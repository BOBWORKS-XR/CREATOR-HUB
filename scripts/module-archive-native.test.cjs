const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const archive = require('./module-archive.cjs');
const build = require('./build-unified.cjs');
const unix = require('./unix-package-payload.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('native GNU tar producer pipes exact raw modules/routing through the same Rust decoder and package layouts', { skip: process.platform !== 'linux' || process.env.CREATOR_NATIVE_ARCHIVE_TESTS !== '1' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-archive-native-'));
  try {
    const decoder = process.env.CREATOR_TEST_ARCHIVE_DECODER;
    assert.ok(decoder && path.isAbsolute(decoder) && fs.statSync(decoder).isFile(), 'Native archive tests require an explicitly built CREATOR_TEST_ARCHIVE_DECODER.');
    const modules = path.join(root, 'raw');
    const manifest = { schemaVersion: 1, platform: 'linux', arch: 'x86_64', modules: {} };
    for (const id of ['mcp', 'setup']) {
      const names = build.moduleFiles(id, 'linux');
      manifest.modules[id] = { executable: names[0], version: '0.1.12', files: Object.fromEntries(names.map(name => [name, hash(Buffer.from(name))])) };
    }
    manifest.managedRouting = { protocol: 1, files: Object.fromEntries(require('./managed-router-package.cjs').routeFiles('linux').map(name => [name, hash(Buffer.from(name))])) };
    for (const name of Object.keys(archive.rawFiles(manifest))) {
      const file = path.join(modules, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, name, { mode: 0o755 });
      build.stageFileMode(file, 'linux', archive.modeFor(manifest, name) === 0o755);
      assert.equal(fs.statSync(file).mode & 0o7777, archive.modeFor(manifest, name));
      assert.equal(fs.readFileSync(file, 'utf8'), name);
    }
    const original = structuredClone(manifest);
    const file = path.join(root, archive.FILE);
    manifest.payloadArchive = archive.create(modules, manifest, file);
    assert.deepEqual(manifest.modules, original.modules);
    assert.deepEqual(manifest.managedRouting, original.managedRouting);
    assert.deepEqual(archive.verify(file, manifest, decoder), archive.rawFiles(manifest));
    const destination = path.join(root, 'decoded');
    execFileSync(decoder, ['extract', file, destination], { input: JSON.stringify(manifest) });
    assert.deepEqual(unix.verifyResources(destination, manifest), archive.rawFiles(manifest));
    assert.throws(() => execFileSync(decoder, ['extract', file, destination], { input: JSON.stringify(manifest), stdio: 'pipe' }));
    fs.writeFileSync(path.join(root, 'builtin-manifest.json'), JSON.stringify(manifest));
    const raw = Buffer.concat([Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK'), fs.readFileSync(path.join(root, 'builtin-manifest.json'))]);
    const rawHub = path.join(root, 'creator-hub');
    fs.writeFileSync(rawHub, raw);
    for (const format of ['deb', 'rpm', 'appimage']) {
      const extracted = path.join(root, format);
      const tree = format === 'appimage' ? path.join(extracted, 'squashfs-root') : extracted;
      const resources = path.join(tree, 'usr/lib/Creator Hub');
      fs.mkdirSync(resources, { recursive: true });
      fs.copyFileSync(file, path.join(resources, archive.FILE));
      const hub = path.join(tree, 'usr/bin/creator-hub');
      fs.mkdirSync(path.dirname(hub), { recursive: true });
      const bytes = Buffer.from(raw);
      bytes.write({ deb: 'DEB', rpm: 'RPM', appimage: 'APP' }[format], Buffer.byteLength('__TAURI_BUNDLE_TYPE_VAR_'));
      fs.writeFileSync(hub, bytes, { mode: 0o755 });
      assert.deepEqual(unix.verifyLayout(extracted, format, manifest, 'Creator Hub', rawHub, null, decoder).files, archive.rawFiles(manifest));
      fs.mkdirSync(path.join(resources, 'modules'));
      assert.throws(() => unix.verifyLayout(extracted, format, manifest, 'Creator Hub', rawHub, null, decoder), /exposes raw/);
    }
    const changed = Buffer.from(fs.readFileSync(file));
    changed[15] ^= 1;
    fs.writeFileSync(file, changed);
    assert.throws(() => archive.verify(file, manifest, decoder), /changed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
