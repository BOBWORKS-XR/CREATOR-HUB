'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readBounded } = require('./read-bounded-input.cjs');
const ROOT = path.resolve(__dirname, '..');
const BRANCH = 'validation/windows-menu-merge-20261027';
const WORKFLOW = '.github/workflows/windows-outgoing-017.yml';
const ARTIFACT = 'windows-outgoing-017-acceptance-input';
const KIND = 'direct-outgoing-016-017';
const DIRECTORY = '@ARTIFACT_DIRECTORY@';
const TEMPLATE = 'outgoing-017-template.json';
const BASELINE = 'Creator.Hub_0.1.16_x64-setup.exe';
const TARGET = 'Creator_Hub_0.1.17_x64-acceptance-only-setup.exe';
const DESCRIPTOR = 'creator-hub-windows-x86_64.json';
const LIMITS = Object.freeze({ [BASELINE]: 64 * 1024 * 1024, [TARGET]: 64 * 1024 * 1024,
  [DESCRIPTOR]: 32768, [`${DESCRIPTOR}.minisig`]: 4096, 'latest.json': 32768, [TEMPLATE]: 32768 });
const CASES = Object.freeze({ 'mcp-restore': ['mcp', 'true'], 'setup-restore': ['setup', 'true'], 'setup-no-restore': ['setup', 'false'] });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = value => { assert.match(value, /^[a-f0-9]{64}$/); assert.notEqual(value, '0'.repeat(64)); };
function keys(value, names) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Reviewed pins are not populated');
  assert.deepEqual(Object.keys(value).sort(), [...names].sort());
}
const json = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
function assertHost(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32');
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
    GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: `refs/heads/${BRANCH}` })) {
    assert.equal(env[key], value, `Disposable manual validation runner required: ${key}`);
  }
  assert.equal(env.GITHUB_WORKFLOW_REF, `BOBWORKS-XR/CREATOR-HUB/${WORKFLOW}@refs/heads/${BRANCH}`);
  assert.match(env.GITHUB_SHA, /^[a-f0-9]{40}$/); assert.match(env.GITHUB_RUN_ID, /^[1-9][0-9]*$/);
  assert.match(env.GITHUB_RUN_ATTEMPT, /^[1-9][0-9]*$/);
  assert.ok(Object.hasOwn(CASES, env.CREATOR_OUTGOING_CASE));
  assert.deepEqual([env.CREATOR_OUTGOING_LAST_TOOL, env.CREATOR_OUTGOING_RESTORE], CASES[env.CREATOR_OUTGOING_CASE]);
}
function reviewBytes(bytes, expected) {
  const review = json(bytes);
  keys(review, ['schemaVersion', 'kind', 'receiptSha256', 'configCanonicalSha256', 'stagerWorkflow', 'files']);
  digest(expected); assert.equal(hash(bytes), expected, 'Independently reviewed admission-file digest differs');
  assert.equal(review.schemaVersion, 1); assert.equal(review.kind, KIND);
  digest(review.receiptSha256); digest(review.configCanonicalSha256);
  assert.match(review.stagerWorkflow, /^\.github\/workflows\/[a-z0-9-]+\.yml$/);
  keys(review.files, Object.keys(LIMITS));
  for (const [name, pin] of Object.entries(review.files)) {
    keys(pin, ['bytes', 'sha256']); digest(pin.sha256);
    assert.ok(Number.isSafeInteger(pin.bytes) && pin.bytes > 0 && pin.bytes <= LIMITS[name]);
  }
  return review;
}
function inputs(env) {
  for (const key of ['INPUT_RUN', 'INPUT_ARTIFACT']) assert.match(env[key] || '', /^[1-9][0-9]{0,19}$/);
  digest(env.INPUT_SHA256); return env;
}
function bindArtifact(run, artifact, env, review) {
  inputs(env);
  for (const id of [run.id, artifact.id, artifact.workflow_run?.id]) assert.ok(Number.isSafeInteger(id) && id > 0);
  assert.equal(String(run.id), env.INPUT_RUN); assert.equal(String(artifact.id), env.INPUT_ARTIFACT);
  assert.equal(run.repository?.id, 1364807512); assert.equal(run.head_repository?.id, 1364807512);
  assert.equal(run.event, 'workflow_dispatch'); assert.equal(run.head_branch, BRANCH);
  assert.equal(run.path, review.stagerWorkflow); assert.match(run.head_sha, /^[a-f0-9]{40}$/);
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
  assert.equal(artifact.name, ARTIFACT); assert.equal(artifact.expired, false);
  assert.equal(artifact.workflow_run.id, run.id); assert.equal(artifact.workflow_run.head_sha, run.head_sha);
  assert.equal(artifact.digest, `sha256:${env.INPUT_SHA256}`);
  assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 128 * 1024 * 1024);
  return { artifactId: artifact.id, runId: run.id, artifactSource: run.head_sha, archiveSha256: env.INPUT_SHA256,
    harnessSource: env.GITHUB_SHA, harnessRun: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT,
    case: env.CREATOR_OUTGOING_CASE, reviewSha256: env.CREATOR_OUTGOING_REVIEW_SHA256, receiptSha256: review.receiptSha256 };
}
function admit(review, files, directory) {
  keys(files, Object.keys(LIMITS)); assert.ok(path.isAbsolute(directory));
  for (const [name, pin] of Object.entries(review.files)) {
    assert.ok(Buffer.isBuffer(files[name])); assert.equal(files[name].length, pin.bytes, `Size differs: ${name}`);
    assert.equal(hash(files[name]), pin.sha256, `Hash differs: ${name}`);
  }
  const template = json(files[TEMPLATE]);
  keys(template, ['schemaVersion', 'receiptSha256', 'config']);
  assert.equal(template.schemaVersion, 1); assert.equal(template.receiptSha256, review.receiptSha256);
  const config = template.config;
  keys(config, ['schemaVersion', 'kind', 'sourceCommit', 'baseline', 'targetVersion', 'directory', 'pins', 'runtime']);
  assert.equal(config.directory, DIRECTORY, 'Only the reviewed portable directory marker may be replaced');
  assert.equal(hash(JSON.stringify(config)), review.configCanonicalSha256, 'Reviewed portable config digest differs');
  keys(config.baseline, ['version', 'installer', 'exe']);
  keys(config.pins, ['descriptor', 'descriptorSignature', 'installer', 'executable', 'manifest']);
  keys(config.runtime, ['baselineDescriptor', 'targetDescriptor']);
  assert.equal(config.schemaVersion, 1); assert.equal(config.kind, KIND);
  assert.match(config.sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(config.baseline.version, '0.1.16'); assert.equal(config.targetVersion, '0.1.17');
  for (const value of [config.baseline.installer, config.baseline.exe, ...Object.values(config.pins), ...Object.values(config.runtime)]) digest(value);
  assert.equal(config.baseline.installer, review.files[BASELINE].sha256);
  for (const [key, file] of Object.entries({ installer: TARGET, descriptor: DESCRIPTOR,
    descriptorSignature: `${DESCRIPTOR}.minisig`, manifest: 'latest.json' })) assert.equal(config.pins[key], review.files[file].sha256);
  // All template bytes were independently pinned. Directory is the only substitution.
  const materialized = { ...config, directory };
  return { config: materialized, configSha256: hash(JSON.stringify(materialized)), receiptSha256: review.receiptSha256,
    configCanonicalSha256: review.configCanonicalSha256 };
}
function checkReceipt(report, lifecycle, config, caseName) {
  assert.ok(Object.hasOwn(CASES, caseName)); const [lastTool, restore] = CASES[caseName];
  assert.equal(report.kind, KIND); assert.equal(report.sourceCommit, config.sourceCommit);
  assert.deepEqual(report.baseline, config.baseline); assert.deepEqual(report.pins, config.pins);
  assert.equal(report.lastTool, lastTool); assert.equal(report.restore, restore === 'true');
  assert.equal(report.restoredLastTool, restore === 'true' ? lastTool : null);
  for (const key of ['passed', 'nativeUpdateAccepted', 'automaticRestart', 'cancelPreserved', 'settingsPreserved',
    'existingConnectionSurvived', 'newConnectionVerified', 'restorationVerified', 'policyRestored', 'labDiscovery', 'acceptanceOnly']) assert.equal(report[key], true, key);
  for (const key of ['publicDiscovery', 'liveAiAcceptance', 'releaseReady']) assert.equal(report[key], false, key);
  assert.deepEqual(report.beforePeVersion, [0, 1, 16, 0]); assert.deepEqual(report.afterPeVersion, [0, 1, 17, 0]);
  const results = lifecycle.filter(row => row.kind === 'lab-lifecycle-result'); assert.equal(results.length, 1);
  const result = results[0];
  assert.equal(result.scenario, KIND); assert.equal(result.actualScope, 'exact-direct16-to-root-only17-acceptance-fixture-lab-only');
  for (const key of ['lifecycleSucceeded', 'cleanupVerified', 'systemTlsVerified', 'labDiscovery']) assert.equal(result[key], true, key);
  for (const key of ['publicDiscovery', 'liveAiAcceptance', 'productAcceptance', 'releaseReady']) assert.equal(result[key], false, key);
  assert.equal(result.driverExitCode, 0); assert.equal(result.servedRouteCount, 5); assert.equal(result.rejectedRequestCount, 0);
}
function read(file, max = 32768) {
  const bytes = readBounded(path.resolve(file), max); assert.equal(fs.lstatSync(file).nlink, 1); return bytes;
}
function main(args, env = process.env) {
  assertHost(env); // No artifact/config/profile read or write before host refusal.
  const review = reviewBytes(read(path.join(__dirname, 'windows-outgoing-017-review.json')), env.CREATOR_OUTGOING_REVIEW_SHA256);
  inputs(env);
  const control = path.join(ROOT, 'artifacts/outgoing-017-control');
  const write = (name, value) => fs.writeFileSync(path.join(control, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const mode = args[0];
  if (mode === 'review') { assert.equal(args.length, 1); return { reviewed: true, receiptSha256: review.receiptSha256 }; }
  const binding = bindArtifact(json(read(path.join(control, 'stager-run.json'), 2 * 1024 * 1024)),
    json(read(path.join(control, 'artifact.json'), 2 * 1024 * 1024)), env, review);
  if (mode === 'bind') { assert.equal(args.length, 1); write('input-binding.json', binding); return binding; }
  assert.ok(['prepare', 'contract', 'receipt'].includes(mode));
  assert.equal(args.length, mode === 'receipt' ? 4 : 2);
  const directory = path.resolve(args[1]);
  assert.deepEqual(fs.readdirSync(directory).sort(), Object.keys(LIMITS).sort(), 'Only the six flat reviewed data files are admitted');
  const files = Object.fromEntries(Object.entries(LIMITS).map(([name, max]) => [name, read(path.join(directory, name), max)]));
  const admitted = admit(review, files, directory);
  const configPath = path.join(control, 'runner-config.json');
  if (mode === 'prepare') {
    write('runner-config.json', admitted.config); write('admission.json', { ...binding, ...admitted });
    return { configSha256: admitted.configSha256, receiptSha256: admitted.receiptSha256 };
  }
  assert.deepEqual(json(read(configPath)), admitted.config);
  assert.equal(env.CREATOR_OUTGOING_CONFIG_SHA256, admitted.configSha256);
  const target = require('../artifacts/menu-merge-20261027/outgoing/target.cjs');
  target.loadContract(admitted.config, env); // Native production-key verification remains in the updater.
  if (mode === 'contract') return { contractPinned: true, configSha256: admitted.configSha256 };
  const reportBytes = read(args[2], 256 * 1024), lifecycleBytes = read(args[3], 1024 * 1024);
  const report = json(reportBytes);
  const lifecycle = lifecycleBytes.toString('utf8').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  checkReceipt(report, lifecycle, admitted.config, env.CREATOR_OUTGOING_CASE);
  const result = { ...binding, configSha256: admitted.configSha256, reportSha256: hash(reportBytes),
    lifecycleSha256: hash(lifecycleBytes), nativeAccepted: true, acceptanceOnly: true, releaseReady: false };
  write('acceptance-binding.json', result); return result;
}
module.exports = { BRANCH, WORKFLOW, ARTIFACT, KIND, DIRECTORY, TEMPLATE, BASELINE, TARGET, DESCRIPTOR, LIMITS, CASES,
  hash, assertHost, reviewBytes, inputs, bindArtifact, admit, checkReceipt, main };
if (require.main === module) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
  catch (error) { console.error(String(error.message).slice(0, 1600)); process.exitCode = 1; }
}
