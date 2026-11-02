'use strict';
// Same-run migration handoff; successor admission remains the outgoing driver's responsibility.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = require('./native-windows-016-migration.cjs');
const candidate = require('./windows-migration-r2-candidate.cjs');
const { readBounded } = require('./read-bounded-input.cjs');

const input = Object.freeze({ artifactId: 13141988162, runId: 41446190810,
  artifactSource: 'bd980ed2b02ba5d00bce25d156d67f6a2f45253d',
  archiveSha256: 'fabe440d1108114a0ca810a1115a29e19c08e7a77f30aa370d46a3cb2481a53e' });
function checkReport(report, revision) {
  assert.match(revision, /^[a-f0-9]{40}$/);
  assert.equal(report.schemaVersion, 1); assert.equal(report.scope, 'exact-direct16-three-client-clean-legacy-guide-probe');
  assert.equal(report.testSource, revision); assert.equal(report.passed, true);
  for (const [key, value] of Object.entries(candidate.productProvenance())) assert.deepEqual(report[key], value);
  assert.equal(report.installerSha256, candidate.TARGET.installer); assert.equal(report.executableSha256, candidate.TARGET.exe);
  for (const key of ['nativeGuideAccepted', 'repeatStartupAccepted', 'settingsPreserved', 'cancelAccepted', 'installedResourcesVerified', 'policyRestored']) assert.equal(report[key], true);
  for (const key of ['migrationAccepted', 'signedUpdateAccepted', 'liveAiAppAccepted', 'crashRecoveryAccepted', 'backupBeforeEveryWriteAccepted', 'releaseReady', 'userMachineUsed']) assert.equal(report[key], false);
  assert.equal(report.nativeDecisions.length, 2);
  const binding = migration.validateProvenance(report.inputBinding, revision);
  for (const [key, value] of Object.entries(input)) assert.equal(binding[key], value);
  const hub = report.baselines.filter(row => row.product === 'Creator Hub'); assert.equal(hub.length, 1);
  assert.deepEqual(hub[0], { product: 'Creator Hub', version: '0.1.12',
    installerSha256: '0cd8a4493dd9a5b77fbc5fe160582a2b2698fea43aedd9118b2d5b3bd3c51a18',
    executableSha256: '34c6f05548f469ac23b4faee7aa8355d5cca083c444c4f7b0942426a9c76a7ac' });
}
// This only binds the outgoing baseline; existing successor admission is still required.
function checkOutgoingBaseline(config) {
  assert.ok(config && typeof config === 'object' && !Array.isArray(config));
  assert.deepEqual(config.baseline, { version: candidate.TARGET.version,
    installer: candidate.TARGET.installer, exe: candidate.TARGET.exe });
  assert.equal(config.targetVersion, '0.1.17');
  assert.equal(config.runtime?.baselineDescriptor, migration.RESOURCE_PINS['routing/runtime.json']);
}
function migrationInputs(env, paths = path) {
  const keys = ['CREATOR_MIGRATED_CONTINUATION', 'CREATOR_MIGRATED_CANDIDATE', 'CREATOR_MIGRATED_BASELINES'];
  const supplied = Object.keys(env).filter(key => /^CREATOR_MIGRATED_/i.test(key));
  if (!supplied.length) return null;
  assert.ok(supplied.every(key => keys.includes(key)), 'Unknown migrated continuation setting');
  assert.equal(env.CREATOR_MIGRATED_CONTINUATION, '1');
  const inputs = [env.CREATOR_MIGRATED_CANDIDATE, env.CREATOR_MIGRATED_BASELINES];
  assert.ok(inputs.every(value => typeof value === 'string' && value.length <= 4096 && paths.isAbsolute(value) && !/[\r\n\0]/.test(value)));
  assert.notEqual(paths.resolve(inputs[0]).toLowerCase(), paths.resolve(inputs[1]).toLowerCase());
  return inputs;
}
function preservationGuard(files) {
  assert.ok(Array.isArray(files) && files.length > 0);
  const seen = new Set();
  const rows = files.map(({ file, expected }) => {
    assert.ok(path.isAbsolute(file));
    const key = path.resolve(file).toLowerCase(); assert.ok(!seen.has(key), 'Duplicate protected file'); seen.add(key);
    const bytes = readBounded(file, 2 * 1024 * 1024);
    if (expected !== undefined) assert.deepEqual(bytes, expected, 'Migration backup or fixture differs');
    return { file, bytes };
  });
  let refusal;
  function verify() {
    if (refusal) throw refusal;
    try { for (const row of rows) assert.deepEqual(readBounded(row.file, 2 * 1024 * 1024), row.bytes, 'Migrated profile changed'); }
    catch (error) { refusal = error; throw error; }
  }
  return Object.freeze({ verify, fileCount: rows.length });
}
function fixtureFiles(env, out) {
  const fixture = migration.fixture(env, out);
  const storesAndClients = [...fixture.stores, ...fixture.clients];
  const entries = [...storesAndClients.map(item => ({ file: item.path })),
    ...storesAndClients.map(item => ({ file: migration.backupFile(item.path, item.bytes), expected: item.bytes })),
    ...fixture.untouched.map(item => ({ file: item.path, expected: item.bytes }))];
  for (const project of [fixture.projectA, fixture.projectB]) {
    entries.push({ file: path.join(project, 'ProjectSettings/ProjectVersion.txt'), expected: Buffer.from('m_EditorVersion: 6000.3.21f1\n') });
    entries.push({ file: path.join(project, 'Packages/manifest.json'), expected: Buffer.from('{"dependencies":{}}\n') });
    entries.push({ file: path.join(project, 'Assets/AuthoredContent.txt'), expected: Buffer.from('Never modify a Unity project during migration\n') });
  }
  return entries;
}
async function runAndCapture(args) {
  migration.admission();
  assert.match(process.env.GITHUB_RUN_ID || '', /^[1-9][0-9]*$/);
  assert.match(process.env.GITHUB_RUN_ATTEMPT || '', /^[1-9][0-9]*$/);
  assert.ok(path.isAbsolute(process.env.GITHUB_WORKSPACE || ''));
  assert.equal(fs.realpathSync(process.cwd()).toLowerCase(), fs.realpathSync(process.env.GITHUB_WORKSPACE).toLowerCase(), 'Exact runner workspace required');
  const artifacts = path.resolve('artifacts');
  assert.ok(fs.lstatSync(artifacts).isDirectory() && !fs.lstatSync(artifacts).isSymbolicLink());
  const before = new Set(fs.readdirSync(artifacts));
  const report = await migration.main(args);
  checkReport(report, process.env.GITHUB_SHA);
  const created = fs.readdirSync(artifacts).filter(name => /^native-suite-[0-9]+$/.test(name) && !before.has(name));
  assert.equal(created.length, 1, 'Exactly one same-process migration output required');
  const out = path.join(artifacts, created[0]);
  const reportBytes = readBounded(path.join(out, 'migration-016-report.json'), 256 * 1024);
  const onDisk = JSON.parse(reportBytes);
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(report)), 'In-process migration and retained report differ');
  const hub = path.join(process.env.LOCALAPPDATA, 'Creator Hub');
  const plan = migration.inspectInstalledResources(hub);
  const active = migration.inspectActiveRoute(process.env.LOCALAPPDATA, plan);
  assert.deepEqual(active, report.activeRoute, 'R2 route differs after migration');
  const guard = preservationGuard(fixtureFiles(process.env, out));
  guard.verify();
  return Object.freeze({ runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    migrationOutput: out, migrationReportSha256: candidate.hash(reportBytes), baselineExecutableSha256: candidate.TARGET.exe, activeRoute: active, guard,
    updateAuthority: false, successorQualified: false, changedMcpGenerationProven: false, releaseReady: false });
}
function requireMigrationNetworkIsolation() {
  throw Error('Migrated continuation disabled: migration network isolation is not established');
}
async function runWithMigrationEnvironment(args, env = process.env, run = runAndCapture, checkNetwork = requireMigrationNetworkIsolation) {
  checkNetwork();
  const forbidden = /^(?:CREATOR_|WEBVIEW2_|NODE_OPTIONS$|NODE_PATH$|NODE_TLS_REJECT_UNAUTHORIZED$|NODE_EXTRA_CA_CERTS$|SSL_CERT_FILE$|SSL_CERT_DIR$|CURL_CA_BUNDLE$|REQUESTS_CA_BUNDLE$|ALL_PROXY$|HTTP_PROXY$|HTTPS_PROXY$|NO_PROXY$)/i;
  const saved = Object.fromEntries(Object.entries(env).filter(([name]) => forbidden.test(name)));
  for (const name of Object.keys(env)) if (forbidden.test(name)) delete env[name];
  env.CREATOR_WINDOWS_016_MIGRATION = '1';
  try { return await run(args); }
  finally {
    for (const name of Object.keys(env)) if (forbidden.test(name)) delete env[name];
    Object.assign(env, saved);
  }
}
module.exports = { input, checkReport, checkOutgoingBaseline, migrationInputs, preservationGuard, fixtureFiles, runAndCapture, requireMigrationNetworkIsolation, runWithMigrationEnvironment };
