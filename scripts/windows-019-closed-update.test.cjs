'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const Module = require('node:module');
const capture = require('./fixtures/windows-019-r4-closed-update.json');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const expected = {
  update: '4d3c4da2f6601a18a7521737a27571ddab1cf62498b4c314dd57c9733b050b12',
  lifecycle: 'ffda0767ce8d46c51bca61d95b83f8a8cb9f4dbca734a7b674e55f3b8400b9ea',
  inputBinding: '6a733326d82b1c85dda5cc8cd0646fd4c53a9e6a3484b8683145ffed71e2a703',
  preinstalled: '4fc70ad6afde5a5ce763ed67862fd64c6be3521fbd5650f924487e2b04d92103',
  candidateBinding: '00f8d0bb5c7cf1c2d633cd40d6a371711cfdac4a6d860e61dc9095a3c0dee3b1',
};
function bytes(name) {
  const doc = capture.documents[name], result = Buffer.from(doc.base64, 'base64');
  assert.equal(result.toString('base64'), doc.base64);
  assert.equal(result.length, doc.size); assert.equal(hash(result), expected[name]);
  assert.equal(doc.sha256, expected[name]); return result;
}
const original = JSON.parse(bytes('update'));
const input = JSON.parse(bytes('inputBinding'));
const preinstalled = JSON.parse(bytes('preinstalled'));
const binding = JSON.parse(bytes('candidateBinding'));
const events = bytes('lifecycle').toString('utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const lifecycle = events.filter(row => row.kind === 'lab-lifecycle-result');
assert.equal(lifecycle.length, 1);

// Only this test process sees the exact frozen R4 binding, never live/pending pins.
const bindingFile = require.resolve('./fixtures/windows-019-binding.json');
require(bindingFile);
require.cache[bindingFile].exports = binding;
const contract = require('./windows-019-contract.cjs');
const production = require('./windows-019-production.cjs');
const owned = require('./windows-019-owned-snapshot.cjs');
const migration = require('./native-windows-019-migration.cjs');
const updater = require('./windows-019-updater.cjs');
const driverFile = path.join(__dirname, 'native-windows-019-migration.cjs');
const driverModule = { exports: {} };
const driverSource = fs.readFileSync(driverFile, 'utf8') + '\nmodule.exports.__testRunSignedIncomingParent = runSignedIncomingParent;';
vm.runInThisContext(Module.wrap(driverSource), { filename: driverFile })(driverModule.exports,
  Module.createRequire(driverFile), driverModule, driverFile, __dirname);
const home = process.platform === 'win32' ? 'C:\\Users\\runneradmin' : path.resolve('r4-runner');
const workspace = process.platform === 'win32' ? 'D:\\a\\CREATOR-HUB\\CREATOR-HUB' : path.resolve('r4-workspace');
const env = {
  GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_JOB: 'incoming-migration', GITHUB_REF: 'refs/heads/validation/windows-019-production',
  GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-019-production.yml@refs/heads/validation/windows-019-production',
  GITHUB_SHA: capture.harnessSource, CREATOR_PRODUCTION_019_SOURCE: capture.harnessSource,
  CREATOR_PRODUCTION_019_MIGRATION: '1', GITHUB_RUN_ATTEMPT: String(capture.runAttempt), GITHUB_RUN_ID: String(capture.runId),
  USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  GITHUB_WORKSPACE: workspace, RUNNER_TEMP: path.join(workspace, 'temp'),
};
function evidence() {
  const update = structuredClone(original);
  // Non-Windows unit hosts remap only the path checked against their fake profile.
  if (process.platform !== 'win32') update.restartedClose.executable = path.join(env.LOCALAPPDATA, 'Creator Hub', 'creator-hub.exe');
  return { env: { ...env }, update, close: update.restartedClose, lifecycle: structuredClone(lifecycle[0]) };
}
function set(object, key, value) {
  const parts = key.split('.'), last = parts.pop();
  const parent = parts.reduce((at, part) => at[part], object);
  if (value === undefined) delete parent[last]; else parent[last] = value;
}

test('R4 original bytes retain successful update/close but do not claim migration acceptance', () => {
  assert.equal(capture.runId, 41808625622); assert.equal(capture.runAttempt, 1);
  assert.equal(capture.harnessSource, '15a24d9cc5351a7c7622b16a6f2f33bc7641da20');
  for (const name of Object.keys(expected)) bytes(name);
  contract.validateProduction(binding);
  assert.equal(original.passed, true); assert.equal(original.restartedClose.state, 'verified');
  assert.equal(lifecycle[0].actualScope, 'exact-public-0.1.12-to-0.1.19-lab-only');
  assert.equal(original.nativeAcceptance, false); assert.equal(original.releaseReady, false);
});

test('actual R4 report traverses every closed-update assertion and observation check', () => {
  const value = evidence();
  updater.validateObservation(value.update.observedRestart, value.update, value.close);
  assert.deepEqual(owned.checkClosedSignedUpdate(value), {
    signedUpdateAndCloseEvidenceMatched: true, labCleanupEvidenceMatched: true,
    ancestryProven: false, migrationProven: false, processTransfer: false, releaseReady: false,
  });
});

test('closed-update contract rejects stale scope, wrong versions and every missing checked field', () => {
  const changes = {
    'update.passed': false, 'update.selfUpdateTested': false, 'update.policyRestored': false,
    'update.harnessSource': 'a'.repeat(40),
    'update.from.version': '0.1.14', 'update.from.asset': 'Creator.Hub_0.1.14_x64-setup.exe',
    'update.from.installer': 'a'.repeat(64), 'update.from.exe': 'a'.repeat(64),
    'update.to.version': '0.1.18', 'update.to.installer': 'a'.repeat(64), 'update.to.exe': 'a'.repeat(64),
    'update.testOnlyDescriptor': true, 'update.productionMetadata': false, 'update.labDiscovery': false,
    'update.publicDiscovery': true, 'update.releaseReady': true, 'update.migrationDeferred': false,
    'update.managedRouteReconnectTested': true, 'update.checks': [], 'update.feed.kind': 'public-stable',
    'update.originalExitCode': 1, 'update.restartedPid': 0,
    'close.kind': 'other', 'close.state': 'unknown', 'close.pid': 999,
    'close.startTicks': '0', 'close.executable': path.join(env.LOCALAPPDATA, 'foreign.exe'),
    'close.exitCode': 1, 'close.migrationContinuationAvailable': true, 'close.releaseReady': true,
    'lifecycle.kind': 'other', 'lifecycle.lifecycleSucceeded': false, 'lifecycle.scenario': 'other',
    'lifecycle.actualScope': 'unmodified-public-0.1.12-lab-only',
    'lifecycle.cleanupVerified': false, 'lifecycle.systemTlsVerified': false,
    'lifecycle.hubCleanupState': 'unknown', 'lifecycle.hubCleanupUnknown': true,
    'lifecycle.driverRegistered': false, 'lifecycle.driverGateOpened': false,
    'lifecycle.publicDiscovery': true, 'lifecycle.releaseReady': true,
    'lifecycle.driverExitCode': 1, 'lifecycle.rejectedRequestCount': 1,
    'lifecycle.failureDetails': 'failure', 'lifecycle.processIdentityFailure': 'failure',
    'update.observedRestart.kind': 'other', 'update.observedRestart.baselinePid': 999,
    'update.observedRestart.restartedPid': 999, 'update.observedRestart.baselineStartTicks': '0',
    'update.observedRestart.restartedStartTicks': '0', 'update.observedRestart.approvalLowerBoundTicks': '0',
    'update.observedRestart.baselineImageSha256': 'a'.repeat(64),
    'update.observedRestart.restartedImageSha256': 'a'.repeat(64),
    'update.observedRestart.singletonAtCheckpoints': false, 'update.observedRestart.harnessAdditionalLaunch': true,
    'update.observedRestart.ancestryProven': true, 'update.observedRestart.securityAttestation': true,
  };
  for (const pin of Object.keys(original.feed.pins)) changes[`update.feed.pins.${pin}`] = 'a'.repeat(64);
  for (const [key, value] of Object.entries(changes)) {
    for (const replacement of [value, undefined]) {
      const copy = evidence(); set(copy, key, replacement);
      assert.throws(() => owned.checkClosedSignedUpdate(copy), key + (replacement === undefined ? ' missing' : ' changed'));
    }
  }
  for (const scope of ['exact-public-0.1.14-to-0.1.19-lab-only', 'exact-public-0.1.12-to-0.1.18-lab-only',
    'exact-public-0.1.12-to-0.1.20-lab-only', 'exact-public-0.1.12-to-0.1.19-lab-only ']) {
    const copy = evidence(); copy.lifecycle.actualScope = scope;
    assert.throws(() => owned.checkClosedSignedUpdate(copy), scope);
  }
  for (const mutate of [copy => { copy.update.observedRestart.extra = true; },
    copy => { copy.update.originalPid = copy.update.restartedPid; copy.update.observedRestart.baselinePid = copy.update.restartedPid; },
    copy => { copy.update.observedRestart.approvalLowerBoundTicks = copy.update.observedRestart.baselineStartTicks; },
    copy => { copy.update.observedRestart.approvalLowerBoundTicks = copy.update.observedRestart.restartedStartTicks; },
    copy => { copy.close.startTicks = '639293818409936010'; }]) {
    const copy = evidence(); mutate(copy); assert.throws(() => owned.checkClosedSignedUpdate(copy));
  }
});

test('PowerShell producer supplies the same exact pinned scope and scenario as R4', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-self-update-lab-019.ps1'), 'utf8');
  assert.ok(source.includes('$actualScope = "exact-public-$env:CREATOR_PRODUCTION_019_BASELINE-to-0.1.19-lab-only"'));
  assert.ok(source.includes("[string]$Scenario = 'public-stable'"));
  assert.equal(lifecycle[0].actualScope, `exact-public-${production.BASELINE.version}-to-${production.TARGET.version}-lab-only`);
  assert.equal(lifecycle[0].scenario, 'public-stable');
});

test('actual R4 acquisition binds source, private draft and all four exact asset identities', () => {
  assert.equal(production.validateAcquisition(input, capture.harnessSource), input);
  assert.equal(migration.validateProvenance(input, capture.harnessSource), input);
  const changes = { harnessSource: 'a'.repeat(40), privateDraft: false, readbackVerified: false,
    releaseId: 1, releaseTag: 'v0.1.18', 'source.commit': 'a'.repeat(40), 'source.tree': 'a'.repeat(40) };
  for (const [key, value] of Object.entries(changes)) {
    const copy = structuredClone(input); set(copy, key, value);
    assert.throws(() => production.validateAcquisition(copy, capture.harnessSource), key);
  }
  for (const name of Object.keys(input.files)) for (const key of ['id', 'size', 'sha256']) {
    const copy = structuredClone(input); copy.files[name][key] = key === 'sha256' ? 'a'.repeat(64) : 1;
    assert.throws(() => production.validateAcquisition(copy, capture.harnessSource), `${name}.${key}`);
  }
});

test('actual R4 preinstalled paths and all 17 generated file identities match the fixture producer', () => {
  const win = path.win32, profile = { USERPROFILE: 'C:\\Users\\runneradmin',
    APPDATA: 'C:\\Users\\runneradmin\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\runneradmin\\AppData\\Local' };
  const f = migration.fixture(profile, preinstalled.fixtureRoot, win);
  const rows = [...f.stores, ...f.clients, ...f.untouched];
  for (const project of [f.projectA, f.projectB]) {
    rows.push({ path: win.join(project, 'ProjectSettings/ProjectVersion.txt'), bytes: Buffer.from('m_EditorVersion: 6000.3.21f1\n') });
    rows.push({ path: win.join(project, 'Packages/manifest.json'), bytes: Buffer.from('{"dependencies":{}}\n') });
    rows.push({ path: win.join(project, 'Assets/AuthoredContent.txt'), bytes: Buffer.from('Never modify a Unity project during migration\n') });
  }
  assert.equal(preinstalled.source, capture.harnessSource); assert.equal(preinstalled.runId, String(capture.runId));
  assert.equal(preinstalled.runAttempt, String(capture.runAttempt));
  assert.deepEqual(owned.metadata(rows), preinstalled.files);
  if (process.platform === 'win32') {
    const actualRows = owned.fixturePlan(env, preinstalled.fixtureRoot);
    assert.deepEqual(owned.metadata(actualRows), preinstalled.files);
    assert.equal(owned.checkFixtureBytes({ env, out: preinstalled.fixtureRoot, recorded: preinstalled,
      read: file => actualRows.find(row => row.path === file).bytes }), 17);
  }
  assert.equal(win.join(win.dirname(preinstalled.fixtureRoot), win.basename(preinstalled.fixtureRoot) + '001', 'self-update-report.json')
    .replaceAll('\\', '/').split('/artifacts/')[1], capture.documents.update.member);
});

test('production preflight includes the actual-derived closed-update regression', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/windows-019-production.yml'), 'utf8');
  assert.ok(workflow.includes('scripts/windows-019-closed-update.test.cjs'));
});

test('parent parses original R4 lifecycle and checks actual reports before fixture continuation', () => {
  const out = path.join(env.GITHUB_WORKSPACE, 'artifacts', 'native-suite-1793784981724');
  const f = migration.fixture(env, out), before = { fixture: 'unchanged' };
  for (const project of [f.projectA, f.projectB]) {
    f.untouched.push({ path: path.join(project, 'Assets/AuthoredContent.txt'), bytes: Buffer.from('Never modify a Unity project during migration\n') });
  }
  const rows = owned.fixturePlan(env, out);
  const read = file => rows.find(row => row.path === file).bytes;
  const calls = [];
  const result = driverModule.exports.__testRunSignedIncomingParent({
    environment: { ...env, ProgramFiles: path.resolve('test-program-files') }, out, fixture: f,
    baselineInstaller: path.resolve('test-baseline.exe'), projectBefore: before, projectImage: () => before,
  }, {
    owned: { ...owned,
      bindFeed(config) { assert.deepEqual(config.pins, production.PINS); },
      checkPreinstalledFixture(args) { owned.checkFixtureBytes({ ...args, read }); },
      checkClosedSignedUpdate(args) { calls.push('closed'); return owned.checkClosedSignedUpdate(args); },
      checkFixtureBytes(args) { calls.push('preserved'); return owned.checkFixtureBytes({ ...args, read }); },
    },
    checkLinks() {},
    readFile(file) {
      if (file.endsWith('config.json')) return Buffer.from(JSON.stringify({ pins: production.PINS }));
      assert.equal(file, path.join(owned.signedUpdateRoot(out), 'self-update-report.json'));
      return Buffer.from(JSON.stringify(evidence().update));
    },
    writeFile(file, content, options) {
      assert.equal(options.flag, 'wx');
      if (file.endsWith('signed-update-lifecycle.jsonl')) assert.equal(content, bytes('lifecycle').toString('utf8'));
    },
    run() { return bytes('lifecycle').toString('utf8'); },
  });
  assert.deepEqual(calls, ['closed', 'preserved']);
  assert.equal(result.signedUpdateObserved, true); assert.equal(result.normalCloseObserved, true);
  assert.equal(result.labCleanupObserved, true); assert.equal(result.migrationProven, false);
  const recorded = { source: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    fixtureRoot: out, files: owned.metadata(rows) };
  assert.throws(() => owned.checkFixtureBytes({ env, out, recorded, read: () => Buffer.from('changed') }));
});
