// Native, disposable-only migration probe. Never run this driver on a user PC.
// Contract: node scripts/native-windows-016-migration.cjs ABS_INSTALLER_OR_DATA_DIR ABS_BASELINES_DIR
// Only Creator.Hub_0.1.16_x64-setup.exe is consumed from the data-only artifact.
// No external payload, build receipt, manifest, signature generation or rebuild.
// The parent must create artifacts/incoming-016/input-binding.json after its
// immutable artifact/run provenance preflight, before invoking this driver.
// Baselines directory: the three exact assets exported by native-installed-baseline.cjs.
// Required lane: validation/windows-menu-merge-20261027, CREATOR_WINDOWS_016_MIGRATION=1.
// Install/update/restart signing and real AI application acceptance remain separate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');

const { TARGET, productProvenance } = require('./windows-incoming-016.cjs');
const CONTEXT = Object.freeze({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
  RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/validation/windows-menu-merge-20261027', CREATOR_WINDOWS_016_MIGRATION: '1' });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Independently frozen from the settings-build-v3 installer payload. The signed runtime
// descriptor binds all nine MCP files; these pins also bind Setup and routing.
const RESOURCE_PINS = Object.freeze({
  'routing/runtime.json': '3e101bb7ee0d9548cec390a4b35a9177b84ae801190a3851762f2e7f6504e40c',
  'routing/runtime.minisig': '1288435da22951b8e3723407cfd8c806da20c5b5d8cb075b94aa865263e16e6f',
  'routing/router.json': '4138e47641b11c3a154577bbc13ec58afcb3a9f97430679a9c51fbcde81f3a00',
  'routing/router.minisig': 'f9fb497a5ea5e2a0cceceffad8efccd3e14e57cfa7d3af1763afc858eaecabb1',
  'routing/creator-hub-mcp-router.exe': 'e03924ba3db7d2331c7d0f5e33f270e220dc720d4d67340e6edd1be573b6cde4',
  'setup/creator-project-setup.exe': '1ef1266ce57b28bf5b0dc9972a1f6c9ea6e95ef7e373a80fcca75a2965339ff4',
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
  for (const key of Object.keys(env)) {
    assert.ok(!/^(?:NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|ALL_PROXY|HTTP_PROXY|HTTPS_PROXY)$/i.test(key), `Refused process override: ${key}`);
    if (/^CREATOR_/i.test(key)) assert.equal(key, 'CREATOR_WINDOWS_016_MIGRATION', 'No product fixture or behavior overrides');
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
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), ['artifactId', 'runId', 'artifactSource', 'archiveSha256', 'harnessSource'].sort());
  for (const field of ['artifactId', 'runId']) assert.ok(Number.isSafeInteger(value[field]) && value[field] > 0);
  assert.match(value.artifactSource, /^[a-f0-9]{40}$/); assert.match(value.archiveSha256, /^[a-f0-9]{64}$/);
  assert.equal(value.harnessSource, revision, 'Artifact preflight must belong to this exact test-source revision');
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
  assert.equal(hash(runtimeBytes), RESOURCE_PINS['routing/runtime.json'], 'Frozen runtime descriptor differs');
  assert.equal(hash(routerBytes), RESOURCE_PINS['routing/router.json'], 'Frozen router descriptor differs');
  const runtime = JSON.parse(runtimeBytes), router = JSON.parse(routerBytes);
  assert.deepEqual(Object.keys(runtime).sort(), ['schemaVersion', 'product', 'hubVersion', 'platform', 'arch', 'module'].sort());
  assert.equal(runtime.schemaVersion, 1); assert.equal(runtime.product, 'com.creatorworks.hub.mcp-runtime');
  assert.equal(runtime.hubVersion, TARGET.version); assert.equal(runtime.platform, 'windows'); assert.equal(runtime.arch, 'x86_64');
  assert.deepEqual(Object.keys(runtime.module).sort(), ['executable', 'version', 'files'].sort());
  assert.equal(runtime.module.executable, 'mcp/creator-works-mcp-launcher.exe'); assert.equal(runtime.module.version, '2.7.7');
  assert.deepEqual(Object.keys(runtime.module.files).sort(), [...MCP_FILES].sort());
  for (const digest of Object.values(runtime.module.files)) assert.match(digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(router, { schemaVersion: 1, product: 'com.creatorworks.hub.mcp-router', platform: 'windows', arch: 'x86_64',
    protocol: 1, sha256: RESOURCE_PINS['routing/creator-hub-mcp-router.exe'] });
  return { schemaVersion: 1, platform: 'windows', arch: 'x86_64', modules: { mcp: runtime.module,
    setup: { executable: 'setup/creator-project-setup.exe', version: '0.3.7',
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
  return { projectA, projectB, oldRoot, oldServer, oldNode, current, legacy, missingChannel, stores, clients, untouched, entry };
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
    + ['Codex', 'Claude Code', 'Claude Desktop'].map(name => `${name}\nCommand: ${f.oldNode}\nServer: ${f.oldServer}\nProject kept: ${f.projectA}`).join('\n\n')
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
  const connection = selected.title === 'Review unverified MCP connections' && selected.id === 1000 && selected.name === 'Move reviewed connections';
  assert.ok(guide || connection, 'Only fixed guide/connection decisions are admitted');
  if (connection) assert.ok(typeof selected.content === 'string' && selected.content.length > 0 && selected.content.length <= 8192);
  assert.ok(path.win32.isAbsolute(executable) && !/[\0\r\n]/.test(executable));
  const quote = text => `'${text.replaceAll("'", "''")}'`;
  return `$targetPid=${pid};$expectedExecutable=${quote(executable)};$dialogHandle=${selected.handle};$buttonId=${selected.id};$buttonName=${quote(selected.name)};$expectedTitle=${quote(selected.title)};$expectedContent=${quote(connection ? selected.content : '')};\n${DIALOG_ACTION}`;
}

function reportTemplate(testSource) {
  return { schemaVersion: 1, scope: 'exact-direct16-three-client-clean-legacy-guide-probe',
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

async function main(args = process.argv.slice(2)) {
  // Admission precedes reads, installation, fixture creation, policy or UI calls.
  admission();
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
  const provenanceFile = path.resolve('artifacts/incoming-016/input-binding.json'); rejectLinks(provenanceFile);
  const provenance = validateProvenance(JSON.parse(regular(provenanceFile, 4096)), process.env.GITHUB_SHA);
  const pins = require('./windows-incoming-016.cjs'); assert.deepEqual(pins.TARGET, TARGET);
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
  let child, browser, page, oldClient, observer, chromium, manifest;
  const read = file => regular(file);
  const hubHash = () => hash(regular(hub, 200 * 1024 * 1024));
  const native = action => execFileSync('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/native-window.ps1'),
    '-TargetPid', String(child.pid), '-ExpectedExecutable', hub, '-Action', action], { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 256 * 1024 });
  const policy = action => execFileSync('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/native-webview-policy.ps1'),
    '-Action', action, '-StateFile', policyState], { windowsHide: true, timeout: 30000 });
  const unchanged = () => { for (const item of stores) assert.deepEqual(read(item.path), item.bytes); };
  let retainedRuntime = [], retainedAfter;
  const retained = () => {
    for (const item of f.untouched) assert.deepEqual(read(item.path), item.bytes);
    assert.deepEqual(read(f.stores[2].path), f.stores[2].bytes);
    for (const item of retainedRuntime) assert.equal(hash(regular(item.file, 200 * 1024 * 1024)), item.sha256);
  };
  const verifyBackups = items => {
    for (const item of items) assert.deepEqual(read(backupFile(item.path, item.bytes)), item.bytes, 'Exact original backup required');
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
  const launch = async () => {
    assert.equal(hubHash(), TARGET.exe); assert.deepEqual(processes(), []);
    child = spawn(hub, [], { env: { ...environment,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9238 --remote-debugging-address=127.0.0.1',
      WEBVIEW2_USER_DATA_FOLDER: path.join(out, 'webview') }, windowsHide: true, stdio: 'ignore' });
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
    // Fail missing npm/Python/helper prerequisites before installing any baseline.
    chromium = require('@playwright/test').chromium;
    assert.equal(typeof chromium.connectOverCDP, 'function');
    const sdk = createRequire(path.resolve('modules/mcp/package.json'));
    const { Client } = sdk('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = sdk('@modelcontextprotocol/sdk/client/stdio.js');
    assert.equal(typeof Client, 'function'); assert.equal(typeof StdioClientTransport, 'function');
    assert.equal(execFileSync('python', ['-c', "import tomllib; print('tomllib-ready')"],
      { env: environment, encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim(), 'tomllib-ready');
    for (const helper of ['native-window.ps1', 'native-webview-policy.ps1', 'native-startup-diagnostics.ps1']) regular(path.resolve('scripts', helper));
    report.baselines = [];
    for (const baseline of baselines) {
      execFileSync(path.join(input.baselines, baseline.asset), ['/S', '/NS'], { env: environment, windowsHide: true, timeout: 180000, stdio: 'pipe' });
      report.baselines.push({ product: baseline.product, version: baseline.version, installerSha256: baseline.sha256,
        executableSha256: hash(regular(path.join(process.env.LOCALAPPDATA, baseline.product, baseline.binary), 200 * 1024 * 1024)) });
    }
    const beforeInstall = registrations();
    assert.equal(beforeInstall.length, 3);
    for (const item of baselines) assert.equal(beforeInstall.find(value => value.name === item.product && value.hive === 'HKCU:')?.version, item.version);
    for (const project of [f.projectA, f.projectB]) {
      for (const directory of ['Assets', 'ProjectSettings', 'Packages']) fs.mkdirSync(path.join(project, directory), { recursive: true });
      fs.writeFileSync(path.join(project, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.21f1\n', { flag: 'wx' });
      fs.writeFileSync(path.join(project, 'Packages', 'manifest.json'), '{"dependencies":{}}\n', { flag: 'wx' });
      f.untouched.push({ path: path.join(project, 'Assets', 'AuthoredContent.txt'), bytes: Buffer.from('Never modify a Unity project during migration\n') });
    }
    for (const item of [...stores, ...f.untouched.filter(item => !stores.includes(item))]) {
      rejectLinks(item.path); assert.equal(fs.existsSync(item.path), false);
      fs.mkdirSync(path.dirname(item.path), { recursive: true }); fs.writeFileSync(item.path, item.bytes, { flag: 'wx' });
    }
    retainedRuntime = fs.readdirSync(path.join(f.oldRoot, 'server'), { recursive: true, withFileTypes: true })
      .filter(item => item.isFile()).map(item => {
        const file = path.join(item.parentPath || item.path, item.name); return { file, sha256: hash(regular(file, 200 * 1024 * 1024)) };
      });
    assert.equal(retainedRuntime.length, 9, 'Exact baseline server inventory required');
    const projectBefore = projectImage([f.projectA, f.projectB]);
    const connect = async entry => {
      const transport = new StdioClientTransport({ ...entry, env: { ...environment, ...entry.env }, stderr: 'pipe' });
      transport.stderr?.resume();
      const client = new Client({ name: 'disposable-direct16-migration', version: '1' });
      try { await client.connect(transport, { timeout: 15000 }); transport.stderr?.resume();
        assert.ok((await client.listTools({}, { timeout: 15000 })).tools.length > 0); return client;
      } catch (error) { await client.close().catch(() => {}); throw error; }
    };
    execFileSync(installer, ['/UPDATE', '/S', '/NS'], { env: environment, windowsHide: true, timeout: 180000, stdio: 'pipe' });
    assert.equal(hubHash(), TARGET.exe); unchanged(); retained();
    manifest = inspectInstalledResources(path.dirname(hub));
    report.installedResourcesVerified = true; report.resourcePins = RESOURCE_PINS;
    assert.deepEqual(registrations().map(item => item.name).sort(), baselines.map(item => item.product).sort());
    oldClient = await connect(f.entry);
    report.checks.push('Pinned baseline installers and exact direct16 payload installed; original stores/clients retained and old SDK transport connected before native migration');
    policy('Enable'); await launch();
    await page.locator('#usage-terms-dialog').waitFor({ state: 'visible' });
    await page.locator('#usage-terms-checkbox').check(); await page.locator('#usage-terms-continue').click();
    await page.locator('#usage-terms-dialog').waitFor({ state: 'hidden' });
    await page.locator('#convergence-move').waitFor({ state: 'visible' });
    const initial = await retry(readStatus);
    assert.equal(initial.streamlined, true); assert.equal(initial.stage, 'review'); assert.equal(initial.required, true);
    assert.deepEqual(initial.backups, []);
    await page.locator('#convergence-move').click(); await nativeDecision(false);
    await page.waitForFunction(() => document.querySelector('#convergence-dialog')?.getAttribute('aria-busy') === 'false');
    unchanged(); retained();
    const cancelled = await readStatus(); assert.equal(cancelled.stage, 'review'); assert.deepEqual(cancelled.backups, []);
    for (const item of [...f.stores, ...f.clients]) assert.equal(fs.existsSync(backupFile(item.path, item.bytes)), false);
    report.cancelAccepted = true;
    // Observation is deliberately not advertised as atomic before-write proof.
    const observed = new Map(); let observationError;
    const sample = () => {
      try {
        for (const item of [...f.stores.slice(0, 2), ...f.clients]) {
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
    observer = setInterval(sample, 20);
    await page.locator('#convergence-move').click(); await nativeDecision(true);
    await connectionDecision();
    await page.locator('#convergence-title').filter({ hasText: /^Move complete$/ }).waitFor({ timeout: 180000 });
    sample(); clearInterval(observer); observer = null;
    if (observationError) throw observationError;
    assert.equal(observed.size, 5); report.backupsPresentAtFirstObservedChange = [...observed.values()];
    const completed = await readStatus(); assert.equal(completed.stage, 'complete'); assert.equal(completed.required, false);
    assert.deepEqual(completed.legacyApps, []); verifyBackups([...f.stores, ...f.clients]); retained();
    const current = read(f.stores[0].path), earlier = read(f.stores[1].path);
    const server = JSON.parse(current).mcp_server_path;
    assert.equal(hash(regular(server, 64 * 1024 * 1024)), manifest.modules.mcp.files['mcp/server/creator-works-mcp.mjs']);
    const active = inspectActiveRoute(process.env.LOCALAPPDATA, manifest);
    assert.equal(fs.realpathSync(server), fs.realpathSync(path.join(active.payload, 'mcp/server/creator-works-mcp.mjs')));
    report.activeRoute = active;
    verifyMerged(f, current, earlier, server);
    const { managedLocations, verifyMigratedTarget } = require('./native-managed-target.cjs');
    const route = managedLocations(process.env.LOCALAPPDATA), migrated = [];
    for (const item of f.clients) {
      const document = item.id === 'codex' ? JSON.parse(execFileSync('python', ['-c',
        "import json,sys,tomllib; print(json.dumps(tomllib.load(open(sys.argv[1],'rb'))))", item.path],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 })) : JSON.parse(read(item.path));
      const entry = verifyClient(f, item, document, route.command);
      if (item.id === 'codex') assert.match(read(item.path).toString('utf8'), /^# Keep this comment\r?\n/);
      verifyMigratedTarget(entry, manifest, null, process.env.LOCALAPPDATA); migrated.push(entry);
      const client = await connect(entry); await client.close();
    }
    assert.ok((await oldClient.listTools({}, { timeout: 15000 })).tools.length > 0);
    const reconnectOld = await connect(f.entry); await reconnectOld.close();
    assert.deepEqual(registrations(), [{ hive: 'HKCU:', name: 'Creator Hub', version: TARGET.version }]);
    for (const baseline of baselines.slice(1)) for (const name of [baseline.binary, 'uninstall.exe']) {
      assert.equal(fs.existsSync(path.join(process.env.LOCALAPPDATA, baseline.product, name)), false);
    }
    assert.deepEqual(projectImage([f.projectA, f.projectB]), projectBefore, 'Migration may not edit or add Unity project files');
    report.checks.push('Single-guide native approval completed import/routing/retirement; exact backups, current preferences, unknown fields, projects, three clients and compatibility runtime verified');
    await page.screenshot({ path: path.join(out, 'migration-complete.png') });
    await page.locator('#convergence-later').click();
    retainedAfter = [...f.stores, ...f.clients, ...f.untouched].map(item => ({ file: item.path, bytes: read(item.path) }));
    await close(); await launch();
    await page.waitForFunction(() => { const check = document.querySelector('#check-updates'); return check && !check.disabled; }, null, { timeout: 180000 });
    const repeated = await retry(readStatus);
    assert.equal(repeated.required, false); assert.deepEqual(repeated.legacyApps, []);
    assert.equal(await page.locator('#convergence-dialog').isVisible(), false);
    assert.equal(await page.locator('#usage-terms-dialog').isVisible(), false);
    for (const item of retainedAfter) assert.deepEqual(read(item.file), item.bytes);
    retained(); verifyBackups([...f.stores, ...f.clients]);
    assert.deepEqual(inspectActiveRoute(process.env.LOCALAPPDATA, manifest), active);
    inspectInstalledResources(path.dirname(hub));
    assert.deepEqual(projectImage([f.projectA, f.projectB]), projectBefore);
    assert.deepEqual(registrations(), [{ hive: 'HKCU:', name: 'Creator Hub', version: TARGET.version }]);
    assert.ok((await oldClient.listTools({}, { timeout: 15000 })).tools.length > 0);
    for (const entry of [f.entry, ...migrated]) { const client = await connect(entry); await client.close(); }
    await close();
    assert.equal(report.nativeDecisions.length, 2, 'One native cancellation and one native approval; no additional decisions');
    report.checks.push('Normal close/relaunch is idempotent: no repeated guide/terms, no settings reset, old live transport and all managed routes reconnect');
    report.nativeGuideAccepted = true; report.repeatStartupAccepted = true; report.settingsPreserved = true;
    report.passed = true;
  } catch (error) {
    report.error = String(error.stack || error); process.exitCode = 1;
    if (page) {
      report.guide = await page.locator('#convergence-dialog').innerText().catch(() => null);
      report.openDialogs = await page.evaluate(() => [...document.querySelectorAll('dialog[open]')]
        .map(dialog => ({ id: dialog.id, text: dialog.textContent.slice(0, 8192) }))).catch(() => null);
      try { report.nativeWindows = JSON.parse(native('snapshot')); } catch (captureError) { report.nativeSnapshotError = String(captureError); }
      await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    }
  } finally {
    if (observer) clearInterval(observer);
    if (oldClient) try { await oldClient.close(); } catch (error) { report.sdkCleanupError = String(error); report.passed = false; }
    if (child?.exitCode === null) {
      try { native('close'); await retry(() => assert.equal(child.exitCode, 0), 15); }
      catch (error) { report.closeError = String(error); report.passed = false; child.unref(); }
    }
    if (browser) await browser.close().catch(error => { report.browserCloseError = String(error); report.passed = false; });
    try { if (fs.existsSync(policyState)) policy('Restore'); report.policyRestored = true; }
    catch (error) { report.policyError = String(error); report.passed = false; }
    if (!report.passed) { report.nativeGuideAccepted = false; process.exitCode = 1; }
    // Retain all fixture data, legacy runtime files, before-images and diagnostics.
    fs.writeFileSync(path.join(out, 'migration-016-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ out, passed: report.passed, nativeGuideAccepted: report.nativeGuideAccepted,
      migrationAccepted: false, signedUpdateAccepted: false, releaseReady: false, error: report.error || null }));
  }
  return report;
}

module.exports = { TARGET, CONTEXT, admission, parseArgs, inside, hash, backupFile, fixture, verifyMerged, verifyClient,
  installerPath, validateProvenance, RESOURCE_PINS, MCP_FILES, INPUT_FILES, resourcePlan, moduleGeneration, verifyActiveReceipt,
  inspectInstalledResources, inspectActiveRoute, assertDialog, connectionReview, assertConnectionDialog, dialogCommand, DIALOG_ACTION, REGISTRATIONS, PROCESSES, reportTemplate, main };
if (require.main === module) main().catch(error => { console.error(String(error.stack || error)); process.exitCode = 1; });
