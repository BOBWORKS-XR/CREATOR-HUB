const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const archive = require('./module-archive.cjs');
const build = require('./build-unified.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-archive-contract-'));
  const bytes = Buffer.from('opaque native decoder fixture, not a TAR parser test');
  const manifest = { schemaVersion: 1, platform: 'linux', arch: 'x86_64', modules: {} };
  for (const id of ['mcp', 'setup']) {
    const names = build.moduleFiles(id, 'linux');
    manifest.modules[id] = { executable: names[0], version: '0.1.12', files: Object.fromEntries(names.map(name => [name, hash(Buffer.from(name))])) };
  }
  manifest.payloadArchive = { schemaVersion: 1, file: archive.FILE, size: bytes.length, sha256: hash(bytes),
    unpackedSize: 10, files: Object.fromEntries(Object.keys(archive.rawFiles(manifest)).map(name => [name, { size: 1, mode: archive.modeFor(manifest, name) }])) };
  const file = path.join(directory, archive.FILE);
  fs.writeFileSync(file, bytes);
  return { directory, manifest, file };
}

test('archive policy binds exact Linux names, sizes and executable modes without changing raw hashes', () => {
  const { directory, manifest } = fixture();
  try {
    assert.deepEqual(archive.validateBinding(manifest), archive.rawFiles(manifest));
    for (const mutate of [
      value => { value.platform = 'macos'; }, value => { value.payloadArchive.file = '../modules.tar.gz'; },
      value => { value.payloadArchive.size = archive.MAX_ARCHIVE + 1; }, value => { value.payloadArchive.unpackedSize = archive.MAX_TOTAL + 1; },
      value => { value.payloadArchive.files['mcp/creator-works-mcp-launcher'].mode = 0o4755; },
      value => { value.payloadArchive.files['mcp/server/runtime/node'].mode = 0o644; },
      value => { value.payloadArchive.files['mcp/server/LICENSE'].size = archive.MAX_FILE + 1; },
      value => { value.payloadArchive.files['mcp/server/LICENSE'].unknown = true; },
      value => { value.payloadArchive.files['mcp/unknown'] = { size: 0, mode: 0o644 }; },
      value => { delete value.payloadArchive.files['mcp/server/LICENSE']; },
    ]) {
      const invalid = structuredClone(manifest);
      mutate(invalid);
      assert.throws(() => archive.validateBinding(invalid));
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('production validation delegates exact manifest to the shared decoder and refuses partial results', () => {
  const { directory, manifest, file } = fixture();
  try {
    const decoder = path.join(directory, 'native-decoder');
    const invoke = (binary, args, options) => {
      assert.equal(binary, decoder);
      assert.deepEqual(args, ['verify', file]);
      assert.deepEqual(JSON.parse(options.input), manifest);
      assert.equal(options.maxBuffer, 65536);
      return JSON.stringify({ files: archive.rawFiles(manifest) });
    };
    assert.deepEqual(archive.verify(file, manifest, decoder, invoke), archive.rawFiles(manifest));
    assert.throws(() => archive.verify(file, manifest));
    assert.throws(() => archive.verify(file, manifest, 'relative-decoder'));
    assert.throws(() => archive.verify(file, manifest, decoder, () => JSON.stringify({ files: {} })));
    assert.throws(() => archive.verify(file, manifest, decoder, () => { throw Error('Native decoder refused TAR'); }));
    fs.writeFileSync(file, Buffer.alloc(manifest.payloadArchive.size));
    assert.throws(() => archive.verify(file, manifest, decoder, () => { assert.fail('Changed archive reached the decoder'); }), /changed/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Linux producer alone replaces exposed ELF resources; Windows/Mac and strict Hub comparison remain', () => {
  const source = fs.readFileSync(path.join(__dirname, 'build-unified.cjs'), 'utf8');
  assert.match(source, /if \(platform === 'linux'\) \{[\s\S]*manifest\.payloadArchive = archive\.create/);
  assert.match(source, /archive\.verify\(file, manifest, archiveDecoder\)/);
  assert.match(source, /for \(const resource of Object\.keys\(resources\)\) delete resources\[resource\]/);
  assert.match(source, /resources\[file\] = archive\.FILE/);
  const consumer = fs.readFileSync(path.join(__dirname, 'unix-package-payload.cjs'), 'utf8');
  assert.match(consumer, /verifyLinuxHub\(fs\.readFileSync\(rawHub\), bytes, format\)/);
});

test('native tests require explicit opt-in and never provision compiler/decoder dependencies', () => {
  for (const file of ['module-archive-native.test.cjs', 'linux-hub-runpath.test.cjs']) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    assert.match(source, /skip: process\.platform !== 'linux' \|\| process\.env\.CREATOR_NATIVE_ARCHIVE_TESTS !== '1'/);
    assert.doesNotMatch(source, /\['build'|--offline|rustup/);
  }
});
