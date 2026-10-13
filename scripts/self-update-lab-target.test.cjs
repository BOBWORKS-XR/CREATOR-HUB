const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { selectLab, stagedCompanion, discoveryScope } = require('./self-update-lab-target.cjs');
const runner = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
  HTTPS_PROXY: 'http://127.0.0.1:34567' };

test('lab target refuses local execution before reading any configuration', () => {
  assert.throws(() => selectLab('missing', {}, null, {}), /disposable GitHub-hosted/);
  const result = spawnSync(process.execPath, [require.resolve('./native-self-update-smoke.cjs')], {
    encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false', CREATOR_SELF_UPDATE_LAB_CONFIG: 'missing' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restricted to a disposable/);
  assert.doesNotMatch(result.stderr, /ENOENT|configuration path/);
});

test('lab target rejects version fixtures, relative inputs and non-owned proxy routes', () => {
  assert.throws(() => selectLab('missing', {}, {}, runner), /unmodified public baseline/);
  assert.throws(() => selectLab('missing', {}, null, runner), /absolute/);
  for (const HTTPS_PROXY of ['http://remote:34567', 'https://127.0.0.1:34567',
    'http://127.0.0.1', 'http://user:password@127.0.0.1:34567', 'http://127.0.0.1:34567/path',
    'http://127.0.0.1:34567?alias=1', 'http://127.0.0.1:34567#alias']) {
    assert.throws(() => selectLab(path.resolve('missing'), {}, null, { ...runner, HTTPS_PROXY }), /owned loopback/);
  }
});

test('lab discovery report cannot represent public publication or native baseline acceptance', () => {
  const scope = discoveryScope({ targetVersion: '0.1.13', baseline: { version: '0.1.12' }, pins: {} });
  assert.equal(scope.publicDiscovery, false);
  assert.equal(scope.labDiscovery, true);
  assert.equal(scope.releaseReady, false);
  assert.equal(scope.previousStable, '0.1.12');
  assert.equal(scope.kind, 'prepublication-signed-lab-update');
  assert.equal(scope.releaseLine, 'separate-apps');
});

test('separate companion staging reads exact immutable bytes, refuses tampering/aliases and never downloads', t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-companion-')));
  const file = path.join(directory, 'Creator.Works.MCP_fixture.exe');
  t.after(() => { fs.unlinkSync(file); fs.rmdirSync(directory); });
  const bytes = Buffer.from('NOT AN INSTALLER: unsigned unit staging fixture');
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  const pin = { assetName: path.basename(file), installerSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    executableSha256: 'a'.repeat(64), version: '2.7.7' };
  const staged = stagedCompanion(directory, pin);
  assert.equal(staged.path, file);
  assert.equal(staged.installerSha256, pin.installerSha256);
  assert.ok(Object.isFrozen(staged));
  assert.deepEqual(fs.readFileSync(file), bytes);
  for (const assetName of ['../other.exe', 'other..exe', 'other.exe?download=1']) assert.throws(() => stagedCompanion(directory, { ...pin, assetName }));
  assert.throws(() => stagedCompanion('.', pin), /absolute/);
  fs.appendFileSync(file, 'changed');
  assert.throws(() => stagedCompanion(directory, pin), /exact pinned separate companion/);
});

test('actual lab selector binds candidate hashes and both staged separate installers before returning', t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'maintenance-lab-select-')));
  t.after(() => { for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name)); fs.rmdirSync(directory); });
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const installer = Buffer.from('NONCRYPTOGRAPHIC unit-only Hub installer');
  const sig = Buffer.from('untrusted comment: NONCRYPTOGRAPHIC unit signature\n');
  const descriptor = Buffer.from(JSON.stringify({ schemaVersion: 1, appId: 'creator-hub', version: '0.1.13',
    platform: 'windows', architecture: 'x86_64', packageType: 'nsis', assetName: 'Creator.Hub_0.1.13_x64-setup.exe',
    byteLength: installer.length, sha256: hash(installer), executableSha256: 'a'.repeat(64),
    identityProtocol: 0, lifecycleProtocol: 0, installerProtocol: 1, minHubVersion: '0.1.0-alpha.1' }));
  const manifest = Buffer.from(JSON.stringify({ version: '0.1.13', platforms: { 'windows-x86_64': {
    url: 'https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.13/Creator.Hub_0.1.13_x64-setup.exe',
    signature: sig.toString('base64') } } }));
  const fixturePins = {};
  for (const app of ['setup', 'mcp']) {
    const bytes = Buffer.from(`NOT AN INSTALLER: separate ${app} fixture`), assetName = `Creator.${app}_fixture.exe`;
    fixturePins[app] = { assetName, version: '1.0.0', installerSha256: hash(bytes), executableSha256: 'b'.repeat(64) };
    fs.writeFileSync(path.join(directory, assetName), bytes, { flag: 'wx' });
  }
  for (const [name, bytes] of Object.entries({ 'creator-hub-windows-x86_64.json': descriptor,
    'creator-hub-windows-x86_64.json.minisig': sig, 'Creator.Hub_0.1.13_x64-setup.exe': installer, 'latest.json': manifest })) {
    fs.writeFileSync(path.join(directory, name), bytes, { flag: 'wx' });
  }
  const configPath = path.join(directory, 'lab.json');
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, targetVersion: '0.1.13', directory,
    pins: { descriptor: hash(descriptor), descriptorSignature: hash(sig), installer: hash(installer), manifest: hash(manifest), executable: 'a'.repeat(64) } }), { flag: 'wx' });
  const module = { exports: {} };
  // Substitute only deliberately unsigned companion fixture pins. Keep real selector/feed validators and file reads.
  vm.runInNewContext(fs.readFileSync(require.resolve('./self-update-lab-target.cjs'), 'utf8'), {
    module, TextDecoder, URL, require(name) { return name === './prerelease-apps.json' ? fixturePins : require(name); },
  });
  const target = { version: '0.1.13', installer: hash(installer), exe: 'a'.repeat(64) };
  const selected = module.exports.selectLab(configPath, target, null, runner);
  assert.ok(Object.isFrozen(selected) && Object.isFrozen(selected.companionInstallers));
  assert.equal(selected.baseline.version, '0.1.12');
  assert.equal(selected.companionInstallers.setup.path, path.join(directory, fixturePins.setup.assetName));
  for (const patch of [{ version: '0.1.14' }, { installer: 'c'.repeat(64) }, { exe: 'c'.repeat(64) }]) {
    assert.throws(() => module.exports.selectLab(configPath, { ...target, ...patch }, null, runner), /differs/);
  }
  fs.appendFileSync(path.join(directory, fixturePins.mcp.assetName), 'changed');
  assert.throws(() => module.exports.selectLab(configPath, target, null, runner), /exact pinned separate companion/);
});
