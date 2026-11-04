'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const bindingFile = require.resolve('./fixtures/windows-outgoing-019-binding.json');
const checkedInBinding = require(bindingFile);
const synthetic = require('./fixtures/windows-outgoing-019-test-fixture.cjs');
assert.equal(synthetic.purpose, 'SYNTHETIC UNIT DATA ONLY');
// Test-process module substitution only; native entrypoints never admit synthetic inputs.
require.cache[bindingFile].exports = synthetic.binding;
const target = require('./windows-outgoing-019-target.cjs');
const input = require('./windows-outgoing-019-input.cjs');
const driver = require('./windows-outgoing-019-driver.cjs');
const direct = require('./native-outgoing-direct-019.cjs');
const { binding } = target;
const reviewSha = target.hash(fs.readFileSync(path.join(__dirname, 'fixtures/windows-outgoing-019-binding.json')));
function env(caseName = 'mcp-restore') {
  const [last, restore] = target.CASES[caseName];
  return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'acceptance',
    GITHUB_REF: 'refs/heads/validation/windows-menu-merge-20261027',
    GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-outgoing-019.yml@refs/heads/validation/windows-menu-merge-20261027',
    GITHUB_SHA: 'a'.repeat(40), EXPECTED_HARNESS_COMMIT: 'a'.repeat(40), CREATOR_OUTGOING_CASE: caseName,
    CREATOR_OUTGOING_LAST_TOOL: last, CREATOR_OUTGOING_RESTORE: restore, CREATOR_OUTGOING_REVIEW_SHA256: reviewSha };
}
test('actual source, successful fixture20 build and changed generation are mandatory', () => {
  target.validateBinding();
  for (const mutate of [v => v.target.version = '0.1.19', v => v.baseline.source.commit = 'b'.repeat(40),
    v => v.target.source.tree = 'c'.repeat(40), v => v.target.buildExitCode = 1,
    v => v.target.sourceUnchanged = false, v => v.target.installer.sha256 = 'd'.repeat(64),
    v => v.target.generation = v.baseline.generation, v => v.target.verificationReceiptSha256 = 'e'.repeat(64),
    v => v.fixtureQualification.fixtureUsableForOutgoingTest = false]) {
    const value = structuredClone(binding); mutate(value); assert.throws(() => target.validateBinding(value));
  }
});
test('both private input releases require the actual staged release and asset IDs', () => {
  for (const mutate of [v => { delete v.baseline.releaseId; }, v => v.baseline.assetId++, v => v.target.privateRelease.id++]) {
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
  for (const mutate of [c => c.sourceCommit = 'a'.repeat(40), c => c.targetVersion = '0.1.19',
    c => c.baseline.exe = c.pins.executable, c => c.runtime.targetDescriptor = c.runtime.baselineDescriptor,
    c => c.pins.manifest = 'a'.repeat(64), c => c.directory = 'relative']) {
    const value = structuredClone(config); mutate(value); assert.throws(() => target.assertBound(value));
  }
});
test('actual protocol and restore ticket bind 19 to 20', () => {
  for (const version of ['0.1.19', '0.1.20']) driver.assertProtocol({ version, protocol: 1, integrated: true,
    services: { integrated: true, features: ['setup', 'mcp'] } }, version);
  assert.throws(() => driver.assertProtocol({ version: '0.1.16' }, '0.1.16'));
  const hub = 'C:\\runner\\Creator Hub\\creator-hub.exe';
  const ticket = { schemaVersion: 1, fromVersion: '0.1.19', toVersion: '0.1.20',
    views: [{ app: 'mcp', direct: true, bundled: true, path: hub }] };
  driver.assertTicket(ticket, 'mcp', hub);
  for (const mutate of [t => t.fromVersion = '0.1.16', t => t.toVersion = '0.1.19', t => t.views[0].direct = false]) {
    const value = structuredClone(ticket); mutate(value); assert.throws(() => driver.assertTicket(value, 'mcp', hub));
  }
});
test('direct page helper is finite to actual19 baseline and20 successor', async () => {
  for (const version of ['0.1.19', '0.1.20']) await direct.checkProtocol({ evaluate: async () => ({ version, protocol: 1,
    integrated: true, services: { integrated: true, features: ['setup', 'mcp'] } }) }, version);
  assert.throws(() => direct.assertProtocol({ version: '0.1.18' }, '0.1.18'));
  const source = fs.readFileSync(path.join(__dirname, 'windows-outgoing-019-driver.cjs'), 'utf8');
  assert.ok(source.includes('expectedVersion: target.binding.baseline.version'));
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
  const source = fs.readFileSync(path.join(__dirname, 'windows-outgoing-019-driver.cjs'), 'utf8');
  assert.equal((source.match(/spawn\(hub,/g) || []).length, 1);
  for (const token of ['target.assertInstalledResources', 'target.assertGenerationProcess', 'target.assertActiveResources',
    'assert.notEqual(nodes[0].image.toLowerCase(), sdkRecords[1].image.toLowerCase())',
    'assert.equal(reconnect.getServerVersion().version, target.binding.target.manifest.modules.mcp.version)', 'assert.equal(sdkClient.getServerVersion().version, target.binding.baseline.manifest.modules.mcp.version)',
    'assert.notEqual(report.afterRoute.generation, report.beforeRoute.generation)', 'sameProcess(sentinelRecord)', 'await roundTrip(sdkClient)']) assert.ok(source.includes(token), token);
  assert.ok(source.indexOf('target.assertInstalledResources') < source.indexOf('passed: true, nativeUpdateAccepted'));
});
test('named PowerShell invocation is used and native timeouts are unchanged', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/windows-outgoing-019.yml'), 'utf8');
  assert.ok(workflow.includes('$parameters=@{Outgoing019=$true;'));
  assert.ok(workflow.includes('TimeoutSeconds=480}')); assert.ok(workflow.includes('native-self-update-outgoing-019.ps1 @parameters'));
  assert.ok(workflow.includes('timeout-minutes: 20')); assert.ok(!workflow.includes('@args'));
  assert.ok(!/runs-on: (?:ubuntu|macos)/.test(workflow));
});
test('wrong active generation and process path refuse before inspecting files', () => {
  for (const version of ['0.1.19', '0.1.20']) {
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
    beforePeVersion: [0, 1, 19, 0], afterPeVersion: [0, 1, 20, 0], beforeRoot: { pid: 10 }, afterRoot: { pid: 11, kernelIdentityVerified: true }, resourceProbe: { phase: 'after-automatic-root', attempts: 1, passed: true },
    heldProcessesBefore: held, heldProcessesAfter: structuredClone(held), heldServerVersion: { version: binding.baseline.manifest.modules.mcp.version },
    reconnectedServerVersion: { version: binding.target.manifest.modules.mcp.version }, beforeRoute: { generation: binding.baseline.generation }, afterRoute: { generation: binding.target.generation } };
  for (const key of ['passed', 'nativeUpdateAccepted', 'automaticRestart', 'cancelPreserved', 'existingConnectionSurvived',
    'newConnectionVerified', 'restorationVerified', 'policyRestored', 'settingsPreserved', 'acceptanceOnly', 'changedMcpGenerationProven',
    'installedResourcesVerifiedBeforeAndAfter', 'heldGenerationRetained']) report[key] = true;
  for (const key of ['publicDiscovery', 'liveAiAcceptance', 'releaseReady']) report[key] = false;
  const lifecycle = { kind: 'lab-lifecycle-result', scenario: target.KIND, actualScope: 'exact-direct19-to-changed20-acceptance-fixture-lab-only',
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
    v => v.report.reconnectedServerVersion.version = binding.baseline.manifest.modules.mcp.version, v => v.lifecycle.cleanupVerified = false,
    v => v.lifecycle.rejectedRequestCount = 1, v => v.report.restoredLastTool = 'setup']) {
    const value = successfulReceipt('mcp-restore'); mutate(value);
    assert.throws(() => input.checkReceipt(value.report, [value.lifecycle], value.config, env()));
  }
});

function copyFixture() {
  const root = path.join(__dirname, '../artifacts/outgoing-019-readiness-fixtures'); fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'case-'));
  const hub = path.join(directory, 'creator-hub.exe'), bytes = Buffer.from('synthetic-root-20');
  fs.writeFileSync(hub, bytes, { flag: 'wx' });
  const resources = Array.from({ length: 15 }, (_, index) => {
    const data = Buffer.from(`complete-resource-${index}`), file = path.join(directory, `resource-${index}.bin`);
    fs.writeFileSync(file, index === 0 ? Buffer.alloc(0) : data, { flag: 'wx' });
    return { file, data, sha256: target.hash(data), name: `modules/resource-${index}.bin` };
  });
  const record = { pid: 20, parentPid: 18, startTicks: '20', image: hub, kernelIdentityVerified: true };
  return { directory, hub, bytes, resources, record };
}
test('partial-copy fixture reproduces early read refusal but waits for automatic Root before one strict 15-file probe', async () => {
  const f = copyFixture(); let visible = false, probes = 0, resourceReads = 0, observed = false;
  assert.equal(target.hash(fs.readFileSync(f.hub)), target.hash(f.bytes));
  assert.throws(() => target.readHash(f.resources[0].file, f.resources[0].sha256, f.resources[0].name), error =>
    error.resourceDiagnostic.relativePath === f.resources[0].name && error.resourceDiagnostic.lstat.size === 0);
  await driver.observeAutomaticSuccessor({ hub: f.hub, previousPid: 10, expectedSha256: target.hash(f.bytes),
    inventory: () => visible ? [f.record] : [], hashFile: file => target.hash(fs.readFileSync(file)), peVersion: () => [0, 1, 20, 0],
    onObserved: record => { assert.deepEqual(record, f.record); observed = true; },
    verifyResources: () => { assert.equal(observed, true); probes++; for (const item of f.resources) { resourceReads++; target.readHash(item.file, item.sha256, item.name); } },
    wait: async (read, seconds) => {
      assert.equal(seconds, 90); assert.throws(read, /automatic replacement Root/); assert.equal(probes, 0);
      fs.writeFileSync(f.resources[0].file, f.resources[0].data); visible = true; return read();
    } });
  assert.equal(probes, 1); assert.equal(resourceReads, 15);
});
test('corrupt payload after Root readiness is refused once with named size and actual-hash evidence', async () => {
  const f = copyFixture(), item = f.resources[0], corrupt = Buffer.from('corrupt-after-ready');
  fs.writeFileSync(item.file, corrupt); let probes = 0, observed = false;
  await assert.rejects(driver.observeAutomaticSuccessor({ hub: f.hub, previousPid: 10, expectedSha256: target.hash(f.bytes),
    inventory: () => [f.record], hashFile: file => target.hash(fs.readFileSync(file)), peVersion: () => [0, 1, 20, 0],
    onObserved: () => { observed = true; }, verifyResources: () => { probes++; target.readHash(item.file, item.sha256, item.name); },
    wait: async read => read() }), error => {
    assert.equal(observed, true); assert.equal(error.resourceDiagnostic.relativePath, item.name);
    assert.equal(error.resourceDiagnostic.lstat.size, corrupt.length);
    assert.equal(error.resourceDiagnostic.actualSha256, target.hash(corrupt));
    assert.equal(error.resourceDiagnostic.expectedSha256, item.sha256); return true;
  });
  assert.equal(probes, 1);
});
test('wrong replacement identity, image or PE version cannot reach payload verification', async () => {
  for (const mode of ['same-pid', 'kernel', 'hash', 'version']) {
    const f = copyFixture(); let probes = 0, observed = 0;
    const record = { ...f.record, ...(mode === 'same-pid' ? { pid: 10 } : {}), ...(mode === 'kernel' ? { kernelIdentityVerified: false } : {}) };
    await assert.rejects(driver.observeAutomaticSuccessor({ hub: f.hub, previousPid: 10, expectedSha256: target.hash(f.bytes),
      inventory: () => [record], hashFile: () => mode === 'hash' ? '0'.repeat(64) : target.hash(f.bytes),
      peVersion: () => [0, 1, mode === 'version' ? 19 : 20, 0], onObserved: () => { observed++; }, verifyResources: () => { probes++; },
      wait: async (read, seconds) => { assert.equal(seconds, 90); return read(); } }));
    assert.equal(probes, 0); assert.equal(observed, 0);
  }
});
test('resource diagnostics preserve empty-file and nonregular-file refusal without contents', () => {
  const f = copyFixture(), item = f.resources[0];
  assert.throws(() => target.readHash(item.file, item.sha256, item.name), error => {
    assert.equal(error.resourceDiagnostic.lstat.size, 0); assert.equal(error.resourceDiagnostic.actualSha256, null);
    assert.equal(error.resourceDiagnostic.hashAvailable, false); return true;
  });
  assert.throws(() => target.readHash(f.directory, item.sha256, 'modules/not-a-file'), error =>
    error.resourceDiagnostic.relativePath === 'modules/not-a-file' && error.resourceDiagnostic.lstat.isDirectory);
  const source = fs.readFileSync(path.join(__dirname, 'windows-outgoing-019-target.cjs'), 'utf8');
  assert.ok(source.includes('!stat.isSymbolicLink()')); assert.ok(source.includes('512 * 1024 * 1024'));
});
test('actual driver captures new Root before the strict probe and preserves diagnostic evidence', () => {
  const source = fs.readFileSync(path.join(__dirname, 'windows-outgoing-019-driver.cjs'), 'utf8');
  assert.equal((source.match(/spawn\(hub,/g) || []).length, 1);
  assert.ok(source.includes('await observeAutomaticSuccessor({ hub,'));
  assert.ok(source.includes("phase: 'after-automatic-root', attempts: 1"));
  assert.ok(source.includes('report.resourceFailure = error.resourceDiagnostic'));
  assert.ok(source.indexOf('onObserved(ready.record, ready.version)') < source.indexOf('verifyResources();'));
});

test('synthetic pending binding refuses all admission until actual pins arrive', () => {
  const pendingBinding = structuredClone(synthetic.binding);
  pendingBinding.enabled = false;
  pendingBinding.baseline.source.commit = null;
  pendingBinding.target.source.commit = null;
  pendingBinding.target.privateRelease.id = null;
  assert.equal(pendingBinding.enabled, false); assert.equal(pendingBinding.baseline.source.commit, null);
  assert.equal(pendingBinding.target.source.commit, null); assert.equal(pendingBinding.target.privateRelease.id, null);
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, ['-e', [
    "const bindingFile = require.resolve('./scripts/fixtures/windows-outgoing-019-binding.json');",
    'require(bindingFile); require.cache[bindingFile].exports = JSON.parse(process.argv[1]);',
    "require('./scripts/windows-outgoing-019-target.cjs').validateBinding();",
  ].join('\n'), JSON.stringify(pendingBinding)],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 1); assert.match(result.stderr, /Pending R2 base19\/private20 pins/);
});
test('checked-in binding validation follows its declared admission state', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, ['-e', "require('./scripts/windows-outgoing-019-target.cjs').validateBinding()"],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, checkedInBinding.enabled ? 0 : 1, result.error?.message || result.stderr || result.stdout);
  if (!checkedInBinding.enabled) assert.match(result.stderr, /Pending R2 base19\/private20 pins/);
});
test('shape validation refuses absent proofs, old source, same generation and inconsistent asset pins', () => {
  target.validateBindingShape(synthetic.binding);
  for (const mutate of [v => v.baseline.installer.sha256 = null, v => v.baseline.verificationReceiptSha256 = null,
    v => v.baseline.sourceUnchanged = false, v => v.target.sourceUnchanged = false,
    v => v.target.source.commit = 'b6c806254746563e81a6715231d7ef6dfa081fc1',
    v => v.baseline.source.commit = '3bed5cc1881cb6c85ef67abd493c68c2ffdb71b3',
    v => v.target.generation = v.baseline.generation, v => v.target.manifest.modules.mcp.version = '2.7.8-fixture.19',
    v => v.target.privateRelease.assets['latest.json'].sha256 = '1'.repeat(64),
    v => delete v.target.manifest.managedRouting.files['routing/runtime.minisig'],
    v => v.fixtureQualification.productionApproval = true, v => v.fixtureQualification.outgoingNativeAccepted = true,
    v => v.fixtureQualification.payloadFiles = 14, v => v.fixtureQualification.source = { ...v.fixtureQualification.source, tree: '1'.repeat(40) }]) {
    const value = structuredClone(synthetic.binding); mutate(value); assert.throws(() => target.validateBindingShape(value));
  }
});
test('resource completion phase and verified automatic Root identity are mandatory in receipts', () => {
  for (const mutate of [v => delete v.report.resourceProbe, v => v.report.resourceProbe.phase = 'before-root',
    v => v.report.resourceProbe.attempts = 2, v => v.report.resourceProbe.passed = false,
    v => v.report.afterRoot.kernelIdentityVerified = false]) {
    const value = successfulReceipt('setup-restore'); mutate(value);
    assert.throws(() => input.checkReceipt(value.report, [value.lifecycle], value.config, env('setup-restore')));
  }
});
test('workflow is finite Windows-only and binds SDK source before private acquisition', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/windows-outgoing-019.yml'), 'utf8');
  assert.ok(workflow.includes('branches: [validation/windows-menu-merge-20261027]'));
  assert.ok(workflow.includes('scripts/windows-outgoing-019-input.cjs source'));
  assert.ok(workflow.includes('ref: '+ '\u0024{{ steps.binding.outputs.source_commit }}'));
  assert.ok(workflow.includes("git -C product rev-parse 'HEAD^{tree}'"));
  assert.ok(workflow.indexOf('input.cjs source') < workflow.indexOf('input.cjs acquire'));
  assert.equal((workflow.match(/persist-credentials: false/g) || []).length, 3);
  assert.equal((workflow.match(/- case:/g) || []).length, 3);
  assert.ok(workflow.includes("if: github.event_name == 'workflow_dispatch'"));
  assert.doesNotMatch(workflow, /cargo |npm run build|gh workflow run|gh release |secrets\./);
});
test('copied native transport retains admission, ownership, TLS and bounded deadline checks', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-self-update-outgoing-019.ps1'), 'utf8');
  for (const text of ["if (-not $Outgoing019 -or $Incoming016", "$TimeoutSeconds -gt 480", 'SystemTlsVerified',
    'No name-wide or process-tree kills', 'AuthenticateAsClientAsync', 'CreatorHubLabProcessImage',
    'CREATOR_OUTGOING_CONFIG_SHA256', 'native-outgoing-process-019.ps1']) assert.ok(source.toLowerCase().includes(text.toLowerCase()), text);
  const feed = fs.readFileSync(path.join(__dirname, 'self-update-outgoing-019-feed.cjs'), 'utf8');
  assert.ok(feed.includes('Only acceptance-only direct20 target admitted'));
  assert.ok(feed.includes("minHubVersion: '0.1.19'"));
  assert.ok(feed.includes('No DNS lookup, upstream connection or relay'));
});

test('parsed workflow retains exactly three Windows profiles and pinned checkout behavior', () => {
  const { yaml } = require('playwright-core/lib/utilsBundle');
  const document = yaml.parseDocument(fs.readFileSync(path.join(__dirname, '../.github/workflows/windows-outgoing-019.yml'), 'utf8'));
  assert.deepEqual(document.errors, []);
  const workflow = document.toJS();
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['acceptance', 'preflight']);
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job['runs-on'], 'windows-latest');
    for (const step of job.steps) if (step.uses === 'actions/checkout@v6') assert.equal(step.with['persist-credentials'], false);
  }
  assert.equal(workflow.jobs.acceptance['timeout-minutes'], 20);
  assert.deepEqual(workflow.jobs.acceptance.strategy.matrix.include, [
    { case: 'mcp-restore', last_tool: 'mcp', restore: 'true' },
    { case: 'setup-restore', last_tool: 'setup', restore: 'true' },
    { case: 'setup-no-restore', last_tool: 'setup', restore: 'false' },
  ]);
  const steps = workflow.jobs.acceptance.steps;
  assert.ok(steps.findIndex(step => step.run === 'npm ci --ignore-scripts') < steps.findIndex(step => step.id === 'binding'));
});
