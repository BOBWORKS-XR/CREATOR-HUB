'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const diag = require('./windows-mixed-public-diagnostic.cjs');
const migration = require('./native-windows-016-migration.cjs');
const handoff = require('./windows-migrated-outgoing-handoff.cjs');
const candidate = require('./windows-migration-r2-candidate.cjs');
const driver = require('./windows-mixed-public-driver.cjs');
const sha = 'a'.repeat(40);
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/validation/windows-menu-merge-20261027',
  GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-outgoing-017.yml@refs/heads/validation/windows-menu-merge-20261027',
  CREATOR_MIXED_PUBLIC_DIAGNOSTIC: '1', CREATOR_OUTGOING_CASE: 'mcp-restore', CREATOR_OUTGOING_LAST_TOOL: 'mcp', CREATOR_OUTGOING_RESTORE: 'true',
  GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '123', GITHUB_ACTOR_ID: '42', CREATOR_MIXED_EXPECTED_ACTOR_ID: '42',
  GITHUB_SHA: sha, CREATOR_MIXED_EXPECTED_SOURCE: sha, GITHUB_WORKSPACE: path.resolve('.'), USERPROFILE: path.resolve('profile'),
  APPDATA: path.resolve('profile/appdata'), LOCALAPPDATA: path.resolve('profile/local'), RUNNER_TEMP: path.resolve('temp') };
const config = { sourceCommit: 'e39d853f4207bbc8f250566064027c19d8eeb6e0', targetVersion: '0.1.17',
  baseline: { version: candidate.TARGET.version, installer: candidate.TARGET.installer, exe: candidate.TARGET.exe },
  runtime: { baselineDescriptor: migration.RESOURCE_PINS['routing/runtime.json'], targetDescriptor: '1e53158ae6bffe842c7256c1b40a44d59c2d0a6d3f03b5506b1e5f17584d6fda' },
  pins: { descriptor: '50bbcc0dfe5a4d22900a65b046145a9f05b185a4f86333c37f6b4277aebe1b6f',
    descriptorSignature: '57df8ee478f8e159a983d2e598b4bbedef15f7eb375a68b4221c12854fcbb733',
    installer: '0a737147db5766e108ece53a6f6ffd5fad2d5d311058effacd4e07ae2d9bf219',
    executable: 'b98e7484bb7d3f2a9d3abb450446285eb24b42deeb31adf02a5694e1b16795a5',
    manifest: 'b80fba85744c023ed6d61a6442bd64d3031074d2d9d7ad9130d3c68e50ef3bf1' } };
test('migrated successor activates the approved route only through unchanged guarded OpenCode review', async () => {
  const calls = []; let checks = 0;
  const migrated = { guard: { verify() { checks++; } } };
  const page = { evaluate: async fn => fn() };
  const previous = global.window;
  global.window = { CreatorHubNative: { async invoke(command, args) {
    calls.push([command, args]);
    if (args.command === 'begin_ui_operation') return 7;
    if (args.command === 'review_existing_client_connections') return { status: 'unchanged', count: 0 };
  } } };
  try {
    await driver.activateMigratedRoute(page, migrated);
    assert.equal(checks, 2);
    assert.deepEqual(calls.map(([, args]) => [args.command, args.args]), [
      ['begin_ui_operation', {}], ['review_existing_client_connections', { clients: ['opencode'] }], ['finish_ui_operation', { id: 7 }],
    ]);
    global.window.CreatorHubNative.invoke = async (command, args) => args.command === 'review_existing_client_connections'
      ? { status: 'migrated', count: 1 } : 7;
    await assert.rejects(driver.activateMigratedRoute(page, migrated));
    assert.equal(checks, 4);
    migrated.guard.verify = () => { throw Error('fixture changed'); };
    await assert.rejects(driver.activateMigratedRoute(page, migrated), /fixture changed/);
  } finally { global.window = previous; }
  const source = fs.readFileSync(path.join(__dirname, 'windows-mixed-public-driver.cjs'), 'utf8');
  assert.ok(source.indexOf('report.preReviewRoute = observeActive()') < source.indexOf('await activateMigratedRoute(page, migrated)'));
  assert.ok(source.indexOf('await activateMigratedRoute(page, migrated)') < source.indexOf("report.afterRoute = active('0.1.17')"));
  const fixture = migration.fixture(env, path.resolve('migration-output'));
  assert.ok(fixture.untouched.some(item => item.path.endsWith(path.join('opencode', 'opencode.jsonc')) &&
    item.bytes.toString().includes('"other":{"type":"remote"')));
});
test('diagnostic admission requires exact hosted context, actor, source and first attempt', () => {
  diag.admit(env, 'win32');
  for (const key of Object.keys(env)) assert.throws(() => diag.admit({ ...env, [key]: '' }, 'win32'));
  assert.throws(() => diag.admit(env, 'linux')); assert.throws(() => diag.admit({ ...env, GITHUB_RUN_ATTEMPT: '2' }, 'win32'));
  diag.checkExactFixture(config);
  for (const mutate of [c => c.baseline.installer = '0'.repeat(64), c => c.pins.installer = '0'.repeat(64), c => c.runtime.targetDescriptor = '0'.repeat(64), c => c.sourceCommit = 'b'.repeat(40)]) {
    const c = structuredClone(config); mutate(c); assert.throws(() => diag.checkExactFixture(c));
  }
});
test('23-file handoff refuses tampering before phase two and latches later changes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-public-handoff-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const expected = Array.from({ length: 23 }, (_, i) => ({ file: path.join(dir, `file-${i}`), expected: Buffer.from(`fixture-${i}`) }));
  for (const entry of expected) fs.writeFileSync(entry.file, entry.expected, { flag: 'wx' });
  const records = expected.map(entry => ({ file: entry.file, sha256: candidate.hash(entry.expected) }));
  const missing = records.slice(1); assert.throws(() => diag.protectHandoffFiles(expected, missing));
  const reordered = [...records]; [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  assert.throws(() => diag.protectHandoffFiles(expected, reordered));
  fs.writeFileSync(expected[0].file, 'changed'); assert.throws(() => diag.protectHandoffFiles(expected, records));
  fs.writeFileSync(expected[0].file, expected[0].expected);
  const guard = diag.protectHandoffFiles(expected, records); guard.verify();
  fs.writeFileSync(expected[1].file, 'changed'); assert.throws(() => guard.verify());
  fs.writeFileSync(expected[1].file, expected[1].expected); assert.throws(() => guard.verify());
});
test('spawn cleanup recovery accepts only the owned live child with kernel identity', () => {
  const { recoverSpawnedRoot } = require('./windows-mixed-public-driver.cjs');
  const child = { pid: 44, exitCode: null, signalCode: null }, hub = 'C:\\runner\\Creator Hub\\creator-hub.exe';
  const row = { pid: 44, parentPid: 33, image: hub, startTicks: '123', kernelIdentityVerified: true };
  assert.deepEqual(recoverSpawnedRoot(child, () => row, hub, 33), row);
  for (const bad of [{ ...row, pid: 45 }, { ...row, parentPid: 34 }, { ...row, image: 'C:\\other.exe' }, { ...row, kernelIdentityVerified: false }])
    assert.throws(() => recoverSpawnedRoot(child, () => bad, hub, 33));
  assert.throws(() => recoverSpawnedRoot({ ...child, exitCode: 0 }, () => row, hub, 33));
  assert.throws(() => recoverSpawnedRoot({ ...child, signalCode: 'SIGTERM' }, () => row, hub, 33));
  assert.throws(() => recoverSpawnedRoot(child, () => { throw Error('inventory unavailable'); }, hub, 33));
});
test('cleanup recovers an owned initial child and refuses to close an unrecorded successor', async () => {
  const vm = require('node:vm'), { recoverSpawnedRoot } = require('./windows-mixed-public-driver.cjs');
  const source = fs.readFileSync(path.join(__dirname, 'windows-mixed-public-driver.cjs'), 'utf8');
  const start = source.indexOf('    if (!rootRecord && child && child.exitCode === null');
  const end = source.indexOf('    if (browser)', start); assert.ok(start >= 0 && end > start);
  const fragment = source.slice(start, end), hub = 'C:\\runner\\Creator Hub\\creator-hub.exe';
  const row = { pid: 44, parentPid: process.pid, image: hub, startTicks: '123', kernelIdentityVerified: true };
  async function execute(options) {
    const events = [], report = { passed: true }, context = { ...options, report, hub, recoverSpawnedRoot,
      record: options.record || (() => row), native: action => events.push(action), inventory: () => [],
      retry: async fn => fn(), assert };
    await vm.runInNewContext(`(async () => { ${fragment} })()`, context);
    return { report, events };
  }
  const live = { pid: 44, exitCode: null, signalCode: null };
  const recovered = await execute({ child: live, rootRecord: null, restartPossible: false, successorRecorded: false });
  assert.deepEqual(recovered.events, ['close']); assert.equal(recovered.report.initialRootIdentityRecovered, true);
  const unknown = await execute({ child: live, rootRecord: null, restartPossible: false, successorRecorded: false,
    record: () => { throw Error('unowned'); } });
  assert.deepEqual(unknown.events, []); assert.equal(unknown.report.initialCleanupUnverified, true); assert.equal(unknown.report.passed, false);
  const exited = { ...live, exitCode: 0 };
  const unrecorded = await execute({ child: exited, rootRecord: row, restartPossible: true, successorRecorded: false });
  assert.deepEqual(unrecorded.events, []); assert.equal(unrecorded.report.successorCleanupUnverified, true); assert.equal(unrecorded.report.passed, false);
});
test('separate diagnostic invokes migration.main without changing the closed network gate', () => {
  const source = fs.readFileSync(path.join(__dirname, 'windows-mixed-public-diagnostic.cjs'), 'utf8');
  const driver = fs.readFileSync(path.join(__dirname, 'windows-mixed-public-driver.cjs'), 'utf8');
  const ordinary = fs.readFileSync(path.join(__dirname, '../artifacts/menu-merge-20261027/outgoing/driver.cjs'), 'utf8');
  const lifecycle = fs.readFileSync(path.join(__dirname, 'native-mixed-public-diagnostic.ps1'), 'utf8');
  assert.match(source, /await migration\.main\(args\)/); assert.doesNotMatch(source, /runWithMigrationEnvironment|checkNetwork/);
  assert.match(ordinary, /handoff\.runWithMigrationEnvironment\(inputs\)/);
  assert.throws(() => handoff.requireMigrationNetworkIsolation(), /network isolation is not established/);
  assert.match(driver, /mixed-public-diagnostic-report\.json/); assert.match(driver, /publicDiscovery: null, publicNetworkAllowed: true/);
  assert.match(driver, /WEBVIEW2_USER_DATA_FOLDER: path\.join\(migrated\.migrationOutput, 'webview'\)/);
  assert.doesNotMatch(driver, /existingConnectionSurvived: true/);
  assert.match(driver, /restartPossible && !successorRecorded[\s\S]*successorCleanupUnverified = true/);
  assert.match(driver, /recoverSpawnedRoot\(child, record, hub\)/);
  assert.match(lifecycle, /windows-mixed-public-driver\.cjs/); assert.match(lifecycle, /migrationNetworkObservation='unobserved'/);
  assert.ok(lifecycle.indexOf('.loadHandoff()') < lifecycle.indexOf("Set-LabPhase 'root-add'"));
  assert.match(driver, /diagnostic\.loadHandoff\(\)/); assert.doesNotMatch(driver, /diagnostic\.runMigration\(/);
  assert.match(lifecycle, /isolationProven=\$false/); assert.match(lifecycle, /rejectedRequestCount/);
  const ps = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const file = path.join(__dirname, 'native-mixed-public-diagnostic.ps1').replaceAll("'", "''");
  execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `$t=$null;$e=$null;[void][Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$t,[ref]$e);if($e.Count){exit 1}`], { timeout: 15000 });
});
test('opt-in job preserves the old gate and orders public migration before controlled trust', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/windows-outgoing-017.yml'), 'utf8');
  const parts = workflow.split(/\r?\n  mixed-public-diagnostic:\r?\n/); assert.equal(parts.length, 2);
  assert.match(parts[0], /requireMigrationNetworkIsolation\(\)/);
  assert.match(parts[0], /github\.ref == 'refs\/heads\/validation\/windows-menu-merge-20261027' && !inputs\.mixed_public_diagnostic/);
  assert.match(parts[1], /inputs\.mixed_public_diagnostic && !inputs\.migrated/);
  for (const text of ['13147427412', '41458124135', '13141988162', '41446190810',
    'mixed_expected_source', 'mixed_expected_actor_id', 'windows-mixed-public-diagnostic.cjs --prepare']) assert.ok(workflow.includes(text), text);
  assert.ok(parts[1].indexOf('windows-mixed-public-diagnostic.cjs --migration') < parts[1].indexOf('native-mixed-public-diagnostic.ps1 -Outgoing017'));
  assert.ok(parts[1].indexOf('native-mixed-public-diagnostic.ps1 -Outgoing017') < parts[1].indexOf('windows-mixed-public-diagnostic.cjs --receipt'));
  assert.doesNotMatch(parts[1], /migrated-receipt|acceptance-binding\.json/);
});
test('actual driver-wait timeout reports unknown Hub cleanup and fails aggregate cleanup', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-mixed-public-diagnostic.ps1'), 'utf8');
  const start = source.indexOf('function Resolve-LabCleanupState('), end = source.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start);
  const loopStart = source.indexOf('    while (-not $driver.WaitForExit(200)) {');
  const loopEnd = source.indexOf('    $driverExitCode = $driver.ExitCode', loopStart);
  assert.ok(loopStart >= 0 && loopEnd > loopStart);
  const command = `${source.slice(start, end)}\n` + `
$driver=[pscustomobject]@{}; $driver | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($milliseconds) return $false }
$proxy=[pscustomobject]@{HasExited=$false}; $watcher=[pscustomobject]@{HasExited=$false}
$deadline=[DateTime]::UtcNow.AddSeconds(-1); $failed=$false
try { ${source.slice(loopStart, loopEnd)} } catch { $failed=$true }
$timeout=Resolve-LabCleanupState $true $false $true
$success=Resolve-LabCleanupState $true $true $true
$early=Resolve-LabCleanupState $false $false $true
$otherFailure=Resolve-LabCleanupState $true $true $false
@{failed=$failed;timeout=$timeout;success=$success;early=$early;otherFailure=$otherFailure}|ConvertTo-Json -Depth 4 -Compress`;
  const ps = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const result = JSON.parse(execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 15000 }).trim());
  assert.equal(result.failed, true); assert.equal(result.timeout.cleanupVerified, false);
  assert.equal(result.timeout.hubCleanupState, 'unknown'); assert.equal(result.timeout.hubCleanupUnknown, true);
  assert.equal(result.success.cleanupVerified, true); assert.equal(result.success.hubCleanupState, 'verified');
  assert.equal(result.early.cleanupVerified, true); assert.equal(result.early.hubCleanupState, 'not-started');
  assert.equal(result.otherFailure.cleanupVerified, false);
  assert.ok(source.indexOf('$driverStarted = $true', source.indexOf("Set-LabPhase 'driver-start'")) < source.indexOf('$driverRecord = Get-LabProcessRecord $driver', source.indexOf("Set-LabPhase 'driver-start'")));
});
test('driver start gate withholds all driver loading until identity and watcher registration', async t => {
  const source = fs.readFileSync(path.join(__dirname, 'native-mixed-public-diagnostic.ps1'), 'utf8');
  const match = source.match(/\$driverBootstrap = @'\r?\n([\s\S]*?)\r?\n'@/); assert.ok(match);
  const sequence = ["Set-LabPhase 'driver-start'", '$driver.Start()', '$driverRecord = Get-LabProcessRecord $driver',
    "Set-LabPhase 'driver-register'", "if ($registered.kind -cne 'lab-process-registered')", '$driverRegistered = $true',
    "$driver.StandardInput.WriteLine('START')", '$driver.StandardInput.Close()'];
  let previous = -1;
  for (const item of sequence) { const next = source.indexOf(item, previous + 1); assert.ok(next > previous, item); previous = next; }
  assert.match(source, /if \(\$driverStarted -and -not \$driverGateOpened\)[\s\S]*\$driver\.StandardInput\.Close\(\)/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-driver-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const driver = path.join(dir, 'driver.cjs'), marker = path.join(dir, 'driver-loaded');
  fs.writeFileSync(driver, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'loaded'); module.exports.main = async () => {};`);
  for (const input of ['', 'START', 'WRONG\n', 'START\nEXTRA']) {
    const result = spawnSync(process.execPath, ['-e', match[1], driver], { input, timeout: 5000, windowsHide: true });
    assert.notEqual(result.status, 0); assert.equal(fs.existsSync(marker), false, input);
  }
  for (const failure of ['identity-capture', 'watcher-registration']) {
    const proc = spawn(process.execPath, ['-e', match[1], driver], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(marker), false, failure);
    const exited = new Promise(resolve => proc.once('exit', (code, signal) => resolve({ code, signal })));
    proc.stdin.end();
    const outcome = await exited; assert.notEqual(outcome.code, 0); assert.equal(fs.existsSync(marker), false);
  }
  const approved = spawnSync(process.execPath, ['-e', match[1], driver], { input: 'START\r\n', timeout: 5000, windowsHide: true });
  assert.equal(approved.status, 0, approved.stderr.toString()); assert.equal(fs.readFileSync(marker, 'utf8'), 'loaded');
});
test('phase receipt accepts only the diagnostic scope and rejects claims or failed cleanup', () => {
  const mr = { ...migration.reportTemplate(sha), passed: true, nativeGuideAccepted: true,
    repeatStartupAccepted: true, settingsPreserved: true, cancelAccepted: true, installedResourcesVerified: true,
    policyRestored: true, nativeDecisions: [{}, {}], inputBinding: { ...handoff.input, harnessSource: sha },
    baselines: [{ product: 'Creator Hub', version: '0.1.12', installerSha256: '0cd8a4493dd9a5b77fbc5fe160582a2b2698fea43aedd9118b2d5b3bd3c51a18',
      executableSha256: '34c6f05548f469ac23b4faee7aa8355d5cca083c444c4f7b0942426a9c76a7ac' }] };
  const bytes = Buffer.from(JSON.stringify(mr));
  const beforeRoute = { schemaVersion: 1, descriptorSha256: config.runtime.baselineDescriptor, generation: 'a'.repeat(64) };
  const afterRoute = { schemaVersion: 1, descriptorSha256: config.runtime.targetDescriptor, generation: 'b'.repeat(64) };
  const report = { kind: diag.KIND, passed: true, publicDiscovery: null, publicNetworkAllowed: true, publicDiscoveryProven: false, labDiscovery: true, migratedContinuation: true,
    automaticRestart: true, cancelPreserved: true, outgoingConnectionSurvived: true, newConnectionVerified: true,
    restorationVerified: true, policyRestored: true, fixtureSettingsChecksPassed: true,
    migratedFixtureFilesUnchangedAfterDriverCleanup: true, activeRouteUnchangedAfterCancel: true,
    nativeUpdateAccepted: false, liveAiAcceptance: false, acceptanceOnly: false, releaseReady: false, changedMcpGenerationProven: false,
    migrationNetworkObserved: false, webViewContinuityProven: false, migrationEraConnectionProven: false, combinedAcceptance: false,
    initialCleanupUnverified: false, successorCleanupUnverified: false, automaticRouteTransitionProven: false,
    beforeRoute, preReviewRoute: beforeRoute, afterRoute, successorRouteAfterExplicitReview: afterRoute,
    successorRouteObservation: 'after-explicit-client-review',
    migrationPhase: { publicNetworkAllowed: true, publicDiscovery: 'unproven', networkObservation: 'unobserved', isolationProven: false },
    outgoingPhase: { controlledFeed: true, publicDiscovery: false }, sourceCommit: config.sourceCommit, baseline: config.baseline, pins: config.pins,
    lastTool: 'mcp', restore: true, restoredLastTool: 'mcp', beforePeVersion: [0,1,16,0], afterPeVersion: [0,1,17,0],
    migratedFixtureFilesChecked: 23, migrationRunId: '123', migrationRunAttempt: '1', migrationHarnessSource: sha,
    migrationReceipt: 'artifacts/native-suite-123/migration-016-report.json', migrationReportSha256: candidate.hash(bytes) };
  const life = { kind: 'lab-lifecycle-result', scenario: diag.KIND, actualScope: diag.KIND,
    lifecycleSucceeded: true, cleanupVerified: true, systemTlsVerified: true, labDiscovery: true, publicDiscovery: null, publicNetworkAllowed: true, publicDiscoveryProven: false,
    outgoingControlledFeed: true, migrationHandoffBeforeTrust: true, successorCleanupVerified: true, driverRegistered: true, driverGateOpened: true, hubCleanupState: 'verified', hubCleanupUnknown: false, isolationProven: false, liveAiAcceptance: false,
    productAcceptance: false, nativeAcceptanceTested: false, releaseReady: false, migrationNetworkObserved: false,
    webViewContinuityProven: false, migrationEraConnectionProven: false, combinedAcceptance: false,
    migrationNetworkObservation: 'unobserved', driverExitCode: 0, servedRouteCount: 5, rejectedRequestCount: 0 };
  const encoded = r => Buffer.from(JSON.stringify(r) + '\n');
  const result = diag.checkReceipt(report, bytes, encoded(life), config, env);
  assert.equal(result.diagnosticPassed, true); assert.equal(result.combinedAcceptance, false); assert.equal(result.releaseReady, false);
  assert.deepEqual(result.preReviewRoute, beforeRoute); assert.deepEqual(result.successorRouteAfterExplicitReview, afterRoute);
  assert.equal(result.successorRouteObservation, 'after-explicit-client-review'); assert.equal(result.automaticRouteTransitionProven, false);
  assert.deepEqual(diag.checkReceipt({ ...report, preReviewRoute: afterRoute }, bytes, encoded(life), config, env).preReviewRoute, afterRoute);
  assert.throws(() => require('./windows-outgoing-017.cjs').checkMigratedReceipt(report, [life], config, 'mcp-restore', bytes, env));
  for (const change of [{ passed: false }, { nativeUpdateAccepted: true }, { migrationNetworkObserved: true }, { publicDiscovery: true }, { publicDiscovery: false }, { publicDiscoveryProven: true },
    { migrationEraConnectionProven: true }, { webViewContinuityProven: true }, { combinedAcceptance: true },
    { migratedFixtureFilesUnchangedAfterDriverCleanup: false }, { activeRouteUnchangedAfterCancel: false },
    { initialCleanupUnverified: true }, { successorCleanupUnverified: true }, { automaticRouteTransitionProven: true },
    { preReviewRoute: null }, { preReviewRoute: { ...beforeRoute, schemaVersion: 2 } },
    { preReviewRoute: { ...beforeRoute, descriptorSha256: '0'.repeat(64) } },
    { preReviewRoute: { ...beforeRoute, generation: 'bad' } }, { preReviewRoute: { ...beforeRoute, generation: 'c'.repeat(64) } },
    { successorRouteAfterExplicitReview: beforeRoute }, { afterRoute: beforeRoute },
    { successorRouteObservation: 'automatic' }, { successorRouteObservation: undefined }])
    assert.throws(() => diag.checkReceipt({ ...report, ...change }, bytes, encoded(life), config, env));
  for (const change of [{ driverExitCode: 1 }, { driverExitCode: null }, { driverRegistered: false }, { driverGateOpened: false }, { publicDiscovery: true }, { publicDiscoveryProven: true }, { cleanupVerified: false }, { successorCleanupVerified: false }, { hubCleanupState: 'unknown' }, { hubCleanupUnknown: true }, { migrationHandoffBeforeTrust: false },
    { rejectedRequestCount: 1 }, { combinedAcceptance: true }])
    assert.throws(() => diag.checkReceipt(report, bytes, encoded({ ...life, ...change }), config, env));
});
