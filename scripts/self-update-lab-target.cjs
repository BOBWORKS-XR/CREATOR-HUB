const assert = require('node:assert/strict');
const path = require('node:path');
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
  return contract;
}

function checkBaseline(contract, installer, executable) {
  return assertBaselineBytes(contract.targetVersion,
    readBounded(installer, LIMITS.installer), readBounded(executable, LIMITS.installer));
}

function discoveryScope(contract) {
  return { kind: 'prepublication-signed-lab-update', labDiscovery: true, publicDiscovery: false,
    releaseReady: false, previousStable: contract.baseline.version,
    targetVersion: contract.targetVersion, pins: contract.pins };
}

module.exports = { selectLab, checkBaseline, discoveryScope };
