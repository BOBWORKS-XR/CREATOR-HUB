'use strict';
// Finite 019 rebind of e4459b0 windows-017-production.cjs.
const assert = require('node:assert/strict');
const path = require('node:path');
const { readBounded } = require('./read-bounded-input.cjs');
const shared = require('./windows-019-shared.cjs');
const c = require('./windows-019-contract.cjs');
const { pinned } = c;
const SOURCE = Object.freeze(pinned.source);
const TARGET = Object.freeze({ version: c.VERSION, asset: c.ASSET, bytes: pinned.installer.bytes,
  installer: pinned.installer.sha256, exe: pinned.executable.sha256, productSource: SOURCE.commit });
const assets = pinned.production.assets;
const PINS = Object.freeze({ descriptor: assets['creator-hub-windows-x86_64.json'].sha256,
  descriptorSignature: assets['creator-hub-windows-x86_64.json.minisig'].sha256,
  manifest: assets['latest.json'].sha256, installer: TARGET.installer, executable: TARGET.exe });
const baselineVersion = process.env.CREATOR_PRODUCTION_019_BASELINE || '0.1.12';
const BASELINE = c.baselineFor(baselineVersion);
const KIND = `targeted-public-${BASELINE.version}-production-metadata`;
function validateBinding() { return c.validateProduction(); }
function assertHost(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32');
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: c.PRODUCTION_REF, GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-019-production.yml@${c.PRODUCTION_REF}`,
    CREATOR_WINDOWS_019_PRODUCTION: '1' })) assert.equal(env[key], value, key);
  assert.ok(['incoming', 'incoming-migration'].includes(env.GITHUB_JOB));
  assert.ok(['0.1.12', '0.1.14', '0.1.18'].includes(env.CREATOR_PRODUCTION_019_BASELINE));
  if (env.GITHUB_JOB === 'incoming-migration') assert.equal(env.CREATOR_PRODUCTION_019_BASELINE, '0.1.12');
  c.digest(env.GITHUB_SHA, 40); assert.equal(env.EXPECTED_HARNESS_COMMIT, env.GITHUB_SHA);
  assert.equal(env.CREATOR_HOSTED_UPDATE_FIXTURE, undefined); assert.equal(env.CREATOR_PUBLIC12_R2_LAB, undefined);
  validateBinding();
}
function validatePins(pins) { validateBinding(); assert.deepEqual(pins, PINS); }
function installer(file) {
  validateBinding(); assert.ok(path.isAbsolute(file));
  const bytes = readBounded(file, TARGET.bytes); assert.equal(bytes.length, TARGET.bytes); assert.equal(c.hash(bytes), TARGET.installer); return file;
}
function validateInput(input) {
  validatePins(input.pins); assert.equal(input.targetVersion, TARGET.version);
  for (const [key, pin] of Object.entries({ installer: { bytes: TARGET.bytes, sha256: TARGET.installer },
    descriptor: assets['creator-hub-windows-x86_64.json'], descriptorSignature: assets['creator-hub-windows-x86_64.json.minisig'], manifest: assets['latest.json'] })) {
    assert.ok(Buffer.isBuffer(input[key])); assert.equal(input[key].length, pin.bytes ?? pin.size); assert.equal(c.hash(input[key]), pin.sha256);
  }
}
function loadContract(config) {
  c.keys(config, ['directory', 'pins', 'schemaVersion', 'targetVersion']); assert.equal(config.schemaVersion, 1);
  assert.equal(config.targetVersion, TARGET.version); assert.ok(path.isAbsolute(config.directory)); validatePins(config.pins);
  const feed = require('./self-update-lab-feed-019.cjs');
  const read = (name, max) => readBounded(path.join(config.directory, name), max);
  return feed.createProduction019Contract({ targetVersion: TARGET.version, pins: config.pins,
    descriptor: read(feed.DESCRIPTOR, 32768), descriptorSignature: read(`${feed.DESCRIPTOR}.minisig`, 4096),
    manifest: read('latest.json', 32768), installer: read(TARGET.asset, TARGET.bytes) }, baselineVersion);
}
function selectLab(file, target, fixture, env = process.env) {
  assertHost(env); shared.assertProxy(env); assert.equal(fixture, null);
  assert.deepEqual(target, { version: TARGET.version, installer: TARGET.installer, exe: TARGET.exe });
  return loadContract(JSON.parse(readBounded(file, 32768)));
}
function checkBaseline(contract, installerPath, executable) {
  assert.deepEqual(contract.baseline, BASELINE);
  assert.equal(c.hash(readBounded(installerPath, 512 * 1024 * 1024)), BASELINE.installer);
  assert.equal(c.hash(readBounded(executable, 512 * 1024 * 1024)), BASELINE.exe);
}
function productProvenance() {
  const provenance = c.validateBuildProvenance(pinned);
  return { productSource: SOURCE.commit, productTree: SOURCE.tree, sourceUnchanged: provenance.sourceUnchanged,
    buildProvenance: provenance, buildInputsSha256: pinned.build.inputsSha256, buildResultSha256: pinned.build.resultSha256 };
}
function discoveryScope(contract) {
  validatePins(contract.pins); assert.deepEqual(contract.baseline, BASELINE);
  return { kind: KIND, previousStable: BASELINE.version, baselineRole: 'explicit-pinned-public-version', ...productProvenance(), pins: PINS,
    productionMetadata: true, testOnlyDescriptor: false, syntheticCompanionDiscovery: BASELINE.version === '0.1.12', labDiscovery: true, publicDiscovery: false, releaseReady: false };
}
function validateAcquisition(value, revision) {
  validateBinding(); c.keys(value, ['harnessSource', 'privateDraft', 'readbackVerified', 'releaseId', 'releaseTag', 'source', 'files']);
  assert.equal(value.harnessSource, revision); assert.equal(value.privateDraft, true); assert.equal(value.readbackVerified, true);
  assert.equal(value.releaseId, pinned.production.releaseId); assert.equal(value.releaseTag, pinned.production.releaseTag);
  assert.deepEqual(value.source, SOURCE); assert.deepEqual(value.files, assets); return value;
}
module.exports = { SOURCE, TARGET, PINS, BASELINE, KIND, binding: pinned, validateBinding, assertHost, validatePins, validateInput, loadContract,
  selectLab, installer, checkBaseline, productProvenance, discoveryScope, validateAcquisition, hash: c.hash,
  showPage: shared.showPage, assertOwnedDebugging: shared.assertOwnedDebugging, freshSettingsBytes: shared.freshSettingsBytes,
  readBounded, assertRunner: assertHost, get LIMITS() { return require('./self-update-lab-feed-019.cjs').LIMITS; },
  startLabProxy: (...args) => require('./self-update-lab-feed-019.cjs').startLabProxy(...args) };
