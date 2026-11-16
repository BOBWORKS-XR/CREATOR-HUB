'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
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
  normalCloses: [{ pid: 10, exitCode: 0 }, { pid: 20, exitCode: 0 }] }; }
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
