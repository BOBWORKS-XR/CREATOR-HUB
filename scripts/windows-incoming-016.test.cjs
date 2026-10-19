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

const candidatePath = [path.join(root, 'artifacts/unified/windows-016-setup-repair-20261019/installer.exe'),
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
    installerSha256: incoming.TARGET.installer, executableSha256: incoming.TARGET.exe, settingsPreserved: true, pluginsRemoved: true, signedUpdateAccepted: false };
  incoming.checkReceipt(fresh, 'fresh');
  assert.throws(() => incoming.checkReceipt({ ...fresh, migrationAccepted: true }, 'fresh'));
  assert.throws(() => incoming.checkReceipt({ ...fresh, settingsPreserved: false }, 'fresh'));
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
  assert.match(workflow, /workflow_dispatch:/); assert.match(workflow, /options: \[fresh, guarded, incoming\]/);
  assert.match(workflow, /push:\s+branches: \[validation\/windows-incoming-016\]/);
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
});

test('native lifecycle parses in an available bounded PowerShell process', t => {
  const file = path.join(__dirname, 'native-self-update-lab.ps1').replaceAll("'", "''");
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    `$t=$null;$e=$null;[void][Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$t,[ref]$e);if($e.Count){$e|Out-String;exit 1}`],
  { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (['ENOENT', 'ETIMEDOUT'].includes(result.error?.code)) return t.skip(`PowerShell parser unavailable: ${result.error.code}; native parse is not accepted`);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('current finite target refuses the superseded development16 bytes', () => {
  assert.equal(incoming.TARGET.productSource, 'f9f0e1e5cb27b3ae5178c8aac16429e83ba34593');
  assert.equal(incoming.TARGET.bytes, 37980864);
  assert.throws(() => incoming.validatePins({ ...pins(), installer: '7229cfcf919dc3a9e27a459fd482cbbe059fd54caa9ad379b2a75c8baa113a20',
    executable: '7ef27351edefe4545d3e530e8d5c51e7eb3092e7cc7b20498591bfe7456c2389' }));
});

test('guarded installer receipt cannot stand in for GUI, signed updater or migration acceptance', () => {
  const report = { passed: true, releaseReady: false, scope: 'exact-public14-to-direct16-guarded-nsis-only',
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
