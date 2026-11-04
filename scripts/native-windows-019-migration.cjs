// Native, disposable-only migration probe. Never run this driver on a user PC.
// Contract: node scripts/native-windows-016-migration.cjs ABS_INSTALLER_OR_DATA_DIR ABS_BASELINES_DIR
// Only Creator.Hub_0.1.19_x64-setup.exe is consumed from the data-only artifact.
// No external payload, build receipt, manifest, signature generation or rebuild.
// The parent must create artifacts/incoming-019/input-binding.json after its
// immutable artifact/run provenance preflight, before invoking this driver.
// Baselines directory: the three exact assets exported by native-installed-baseline.cjs.
// Required lane: validation/windows-019-production, CREATOR_WINDOWS_019_MIGRATION=1.
// Install/update/restart signing and real AI application acceptance remain separate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');

const { TARGET, productProvenance } = require('./windows-019-production.cjs');
const CONTEXT = Object.freeze({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
  RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-019-production.yml@refs/heads/validation/windows-019-production',
  GITHUB_REF: 'refs/heads/validation/windows-019-production', CREATOR_WINDOWS_019_MIGRATION: '1' });
const INCOMING_PARENT_MODE = Symbol('incoming-signed-migration-diagnostic');
const setupOwned = require('./windows-019-setup-owned-case.cjs');
const unverifiedServer = require('./windows-019-unverified-server-case.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const BASELINE_OUTPUT_MESSAGES = new Set([
  'NSIS Error', 'Error launching installer', 'Error writing temporary file',
  'Installer integrity check has failed', 'Error opening file for writing',
]);
function redactBaselineOutput(output) {
  if (!Buffer.isBuffer(output) && typeof output !== 'string') return { available: false, lines: [], truncated: false };
  const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output.slice(0, 4097));
  const prefix = bytes.subarray(0, 4096).toString('utf8');
  const lines = prefix.split(/\r\n|\r|\n/).filter(Boolean);
  return { available: true, lines: lines.slice(0, 32).map(line => BASELINE_OUTPUT_MESSAGES.has(line) ? line : '[redacted]'),
    truncated: bytes.length > 4096 || lines.length > 32 };
}
function baselineFailure(error, baseline) {
  const code = error && error.code;
  const signal = error && error.signal;
  return { asset: baseline.asset, status: Number.isSafeInteger(error?.status) ? error.status : null,
    signal: typeof signal === 'string' && Object.hasOwn(os.constants.signals, signal) ? signal : signal == null ? null : 'other',
    code: Number.isSafeInteger(code) ? code : typeof code === 'string' && (Object.hasOwn(os.constants.errno, code) || code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') ? code : code == null ? null : 'other',
    stdout: redactBaselineOutput(error?.stdout), stderr: redactBaselineOutput(error?.stderr) };
}
function installBaseline(file, baseline, environment, report, run = execFileSync) {
  try { return run(file, ['/S', '/NS'], { env: environment, windowsHide: true, timeout: 180000, stdio: 'pipe' }); }
  catch (error) { report.baselineInstallerFailure = baselineFailure(error, baseline); throw error; }
}
function installLegacyBaselines({ baselines, input, environment, report, localAppData, registrations,
  install = installBaseline, read = regular, digest = hash }) {
  report.baselines = [];
  for (const baseline of baselines) {
    install(path.join(input.baselines, baseline.asset), baseline, environment, report);
    report.baselines.push({ product: baseline.product, version: baseline.version, installerSha256: baseline.sha256,
      executableSha256: digest(read(path.join(localAppData, baseline.product, baseline.binary), 200 * 1024 * 1024)) });
  }
  const beforeInstall = registrations();
  assert.equal(beforeInstall.length, 3);
  for (const item of baselines) assert.equal(beforeInstall.find(value => value.name === item.product && value.hive === 'HKCU:')?.version, item.version);
}
async function installMigrationTarget({ installer, environment, hub, hubHash, unchanged, retained, report, registrations,
  baselines, connect, entry, run = execFileSync, inspect = inspectInstalledResources }) {
  run(installer, ['/UPDATE', '/S', '/NS'], { env: environment, windowsHide: true, timeout: 180000, stdio: 'pipe' });
  assert.equal(hubHash(), TARGET.exe); unchanged(); retained();
  const manifest = inspect(path.dirname(hub));
  report.installedResourcesVerified = true; report.resourcePins = RESOURCE_PINS;
  assert.deepEqual(registrations().map(item => item.name).sort(), baselines.map(item => item.product).sort());
  const oldClient = await connect(entry);
  report.checks.push('Pinned baseline installers and exact direct19 payload installed; original stores/clients retained and old SDK transport connected before native migration');
  return { manifest, oldClient };
}

// Exact Setup/router pins come from the single reviewed candidate manifest.
const binding = require('./windows-019-contract.cjs').pinned;
const RESOURCE_PINS = Object.freeze({
  ...binding.manifest.document?.modules?.setup?.files, ...binding.manifest.document?.managedRouting?.files
});

const MCP_FILES = Object.freeze(['mcp/creator-works-mcp-launcher.exe', 'mcp/server/creator-works-mcp.mjs',
  'mcp/server/runtime/node.exe', 'mcp/server/runtime/LICENSE', 'mcp/server/runtime/VERSION',
  'mcp/server/unity-extension/Editor/BanterMCPBridge.cs', 'mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png',
  'mcp/server/LICENSE', 'mcp/server/THIRD_PARTY_NOTICES.md']);
const INPUT_FILES = Object.freeze([TARGET.asset, 'creator-hub-windows-x86_64.json',
  'creator-hub-windows-x86_64.json.minisig', 'latest.json']);

function admission(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32', 'Native migration requires Windows');
  for (const [key, value] of Object.entries(CONTEXT)) assert.equal(env[key], value, `Refused runner context: ${key}`);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/, 'Exact test source revision required');
  assert.equal(env.EXPECTED_HARNESS_COMMIT, env.GITHUB_SHA, 'Expected production harness differs');
  for (const key of Object.keys(env)) {
    assert.ok(!/^(?:NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|ALL_PROXY|HTTP_PROXY|HTTPS_PROXY)$/i.test(key), `Refused process override: ${key}`);
    if (/^CREATOR_/i.test(key)) assert.equal(key, 'CREATOR_WINDOWS_019_MIGRATION', 'No product fixture or behavior overrides');
    assert.ok(!/^WEBVIEW2_/i.test(key), 'No inherited WebView profile or debugger overrides');
  }
}

function parseArgs(args, paths = path) {
  assert.equal(args.length, 2, 'Supply only absolute installer path/data directory and baseline directory');
  for (const value of args) assert.ok(typeof value === 'string' && paths.isAbsolute(value)
    && !/[\r\n\0]/.test(value), 'Absolute input directories required');
  assert.notEqual(paths.resolve(args[0]).toLowerCase(), paths.resolve(args[1]).toLowerCase());
  return { candidate: paths.resolve(args[0]), baselines: paths.resolve(args[1]) };
}

function installerPath(input, directory, paths = path) {
  const file = directory ? paths.join(input, TARGET.asset) : input;
  assert.equal(paths.basename(file), TARGET.asset, 'Only the canonical fixed installer name is admitted');
  return file;
}

function validateProvenance(value, revision) {
  require('./windows-019-production.cjs').validateAcquisition(value, revision);
  return value;
}

function inside(root, file, paths = path) {
  const relative = paths.relative(root, file);
  return relative !== '' && !relative.startsWith(`..${paths.sep}`) && relative !== '..' && !paths.isAbsolute(relative);
}

function regular(file, max = 2 * 1024 * 1024) {
  const info = fs.lstatSync(file);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= max, 'Expected bounded regular file');
  const bytes = fs.readFileSync(file); assert.equal(bytes.length, info.size); return bytes;
}

function rejectLinks(file) {
  for (let at = path.resolve(file);;) {
    if (fs.existsSync(at)) assert.equal(fs.lstatSync(at).isSymbolicLink(), false, 'Linked test paths are refused');
    const next = path.dirname(at); if (next === at) break; at = next;
  }
}

function resourcePlan(runtimeBytes, routerBytes) {
  require('./windows-019-production.cjs').validateBinding();
  assert.equal(hash(runtimeBytes), RESOURCE_PINS['routing/runtime.json'], 'Frozen runtime descriptor differs');
  assert.equal(hash(routerBytes), RESOURCE_PINS['routing/router.json'], 'Frozen router descriptor differs');
  const runtime = JSON.parse(runtimeBytes), router = JSON.parse(routerBytes);
  assert.deepEqual(Object.keys(runtime).sort(), ['schemaVersion', 'product', 'hubVersion', 'platform', 'arch', 'module'].sort());
  assert.equal(runtime.schemaVersion, 1); assert.equal(runtime.product, 'com.creatorworks.hub.mcp-runtime');
  assert.equal(runtime.hubVersion, TARGET.version); assert.equal(runtime.platform, 'windows'); assert.equal(runtime.arch, 'x86_64');
  assert.deepEqual(Object.keys(runtime.module).sort(), ['executable', 'version', 'files'].sort());
  assert.equal(runtime.module.executable, 'mcp/creator-works-mcp-launcher.exe'); assert.equal(runtime.module.version, binding.manifest.document.modules.mcp.version);
  assert.deepEqual(Object.keys(runtime.module.files).sort(), [...MCP_FILES].sort());
  assert.deepEqual(runtime.module.files, binding.manifest.document.modules.mcp.files);
  for (const digest of Object.values(runtime.module.files)) assert.match(digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(router, { schemaVersion: 1, product: 'com.creatorworks.hub.mcp-router', platform: 'windows', arch: 'x86_64',
    protocol: 1, sha256: RESOURCE_PINS['routing/creator-hub-mcp-router.exe'] });
  return { schemaVersion: 1, platform: 'windows', arch: 'x86_64', modules: { mcp: runtime.module,
    setup: { executable: 'setup/creator-project-setup.exe', version: binding.manifest.document.modules.setup.version,
      files: { 'setup/creator-project-setup.exe': RESOURCE_PINS['setup/creator-project-setup.exe'] } } },
  managedRouting: { protocol: 1, files: Object.fromEntries(Object.entries(RESOURCE_PINS).filter(([name]) => name.startsWith('routing/'))) } };
}

function pinnedRead(file, expected, max = 128 * 1024 * 1024) {
  rejectLinks(file); const bytes = regular(file, max); assert.equal(hash(bytes), expected, `Frozen installed resource differs: ${path.basename(file)}`); return bytes;
}

function inspectInstalledResources(directory) {
  // The exact installed EXE is the first admission, not an inferred source match.
  pinnedRead(path.join(directory, 'creator-hub.exe'), TARGET.exe);
  const root = path.join(directory, 'modules');
  const runtime = pinnedRead(path.join(root, 'routing/runtime.json'), RESOURCE_PINS['routing/runtime.json'], 32768);
  const router = pinnedRead(path.join(root, 'routing/router.json'), RESOURCE_PINS['routing/router.json'], 32768);
  const plan = resourcePlan(runtime, router);
  for (const entry of [plan.modules.mcp.files, RESOURCE_PINS]) for (const [name, digest] of Object.entries(entry)) pinnedRead(path.join(root, name), digest);
  return plan;
}

function moduleGeneration(module) {
  return hash(Buffer.from(JSON.stringify({ executable: module.executable, version: module.version,
    files: Object.fromEntries(Object.entries(module.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) })));
}

function verifyActiveReceipt(receipt, plan) {
  assert.deepEqual(receipt, { schemaVersion: 1, descriptorSha256: RESOURCE_PINS['routing/runtime.json'], generation: moduleGeneration(plan.modules.mcp) });
  return receipt.generation;
}

function inspectActiveRoute(localData, plan) {
  const root = path.join(localData, 'creator-hub', 'mcp-route-v1', 'windows-x86_64');
  const activeFile = path.join(root, 'active.json'); rejectLinks(activeFile);
  const activeBytes = regular(activeFile, 2048), receipt = JSON.parse(activeBytes), generation = verifyActiveReceipt(receipt, plan);
  const descriptor = path.join(root, 'descriptors', receipt.descriptorSha256);
  for (const name of ['runtime.json', 'runtime.minisig']) pinnedRead(path.join(descriptor, name), RESOURCE_PINS[`routing/${name}`], 32768);
  for (const name of ['router.json', 'router.minisig', 'creator-hub-mcp-router.exe']) pinnedRead(path.join(root, 'router-v1', name), RESOURCE_PINS[`routing/${name}`]);
  const payload = path.join(localData, 'creator-hub', 'runtime-generations', 'windows-x86_64', generation);
  for (const [name, digest] of Object.entries(plan.modules.mcp.files)) pinnedRead(path.join(payload, name), digest);
  assert.deepEqual(regular(activeFile, 2048), activeBytes, 'Active route changed while its retained images were checked');
  return { descriptorSha256: receipt.descriptorSha256, generation, payload };
}

function backupFile(file, bytes, paths = path) {
  return paths.join(paths.dirname(file), '.creator-hub-settings-backups', `${paths.basename(file)}.${hash(bytes)}.bak`);
}

function fixture(env, out, paths = path) {
  const projectA = paths.join(out, 'projects', 'Current Project');
  const projectB = paths.join(out, 'projects', 'Earlier Only Project');
  const oldRoot = paths.join(env.LOCALAPPDATA, 'Creator Works MCP');
  const oldServer = paths.join(oldRoot, 'server', 'creator-works-mcp.mjs');
  const oldNode = paths.join(oldRoot, 'server', 'runtime', 'node.exe');
  const channel = (id, folder) => ({ id, name: 'Saved project', unity_project_path: folder,
    scene_path: null, enabled: false, futureChannelOption: { keep: ['custom', false] } });
  const currentChannel = channel('current-project', projectA);
  const missingChannel = channel('earlier-only', projectB);
  const current = { channels: [currentChannel], active_channel_id: currentChannel.id, mcp_server_path: oldServer,
    auto_start: false, tool_groups: 'read', enable_custom_scripts: false, allow_all_tests: false,
    automatic_update_checks: false, connection_guide_version: 1,
    futurePreference: { keep: false, values: [1, 'unchanged'] } };
  const legacy = { ...current, channels: [{ ...currentChannel, id: 'old-duplicate', enabled: true,
    unity_project_path: projectA.replaceAll('\\', '/').toUpperCase() + '/' }, missingChannel, missingChannel],
    active_channel_id: missingChannel.id, auto_start: true, tool_groups: 'full', allow_all_tests: true,
    futurePreference: { old: 'only in exact backup' }, oldOnlyPreference: 'do not activate' };
  const entry = { command: oldNode, args: [oldServer], timeout: 37,
    env: { UNITY_PROJECT_PATH: projectA, CREATOR_WORKS_TOOL_GROUPS: 'read', CUSTOM_SETTING: 'keep' } };
  const other = { command: 'unrelated-server', args: ['keep'], env: { THIRD_PARTY: 'untouched' } };
  const jsonClient = id => ({ id, entry, path: id === 'claude' ? paths.join(env.USERPROFILE, '.claude.json')
    : paths.join(env.APPDATA, 'Claude', 'claude_desktop_config.json'),
    bytes: Buffer.from(JSON.stringify({ preferences: { keep: false }, futureRoot: ['untouched'],
      mcpServers: { other, 'creator-works': entry } }, null, 2) + '\r\n') });
  const clients = [{ id: 'codex', entry, path: paths.join(env.USERPROFILE, '.codex', 'config.toml'),
    bytes: Buffer.from(`# Keep this comment\r\nmodel='keep'\r\nfuture_root='untouched'\r\n[mcp_servers.other]\r\ncommand='unrelated-server'\r\nargs=['keep']\r\n[mcp_servers.creator-works]\r\ncommand=${JSON.stringify(oldNode)}\r\nargs=[${JSON.stringify(oldServer)}]\r\ntimeout=37\r\n[mcp_servers.creator-works.env]\r\nUNITY_PROJECT_PATH=${JSON.stringify(projectA)}\r\nCREATOR_WORKS_TOOL_GROUPS='read'\r\nCUSTOM_SETTING='keep'\r\n`) }, jsonClient('claude'), jsonClient('claudeDesktop')];
  const stores = [
    { path: paths.join(env.APPDATA, 'creator-works-mcp', 'launcher-config.json'), bytes: Buffer.from(JSON.stringify(current, null, 2) + '\n') },
    { path: paths.join(env.APPDATA, 'banter-mcp', 'launcher-config.json'), bytes: Buffer.from(JSON.stringify(legacy, null, 2) + '\r\n') },
    { path: paths.join(env.LOCALAPPDATA, 'CreatorProjectSetup', 'editor-roots.json'), bytes: Buffer.from(JSON.stringify([paths.join(out, 'saved-editor-roots')]) + '\n') },
  ];
  const untouched = [
    { path: paths.join(env.APPDATA, 'creator-works-mcp', 'future-settings.bin'), bytes: Buffer.from('unknown-settings-must-survive\r\n') },
    { path: paths.join(env.APPDATA, 'banter-mcp', 'old-settings.bin'), bytes: Buffer.from('old-settings-must-survive\r\n') },
    { path: paths.join(env.LOCALAPPDATA, 'CreatorHub', 'preferences', 'hub-preferences.json'),
      bytes: Buffer.from('{"schemaVersion":1,"preview":false,"autoDownload":false,"restoreHostedViews":true}\n') },
    { path: paths.join(env.USERPROFILE, '.gemini', 'config', 'mcp_config.json'), bytes: Buffer.from(JSON.stringify({ mcpServers: { other }, futureRoot: ['keep'] }) + '\n') },
    { path: paths.join(env.APPDATA, 'opencode', 'opencode.jsonc'), bytes: Buffer.from('// Keep comment and third-party entry\n{"mcp":{"other":{"type":"remote","url":"https://example.invalid/mcp"}},"futureRoot":false}\n') },
  ];
  return setupOwned.fixtureCase(env, { projectA, projectB, oldRoot, oldServer, oldNode, current, legacy, missingChannel, stores, clients, untouched, entry });
}

function seedMigrationFixture({ f, stores, fsOps = fs, checkLinks = rejectLinks, read = regular, digest = hash, image = projectImage }) {
  for (const project of [f.projectA, f.projectB]) {
    for (const directory of ['Assets', 'ProjectSettings', 'Packages']) fsOps.mkdirSync(path.join(project, directory), { recursive: true });
    fsOps.writeFileSync(path.join(project, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.21f1\n', { flag: 'wx' });
    fsOps.writeFileSync(path.join(project, 'Packages', 'manifest.json'), '{"dependencies":{}}\n', { flag: 'wx' });
    f.untouched.push({ path: path.join(project, 'Assets', 'AuthoredContent.txt'), bytes: Buffer.from('Never modify a Unity project during migration\n') });
  }
  for (const item of [...stores, ...f.untouched.filter(item => !stores.includes(item))]) {
    checkLinks(item.path); assert.equal(fsOps.existsSync(item.path), false);
    fsOps.mkdirSync(path.dirname(item.path), { recursive: true }); fsOps.writeFileSync(item.path, item.bytes, { flag: 'wx' });
  }
  const retainedRuntime = fsOps.readdirSync(path.join(f.oldRoot, 'server'), { recursive: true, withFileTypes: true })
    .filter(item => item.isFile()).map(item => {
      const file = path.join(item.parentPath || item.path, item.name); return { file, sha256: digest(read(file, 200 * 1024 * 1024)) };
    });
  assert.equal(retainedRuntime.length, 9, 'Exact baseline server inventory required');
  return { fixture: f, retainedRuntime, projectBefore: image([f.projectA, f.projectB]) };
}

function verifyMerged(f, currentBytes, legacyBytes, server) {
  assert.ok(typeof server === 'string' && server.length > 0 && server !== f.oldServer, 'The saved server must actually move to Hub');
  const expected = { ...f.current, channels: [...f.current.channels, f.missingChannel], mcp_server_path: server };
  for (const bytes of [currentBytes, legacyBytes]) {
    const document = JSON.parse(bytes); assert.deepEqual(document, expected, 'Import changes only projects and reviewed server, not current preferences/selection/unknown fields');
    assert.equal(new Set(document.channels.map(item => item.id)).size, document.channels.length);
    assert.equal(new Set(document.channels.map(item => path.win32.normalize(item.unity_project_path).toLowerCase())).size, document.channels.length);
  }
}

function verifyClient(f, item, document, router) {
  if (item.setupOwned) return setupOwned.verifyClient(item, document, router);
  const actual = item.id === 'codex' ? document.mcp_servers['creator-works'] : document.mcpServers['creator-works'];
  assert.deepEqual(actual, { ...item.entry, command: router, args: [],
    env: { ...item.entry.env, CREATOR_WORKS_CONFIG_OWNER: 'creator-hub-v1' } },
  'Only reviewed command/args and the exact Hub ownership marker may change');
  if (item.id === 'codex') {
    assert.deepEqual(document, { model: 'keep', future_root: 'untouched', mcp_servers: {
      other: { command: 'unrelated-server', args: ['keep'] }, 'creator-works': actual } });
  } else {
    const before = JSON.parse(item.bytes); before.mcpServers['creator-works'] = actual;
    assert.deepEqual(document, before, 'Third-party entries and unknown client fields must survive');
  }
  assert.equal(actual.env.UNITY_PROJECT_PATH, f.projectA);
  return actual;
}

function assertDialog(windows, pid, approve) {
  const dialogs = windows.filter(item => item.class === '#32770');
  assert.equal(dialogs.length, 1, 'Exactly one owned native confirmation required');
  const dialog = dialogs[0]; assert.equal(dialog.title, 'Move to Hub');
  assert.ok(Number.isSafeInteger(dialog.handle) && dialog.handle > 0);
  const name = approve ? 'Move to Hub' : 'Not now';
  const controls = dialog.controls.filter(item => item.name === name);
  assert.equal(controls.length, 1); assert.equal(controls[0].processId, pid);
  assert.equal(controls[0].id, approve ? 'CommandButton_1000' : 'CommandButton_1001');
  return { title: dialog.title, name, id: approve ? 1000 : 1001, handle: dialog.handle };
}

function connectionReview(f, router) {
  return 'These existing connections could not be publisher-verified:\n\n'
    + (f.normalSetup ? ['Claude Code', 'Claude Desktop'] : ['Codex', 'Claude Code', 'Claude Desktop']).map(name => `${name}\nCommand: ${f.oldNode}\nServer: ${f.oldServer}\nProject kept: ${f.projectA}`).join('\n\n')
    + `\n\nMove them to the verified Hub router at ${router}? Names and ownership markers are not proof. Continue only for your Creator Works connections. Exact backups, client options and other servers are kept. Cancel stops migration before changing any of these clients.`;
}

function assertConnectionDialog(windows, pid, content) {
  const dialogs = windows.filter(item => item.class === '#32770');
  assert.equal(dialogs.length, 1, 'Exactly one owned connection exception review required');
  const dialog = dialogs[0]; assert.equal(dialog.title, 'Review unverified MCP connections');
  assert.ok(Number.isSafeInteger(dialog.handle) && dialog.handle > 0);
  const texts = dialog.controls.filter(item => item.id === 'ContentText');
  assert.equal(texts.length, 1); assert.equal(texts[0].processId, pid); assert.equal(texts[0].name, content);
  const buttons = dialog.controls.filter(item => item.name === 'Move reviewed connections');
  assert.equal(buttons.length, 1); assert.equal(buttons[0].processId, pid); assert.equal(buttons[0].id, 'CommandButton_1000');
  return { title: dialog.title, name: 'Move reviewed connections', id: 1000, handle: dialog.handle, content };
}

// The shared native-window helper predates this single-review task dialog.
// This fixed action rechecks HWND, PID, image, title, UIA ID and visibility, then
// posts exactly one TDM_CLICK_BUTTON. It cannot invoke an arbitrary app command.
const DIALOG_ACTION = String.raw`
$ErrorActionPreference='Stop'
$p=Get-Process -Id $targetPid -ErrorAction Stop
if ([IO.Path]::GetFullPath($p.Path) -ine [IO.Path]::GetFullPath($expectedExecutable)) { throw 'Owned image changed' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class Migration016Dialog {
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
}
'@
$h=[IntPtr]$dialogHandle; [uint32]$owner=0
[void][Migration016Dialog]::GetWindowThreadProcessId($h,[ref]$owner)
$name=[Text.StringBuilder]::new(256); [void][Migration016Dialog]::GetWindowText($h,$name,256)
$class=[Text.StringBuilder]::new(256); [void][Migration016Dialog]::GetClassName($h,$class,256)
if($owner -ne $targetPid -or $name.ToString() -cne $expectedTitle -or $class.ToString() -cne '#32770' -or -not [Migration016Dialog]::IsWindowVisible($h)) { throw 'Owned dialog changed' }
$w=[Windows.Automation.AutomationElement]::FromHandle($h)
if($expectedContent) {
 $texts=$w.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::AutomationIdProperty,'ContentText'))
 if($texts.Count -ne 1 -or $texts[0].Current.ProcessId -ne $targetPid -or $texts[0].Current.Name -cne $expectedContent) { throw 'Reviewed connection details changed' }
}
$matches=$w.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,$buttonName))
if($matches.Count -ne 1) { throw 'Ambiguous native approval' }
$b=$matches[0]
if($b.Current.ProcessId -ne $targetPid -or $b.Current.AutomationId -cne ('CommandButton_'+$buttonId) -or -not $b.Current.IsEnabled -or $b.Current.IsOffscreen) { throw 'Native approval changed' }
if(-not [Migration016Dialog]::PostMessage($h,0x466,[IntPtr]$buttonId,[IntPtr]::Zero)) { throw 'Native action post failed' }
'Posted one owned native migration decision'
`;

function dialogCommand(pid, executable, selected) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0); assert.ok(Number.isSafeInteger(selected.handle) && selected.handle > 0);
  const guide = selected.title === 'Move to Hub' && ((selected.id === 1000 && selected.name === 'Move to Hub') || (selected.id === 1001 && selected.name === 'Not now'));
  const server = selected.title === 'Keep MCP settings working in Hub' && selected.id === 1000 && selected.name === 'Use Hub runtime';
  const connection = selected.title === 'Review unverified MCP connections' && selected.id === 1000 && selected.name === 'Move reviewed connections';
  assert.ok(guide || connection || server, 'Only fixed guide/connection/server decisions are admitted');
  if (connection || server) assert.ok(typeof selected.content === 'string' && selected.content.length > 0 && selected.content.length <= 8192);
  assert.ok(path.win32.isAbsolute(executable) && !/[\0\r\n]/.test(executable));
  const quote = text => `'${text.replaceAll("'", "''")}'`;
  return `$targetPid=${pid};$expectedExecutable=${quote(executable)};$dialogHandle=${selected.handle};$buttonId=${selected.id};$buttonName=${quote(selected.name)};$expectedTitle=${quote(selected.title)};$expectedContent=${quote(connection || server ? selected.content : '')};\n${DIALOG_ACTION}`;
}

function reportTemplate(testSource) {
  return { schemaVersion: 1, scope: 'exact-direct19-three-client-clean-legacy-guide-probe',
    ...productProvenance(), testSource, installerSha256: TARGET.installer, executableSha256: TARGET.exe,
    passed: false, nativeGuideAccepted: false, migrationAccepted: false, signedUpdateAccepted: false,
    liveAiAppAccepted: false, crashRecoveryAccepted: false, backupBeforeEveryWriteAccepted: false,
    releaseReady: false, userMachineUsed: false, checks: [], limitations: [
      'SDK transports test protocol connection, not real Codex/Claude application sessions.',
      'Native observation checks backups at first observed changes, not atomic proof before every write.',
      'Interrupted migration recovery and signed incoming update/restart are separate gates.' ] };
}

const REGISTRATIONS = String.raw`
$ErrorActionPreference='Stop'
$items=@()
foreach($hive in @('HKCU:','HKLM:')) {
 foreach($name in @('Creator Hub','Creator Works MCP','Creator Project Setup')) {
  $key=$hive+'\Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$name
  if(Test-Path -LiteralPath $key) {
   $items+=@{hive=$hive;name=$name;version=(Get-ItemProperty -LiteralPath $key -Name DisplayVersion).DisplayVersion}
  }
 }
}
ConvertTo-Json -InputObject @($items) -Compress
`;
const PROCESSES = String.raw`
$ErrorActionPreference='Stop'
ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Filter "Name = 'creator-hub.exe' OR Name = 'creator-works-mcp-launcher.exe' OR Name = 'creator-project-setup.exe'" | Select-Object ProcessId,ParentProcessId,ExecutablePath) -Compress
`;

function projectImage(roots) {
  return roots.flatMap(folder => fs.readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter(item => item.isFile()).map(item => {
      const file = path.join(item.parentPath || item.path, item.name); rejectLinks(file);
      return { file, sha256: hash(regular(file)) };
    })).sort((a, b) => a.file.localeCompare(b.file));
}

async function retry(action, seconds = 45) {
  let last;
  for (const end = Date.now() + seconds * 1000; Date.now() < end;) {
    try { return await action(); } catch (error) { last = error; await delay(200); }
  }
  throw last || Error('Native migration deadline exceeded');
}

const guidePageBindings = new WeakMap();
// The live capture must come from the trusted runner, not from fixture data.
function verifyGuideOwnership(live, hub) {
  assert.ok(Number.isSafeInteger(live.process?.pid) && live.process.pid > 0, 'A live owned Hub process is required');
  assert.equal(live.image, hub, 'The live interface must identify the expected Hub image');
  assert.equal(live.process.exitCode, null, 'The owned Hub must still be running');
  const captured = live.captureOwnership();
  assert.equal(captured.imageSha256, TARGET.exe, 'The live Hub image must be exact R2');
  require('./windows-019-production.cjs').assertOwnedDebugging(captured.diagnostics, live.process.pid, hub);
  assert.deepEqual(captured.processes, [{ ProcessId: live.process.pid, ParentProcessId: process.pid, ExecutablePath: hub }]);
}
function verifyBrowserPage(browser, page) {
  const context = page.context();
  assert.equal(context.browser(), browser, 'Guide page belongs to a different browser');
  assert.ok(browser.contexts().includes(context) && context.pages().includes(page), 'Guide page is not in the connected browser');
  assert.match(page.url(), /^https?:\/\/tauri\.localhost(?:\/|$)/, 'Unexpected guide page origin');
}
function rememberGuidePage(live, hub, browser, page) {
  verifyGuideOwnership(live, hub); verifyBrowserPage(browser, page);
  guidePageBindings.set(page, { browser, process: live.process, pid: live.process.pid, image: hub });
}
function verifyGuidePage(live, hub) {
  const page = live.page, binding = guidePageBindings.get(page);
  assert.ok(binding, 'Guide page has no verified CDP binding');
  assert.equal(binding.browser, live.browser, 'Guide browser differs from the verified CDP connection');
  assert.equal(binding.process, live.process, 'Guide process differs from the verified CDP binding');
  assert.equal(binding.pid, live.process.pid); assert.equal(binding.image, hub);
  verifyBrowserPage(binding.browser, page);
}

async function runGuideRestart({ fixture: seededFixture, projectBefore, connect }, context) {
  const { live, f, retry, readStatus, nativeDecision, unchanged, retained, report, connectionDecision, serverDecision, verifyBackups,
    read, manifest, oldClient, registrations, baselines, projectImage, out, hub, termsAlreadyAccepted = false } = context;
  assert.ok(f && Array.isArray(f.stores) && Array.isArray(f.clients) && Array.isArray(f.untouched), 'A seeded migration fixture is required');
  assert.equal(seededFixture, f, 'Guide must consume the same synthetic fixture object');
  const { policy, open, launch, close } = live;
  const effects = { fs, hash, regular, inspectActiveRoute, verifyMerged, verifyClient, execFileSync, inspectInstalledResources,
    localAppData: process.env.LOCALAPPDATA, managedTarget: () => require('./native-managed-target.cjs'), ...context.effects };
  policy('Enable'); await open();
  verifyGuideOwnership(live, hub);
  verifyGuidePage(live, hub);
  if (termsAlreadyAccepted) {
    await live.page.locator('#usage-terms-dialog').waitFor({ state: 'hidden' });
  } else {
    await live.page.locator('#usage-terms-dialog').waitFor({ state: 'visible' });
    await live.page.locator('#usage-terms-checkbox').check(); await live.page.locator('#usage-terms-continue').click();
    await live.page.locator('#usage-terms-dialog').waitFor({ state: 'hidden' });
  }
  if (termsAlreadyAccepted) {
    const pending = await retry(readStatus);
    assert.equal(pending.stage, 'review'); assert.equal(pending.required, true); assert.deepEqual(pending.backups, []);
    await live.page.locator('#convergence-reopen').waitFor({ state: 'visible', timeout: 180000 });
    await live.page.locator('#convergence-reopen').click();
  }
  await live.page.locator('#convergence-move').waitFor({ state: 'visible' });
  const initial = await retry(readStatus);
  assert.equal(initial.streamlined, true); assert.equal(initial.stage, 'review'); assert.equal(initial.required, true);
  assert.deepEqual(initial.backups, []);
  await live.page.locator('#convergence-move').click(); await nativeDecision(false);
  await live.page.waitForFunction(() => document.querySelector('#convergence-dialog')?.getAttribute('aria-busy') === 'false');
  unchanged(); retained();
  const cancelled = await readStatus(); assert.equal(cancelled.stage, 'review'); assert.deepEqual(cancelled.backups, []);
  for (const item of [...f.stores, ...f.clients]) assert.equal(effects.fs.existsSync(backupFile(item.path, item.bytes)), false);
  report.cancelAccepted = true;
  if (f.normalSetup) report.normalSetupOwnedCodex = { fixtureOnly: true, copiedUserData: false,
    command: f.clients[0].entry.command, args: [], beforeNativeMoveSha256: hash(read(f.clients[0].path)),
    guiNativeMoveRequired: true, migrationAccepted: false };
  // Observation is deliberately not advertised as atomic before-write proof.
  const observed = new Map(); let observationError;
  const sample = () => {
    try {
      for (const item of [...f.stores.slice(0, 2), ...f.clients.filter(item => !item.setupOwned)]) {
        if (observed.has(item.path)) continue;
        let bytes;
        try { bytes = read(item.path); }
        catch (error) {
          // An in-progress locked/atomic source cannot establish a before/after
          // observation. Final idle reads below remain mandatory.
          if (!['ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes(error.code)) throw error;
          report.transientSourceReadSkips = (report.transientSourceReadSkips || 0) + 1; continue;
        }
        if (bytes.equals(item.bytes)) continue;
        verifyBackups(f.stores); verifyBackups([item]); observed.set(item.path, { file: item.path, backup: backupFile(item.path, item.bytes) });
      }
    } catch (error) { observationError ||= error; }
  };
  live.observer = setInterval(sample, 20);
  await live.page.locator('#convergence-move').click(); await nativeDecision(true);
  await connectionDecision();
  if (f.unverifiedSavedServer) await serverDecision();
  await live.page.locator('#convergence-title').filter({ hasText: /^Move complete$/ }).waitFor({ timeout: 180000 });
  sample(); clearInterval(live.observer); live.observer = null;
  if (observationError) throw observationError;
  assert.equal(observed.size, f.normalSetup ? 4 : 5); report.backupsPresentAtFirstObservedChange = [...observed.values()];
  const completed = await readStatus(); assert.equal(completed.stage, 'complete'); assert.equal(completed.required, false);
  assert.deepEqual(completed.legacyApps, []); verifyBackups([...f.stores, ...f.clients]); retained();
  const current = read(f.stores[0].path), earlier = read(f.stores[1].path);
  const server = JSON.parse(current).mcp_server_path;
  assert.equal(effects.hash(effects.regular(server, 64 * 1024 * 1024)), manifest.modules.mcp.files['mcp/server/creator-works-mcp.mjs']);
  const active = effects.inspectActiveRoute(effects.localAppData, manifest);
  assert.equal(effects.fs.realpathSync(server), effects.fs.realpathSync(path.join(active.payload, 'mcp/server/creator-works-mcp.mjs')));
  report.activeRoute = active;
  if (f.unverifiedSavedServer) {
    assert.equal(report.serverRuntimeDecision?.length, 1, 'Separate native Use Hub runtime approval required');
    assert.equal(server, report.serverRuntimeDecision[0].expectedServer, 'The re-resolved mixed-slash server must be persisted');
    report.unverifiedSavedServerTransition = { before: f.unverifiedSavedServer, after: server, nativeApproved: true };
  }
  effects.verifyMerged(f, current, earlier, server);
  const { managedLocations, verifyMigratedTarget } = effects.managedTarget();
  const route = managedLocations(effects.localAppData), migrated = [];
  for (const item of f.clients) {
    const document = item.id === 'codex' ? JSON.parse(effects.execFileSync('python', ['-c',
      "import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1],'rb'))))", item.path],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 })) : JSON.parse(read(item.path));
    const entry = effects.verifyClient(f, item, document, route.command);
    if (item.id === 'codex') assert.match(read(item.path).toString('utf8'), /^# Keep this comment\r?\n/);
    verifyMigratedTarget(entry, manifest, null, effects.localAppData); migrated.push(entry);
    const client = await connect(entry); await client.close();
  }
  assert.ok((await oldClient.listTools({}, { timeout: 15000 })).tools.length > 0);
  const reconnectOld = await connect(f.entry); await reconnectOld.close();
  assert.deepEqual(registrations(), [{ hive: 'HKCU:', name: 'Creator Hub', version: TARGET.version }]);
  for (const baseline of baselines.slice(1)) for (const name of [baseline.binary, 'uninstall.exe']) {
    assert.equal(effects.fs.existsSync(path.join(effects.localAppData, baseline.product, name)), false);
  }
  assert.deepEqual(projectImage([f.projectA, f.projectB]), projectBefore, 'Migration may not edit or add Unity project files');
  report.checks.push('Single-guide native approval completed import/routing/retirement; exact backups, current preferences, unknown fields, projects, three clients and compatibility runtime verified');
  await live.page.screenshot({ path: path.join(out, 'migration-complete.png') });
  await live.page.locator('#convergence-later').click();
  const retainedAfter = [...f.stores, ...f.clients, ...f.untouched].map(item => ({ file: item.path, bytes: read(item.path) }));
  await close(); await launch();
  verifyGuideOwnership(live, hub);
  verifyGuidePage(live, hub);
  await live.page.waitForFunction(() => { const check = document.querySelector('#check-updates'); return check && !check.disabled; }, null, { timeout: 180000 });
  const repeated = await retry(readStatus);
  assert.equal(repeated.required, false); assert.deepEqual(repeated.legacyApps, []);
  assert.equal(await live.page.locator('#convergence-dialog').isVisible(), false);
  assert.equal(await live.page.locator('#usage-terms-dialog').isVisible(), false);
  for (const item of retainedAfter) assert.deepEqual(read(item.file), item.bytes);
  retained(); verifyBackups([...f.stores, ...f.clients]);
  assert.deepEqual(effects.inspectActiveRoute(effects.localAppData, manifest), active);
  effects.inspectInstalledResources(path.dirname(hub));
  assert.deepEqual(projectImage([f.projectA, f.projectB]), projectBefore);
  assert.deepEqual(registrations(), [{ hive: 'HKCU:', name: 'Creator Hub', version: TARGET.version }]);
  assert.ok((await oldClient.listTools({}, { timeout: 15000 })).tools.length > 0);
  for (const entry of [f.entry, ...migrated]) { const client = await connect(entry); await client.close(); }
  await close();
  assert.equal(report.nativeDecisions.length, 2, 'One native cancellation and one native approval; no additional decisions');
  report.checks.push('Normal close/relaunch is idempotent: no repeated guide/terms, no settings reset, old live transport and all managed routes reconnect');
  if (f.normalSetup) {
    const retained = hash(read(f.clients[0].path));
    assert.equal(retained, report.normalSetupOwnedCodex.beforeNativeMoveSha256);
    report.normalSetupOwnedCodex.afterRestartSha256 = retained;
    report.normalSetupOwnedCodex.migrationAccepted = true;
  }
  report.nativeGuideAccepted = true; report.repeatStartupAccepted = true; report.settingsPreserved = true;
  report.passed = true;
}

async function runMigrationPhases(setupInstall, guideRestart) {
  const setup = await setupInstall();
  return guideRestart(setup);
}

async function cleanupMigration({ observer, oldClient, child, browser, policyState, policy, native, retry, report,
  clear = clearInterval, exists = fs.existsSync }) {
  if (observer) clear(observer);
  if (oldClient) try { await oldClient.close(); } catch (error) { report.sdkCleanupError = String(error); report.passed = false; }
  if (child?.exitCode === null) {
    try { native('close'); await retry(() => assert.equal(child.exitCode, 0), 15); }
    catch (error) { report.closeError = String(error); report.passed = false; child.unref(); }
  }
  if (browser) await browser.close().catch(error => { report.browserCloseError = String(error); report.passed = false; });
  try { if (exists(policyState)) policy('Restore'); report.policyRestored = true; }
  catch (error) { report.policyError = String(error); report.passed = false; }
}

function runSignedIncomingParent({ environment, out, fixture: seededFixture, baselineInstaller, projectBefore, projectImage: image }, overrides = {}) {
  const owned = overrides.owned || require('./windows-019-owned-snapshot.cjs');
  const readFile = overrides.readFile || regular, writeFile = overrides.writeFile || fs.writeFileSync;
  const run = overrides.run || execFileSync, checkLinks = overrides.checkLinks || rejectLinks;
  const env = { ...environment, CREATOR_WINDOWS_019_PRODUCTION: '1', CREATOR_PRODUCTION_019_BASELINE: '0.1.12', CREATOR_PRODUCTION_019_EMPTY_DISCOVERY: '1',
    CREATOR_PRODUCTION_019_MIGRATION: '1', CREATOR_PRODUCTION_019_SOURCE: environment.GITHUB_SHA,
    CREATOR_PRODUCTION_019_FIXTURE_ROOT: out };
  owned.admit(env);
  const configFile = path.resolve('artifacts/production-019-control/config.json');
  checkLinks(configFile);
  const config = JSON.parse(readFile(configFile, 256 * 1024));
  owned.bindFeed(config, env);
  const rows = owned.fixturePlan(env, out);
  const known = [...seededFixture.stores, ...seededFixture.clients, ...seededFixture.untouched];
  assert.equal(rows.length, 17); assert.equal(known.length, 13);
  const knownPaths = new Set();
  for (const item of known) {
    assert.ok(!knownPaths.has(item.path)); knownPaths.add(item.path);
    assert.ok(rows.some(row => row.path === item.path && row.bytes.equals(item.bytes)), 'Seeded fixture differs');
  }
  const projectFiles = [seededFixture.projectA, seededFixture.projectB].flatMap(project =>
    [path.join(project, 'ProjectSettings', 'ProjectVersion.txt'), path.join(project, 'Packages', 'manifest.json')]);
  assert.deepEqual(rows.filter(row => !knownPaths.has(row.path)).map(row => row.path).sort(), projectFiles.sort());
  const recorded = { source: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    fixtureRoot: out, files: owned.metadata(rows) };
  owned.checkPreinstalledFixture({ env, out, recorded });
  const receiptPath = path.join(out, 'incoming-preinstalled.json'); checkLinks(receiptPath);
  writeFile(receiptPath, JSON.stringify(recorded), { flag: 'wx' });
  assert.ok(path.isAbsolute(env.ProgramFiles || '') && path.isAbsolute(baselineInstaller));
  const shell = path.join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
  const lifecycleFile = path.join(out, 'signed-update-lifecycle.jsonl'); checkLinks(lifecycleFile);
  let output;
  try {
    output = run(shell, ['-NoProfile', '-NonInteractive', '-File', path.resolve('scripts/native-self-update-lab-019.ps1'),
      '-ContractPath', configFile, '-BaselineInstallerPath', baselineInstaller, '-TimeoutSeconds', '480'],
    { env, encoding: 'utf8', windowsHide: true, timeout: 600000, maxBuffer: 2 * 1024 * 1024 });
  } catch (error) {
    if (typeof error.stdout === 'string' && Buffer.byteLength(error.stdout) <= 2 * 1024 * 1024)
      writeFile(lifecycleFile, error.stdout, { flag: 'wx' });
    throw error;
  }
  assert.equal(typeof output, 'string');
  assert.ok(Buffer.byteLength(output) <= 2 * 1024 * 1024);
  writeFile(lifecycleFile, output, { flag: 'wx' });
  const events = output.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line.replace(/^\uFEFF/, '')));
  const final = events.filter(item => item.kind === 'lab-lifecycle-result'); assert.equal(final.length, 1);
  const updateFile = path.join(owned.signedUpdateRoot(out), 'self-update-report.json'); checkLinks(updateFile);
  const update = JSON.parse(readFile(updateFile, 2 * 1024 * 1024));
  owned.checkClosedSignedUpdate({ env, update, close: update.restartedClose, lifecycle: final[0] });
  owned.checkFixtureBytes({ env, out, recorded });
  assert.deepEqual(image([seededFixture.projectA, seededFixture.projectB]), projectBefore);
  return { signedUpdateObserved: true, normalCloseObserved: true, labCleanupObserved: true,
    processTransfer: false, migrationNetworkObserved: false, migrationIsolationProven: false,
    publicDiscovery: false, migrationProven: false, releaseReady: false };
}

async function productionMigrationMain(args = process.argv.slice(2)) {
  admission();
  assert.match(process.env.INCOMING_EXPECTED_SOURCE || '', /^[a-f0-9]{40}$/);
  assert.equal(process.env.INCOMING_EXPECTED_SOURCE, process.env.GITHUB_SHA, 'Expected diagnostic source differs');
  require('./windows-019-owned-snapshot.cjs').admit({ ...process.env,
    CREATOR_PRODUCTION_019_MIGRATION: '1', CREATOR_PRODUCTION_019_SOURCE: process.env.GITHUB_SHA });
  return main(args, INCOMING_PARENT_MODE);
}

async function main(args = process.argv.slice(2), mode) {
  assert.ok(mode === undefined || mode === INCOMING_PARENT_MODE, 'Unknown migration mode');
  // Admission precedes reads, installation, fixture creation, policy or UI calls.
  admission();
  if (mode === INCOMING_PARENT_MODE) {
    const owned = require('./windows-019-owned-snapshot.cjs');
    owned.admit({ ...process.env, CREATOR_PRODUCTION_019_MIGRATION: '1', CREATOR_PRODUCTION_019_SOURCE: process.env.GITHUB_SHA });
  }
  const input = parseArgs(args);
  rejectLinks(input.candidate);
  const dataIsDirectory = fs.lstatSync(input.candidate).isDirectory();
  const installer = installerPath(input.candidate, dataIsDirectory);
  const dataDirectory = dataIsDirectory ? input.candidate : path.dirname(installer);
  assert.notEqual(dataDirectory.toLowerCase(), input.baselines.toLowerCase());
  for (const value of [dataDirectory, input.baselines]) {
    rejectLinks(value); assert.ok(fs.statSync(value).isDirectory());
    assert.ok([process.env.GITHUB_WORKSPACE, process.env.RUNNER_TEMP].some(root => root && inside(root, value)), 'Inputs must be staged inside this disposable job');
  }
  for (const item of fs.readdirSync(dataDirectory, { withFileTypes: true })) {
    assert.ok(item.isFile() && !item.isSymbolicLink() && INPUT_FILES.includes(item.name), 'Only the flat data-only installer/signature/descriptor/manifest input set is admitted');
  }
  for (const key of ['USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'GITHUB_WORKSPACE', 'RUNNER_TEMP']) {
    assert.ok(path.isAbsolute(process.env[key] || ''), `Missing absolute ${key}`); rejectLinks(process.env[key]);
  }
  assert.ok(inside(process.env.USERPROFILE, process.env.APPDATA) && inside(process.env.USERPROFILE, process.env.LOCALAPPDATA));
  assert.equal(fs.realpathSync(process.cwd()).toLowerCase(), fs.realpathSync(process.env.GITHUB_WORKSPACE).toLowerCase(), 'Run from the exact checked-out workspace');
  const { baselines } = require('./native-installed-baseline.cjs');
  const provenanceFile = path.resolve('artifacts/incoming-019/input-binding.json'); rejectLinks(provenanceFile);
  const provenance = validateProvenance(JSON.parse(regular(provenanceFile, 4096)), process.env.GITHUB_SHA);
  const pins = require('./windows-019-production.cjs'); assert.deepEqual(pins.TARGET, TARGET);
  assert.equal(hash(regular(installer, TARGET.bytes)), TARGET.installer);
  assert.equal(fs.statSync(installer).size, TARGET.bytes);
  for (const baseline of baselines) assert.equal(hash(regular(path.join(input.baselines, baseline.asset), 200 * 1024 * 1024)), baseline.sha256);
  const out = path.resolve('artifacts', `native-suite-${Date.now()}`); rejectLinks(out);
  const f = fixture(process.env, out);
  const stores = [...f.stores, ...f.clients, ...f.untouched];
  const productDirs = ['Creator Hub', 'Creator Works MCP', 'Creator Project Setup', 'CreatorHub', 'creator-hub', 'CreatorProjectSetup']
    .map(name => path.join(process.env.LOCALAPPDATA, name));
  for (const file of [...productDirs, ...stores.map(item => item.path),
    path.join(process.env.APPDATA, 'creator-works-mcp'), path.join(process.env.APPDATA, 'banter-mcp')]) {
    rejectLinks(file); assert.equal(fs.existsSync(file), false, 'Fresh disposable app/settings namespace required');
  }
  const ps = script => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 20000, maxBuffer: 256 * 1024 });
  const registrations = () => JSON.parse(ps(REGISTRATIONS));
  const processes = () => JSON.parse(ps(PROCESSES));
  assert.deepEqual(registrations(), []); assert.deepEqual(processes(), []);
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.mkdirSync(out, { recursive: false });
  const report = reportTemplate(process.env.GITHUB_SHA);
  report.inputBinding = provenance;
  const policyState = path.join(out, 'webview-policy.json');
  const hub = path.join(process.env.LOCALAPPDATA, 'Creator Hub', 'creator-hub.exe');
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/TOKEN|SECRET|PASSWORD|PRIVATE_KEY|SIGNING|CREDENTIAL|AUTHORIZATION|PROXY|^(?:NODE_|WEBVIEW2_|CREATOR_|TAURI_)/i.test(name)));
  let child, browser, page, oldClient, observer, chromium, manifest, live;
  const read = file => regular(file);
  const hubHash = () => hash(regular(hub, 200 * 1024 * 1024));
  const native = action => execFileSync('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/native-window-019.ps1'),
    '-TargetPid', String(child.pid), '-ExpectedExecutable', hub, '-Action', action], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024 });
  const policy = action => execFileSync('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/native-webview-policy.ps1'),
    '-Action', action, '-StateFile', policyState], { windowsHide: true, timeout: 30000 });
  const unchanged = () => { for (const item of stores) assert.deepEqual(read(item.path), item.bytes); };
  let retainedRuntime = [];
  const retained = () => {
    for (const item of f.untouched) assert.deepEqual(read(item.path), item.bytes);
    assert.deepEqual(read(f.stores[2].path), f.stores[2].bytes);
    for (const item of retainedRuntime) assert.equal(hash(regular(item.file, 200 * 1024 * 1024)), item.sha256);
  };
  const verifyBackups = items => {
    for (const item of items) if (item.setupOwned) assert.deepEqual(read(item.path), item.bytes, 'Already-owned Setup entry must be an exact no-op'); else assert.deepEqual(read(backupFile(item.path, item.bytes)), item.bytes, 'Exact original backup required');
  };
  const readStatus = () => page.evaluate(() => window.CreatorHubNative.invoke('convergence_status'));
  const nativeDecision = async approve => {
    const { selected, text } = await retry(() => {
      const windows = JSON.parse(native('snapshot'));
      const selected = assertDialog(windows, child.pid, approve);
      const text = windows.find(item => item.title === 'Move to Hub').controls.map(item => item.name).join('\n');
      assert.ok(text.includes('1 missing project(s); 2 known standalone app location(s).'), 'Native review must bind the actual fixture inventory');
      assert.ok(text.includes('Back up settings first; add missing projects without duplicates'));
      return { selected, text };
    });
    unchanged(); retained();
    assert.deepEqual(registrations().map(item => item.name).sort(), baselines.map(item => item.product).sort());
    assert.equal(hubHash(), TARGET.exe);
    report.nativeDecisions ||= []; report.nativeDecisions.push({ pid: child.pid, executableSha256: hubHash(), reviewText: text.slice(0, 8192), ...selected });
    // Only readiness is retried. Native decisions and page clicks are not replayed.
    ps(dialogCommand(child.pid, hub, selected));
  };
  const connectionDecision = async () => {
    const { managedLocations } = require('./native-managed-target.cjs');
    const router = managedLocations(process.env.LOCALAPPDATA).command;
    const content = connectionReview(f, router);
    const selected = await retry(() => assertConnectionDialog(JSON.parse(native('snapshot')), child.pid, content));
    const active = inspectActiveRoute(process.env.LOCALAPPDATA, manifest);
    assert.ok(active.payload);
    const imported = { ...f.current, channels: [...f.current.channels, f.missingChannel] };
    for (const item of f.stores.slice(0, 2)) assert.deepEqual(JSON.parse(read(item.path)), imported,
      'Project import precedes the client review; the saved server must still be the old one');
    verifyBackups(f.stores); retained();
    for (const item of f.clients) assert.deepEqual(read(item.path), item.bytes, 'No client changes before explicit exception approval');
    assert.equal(hubHash(), TARGET.exe);
    report.connectionExceptionDecisions = [{ ...selected, pid: child.pid, executableSha256: hubHash() }];
    // One explicit approval of captured known fixture paths, not generic modal dismissal.
    ps(dialogCommand(child.pid, hub, selected));
  };
  const serverDecision = async () => {
    assert.ok(f.unverifiedSavedServer); assert.equal(fs.existsSync(f.unverifiedSavedServer), false, 'Never create or execute the unverified fixture server');
    assert.equal(report.connectionExceptionDecisions?.length, 1, 'Client review must complete separately first');
    const active = inspectActiveRoute(process.env.LOCALAPPDATA, manifest);
    const expectedServer = active.payload + path.sep + 'mcp/server/creator-works-mcp.mjs';
    assert.ok(expectedServer.includes('\\') && expectedServer.includes('mcp/server/'));
    const selected = await retry(() => unverifiedServer.assertServerDialog(JSON.parse(native('snapshot')), child.pid, expectedServer));
    const imported = { ...f.current, channels: [...f.current.channels, f.missingChannel] };
    for (const item of f.stores.slice(0, 2)) assert.deepEqual(JSON.parse(read(item.path)), imported, 'No saved server replacement before separate approval');
    verifyBackups(f.stores); retained(); assert.equal(hubHash(), TARGET.exe);
    report.serverRuntimeDecision = [{ ...selected, expectedServer, pid: child.pid, executableSha256: hubHash() }];
    ps(dialogCommand(child.pid, hub, selected));
  };
  const launch = async () => {
    assert.equal(hubHash(), TARGET.exe); assert.deepEqual(processes(), []);
    child = spawn(hub, [], { env: { ...environment,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9238 --remote-debugging-address=127.0.0.1',
      ...(mode === INCOMING_PARENT_MODE ? {} : { WEBVIEW2_USER_DATA_FOLDER: path.join(out, 'webview') }) }, windowsHide: true, stdio: 'ignore' });
    child.on('error', error => { report.launchError = String(error); });
    await retry(() => {
      assert.equal(child.exitCode, null); assert.equal(report.launchError, undefined);
      const state = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/native-startup-diagnostics.ps1')],
        { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 256 * 1024 }).replace(/^\uFEFF/, ''));
      pins.assertOwnedDebugging(state, child.pid, hub);
    });
    browser = await retry(() => chromium.connectOverCDP('http://127.0.0.1:9238'));
    page = await retry(() => {
      const pages = browser.contexts().flatMap(context => context.pages()).filter(view => /^https?:\/\/tauri\.localhost(?:\/|$)/.test(view.url()));
      assert.equal(pages.length, 1); return pages[0];
    });
    rememberGuidePage(live, hub, browser, page);
    page.setDefaultTimeout(45000);
    await page.waitForFunction(() => window.CreatorHubNative?.integratedFeatures === true);
    assert.deepEqual(processes(), [{ ProcessId: child.pid, ParentProcessId: process.pid, ExecutablePath: hub }], 'Only the exact direct Hub process may host the guide');
    assert.equal(page.frames().length, 1); assert.equal(page.context().pages().length, 1);
    assert.equal((await page.locator('.footer-version').innerText()).trim(), TARGET.version);
  };
  const close = async () => {
    await page.waitForFunction(() => { const check = document.querySelector('#check-updates'); return check && !check.disabled; }, null, { timeout: 180000 });
    native('close'); await retry(() => assert.equal(child.exitCode, 0));
    await browser.close(); browser = null; page = null;
    await retry(() => assert.deepEqual(processes(), []));
  };
  try {
    const setupInstall = async () => {
      // Fail missing npm/Python/helper prerequisites before installing any baseline.
      chromium = require('@playwright/test').chromium;
      assert.equal(typeof chromium.connectOverCDP, 'function');
      const sdk = createRequire(path.resolve('product/modules/mcp/package.json'));
      const { Client } = sdk('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = sdk('@modelcontextprotocol/sdk/client/stdio.js');
      assert.equal(typeof Client, 'function'); assert.equal(typeof StdioClientTransport, 'function');
      assert.equal(execFileSync('python', ['-c', "import tomllib; print('tomllib-ready')"],
        { env: environment, encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim(), 'tomllib-ready');
      for (const helper of ['native-window-019.ps1', 'native-webview-policy.ps1', 'native-startup-diagnostics.ps1']) regular(path.resolve('scripts', helper));
      installLegacyBaselines({ baselines, input, environment, report, localAppData: process.env.LOCALAPPDATA, registrations,
        install: (file, baseline, env, output) => require('./windows-019-baseline-diagnostics.cjs').install(file, baseline, env, output, out, installBaseline) });
      const seeded = seedMigrationFixture({ f, stores });
      retainedRuntime = seeded.retainedRuntime;
      const projectBefore = seeded.projectBefore;
      const connect = async entry => {
        const transport = new StdioClientTransport({ ...entry, env: { ...environment, ...entry.env }, stderr: 'pipe' });
        transport.stderr?.resume();
        const client = new Client({ name: 'disposable-direct19-migration', version: '1' });
        try { await client.connect(transport, { timeout: 15000 }); transport.stderr?.resume();
          assert.ok((await client.listTools({}, { timeout: 15000 })).tools.length > 0); return client;
        } catch (error) { await client.close().catch(() => {}); throw error; }
      };
      if (mode === INCOMING_PARENT_MODE) {
        report.incomingProduction = { signedUpdateObserved: false, normalCloseObserved: false, labCleanupObserved: false,
          processCleanupState: 'unverified', processTransfer: false, migrationNetworkObserved: false,
          migrationIsolationProven: false, publicDiscovery: false, migrationProven: false, releaseReady: false };
        report.incomingProduction = runSignedIncomingParent({ environment, out, fixture: seeded.fixture,
          baselineInstaller: path.join(input.baselines, baselines[0].asset), projectBefore, projectImage });
        assert.equal(hubHash(), TARGET.exe); unchanged(); retained();
        manifest = inspectInstalledResources(path.dirname(hub));
        report.installedResourcesVerified = true; report.resourcePins = RESOURCE_PINS;
        assert.deepEqual(registrations().map(item => item.name).sort(), baselines.map(item => item.product).sort());
        oldClient = await connect(f.entry);
      } else {
        ({ manifest, oldClient } = await installMigrationTarget({ installer, environment, hub, hubHash, unchanged, retained,
          report, registrations, baselines, connect, entry: f.entry }));
      }
      return { fixture: seeded.fixture, projectBefore, connect };
    };
    live = { policy, open: launch, launch, close, image: hub, get process() { return child; }, get browser() { return browser; }, get page() { return page; },
      captureOwnership: () => ({ imageSha256: hubHash(), processes: processes(), diagnostics: JSON.parse(execFileSync('powershell.exe',
        ['-NoProfile', '-File', path.resolve('scripts/native-startup-diagnostics.ps1')],
        { encoding: 'utf8', timeout: 20000, windowsHide: true, maxBuffer: 256 * 1024 }).replace(/^\uFEFF/, '')) }),
      get observer() { return observer; }, set observer(value) { observer = value; } };
    await runMigrationPhases(setupInstall, setup => runGuideRestart(setup, { live, f, retry, readStatus, nativeDecision,
      unchanged, retained, report, connectionDecision, serverDecision, verifyBackups, read, manifest, oldClient, registrations, baselines, projectImage, out, hub,
      termsAlreadyAccepted: mode === INCOMING_PARENT_MODE }));
  } catch (error) {
    report.error = report.baselineInstallerFailure ? 'Baseline installer failed; see redacted baselineInstallerFailure.' : String(error.stack || error); process.exitCode = 1;
    if (page) {
      report.guide = await page.locator('#convergence-dialog').innerText().catch(() => null);
      report.openDialogs = await page.evaluate(() => [...document.querySelectorAll('dialog[open]')]
        .map(dialog => ({ id: dialog.id, text: dialog.textContent.slice(0, 8192) }))).catch(() => null);
      try { report.nativeWindows = JSON.parse(native('snapshot')); } catch (captureError) { report.nativeSnapshotError = String(captureError); }
      await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    }
  } finally {
    await cleanupMigration({ observer, oldClient, child, browser, policyState, policy, native, retry, report });
    if (!report.passed) { report.nativeGuideAccepted = false; process.exitCode = 1; }
    // Retain all fixture data, legacy runtime files, before-images and diagnostics.
    fs.writeFileSync(path.join(out, 'migration-016-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ out, passed: report.passed, nativeGuideAccepted: report.nativeGuideAccepted,
      migrationAccepted: false, signedUpdateAccepted: false, releaseReady: false, error: report.error || null }));
  }
  return report;
}

module.exports = { TARGET, CONTEXT, admission, parseArgs, inside, hash, backupFile, fixture, verifyMerged, verifyClient, redactBaselineOutput, baselineFailure, installBaseline, installLegacyBaselines, installMigrationTarget, runMigrationPhases, runGuideRestart, cleanupMigration, productionMigrationMain,
  installerPath, validateProvenance, RESOURCE_PINS, MCP_FILES, INPUT_FILES, resourcePlan, moduleGeneration, verifyActiveReceipt,
  inspectInstalledResources, inspectActiveRoute, assertDialog, connectionReview, assertConnectionDialog, dialogCommand, DIALOG_ACTION, REGISTRATIONS, PROCESSES, reportTemplate, main };
if (require.main === module) main().catch(error => { console.error(String(error.stack || error)); process.exitCode = 1; });
