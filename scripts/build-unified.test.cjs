const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { relativeFile, moduleFiles, verifyStage, stageFileMode } = require('./build-unified.cjs');

test('direct page packaging is explicit, Linux-only and cannot disguise writable features as a read-only candidate', () => {
  const { integrationArguments, parseBuildOptions, build } = require('./build-unified.cjs');
  assert.deepEqual(integrationArguments('windows', 'x86_64', false), []);
  for (const [platform, arch] of [['windows', 'x86_64'], ['macos', 'aarch64'], ['linux', 'aarch64']]) {
    assert.throws(() => integrationArguments(platform, arch, true), /Linux x86_64 only/);
  }
  assert.deepEqual(integrationArguments('linux', 'x86_64', true, true),
    ['--features', 'integrated-features,experimental-flatpak-host,experimental-linux-migration']);
  assert.deepEqual(parseBuildOptions(['--integrated-features']), { integratedFeatures: true });
  assert.throws(() => parseBuildOptions(['--integrated-features', '--integrated-features']), /Duplicate/);
  assert.throws(() => build('never-build', { integratedFeatures: true }, { platform: 'linux', arch: 'x86_64',
    execute() { throw Error('Must refuse before execution'); } }), /managed writable Unix Hub candidate/);
});

test('direct candidates retain exact service bytes and existing helper file maps without claiming acceptance', () => {
  const { stageIntegrationService } = require('./build-unified.cjs');
  const activation = require('./flatpak-native-activation.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-direct-overlay-'));
  try {
    const overlay = path.join(dir, 'tauri.json');
    const before = { bundle: { resources: { 'archive.dat': 'archive.dat' }, linux: { deb: {
      depends: ['policykit-1'], files: { '/usr/libexec/existing-helper': 'existing-helper' },
    } } }, build: { features: ['experimental-linux-migration'] } };
    fs.writeFileSync(overlay, JSON.stringify(before));
    stageIntegrationService(dir, overlay);
    const after = JSON.parse(fs.readFileSync(overlay));
    assert.deepEqual(after.bundle.resources, before.bundle.resources);
    assert.deepEqual(after.build, before.build);
    assert.deepEqual(after.bundle.linux.deb.depends, ['policykit-1']);
    assert.equal(after.bundle.linux.deb.files['/usr/libexec/existing-helper'], 'existing-helper');
    assert.deepEqual(fs.readFileSync(after.bundle.linux.deb.files[`/${activation.SERVICE}`]), activation.service());
    const receipt = JSON.parse(fs.readFileSync(path.join(dir, 'direct-features-candidate.json')));
    assert.equal(receipt.activationRunsOutsideSandbox, true);
    for (const key of ['nativeGuiAccepted', 'migrationAccepted', 'signedUpdateAccepted', 'flatpakActivationAccepted', 'releaseReady']) assert.equal(receipt[key], false);
    const bytes = fs.readFileSync(overlay);
    assert.throws(() => stageIntegrationService(dir, overlay), /already mapped/);
    assert.deepEqual(fs.readFileSync(overlay), bytes);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('integrated Linux DEB profile is explicit and refuses incompatible flags before signing or building', () => {
  const { candidateProfile, parseBuildOptions, build } = require('./build-unified.cjs');
  assert.deepEqual(parseBuildOptions(['--linux-integrated-candidate', '--integrated-features']),
    { linuxIntegratedCandidate: true, integratedFeatures: true });
  assert.equal(candidateProfile({}), 'retirement-acceptance');
  assert.equal(candidateProfile({ linuxIntegratedCandidate: true, integratedFeatures: true }), 'integrated-candidate');
  for (const options of [{ linuxIntegratedCandidate: true },
    { linuxIntegratedCandidate: true, linuxRetirementCandidate: true, integratedFeatures: true }]) {
    assert.throws(() => build('never-build', options, { platform: 'linux', arch: 'x86_64',
      execute() { throw Error('Must refuse before execution'); } }), /requires --integrated-features/);
  }
  assert.throws(() => build('never-build', { linuxIntegratedCandidate: true, integratedFeatures: true,
    managed: true, experimentalUnix: true, experimentalWritable: true }, { platform: 'linux', arch: 'x86_64',
    execute() { throw Error('Must refuse before execution'); } }), /requires signed native Linux/);
});

test('Linux staged data and executables get canonical archive modes without changing other platform policy', () => {
  const writes = [];
  const chmod = (file, mode) => writes.push({ file, mode });
  stageFileMode('server.mjs', 'linux', false, chmod);
  stageFileMode('node', 'linux', true, chmod);
  stageFileMode('server.mjs', 'macos', false, chmod);
  stageFileMode('node', 'macos', true, chmod);
  stageFileMode('node.exe', 'windows', true, chmod);
  assert.deepEqual(writes, [{ file: 'server.mjs', mode: 0o644 }, { file: 'node', mode: 0o755 }, { file: 'node', mode: 0o755 }]);
});

test('native built-in acceptance refuses the user PC before inspecting apps', () => {
  const result = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, 'native-builtin-smoke.cjs')], {
    encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '' }, windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restricted to a disposable/);
});

test('bundle file names cannot traverse or use alternate absolute paths', () => {
  assert.equal(relativeFile('mcp/server/runtime/node.exe'), true);
  for (const name of ['', '../mcp', '/mcp', 'C:/mcp', 'mcp\\file', 'mcp//file', 'mcp/./file']) assert.equal(relativeFile(name), false, name);
});
test('both internal backends must exist and match their build hashes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-builtins-'));
  try {
    const manifest = { schemaVersion: 1, platform: 'windows', arch: 'x86_64', modules: {} };
    for (const id of ['mcp', 'setup']) {
      const names = moduleFiles(id, manifest.platform);
      const files = {};
      for (const name of names) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), id);
        files[name] = crypto.createHash('sha256').update(id).digest('hex');
      }
      manifest.modules[id] = { executable: names[0], version: '1.0.0', files };
    }
    verifyStage(dir, manifest);
    const original = manifest.modules.mcp.files;
    manifest.modules.mcp.files = { [manifest.modules.mcp.executable]: original[manifest.modules.mcp.executable] };
    assert.throws(() => verifyStage(dir, manifest), /incomplete/);
    manifest.modules.mcp.files = original;
    for (const version of ['invalid', null, undefined, 277, '', 'v2.7.7', '02.7.7']) {
      manifest.modules.mcp.version = version;
      assert.throws(() => verifyStage(dir, manifest), /module payload/);
    }
    manifest.modules.mcp.version = '1.0.0';
    const runtime = moduleFiles('mcp', 'windows').find(name => name.endsWith('/runtime/node.exe'));
    fs.unlinkSync(path.join(dir, runtime));
    assert.throws(() => verifyStage(dir, manifest));
    fs.writeFileSync(path.join(dir, runtime), 'mcp');
    fs.writeFileSync(path.join(dir, manifest.modules.mcp.executable), 'changed');
    assert.throws(() => verifyStage(dir, manifest), /changed/);
    fs.unlinkSync(path.join(dir, manifest.modules.mcp.executable));
    assert.throws(() => verifyStage(dir, manifest));
    delete manifest.modules.mcp;
    assert.throws(() => verifyStage(dir, manifest), /manifest/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
