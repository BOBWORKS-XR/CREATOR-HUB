const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { validateStagedSetup } = require('./stage-setup-cache.cjs');

test('staging refuses local and self-hosted execution before reading files or touching caches', () => {
  for (const env of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted', RUNNER_OS: 'Windows' }]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'stage-setup-cache.cjs')], {
      env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10000, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restricted to a disposable GitHub-hosted Windows runner/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  }
});

test('staging binds exact bytes, both hashes, identity, version and Hub minimum', () => {
  const installer = Buffer.from('fixture only');
  const pin = { version: '0.3.0-alpha.2', assetName: 'Creator-Project-Setup-0.3.0-alpha.2-Windows-setup.exe',
    installerSha256: crypto.createHash('sha256').update(installer).digest('hex'), executableSha256: 'a'.repeat(64) };
  const descriptor = { schemaVersion: 1, appId: 'creator-project-setup', version: pin.version, assetName: pin.assetName,
    sha256: pin.installerSha256, executableSha256: pin.executableSha256, byteLength: installer.length,
    minHubVersion: '0.1.0-alpha.5', installerProtocol: 1 };
  const valid = value => validateStagedSetup(pin, value, installer, '0.1.0-alpha.5');
  assert.equal(valid(descriptor).publicFeedTested, false);
  for (const key of ['schemaVersion', 'appId', 'version', 'assetName', 'sha256', 'executableSha256', 'byteLength', 'minHubVersion', 'installerProtocol']) {
    assert.throws(() => valid({ ...descriptor, [key]: 'different' }), key);
  }
  assert.throws(() => validateStagedSetup(pin, descriptor, Buffer.from('changed bytes'), '0.1.0-alpha.5'));
  assert.throws(() => validateStagedSetup({ ...pin, version: '../../outside' }, { ...descriptor, version: '../../outside' }, installer, '0.1.0-alpha.5'));
});
