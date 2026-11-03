'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const target = require('./windows-outgoing-018-target.cjs');
const input = require('./windows-outgoing-018-input.cjs');
const driver = require('./windows-outgoing-018-driver.cjs');
const { binding } = target;
const reviewSha = target.hash(fs.readFileSync(path.join(__dirname, 'fixtures/windows-outgoing-018-binding.json')));
function env(caseName = 'mcp-restore') {
  const [last, restore] = target.CASES[caseName];
  return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'acceptance',
    GITHUB_REF: 'refs/heads/validation/windows-menu-merge-20261027',
    GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-outgoing-018.yml@refs/heads/validation/windows-menu-merge-20261027',
    GITHUB_SHA: 'a'.repeat(40), EXPECTED_HARNESS_COMMIT: 'a'.repeat(40), CREATOR_OUTGOING_CASE: caseName,
    CREATOR_OUTGOING_LAST_TOOL: last, CREATOR_OUTGOING_RESTORE: restore, CREATOR_OUTGOING_REVIEW_SHA256: reviewSha };
}
test('actual source, old failure and changed18 generation are mandatory', () => {
  target.validateBinding();
  for (const mutate of [v => v.target.version = '0.1.17', v => v.baseline.source.commit = 'b'.repeat(40),
    v => v.target.source.tree = 'c'.repeat(40), v => v.target.originalBuildExitCode = 0,
    v => v.target.rawSourceUnchanged = true, v => v.target.installer.sha256 = 'd'.repeat(64),
    v => v.target.generation = v.baseline.generation, v => v.target.recoveryReceiptSha256 = 'e'.repeat(64),
    v => v.exceptionQualification.fixtureUsableForOutgoingTest = false]) {
    const value = structuredClone(binding); mutate(value); assert.throws(() => target.validateBinding(value));
  }
});
test('only exact manual Windows runner and the three case pairs are admitted', () => {
  for (const name of Object.keys(target.CASES)) target.assertHost(env(name), 'win32');
  for (const key of Object.keys(env())) assert.throws(() => target.assertHost({ ...env(), [key]: 'wrong' }, 'win32'), key);
  assert.throws(() => target.assertHost(env(), 'linux'));
  assert.throws(() => target.assertHost({ ...env(), CREATOR_HOSTED_UPDATE_FIXTURE: 'x' }, 'win32'));
});
test('private asset identity checks refuse changed release, body identity or publication', () => {
  const expected = binding.target.privateRelease;
  const release = { id: expected.id, tag_name: expected.tag, target_commitish: expected.source, draft: true,
    assets: Object.entries(expected.assets).map(([name, pin]) => ({ id: pin.id, name, state: 'uploaded', size: pin.bytes, digest: `sha256:${pin.sha256}` })) };
  input.verifyRelease(release, expected);
  for (const mutate of [r => r.draft = false, r => r.id++, r => r.target_commitish = 'b'.repeat(40),
    r => r.assets[0].size++, r => r.assets[0].digest = 'sha256:' + 'f'.repeat(64), r => r.assets.pop()]) {
    const value = structuredClone(release); mutate(value); assert.throws(() => input.verifyRelease(value, expected));
  }
});
test('config permits only its absolute directory to vary', () => {
  const config = target.configFor(path.resolve('test-data')); target.assertBound(config);
  for (const mutate of [c => c.sourceCommit = 'a'.repeat(40), c => c.targetVersion = '0.1.17',
    c => c.baseline.exe = c.pins.executable, c => c.runtime.targetDescriptor = c.runtime.baselineDescriptor,
    c => c.pins.manifest = 'a'.repeat(64), c => c.directory = 'relative']) {
    const value = structuredClone(config); mutate(value); assert.throws(() => target.assertBound(value));
  }
});
test('actual protocol and restore ticket bind 17 to 18', () => {
  for (const version of ['0.1.17', '0.1.18']) driver.assertProtocol({ version, protocol: 1, integrated: true,
    services: { integrated: true, features: ['setup', 'mcp'] } }, version);
  assert.throws(() => driver.assertProtocol({ version: '0.1.16' }, '0.1.16'));
  const hub = 'C:\\runner\\Creator Hub\\creator-hub.exe';
  const ticket = { schemaVersion: 1, fromVersion: '0.1.17', toVersion: '0.1.18',
    views: [{ app: 'mcp', direct: true, bundled: true, path: hub }] };
  driver.assertTicket(ticket, 'mcp', hub);
  for (const mutate of [t => t.fromVersion = '0.1.16', t => t.toVersion = '0.1.17', t => t.views[0].direct = false]) {
    const value = structuredClone(ticket); mutate(value); assert.throws(() => driver.assertTicket(value, 'mcp', hub));
  }
});
test('restore preference is applied through real driver controls', async () => {
  const values = [];
  const page = { locator(selector) { return { click: async () => {}, setChecked: async value => values.push([selector, value]),
    isVisible: async () => ['#view-projects', '#unified-home-updater .hub-update'].includes(selector) }; } };
  for (const restore of [true, false]) {
    values.length = 0; await driver.setUpdatePreferences(page, restore);
    assert.deepEqual(values, [['#auto-download', false], ['#preview-channel', false], ['#restore-hosted-views', restore]]);
  }
});
test('held router and changed generation checks precede success and no manual successor launch exists', () => {
  const source = fs.readFileSync(path.join(__dirname, 'windows-outgoing-018-driver.cjs'), 'utf8');
  assert.equal((source.match(/spawn\(hub,/g) || []).length, 1);
  for (const token of ['target.assertInstalledResources', 'target.assertGenerationProcess', 'target.assertActiveResources',
    'assert.notEqual(nodes[0].image.toLowerCase(), sdkRecords[1].image.toLowerCase())',
    "assert.equal(reconnect.getServerVersion().version, '2.7.8-fixture.18')", "assert.equal(sdkClient.getServerVersion().version, '2.7.7')",
    'assert.notEqual(report.afterRoute.generation, report.beforeRoute.generation)', 'sameProcess(sentinelRecord)', 'await roundTrip(sdkClient)']) assert.ok(source.includes(token), token);
  assert.ok(source.indexOf('target.assertInstalledResources') < source.indexOf('passed: true, nativeUpdateAccepted'));
});
test('named PowerShell invocation is used and native timeouts are unchanged', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/windows-outgoing-018.yml'), 'utf8');
  assert.ok(workflow.includes('$parameters=@{Outgoing018=$true;'));
  assert.ok(workflow.includes('TimeoutSeconds=480}')); assert.ok(workflow.includes('native-self-update-outgoing-018.ps1 @parameters'));
  assert.ok(workflow.includes('timeout-minutes: 20')); assert.ok(!workflow.includes('@args'));
  assert.ok(!/runs-on: (?:ubuntu|macos)/.test(workflow));
});
test('wrong active generation and process path refuse before inspecting files', () => {
  for (const version of ['0.1.17', '0.1.18']) {
    assert.throws(() => target.assertActiveResources('C:/not-used', version, { schemaVersion: 1, descriptorSha256: 'a'.repeat(64), generation: 'b'.repeat(64) }));
    assert.throws(() => target.assertGenerationProcess('C:/wrong/node.exe', 'C:/not-used', version));
  }
});
function successfulReceipt(caseName) {
  const config = target.configFor(path.resolve('test-data'));
  const [tool, restore] = target.CASES[caseName];
  const held = [{ pid: 20, startTicks: '1', image: 'router.exe' }, { pid: 21, startTicks: '2', image: 'old-node.exe' }];
  const report = { kind: target.KIND, sourceCommit: binding.target.source.commit, baseline: config.baseline, pins: config.pins,
    lastTool: tool, restore: restore === 'true', restoredLastTool: restore === 'true' ? tool : null,
    beforePeVersion: [0, 1, 17, 0], afterPeVersion: [0, 1, 18, 0], beforeRoot: { pid: 10 }, afterRoot: { pid: 11 },
    heldProcessesBefore: held, heldProcessesAfter: structuredClone(held), heldServerVersion: { version: '2.7.7' },
    reconnectedServerVersion: { version: '2.7.8-fixture.18' }, beforeRoute: { generation: binding.baseline.generation }, afterRoute: { generation: binding.target.generation } };
  for (const key of ['passed', 'nativeUpdateAccepted', 'automaticRestart', 'cancelPreserved', 'existingConnectionSurvived',
    'newConnectionVerified', 'restorationVerified', 'policyRestored', 'settingsPreserved', 'acceptanceOnly', 'changedMcpGenerationProven',
    'installedResourcesVerifiedBeforeAndAfter', 'heldGenerationRetained']) report[key] = true;
  for (const key of ['publicDiscovery', 'liveAiAcceptance', 'releaseReady']) report[key] = false;
  const lifecycle = { kind: 'lab-lifecycle-result', scenario: target.KIND, actualScope: 'exact-direct17-to-changed18-acceptance-fixture-lab-only',
    driverExitCode: 0, servedRouteCount: 5, rejectedRequestCount: 0, lifecycleSucceeded: true, cleanupVerified: true,
    systemTlsVerified: true, labDiscovery: true, publicDiscovery: false, productAcceptance: false, releaseReady: false };
  return { config, report, lifecycle };
}
test('all three profiles require exact successful native and cleanup evidence', () => {
  for (const name of Object.keys(target.CASES)) {
    const value = successfulReceipt(name); input.checkReceipt(value.report, [value.lifecycle], value.config, env(name));
  }
});
test('receipt refuses held-session replacement, old generation, no restart and failed cleanup', () => {
  for (const mutate of [v => v.report.heldProcessesAfter[0].pid++, v => v.report.afterRoute.generation = binding.baseline.generation,
    v => v.report.changedMcpGenerationProven = false, v => v.report.afterRoot.pid = v.report.beforeRoot.pid,
    v => v.report.reconnectedServerVersion.version = '2.7.7', v => v.lifecycle.cleanupVerified = false,
    v => v.lifecycle.rejectedRequestCount = 1, v => v.report.restoredLastTool = 'setup']) {
    const value = successfulReceipt('mcp-restore'); mutate(value);
    assert.throws(() => input.checkReceipt(value.report, [value.lifecycle], value.config, env()));
  }
});
