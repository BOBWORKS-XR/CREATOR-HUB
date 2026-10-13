const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertRunner, readBounded, loadContract, assertBaselineBytes, LIMITS } = require('./self-update-lab-feed.cjs');

function selectLab(configPath, target, fixture, env = process.env) {
  assertRunner(env);
  assert.equal(fixture, null, 'Lab requires the unmodified public baseline, not a version fixture');
  assert.ok(path.isAbsolute(configPath), 'Lab configuration path must be absolute');
  const proxy = new URL(env.HTTPS_PROXY || '');
  assert.ok(proxy.protocol === 'http:' && proxy.hostname === '127.0.0.1' &&
    /^\d+$/.test(proxy.port) && Number(proxy.port) > 0 && Number(proxy.port) <= 65535 &&
    !proxy.username && !proxy.password && proxy.pathname === '/' && !proxy.search && !proxy.hash,
  'Use only the owned loopback lab proxy');
  const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readBounded(configPath, LIMITS.metadata)));
  const contract = loadContract(config);
  assert.equal(contract.targetVersion, target.version, 'Lab target version differs');
  assert.equal(contract.pins.installer, target.installer, 'Lab installer pin differs');
  assert.equal(contract.pins.executable, target.exe, 'Lab executable pin differs');
  const pins = require('./prerelease-apps.json');
  // The five-route proxy cannot fetch companion releases. Co-stage the unchanged separate installers.
  const companionInstallers = Object.fromEntries(['setup', 'mcp'].map(app =>
    [app, stagedCompanion(config.directory, pins[app])]));
  return Object.freeze({ ...contract, companionInstallers: Object.freeze(companionInstallers) });
}

function stagedCompanion(directory, pin) {
  assert.ok(path.isAbsolute(directory), 'Companion staging directory must be absolute');
  assert.match(pin.assetName, /^[A-Za-z0-9._-]+\.exe$/);
  assert.ok(pin.assetName.length <= 160 && !pin.assetName.includes('..'), 'Invalid companion asset name');
  for (const field of ['installerSha256', 'executableSha256']) assert.match(pin[field], /^[a-f0-9]{64}$/);
  const installer = path.join(directory, pin.assetName);
  const bytes = readBounded(installer, LIMITS.installer);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), pin.installerSha256,
    'Pre-stage the exact pinned separate companion installer before enabling the lab proxy');
  return Object.freeze({ path: installer, installerSha256: pin.installerSha256,
    executableSha256: pin.executableSha256, version: pin.version });
}

function checkBaseline(contract, installer, executable) {
  return assertBaselineBytes(contract.targetVersion,
    readBounded(installer, LIMITS.installer), readBounded(executable, LIMITS.installer));
}

function discoveryScope(contract) {
  return { kind: 'prepublication-signed-lab-update', releaseLine: 'separate-apps', labDiscovery: true, publicDiscovery: false,
    releaseReady: false, previousStable: contract.baseline.version,
    targetVersion: contract.targetVersion, pins: contract.pins };
}

module.exports = { selectLab, stagedCompanion, checkBaseline, discoveryScope };
