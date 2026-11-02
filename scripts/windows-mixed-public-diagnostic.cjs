'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = require('./native-windows-016-migration.cjs');
const handoff = require('./windows-migrated-outgoing-handoff.cjs');
const candidate = require('./windows-migration-r2-candidate.cjs');
const { readBounded } = require('./read-bounded-input.cjs');
const ROOT = path.resolve(__dirname, '..');
const KIND = 'mixed-public-migration-controlled-outgoing-diagnostic';
function checkExactFixture(config) {
  handoff.checkOutgoingBaseline(config);
  assert.equal(config.sourceCommit, 'e39d853f4207bbc8f250566064027c19d8eeb6e0');
  assert.deepEqual(config.pins, { descriptor: '50bbcc0dfe5a4d22900a65b046145a9f05b185a4f86333c37f6b4277aebe1b6f',
    descriptorSignature: '57df8ee478f8e159a983d2e598b4bbedef15f7eb375a68b4221c12854fcbb733',
    installer: '0a737147db5766e108ece53a6f6ffd5fad2d5d311058effacd4e07ae2d9bf219',
    executable: 'b98e7484bb7d3f2a9d3abb450446285eb24b42deeb31adf02a5694e1b16795a5',
    manifest: 'b80fba85744c023ed6d61a6442bd64d3031074d2d9d7ad9130d3c68e50ef3bf1' });
  assert.equal(config.runtime.targetDescriptor, '1e53158ae6bffe842c7256c1b40a44d59c2d0a6d3f03b5506b1e5f17584d6fda');
}
const STRIP = /^(?:CREATOR_|WEBVIEW2_|NODE_OPTIONS$|NODE_PATH$|NODE_TLS_REJECT_UNAUTHORIZED$|NODE_EXTRA_CA_CERTS$|SSL_CERT_FILE$|SSL_CERT_DIR$|CURL_CA_BUNDLE$|REQUESTS_CA_BUNDLE$|ALL_PROXY$|HTTP_PROXY$|HTTPS_PROXY$|NO_PROXY$)/i;
function admit(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32');
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: 'refs/heads/validation/windows-menu-merge-20261027',
    GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-outgoing-017.yml@refs/heads/validation/windows-menu-merge-20261027',
    CREATOR_MIXED_PUBLIC_DIAGNOSTIC: '1', CREATOR_OUTGOING_CASE: 'mcp-restore', CREATOR_OUTGOING_LAST_TOOL: 'mcp', CREATOR_OUTGOING_RESTORE: 'true', GITHUB_RUN_ATTEMPT: '1' })) assert.equal(env[key], value, key);
  assert.match(env.GITHUB_RUN_ID || '', /^[1-9][0-9]*$/);
  assert.match(env.GITHUB_ACTOR_ID || '', /^[1-9][0-9]*$/); assert.equal(env.GITHUB_ACTOR_ID, env.CREATOR_MIXED_EXPECTED_ACTOR_ID);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/); assert.equal(env.GITHUB_SHA, env.CREATOR_MIXED_EXPECTED_SOURCE);
  for (const key of ['GITHUB_WORKSPACE', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'RUNNER_TEMP']) assert.ok(path.isAbsolute(env[key] || ''), key);
}
async function runMigration(args) {
  admit();
  const env = process.env, saved = Object.fromEntries(Object.entries(env).filter(([name]) => STRIP.test(name)));
  for (const name of Object.keys(env)) if (STRIP.test(name)) delete env[name];
  env.CREATOR_WINDOWS_016_MIGRATION = '1';
  try {
    migration.admission();
    assert.equal(fs.realpathSync(process.cwd()).toLowerCase(), fs.realpathSync(env.GITHUB_WORKSPACE).toLowerCase());
    const artifacts = path.join(ROOT, 'artifacts'), stat = fs.lstatSync(artifacts);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    const before = new Set(fs.readdirSync(artifacts));
    const report = await migration.main(args);
    handoff.checkReport(report, env.GITHUB_SHA);
    const created = fs.readdirSync(artifacts).filter(name => /^native-suite-[0-9]+$/.test(name) && !before.has(name));
    assert.equal(created.length, 1); const out = path.join(artifacts, created[0]);
    const bytes = readBounded(path.join(out, 'migration-016-report.json'), 256 * 1024);
    assert.deepEqual(JSON.parse(bytes), JSON.parse(JSON.stringify(report)));
    const plan = migration.inspectInstalledResources(path.join(env.LOCALAPPDATA, 'Creator Hub'));
    const active = migration.inspectActiveRoute(env.LOCALAPPDATA, plan); assert.deepEqual(active, report.activeRoute);
    const files = handoff.fixtureFiles(env, out), guard = handoff.preservationGuard(files); guard.verify();
    return Object.freeze({ runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, migrationOutput: out,
      migrationReportSha256: candidate.hash(bytes), activeRoute: active, guard,
      files: files.map(item => ({ file: item.file, sha256: candidate.hash(readBounded(item.file, 2 * 1024 * 1024)) })),
      updateAuthority: false, successorQualified: false, releaseReady: false });
  } finally {
    for (const name of Object.keys(env)) if (STRIP.test(name)) delete env[name];
    Object.assign(env, saved);
  }
}
function writeHandoff(result, env = process.env) {
  admit(env); result.guard.verify(); assert.equal(result.files.length, 23);
  const output = path.join(ROOT, 'artifacts/mixed-public-control/migration-handoff.json');
  const receipt = { schemaVersion: 1, kind: KIND, phase: 'public-migration', runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT, source: env.GITHUB_SHA, actorId: env.GITHUB_ACTOR_ID,
    userProfile: env.USERPROFILE, appData: env.APPDATA, localAppData: env.LOCALAPPDATA,
    migrationOutput: path.relative(ROOT, result.migrationOutput), migrationReportSha256: result.migrationReportSha256,
    activeRoute: result.activeRoute, files: result.files, publicNetworkAllowed: true, publicDiscovery: null, publicDiscoveryProven: false, migrationNetworkObserved: false,
    isolationProven: false, combinedAcceptance: false, releaseReady: false };
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  return receipt;
}
function protectHandoffFiles(expected, records) {
  assert.equal(expected.length, 23); assert.ok(Array.isArray(records)); assert.equal(records.length, 23);
  const protectedFiles = expected.map((item, i) => {
    const record = records[i]; assert.equal(record.file, item.file); assert.match(record.sha256, /^[a-f0-9]{64}$/);
    const bytes = readBounded(item.file, 2 * 1024 * 1024); assert.equal(candidate.hash(bytes), record.sha256);
    if (item.expected !== undefined) assert.deepEqual(bytes, item.expected);
    return { file: item.file, expected: bytes };
  });
  const guard = handoff.preservationGuard(protectedFiles); guard.verify(); return guard;
}
function loadHandoff(env = process.env) {
  admit(env);
  const file = path.join(ROOT, 'artifacts/mixed-public-control/migration-handoff.json');
  const data = JSON.parse(readBounded(file, 256 * 1024));
  assert.equal(data.schemaVersion, 1); assert.equal(data.kind, KIND); assert.equal(data.phase, 'public-migration');
  for (const [key, value] of Object.entries({ runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, source: env.GITHUB_SHA,
    actorId: env.GITHUB_ACTOR_ID, userProfile: env.USERPROFILE, appData: env.APPDATA, localAppData: env.LOCALAPPDATA,
    publicNetworkAllowed: true, publicDiscovery: null, publicDiscoveryProven: false, migrationNetworkObserved: false, isolationProven: false, combinedAcceptance: false, releaseReady: false })) assert.equal(data[key], value, key);
  assert.match(data.migrationOutput, /^artifacts[\\/]native-suite-[0-9]+$/);
  const out = path.resolve(ROOT, data.migrationOutput), bytes = readBounded(path.join(out, 'migration-016-report.json'), 256 * 1024);
  assert.equal(candidate.hash(bytes), data.migrationReportSha256); handoff.checkReport(JSON.parse(bytes), env.GITHUB_SHA);
  const guard = protectHandoffFiles(handoff.fixtureFiles(env, out), data.files);
  const plan = migration.inspectInstalledResources(path.join(env.LOCALAPPDATA, 'Creator Hub'));
  const active = migration.inspectActiveRoute(env.LOCALAPPDATA, plan); assert.deepEqual(active, data.activeRoute);
  return { runId: data.runId, runAttempt: data.runAttempt, migrationOutput: out, migrationReportSha256: data.migrationReportSha256,
    activeRoute: active, guard, updateAuthority: false, successorQualified: false, releaseReady: false };
}
function checkReceipt(report, migrationBytes, lifecycleBytes, config, env = process.env) {
  admit(env); checkExactFixture(config);
  assert.equal(report.kind, KIND); assert.equal(report.passed, true);
  assert.equal(report.publicDiscovery, null);
  for (const key of ['publicNetworkAllowed', 'labDiscovery', 'migratedContinuation', 'automaticRestart', 'cancelPreserved',
    'outgoingConnectionSurvived', 'newConnectionVerified', 'restorationVerified', 'policyRestored',
    'fixtureSettingsChecksPassed', 'migratedFixtureFilesUnchangedAfterDriverCleanup', 'activeRouteUnchangedAfterCancel']) assert.equal(report[key], true, key);
  for (const key of ['nativeUpdateAccepted', 'liveAiAcceptance', 'acceptanceOnly', 'releaseReady', 'changedMcpGenerationProven',
    'migrationNetworkObserved', 'publicDiscoveryProven', 'webViewContinuityProven', 'migrationEraConnectionProven', 'combinedAcceptance',
    'initialCleanupUnverified', 'successorCleanupUnverified', 'automaticRouteTransitionProven']) assert.equal(report[key], false, key);
  assert.deepEqual(report.migrationPhase, { publicNetworkAllowed: true, publicDiscovery: 'unproven', networkObservation: 'unobserved', isolationProven: false });
  assert.deepEqual(report.outgoingPhase, { controlledFeed: true, publicDiscovery: false });
  assert.equal(report.sourceCommit, config.sourceCommit); assert.deepEqual(report.baseline, config.baseline); assert.deepEqual(report.pins, config.pins);
  assert.equal(report.lastTool, 'mcp'); assert.equal(report.restore, true); assert.equal(report.restoredLastTool, 'mcp');
  assert.deepEqual(report.beforePeVersion, [0, 1, 16, 0]); assert.deepEqual(report.afterPeVersion, [0, 1, 17, 0]);
  const route = (value, allowed) => {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value));
    assert.equal(value.schemaVersion, 1); assert.ok(allowed.includes(value.descriptorSha256));
    assert.match(value.generation, /^[a-f0-9]{64}$/);
  };
  route(report.beforeRoute, [config.runtime.baselineDescriptor]);
  route(report.preReviewRoute, [config.runtime.baselineDescriptor, config.runtime.targetDescriptor]);
  if (report.preReviewRoute.descriptorSha256 === config.runtime.baselineDescriptor)
    assert.deepEqual(report.preReviewRoute, report.beforeRoute);
  route(report.successorRouteAfterExplicitReview, [config.runtime.targetDescriptor]);
  assert.deepEqual(report.afterRoute, report.successorRouteAfterExplicitReview);
  assert.equal(report.successorRouteObservation, 'after-explicit-client-review');
  assert.equal(report.migratedFixtureFilesChecked, 23); assert.equal(report.migrationRunId, env.GITHUB_RUN_ID);
  assert.equal(report.migrationRunAttempt, env.GITHUB_RUN_ATTEMPT); assert.equal(report.migrationHarnessSource, env.GITHUB_SHA);
  assert.match(report.migrationReceipt, /^artifacts[\\/]native-suite-[0-9]+[\\/]migration-016-report\.json$/);
  assert.ok(Buffer.isBuffer(migrationBytes)); assert.equal(candidate.hash(migrationBytes), report.migrationReportSha256);
  handoff.checkReport(JSON.parse(migrationBytes), env.GITHUB_SHA);
  assert.ok(Buffer.isBuffer(lifecycleBytes));
  const rows = lifecycleBytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse).filter(row => row.kind === 'lab-lifecycle-result');
  assert.equal(rows.length, 1); const result = rows[0];
  assert.equal(result.scenario, KIND); assert.equal(result.actualScope, KIND);
  assert.equal(result.publicDiscovery, null);
  for (const key of ['lifecycleSucceeded', 'cleanupVerified', 'systemTlsVerified', 'labDiscovery', 'publicNetworkAllowed', 'outgoingControlledFeed', 'migrationHandoffBeforeTrust', 'successorCleanupVerified', 'driverRegistered', 'driverGateOpened']) assert.equal(result[key], true, key);
  for (const key of ['isolationProven', 'liveAiAcceptance', 'productAcceptance', 'nativeAcceptanceTested', 'releaseReady',
    'migrationNetworkObserved', 'publicDiscoveryProven', 'webViewContinuityProven', 'migrationEraConnectionProven', 'combinedAcceptance']) assert.equal(result[key], false, key);
  assert.equal(result.migrationNetworkObservation, 'unobserved'); assert.equal(result.driverExitCode, 0);
  assert.equal(result.hubCleanupState, 'verified'); assert.equal(result.hubCleanupUnknown, false);
  assert.equal(result.servedRouteCount, 5); assert.equal(result.rejectedRequestCount, 0);
  return { kind: KIND, diagnosticPassed: true, publicDiscovery: null, publicNetworkAllowed: true, publicDiscoveryProven: false, migrationNetworkObservation: 'unobserved',
    migrationNetworkObserved: false, isolationProven: false, webViewContinuityProven: false, migrationEraConnectionProven: false,
    preReviewRoute: report.preReviewRoute, successorRouteAfterExplicitReview: report.successorRouteAfterExplicitReview,
    successorRouteObservation: 'after-explicit-client-review', automaticRouteTransitionProven: false,
    combinedAcceptance: false, nativeAccepted: false, productionApproval: false, releaseReady: false };
}
function prepareOutgoing(env = process.env) {
  admit(env);
  const outgoing = require('./windows-outgoing-017.cjs'); outgoing.assertHost(env);
  assert.equal(env.INPUT_RUN, '41458124135'); assert.equal(env.INPUT_ARTIFACT, '13147427412');
  assert.equal(env.INPUT_SHA256, '6861cb447f1416a9e2a6a7ab14796cb601896dce934a62fee3dec998006ab73c');
  const reviewBytes = readBounded(path.join(ROOT, 'scripts/fixtures/windows-mixed-public-r2-review.json'), 32768);
  const reviewSha = '1ec982be724555fe0bf8556dd8fa4a997cd7e1772ea87e91e7992d1d8209cdc7';
  assert.equal(candidate.hash(reviewBytes), reviewSha); assert.equal(env.CREATOR_OUTGOING_REVIEW_SHA256, reviewSha);
  const review = outgoing.reviewBytes(reviewBytes, reviewSha);
  const control = path.join(ROOT, 'artifacts/outgoing-017-control');
  const run = JSON.parse(readBounded(path.join(control, 'stager-run.json'), 2 * 1024 * 1024));
  const artifact = JSON.parse(readBounded(path.join(control, 'artifact.json'), 2 * 1024 * 1024));
  assert.equal(run.run_attempt, 1);
  const binding = outgoing.bindArtifact(run, artifact, env, review);
  assert.equal(binding.artifactSource, '4a95cc2193ad158fd47e86e0370898d674c2d23d');
  assert.equal(artifact.workflow_run.repository_id, 1364807512); assert.equal(artifact.workflow_run.head_repository_id, 1364807512);
  const directory = path.join(ROOT, 'artifacts/outgoing-017-data');
  assert.deepEqual(fs.readdirSync(directory).sort(), Object.keys(outgoing.LIMITS).sort());
  const files = Object.fromEntries(Object.entries(outgoing.LIMITS).map(([name, limit]) => [name, readBounded(path.join(directory, name), limit)]));
  const admitted = outgoing.admit(review, files, directory); checkExactFixture(admitted.config);
  fs.writeFileSync(path.join(control, 'runner-config.json'), JSON.stringify(admitted.config, null, 2), { flag: 'wx' });
  return { configSha256: admitted.configSha256, artifactId: binding.artifactId, releaseReady: false };
}
module.exports = { KIND, STRIP, admit, checkExactFixture, runMigration, writeHandoff, protectHandoffFiles, loadHandoff, checkReceipt, prepareOutgoing };
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2); admit();
    if (args.length === 1 && args[0] === '--prepare') { console.log(JSON.stringify(prepareOutgoing())); return; }
    if (args.length === 1 && args[0] === '--migration') {
      const inputs = handoff.migrationInputs(process.env); assert.ok(inputs);
      const result = await runMigration(inputs); const receipt = writeHandoff(result);
      console.log(JSON.stringify({ phase: receipt.phase, publicDiscovery: null, publicNetworkAllowed: true, publicDiscoveryProven: false, migrationNetworkObserved: false, releaseReady: false }));
      return;
    }
    assert.equal(args.length, 2); assert.equal(args[0], '--receipt');
    const reportFile = path.resolve(args[1]), relative = path.relative(ROOT, reportFile);
    assert.match(relative, /^artifacts[\\/]native-suite-[0-9]+[\\/]mixed-public-diagnostic-report\.json$/);
    const reportBytes = readBounded(reportFile, 256 * 1024), report = JSON.parse(reportBytes);
    assert.match(report.migrationReceipt, /^artifacts[\\/]native-suite-[0-9]+[\\/]migration-016-report\.json$/);
    const migrationBytes = readBounded(path.resolve(ROOT, report.migrationReceipt), 256 * 1024);
    const lifecycle = readBounded(path.join(ROOT, 'artifacts/mixed-public-control/lifecycle.jsonl'), 1024 * 1024);
    const target = require('../artifacts/menu-merge-20261027/outgoing/target.cjs');
    const config = target.readConfig(path.join(ROOT, 'artifacts/outgoing-017-control/runner-config.json'));
    const receipt = { ...checkReceipt(report, migrationBytes, lifecycle, config), runId: process.env.GITHUB_RUN_ID,
      source: process.env.GITHUB_SHA, actorId: process.env.GITHUB_ACTOR_ID, reportSha256: candidate.hash(reportBytes),
      migrationReportSha256: candidate.hash(migrationBytes), lifecycleSha256: candidate.hash(lifecycle) };
    fs.writeFileSync(path.join(ROOT, 'artifacts/mixed-public-control/diagnostic-binding.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
    console.log(JSON.stringify(receipt));
  })().catch(error => { console.error(String(error.stack || error).slice(0, 3000)); process.exitCode = 1; });
}
