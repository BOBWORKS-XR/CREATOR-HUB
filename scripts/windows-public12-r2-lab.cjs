'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const candidate = require('./windows-incoming-016.cjs');
const feed = require('./self-update-lab-feed.cjs');
const { selectBaseline } = require('./self-update-baselines.cjs');
const BRANCH = 'validation/windows-menu-merge-20261027';
const WORKFLOW = '.github/workflows/windows-incoming-016.yml';
const BASELINE = Object.freeze(selectBaseline('0.1.13'));
const KIND = 'public12-r2-test-descriptor-lab-only';
function assertHost(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32');
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
    GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: `refs/heads/${BRANCH}`, GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${WORKFLOW}@refs/heads/${BRANCH}`,
    CREATOR_PUBLIC12_R2_LAB: '1' })) assert.equal(env[key], value, `Disposable public12 lab refused: ${key}`);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
  assert.equal(env.CREATOR_HOSTED_UPDATE_FIXTURE, undefined);
}
function validatePins(pins) {
  candidate.validatePins(pins);
  for (const value of Object.values(pins)) assert.notEqual(value, '0'.repeat(64));
}
function loadContract(config) {
  assert.deepEqual(Object.keys(config).sort(), ['directory', 'pins', 'schemaVersion', 'targetVersion']);
  assert.equal(config.schemaVersion, 1); assert.equal(config.targetVersion, candidate.TARGET.version);
  assert.ok(path.isAbsolute(config.directory)); validatePins(config.pins);
  const data = feed.readBounded(path.join(config.directory, feed.DESCRIPTOR), feed.LIMITS.metadata);
  const descriptor = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
  assert.equal(descriptor.minHubVersion, '0.1.12'); assert.equal(descriptor.assetName, candidate.TARGET.asset);
  assert.equal(descriptor.identityProtocol, 0); assert.equal(descriptor.lifecycleProtocol, 0);
  assert.equal(descriptor.sha256, candidate.TARGET.installer); assert.equal(descriptor.executableSha256, candidate.TARGET.exe);
  const contract = feed.loadContract(config);
  assert.deepEqual(contract.baseline, BASELINE); return contract;
}
function requireReviewedDiscovery(contract, env = process.env) {
  assert.equal(env.CREATOR_PUBLIC12_R2_EMPTY_DISCOVERY, '1', 'Explicit signed012 synthetic discovery opt-in required');
  const bound = feed.bindSigned012EmptyDiscovery(contract, env);
  assert.equal(bound.syntheticDiscovery, true); return contract;
}
if (require.main === module) {
  try {
    assertHost();
    const [command, file] = process.argv.slice(2); assert.equal(command, 'check'); assert.ok(path.isAbsolute(file));
    const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(feed.readBounded(file, feed.LIMITS.metadata)));
    const contract = requireReviewedDiscovery(loadContract(config));
    console.log(JSON.stringify({ kind: KIND, pins: contract.pins, baseline: BASELINE, testOnlyDescriptor: true,
      labDiscovery: false, nativeAcceptance: false, publicDiscovery: false, releaseReady: false }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
function selectLab(configPath, target, fixture, env = process.env) {
  assertHost(env); candidate.assertProxy(env); assert.equal(fixture, null);
  assert.ok(path.isAbsolute(configPath)); assert.equal(target.version, candidate.TARGET.version);
  assert.equal(target.installer, candidate.TARGET.installer); assert.equal(target.exe, candidate.TARGET.exe);
  return requireReviewedDiscovery(loadContract(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(feed.readBounded(configPath, feed.LIMITS.metadata)))), env);
}
function checkBaseline(contract, installer, executable) {
  assert.deepEqual(contract.baseline, BASELINE);
  feed.assertBaselineBytes(contract.targetVersion, feed.readBounded(installer, feed.LIMITS.installer), feed.readBounded(executable, feed.LIMITS.installer));
}
function discoveryScope(contract) {
  assert.deepEqual(contract.baseline, BASELINE);
  return { kind: KIND, previousStable: BASELINE.version, baselineRole: 'targeted-historical-public-baseline-not-previous-stable',
    targetVersion: candidate.TARGET.version, pins: contract.pins, ...candidate.productProvenance(),
    labDiscovery: true, publicDiscovery: false, migrationAccepted: false, releaseReady: false };
}
module.exports = { KIND, BRANCH, WORKFLOW, BASELINE, TARGET: candidate.TARGET, assertHost, validatePins, loadContract, requireReviewedDiscovery, selectLab, checkBaseline,
  discoveryScope, showPage: candidate.showPage, assertOwnedDebugging: candidate.assertOwnedDebugging };
