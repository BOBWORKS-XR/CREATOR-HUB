'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const productionTarget = require('./windows-outgoing-019-target.cjs');
const productionInput = require('./windows-outgoing-019-input.cjs');
const direct = require('./native-outgoing-direct-019.cjs');
const retention = require('./sdk-retention-023.cjs');
const hash = productionTarget.hash;
const windowsOnly = { skip: process.platform !== 'win32' };

// Private module instances keep synthetic pins out of production admission and the require cache.
function isolated(name, overrides) {
  const filename = path.join(__dirname, name), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(__dirname);
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = name => Object.hasOwn(overrides, name) ? overrides[name] : originalRequire(name);
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
  return loaded.exports;
}
function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { flag: 'wx' });
}
function fixture(t, { caseName = 'setup-restore', existingView = false, pin } = {}) {
  const artifacts = path.resolve(__dirname, '../artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  const root = path.join(artifacts, `native-suite-${process.hrtime.bigint()}`);
  fs.mkdirSync(root);
  t.after(() => {
    assert.equal(path.dirname(root), artifacts); assert.match(path.basename(root), /^native-suite-[0-9]+$/);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const binding = structuredClone(require('./fixtures/windows-outgoing-019-test-fixture.cjs').binding);
  binding.target.source = { ...productionTarget.EXPECTED_TARGET_SOURCE };
  binding.target.privateRelease.source = binding.target.source.commit;
  binding.fixtureQualification.source = { ...binding.target.source };
  const payloads = {};
  for (const [name, item] of [['baseline', binding.baseline], ['target', binding.target]]) {
    const data = Object.fromEntries(productionTarget.RESOURCE_PATHS.map(file => [file, Buffer.from(`SYNTHETIC ${name} ${file}\n`)]));
    data['routing/router.json'] = Buffer.from(JSON.stringify({ schemaVersion: 1, product: 'com.creatorworks.hub.mcp-router',
      platform: 'windows', arch: 'x86_64', protocol: 1, ...(name === 'target' ? { storeBinding: 2 } : {}),
      sha256: hash(data['routing/creator-hub-mcp-router.exe']) }));
    data['routing/runtime.json'] = Buffer.from(JSON.stringify({ hubVersion: item.version }));
    for (const part of [item.manifest.modules.mcp, item.manifest.modules.setup, item.manifest.managedRouting]) {
      for (const file of Object.keys(part.files)) part.files[file] = hash(data[file]);
    }
    item.generation = productionTarget.generation(item.manifest.modules.mcp);
    const executable = Buffer.from(`SYNTHETIC ${name} Hub, not executable\n`);
    item.executable = { bytes: executable.length, sha256: hash(executable) };
    payloads[name] = { data, executable };
  }
  const target = isolated('windows-outgoing-019-target.cjs', { './fixtures/windows-outgoing-019-binding.json': binding });
  const input = isolated('windows-outgoing-019-input.cjs', { './windows-outgoing-019-target.cjs': target });
  const config = target.configFor(path.join(root, 'inputs'));
  const profile = { home: path.join(root, 'profile'), local: path.join(root, 'profile/AppData/Local'),
    roaming: path.join(root, 'profile/AppData/Roaming') };
  const oldRoute = target.managedLocations(profile.local, '0.1.22', profile.home);
  const newRoute = target.managedLocations(profile.local, '0.1.23', profile.home);
  const active = item => ({ schemaVersion: 1, descriptorSha256: item.manifest.managedRouting.files['routing/runtime.json'],
    generation: item.generation });
  for (const [name, route] of [['baseline', oldRoute], ['target', newRoute]]) {
    const item = binding[name], data = payloads[name].data;
    write(route.active, JSON.stringify(active(item)));
    for (const file of Object.keys(item.manifest.modules.mcp.files)) write(path.join(route.payload, file), data[file]);
    for (const file of Object.keys(item.manifest.managedRouting.files)) {
      const destination = file.includes('runtime.') ? path.join(route.root, 'descriptors', active(item).descriptorSha256)
        : path.join(route.root, route.router);
      write(path.join(destination, path.basename(file)), data[file]);
    }
  }
  const installed = path.join(profile.local, 'Creator Hub');
  write(path.join(installed, 'creator-hub.exe'), payloads.target.executable);
  for (const [file, bytes] of Object.entries(payloads.target.data)) write(path.join(installed, 'modules', file), bytes);
  const [lastTool, restoreText] = target.CASES[caseName], restore = restoreText === 'true';
  const selectedPath = path.join(profile.home, '.claude.json');
  const oldPath = path.join(profile.home, '.gemini/config/mcp_config.json');
  const currentSettings = path.join(profile.roaming, 'creator-works-mcp/launcher-config.json');
  const oldSettings = path.join(profile.roaming, 'banter-mcp/launcher-config.json');
  write(currentSettings, retention.settings(lastTool, restore));
  write(oldSettings, retention.settings(lastTool, restore).replaceAll('\n', '\r\n'));
  const review = direct.reviewedSettings(currentSettings, newRoute.base);
  const canonicalSettings = JSON.stringify(JSON.parse(review.bytes), (key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(name => [name, value[name]])) : value);
  write(review.path, JSON.stringify({ ...JSON.parse(review.bytes), _creator_hub_view: {
    source: review.source, sha256: hash(canonicalSettings) } }));
  const before = { mcpServers: { 'creator-works': { command: oldRoute.command, args: [],
    env: { CREATOR_WORKS_CONFIG_OWNER: 'creator-hub-v1' }, disabled: false }, other: { command: 'keep' } },
    preferences: { outgoingSentinel: 'keep' } };
  if (pin) before.mcpServers['creator-works'].env[pin] = oldSettings;
  const after = structuredClone(before);
  after.mcpServers['creator-works'].command = newRoute.command;
  after.mcpServers['creator-works'].env.CREATOR_WORKS_LAUNCHER_CONFIG = pin ? oldSettings : review.path;
  const beforeBytes = Buffer.from(JSON.stringify(before, null, 2) + '\n');
  const afterBytes = Buffer.from(JSON.stringify(after, null, 2) + '\n');
  const oldBytes = Buffer.from(JSON.stringify({ mcpServers: { 'creator-works': { command: oldRoute.command, args: [],
    env: { CREATOR_WORKS_CONFIG_OWNER: 'creator-hub-v1', CREATOR_WORKS_LAUNCHER_CONFIG: oldSettings }, disabled: false } },
    outgoingSentinel: 'keep-old' }, null, 2) + '\r\n');
  write(selectedPath, afterBytes); write(oldPath, oldBytes);
  const capture = (name, file, bytes = direct.readEvidence(file)) => {
    const saved = path.join(root, name); write(saved, bytes);
    return { file, capture: saved, bytes: bytes.length, sha256: hash(bytes) };
  };
  const clients = { selectedBefore: capture('claude-before.json', selectedPath, beforeBytes),
    oldBefore: capture('old-client-before.json', oldPath),
    selectedAfter: capture('claude-after.json', selectedPath), oldAfter: capture('old-client-after.json', oldPath),
    currentSettingsBefore: capture('settings-before.json', currentSettings), currentSettingsAfter: capture('settings-after.json', currentSettings),
    oldSettingsBefore: capture('old-settings-before.json', oldSettings), oldSettingsAfter: capture('old-settings-after.json', oldSettings) };
  for (const [key, selected, old] of [['afterUpdateCancel', 'claude-update-cancel.json', 'old-client-update-cancel.json'],
    ['afterReviewCancel', 'claude-review-cancel.json', 'old-client-review-cancel.json']]) {
    clients[key] = { selected: capture(selected, selectedPath, beforeBytes), old: capture(old, oldPath) };
  }
  const pending = Buffer.from(JSON.stringify({ schema: 1, files: [{ client: 'Claude Code',
    path: direct.physicalSettingsPath(selectedPath), before_sha256: hash(beforeBytes), after_sha256: hash(afterBytes) }] }));
  const id = hash(pending), journal = path.join(profile.local, 'creator-hub/client-migrations-v1', id);
  for (const [name, bytes] of [['pending.json', pending], ['completed.json', pending], ['0.before.bin', beforeBytes],
    ['0.after.bin', afterBytes], ['0.intent.json', JSON.stringify({ schema: 1, before_sha256: hash(beforeBytes), after_sha256: hash(afterBytes) })],
    ['0.native.json', '{"schema":1,"success":true,"error":null}'], ['0.outcome.json', '{"schema":1,"status":"Applied","native_error":null}']]) {
    write(path.join(journal, name), bytes);
  }
  const backup = path.join(profile.home, '.creator-hub-settings-backups', `.claude.json.${hash(beforeBytes)}.bak`);
  const retained = path.join(profile.home, `.creator-hub-migration-${id}-0/retained.bin`);
  write(backup, beforeBytes); write(retained, beforeBytes);
  const approved = { status: 'migrated', count: 1, journal };
  const processes = (route, pid) => [{ pid, parentPid: 1, startTicks: String(pid), kernelIdentityVerified: true, image: route.command },
    { pid: pid + 1, parentPid: pid, startTicks: String(pid + 1), kernelIdentityVerified: true,
      image: path.join(route.payload, 'mcp/server/runtime/node.exe') }];
  const held = processes(oldRoute, 10);
  const report = { kind: target.KIND, sourceCommit: binding.target.source.commit, baseline: config.baseline, pins: config.pins,
    lastTool, restore, restoredLastTool: restore ? lastTool : null, profile, clients,
    manualCapabilityRetention: retention.proof(lastTool, restore), beforePeVersion: [0, 1, 22, 0], afterPeVersion: [0, 1, 23, 0],
    beforeRoot: { pid: 1 }, afterRoot: { pid: 2, kernelIdentityVerified: true },
    resourceProbe: { phase: 'after-automatic-root', attempts: 1, passed: true },
    heldProcessesBefore: held, heldProcessesAfter: structuredClone(held), reconnectedProcesses: processes(newRoute, 20),
    freshOldProcesses: processes(oldRoute, 30), heldServerVersion: { version: binding.baseline.manifest.modules.mcp.version },
    reconnectedServerVersion: { version: binding.target.manifest.modules.mcp.version },
    freshOldServerVersion: { version: binding.baseline.manifest.modules.mcp.version },
    beforeRoute: active(binding.baseline), afterRoute: active(binding.target),
    settingsReview: { source: review.source, path: review.path }, settingsView: direct.assertSettingsView(review),
    settingsViewExistedBeforeReview: existingView,
    clientReview: { cancelled: { status: 'cancelled', count: 0 }, approved,
      evidence: direct.assertMigrationEvidence({ result: approved, local: profile.local, selectedPath, before: beforeBytes, after: afterBytes }) } };
  if (existingView) report.settingsViewBefore = capture('settings-view-before.json', review.path);
  for (const key of ['passed', 'nativeUpdateAccepted', 'automaticRestart', 'cancelPreserved', 'existingConnectionSurvived',
    'newConnectionVerified', 'restorationVerified', 'policyRestored', 'settingsPreserved', 'acceptanceOnly',
    'targetMcpRuntimeVerified', 'installedResourcesVerifiedBeforeAndAfter', 'heldGenerationRetained',
    'activeRouteUnchangedAfterCancel', 'normalRestartPreserved', 'fixtureEvidencePreservedAfterCleanup']) report[key] = true;
  for (const key of ['publicDiscovery', 'liveAiAcceptance', 'releaseReady']) report[key] = false;
  const lifecycle = { kind: 'lab-lifecycle-result', scenario: target.KIND,
    actualScope: 'exact-direct22-to-qualified23-acceptance-fixture-lab-only', lifecycleSucceeded: true, cleanupVerified: true,
    systemTlsVerified: true, labDiscovery: true, publicDiscovery: false, productAcceptance: false, releaseReady: false,
    driverExitCode: 0, servedRouteCount: 5, rejectedRequestCount: 0 };
  const check = (value = report, rows = [lifecycle]) => input.checkReceipt(value, rows, config, { CREATOR_OUTGOING_CASE: caseName });
  check();
  return { root, report, lifecycle, input, target, config, check, oldRoute, newRoute, installed, backup, retained, review, journal };
}

test('disabled binding refuses receipt admission before any filesystem evidence is read', () => {
  const binding = structuredClone(require('./fixtures/windows-outgoing-019-test-fixture.cjs').binding);
  binding.enabled = false;
  const target = isolated('windows-outgoing-019-target.cjs', { './fixtures/windows-outgoing-019-binding.json': binding });
  const input = isolated('windows-outgoing-019-input.cjs', { './windows-outgoing-019-target.cjs': target });
  assert.throws(() => input.checkReceipt({}, [], { directory: __dirname }), /Pending exact22\/private23 pins/);
});

test('complete synthetic driver receipts pass every case, with fresh/existing views and retained settings pins', windowsOnly, t => {
  for (const caseName of Object.keys(productionTarget.CASES)) {
    for (const existingView of [false, true]) fixture(t, { caseName, existingView });
  }
  fixture(t, { pin: 'CREATOR_WORKS_LAUNCHER_CONFIG' });
  fixture(t, { pin: 'BANTWORKS_LAUNCHER_CONFIG' });
});

test('receipt requires explicit captured profile and evidence rather than success flags', windowsOnly, t => {
  const f = fixture(t);
  for (const key of ['profile', 'clients', 'clientReview', 'settingsReview', 'settingsView', 'settingsViewExistedBeforeReview',
    'freshOldProcesses', 'freshOldServerVersion', 'activeRouteUnchangedAfterCancel', 'normalRestartPreserved',
    'fixtureEvidencePreservedAfterCleanup']) {
    const report = structuredClone(f.report); delete report[key]; assert.throws(() => f.check(report), key);
  }
  for (const key of ['local', 'roaming', 'home']) {
    for (const replacement of [undefined, 'relative/profile', path.join(f.root, 'wrong-profile')]) {
      const report = structuredClone(f.report); report.profile[key] = replacement;
      assert.throws(() => f.check(report), `${key}: ${replacement}`);
    }
  }
  for (const field of ['selectedBefore', 'selectedAfter', 'oldBefore', 'oldAfter', 'currentSettingsBefore',
    'currentSettingsAfter', 'oldSettingsBefore', 'oldSettingsAfter', 'afterUpdateCancel', 'afterReviewCancel']) {
    const report = structuredClone(f.report); delete report.clients[field]; assert.throws(() => f.check(report), field);
  }
});

test('capture identity, length, hashes and owned paths fail closed', windowsOnly, t => {
  const f = fixture(t);
  for (const mutate of [r => r.clients.selectedBefore.bytes++, r => r.clients.selectedBefore.sha256 = '0'.repeat(64),
    r => r.clients.selectedBefore.file = r.clients.oldBefore.file,
    r => r.clients.selectedBefore.capture = r.clients.selectedAfter.capture,
    r => r.clients.oldAfter.capture = r.clients.oldBefore.capture,
    r => r.clients.selectedBefore.capture = path.join(f.root, '../outside.json')]) {
    const report = structuredClone(f.report); mutate(report); assert.throws(() => f.check(report));
  }
});

test('both cancellations require byte-identical selected and unselected captures', windowsOnly, t => {
  const f = fixture(t);
  for (const phase of ['afterUpdateCancel', 'afterReviewCancel']) for (const client of ['selected', 'old']) {
    const report = structuredClone(f.report), saved = report.clients[phase][client];
    const original = fs.readFileSync(saved.capture);
    const changed = Buffer.from(JSON.stringify(JSON.parse(original)));
    fs.writeFileSync(saved.capture, changed);
    saved.bytes = changed.length; saved.sha256 = hash(changed);
    try { assert.throws(() => f.check(report), /client changed/); }
    finally { fs.writeFileSync(saved.capture, original); }
  }
});

test('approval requires exactly one migration and the full matching native journal receipt', windowsOnly, t => {
  const f = fixture(t);
  for (const mutate of [r => r.clientReview.cancelled.status = 'unchanged', r => r.clientReview.cancelled.count = 1,
    r => r.clientReview.approved.status = 'unchanged', r => r.clientReview.approved.count = 0,
    r => r.clientReview.approved.count = 2, r => delete r.clientReview.approved.journal,
    r => r.clientReview.approved.journal = path.join(r.profile.home, 'wrong-store', path.basename(f.journal)),
    r => delete r.clientReview.evidence.backup, r => r.clientReview.evidence.files.pop(),
    r => r.clientReview.evidence.files[0].sha256 = '0'.repeat(64)]) {
    const report = structuredClone(f.report); mutate(report); assert.throws(() => f.check(report));
  }
});

test('native backup, retained image, transaction and publication bytes are rechecked', windowsOnly, t => {
  const f = fixture(t);
  for (const file of [f.backup, f.retained, ...['pending.json', 'completed.json', '0.before.bin', '0.after.bin',
    '0.intent.json', '0.native.json', '0.outcome.json'].map(name => path.join(f.journal, name))]) {
    const original = fs.readFileSync(file); fs.writeFileSync(file, '{}');
    try { assert.throws(() => f.check(), file); } finally { fs.writeFileSync(file, original); }
  }
  for (const name of ['stage.bin', 'displaced.bin']) {
    const file = path.join(path.dirname(f.retained), name); write(file, 'unexpected');
    try { assert.throws(() => f.check(), name); } finally { fs.unlinkSync(file); }
  }
});

test('settings provenance, unchanged originals and existing-view captures are mandatory', windowsOnly, t => {
  const f = fixture(t, { existingView: true });
  for (const mutate of [r => r.settingsReview.source = r.clients.oldSettingsBefore.file,
    r => r.settingsReview.path = path.join(f.newRoute.base, 'settings-views/guessed/launcher-config.json'),
    r => r.settingsView.sha256 = '0'.repeat(64), r => delete r.settingsViewBefore,
    r => r.settingsViewExistedBeforeReview = false]) {
    const report = structuredClone(f.report); mutate(report); assert.throws(() => f.check(report));
  }
  const original = fs.readFileSync(f.review.path);
  for (const mutate of [v => v.auto_start = true, v => v._creator_hub_view.sha256 = '0'.repeat(64),
    v => v._creator_hub_view.source = f.report.clients.oldSettingsBefore.file]) {
    const view = JSON.parse(original); mutate(view); fs.writeFileSync(f.review.path, JSON.stringify(view));
    try { assert.throws(() => f.check()); } finally { fs.writeFileSync(f.review.path, original); }
  }
  for (const file of [f.report.clients.currentSettingsBefore.file, f.report.clients.oldSettingsBefore.file,
    f.report.clients.oldAfter.file, f.report.clients.selectedAfter.file]) {
    const bytes = fs.readFileSync(file); fs.writeFileSync(file, bytes.toString().trim());
    try { assert.throws(() => f.check(), file); } finally { fs.writeFileSync(file, bytes); }
  }
});

test('selected JSON may change only the reviewed command and missing pin', windowsOnly, t => {
  const f = fixture(t), capture = f.report.clients.selectedAfter;
  const original = fs.readFileSync(capture.capture);
  for (const mutate of [v => v.mcpServers['creator-works'].command = f.oldRoute.command,
    v => v.mcpServers['creator-works'].command = path.join(f.newRoute.root, 'router-v1/creator-hub-mcp-router.exe'),
    v => v.mcpServers['creator-works'].env.CREATOR_WORKS_LAUNCHER_CONFIG = f.report.clients.oldSettingsBefore.file,
    v => v.mcpServers['creator-works'].args.push('--other'), v => v.mcpServers.other.command = 'changed']) {
    const after = JSON.parse(original); mutate(after); const changed = Buffer.from(JSON.stringify(after));
    const report = structuredClone(f.report); report.clients.selectedAfter.bytes = changed.length;
    report.clients.selectedAfter.sha256 = hash(changed);
    fs.writeFileSync(capture.capture, changed); fs.writeFileSync(capture.file, changed);
    try { assert.throws(() => f.check(report), /Only reviewed command/); }
    finally { fs.writeFileSync(capture.capture, original); fs.writeFileSync(capture.file, original); }
  }
});

test('old store must stay current and all old/new signed resources retain exact hashes', windowsOnly, t => {
  const f = fixture(t);
  const files = [f.oldRoute.active, f.newRoute.active,
    ...[f.oldRoute, f.newRoute].flatMap(route => [path.join(route.root, route.router, 'router.json'),
      path.join(route.root, route.router, 'router.minisig'), route.command,
      path.join(route.root, 'descriptors', route === f.oldRoute ? f.report.beforeRoute.descriptorSha256 : f.report.afterRoute.descriptorSha256, 'runtime.json'),
      path.join(route.root, 'descriptors', route === f.oldRoute ? f.report.beforeRoute.descriptorSha256 : f.report.afterRoute.descriptorSha256, 'runtime.minisig'),
      ...Object.keys(f.target.binding.baseline.manifest.modules.mcp.files).map(file => path.join(route.payload, file))]),
    path.join(f.installed, 'creator-hub.exe'), ...productionTarget.RESOURCE_PATHS.map(file => path.join(f.installed, 'modules', file))];
  for (const file of files) {
    const original = fs.readFileSync(file); fs.writeFileSync(file, '{}');
    try { assert.throws(() => f.check(), file); } finally { fs.writeFileSync(file, original); }
  }
  const report = structuredClone(f.report); report.beforeRoute = report.afterRoute;
  assert.throws(() => f.check(report));
});

test('fresh-old proof requires six distinct exact old/new router/runtime process identities', windowsOnly, t => {
  const f = fixture(t);
  for (const key of ['heldProcessesBefore', 'freshOldProcesses', 'reconnectedProcesses']) {
    for (const mutate of [rows => rows.pop(), rows => rows[0].kernelIdentityVerified = false,
      rows => rows[1].startTicks = '0', rows => rows[1].parentPid++, rows => rows[0].image = 'C:/wrong/router.exe',
      rows => rows[1].image = 'C:/wrong/node.exe']) {
      const report = structuredClone(f.report); mutate(report[key]); assert.throws(() => f.check(report), key);
    }
  }
  for (const mutate of [r => r.freshOldProcesses = structuredClone(r.heldProcessesBefore),
    r => r.freshOldProcesses = structuredClone(r.reconnectedProcesses),
    r => r.reconnectedProcesses = structuredClone(r.heldProcessesBefore),
    r => r.freshOldServerVersion.version = r.reconnectedServerVersion.version,
    r => r.heldProcessesAfter[1].startTicks = '999']) {
    const report = structuredClone(f.report); mutate(report); assert.throws(() => f.check(report));
  }
});

test('existing restart, version, restoration, TLS, network and cleanup gates remain enforced', windowsOnly, t => {
  const f = fixture(t);
  for (const key of ['passed', 'nativeUpdateAccepted', 'automaticRestart', 'cancelPreserved', 'existingConnectionSurvived',
    'newConnectionVerified', 'restorationVerified', 'policyRestored', 'settingsPreserved', 'acceptanceOnly',
    'targetMcpRuntimeVerified', 'installedResourcesVerifiedBeforeAndAfter', 'heldGenerationRetained']) {
    const report = structuredClone(f.report); report[key] = false; assert.throws(() => f.check(report), key);
  }
  for (const key of ['publicDiscovery', 'liveAiAcceptance', 'releaseReady']) {
    const report = structuredClone(f.report); report[key] = true; assert.throws(() => f.check(report), key);
  }
  for (const mutate of [r => r.beforePeVersion[2]++, r => r.afterPeVersion[2]--,
    r => r.afterRoot.pid = r.beforeRoot.pid, r => r.afterRoot.kernelIdentityVerified = false,
    r => delete r.resourceProbe, r => r.resourceProbe.phase = 'before-root', r => r.resourceProbe.passed = false,
    r => r.resourceProbe.attempts++, r => r.heldServerVersion.version = 'wrong',
    r => r.reconnectedServerVersion.version = 'wrong', r => r.restoredLastTool = null,
    r => r.manualCapabilityRetention.toolGroups = 'wrong']) {
    const report = structuredClone(f.report); mutate(report); assert.throws(() => f.check(report));
  }
  for (const mutate of [v => v.systemTlsVerified = false, v => v.cleanupVerified = false,
    v => v.lifecycleSucceeded = false, v => v.driverExitCode = 1, v => v.servedRouteCount = 4,
    v => v.publicDiscovery = true, v => v.productAcceptance = true, v => v.releaseReady = true,
    v => v.rejectedRequestCount = 2, v => v.rejectionOverflow = 1,
    v => v.rejectionSummary = [{ kind: 'unexpected', count: 1 }]]) {
    const lifecycle = structuredClone(f.lifecycle); mutate(lifecycle); assert.throws(() => f.check(f.report, [lifecycle]));
  }
  assert.throws(() => f.check(f.report, [])); assert.throws(() => f.check(f.report, [f.lifecycle, f.lifecycle]));
});

test('permitted SDK registry refusal still requires exact observed Hub process attribution', windowsOnly, t => {
  const f = fixture(t), report = structuredClone(f.report), lifecycle = structuredClone(f.lifecycle);
  report.beforeRoot = { pid: 100, parentPid: 90, startTicks: '100', kernelIdentityVerified: true,
    image: path.join(report.profile.local, 'Creator Hub/creator-hub.exe') };
  Object.assign(lifecycle, { rejectedRequestCount: 1, rejectionOverflow: 0, connectDiagnosticOverflow: 0, connectTraceOverflow: 0,
    driver: { pid: 90 }, rejectionSummary: [{ kind: 'connect-policy', code: null, count: 1 }],
    connectDiagnostics: [{ authority: '[redacted]', headPresent: false, singleHost: true, duplicateHost: false,
      hostHeaderMatchesAuthority: false, sensitiveHeadersPresent: false, count: 1 }],
    connectTrace: [{ target: { kind: 'dns', host: 'greenfield-registry.sdq.st', port: 443 }, hostHeaderMatchesAuthority: true,
      clientPort: 1000, proxyPort: 2000, owner: { status: 'observed', processes: [{ pid: 100, parentPid: 90,
        image: report.beforeRoot.image }] } }] });
  f.check(report, [lifecycle]);
  for (const mutate of [v => v.driver.pid++, v => v.connectTrace[0].owner.processes[0].pid++,
    v => v.connectTrace[0].owner.processes[0].image = 'C:/unattributed.exe',
    v => v.connectTrace[0].owner.status = 'unknown', v => v.connectTrace[0].target.host = 'example.invalid',
    v => v.connectTrace[0].hostHeaderMatchesAuthority = false,
    v => v.connectTrace[0].proxyPort = v.connectTrace[0].clientPort,
    v => v.connectDiagnostics[0].sensitiveHeadersPresent = true]) {
    const changed = structuredClone(lifecycle); mutate(changed); assert.throws(() => f.check(report, [changed]));
  }
});
