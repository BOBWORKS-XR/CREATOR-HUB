'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const candidate = require('./windows-incoming-016.cjs');
const migration = require('./native-windows-016-migration.cjs');
const direct = require('./native-self-update-direct.cjs');
const { readBounded } = require('./read-bounded-input.cjs');
const ROOT = path.resolve(__dirname, '..');
const BRANCH = 'validation/windows-menu-merge-20261027';
const WORKFLOW = '.github/workflows/windows-settings-only-016.yml';
const CASES = ['current-legacy', 'legacy-only'];
const CONTROL = path.join(ROOT, 'artifacts/settings-only-016-control');
const hash = candidate.hash;
const read = (file, max = 256 * 1024) => readBounded(file, max);
const json = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
const bytes = value => Buffer.from(JSON.stringify(value, null, 2).replace(/\n/g, '\r\n') + '\r\n');
function admission(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32');
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
    GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: `refs/heads/${BRANCH}`,
    GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${WORKFLOW}@refs/heads/${BRANCH}` })) assert.equal(env[key], value, `Refused runner: ${key}`);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'INPUT_RUN', 'INPUT_ARTIFACT']) assert.match(env[key] || '', /^[1-9][0-9]*$/);
  assert.match(env.INPUT_SHA256 || '', /^[a-f0-9]{64}$/); assert.ok(CASES.includes(env.CREATOR_SETTINGS_CASE));
  for (const key of Object.keys(env)) {
    assert.ok(!/^(NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|ALL_PROXY|HTTP_PROXY|HTTPS_PROXY)$/i.test(key), `Refused override: ${key}`);
    assert.ok(!/^WEBVIEW2_/i.test(key), 'No inherited WebView override');
    if (/^CREATOR_/i.test(key)) assert.equal(key, 'CREATOR_SETTINGS_CASE');
  }
}
function bindInput(run, artifact, env) {
  for (const id of [run.id, artifact.id, artifact.workflow_run?.id]) assert.ok(Number.isSafeInteger(id) && id > 0);
  assert.equal(String(run.id), env.INPUT_RUN); assert.equal(String(artifact.id), env.INPUT_ARTIFACT);
  assert.equal(run.repository?.id, 1364807512); assert.equal(run.head_repository?.id, 1364807512);
  assert.equal(run.event, 'workflow_dispatch'); assert.equal(run.head_branch, BRANCH);
  assert.equal(run.path, '.github/workflows/windows-016-input.yml');
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success'); assert.match(run.head_sha, /^[a-f0-9]{40}$/);
  assert.equal(artifact.name, 'windows-016-acceptance-input'); assert.equal(artifact.expired, false);
  assert.equal(artifact.workflow_run.id, run.id); assert.equal(artifact.workflow_run.head_sha, run.head_sha);
  assert.equal(artifact.digest, `sha256:${env.INPUT_SHA256}`);
  assert.ok(Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 64 * 1024 * 1024);
  return { artifactId: artifact.id, runId: run.id, artifactSource: run.head_sha,
    archiveSha256: env.INPUT_SHA256, harnessSource: env.GITHUB_SHA };
}
function fixture(env, out, paths = path) {
  const current = paths.join(env.APPDATA, 'creator-works-mcp/launcher-config.json');
  const legacy = paths.join(env.APPDATA, 'banter-mcp/launcher-config.json');
  const projects = ['Current Project', 'Earlier Project'].map(name => paths.join(out, 'projects', name));
  const channels = projects.map((folder, i) => ({ id: `project-${i}`, name: i ? 'Earlier saved project' : 'Current selected project',
    unity_project_path: folder, scene_path: null, enabled: false }));
  const config = { channels, active_channel_id: channels[0].id, mcp_server_path: '', auto_start: false,
    tool_groups: 'read', enable_custom_scripts: false, allow_all_tests: false, automatic_update_checks: false,
    connection_guide_version: 1, futurePreference: { keep: ['original', false, 7] } };
  const untouched = [
    { file: paths.join(env.LOCALAPPDATA, 'CreatorHub/preferences/hub-preferences.json'),
      bytes: bytes({ schemaVersion: 1, preview: false, autoDownload: false, restoreHostedViews: true }) },
    { file: paths.join(env.LOCALAPPDATA, 'CreatorProjectSetup/editor-roots.json'), bytes: bytes([paths.join(out, 'saved-editor-root')]) },
    { file: paths.join(env.USERPROFILE, '.codex/config.toml'), bytes: Buffer.from("# Synthetic, unrelated entry\r\n[mcp_servers.other]\r\ncommand='unrelated-fixture'\r\n") },
    { file: paths.join(env.USERPROFILE, '.claude.json'), bytes: bytes({ mcpServers: { other: { command: 'unrelated-fixture', args: [] } } }) },
    { file: paths.join(env.APPDATA, 'Claude/claude_desktop_config.json'), bytes: bytes({ mcpServers: { other: { command: 'unrelated-fixture' } }, preferences: { keep: false } }) },
    { file: paths.join(env.USERPROFILE, '.gemini/config/mcp_config.json'), bytes: bytes({ mcpServers: {} }) },
    { file: paths.join(env.APPDATA, 'opencode/opencode.jsonc'), bytes: Buffer.from('// Fixture only\n{"mcp":{},"keep":false}\n') },
    ...projects.flatMap(folder => [
      { file: paths.join(folder, 'ProjectSettings/ProjectVersion.txt'), bytes: Buffer.from('m_EditorVersion: 6000.3.21f1\n') },
      { file: paths.join(folder, 'Packages/manifest.json'), bytes: Buffer.from('{"dependencies":{}}\n') },
      { file: paths.join(folder, 'Assets/Retained.txt'), bytes: Buffer.from('Synthetic authored content; never edit\n') },
    ]),
  ];
  return { current, legacy, projects, config, untouched,
    review: paths.join(env.LOCALAPPDATA, 'CreatorHub/convergence/review-v1.json') };
}
function initialConfig(f, caseName, installedDirectory, paths = path) {
  assert.ok(CASES.includes(caseName));
  return { ...f.config, mcp_server_path: caseName === 'current-legacy' ? ''
    : paths.join(installedDirectory, 'modules/mcp/server/creator-works-mcp.mjs') };
}
function missingProjectFixture(current, legacy, review, verifiedServer) {
  assert.deepEqual(Object.keys(review).sort(), ['policy', 'stores_retained', 'connections_reviewed', 'standalone_removal_accepted', 'retained_legacy_sha256'].sort());
  assert.equal(review.policy, 1); assert.equal(review.stores_retained, true); assert.equal(review.connections_reviewed, true);
  assert.equal(review.standalone_removal_accepted, false); assert.equal(review.retained_legacy_sha256, hash(legacy));
  const before = json(current); assert.deepEqual(before, json(legacy)); assert.equal(before.channels.length, 2);
  assert.ok(path.win32.isAbsolute(verifiedServer)); assert.equal(before.mcp_server_path, verifiedServer);
  assert.equal(before.active_channel_id, before.channels[0].id);
  return bytes({ ...before, channels: [before.channels[0]], tool_groups: 'none',
    futurePreference: { keep: ['current-wins', false, 9] } });
}
function mergedDocument(current, legacy) {
  const c = json(current), l = json(legacy);
  assert.equal(c.channels.length, 1); assert.equal(l.channels.length, 2);
  assert.deepEqual(c.channels[0], l.channels[0]);
  assert.notEqual(path.win32.normalize(c.channels[0].unity_project_path).toLowerCase(), path.win32.normalize(l.channels[1].unity_project_path).toLowerCase());
  return { ...c, channels: [c.channels[0], l.channels[1]] };
}
function reviewSettled(cancelled, document = globalThis.document) {
  const root = document.querySelector('#feature-mcp');
  return Boolean(root && root.getAttribute('aria-busy') === 'false' && (!cancelled
    || root.querySelector('[data-field="product-status"]')?.textContent.includes('without explicit approval')));
}
async function loadMcpConfig(page) {
  return page.evaluate(async () => {
    const call = (command, args = {}) => window.CreatorHubNative.invoke('feature_call', { feature: 'mcp', command, args });
    const id = await call('begin_ui_operation');
    try { return await call('load_config'); }
    finally { await call('finish_ui_operation', { id }); }
  });
}
async function assertMcpControls(page, enabled) {
  assert.equal(await page.locator('#feature-mcp [data-field="controls"]').evaluate(fieldset => fieldset.disabled), !enabled);
  for (const field of ['project', 'check']) {
    assert.equal(await page.locator(`#feature-mcp [data-field="${field}"]`).isEnabled(), enabled);
  }
}
const DIALOGS = Object.freeze({
  bootstrap: ['Move to Hub', 'Move to Hub', 'Not now'],
  import: ['Import saved MCP projects', 'Back up and import projects', 'Keep existing'],
  preserve: ['Preserve MCP product settings', 'Keep backups', 'Keep unchanged'],
});
function confirmation(kind, f) {
  if (kind === 'bootstrap') return "Move your existing setup to this Creator Hub?\n\n- Back up settings first; add missing projects without duplicates and keep current preferences and selection.\n- Move verified existing AI connections to this Hub's signed runtime; keep other client entries.\n- Retire only verified standalone app entries; keep settings, Unity projects, backups and old runtime files.\n\n0 missing project(s); 0 known standalone app location(s). Custom launchers that need an old GUI or its registration are not converted.\n\nCustom or unverified connections and servers need separate review. Busy apps are not force-closed. Cancel changes no settings or installations.";
  if (kind === 'import') return 'Import saved MCP projects into your current settings?\n\nMissing projects to import: 1. Earlier entries already listed: 1. Projects are matched by folder and will not be duplicated. Current preferences, selected project and existing project entries are kept. Both original configurations are backed up first, then both active settings files receive the combined project list with current preferences. Older preferences remain in their backup.\n\nHub will ask any verified idle standalone app windows to close normally before keeping exact local backups. Busy or unverified apps are not force-closed. AI clients, Unity and Node connections stay open.\n\nOnly the reviewed MCP settings are updated. AI-client settings, Project Setup settings and installed apps are not changed. Project folders are not moved or edited. No client migration or app removal is performed. Cancel leaves the current setup unchanged.';
  assert.equal(kind, 'preserve');
  return `Keep exact local backups of these MCP settings?\n\nCurrent: ${f.current}\nLegacy (kept): ${f.legacy}\n\nCurrent settings remain preferred; legacy-only settings remain in their existing location. Different files are not merged, copied to a new Hub store or overwritten. Unknown fields, projects, terms and installed apps are unchanged.`;
}
function selectDialog(windows, pid, kind, approve, f) {
  assert.ok(Object.hasOwn(DIALOGS, kind)); assert.equal(typeof approve, 'boolean');
  const dialogs = windows.filter(row => row.class === '#32770'); assert.equal(dialogs.length, 1);
  const dialog = dialogs[0], [title, yes, no] = DIALOGS[kind]; assert.equal(dialog.title, title);
  assert.ok(Number.isSafeInteger(dialog.handle) && dialog.handle > 0);
  const content = confirmation(kind, f), texts = dialog.controls.filter(row => row.id === 'ContentText');
  assert.equal(texts.length, 1); assert.equal(texts[0].processId, pid); assert.equal(texts[0].name, content);
  const name = approve ? yes : no, id = approve ? 1000 : 1001;
  const controls = dialog.controls.filter(row => row.name === name); assert.equal(controls.length, 1);
  assert.equal(controls[0].processId, pid); assert.equal(controls[0].id, `CommandButton_${id}`);
  return { title, name, id, handle: dialog.handle, content };
}
function dialogCommand(pid, executable, selected, kind, approve, f) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0); assert.ok(path.win32.isAbsolute(executable) && !/[\0\r\n]/.test(executable));
  const expected = selectDialog([{ title: selected.title, handle: selected.handle, class: '#32770', controls: [
    { id: 'ContentText', name: selected.content, processId: pid }, { id: `CommandButton_${selected.id}`, name: selected.name, processId: pid },
  ] }], pid, kind, approve, f);
  assert.deepEqual(selected, expected);
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  return `$targetPid=${pid};$expectedExecutable=${quote(executable)};$dialogHandle=${selected.handle};$buttonId=${selected.id};$buttonName=${quote(selected.name)};$expectedTitle=${quote(selected.title)};$expectedContent=${quote(selected.content)};\n${migration.DIALOG_ACTION}`;
}
function checkReceipt(report, caseName, source) {
  assert.ok(CASES.includes(caseName)); assert.equal(report.case, caseName); assert.equal(report.harnessSource, source);
  assert.equal(report.scope, 'exact-candidate-two-settings-cases');
  for (const [key, value] of Object.entries(candidate.productProvenance())) assert.deepEqual(report[key], value);
  assert.equal(report.installerSha256, candidate.TARGET.installer); assert.equal(report.executableSha256, candidate.TARGET.exe);
  migration.validateProvenance(report.inputBinding, source);
  for (const key of ['passed', 'nativeCaseAccepted', 'cancelPreserved', 'backupsVerified', 'settingsVerified', 'manualNormalRestartAccepted', 'policyRestored', 'installedResourcesVerified']) assert.equal(report[key], true, key);
  for (const key of ['releaseReady', 'signedUpdateAccepted', 'signedAutomaticRestartAccepted', 'migrationAccepted', 'liveAiAppAccepted', 'userMachineUsed', 'ambiguousJsonAccepted']) assert.equal(report[key], false, key);
  assert.equal(report.requiredFalseObserved, caseName === 'current-legacy');
  assert.equal(report.legacyOnlyNoCopy, caseName === 'legacy-only');
  assert.equal(report.bootstrapAccepted, caseName === 'current-legacy');
  const decisions = caseName === 'current-legacy' ? [['bootstrap', true], ['import', false], ['import', true]]
    : [['preserve', false], ['preserve', true], ['preserve', true]];
  assert.deepEqual(report.nativeDecisions.map(row => [row.kind, row.approve]), decisions);
  assert.equal(report.normalCloses.length, caseName === 'current-legacy' ? 3 : 2);
  assert.equal(new Set(report.normalCloses.map(row => row.pid)).size, report.normalCloses.length);
  for (const close of report.normalCloses) { assert.ok(Number.isSafeInteger(close.pid) && close.pid > 0); assert.equal(close.exitCode, 0); }
}
async function main(args = process.argv.slice(2), env = process.env) {
  admission(env); // No input/profile read, fixture, process or policy operation before refusal.
  if (args[0] === 'bind') {
    assert.equal(args.length, 1);
    const binding = bindInput(json(read(path.join(CONTROL, 'stager-run.json'), 2 * 1024 * 1024)),
      json(read(path.join(CONTROL, 'artifact.json'), 2 * 1024 * 1024)), env);
    fs.writeFileSync(path.join(CONTROL, 'input-binding.json'), JSON.stringify(binding, null, 2) + '\n', { flag: 'wx' }); return binding;
  }
  if (args[0] === 'receipt') {
    assert.equal(args.length, 2); assert.ok(migration.inside(path.join(ROOT, 'artifacts'), path.resolve(args[1])));
    const report = json(read(path.resolve(args[1])));
    assert.equal(report.harnessRun, env.GITHUB_RUN_ID); assert.equal(report.attempt, env.GITHUB_RUN_ATTEMPT);
    checkReceipt(report, env.CREATOR_SETTINGS_CASE, env.GITHUB_SHA); return { receiptVerified: true, releaseReady: false };
  }
  assert.equal(args.length, 1); assert.ok(path.isAbsolute(args[0]));
  assert.equal(fs.realpathSync(process.cwd()).toLowerCase(), fs.realpathSync(env.GITHUB_WORKSPACE).toLowerCase());
  for (const key of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'GITHUB_WORKSPACE', 'RUNNER_TEMP']) {
    assert.ok(path.isAbsolute(env[key] || '')); rejectLinks(env[key]);
  }
  assert.ok(migration.inside(env.USERPROFILE, env.APPDATA) && migration.inside(env.USERPROFILE, env.LOCALAPPDATA));
  assert.ok(migration.inside(env.GITHUB_WORKSPACE, args[0])); rejectLinks(args[0]);
  const input = candidate.installer(args[0]); assert.equal(fs.statSync(input).size, candidate.TARGET.bytes);
  const binding = migration.validateProvenance(json(read(path.join(CONTROL, 'input-binding.json'), 4096)), env.GITHUB_SHA);
  assert.equal(String(binding.runId), env.INPUT_RUN); assert.equal(String(binding.artifactId), env.INPUT_ARTIFACT); assert.equal(binding.archiveSha256, env.INPUT_SHA256);
  const out = path.join(ROOT, 'artifacts', `native-suite-${Date.now()}`), f = fixture(env, out), caseName = env.CREATOR_SETTINGS_CASE;
  const hub = path.join(env.LOCALAPPDATA, 'Creator Hub/creator-hub.exe');
  for (const file of [out, ...['Creator Hub', 'Creator Works MCP', 'Creator Project Setup', 'CreatorHub', 'creator-hub', 'CreatorProjectSetup'].map(name => path.join(env.LOCALAPPDATA, name)),
    path.dirname(f.current), path.dirname(f.legacy), ...f.untouched.map(row => row.file)]) {
    rejectLinks(file); assert.equal(fs.existsSync(file), false, 'Never adopt a pre-existing user/profile fixture');
  }
  const ps = script => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 256 * 1024 });
  const processes = () => JSON.parse(ps(migration.PROCESSES)), registrations = () => JSON.parse(ps(migration.REGISTRATIONS));
  assert.deepEqual(processes(), []); assert.deepEqual(registrations(), []);
  const { chromium } = require('@playwright/test'); // Dependencies checked before installing.
  fs.mkdirSync(out); const policyState = path.join(out, 'webview-policy.json');
  const report = { scope: 'exact-candidate-two-settings-cases', case: caseName, ...candidate.productProvenance(),
    harnessSource: env.GITHUB_SHA, harnessRun: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, inputBinding: binding,
    installerSha256: candidate.TARGET.installer, executableSha256: candidate.TARGET.exe,
    passed: false, nativeCaseAccepted: false, bootstrapAccepted: false, requiredFalseObserved: false, legacyOnlyNoCopy: false,
    releaseReady: false, signedUpdateAccepted: false, signedAutomaticRestartAccepted: false, migrationAccepted: false,
    liveAiAppAccepted: false, userMachineUsed: false, ambiguousJsonAccepted: false, nativeDecisions: [], normalCloses: [] };
  const save = (name, value) => fs.writeFileSync(path.join(out, name), Buffer.isBuffer(value) ? value : bytes(value), { flag: 'wx' });
  const environment = Object.fromEntries(Object.entries(env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|PRIVATE_KEY|SIGNING|CREDENTIAL|AUTHORIZATION|PROXY|^(NODE_|WEBVIEW2_|CREATOR_|TAURI_)/i.test(key)));
  const policy = action => execFileSync('powershell.exe', ['-NoProfile', '-File', path.join(ROOT, 'scripts/native-webview-policy.ps1'), '-Action', action, '-StateFile', policyState], { windowsHide: true, timeout: 30000 });
  let child, browser, page, ownedPage = false, current, legacy, plan;
  const native = action => execFileSync('powershell.exe', ['-NoProfile', '-File', path.join(ROOT, 'scripts/native-window.ps1'),
    '-TargetPid', String(child.pid), '-ExpectedExecutable', hub, '-Action', action], { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 256 * 1024 });
  const retained = () => {
    for (const item of f.untouched) assert.deepEqual(read(item.file), item.bytes, item.file);
    assert.deepEqual(registrations(), [{ hive: 'HKCU:', name: 'Creator Hub', version: candidate.TARGET.version }]);
  };
  const originals = () => { assert.equal(fs.existsSync(f.current), current !== null); if (current) assert.deepEqual(read(f.current), current); assert.deepEqual(read(f.legacy), legacy); retained(); };
  const backupState = () => Object.fromEntries([f.current, f.legacy].map(file => {
    const dir = path.join(path.dirname(file), '.creator-hub-settings-backups'); rejectLinks(dir);
    if (!fs.existsSync(dir)) return [dir, null];
    const names = fs.readdirSync(dir).sort(); assert.ok(names.length <= 64);
    return [dir, names.map(name => ({ name, sha256: hash(read(path.join(dir, name))) }))];
  }));
  const backups = () => { for (const [file, original] of [[f.current, current], [f.legacy, legacy]]) if (original) assert.deepEqual(read(migration.backupFile(file, original)), original); report.backupsVerified = true; };
  const status = () => page.evaluate(() => window.CreatorHubNative.invoke('convergence_status'));
  const feature = command => page.evaluate(command => window.CreatorHubNative.invoke('feature_call', { feature: 'mcp', command, args: {} }), command);
  const decision = async (kind, approve) => {
    const selected = await retry(() => selectDialog(JSON.parse(native('snapshot')), child.pid, kind, approve, f));
    originals(); assert.equal(hash(read(hub, 128 * 1024 * 1024)), candidate.TARGET.exe);
    report.nativeDecisions.push({ kind, approve, pid: child.pid, ...selected });
    ps(dialogCommand(child.pid, hub, selected, kind, approve, f)); // Never retry the native action.
  };
  const launch = async () => {
    ownedPage = false; assert.deepEqual(processes(), []); assert.equal(hash(read(hub, 128 * 1024 * 1024)), candidate.TARGET.exe);
    child = spawn(hub, [], { windowsHide: true, stdio: 'ignore', env: { ...environment,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9238 --remote-debugging-address=127.0.0.1', WEBVIEW2_USER_DATA_FOLDER: path.join(out, 'webview') } });
    child.on('error', error => { report.launchError = String(error); });
    const owned = () => {
      assert.equal(report.launchError, undefined); assert.equal(child.exitCode, null);
      const state = execFileSync('powershell.exe', ['-NoProfile', '-File', path.join(ROOT, 'scripts/native-startup-diagnostics.ps1')], { windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 256 * 1024 });
      candidate.assertOwnedDebugging(JSON.parse(state.replace(/^\uFEFF/, '')), child.pid, hub);
    };
    await retry(owned); browser = await retry(() => chromium.connectOverCDP('http://127.0.0.1:9238'));
    page = await retry(() => { const views = browser.contexts().flatMap(context => context.pages()).filter(view => /^https?:\/\/tauri\.localhost(?:\/|$)/.test(view.url())); assert.equal(views.length, 1); return views[0]; });
    owned(); ownedPage = true; page.setDefaultTimeout(45000);
    await page.waitForFunction(() => window.CreatorHubNative?.integratedFeatures === true); await direct.checkProtocol(page);
    assert.deepEqual(processes(), [{ ProcessId: child.pid, ParentProcessId: process.pid, ExecutablePath: hub }]);
    assert.equal(page.frames().length, 1); assert.equal(page.context().pages().length, 1);
  };
  const close = async () => {
    await page.waitForFunction(() => document.querySelector('#check-updates')?.disabled === false, null, { timeout: 180000 });
    native('close'); await retry(() => assert.equal(child.exitCode, 0));
    report.normalCloses.push({ pid: child.pid, exitCode: child.exitCode }); ownedPage = false;
    await browser.close(); browser = null; page = null; await retry(() => assert.deepEqual(processes(), [])); retained();
  };
  const readyMcp = async expected => {
    await page.waitForFunction(() => { const root = document.querySelector('#feature-mcp'); return root && !root.hidden && root.getAttribute('aria-busy') === 'false' && root.querySelector('[data-field="status"]')?.textContent === 'Ready'; });
    await assertMcpControls(page, true);
    const loaded = await loadMcpConfig(page);
    for (const key of ['active_channel_id', 'mcp_server_path', 'auto_start', 'tool_groups', 'enable_custom_scripts', 'allow_all_tests']) assert.deepEqual(loaded[key], expected[key]);
    assert.deepEqual(loaded.channels, expected.channels);
    assert.equal(await page.locator('#feature-mcp [data-field="project"]').inputValue(), expected.channels.find(row => row.id === expected.active_channel_id).unity_project_path);
    for (const [field, key] of [['groups', 'tool_groups'], ['server', 'mcp_server_path']]) assert.equal(await page.locator(`#feature-mcp [data-field="${field}"]`).inputValue(), expected[key]);
    for (const [field, key] of [['follow', 'auto_start'], ['scripts', 'enable_custom_scripts'], ['tests', 'allow_all_tests']]) assert.equal(await page.locator(`#feature-mcp [data-field="${field}"]`).isChecked(), expected[key]);
    retained();
  };
  try {
    const install = spawn(input, ['/S', '/NS'], { env: environment, windowsHide: true, stdio: 'ignore' });
    install.on('error', error => { report.installError = String(error); });
    await retry(() => { assert.equal(report.installError, undefined); assert.equal(install.exitCode, 0); }, 120);
    plan = migration.inspectInstalledResources(path.dirname(hub)); report.installedResourcesVerified = true;
    // Seed only our fresh hosted-runner namespace, after exact installed resource admission.
    const initial = initialConfig(f, caseName, path.dirname(hub));
    current = caseName === 'current-legacy' ? bytes(initial) : null; legacy = bytes(initial);
    for (const item of [...f.untouched, { file: f.legacy, bytes: legacy }, ...(current ? [{ file: f.current, bytes: current }] : [])]) {
      rejectLinks(item.file); fs.mkdirSync(path.dirname(item.file), { recursive: true }); fs.writeFileSync(item.file, item.bytes, { flag: 'wx' });
    }
    save('fixture-before.json', { current: current && hash(current), legacy: hash(legacy), untouched: f.untouched.map(row => ({ file: row.file, sha256: hash(row.bytes) })) });
    originals(); policy('Enable'); await launch();
    await page.locator('#usage-terms-dialog').waitFor({ state: 'visible' });
    await page.locator('#usage-terms-checkbox').check(); await page.locator('#usage-terms-continue').click();
    await page.locator('#usage-terms-dialog').waitFor({ state: 'hidden' });
    await page.locator('#convergence-dialog').waitFor({ state: 'visible' });
    const initialStatus = await status(); assert.equal(initialStatus.required, true); assert.deepEqual(initialStatus.legacyApps, []);
    if (caseName === 'current-legacy') {
      assert.equal(initialStatus.settingsImportAvailable, false);
      await page.locator('#convergence-move').click(); await decision('bootstrap', true);
      await page.locator('#convergence-title').filter({ hasText: /^Move complete$/ }).waitFor({ timeout: 180000 });
      const complete = await status(); assert.equal(complete.stage, 'complete'); assert.equal(complete.required, false);
      const review = read(f.review); save('bootstrap-native-review.json', review);
      current = read(f.current); legacy = read(f.legacy); assert.deepEqual(json(current), json(legacy));
      save('bootstrap-current.json', current); save('bootstrap-legacy.json', legacy);
      const route = migration.inspectActiveRoute(env.LOCALAPPDATA, plan);
      await page.locator('#convergence-later').click(); await close();
      const next = missingProjectFixture(current, legacy, json(review), path.join(route.payload, 'mcp/server/creator-works-mcp.mjs'));
      assert.deepEqual(processes(), []); assert.deepEqual(read(f.review), review); assert.deepEqual(read(f.current), current);
      // The only harness rewrite is its own synthetic current store, with the app stopped.
      const fd = fs.openSync(f.current, 'r+');
      try { assert.equal(fs.fstatSync(fd).nlink, 1); assert.deepEqual(fs.readFileSync(fd), current); fs.writeSync(fd, next, 0, next.length, 0); fs.ftruncateSync(fd, next.length); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      current = next; originals(); assert.deepEqual(read(f.review), review); save('import-before-current.json', current); save('import-before-legacy.json', legacy);
      report.bootstrapAccepted = true; report.bootstrapReviewSha256 = hash(review);
      await launch(); await page.locator('#convergence-dialog').waitFor({ state: 'visible' });
      const requiredFalse = await status(); save('required-false-status.json', requiredFalse);
      assert.equal(requiredFalse.required, false); assert.equal(requiredFalse.settingsImportAvailable, true); assert.equal(requiredFalse.retirementAvailable, false);
      assert.deepEqual(requiredFalse.legacyApps, []);
      assert.equal(await page.locator('#convergence-title').innerText(), DIALOGS.import[0]);
      for (const id of ['move', 'connections', 'retire']) assert.equal(await page.locator(`#convergence-${id}`).isVisible(), false);
      report.requiredFalseObserved = true;
      const beforeCancel = backupState();
      await page.getByRole('button', { name: DIALOGS.import[1], exact: true }).click(); await decision('import', false);
      await page.waitForFunction(() => document.querySelector('#convergence-dialog')?.getAttribute('aria-busy') === 'false');
      assert.match(await page.locator('#convergence-error').innerText(), /cancelled/); originals(); assert.deepEqual(backupState(), beforeCancel); assert.deepEqual(read(f.review), review);
      report.cancelPreserved = true;
      const expected = mergedDocument(current, legacy);
      await page.getByRole('button', { name: DIALOGS.import[1], exact: true }).click(); await decision('import', true);
      await page.locator('#convergence-title').filter({ hasText: /^Saved MCP projects imported$/ }).waitFor();
      backups(); assert.deepEqual(json(read(f.current)), expected); assert.deepEqual(read(f.current), read(f.legacy));
      const imported = await status(); assert.equal(imported.required, false); assert.equal(imported.settingsImportAvailable, false); assert.equal(imported.stage, 'backed-up');
      current = read(f.current); legacy = read(f.legacy); save('import-after.json', current);
      assert.deepEqual(read(f.review), review); assert.deepEqual(migration.inspectActiveRoute(env.LOCALAPPDATA, plan), route);
      await page.getByRole('button', { name: 'Continue in Hub', exact: true }).click();
      await candidate.showPage(page, 'mcp'); await readyMcp(expected); originals();
      await page.screenshot({ path: path.join(out, 'imported-mcp.png'), animations: 'disabled' }); await close();
      await launch(); await page.waitForFunction(() => document.querySelector('#check-updates')?.disabled === false, null, { timeout: 180000 });
      const again = await status(); save('restart-status.json', again);
      assert.equal(again.required, false); assert.equal(again.settingsImportAvailable, false); assert.deepEqual(again.legacyApps, []);
      assert.equal(await page.locator('#convergence-dialog').isVisible(), false);
      await candidate.showPage(page, 'mcp'); await readyMcp(expected); originals(); assert.deepEqual(read(f.review), review);
      assert.deepEqual(migration.inspectActiveRoute(env.LOCALAPPDATA, plan), route); await close();
    } else {
      assert.equal(initialStatus.settingsImportAvailable, false);
      await page.locator('#convergence-later').click(); await page.locator('#convergence-dialog').waitFor({ state: 'hidden' });
      const reviewLegacy = async cancelFirst => {
        await candidate.showPage(page, 'mcp');
        const panel = page.getByRole('region', { name: 'Saved MCP settings review', exact: true });
        await panel.waitFor({ state: 'visible' });
        await page.waitForFunction(reviewSettled, false);
        assert.equal((await feature('product_settings_status')).status, 'legacy-only');
        await assertMcpControls(page, false); originals();
        const button = panel.getByRole('button', { name: 'Review saved MCP settings', exact: true });
        if (cancelFirst) {
          const beforeCancel = backupState(); await button.click(); await decision('preserve', false);
          await page.waitForFunction(reviewSettled, true);
          originals(); assert.deepEqual(backupState(), beforeCancel);
          await assertMcpControls(page, false);
          assert.equal(await button.isEnabled(), true, 'Returned cancellation must allow an explicit fresh review'); report.cancelPreserved = true;
        }
        await button.click(); await decision('preserve', true); await readyMcp(initial); backups(); originals();
      };
      await reviewLegacy(true); await page.screenshot({ path: path.join(out, 'legacy-mcp.png'), animations: 'disabled' }); await close();
      await launch(); await page.waitForFunction(() => document.querySelector('#check-updates')?.disabled === false, null, { timeout: 180000 });
      assert.equal(await page.locator('#convergence-dialog').isVisible(), false);
      await reviewLegacy(false); originals(); assert.equal(fs.existsSync(f.review), false, 'Product backup review is not migration approval');
      report.legacyOnlyNoCopy = true; await close();
    }
    migration.inspectInstalledResources(path.dirname(hub)); originals();
    report.settingsVerified = true; report.manualNormalRestartAccepted = true; report.nativeCaseAccepted = true; report.passed = true;
  } catch (error) {
    report.error = String(error.stack || error); process.exitCode = 1;
    if (ownedPage && page) {
      await page.screenshot({ path: path.join(out, 'failure.png'), timeout: 5000 }).catch(() => {});
      report.dialogs = await page.locator('dialog[open]').evaluateAll(rows => rows.map(row => ({ id: row.id, text: row.textContent.slice(0, 8192) }))).catch(() => null);
      try { report.nativeWindows = JSON.parse(native('snapshot')); } catch { report.nativeCaptureUnavailable = true; }
    }
  } finally {
    if (child?.exitCode === null) try { native('close'); await retry(() => assert.equal(child.exitCode, 0), 15); } catch (error) { report.closeError = String(error); report.passed = false; child.unref(); }
    if (browser) await browser.close().catch(error => { report.browserError = String(error); report.passed = false; });
    try { if (fs.existsSync(policyState)) policy('Restore'); report.policyRestored = true; } catch (error) { report.policyError = String(error); report.passed = false; }
    try { checkReceipt(report, caseName, env.GITHUB_SHA); } catch (error) { report.receiptError = String(error); report.passed = false; }
    if (!report.passed) { report.nativeCaseAccepted = false; process.exitCode = 1; }
    save('settings-only-016-report.json', report);
  }
  return { out, passed: report.passed, nativeCaseAccepted: report.nativeCaseAccepted, releaseReady: false };
}
function rejectLinks(file) {
  for (let entry = path.resolve(file); ; entry = path.dirname(entry)) {
    if (fs.existsSync(entry)) assert.equal(fs.lstatSync(entry).isSymbolicLink(), false, 'Linked paths refused');
    if (path.dirname(entry) === entry) break;
  }
}
async function retry(action, seconds = 90) {
  let last;
  for (const end = Date.now() + seconds * 1000; Date.now() < end;) {
    try { return await action(); } catch (error) { last = error; await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  throw last || Error('Readiness deadline exceeded');
}
module.exports = { BRANCH, WORKFLOW, CASES, admission, bindInput, fixture, initialConfig, missingProjectFixture, mergedDocument, reviewSettled, loadMcpConfig, assertMcpControls, DIALOGS, confirmation, selectDialog, dialogCommand, checkReceipt, main };
if (require.main === module) main().then(result => console.log(JSON.stringify(result))).catch(error => { console.error(String(error.stack || error)); process.exitCode = 1; });
