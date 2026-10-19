const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KIND = 'public14-incoming-direct16';
const BASELINE = Object.freeze({ version: '0.1.14',
  installer: '284820f92de487e8a0f1bb5b3b99cafe5e073f0402a9350a2ea6e76fa9543157',
  exe: 'cd5e3fd2829727d06444c0f3266b178798d1b55c63df651be12eb38ac4523a86' });
const TARGET = Object.freeze({ version: '0.1.16', asset: 'Creator.Hub_0.1.16_x64-setup.exe', bytes: 37980864,
  productSource: 'f9f0e1e5cb27b3ae5178c8aac16429e83ba34593',
  installer: 'f0092e056f7b4245d10350b7954c3dbe5e5356f2e340143d0aefb80078672bc7',
  exe: '8e140ba93190bb717ea30587dbb9dcf4e1c40bf7c1d08ca06b2da947e3b6d30b' });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const feed = () => require('./self-update-lab-feed.cjs');

function keys(value, names) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), 'Unexpected incoming16 fields');
}
function validatePins(pins) {
  keys(pins, ['descriptor', 'descriptorSignature', 'installer', 'manifest', 'executable']);
  for (const value of Object.values(pins)) assert.match(value, /^[a-f0-9]{64}$/);
  assert.equal(pins.installer, TARGET.installer, 'Only the reviewed 16 installer is admitted');
  assert.equal(pins.executable, TARGET.exe, 'Use the installer-extracted EXE, not the loose build output');
}
function validateInput(input) {
  keys(input, ['targetVersion', 'descriptor', 'descriptorSignature', 'installer', 'manifest', 'pins']);
  assert.equal(input.targetVersion, TARGET.version);
  validatePins(input.pins);
  assert.ok(Buffer.isBuffer(input.installer));
  assert.equal(input.installer.length, TARGET.bytes);
  assert.equal(hash(input.installer), TARGET.installer);
}
function validateConfig(config) {
  keys(config, ['schemaVersion', 'kind', 'baselineVersion', 'targetVersion', 'directory', 'pins']);
  assert.equal(config.schemaVersion, 1); assert.equal(config.kind, KIND);
  assert.equal(config.baselineVersion, BASELINE.version); assert.equal(config.targetVersion, TARGET.version);
  assert.ok(typeof config.directory === 'string' && path.isAbsolute(config.directory));
  validatePins(config.pins);
  return config;
}
function installer(file) {
  const bytes = feed().readBounded(file, TARGET.bytes);
  assert.equal(bytes.length, TARGET.bytes); assert.equal(hash(bytes), TARGET.installer);
  return file;
}
function loadContract(config) {
  validateConfig(config);
  const transport = feed(), read = (name, max) => transport.readBounded(path.join(config.directory, name), max);
  return transport.createIncoming016Contract({ targetVersion: TARGET.version, pins: config.pins,
    descriptor: read(transport.DESCRIPTOR, transport.LIMITS.metadata),
    descriptorSignature: read(`${transport.DESCRIPTOR}.minisig`, transport.LIMITS.signature),
    installer: read(TARGET.asset, TARGET.bytes), manifest: read('latest.json', transport.LIMITS.metadata) });
}
function assertBaselineBytes(installerBytes, exeBytes) {
  assert.equal(hash(installerBytes), BASELINE.installer, 'Exact public14 installer required');
  assert.equal(hash(exeBytes), BASELINE.exe, 'Exact installed public14 EXE required');
}
function assertProxy(env) {
  feed().assertRunner(env);
  assert.equal(env.CREATOR_HOSTED_UPDATE_FIXTURE, undefined, 'No baseline fixture or version masquerade');
  for (const name of ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'ALL_PROXY', 'NODE_OPTIONS',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE']) assert.equal(env[name], undefined);
  const proxy = new URL(env.HTTPS_PROXY || '');
  assert.ok(proxy.protocol === 'http:' && proxy.hostname === '127.0.0.1' && /^[1-9][0-9]{0,4}$/.test(proxy.port)
    && Number(proxy.port) <= 65535 && !proxy.username && !proxy.password && proxy.pathname === '/' && !proxy.search && !proxy.hash);
  assert.equal(env.HTTP_PROXY, env.HTTPS_PROXY); assert.equal(env.NO_PROXY, '127.0.0.1,localhost,::1');
}
function selectLab(file, target, fixture, env = process.env) {
  assertProxy(env); assert.equal(fixture, null);
  assert.equal(target.version, TARGET.version); assert.equal(target.installer, TARGET.installer); assert.equal(target.exe, TARGET.exe);
  return loadContract(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(feed().readBounded(file, feed().LIMITS.metadata))));
}
function discoveryScope(contract) {
  assert.equal(contract.targetVersion, TARGET.version); assert.deepEqual(contract.baseline, BASELINE);
  return { kind: KIND, previousStable: BASELINE.version, targetVersion: TARGET.version, pins: contract.pins,
    labDiscovery: true, publicDiscovery: false, liveAiAcceptance: false, migrationAccepted: false, releaseReady: false };
}
function checkBaseline(contract, baseline, executable) {
  assert.equal(contract.targetVersion, TARGET.version);
  assertBaselineBytes(feed().readBounded(baseline, feed().LIMITS.installer), feed().readBounded(executable, feed().LIMITS.installer));
}
function checkReceipt(receipt, mode) {
  assert.equal(receipt.passed, true); assert.equal(receipt.releaseReady, false);
  if (mode === 'guarded') {
    assert.equal(receipt.installerScope, 'guarded-nsis-update-default-location-no-msi');
    assert.equal(receipt.scope, 'exact-public14-to-direct16-guarded-nsis-only');
    assert.equal(receipt.installerSha256, TARGET.installer); assert.equal(receipt.executableSha256, TARGET.exe);
    assert.deepEqual(receipt.from, BASELINE); assert.equal(receipt.settingsPreserved, true);
    assert.equal(receipt.guardedInstallerAccepted, true); assert.equal(receipt.migrationAccepted, false);
    assert.equal(receipt.signedUpdateAccepted, false); assert.equal(receipt.nativeGuiAccepted, false);
    return;
  }
  assert.equal(receipt.policyRestored, true);
  if (mode === 'fresh') {
    assert.equal(receipt.freshInstallAccepted, true); assert.equal(receipt.installerSha256, TARGET.installer);
    assert.equal(receipt.executableSha256, TARGET.exe); assert.equal(receipt.migrationAccepted, false);
    assert.equal(receipt.settingsPreserved, true); assert.equal(receipt.pluginsRemoved, true); assert.equal(receipt.signedUpdateAccepted, false);
  } else {
    assert.equal(mode, 'incoming'); assert.equal(receipt.from.version, BASELINE.version);
    assert.equal(receipt.from.installer, BASELINE.installer); assert.equal(receipt.from.exe, BASELINE.exe);
    assert.equal(receipt.to.version, TARGET.version); assert.equal(receipt.to.installer, TARGET.installer); assert.equal(receipt.to.exe, TARGET.exe);
    for (const field of ['selfUpdateTested', 'directHubUpdateTested', 'managedRouteReconnectTested', 'pluginsRemoved', 'labDiscovery']) assert.equal(receipt[field], true);
    assert.equal(receipt.publicDiscovery, false);
  }
}

function assertOwnedDebugging(state, pid, executable) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const root = state.processes.filter(process => process.ProcessId === pid);
  assert.equal(root.length, 1);
  assert.equal(root[0].ExecutablePath?.toLowerCase(), executable.toLowerCase(), 'Owned Hub executable changed');
  const owned = new Set([pid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const process of state.processes) if (owned.has(process.ParentProcessId) && !owned.has(process.ProcessId)) {
      owned.add(process.ProcessId); changed = true;
    }
  }
  assert.ok(state.listeners.length);
  assert.ok(state.listeners.every(listener => ['127.0.0.1', '::1'].includes(listener.LocalAddress)));
  const active = state.listeners.filter(listener => listener.OwningProcess > 0);
  assert.ok(active.length && active.every(listener => owned.has(listener.OwningProcess)), 'Debugging endpoint must belong to the owned Hub tree');
}

module.exports = { KIND, BASELINE, TARGET, hash, keys, validatePins, validateInput, validateConfig, installer, loadContract,
  assertBaselineBytes, assertProxy, selectLab, discoveryScope, checkBaseline, checkReceipt, assertOwnedDebugging,
  assertRunner: (...args) => feed().assertRunner(...args), readBounded: (...args) => feed().readBounded(...args),
  get LIMITS() { return feed().LIMITS; }, startLabProxy: (...args) => feed().startLabProxy(...args) };

if (require.main === module) {
  try {
    const [mode, directory, pinsText] = process.argv.slice(2);
    assert.ok(['fresh', 'guarded', 'incoming'].includes(mode)); assert.ok(path.isAbsolute(directory));
    installer(path.join(directory, TARGET.asset));
    if (mode === 'incoming') {
      const config = { schemaVersion: 1, kind: KIND, baselineVersion: BASELINE.version, targetVersion: TARGET.version,
        directory, pins: JSON.parse(pinsText) };
      loadContract(config);
      fs.writeFileSync(path.join(directory, 'incoming-016-config.json'), JSON.stringify(config), { flag: 'wx' });
    }
    console.log(JSON.stringify({ kind: KIND, mode, installer: TARGET.installer, executable: TARGET.exe, releaseReady: false }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
