'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const owned = require('./windows-incoming-migration-owned-snapshot.cjs');
const incoming = require('./windows-incoming-016.cjs');
const public12 = require('./windows-public12-r2-lab.cjs');
const sha = 'a'.repeat(40);
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_JOB: 'incoming-migration-diagnostic', GITHUB_REF: 'refs/heads/validation/windows-menu-merge-20261027',
  GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-incoming-016.yml@refs/heads/validation/windows-menu-merge-20261027',
  CREATOR_INCOMING_MIGRATION_DIAGNOSTIC: '1', GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '123', GITHUB_SHA: sha,
  CREATOR_INCOMING_MIGRATION_SOURCE: sha, GITHUB_WORKSPACE: path.resolve('workspace'), RUNNER_TEMP: path.resolve('temp'),
  USERPROFILE: path.resolve('profile'), APPDATA: path.resolve('profile/AppData/Roaming'), LOCALAPPDATA: path.resolve('profile/AppData/Local') };
const out = path.join(env.GITHUB_WORKSPACE, 'artifacts', 'incoming-migration-owned-123');
const profile = Object.fromEntries(['USERPROFILE', 'APPDATA', 'LOCALAPPDATA'].map(key => [key, { path: env[key], dev: '1', ino: '2' }]));
const plan = () => owned.fixturePlan(env, out);
function fixture() {
  return { schemaVersion: 1, kind: owned.KIND, source: sha, runId: '123', runAttempt: '1', profile, fixtureRoot: out,
    baseline: public12.BASELINE, target: incoming.TARGET, feedPins: owned.FEED_PINS, files: owned.metadata(plan()),
    scope: { syntheticOnly: true, phase: 'pre-update-snapshot', feedBytesBound: true, signatureAuthenticityProven: false,
      signedUpdateProven: false, migrationProven: false, continuousIntegrityProven: false, continuationAuthority: false, releaseReady: false } };
}
function reader() { const map = new Map(plan().map(row => [row.path, row.bytes])); return file => { assert.ok(map.has(file)); return map.get(file); }; }
test('producer and validator admission is disposable, source-bound and job-specific', () => {
  owned.admit(env, 'win32'); assert.throws(() => owned.admit(env, 'linux'));
  for (const key of Object.keys(env)) assert.throws(() => owned.admit({ ...env, [key]: '' }, 'win32'));
  assert.throws(() => owned.admit({ ...env, GITHUB_SHA: 'b'.repeat(40) }, 'win32'));
  assert.throws(() => owned.admit({ ...env, APPDATA: path.resolve('elsewhere') }, 'win32'));
  assert.throws(() => owned.createSnapshot({}, {})); assert.throws(() => owned.validateSnapshot({}, 'a'.repeat(64), {}));
});
test('fixture plan is deterministic and checks exactly the original synthetic contents', () => {
  assert.equal(plan().length, 17); assert.deepEqual(owned.metadata(plan()), owned.metadata(plan()));
  const result = owned.checkContract(fixture(), env, out, profile, reader());
  assert.deepEqual(result, { kind: owned.KIND, contractShapeAndFixtureBytesMatched: true, fixtureFilesChecked: 17,
    accountProven: false, baselineRevalidated: false, currentSourceVerified: false, continuationAuthority: false, releaseReady: false });
  let reads = 0; assert.throws(() => owned.checkContract(fixture(), env, out, profile, file => { reads++; return reads === 1 ? Buffer.from('changed') : reader()(file); }));
});
test('snapshot refuses source, run, profile, path, content, feed and authority drift', () => {
  for (const mutate of [
    v => v.source = 'b'.repeat(40), v => v.runId = '999', v => v.runAttempt = '2', v => v.fixtureRoot = path.resolve('other'),
    v => v.profile.USERPROFILE.ino = '9', v => v.files[0].path = path.resolve('other'), v => v.files[0].sha256 = '0'.repeat(64),
    v => v.files.pop(), v => v.files.push(v.files[0]), v => v.target.installer = '0'.repeat(64),
    v => v.feedPins.descriptor = '0'.repeat(64), v => v.scope.continuationAuthority = true, v => v.scope.signedUpdateProven = true,
    v => v.scope.continuousIntegrityProven = true,
    v => v.unexpected = true,
  ]) {
    const value = structuredClone(fixture()); mutate(value);
    assert.throws(() => owned.checkContract(value, env, out, profile, reader()));
  }
  assert.throws(() => owned.checkContract(fixture(), env, out, { ...profile, USERPROFILE: { ...profile.USERPROFILE, ino: '9' } }, reader()));
});
test('exact R2 and retained signed012 feed pins are fixed; no installer or continuation is invoked', () => {
  assert.deepEqual(owned.FEED_PINS, { descriptor: '818bcb983490e20ade5816b4dbb2f5ea98bcaa33484faefa7b9747d12d64b788',
    descriptorSignature: 'c8cc58a35b6b8f8461e078110cbd72462566b19974ac13c547ca80edf5f860da',
    installer: '7326d054ac23b7ac560e2c3488933203a33f0033586b1c33988ce7f316e4c51a',
    manifest: '986745ff133fbd8a4d4c5dc3de17cecafbc500e4af06badb323bf3a632476eea',
    executable: 'fac846563720eb4dae665a814ea28d0556800ebaf75aba7e8ee0be7f1979a5cd' });
  const source = fs.readFileSync(path.join(__dirname, 'windows-incoming-migration-owned-snapshot.cjs'), 'utf8');
  assert.doesNotMatch(source, /child_process|execFile|spawn\(|migration\.main\(/);
  assert.match(source, /Snapshot producer disabled pending disposable-owner and handle-bound path review/);
  assert.match(source, /Snapshot validation disabled pending baseline, account and source revalidation/);
  assert.match(source, /public12\.loadContract\(config\)/);
});
test('disabled producer and validator refuse before reading their inputs', () => {
  const forbidden = new Proxy({}, { get() { throw Error('input was accessed'); }, ownKeys() { throw Error('input was enumerated'); } });
  assert.throws(() => owned.createSnapshot(forbidden, forbidden), /Snapshot producer disabled/);
  assert.throws(() => owned.validateSnapshot(forbidden, 'a'.repeat(64), forbidden), /Snapshot validation disabled/);
});
test('existing, dangling or inaccessible fixture targets are refused before creation', () => {
  const missing = Object.assign(Error('missing'), { code: 'ENOENT' });
  assert.doesNotThrow(() => owned.assertMissing('fixture', () => { throw missing; }));
  assert.throws(() => owned.assertMissing('fixture', () => ({ isSymbolicLink: () => true })), /Existing/);
  assert.throws(() => owned.assertMissing('fixture', () => ({ isSymbolicLink: () => false })), /Existing/);
  assert.throws(() => owned.assertMissing('fixture', () => { throw Object.assign(Error('denied'), { code: 'EACCES' }); }), /denied/);
});
test('all bounded synthetic targets are checked before any writes; existing and duplicate targets refuse', () => {
  const missing = Object.assign(Error('missing'), { code: 'ENOENT' }), checked = [];
  const absent = file => { checked.push(file); throw missing; };
  owned.preflightFixtureRows(plan(), () => {}, absent); assert.equal(checked.length, 17);
  assert.throws(() => owned.preflightFixtureRows(plan(), () => {}, () => ({ isSymbolicLink: () => false })), /Existing/);
  const duplicate = plan(); duplicate[1] = { ...duplicate[1], path: duplicate[0].path };
  assert.throws(() => owned.preflightFixtureRows(duplicate, () => {}, absent));
  const oversized = plan(); oversized[0] = { ...oversized[0], bytes: Buffer.alloc(1024 * 1024 + 1) };
  assert.throws(() => owned.preflightFixtureRows(oversized, () => {}, absent));
  assert.throws(() => owned.preflightFixtureRows(plan(), () => { throw Error('linked'); }, absent), /linked/);
});
test('preinstalled check binds the exact synthetic fixture and all three 0.1.12-era executables', () => {
  const root = path.join(env.GITHUB_WORKSPACE, 'artifacts', 'native-suite-123');
  const rows = owned.fixturePlan(env, root);
  const recorded = { source: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    fixtureRoot: root, files: owned.metadata(rows) };
  const files = new Map(rows.map(row => [row.path, row.bytes]));
  const pins = new Map();
  for (const [index, [name, expected]] of owned.LEGACY.entries()) {
    const bytes = Buffer.from(`mock-executable-${index}`); files.set(path.join(env.LOCALAPPDATA, name), bytes); pins.set(bytes.toString(), expected);
  }
  const read = file => { assert.ok(files.has(file)); return files.get(file); }, digest = bytes => pins.get(bytes.toString());
  const input = { env, out: root, recorded, read, digest };
  assert.deepEqual(owned.checkPreinstalledFixture(input), { fixtureFilesChecked: 17, baselineExecutablesChecked: 3,
    preinstalledModeAuthorized: false, signedUpdateProven: false, processHandoffProven: false, releaseReady: false });
  for (const change of [value => { value.recorded.source = 'b'.repeat(40); }, value => { value.recorded.runId = '999'; },
    value => { value.recorded.files[0].sha256 = '0'.repeat(64); }, value => { value.out = path.resolve('elsewhere'); }]) {
    const candidate = { ...input, recorded: structuredClone(recorded) }; change(candidate);
    assert.throws(() => owned.checkPreinstalledFixture(candidate));
  }
  files.set(rows[0].path, Buffer.from('changed')); assert.throws(() => owned.checkPreinstalledFixture(input));
  files.set(rows[0].path, rows[0].bytes); files.delete(path.join(env.LOCALAPPDATA, owned.LEGACY[0][0]));
  assert.throws(() => owned.checkPreinstalledFixture(input));
  assert.equal(owned.LEGACY[0][1], public12.BASELINE.exe);
});
test('signed updater output remains an exclusive policy-compatible sibling', () => {
  const root = path.join(env.GITHUB_WORKSPACE, 'artifacts', 'native-suite-123');
  assert.equal(owned.signedUpdateRoot(root), path.join(env.GITHUB_WORKSPACE, 'artifacts', 'native-suite-123001'));
  assert.throws(() => owned.signedUpdateRoot(path.join(env.GITHUB_WORKSPACE, 'artifacts', 'other')));
  assert.throws(() => owned.signedUpdateRoot('native-suite-123'));
});
test('preinstalled updater flag admits only the scoped runner before inputs, while the standard fresh gate remains', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-self-update-smoke.cjs'), 'utf8');
  const refusal = source.indexOf("process.env.CREATOR_INCOMING_MIGRATION_DIAGNOSTIC !== undefined");
  assert.ok(refusal > 0 && refusal < source.indexOf("require('node:fs')"));
  assert.match(source, /Invalid preinstalled diagnostic mode/);
  assert.match(source, /require\('\.\/windows-incoming-migration-owned-snapshot\.cjs'\)\.admit\(\)/);
  assert.match(source, /assert\.equal\(fs\.existsSync\(hub\), false, 'Expected a fresh runner without Hub installed'\)/);
});
test('signed updater boundary requires exact normal close and lab trust cleanup', () => {
  const update = { passed: true, selfUpdateTested: true, policyRestored: true, harnessSource: env.GITHUB_SHA, from: public12.BASELINE,
    to: { version: incoming.TARGET.version, installer: incoming.TARGET.installer, exe: incoming.TARGET.exe },
    testOnlyDescriptor: true, labDiscovery: true, publicDiscovery: false, releaseReady: false, migrationDeferred: true, managedRouteReconnectTested: false,
    checks: ['Accepted the required usage terms through the visible dialog on the disposable runner'],
    feed: { kind: public12.KIND, pins: owned.FEED_PINS }, originalExitCode: 0, originalPid: 42, restartedPid: 123,
    observedRestart: { kind: 'observed-signed-update-restart', baselinePid: 42, baselineStartTicks: '100',
      restartedPid: 123, restartedStartTicks: '300', approvalLowerBoundTicks: '200', baselineImageSha256: public12.BASELINE.exe,
      restartedImageSha256: incoming.TARGET.exe, singletonAtCheckpoints: true, harnessAdditionalLaunch: false,
      ancestryProven: false, securityAttestation: false } };
  const close = { kind: 'incoming-migration-owned-close-only', state: 'verified', pid: 123, startTicks: '300',
    executable: path.join(env.LOCALAPPDATA, 'Creator Hub', 'creator-hub.exe'), exitCode: 0, migrationContinuationAvailable: false, releaseReady: false };
  const lifecycle = { kind: 'lab-lifecycle-result', scenario: 'public-stable', actualScope: 'unmodified-public-0.1.12-lab-only',
    lifecycleSucceeded: true, cleanupVerified: true, hubCleanupState: 'verified', hubCleanupUnknown: false,
    driverRegistered: true, driverGateOpened: true, systemTlsVerified: true, publicDiscovery: false, releaseReady: false,
    driverExitCode: 0, rejectedRequestCount: 0, failureDetails: null, processIdentityFailure: null };
  assert.deepEqual(owned.checkClosedSignedUpdate({ env, update, close, lifecycle }), { signedUpdateAndCloseEvidenceMatched: true,
    labCleanupEvidenceMatched: true, ancestryProven: false, migrationProven: false, processTransfer: false, releaseReady: false });
  for (const change of [value => { value.close.state = 'unknown'; }, value => { value.close.pid++; },
    value => { value.close.startTicks = ''; }, value => { value.close.executable = path.resolve('other.exe'); },
    value => { value.close.exitCode = 1; }, value => { value.update.to.exe = '0'.repeat(64); },
    value => { value.update.harnessSource = 'b'.repeat(40); }, value => { value.update.feed.pins.descriptor = '0'.repeat(64); },
    value => { value.lifecycle.cleanupVerified = false; }, value => { value.lifecycle.lifecycleSucceeded = false; },
    value => { value.lifecycle.hubCleanupState = 'unknown'; }, value => { value.lifecycle.hubCleanupUnknown = true; },
    value => { value.lifecycle.driverRegistered = false; }, value => { value.lifecycle.driverGateOpened = false; },
    value => { delete value.lifecycle.hubCleanupState; },
    value => { value.lifecycle.driverExitCode = null; }, value => { value.lifecycle.rejectedRequestCount = 1; },
    value => { value.lifecycle.actualScope = 'other'; }, value => { value.lifecycle.processIdentityFailure = 'unknown'; },
    value => { value.update.checks = []; }, value => { value.update.observedRestart.ancestryProven = true; },
    value => { value.update.observedRestart.restartedStartTicks = '199'; }, value => { value.update.observedRestart.singletonAtCheckpoints = false; },
    value => { value.update.observedRestart.harnessAdditionalLaunch = true; }, value => { delete value.update.observedRestart; }]) {
    const value = structuredClone({ update, close, lifecycle }); change(value);
    assert.throws(() => owned.checkClosedSignedUpdate({ env, ...value }));
  }
});
test('snapshot validation requires an externally retained digest of the exact bytes', () => {
  const crypto = require('node:crypto'), bytes = Buffer.from(JSON.stringify(fixture()));
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.deepEqual(owned.checkSnapshotBytes(bytes, digest), fixture());
  assert.throws(() => owned.checkSnapshotBytes(Buffer.concat([bytes, Buffer.from(' ')]), digest));
  assert.throws(() => owned.checkSnapshotBytes(bytes, '0'.repeat(64)));
  assert.throws(() => owned.checkSnapshotBytes(bytes, 'bad'));
});
