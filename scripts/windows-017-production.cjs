'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { readBounded } = require('./read-bounded-input.cjs');
const shared = require('./windows-incoming-016.cjs');
const raw = require('./fixtures/windows-r5-raw-binding.json');
const binding = require('./fixtures/windows-017-production-binding.json');
const feed = () => require('./self-update-lab-feed-017.cjs');
const SOURCE = Object.freeze({ commit: '930a2886b6872a08a4a25be4738a5a01a4e911d2', tree: 'a1af9bf6c56b221352f8b3feb1fd65259200e9dc' });
const TARGET = Object.freeze({ version: '0.1.18', asset: 'Creator.Hub_0.1.18_x64-setup.exe',
  bytes: raw.installer.bytes, installer: raw.installer.sha256, exe: raw.executable.sha256, productSource: SOURCE.commit });
const PINS = Object.freeze({ descriptor: binding.descriptor?.sha256, descriptorSignature: binding.descriptorSignature?.sha256,
  manifest: binding.manifest?.sha256, installer: TARGET.installer, executable: TARGET.exe });
const baselineVersion = process.env.CREATOR_PRODUCTION_017_BASELINE || '0.1.12';
const BASELINE = Object.freeze(require('./self-update-baselines.cjs').selectBaseline(baselineVersion === '0.1.14' ? '0.1.16' : '0.1.13'));
const KIND = `targeted-public-${BASELINE.version}-production-metadata`;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function validateBinding() {
  require('./windows-r5-raw.cjs').validatePins(raw);
  assert.deepEqual(raw.source, SOURCE); assert.equal(binding.enabled, true, 'Canonical production metadata has not been bound');
  assert.deepEqual(binding.source, SOURCE);
  assert.equal(binding.version, TARGET.version); assert.equal(binding.minHubVersion, '0.1.12');
  for (const [name, maximum] of [['descriptor', 32768], ['descriptorSignature', 4096], ['manifest', 32768]]) {
    assert.match(binding[name]?.sha256 || '', /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(binding[name].bytes) && binding[name].bytes > 0 && binding[name].bytes <= maximum);
  }
}
function assertHost(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32');
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/validation/windows-menu-merge-20261027',
    GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-017-production.yml@refs/heads/validation/windows-menu-merge-20261027',
    CREATOR_WINDOWS_017_PRODUCTION: '1' })) assert.equal(env[key], value, key);
  assert.ok(['incoming', 'incoming-migration'].includes(env.GITHUB_JOB));
  assert.ok(['0.1.12', '0.1.14'].includes(env.CREATOR_PRODUCTION_017_BASELINE));
  if (env.GITHUB_JOB === 'incoming-migration') assert.equal(env.CREATOR_PRODUCTION_017_BASELINE, '0.1.12');
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/); assert.equal(env.EXPECTED_HARNESS_COMMIT, env.GITHUB_SHA);
  assert.equal(env.CREATOR_HOSTED_UPDATE_FIXTURE, undefined); assert.equal(env.CREATOR_PUBLIC12_R2_LAB, undefined);
  validateBinding();
}
function validatePins(pins) { validateBinding(); assert.deepEqual(pins, PINS); }
function installer(file) {
  validateBinding(); assert.ok(path.isAbsolute(file));
  const bytes = readBounded(file, TARGET.bytes); assert.equal(bytes.length, TARGET.bytes); assert.equal(hash(bytes), TARGET.installer);
  return file;
}
function validateInput(input) {
  validatePins(input.pins); assert.equal(input.targetVersion, TARGET.version);
  assert.ok(Buffer.isBuffer(input.installer)); assert.equal(input.installer.length, TARGET.bytes); assert.equal(hash(input.installer), TARGET.installer);
  for (const name of ['descriptor', 'descriptorSignature', 'manifest']) {
    assert.ok(Buffer.isBuffer(input[name])); assert.equal(input[name].length, binding[name].bytes); assert.equal(hash(input[name]), binding[name].sha256);
  }
}
function loadContract(config) {
  assert.deepEqual(Object.keys(config).sort(), ['directory', 'pins', 'schemaVersion', 'targetVersion']);
  assert.equal(config.schemaVersion, 1); assert.equal(config.targetVersion, TARGET.version); assert.ok(path.isAbsolute(config.directory));
  validatePins(config.pins); assert.ok(['0.1.12', '0.1.14'].includes(baselineVersion));
  const read = (name, max) => readBounded(path.join(config.directory, name), max);
  return feed().createProduction017Contract({ targetVersion: TARGET.version, pins: config.pins,
    descriptor: read(feed().DESCRIPTOR, 32768), descriptorSignature: read(`${feed().DESCRIPTOR}.minisig`, 4096),
    manifest: read('latest.json', 32768), installer: read(TARGET.asset, TARGET.bytes) }, baselineVersion);
}
function selectLab(file, target, fixture, env = process.env) {
  assertHost(env); shared.assertProxy(env); assert.equal(fixture, null);
  assert.deepEqual(target, { version: TARGET.version, installer: TARGET.installer, exe: TARGET.exe });
  return loadContract(JSON.parse(readBounded(file, 32768)));
}
function checkBaseline(contract, installer, executable) {
  assert.deepEqual(contract.baseline, BASELINE);
  assert.equal(hash(readBounded(installer, 512 * 1024 * 1024)), BASELINE.installer);
  assert.equal(hash(readBounded(executable, 512 * 1024 * 1024)), BASELINE.exe);
}
function productProvenance() { return { productSource: SOURCE.commit, productTree: SOURCE.tree,
  compilerInputsUnchanged: raw.rootOnlyAssembly?.compilerInputsUnchanged,
  rawSourceUnchanged: raw.rootOnlyAssembly?.rawSourceUnchanged,
  rootOnlyAssembly: raw.rootOnlyAssembly, buildInputsSha256: raw.buildInputsSha256, buildResultSha256: raw.buildResultSha256 }; }
function discoveryScope(contract) {
  validatePins(contract.pins); assert.deepEqual(contract.baseline, BASELINE);
  return { kind: KIND, previousStable: BASELINE.version, baselineRole: 'explicit-pinned-public-version',
    ...productProvenance(), pins: PINS, productionMetadata: true, testOnlyDescriptor: false,
    syntheticCompanionDiscovery: BASELINE.version === '0.1.12', labDiscovery: true, publicDiscovery: false, releaseReady: false };
}
function validateAcquisition(value, revision) {
  validateBinding();
  assert.deepEqual(Object.keys(value).sort(), ['harnessSource', 'privateDraft', 'readbackVerified', 'releaseId', 'releaseTag', 'source', 'files'].sort());
  assert.equal(value.harnessSource, revision); assert.equal(value.privateDraft, true); assert.equal(value.readbackVerified, true);
  assert.equal(value.releaseId, binding.privateRelease.id); assert.equal(value.releaseTag, binding.privateRelease.tag);
  assert.deepEqual(value.source, SOURCE); assert.deepEqual(value.files, binding.assets);
  return value;
}
module.exports = { SOURCE, TARGET, PINS, BASELINE, KIND, validateBinding, assertHost, validatePins, validateInput, loadContract, selectLab, installer,
  checkBaseline, productProvenance, discoveryScope, validateAcquisition, hash, showPage: shared.showPage, assertOwnedDebugging: shared.assertOwnedDebugging,
  freshSettingsBytes: shared.freshSettingsBytes, readBounded, assertRunner: assertHost, get LIMITS() { return feed().LIMITS; },
  startLabProxy: (...args) => feed().startLabProxy(...args) };
