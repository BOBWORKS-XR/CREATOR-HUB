const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const incoming = require('./windows-incoming-016.cjs');
const feed = require('./self-update-lab-feed.cjs');
const outgoing = require('./native-unified-outgoing-target.cjs');
const root = path.resolve(__dirname, '..');
const runner = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
  HTTPS_PROXY: 'http://127.0.0.1:34567', HTTP_PROXY: 'http://127.0.0.1:34567', NO_PROXY: '127.0.0.1,localhost,::1' };
const pins = () => ({ descriptor: 'a'.repeat(64), descriptorSignature: 'b'.repeat(64), manifest: 'c'.repeat(64),
  installer: incoming.TARGET.installer, executable: incoming.TARGET.exe });
const config = () => ({ schemaVersion: 1, kind: incoming.KIND, baselineVersion: '0.1.14', targetVersion: '0.1.16', directory: path.resolve('missing-signed-inputs'), pins: pins() });

test('incoming16 is finite and does not repurpose public12 or private15', () => {
  incoming.validateConfig(config());
  assert.equal(feed.baselineFor('0.1.16').version, '0.1.12');
  assert.equal(outgoing.TARGET.version, '0.1.15');
  assert.equal(incoming.BASELINE.installer, feed.UNIFIED_OUTGOING_BASELINE.installer);
  for (const [field, value] of [['baselineVersion', '0.1.12'], ['baselineVersion', '0.1.15'], ['targetVersion', '0.1.15'],
    ['targetVersion', '0.1.17'], ['kind', outgoing.KIND], ['directory', 'relative'], ['schemaVersion', 2]]) {
    assert.throws(() => incoming.validateConfig({ ...config(), [field]: value }));
  }
  assert.throws(() => incoming.validateConfig({ ...config(), baseline: 'override' }));
  for (const field of ['installer', 'executable']) assert.throws(() => incoming.validateConfig({ ...config(), pins: { ...pins(), [field]: 'd'.repeat(64) } }));
  assert.throws(() => incoming.assertBaselineBytes(Buffer.from('pretend14'), Buffer.from('pretend14')));
});

test('local and foreign-proxy refusal precedes configuration, installer or credential inspection', () => {
  for (const env of [{}, { ...runner, GITHUB_ACTIONS: 'false' }, { ...runner, RUNNER_ENVIRONMENT: 'self-hosted' }]) {
    assert.throws(() => incoming.selectLab('missing', {}, null, env), /disposable/);
  }
  for (const HTTPS_PROXY of ['http://foreign:34567', 'http://user:pass@127.0.0.1:34567', 'http://127.0.0.1:34567/extra']) {
    assert.throws(() => incoming.selectLab('missing', {}, null, { ...runner, HTTPS_PROXY }));
  }
  assert.throws(() => incoming.selectLab('missing', {}, {}, runner));
  for (const name of ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS']) assert.throws(() => incoming.assertProxy({ ...runner, [name]: 'unsafe' }));
  const result = spawnSync(process.execPath, [path.join(__dirname, 'native-windows-016-fresh.cjs'), 'MUST-NOT-INSPECT'],
    { env: { ...process.env, GITHUB_ACTIONS: 'false' }, encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /disposable GitHub-hosted Windows runner/);
  assert.doesNotMatch(result.stderr, /ENOENT|MUST-NOT-INSPECT/);
});

const candidatePath = [path.join(root, 'artifacts/menu-merge-20261027/settings-build-v3', incoming.TARGET.asset),
  path.join(root, 'artifacts/incoming-016/candidate', incoming.TARGET.asset)].find(file => fs.existsSync(file));
test('actual pinned NSIS binds the new public14 five-route contract, not source-only or synthetic installer bytes', { skip: !candidatePath }, () => {
  incoming.installer(candidatePath);
  const installer = fs.readFileSync(candidatePath);
  // Unsigned metadata envelopes test routing only; native production-key verification is mandatory later.
  const descriptorSignature = Buffer.from('untrusted comment: pure incoming16 fixture, not a production signature\nRWQfixture\n');
  const descriptor = Buffer.from(JSON.stringify({ schemaVersion: 1, appId: 'creator-hub', version: '0.1.16', platform: 'windows', architecture: 'x86_64',
    packageType: 'nsis', assetName: incoming.TARGET.asset, byteLength: installer.length, sha256: incoming.TARGET.installer,
    executableSha256: incoming.TARGET.exe, identityProtocol: 0, lifecycleProtocol: 0, installerProtocol: 1, minHubVersion: '0.1.14' }));
  const manifest = Buffer.from(JSON.stringify({ version: '0.1.16', platforms: { 'windows-x86_64': {
    url: `https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.16/${incoming.TARGET.asset}`,
    signature: descriptorSignature.toString('base64') } } }));
  const input = { targetVersion: '0.1.16', installer, descriptor, descriptorSignature, manifest,
    pins: { ...pins(), descriptor: incoming.hash(descriptor), descriptorSignature: incoming.hash(descriptorSignature), manifest: incoming.hash(manifest) } };
  const contract = feed.createIncoming016Contract(input);
  assert.deepEqual(contract.baseline, incoming.BASELINE); assert.equal(contract.routes.length, 5);
  const scope = incoming.discoveryScope(contract);
  assert.equal(scope.previousStable, '0.1.14'); assert.equal(scope.publicDiscovery, false); assert.equal(scope.releaseReady, false);
  const state = feed.newState();
  assert.equal(feed.labReport(contract, state).actualScope.kind, incoming.KIND);
  assert.throws(() => feed.createContract(input), /intermediate Hub/, 'Historical public12 factory remains closed to a minHub14 target');
  assert.throws(() => feed.createUnifiedOutgoingContract(input), /0.1.15/);
  for (const mutate of [i => i.targetVersion = '0.1.15', i => i.installer = Buffer.from('source-only fixture'),
    i => i.pins.executable = outgoing.TARGET.pins.executable, i => i.pins.installer = 'd'.repeat(64),
    i => i.descriptorSignature = Buffer.from('changed signature')]) {
    const changed = { ...input, pins: { ...input.pins } }; mutate(changed); assert.throws(() => feed.createIncoming016Contract(changed));
  }
});

test('fresh/guarded pre-npm installer admission loads only built-ins and local input reader', { skip: !candidatePath }, () => {
  const source = `const Module=require('node:module'); const load=Module._load;
    Module._load=function(name,...args){
      if(!name.startsWith('node:')&&!name.startsWith('./')&&!require('node:path').isAbsolute(name)) throw Error('Dependency loaded before npm: '+name);
      return load.call(this,name,...args);
    };
    require(process.argv[1]).installer(process.argv[2]);`;
  const result = spawnSync(process.execPath, ['-e', source, path.join(__dirname, 'windows-incoming-016.cjs'), path.resolve(candidatePath)],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('baseline and target receipt cannot substitute build, transport, old15 or migration acceptance', () => {
  const receipt = { passed: true, policyRestored: true, releaseReady: false, from: incoming.BASELINE,
    feed: incoming.productProvenance(),
    to: { version: '0.1.16', installer: incoming.TARGET.installer, exe: incoming.TARGET.exe },
    selfUpdateTested: true, directHubUpdateTested: true, managedRouteReconnectTested: true, pluginsRemoved: true,
    labDiscovery: true, publicDiscovery: false };
  incoming.checkReceipt(receipt, 'incoming');
  for (const field of ['passed', 'policyRestored', 'selfUpdateTested', 'directHubUpdateTested', 'managedRouteReconnectTested', 'pluginsRemoved']) {
    assert.throws(() => incoming.checkReceipt({ ...receipt, [field]: false }, 'incoming'));
  }
  assert.throws(() => incoming.checkReceipt({ ...receipt, releaseReady: true }, 'incoming'));
  assert.throws(() => incoming.checkReceipt({ ...receipt, from: { ...incoming.BASELINE, version: '0.1.12' } }, 'incoming'));
  const fresh = { passed: true, policyRestored: true, releaseReady: false, freshInstallAccepted: true, migrationAccepted: false,
    ...incoming.productProvenance(),
    formattingEquivalentSettingsAccepted: true, manualNormalRestartAccepted: true, signedAutomaticRestartAccepted: false,
    normalCloses: [{ pid: 100, exitCode: 0 }, { pid: 200, exitCode: 0 }],
    installerSha256: incoming.TARGET.installer, executableSha256: incoming.TARGET.exe, settingsPreserved: true, pluginsRemoved: true, signedUpdateAccepted: false };
  incoming.checkReceipt(fresh, 'fresh');
  assert.throws(() => incoming.checkReceipt({ ...fresh, migrationAccepted: true }, 'fresh'));
  assert.throws(() => incoming.checkReceipt({ ...fresh, settingsPreserved: false }, 'fresh'));
  for (const change of [{ formattingEquivalentSettingsAccepted: false }, { manualNormalRestartAccepted: false },
    { signedAutomaticRestartAccepted: true }, { normalCloses: [] }, { normalCloses: [{ pid: 100, exitCode: 0 }] },
    { normalCloses: [{ pid: 100, exitCode: 0 }, { pid: 100, exitCode: 0 }] },
    { normalCloses: [{ pid: 100, exitCode: 0 }, { pid: 200, exitCode: 1 }] }]) {
    assert.throws(() => incoming.checkReceipt({ ...fresh, ...change }, 'fresh'));
  }
});

test('fresh CDP must belong to the exact owned Hub process tree, never a foreign listener or replaced image', () => {
  const executable = 'C:\\fixture\\creator-hub.exe';
  const state = { processes: [{ ProcessId: 100, ParentProcessId: 90, ExecutablePath: executable },
    { ProcessId: 101, ParentProcessId: 100, ExecutablePath: 'C:\\fixture\\msedgewebview2.exe' }],
  listeners: [{ LocalAddress: '127.0.0.1', OwningProcess: 101 }] };
  incoming.assertOwnedDebugging(state, 100, executable);
  for (const mutate of [s => s.listeners[0].OwningProcess = 999, s => s.listeners[0].LocalAddress = '0.0.0.0',
    s => s.processes[0].ExecutablePath = 'C:\\foreign\\creator-hub.exe', s => s.processes[1].ParentProcessId = 999,
    s => s.listeners = []]) {
    const changed = structuredClone(state); mutate(changed); assert.throws(() => incoming.assertOwnedDebugging(changed, 100, executable));
  }
});

test('new native lane is explicit/manual, read-only, data-bound and tests before native execution', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/windows-incoming-016.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/); assert.match(workflow, /options: \[fresh, guarded, incoming, migration\]/);
  assert.match(workflow, /push:\s+branches: \[validation\/windows-menu-merge-20261027\]/);
  assert.match(workflow, /acceptance:\s+if: github\.repository == 'BOBWORKS-XR\/CREATOR-HUB' && github\.event_name == 'workflow_dispatch'/);
  assert.doesNotMatch(workflow, /contents: write|pull_request:|macos|cargo |build:unified|signer sign|gh release|TAURI_SIGNING|rejectUnauthorized|ignore-certificate/);
  for (const expected of ['artifact.digest', 'archive_sha256', 'artifact.workflow_run.id', 'same-repository run',
    'persist-credentials: false', 'servedRouteCount -ne 5', 'rejectedRequestCount -ne 0', 'cleanupVerified -ne $true',
    'checkReceipt', '-Incoming016']) assert.ok(workflow.includes(expected));
  assert.ok(workflow.indexOf('node --test') < workflow.indexOf('run: node scripts/native-windows-016-fresh.cjs'));
  assert.ok(workflow.indexOf('inspect-installer $directory') < workflow.indexOf('- run: npm ci'));
  assert.ok(workflow.indexOf('node scripts/windows-incoming-016.cjs $env:MODE') > workflow.indexOf('- run: npm --prefix modules/mcp ci'));
  assert.ok(workflow.indexOf('node --test') < workflow.indexOf('./scripts/native-self-update-lab.ps1 -Incoming016'));
  const lifecycle = fs.readFileSync(path.join(__dirname, 'native-self-update-lab.ps1'), 'utf8');
  assert.match(lifecycle, /\[switch\]\$Incoming016/);
  assert.match(lifecycle, /if \(\$Incoming016\) \{[\s\S]*?Resolve-UnifiedOutgoingLabBaseline/);
  assert.match(lifecycle, /windows-incoming-016\.cjs/);
  assert.match(lifecycle, /Incoming16 cannot be combined with a historical scenario/);
});

test('fresh driver keeps real install/hash/terms/direct-service/normal-close/preservation checks and refuses migration claims', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-windows-016-fresh.cjs'), 'utf8');
  assert.ok(source.indexOf('disposable GitHub-hosted Windows runner') < source.indexOf("require('node:fs')"));
  for (const contract of ["candidate.installer(process.argv[2])", "['/S', '/NS']", 'candidate.TARGET.exe',
    'direct.checkPages', 'direct.settingsSnapshot', 'runtime.exitCode, null', "native('close')", 'child.exitCode, 0',
    'migrationAccepted: false', 'signedUpdateAccepted: false', 'releaseReady: false', "policy('Restore')", "flag: 'wx'"]) assert.ok(source.includes(contract));
  assert.doesNotMatch(source, /taskkill|Stop-Process|\.kill\(|rejectUnauthorized|ignore-certificate|auth\.json/);
  assert.ok(source.includes('`native-suite-${Date.now()}`'), 'Use the exact existing owned policy-helper namespace');
  const policy = fs.readFileSync(path.join(__dirname, 'native-webview-policy.ps1'), 'utf8');
  const ownedFolder = new RegExp(policy.match(/-notmatch '([^']+)'/)[1]);
  assert.equal(ownedFolder.test('native-suite-1792442915860'), true);
  assert.equal(ownedFolder.test('native-016-fresh-1792442915860'), false);
  assert.equal(ownedFolder.test('native-suite-016-fresh-1792442915860'), false);
});

test('native lifecycle parses in an available bounded PowerShell process', t => {
  const file = path.join(__dirname, 'native-self-update-lab.ps1').replaceAll("'", "''");
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    `$t=$null;$e=$null;[void][Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$t,[ref]$e);if($e.Count){$e|Out-String;exit 1}`],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (['ENOENT', 'ETIMEDOUT'].includes(result.error?.code)) return t.skip(`PowerShell parser unavailable: ${result.error.code}; native parse is not accepted`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('seeded fresh migration offer must be explicitly deferred before page navigation', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-windows-016-fresh.cjs'), 'utf8');
  const offered = source.indexOf("page.locator('#convergence-dialog').waitFor({ state: 'visible' })");
  const deferred = source.indexOf("page.locator('#convergence-later').click()", offered);
  const hidden = source.indexOf("page.locator('#convergence-dialog').waitFor({ state: 'hidden' })", deferred);
  assert.ok(offered > 0 && offered < deferred && deferred < hidden && hidden < source.indexOf('report.services = await inspectPages(first)'));
  assert.doesNotMatch(source, /convergence-dialog[^\n]*\|\|/);
  assert.ok(source.indexOf('ownedPage = true') > source.indexOf('candidate.assertOwnedDebugging'));
  assert.ok(source.includes("path.join(out, 'failure.png')"));
});

test('fresh current compact JSON and legacy pretty CRLF are equal without identical bytes or normalization', () => {
  const { current, legacy } = incoming.freshSettingsBytes();
  assert.ok(Buffer.isBuffer(current) && Buffer.isBuffer(legacy));
  assert.notDeepEqual(current, legacy); assert.notEqual(incoming.hash(current), incoming.hash(legacy));
  assert.deepEqual(JSON.parse(current), JSON.parse(legacy));
  assert.doesNotMatch(current.toString(), /[\r\n]/);
  assert.match(legacy.toString(), /^\{\r\n  "channels":/);
  assert.ok(legacy.toString().endsWith('}\r\n'));
  assert.doesNotMatch(legacy.toString().replace(/\r\n/g, ''), /[\r\n]/);
  assert.equal(JSON.parse(current).incoming16_unknown.keep, 'exact bytes; no merge or reset');
  const again = incoming.freshSettingsBytes();
  assert.deepEqual(again, { current, legacy });
});

test('fresh restart repeats exact-image and CDP ownership checks before semantic navigation in the new process', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-windows-016-fresh.cjs'), 'utf8');
  const launch = source.slice(source.indexOf('async function launchOwned()'), source.indexOf('async function inspectPages('));
  assert.ok(launch.indexOf('ownedPage = false') < launch.indexOf('child = spawn(hub'));
  assert.ok(launch.indexOf('candidate.hash(fs.readFileSync(hub)), candidate.TARGET.exe') < launch.indexOf('child = spawn(hub'));
  assert.ok(launch.indexOf('candidate.assertOwnedDebugging') < launch.indexOf('chromium.connectOverCDP'));
  assert.equal((launch.match(/candidate\.assertOwnedDebugging/g) || []).length, 2);
  assert.ok(launch.lastIndexOf('candidate.assertOwnedDebugging') < launch.indexOf('ownedPage = true'));
  const first = source.indexOf('const first = await launchOwned()'), second = source.indexOf('const second = await launchOwned()');
  const firstClose = source.indexOf('await closeOwned()', first), secondClose = source.indexOf('await closeOwned()', second);
  assert.ok(first > 0 && first < firstClose && firstClose < second && second < secondClose);
  assert.ok(secondClose < source.indexOf('report.manualNormalRestartAccepted = true'));
  assert.ok(source.includes("assert.notEqual(child.pid, report.normalCloses[0].pid"));
  assert.ok(source.includes("await inspectPages(second, 'reopened-')"));
  assert.ok(source.includes('showApp: app => candidate.showPage(page, app)'));
  assert.ok(source.includes("await candidate.showPage(page, 'hub')"));
  assert.ok(source.includes('for (const [file, bytes] of seededSettings) assert.deepEqual(fs.readFileSync(file), bytes'));
  assert.ok(source.includes("native('close'); await retry(() => assert.equal(child.exitCode, 0))"));
  assert.ok(source.includes('await browser.close(); browser = null; page = null;'));
  assert.match(source, /signedAutomaticRestartAccepted: false/);
  assert.doesNotMatch(source, /signedAutomaticRestartAccepted\s*=\s*true|waitForTimeout|force:\s*true|dispatchEvent/);
});

test('current finite target binds dirty build inputs separately from associated snapshot and rejects old16', () => {
  assert.equal(incoming.TARGET.productSource, '2a80935315bd6fae5d305e387ce38ac6bb37c32e');
  assert.equal(incoming.TARGET.bytes, 38224253);
  assert.equal(incoming.BUILD_INPUT.builtFromDirtyWorktree, true);
  assert.equal(incoming.BUILD_INPUT.sourceSnapshotBuilt, false);
  assert.equal(incoming.BUILD_INPUT.buildSourceBase, 'cf6c2db2a4260e02206c91133878ff82bf3bb084');
  assert.equal(incoming.BUILD_INPUT.buildInputDigest, '874a1ca81bbbc22363705122ae9ba456c0d8c707f75bdc84d697e4c1acb4da58');
  assert.equal(incoming.BUILD_INPUT.buildSourceFileCount, 781);
  assert.deepEqual(incoming.BUILD_INPUT.sourceSnapshotTestOnlyDifferences, []);
  assert.throws(() => incoming.validatePins({ ...pins(), installer: '390b63dee018c8b9aa0b0039d086c2f697df69ddd68d3ebf96359b4d40bae075',
    executable: 'a0953a166b2544ea0137bf93a5674db08a298e5412f17eb852111e1623fa602c' }));
  assert.throws(() => incoming.validatePins({ ...pins(), installer: 'f0092e056f7b4245d10350b7954c3dbe5e5356f2e340143d0aefb80078672bc7',
    executable: '8e140ba93190bb717ea30587dbb9dcf4e1c40bf7c1d08ca06b2da947e3b6d30b' }));
  assert.throws(() => incoming.validatePins({ ...pins(), installer: '7229cfcf919dc3a9e27a459fd482cbbe059fd54caa9ad379b2a75c8baa113a20',
    executable: '7ef27351edefe4545d3e530e8d5c51e7eb3092e7cc7b20498591bfe7456c2389' }));
});

test('single-guide receipt requires exact payload, cancellation, restart and preservation without broader acceptance', () => {
  const report = { ...require('./native-windows-016-migration.cjs').reportTemplate('a'.repeat(40)),
    passed: true, policyRestored: true, nativeGuideAccepted: true, repeatStartupAccepted: true,
    settingsPreserved: true, cancelAccepted: true, installedResourcesVerified: true,
    nativeDecisions: [{ name: 'Not now' }, { name: 'Move to Hub' }] };
  incoming.checkReceipt(report, 'migration');
  for (const field of ['policyRestored', 'nativeGuideAccepted', 'repeatStartupAccepted', 'settingsPreserved', 'cancelAccepted', 'installedResourcesVerified']) {
    assert.throws(() => incoming.checkReceipt({ ...report, [field]: false }, 'migration'));
  }
  for (const field of ['migrationAccepted', 'signedUpdateAccepted', 'liveAiAppAccepted', 'crashRecoveryAccepted', 'backupBeforeEveryWriteAccepted', 'userMachineUsed', 'releaseReady']) {
    assert.throws(() => incoming.checkReceipt({ ...report, [field]: true }, 'migration'));
  }
  assert.throws(() => incoming.checkReceipt({ ...report, nativeDecisions: [] }, 'migration'));
  assert.throws(() => incoming.checkReceipt({ ...report, executableSha256: 'a'.repeat(64) }, 'migration'));
});

test('guarded installer receipt cannot stand in for GUI, signed updater or migration acceptance', () => {
  const report = { passed: true, releaseReady: false, scope: 'exact-public14-to-direct16-guarded-nsis-only',
    ...incoming.productProvenance(),
    installerScope: 'guarded-nsis-update-default-location-no-msi', from: incoming.BASELINE,
    installerSha256: incoming.TARGET.installer, executableSha256: incoming.TARGET.exe,
    settingsPreserved: true, guardedInstallerAccepted: true, nativeGuiAccepted: false, migrationAccepted: false, signedUpdateAccepted: false };
  incoming.checkReceipt(report, 'guarded');
  for (const field of ['settingsPreserved', 'guardedInstallerAccepted']) assert.throws(() => incoming.checkReceipt({ ...report, [field]: false }, 'guarded'));
  for (const field of ['nativeGuiAccepted', 'migrationAccepted', 'signedUpdateAccepted']) assert.throws(() => incoming.checkReceipt({ ...report, [field]: true }, 'guarded'));
  assert.throws(() => incoming.checkReceipt(report, 'incoming'));
  const source = fs.readFileSync(path.join(__dirname, 'native-windows-016-guarded.cjs'), 'utf8');
  assert.ok(source.indexOf('explicit disposable GitHub-hosted Windows lane') < source.indexOf("require('node:fs')"));
  for (const required of ["['/UPDATE', '/S', '/NS']", 'candidate.BASELINE.exe', 'candidate.TARGET.exe', 'assert.deepEqual(registrations()', 'flag: \'wx\'']) assert.ok(source.includes(required));
  assert.doesNotMatch(source, /taskkill|Stop-Process|\.kill\(|rejectUnauthorized|auth\.json/);
  const result = spawnSync(process.execPath, [path.join(__dirname, 'native-windows-016-guarded.cjs'), 'MUST-NOT-READ'],
    { env: { ...process.env, GITHUB_ACTIONS: 'false' }, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /explicit disposable GitHub-hosted Windows lane/);
  assert.doesNotMatch(result.stderr, /ENOENT|MUST-NOT-READ/);
});

test('reviewed source provenance cannot be replaced by harness HEAD or a claim the snapshot was built', () => {
  const report = { ...require('./native-windows-016-migration.cjs').reportTemplate('a'.repeat(40)), passed: true,
    policyRestored: true, nativeGuideAccepted: true, repeatStartupAccepted: true, settingsPreserved: true,
    cancelAccepted: true, installedResourcesVerified: true, nativeDecisions: [{}, {}] };
  incoming.checkReceipt(report, 'migration');
  for (const change of [{ productSource: report.testSource }, { sourceSnapshotBuilt: true }, { builtFromDirtyWorktree: false },
    { buildInputDigest: 'b'.repeat(64) }, { sourceSnapshotTestOnlyDifferences: [{ path: 'src-tauri/src/convergence_profiles_tests.rs' }] }]) assert.throws(() => incoming.checkReceipt({ ...report, ...change }, 'migration'));
});

test('current navigation uses semantic Open menu and text-only Home/MCP/Setup roles without timing overrides', async () => {
  for (const [feature, label] of [['hub', 'Home Projects and updates'], ['mcp', 'MCP AI bridge for Unity Ready'],
    ['setup', 'Setup / Repair Unity + Creator SDK project setup and repair Ready']]) {
    const calls = [];
    const page = { getByRole(role, options) {
      calls.push([role, options]);
      if (role === 'button') return { async click() { assert.equal(options.name, 'Open menu'); assert.equal(options.exact, true); } };
      assert.equal(role, 'navigation'); assert.equal(options.name, 'Creator tools');
      return { getByRole(nestedRole, nestedOptions) {
        assert.equal(nestedRole, 'button'); assert.match(label, nestedOptions.name);
        assert.doesNotMatch('Download latest Creator Works MCP', nestedOptions.name);
        return { async click() { calls.push('selected'); } };
      } };
    } };
    await incoming.showPage(page, feature); assert.equal(calls.at(-1), 'selected');
  }
  await assert.rejects(incoming.showPage({}, 'plugins'));
});

test('local frozen v3 inventory, source association, manifest and extracted payload match the reviewed binding when present', { skip: !candidatePath?.includes('settings-build-v3') }, () => {
  const directory = path.dirname(candidatePath), before = JSON.parse(fs.readFileSync(path.join(directory, 'before.json')));
  assert.equal(incoming.hash(Buffer.from(JSON.stringify(before.sources))), incoming.BUILD_INPUT.buildInputDigest);
  assert.equal(before.sources.length, incoming.BUILD_INPUT.buildSourceFileCount); assert.equal(before.source, incoming.BUILD_INPUT.buildSourceBase);
  assert.equal(incoming.hash(fs.readFileSync(path.join(directory, 'app/creator-hub.exe'))), incoming.TARGET.exe);
  const snapshot = JSON.parse(fs.readFileSync(path.join(directory, 'product-snapshot.json')));
  assert.equal(snapshot.sourceSnapshot, incoming.TARGET.productSource);
  assert.equal(snapshot.tree, '9200b9fee8300061859a5068cdb0a45e5f96252a');
  assert.equal(snapshot.buildInputManifestSha256, incoming.BUILD_INPUT.buildInputDigest);
  assert.equal(snapshot.builtFromDirtyWorktree, true); assert.equal(snapshot.snapshotBuilt, false);
  assert.deepEqual(snapshot.testOnlyDifferences, incoming.BUILD_INPUT.sourceSnapshotTestOnlyDifferences);
  const receipt = JSON.parse(fs.readFileSync(path.join(directory, 'build-receipt.json')));
  const manifestBytes = fs.readFileSync(path.join(directory, 'stage/builtin-manifest.json'));
  assert.equal(receipt.payloadManifestSha256, '5edce3753928cce0dfaaa5a42e87d4af9c0231469ae0845925f55942d5b3b472');
  assert.equal(incoming.hash(manifestBytes), receipt.payloadManifestSha256);
  const manifest = JSON.parse(manifestBytes);
  const plan = require('./native-windows-016-migration.cjs').inspectInstalledResources(path.join(directory, 'app'));
  assert.deepEqual(plan.modules.mcp.files, manifest.modules.mcp.files);
  assert.deepEqual(plan.modules.setup.files, manifest.modules.setup.files);
  assert.deepEqual(plan.managedRouting.files, manifest.managedRouting.files);
});
