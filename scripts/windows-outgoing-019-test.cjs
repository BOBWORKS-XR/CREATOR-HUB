'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const bindingFile = require.resolve('./fixtures/windows-outgoing-019-binding.json');
const checkedInBinding = require(bindingFile);
const synthetic = require('./fixtures/windows-outgoing-019-test-fixture.cjs');
assert.equal(synthetic.purpose, 'SYNTHETIC UNIT DATA ONLY');
// Private test instances never alter the production binding or shared require cache.
function isolated(name, overrides) {
  const filename = path.join(__dirname, name), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(__dirname);
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = name => Object.hasOwn(overrides, name) ? overrides[name] : originalRequire(name);
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  return loaded.exports;
}
const target = isolated('windows-outgoing-019-target.cjs', { './fixtures/windows-outgoing-019-binding.json': synthetic.binding });
const input = isolated('windows-outgoing-019-input.cjs', { './windows-outgoing-019-target.cjs': target });
const driver = isolated('windows-outgoing-019-driver.cjs', { './windows-outgoing-019-target.cjs': target });
const direct = require('./native-outgoing-direct-019.cjs');
const { binding } = target;
const reviewSha = target.hash(fs.readFileSync(path.join(__dirname, 'fixtures/windows-outgoing-019-binding.json')));
function env(caseName = 'mcp-restore') {
  const [last, restore] = target.CASES[caseName];
  return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'acceptance',
    GITHUB_REF: 'refs/heads/codex/windows-root-ui-023-20261116-r14-ci1',
    GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-outgoing-019.yml@refs/heads/codex/windows-root-ui-023-20261116-r14-ci1',
    GITHUB_SHA: 'a'.repeat(40), EXPECTED_HARNESS_COMMIT: 'a'.repeat(40), CREATOR_OUTGOING_CASE: caseName,
    CREATOR_OUTGOING_LAST_TOOL: last, CREATOR_OUTGOING_RESTORE: restore, CREATOR_OUTGOING_REVIEW_SHA256: reviewSha };
}
test('reviewed R11 source, successful build and changed generation are mandatory', () => {
  target.validateBinding();
  for (const mutate of [v => v.target.version = '0.1.22', v => v.baseline.source.commit = 'b'.repeat(40),
    v => v.target.source.tree = 'c'.repeat(40), v => v.target.buildExitCode = 1,
    v => v.target.sourceUnchanged = false, v => v.target.installer.sha256 = 'd'.repeat(64),
    v => v.target.generation = '0'.repeat(64), v => v.target.verificationReceiptSha256 = 'e'.repeat(64),
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
  assert.throws(() => target.assertHost({ ...env(), GITHUB_REF: 'refs/heads/codex/windows-warning-023-20261113-r4-ci2' }, 'win32'));
  assert.throws(() => target.assertHost({ ...env(), GITHUB_WORKFLOW_REF:
    'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-outgoing-019.yml@refs/heads/codex/windows-warning-023-20261113-r4-ci2' }, 'win32'));
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
  for (const mutate of [c => c.sourceCommit = 'a'.repeat(40), c => c.targetVersion = '0.1.22',
    c => c.baseline.exe = c.pins.executable, c => c.runtime.targetDescriptor = c.runtime.baselineDescriptor,
    c => c.pins.manifest = 'a'.repeat(64), c => c.directory = 'relative']) {
    const value = structuredClone(config); mutate(value); assert.throws(() => target.assertBound(value));
  }
});
test('actual protocol and restore ticket bind 22 to 23', () => {
  for (const version of ['0.1.22', '0.1.23']) driver.assertProtocol({ version, protocol: 1, integrated: true,
    services: { integrated: true, features: ['setup', 'mcp'] } }, version);
  assert.throws(() => driver.assertProtocol({ version: '0.1.16' }, '0.1.16'));
  const hub = 'C:\\runner\\Creator Hub\\creator-hub.exe';
  const ticket = { schemaVersion: 1, fromVersion: '0.1.22', toVersion: '0.1.23',
    views: [{ app: 'mcp', direct: true, bundled: true, path: hub }] };
  driver.assertTicket(ticket, 'mcp', hub);
  for (const mutate of [t => t.fromVersion = '0.1.16', t => t.toVersion = '0.1.22', t => t.views[0].direct = false]) {
    const value = structuredClone(ticket); mutate(value); assert.throws(() => driver.assertTicket(value, 'mcp', hub));
  }
});
test('direct page helper is finite to actual22 baseline and23 successor', async () => {
  for (const version of ['0.1.22', '0.1.23']) await direct.checkProtocol({ evaluate: async () => ({ version, protocol: 1,
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
test('held router and changed generation checks precede success and the separate normal restart', () => {
  const source = fs.readFileSync(path.join(__dirname, 'windows-outgoing-019-driver.cjs'), 'utf8');
  const launches = [...source.matchAll(/spawn\(hub,/g)].map(match => match.index);
  assert.equal(launches.length, 2);
  assert.ok(launches[0] < source.indexOf('await observeAutomaticSuccessor('));
  assert.ok(launches[1] > source.indexOf('report.beforeNormalRestart = rootRecord'));
  for (const token of ['target.assertInstalledResources', 'target.assertGenerationProcess', 'target.assertActiveResources',
    'target.assertFreshConnection(sdkRecords, rows, profile)',
    'assert.equal(reconnect.getServerVersion().version, target.binding.target.manifest.modules.mcp.version)', 'assert.equal(sdkClient.getServerVersion().version, target.binding.baseline.manifest.modules.mcp.version)',
    'assert.equal(report.afterRoute.generation, target.binding.target.generation)', 'sameProcess(sentinelRecord)', 'await roundTrip(sdkClient)']) assert.ok(source.includes(token), token);
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
  for (const version of ['0.1.22', '0.1.23']) {
    assert.throws(() => target.assertActiveResources('C:/not-used', version, { schemaVersion: 1, descriptorSha256: 'a'.repeat(64), generation: 'b'.repeat(64) }, true, 'C:/fixture'), /Expected values/);
    assert.throws(() => target.assertGenerationProcess('C:/wrong/node.exe', 'C:/not-used', version, 'C:/fixture'), /Expected values/);
  }
});
// Filesystem-backed positive receipts and negative mutations live in incoming-receipt-r11.test.cjs.

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
    inventory: () => visible ? [f.record] : [], hashFile: file => target.hash(fs.readFileSync(file)), peVersion: () => [0, 1, 23, 0],
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
    inventory: () => [f.record], hashFile: file => target.hash(fs.readFileSync(file)), peVersion: () => [0, 1, 23, 0],
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
      peVersion: () => [0, 1, mode === 'version' ? 22 : 23, 0], onObserved: () => { observed++; }, verifyResources: () => { probes++; },
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
  assert.equal((source.match(/spawn\(hub,/g) || []).length, 2);
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
  assert.equal(result.status, 1); assert.match(result.stderr, /Pending exact22\/private23 pins/);
});
test('checked-in binding validation follows its declared admission state', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, ['-e', "require('./scripts/windows-outgoing-019-target.cjs').validateBinding()"],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, checkedInBinding.enabled ? 0 : 1, result.error?.message || result.stderr || result.stdout);
  if (!checkedInBinding.enabled) assert.match(result.stderr, /Pending exact22\/private23 pins/);
});
test('shape validation refuses absent proofs, old source, same generation and inconsistent asset pins', () => {
  target.validateBindingShape(synthetic.binding);
  for (const mutate of [v => v.baseline.installer.sha256 = null, v => v.baseline.verificationReceiptSha256 = null,
    v => v.baseline.sourceUnchanged = false, v => v.target.sourceUnchanged = false,
    v => v.target.source.commit = 'b6c806254746563e81a6715231d7ef6dfa081fc1',
    v => v.baseline.source.commit = '3bed5cc1881cb6c85ef67abd493c68c2ffdb71b3',
    v => v.target.generation = '0'.repeat(64), v => v.target.manifest.modules.mcp.version = '2.7.9-fixture.19',
    v => v.target.privateRelease.assets['latest.json'].sha256 = '1'.repeat(64),
    v => v.target.privateRelease.tag = 'lab-windows-warning-023-20261113-r4',
    v => delete v.target.manifest.managedRouting.files['routing/runtime.minisig'],
    v => v.fixtureQualification.productionApproval = true, v => v.fixtureQualification.outgoingNativeAccepted = true,
    v => v.fixtureQualification.kind = 'visibility-r4-signed-candidate',
    v => v.fixtureQualification.payloadFiles = 14, v => v.fixtureQualification.source = { ...v.fixtureQualification.source, tree: '1'.repeat(40) }]) {
    const value = structuredClone(synthetic.binding); mutate(value); assert.throws(() => target.validateBindingShape(value));
  }
});
test('workflow is finite Windows-only and binds SDK source before private acquisition', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/windows-outgoing-019.yml'), 'utf8');
  assert.ok(workflow.includes('branches: [codex/windows-root-ui-023-20261116-r14-ci1]'));
  assert.ok(workflow.includes('scripts/windows-outgoing-019-input.cjs source'));
  assert.ok(workflow.includes('ref: '+ '\u0024{{ steps.binding.outputs.source_commit }}'));
  assert.ok(workflow.includes("git -C product rev-parse 'HEAD^{tree}'"));
  assert.ok(workflow.indexOf('input.cjs source') < workflow.indexOf('input.cjs acquire'));
  assert.equal((workflow.match(/persist-credentials: false/g) || []).length, 5);
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
  assert.ok(feed.includes('Only acceptance-only direct23 target admitted'));
  assert.ok(feed.includes("minHubVersion: '0.1.19'"));
  assert.ok(feed.includes('No DNS lookup, upstream connection or relay'));
});

test('parsed workflow retains exactly three Windows profiles and pinned checkout behavior', () => {
  const { yaml } = require('playwright-core/lib/utilsBundle');
  const document = yaml.parseDocument(fs.readFileSync(path.join(__dirname, '../.github/workflows/windows-outgoing-019.yml'), 'utf8'));
  assert.deepEqual(document.errors, []);
  const workflow = document.toJS();
  const preflight = workflow.jobs.preflight;
  assert.equal(preflight.if, "github.repository == 'BOBWORKS-XR/CREATOR-HUB' && github.ref == 'refs/heads/codex/windows-root-ui-023-20261116-r14-ci1'");
  const tests = preflight.steps.find(step => step.run?.startsWith('node --test ')).run.split(/\s+/).slice(2);
  for (const file of ['scripts/windows-outgoing-019-test.cjs', 'scripts/incoming-store-r11.test.cjs', 'scripts/incoming-receipt-r11.test.cjs']) {
    assert.equal(tests.filter(value => value === file).length, 1, `${file} must run once in preflight`);
  }
  for (const file of ['scripts/incoming-store-r11.test.cjs', 'scripts/incoming-receipt-r11.test.cjs']) assert.ok(workflow.on.push.paths.includes(file));
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['acceptance', 'fresh', 'preflight']);
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

test('exact outgoing binding survives core.autocrlf=true checkout without relaxing raw hashes', t => {
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const relative = 'scripts/fixtures/windows-outgoing-019-binding.json';
  const rule = `${relative} -text`;
  const attributes = fs.readFileSync(path.join(__dirname, '../.gitattributes'), 'utf8');
  const attributeLines = attributes.split(/\r?\n/);
  assert.equal(attributeLines.filter(line => line === rule).length, 1, 'One exact binding byte-preservation rule required');
  const original = fs.readFileSync(bindingFile);
  assert.equal(original.includes(13), false, 'Frozen binding must retain its original LF bytes');
  const expectedHash = target.hash(original);
  assert.match(expectedHash, /^[a-f0-9]{64}$/);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-outgoing-checkout-'));
  t.diagnostic(`Disposable no-ref checkout: ${temporary}`);
  t.after(() => {
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('creator-outgoing-checkout-'));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  const repository = process.env.CREATOR_TEST_GIT_DIR || execFileSync('git', ['rev-parse', '--absolute-git-dir'],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
  assert.ok(path.isAbsolute(repository), 'Existing Git metadata required for the checkout regression');
  const objectDirectory = path.join(temporary, 'objects'); fs.mkdirSync(objectDirectory);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/i.test(name)));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0',
    GIT_OBJECT_DIRECTORY: objectDirectory, GIT_INDEX_FILE: path.join(temporary, 'unused.index') });
  const execute = (args, input, extra = {}) => execFileSync('git', args, { cwd: temporary, env: { ...env, ...extra }, input,
    windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  const refs = () => execute([`--git-dir=${repository}`, 'for-each-ref', '--format=%(refname) %(objectname)']).toString();
  const originalRefs = refs();
  function checkout(label, attrText) {
    const worktree = path.join(temporary, label); fs.mkdirSync(worktree);
    const extra = { GIT_INDEX_FILE: path.join(temporary, `${label}.index`) };
    const git = (args, input) => execute([`--git-dir=${repository}`, `--work-tree=${worktree}`,
      '-c', 'core.autocrlf=true', '-c', 'core.safecrlf=false', ...args], input, extra);
    assert.equal(git(['config', '--get', 'core.autocrlf']).toString().trim(), 'true');
    for (const [name, bytes] of [['.gitattributes', Buffer.from(attrText)], [relative, original], ['control.json', Buffer.from('{"lf":true}\n')]]) {
      const blob = git(['hash-object', '-w', '--no-filters', '--stdin'], bytes).toString().trim();
      git(['update-index', '--add', '--cacheinfo', `100644,${blob},${name}`]);
    }
    const tree = git(['write-tree']).toString().trim();
    git(['read-tree', tree]); git(['checkout-index', '--all', '--force']);
    assert.equal(fs.readFileSync(path.join(worktree, 'control.json'), 'utf8'), '{"lf":true}\r\n', 'Autocrlf conversion must be active');
    assert.ok(git(['cat-file', 'blob', `${tree}:${relative}`]).equals(original), 'Source blob changed');
    return fs.readFileSync(path.join(worktree, relative));
  }
  for (const [label, eol] of [['lf', '\n'], ['crlf', '\r\n']]) {
    const attrText = attributeLines.join(eol), formLines = attrText.split(/\r?\n/);
    assert.equal(formLines.filter(line => line === rule).length, 1, `${label}: exact rule must be parsed`);
    const preserved = checkout(`protected-${label}`, attrText);
    assert.ok(preserved.equals(original)); assert.equal(target.hash(preserved), expectedHash);
    const unprotected = checkout(`unprotected-${label}`, formLines.filter(line => line !== rule).join(eol));
    assert.notEqual(target.hash(unprotected), expectedHash, 'Control must reproduce the missing-rule failure');
    assert.equal(unprotected.toString(), original.toString().replace(/\n/g, '\r\n'));
    t.diagnostic(`${label.toUpperCase()} attributes: exact binding preserved; missing-rule CRLF control rejected`);
  }
  assert.equal(refs(), originalRefs, 'Checkout regression must not modify repository refs');
  assert.equal(fs.existsSync(path.join(temporary, 'unused.index')), false, 'Only explicit disposable indexes may be used');
});