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
  fresh.assertFresh(profile, () => false, path.win32);
  for (const location of fresh.freshPaths(profile, path.win32)) assert.throws(() => fresh.assertFresh(profile, file => file === location, path.win32));
});
test('native subprocess environment excludes credentials and runtime injection', () => {
  assert.deepEqual(fresh.environment({ PATH: 'keep', USERPROFILE: 'keep', GH_TOKEN: 'drop', SECRET: 'drop',
    NODE_OPTIONS: 'drop', NODE_PATH: 'drop', HTTPS_PROXY: 'drop', TAURI_SIGNING_PRIVATE_KEY: 'drop' }), { PATH: 'keep', USERPROFILE: 'keep' });
});
function receipt() { return { kind: 'r12-fresh-install', sourceCommit: target.binding.target.source.commit,
  bindingSha256: bindingSha, installer: target.binding.target.installer, executable: target.binding.target.executable,
  passed: true, cleanAdmission: true, firstLaunchAccepted: true, mcpAvailable: true, normalRestartAccepted: true,
  settingsUnchanged: true, installedResourcesVerified: true, policyRestored: true, cleanupVerified: true,
  migrationAccepted: false, signedUpdateAccepted: false, publicDiscovery: false, liveAiAcceptance: false, releaseReady: false, cleanupForced: false,
  settingsBeforeReopen: [{ file: 'settings', sha256: null }], settingsAfterReopen: [{ file: 'settings', sha256: null }],
  normalCloses: [{ pid: 10, exitCode: 0 }, { pid: 20, exitCode: 0 }] }; }
test('fresh acceptance refuses cleanup, restart, resource, source and settings mismatches', () => {
  fresh.checkReceipt(receipt());
  for (const change of [r => r.cleanupVerified = false, r => r.cleanupForced = true, r => r.normalCloses[1].pid = 10,
    r => r.normalCloses[1].exitCode = 1, r => r.settingsAfterReopen[0].sha256 = 'changed', r => r.mcpAvailable = false,
    r => r.installedResourcesVerified = false, r => r.sourceCommit = 'b'.repeat(40), r => r.bindingSha256 = 'b'.repeat(64),
    r => r.releaseReady = true, r => r.migrationAccepted = true]) { const r = receipt(); change(r); assert.throws(() => fresh.checkReceipt(r)); }
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
