// Offline packaging experiment, not host admission or release authority.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const archive = require('./module-archive.cjs');

const ROOT = path.resolve(__dirname, '..');
const RECIPE = path.join(ROOT, 'packaging', 'flatpak');
const ID = 'com.creatorworks.hub';
const REF = `app/${ID}/x86_64/flatpak-test`;
const PERMISSIONS = ['--socket=wayland', '--socket=fallback-x11', '--device=dri', '--share=ipc'];
const INPUTS = ['creator-hub', 'builtin-manifest.json', 'modules.tar.gz'];
const OUTPUTS = ['bin/creator-hub', 'lib/Creator Hub/modules.tar.gz', `share/applications/${ID}.desktop`,
  `share/icons/hicolor/128x128/apps/${ID}.png`, `share/appdata/${ID}.appdata.xml`, `share/licenses/${ID}/LICENSE`];
const MEMBERS = ['mcp/creator-works-mcp-launcher', 'mcp/server/creator-works-mcp.mjs', 'mcp/server/runtime/node',
  'mcp/server/runtime/LICENSE', 'mcp/server/runtime/VERSION', 'mcp/server/unity-extension/Editor/BanterMCPBridge.cs',
  'mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png', 'mcp/server/LICENSE', 'mcp/server/THIRD_PARTY_NOTICES.md',
  'setup/creator-project-setup'];
const ROUTING = ['routing/creator-hub-mcp-router', 'routing/router.json', 'routing/router.minisig',
  'routing/runtime.json', 'routing/runtime.minisig'];
const LIMIT = 256 * 1024 * 1024;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const record = bytes => ({ size: bytes.length, sha256: sha256(bytes) });
const acceptance = () => ({ nativeLinuxAccepted: false, flatpakGuiAccepted: false, hostIntegrationAccepted: false,
  mcpAccepted: false, migrationAccepted: false, signedUpdateAccepted: false, releaseReady: false });

function ordinary(file) {
  assert.ok(path.isAbsolute(file) && path.normalize(file) === file, 'Ordinary absolute path required');
  for (let part = file;; part = path.dirname(part)) {
    assert.equal(fs.lstatSync(part).isSymbolicLink(), false, 'Redirected path refused');
    if (part === path.dirname(part)) break;
  }
  return fs.lstatSync(file);
}

function read(file, limit = LIMIT, allowHardlinks = false) {
  const before = ordinary(file);
  assert.ok(before.isFile() && (allowHardlinks || before.nlink === 1) && before.size > 0 && before.size <= limit, 'Bounded ordinary file required');
  const fd = fs.openSync(file, 'r');
  try {
    assert.equal(fs.fstatSync(fd).ino, before.ino, 'Input changed while opening');
    assert.equal(fs.fstatSync(fd).dev, before.dev, 'Input changed while opening');
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0, count;
    while (length < buffer.length && (count = fs.readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
    const bytes = buffer.subarray(0, length);
    const after = ordinary(file);
    for (const key of ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key], 'Input changed while reading');
    assert.equal(bytes.length, before.size);
    return bytes;
  } finally { fs.closeSync(fd); }
}

function validatePins(pins) {
  assert.deepEqual(Object.keys(pins).sort(), ['arch', 'files', 'inputArtifactSha256', 'mcpMode', 'platform', 'runAttempt', 'runId',
    'schemaVersion', 'sourceCommit', 'sourceTree', 'version']);
  assert.equal(pins.schemaVersion, 1); assert.equal(pins.version, '0.1.14', 'Do not relabel an older Hub');
  assert.equal(pins.platform, 'linux'); assert.equal(pins.arch, 'x86_64');
  assert.ok(['read-only', 'writable'].includes(pins.mcpMode));
  for (const name of ['sourceCommit', 'sourceTree']) assert.match(pins[name], /^[a-f0-9]{40}$/);
  assert.match(pins.inputArtifactSha256, /^[a-f0-9]{64}$/);
  for (const name of ['runId', 'runAttempt']) assert.ok(Number.isSafeInteger(pins[name]) && pins[name] > 0);
  assert.deepEqual(Object.keys(pins.files).sort(), [...INPUTS].sort());
  for (const value of Object.values(pins.files)) {
    assert.deepEqual(Object.keys(value).sort(), ['sha256', 'size']);
    assert.match(value.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(value.size) && value.size > 0 && value.size <= LIMIT);
  }
}

function validateDescriptor(manifest) {
  assert.deepEqual(Object.keys(manifest).sort(), ['arch', ...(manifest.managedRouting ? ['managedRouting'] : []),
    'modules', 'payloadArchive', 'platform', 'schemaVersion']);
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.platform, 'linux'); assert.equal(manifest.arch, 'x86_64');
  assert.deepEqual(Object.keys(manifest.modules).sort(), ['mcp', 'setup']);
  for (const [id, version, executable] of [['mcp', '2.7.7', MEMBERS[0]], ['setup', '0.3.7', MEMBERS[9]]]) {
    const module = manifest.modules[id];
    assert.deepEqual(Object.keys(module).sort(), ['executable', 'files', 'version']);
    assert.equal(module.version, version); assert.equal(module.executable, executable);
    assert.deepEqual(Object.keys(module.files).sort(), MEMBERS.filter(name => name.startsWith(`${id}/`)).sort());
  }
  if (manifest.managedRouting) {
    assert.deepEqual(Object.keys(manifest.managedRouting).sort(), ['files', 'protocol']);
    assert.equal(manifest.managedRouting.protocol, 1);
    assert.deepEqual(Object.keys(manifest.managedRouting.files).sort(), [...ROUTING].sort());
  }
  archive.validateBinding(manifest);
}

function validateElf(bytes) {
  assert.ok(bytes.length >= 64 && bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])), 'Hub must be ELF');
  assert.equal(bytes[4], 2, 'ELF64 required'); assert.equal(bytes[5], 1, 'Little endian required');
  assert.equal(bytes.readUInt16LE(18), 62, 'Native x86_64 required');
  assert.ok([2, 3].includes(bytes.readUInt16LE(16)), 'Executable ELF required');
}

function validateRecipe(recipe) {
  assert.deepEqual(recipe, {
    'app-id': ID, branch: 'flatpak-test', runtime: 'org.gnome.Platform', 'runtime-version': '50',
    sdk: 'org.gnome.Sdk', command: 'creator-hub', 'appstream-compose': false,
    'build-options': { strip: false, 'no-debuginfo': true },
    'finish-args': PERMISSIONS,
    modules: [{ name: 'creator-hub-reviewed-input', buildsystem: 'simple',
      sources: [{ type: 'dir', path: 'flatpak-input' }], 'build-commands': [
        'install -Dm755 bin/creator-hub /app/bin/creator-hub',
        "install -Dm644 'lib/Creator Hub/modules.tar.gz' '/app/lib/Creator Hub/modules.tar.gz'",
        ...OUTPUTS.slice(2).map(name => `install -Dm644 ${name} /app/${name}`),
      ] }],
  }, 'Only the reviewed offline recipe is allowed');
}

function inventory(root) {
  const files = {};
  function visit(directory) {
    assert.ok(ordinary(directory).isDirectory());
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else files[path.relative(root, file).split(path.sep).join('/')] = record(read(file));
    }
  }
  visit(root);
  assert.deepEqual(Object.keys(files).sort(), [...OUTPUTS].sort(), 'Unexpected staged file');
  return files;
}

function verifyStage(destination, expected) {
  validatePins(expected.provenance);
  validateRecipe(JSON.parse(read(path.join(destination, `${ID}.json`), 65536)));
  assert.deepEqual(inventory(path.join(destination, 'flatpak-input')), expected.files, 'Staged bytes changed');
  const manifestBytes = read(path.join(destination, 'builtin-manifest.json'), 65536);
  assert.deepEqual(record(manifestBytes), expected.provenance.files['builtin-manifest.json']);
  const manifest = JSON.parse(manifestBytes); validateDescriptor(manifest);
  assert.equal(Boolean(manifest.managedRouting), expected.provenance.mcpMode === 'writable');
  const hub = read(path.join(destination, 'flatpak-input', OUTPUTS[0])); validateElf(hub);
  assert.ok(hub.includes(manifestBytes), 'Hub does not embed the exact archive descriptor');
  assert.deepEqual(record(hub), expected.provenance.files['creator-hub']);
  assert.deepEqual(expected.files[OUTPUTS[1]], expected.provenance.files['modules.tar.gz']);
  assert.equal(manifest.payloadArchive.sha256, expected.files[OUTPUTS[1]].sha256);
  assert.equal(manifest.payloadArchive.size, expected.files[OUTPUTS[1]].size);
  return manifest;
}

function prepare(input, pins, destination) {
  validatePins(pins);
  const bytes = Object.fromEntries(INPUTS.map(name => {
    const value = read(path.join(input, name), name.endsWith('.json') ? 65536 : LIMIT);
    assert.deepEqual(record(value), pins.files[name], `Reviewed input differs: ${name}`);
    return [name, value];
  }));
  const manifest = JSON.parse(bytes['builtin-manifest.json']); validateDescriptor(manifest);
  validateElf(bytes['creator-hub']);
  assert.ok(bytes['creator-hub'].includes(bytes['builtin-manifest.json']), 'Exact embedded descriptor required');
  assert.equal(Boolean(manifest.managedRouting), pins.mcpMode === 'writable', 'Reviewed producer mode differs');
  assert.deepEqual(record(bytes['modules.tar.gz']), { size: manifest.payloadArchive.size, sha256: manifest.payloadArchive.sha256 });
  const recipeBytes = read(path.join(RECIPE, `${ID}.json`), 65536); validateRecipe(JSON.parse(recipeBytes));
  const assets = [bytes['creator-hub'], bytes['modules.tar.gz'], read(path.join(RECIPE, `${ID}.desktop`), 8192),
    read(path.join(ROOT, 'src-tauri', 'icons', '128x128.png'), 1024 * 1024),
    read(path.join(RECIPE, `${ID}.metainfo.xml`), 8192), read(path.join(ROOT, 'LICENSE'), 16384)];
  assert.ok(assets[3].subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));
  assert.equal(assets[3].readUInt32BE(16), 128); assert.equal(assets[3].readUInt32BE(20), 128);
  ordinary(path.dirname(destination));
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const [index, name] of OUTPUTS.entries()) {
    const file = path.join(destination, 'flatpak-input', name);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, assets[index], { flag: 'wx', mode: index === 0 ? 0o755 : 0o644 });
    if (process.platform === 'linux') fs.chmodSync(file, index === 0 ? 0o755 : 0o644);
  }
  fs.writeFileSync(path.join(destination, `${ID}.json`), recipeBytes, { flag: 'wx', mode: 0o644 });
  fs.writeFileSync(path.join(destination, 'builtin-manifest.json'), bytes['builtin-manifest.json'], { flag: 'wx', mode: 0o644 });
  const result = { schemaVersion: 1, scope: 'offline-flatpak-packaging-only', provenance: pins,
    files: inventory(path.join(destination, 'flatpak-input')), archiveMembersVerified: false, ...acceptance() };
  verifyStage(destination, result);
  // Recheck original inputs after publication; a partial stage is never accepted.
  for (const name of INPUTS) assert.deepEqual(record(read(path.join(input, name))), pins.files[name], `Input drift: ${name}`);
  fs.writeFileSync(path.join(destination, 'flatpak-stage.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  return result;
}

if (require.main === module) {
  try {
    assert.equal(process.argv.length, 5, 'Use flatpak-package.cjs INPUT REVIEWED_PINS NEW_STAGE');
    const result = prepare(path.resolve(process.argv[2]), JSON.parse(read(path.resolve(process.argv[3]), 65536)), path.resolve(process.argv[4]));
    console.log(JSON.stringify({ staged: true, archiveMembersVerified: result.archiveMembersVerified, ...acceptance() }));
  } catch (error) { console.error(String(error.message).slice(0, 1000)); process.exitCode = 1; }
}
module.exports = { ROOT, RECIPE, ID, REF, PERMISSIONS, INPUTS, OUTPUTS, MEMBERS, ROUTING, LIMIT, sha256, record, acceptance,
  ordinary, read, validatePins, validateDescriptor, validateElf, validateRecipe, inventory, verifyStage, prepare };
