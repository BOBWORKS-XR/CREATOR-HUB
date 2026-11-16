'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { yaml } = require('playwright-core/lib/utilsBundle');
const fresh = require('./native-windows-r12-fresh.cjs');
const target = require('./windows-outgoing-019-target.cjs');
const workflow = yaml.parse(fs.readFileSync(path.join(__dirname, '../.github/workflows/windows-outgoing-019.yml'), 'utf8'));
const bindingSha = target.hash(fs.readFileSync(path.join(__dirname, 'fixtures/windows-outgoing-019-binding.json')));
function env() { return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_JOB: 'fresh', GITHUB_REF: `refs/heads/${fresh.BRANCH}`,
  GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-outgoing-019.yml@refs/heads/${fresh.BRANCH}`,
  GITHUB_SHA: 'a'.repeat(40), EXPECTED_HARNESS_COMMIT: 'a'.repeat(40), CREATOR_OUTGOING_REVIEW_SHA256: bindingSha }; }
test('fresh admission requires exact dispatch binding and never accepts a local redirected profile', () => {
  fresh.admission(env(), 'win32'); assert.throws(() => fresh.admission(env(), 'linux'));
  for (const name of Object.keys(env())) { const changed = env(); changed[name] = 'wrong'; assert.throws(() => fresh.admission(changed, 'win32')); }
  for (const name of ['NODE_PATH', 'NODE_OPTIONS', 'CREATOR_TEST_HOME', 'WEBVIEW2_USER_DATA_FOLDER', 'HTTPS_PROXY'])
    assert.throws(() => fresh.admission({ ...env(), [name]: 'injected' }, 'win32'));
});
test('every known product and settings location must be absent before fresh install', () => {
  const profile = { home: 'C:/Users/runneradmin', local: 'C:/Users/runneradmin/AppData/Local', roaming: 'C:/Users/runneradmin/AppData/Roaming' };
  assert.ok(fresh.freshPaths(profile, path.win32).includes(path.win32.join(profile.local, 'com.creatorworks.hub')));
  fresh.assertFresh(profile, () => false, path.win32);
  for (const location of fresh.freshPaths(profile, path.win32)) assert.throws(() => fresh.assertFresh(profile, file => file === location, path.win32));
});
test('native subprocess environment excludes credentials and runtime injection', () => {
  assert.deepEqual(fresh.environment({ PATH: 'keep', USERPROFILE: 'keep', GH_TOKEN: 'drop', SECRET: 'drop',
    NODE_OPTIONS: 'drop', NODE_PATH: 'drop', HTTPS_PROXY: 'drop', TAURI_SIGNING_PRIVATE_KEY: 'drop' }), { PATH: 'keep', USERPROFILE: 'keep' });
});
function receipt() {
  const profile = { local: 'C:/Users/runneradmin/AppData/Local' };
  const file = path.join(profile.local, 'CreatorHub/consent/hub-usage-terms.json');
  const record = { schemaVersion: 1, policyVersion: '2026-09-28-v1', acceptedAtMs: 1234 };
  const body = Buffer.from(JSON.stringify(record)), pin = { file, bytes: body.length, sha256: target.hash(body) };
  return { kind: 'r12-fresh-install', sourceCommit: target.binding.target.source.commit,
  bindingSha256: bindingSha, installer: target.binding.target.installer, executable: target.binding.target.executable,
  passed: true, cleanAdmission: true, firstLaunchAccepted: true, mcpAvailable: true, normalRestartAccepted: true,
  settingsUnchanged: true, installedResourcesVerified: true, policyRestored: true, cleanupVerified: true,
  migrationAccepted: false, signedUpdateAccepted: false, publicDiscovery: false, liveAiAcceptance: false, releaseReady: false, cleanupForced: false,
  profile, consentBeforeReopen: { ...pin, record }, consentAfterReopen: { ...pin, record: { ...record } },
  settingsBeforeReopen: [pin], settingsAfterReopen: [{ ...pin }],
  normalCloses: [{ pid: 10, exitCode: 0 }, { pid: 20, exitCode: 0 }, { pid: 30, exitCode: 0 }, { pid: 40, exitCode: 0 }],
  productReview: { cancelPreserved: true, approvalObserved: true, backupsVerified: true, controlsEnabledBeforeClose: true,
    controlsEnabledAfterReopen: true, settingsUnchanged: true, markerUnchanged: true, noRepeatedApproval: true,
    runtimeRepairApproved: true, runtimeRepairCancelled: true, initialRouteUnbound: true, repairVisibleBeforeBinding: true, onlyServerChanged: true, oldServerAbsent: true, renewedReview: true, managedRouteUnchanged: true, decisions: [false, true, true], statusBefore: 'conflict', statusAfter: 'conflict', currentBefore: 'a'.repeat(64), currentAfter: 'd'.repeat(64),
    legacyBefore: 'b'.repeat(64), legacyAfter: 'b'.repeat(64), markerSha256: 'c'.repeat(64),
    clientAfterRepair: { serverVersion: '2.7.10', readOnlyCallPassed: true, settingsUnchanged: true, processesExited: true, routerPid: 101, runtimePid: 102 }, clientAfterReopen: { serverVersion: '2.7.10', readOnlyCallPassed: true, settingsUnchanged: true, processesExited: true, routerPid: 103, runtimePid: 104 }, initialBackupRetained: { file: 'old', sha256: 'a'.repeat(64) }, backups: [{ file: 'current', sha256: 'd'.repeat(64) }, { file: 'legacy', sha256: 'b'.repeat(64) }] } }; }
test('fresh acceptance refuses cleanup, restart, resource, source and settings mismatches', () => {
  fresh.checkReceipt(receipt());
  for (const change of [r => r.cleanupVerified = false, r => r.cleanupForced = true, r => r.normalCloses[1].pid = 10,
    r => r.normalCloses[1].exitCode = 1, r => r.settingsAfterReopen[0].sha256 = 'changed', r => r.mcpAvailable = false,
    r => r.installedResourcesVerified = false, r => r.sourceCommit = 'b'.repeat(40), r => r.bindingSha256 = 'b'.repeat(64),
    r => r.releaseReady = true, r => r.migrationAccepted = true]) { const r = receipt(); change(r); assert.throws(() => fresh.checkReceipt(r)); }
});
test('consent requires native policy/schema/timestamp and a present unchanged record', () => {
  const record = { schemaVersion: 1, policyVersion: '2026-09-28-v1', acceptedAtMs: 1 };
  assert.deepEqual(fresh.consentRecord(Buffer.from(JSON.stringify(record))), record);
  for (const value of [null, {}, { ...record, schemaVersion: 2 }, { ...record, policyVersion: 'old' },
    { ...record, acceptedAtMs: 0 }, { ...record, acceptedAtMs: 1.1 }, { ...record, extra: true }])
    assert.throws(() => fresh.consentRecord(Buffer.from(JSON.stringify(value))));
  assert.throws(() => fresh.consentRecord(Buffer.alloc(2049)));
  for (const change of [r => delete r.consentBeforeReopen, r => r.consentAfterReopen.record.policyVersion = 'old',
    r => r.consentAfterReopen.record.acceptedAtMs++, r => r.settingsBeforeReopen = r.settingsAfterReopen = [{ file: 'settings', bytes: null, sha256: null }],
    r => r.consentBeforeReopen.file = 'wrong', r => r.consentAfterReopen.sha256 = 'b'.repeat(64)]) {
    const r = receipt(); change(r); assert.throws(() => fresh.checkReceipt(r));
  }
});
function dialog(changes = {}) {
  return { title: 'Close Creator Hub?', class: '#32770', controls: [
    { name: fresh.CLOSE_MESSAGE, id: 'Content' }, { name: 'Close Hub', id: 'CommandButton_1000' }], ...changes };
}
test('close confirmation requires the exact R12 dialog and task button', () => {
  assert.equal(fresh.closeDialog([]), false); assert.equal(fresh.closeDialog([dialog()]), true);
  for (const windows of [[dialog(), dialog()], [dialog({ class: 'other' })], [dialog({ controls: [] })],
    [dialog({ controls: [{ name: fresh.CLOSE_MESSAGE, id: 'Content' }, { name: 'Close Hub', id: 'wrong' }] })]])
    assert.throws(() => fresh.closeDialog(windows));
  const helper = fs.readFileSync(path.join(__dirname, 'native-window.ps1'), 'utf8');
  assert.ok(helper.includes("$Value -ceq 'CloseCreatorHub'"));
  assert.ok(helper.includes("'CloseCreatorHub' = @('Close Creator Hub?')"));
  assert.ok(helper.includes('Exact R12 close message required.'));
});
test('normal close approves only an exact returned-workflow dialog and never forces termination', async () => {
  let requested = 0, approvals = 0, exitCode = null;
  await fresh.closeNormally({ request: () => requested++, exitCode: () => exitCode, snapshot: () => [dialog()],
    approve: () => { approvals++; exitCode = 0; }, delay: async () => {}, attempts: 2 });
  assert.equal(requested, 1); assert.equal(approvals, 1);
  await assert.rejects(fresh.closeNormally({ request() {}, exitCode: () => null, snapshot: () => [],
    approve: () => assert.fail('Unrelated dialog must not be approved'), delay: async () => {}, attempts: 2 }), /no process was force-closed/);
  await assert.rejects(fresh.closeNormally({ request() {}, exitCode: () => 1, snapshot: () => [],
    approve() {}, delay: async () => {}, attempts: 2 }), /Normal Hub close failed/);
  const driver = fs.readFileSync(path.join(__dirname, 'native-windows-r12-fresh.cjs'), 'utf8');
  assert.doesNotMatch(driver, /taskkill|process\.kill|\.kill\(|Stop-Process|\/F['"]|\/T['"]/);
});
test('WM_CLOSE exit event is delivered before any process snapshot', async () => {
  let code = null, requested = false, waits = 0;
  await fresh.closeNormally({ request: () => { requested = true; }, exitCode: () => code,
    snapshot: () => assert.fail('Exited process must not be inspected'), approve: () => assert.fail('No dialog'),
    delay: async () => { assert.equal(requested, true); waits++; code = 0; }, attempts: 2 });
  assert.equal(waits, 1);
});
test('snapshot race is accepted only after a bounded yield confirms successful exit', async () => {
  let code = null, racing = false, snapshots = 0;
  await fresh.closeNormally({ request() {}, exitCode: () => code,
    snapshot: () => { snapshots++; racing = true; throw Error('Process vanished'); },
    approve: () => assert.fail('No dialog'), delay: async () => { if (racing) code = 0; }, attempts: 2 });
  assert.equal(snapshots, 1);
});
test('snapshot failure without confirmed zero exit still refuses close acceptance', async () => {
  for (const finalCode of [null, 1]) {
    let code = null, racing = false;
    await assert.rejects(fresh.closeNormally({ request() {}, exitCode: () => code,
      snapshot: () => { racing = true; throw Error('Snapshot unavailable'); }, approve() {},
      delay: async () => { if (racing) code = finalCode; }, attempts: 2 }),
    finalCode === null ? /Snapshot unavailable/ : /Normal Hub close failed/);
  }
});
test('fresh job reuses exact binding and signed inputs without adding build or altering upgrade cases', () => {
  const job = workflow.jobs.fresh;
  assert.equal(job.needs, 'preflight'); assert.equal(job.if, "github.event_name == 'workflow_dispatch'");
  assert.equal(job['runs-on'], 'windows-latest'); assert.equal(job['timeout-minutes'], 15);
  assert.equal(job.env.CREATOR_OUTGOING_REVIEW_SHA256, '${{ inputs.binding_sha256 }}');
  assert.deepEqual(workflow.jobs.acceptance.strategy.matrix.include.map(row => row.case), ['mcp-restore', 'setup-restore', 'setup-no-restore']);
  const commands = job.steps.map(step => step.run || '').join('\n');
  assert.match(commands, /native-windows-r12-fresh\.cjs acquire/); assert.match(commands, /native-windows-r12-fresh\.cjs run/);
  assert.doesNotMatch(commands, /cargo|npm run build|tauri build|signer|gh release|workflow run/);
  const acquisition = job.steps.find(step => step.run?.endsWith('.cjs acquire'));
  assert.equal(acquisition.env.GH_TOKEN, '${{ github.token }}');
  assert.equal(job.steps.find(step => step.run?.endsWith('.cjs run')).env, undefined);
});
test('optional fresh_only skips only upgrade execution and defaults to the full unchanged matrix', () => {
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.fresh_only, { type: 'boolean', required: false, default: false });
  assert.equal(workflow.jobs.acceptance.if, "github.event_name == 'workflow_dispatch' && !inputs.fresh_only");
  const enabled = (event, value) => vm.runInNewContext(workflow.jobs.acceptance.if,
    { github: { event_name: event }, inputs: value === undefined ? {} : { fresh_only: value } });
  assert.equal(enabled('workflow_dispatch', undefined), true);
  assert.equal(enabled('workflow_dispatch', false), true);
  assert.equal(enabled('workflow_dispatch', true), false);
  assert.equal(enabled('push', false), false);
  assert.equal(enabled('push', true), false);
  assert.equal(workflow.jobs.fresh.if, "github.event_name == 'workflow_dispatch'");
  assert.equal(workflow.jobs.fresh.needs, 'preflight');
  assert.equal(workflow.jobs.acceptance.needs, 'preflight');
  assert.equal(workflow.jobs.preflight.if, "github.repository == 'BOBWORKS-XR/CREATOR-HUB' && github.ref == 'refs/heads/codex/windows-root-ui-023-20261116-r15-ci1'");
  const preflight = workflow.jobs.preflight.steps.filter(step => step.run?.startsWith('node --test '));
  assert.equal(preflight.length, 3);
  assert.ok(preflight[0].run.includes('scripts/windows-outgoing-019-test.cjs'));
  assert.ok(preflight[0].run.includes('scripts/incoming-receipt-r11.test.cjs'));
  assert.equal(preflight[1].run, 'node --test scripts/native-windows-r12-fresh.test.cjs');
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), ['binding_sha256', 'expected_harness_commit', 'fresh_only']);
});
test('fresh output obeys the unchanged native policy guard and is collected by its job', () => {
  const root = 'D:\\a\\CREATOR-HUB\\CREATOR-HUB';
  const out = fresh.outputDirectory(root, 123456789, path.win32);
  assert.equal(path.win32.dirname(out), path.win32.join(root, 'artifacts'));
  const guard = fs.readFileSync(path.join(__dirname, 'native-webview-policy.ps1'), 'utf8');
  const pattern = guard.match(/-notmatch '([^']+)'/); assert.ok(pattern);
  assert.match(path.win32.basename(out), new RegExp(pattern[1]));
  assert.equal(path.win32.basename(path.win32.join(out, 'webview-policy.json')), 'webview-policy.json');
  assert.ok(guard.includes("-ne 'webview-policy.json'"));
  assert.throws(() => fresh.outputDirectory(root, -1, path.win32));
  const driver = fs.readFileSync(path.join(__dirname, 'native-windows-r12-fresh.cjs'), 'utf8');
  assert.ok(driver.includes("out = outputDirectory(ROOT)"));
  assert.ok(driver.includes("path.join(out, 'webview-policy.json')"));
  const upload = workflow.jobs.fresh.steps.find(step => step.uses === 'actions/upload-artifact@v4');
  assert.equal(upload.with.path, 'artifacts/native-suite-*/*.json\nartifacts/native-suite-*/*.png\n');
});
function configPage(fault) {
  const calls = []; let owned = false;
  return { calls, page: { evaluate(fn) {
    return vm.runInNewContext(`(${fn.toString()})()`, { window: { CreatorHubNative: {
      async invoke(name, value) {
        assert.equal(name, 'feature_call'); assert.equal(value.feature, 'mcp');
        const { command } = value; calls.push(command);
        if (command === 'begin_ui_operation') {
          if (fault === 'begin') throw Error('Begin refused');
          owned = true; return 17;
        }
        assert.equal(owned, true, 'Owned workflow required');
        if (command === 'finish_ui_operation') {
          assert.equal(value.args.id, 17); owned = false;
          if (fault === 'finish') throw Error('Finish refused');
          return;
        }
        assert.equal(command, 'load_config');
        if (fault === 'load') throw Error('Read refused');
        return { channels: [], active_channel_id: null };
      },
    } } });
  } } };
}
test('fresh config inspection follows the actual begin/load/finally-finish contract', async () => {
  const success = configPage();
  const value = await fresh.loadConfigInWorkflow(success.page);
  assert.deepEqual(JSON.parse(JSON.stringify(value)), { channels: [], active_channel_id: null });
  assert.deepEqual(success.calls, ['begin_ui_operation', 'load_config', 'finish_ui_operation']);
  const failedRead = configPage('load');
  await assert.rejects(fresh.loadConfigInWorkflow(failedRead.page), /Read refused/);
  assert.deepEqual(failedRead.calls, success.calls);
});
test('fresh config inspection never loads after begin refusal or accepts finish failure', async () => {
  const begin = configPage('begin');
  await assert.rejects(fresh.loadConfigInWorkflow(begin.page), /Begin refused/);
  assert.deepEqual(begin.calls, ['begin_ui_operation']);
  const finish = configPage('finish');
  await assert.rejects(fresh.loadConfigInWorkflow(finish.page), /Finish refused/);
  assert.deepEqual(finish.calls, ['begin_ui_operation', 'load_config', 'finish_ui_operation']);
});