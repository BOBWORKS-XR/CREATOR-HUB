'use strict';
// Synthetic pre-update fixture only. No update, migration or continuation authority.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const incoming = require('./windows-019-production.cjs');
const public12 = require('./windows-019-production.cjs');
const migration = require('./native-windows-019-migration.cjs');
const { readBounded } = require('./read-bounded-input.cjs');

// The incoming lane stays disabled until process handoff and this writer are reviewed.
const INCOMING_FIXTURE_ENABLED = false;
const KIND = 'incoming-migration-synthetic-preupdate-snapshot';
const FEED_PINS = incoming.PINS;
const LEGACY = Object.freeze([
  ['Creator Hub/creator-hub.exe', public12.BASELINE.exe],
  ['Creator Works MCP/creator-works-mcp-launcher.exe', '765ad40681c9ad69f2748ce5e9873b59971488acdd3f826e90946af835e36af9'],
  ['Creator Project Setup/creator-project-setup.exe', '74653db61681e29a18a308c393e1b8790a86a7ed674ca6abe73f35da0a0f4ed6'],
]);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function admit(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32');
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_JOB: 'incoming-migration', GITHUB_REF: 'refs/heads/validation/windows-019-production',
    GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-019-production.yml@refs/heads/validation/windows-019-production',
    CREATOR_PRODUCTION_019_MIGRATION: '1', GITHUB_RUN_ATTEMPT: '1' })) assert.equal(env[key], value, key);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/); assert.equal(env.GITHUB_SHA, env.CREATOR_PRODUCTION_019_SOURCE);
  assert.match(env.GITHUB_RUN_ID || '', /^[1-9][0-9]*$/);
  for (const key of ['GITHUB_WORKSPACE', 'RUNNER_TEMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) assert.ok(path.isAbsolute(env[key] || ''), key);
  assert.ok(migration.inside(env.USERPROFILE, env.APPDATA) && migration.inside(env.USERPROFILE, env.LOCALAPPDATA));
}
function noLinks(file) {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    let info;
    try { info = fs.lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (info) assert.equal(info.isSymbolicLink(), false, 'Redirected fixture path refused');
    if (path.dirname(current) === current) break;
  }
}
function assertMissing(file, inspect = fs.lstatSync) {
  try { inspect(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw Error('Existing fixture target refused');
}
function preflightFixtureRows(rows, linkCheck = noLinks, inspect = fs.lstatSync) {
  assert.equal(rows.length, 17);
  const seen = new Set();
  for (const row of rows) {
    assert.ok(path.isAbsolute(row.path) && Buffer.isBuffer(row.bytes) && row.bytes.length <= 1024 * 1024);
    const key = path.resolve(row.path).toLowerCase(); assert.ok(!seen.has(key)); seen.add(key);
    linkCheck(row.path); assertMissing(row.path, inspect);
  }
}
function profileIdentity(env) {
  const result = {};
  for (const key of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    noLinks(env[key]); const real = fs.realpathSync(env[key]); const stat = fs.statSync(real, { bigint: true });
    assert.ok(stat.isDirectory() && stat.ino !== 0n, 'Profile identity unavailable');
    result[key] = { path: real, dev: stat.dev.toString(), ino: stat.ino.toString() };
  }
  return result;
}
function fixturePlan(env, out) {
  const fixture = migration.fixture(env, out), rows = [...fixture.stores, ...fixture.clients, ...fixture.untouched];
  for (const project of [fixture.projectA, fixture.projectB]) {
    rows.push({ path: path.join(project, 'ProjectSettings/ProjectVersion.txt'), bytes: Buffer.from('m_EditorVersion: 6000.3.21f1\n') });
    rows.push({ path: path.join(project, 'Packages/manifest.json'), bytes: Buffer.from('{"dependencies":{}}\n') });
    rows.push({ path: path.join(project, 'Assets/AuthoredContent.txt'), bytes: Buffer.from('Never modify a Unity project during migration\n') });
  }
  assert.equal(rows.length, 17);
  const seen = new Set();
  for (const row of rows) {
    assert.ok(path.isAbsolute(row.path) && Buffer.isBuffer(row.bytes));
    assert.ok(migration.inside(env.USERPROFILE, row.path) || migration.inside(out, row.path), 'Fixture escaped owned roots');
    const name = path.resolve(row.path).toLowerCase(); assert.ok(!seen.has(name)); seen.add(name);
  }
  return rows;
}
function metadata(rows) { return rows.map(row => ({ path: row.path, size: row.bytes.length, sha256: hash(row.bytes) })); }
function signedUpdateRoot(out) {
  const match = /^native-suite-([0-9]+)$/.exec(path.basename(out));
  assert.ok(match && path.isAbsolute(out));
  return path.join(path.dirname(out), `native-suite-${match[1]}001`);
}
function checkFixtureBytes({ env, out, recorded, read = checkedFile }) {
  admit(env, 'win32');
  const artifacts = path.join(env.GITHUB_WORKSPACE, 'artifacts');
  assert.ok(migration.inside(artifacts, out) && path.dirname(out).toLowerCase() === artifacts.toLowerCase());
  assert.match(path.basename(out), /^native-suite-[0-9]+$/);
  const rows = fixturePlan(env, out);
  assert.deepEqual(recorded, { source: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    fixtureRoot: out, files: metadata(rows) });
  for (const row of rows) assert.deepEqual(read(row.path, 1024 * 1024), row.bytes, 'Synthetic fixture differs');
  return rows.length;
}
function checkPreinstalledFixture({ env, out, recorded, read = checkedFile, digest = hash }) {
  const count = checkFixtureBytes({ env, out, recorded, read });
  for (const [name, expected] of LEGACY) {
    const bytes = read(path.join(env.LOCALAPPDATA, name), 200 * 1024 * 1024);
    assert.equal(digest(bytes), expected, 'Preinstalled baseline differs');
  }
  return { fixtureFilesChecked: count, baselineExecutablesChecked: LEGACY.length, preinstalledModeAuthorized: false,
    signedUpdateProven: false, processHandoffProven: false, releaseReady: false };
}
function readPreinstalledReceipt(env, out) {
  admit(env, 'win32');
  const artifacts = path.join(env.GITHUB_WORKSPACE, 'artifacts');
  assert.ok(migration.inside(artifacts, out) && path.dirname(out).toLowerCase() === artifacts.toLowerCase());
  assert.match(path.basename(out), /^native-suite-[0-9]+$/);
  return JSON.parse(checkedFile(path.join(out, 'incoming-preinstalled.json'), 256 * 1024));
}
function checkClosedSignedUpdate({ env, update, close, lifecycle }) {
  admit(env, 'win32');
  assert.equal(update.passed, true); assert.equal(update.selfUpdateTested, true); assert.equal(update.policyRestored, true);
  assert.equal(update.harnessSource, env.GITHUB_SHA); assert.deepEqual(update.from, public12.BASELINE);
  assert.deepEqual(update.to, { version: incoming.TARGET.version, installer: incoming.TARGET.installer, exe: incoming.TARGET.exe });
  assert.equal(update.testOnlyDescriptor, false); assert.equal(update.productionMetadata, true); assert.equal(update.labDiscovery, true); assert.equal(update.publicDiscovery, false); assert.equal(update.releaseReady, false);
  assert.equal(update.migrationDeferred, true); assert.equal(update.managedRouteReconnectTested, false);
  assert.ok(Array.isArray(update.checks) && update.checks.includes('Accepted the required usage terms through the visible dialog on the disposable runner'));
  assert.equal(update.feed.kind, public12.KIND); assert.deepEqual(update.feed.pins, FEED_PINS);
  assert.equal(update.originalExitCode, 0); assert.ok(Number.isSafeInteger(update.restartedPid) && update.restartedPid > 0);
  assert.equal(close.kind, 'incoming-migration-owned-close-only'); assert.equal(close.state, 'verified');
  assert.equal(close.pid, update.restartedPid); assert.match(close.startTicks || '', /^[1-9][0-9]{0,18}$/);
  assert.equal(path.resolve(close.executable).toLowerCase(), path.resolve(env.LOCALAPPDATA, 'Creator Hub', 'creator-hub.exe').toLowerCase());
  assert.equal(close.exitCode, 0); assert.equal(close.migrationContinuationAvailable, false); assert.equal(close.releaseReady, false);
  assert.equal(lifecycle.kind, 'lab-lifecycle-result'); assert.equal(lifecycle.lifecycleSucceeded, true);
  assert.equal(lifecycle.scenario, 'public-stable'); assert.equal(lifecycle.actualScope, 'unmodified-public-0.1.12-lab-only');
  assert.equal(lifecycle.cleanupVerified, true); assert.equal(lifecycle.systemTlsVerified, true);
  assert.equal(lifecycle.hubCleanupState, 'verified'); assert.equal(lifecycle.hubCleanupUnknown, false);
  assert.equal(lifecycle.driverRegistered, true); assert.equal(lifecycle.driverGateOpened, true);
  assert.equal(lifecycle.publicDiscovery, false); assert.equal(lifecycle.releaseReady, false);
  assert.equal(lifecycle.driverExitCode, 0); assert.equal(lifecycle.rejectedRequestCount, 0);
  assert.equal(lifecycle.failureDetails, null); assert.equal(lifecycle.processIdentityFailure, null);
  require('./windows-019-updater.cjs').validateObservation(update.observedRestart, update, close);
  return { signedUpdateAndCloseEvidenceMatched: true, labCleanupEvidenceMatched: true,
    ancestryProven: false, migrationProven: false, processTransfer: false, releaseReady: false };
}
function checkSnapshotBytes(bytes, expectedSha256) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 256 * 1024);
  assert.match(expectedSha256 || '', /^[a-f0-9]{64}$/); assert.equal(hash(bytes), expectedSha256, 'Snapshot digest differs');
  return JSON.parse(bytes);
}
function checkContract(snapshot, env, out, profile, read) {
  assert.deepEqual(Object.keys(snapshot).sort(), ['schemaVersion', 'kind', 'source', 'runId', 'runAttempt', 'profile', 'fixtureRoot',
    'baseline', 'target', 'feedPins', 'files', 'scope'].sort());
  assert.equal(snapshot.schemaVersion, 1); assert.equal(snapshot.kind, KIND);
  assert.equal(snapshot.source, env.GITHUB_SHA); assert.equal(snapshot.runId, env.GITHUB_RUN_ID); assert.equal(snapshot.runAttempt, env.GITHUB_RUN_ATTEMPT);
  assert.deepEqual(snapshot.profile, profile); assert.equal(snapshot.fixtureRoot, out);
  assert.deepEqual(snapshot.baseline, public12.BASELINE); assert.deepEqual(snapshot.target, incoming.TARGET);
  assert.deepEqual(snapshot.feedPins, FEED_PINS);
  assert.deepEqual(snapshot.scope, { syntheticOnly: true, phase: 'pre-update-snapshot', feedBytesBound: true,
    signatureAuthenticityProven: false, signedUpdateProven: false, migrationProven: false, continuousIntegrityProven: false,
    continuationAuthority: false, releaseReady: false });
  const rows = fixturePlan(env, out); assert.deepEqual(snapshot.files, metadata(rows));
  for (const row of rows) assert.deepEqual(read(row.path), row.bytes, 'Owned synthetic fixture differs');
  return { kind: KIND, contractShapeAndFixtureBytesMatched: true, fixtureFilesChecked: rows.length,
    accountProven: false, baselineRevalidated: false, currentSourceVerified: false, continuationAuthority: false, releaseReady: false };
}
function checkedFile(file, max) {
  noLinks(file); const info = fs.lstatSync(file); assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1);
  return readBounded(file, max);
}
function bindFeed(config, env) {
  assert.deepEqual(config.pins, FEED_PINS);
  noLinks(config.directory); const dir = fs.realpathSync(config.directory);
  assert.ok(migration.inside(env.GITHUB_WORKSPACE, dir) || migration.inside(env.RUNNER_TEMP, dir));
  public12.loadContract(config); // Byte/shape binding; native updater verifies signatures later.
}
function bindInputs(config, env, updated = false) {
  bindFeed(config, env);
  for (const [index, [name, sha]] of LEGACY.entries()) {
    const expected = updated && index === 0 ? incoming.TARGET.exe : sha;
    assert.equal(hash(checkedFile(path.join(env.LOCALAPPDATA, name), 200 * 1024 * 1024)), expected);
  }
}
function ownedRoot(env) { return path.join(env.GITHUB_WORKSPACE, 'artifacts', `incoming-migration-owned-${env.GITHUB_RUN_ID}`); }
function createSnapshot(config, env = process.env) {
  if (!INCOMING_FIXTURE_ENABLED) throw Error('Snapshot producer disabled pending disposable-owner and handle-bound path review.');
  assert.equal(env, process.env); admit();
  bindInputs(config, env);
  const out = ownedRoot(env), rows = fixturePlan(env, out), profile = profileIdentity(env);
  noLinks(out); assertMissing(out);
  const artifacts = path.dirname(out); noLinks(artifacts); assert.ok(fs.lstatSync(artifacts).isDirectory());
  preflightFixtureRows(rows);
  fs.mkdirSync(out);
  for (const row of rows) {
    noLinks(row.path); assertMissing(row.path);
    fs.mkdirSync(path.dirname(row.path), { recursive: true });
    noLinks(row.path); fs.writeFileSync(row.path, row.bytes, { flag: 'wx' });
  }
  assert.deepEqual(profileIdentity(env), profile);
  const snapshot = { schemaVersion: 1, kind: KIND, source: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT, profile, fixtureRoot: out, baseline: public12.BASELINE, target: incoming.TARGET,
    feedPins: FEED_PINS, files: metadata(rows), scope: { syntheticOnly: true, phase: 'pre-update-snapshot', feedBytesBound: true,
      signatureAuthenticityProven: false, signedUpdateProven: false, migrationProven: false, continuousIntegrityProven: false,
      continuationAuthority: false, releaseReady: false } };
  checkContract(snapshot, env, out, profile, file => checkedFile(file, 1024 * 1024));
  const bytes = Buffer.from(JSON.stringify(snapshot)); assert.ok(bytes.length <= 256 * 1024);
  const file = path.join(out, 'fixture-snapshot.json'); noLinks(file); assertMissing(file);
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  return { out, snapshotSha256: hash(bytes), fixtureFilesChecked: rows.length, continuationAuthority: false, releaseReady: false };
}
function validateSnapshot(config, expectedSha256, env = process.env) {
  if (!INCOMING_FIXTURE_ENABLED) throw Error('Snapshot validation disabled pending baseline, account and source revalidation.');
  assert.equal(env, process.env); admit(); bindInputs(config, env, true);
  const out = ownedRoot(env), profile = profileIdentity(env);
  const snapshot = checkSnapshotBytes(checkedFile(path.join(out, 'fixture-snapshot.json'), 256 * 1024), expectedSha256);
  return checkContract(snapshot, env, out, profile, file => checkedFile(file, 1024 * 1024));
}
module.exports = { KIND, FEED_PINS, LEGACY, admit, assertMissing, preflightFixtureRows, profileIdentity, fixturePlan, metadata, signedUpdateRoot, checkFixtureBytes, checkPreinstalledFixture, readPreinstalledReceipt, checkClosedSignedUpdate, checkSnapshotBytes, checkContract, bindFeed, bindInputs, createSnapshot, validateSnapshot };
