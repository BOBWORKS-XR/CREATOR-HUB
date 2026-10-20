const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const driver = require('./native-windows-016-migration.cjs');
const context = { ...driver.CONTEXT, GITHUB_SHA: 'a'.repeat(40) };
const env = { USERPROFILE: 'C:\\Users\\runneradmin', APPDATA: 'C:\\Users\\runneradmin\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\runneradmin\\AppData\\Local' };
const f = () => driver.fixture(env, 'D:\\a\\CREATOR-HUB\\artifacts\\native-suite-123', path.win32);
const clone = value => JSON.parse(JSON.stringify(value));

test('migration is fenced to one explicit hosted Windows branch and opt-in', () => {
  driver.admission(context, 'win32');
  assert.throws(() => driver.admission(context, 'linux'));
  assert.throws(() => driver.admission(context, 'darwin'));
  for (const key of Object.keys(context)) {
    assert.throws(() => driver.admission({ ...context, [key]: undefined }, 'win32'), key);
    assert.throws(() => driver.admission({ ...context, [key]: 'foreign' }, 'win32'), key);
  }
});

test('behavior overrides, external debugger and TLS/proxy bypasses are refused before native work', () => {
  for (const key of ['CREATOR_HOSTED_UPDATE_FIXTURE', 'CREATOR_OTHER', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED',
    'NODE_EXTRA_CA_CERTS', 'ALL_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE', 'WEBVIEW2_USER_DATA_FOLDER', 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS']) {
    assert.throws(() => driver.admission({ ...context, [key]: 'foreign' }, 'win32'), key);
  }
});

test('CLI refuses local execution before input access, installation, policy or UI', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'native-windows-016-migration.cjs'), 'missing', 'missing'],
    { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 1); assert.match(result.stderr, /Refused runner context|requires Windows/);
  assert.doesNotMatch(result.stderr, /ENOENT|Cannot find module|powershell|installer\.exe/);
});

test('only absolute installer/file-directory input and a distinct baseline directory can be selected', () => {
  assert.deepEqual(driver.parseArgs(['C:\\candidate', 'C:\\baselines'], path.win32), { candidate: 'C:\\candidate', baselines: 'C:\\baselines' });
  for (const args of [[], ['C:\\candidate'], ['candidate', 'C:\\baseline'], ['C:\\one', 'c:\\ONE'],
    ['C:\\one', 'C:\\two', '--override'], ['C:\\one\n', 'C:\\two']]) assert.throws(() => driver.parseArgs(args, path.win32));
  assert.equal(driver.inside('C:\\job', 'C:\\job\\stage', path.win32), true);
  for (const value of ['C:\\job', 'C:\\job-other\\stage', 'C:\\elsewhere', 'D:\\stage']) assert.equal(driver.inside('C:\\job', value, path.win32), false);
});

test('data-only file and directory forms resolve only the exact canonical installer', () => {
  assert.equal(driver.installerPath('C:\\data', true, path.win32), `C:\\data\\${driver.TARGET.asset}`);
  assert.equal(driver.installerPath(`C:\\data\\${driver.TARGET.asset}`, false, path.win32), `C:\\data\\${driver.TARGET.asset}`);
  for (const name of ['installer.exe', 'other.exe', 'Creator.Hub_0.1.16_f9f0e1e_x64-setup.exe']) {
    assert.throws(() => driver.installerPath(`C:\\data\\${name}`, false, path.win32));
  }
  assert.deepEqual(driver.INPUT_FILES, [driver.TARGET.asset, 'creator-hub-windows-x86_64.json', 'creator-hub-windows-x86_64.json.minisig', 'latest.json']);
});

test('exact frozen installer and installer-extracted EXE pins remain independent of optional signed input files', () => {
  assert.equal(driver.TARGET.installer, 'f0092e056f7b4245d10350b7954c3dbe5e5356f2e340143d0aefb80078672bc7');
  assert.equal(driver.TARGET.exe, '8e140ba93190bb717ea30587dbb9dcf4e1c40bf7c1d08ca06b2da947e3b6d30b');
  assert.equal(driver.TARGET.productSource, 'f9f0e1e5cb27b3ae5178c8aac16429e83ba34593');
  assert.equal(driver.TARGET.bytes, 37980864);
  assert.equal(driver.TARGET.asset, 'Creator.Hub_0.1.16_x64-setup.exe');
  assert.equal(Object.isFrozen(driver.TARGET), true);
});

test('immutable artifact preflight is required for this exact code revision before native work', () => {
  const proof = { artifactId: 123, runId: 456, artifactSource: 'b'.repeat(40), archiveSha256: 'c'.repeat(64), harnessSource: context.GITHUB_SHA };
  assert.deepEqual(driver.validateProvenance(proof, context.GITHUB_SHA), proof);
  for (const key of Object.keys(proof)) {
    const missing = { ...proof }; delete missing[key]; assert.throws(() => driver.validateProvenance(missing, context.GITHUB_SHA));
    assert.throws(() => driver.validateProvenance({ ...proof, [key]: null }, context.GITHUB_SHA));
  }
  for (const changed of [{ ...proof, artifactId: '123' }, { ...proof, runId: 0 }, { ...proof, artifactId: 1.5 },
    { ...proof, harnessSource: 'd'.repeat(40) }, { ...proof, artifactSource: 'unknown' }, { ...proof, extra: 'not authority' }]) {
    assert.throws(() => driver.validateProvenance(changed, context.GITHUB_SHA));
  }
});

// Exact small public metadata from the immutable f9 payload, not a synthesized
// build receipt. Both strings are independently hash-pinned by the driver.
const runtimeBytes = Buffer.from('{"schemaVersion":1,"product":"com.creatorworks.hub.mcp-runtime","hubVersion":"0.1.16","platform":"windows","arch":"x86_64","module":{"executable":"mcp/creator-works-mcp-launcher.exe","version":"2.7.7","files":{"mcp/creator-works-mcp-launcher.exe":"2404030a96150ef8534ccd467f6cc5712175f848d413e1c6f704adcc39b1dadb","mcp/server/LICENSE":"7e1bc8fb937a3324de67fb2439b8e943dda3efc6b62684da2697e1bfcfe7414e","mcp/server/THIRD_PARTY_NOTICES.md":"4a4fb0b35a2ace85eb634cddc5acab3152d570481e0efabc5369550370eb25b7","mcp/server/creator-works-mcp.mjs":"62d410eba4d81646a35ee274b5904a17287026bdc4d765426d6cf3b07d04141a","mcp/server/runtime/LICENSE":"8efdacdc1cfa3460aeb7fe98e3c54337b971d5da70e6eee292b73b981acb220c","mcp/server/runtime/VERSION":"98182b41c9ce3357797985cf12dc3b0124490ef88bc918a905373e7688e6aec9","mcp/server/runtime/node.exe":"c6335d08331c23d68b9f2b18adb102002d76ef150b47248e954c507e0d033664","mcp/server/unity-extension/Editor/BanterMCPBridge.cs":"0fbae419bb9e1a88d6d86404708d0e84414796bbb4fdbb95874ca88a4f93d1c2","mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png":"f3f68baa0d887de92e6cf7aba8beae7ff8ea5c44b13444f018413041ade19ea7"}}}');
const routerBytes = Buffer.from('{"schemaVersion":1,"product":"com.creatorworks.hub.mcp-router","platform":"windows","arch":"x86_64","protocol":1,"sha256":"e03924ba3db7d2331c7d0f5e33f270e220dc720d4d67340e6edd1be573b6cde4"}');

test('installed small descriptors bind all MCP, Setup, router, metadata and signature images', () => {
  const plan = driver.resourcePlan(runtimeBytes, routerBytes);
  assert.equal(plan.modules.mcp.version, '2.7.7'); assert.equal(plan.modules.setup.version, '0.3.7');
  assert.deepEqual(Object.keys(plan.modules.mcp.files).sort(), [...driver.MCP_FILES].sort());
  assert.equal(Object.keys(driver.RESOURCE_PINS).length, 6);
  for (const digest of Object.values(driver.RESOURCE_PINS)) assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(Object.isFrozen(driver.RESOURCE_PINS), true);
  for (const [runtime, router] of [[Buffer.from('{}'), routerBytes], [runtimeBytes, Buffer.from('{}')],
    [Buffer.concat([runtimeBytes, Buffer.from('\n')]), routerBytes], [runtimeBytes, Buffer.concat([routerBytes, Buffer.from(' ')])]]) {
    assert.throws(() => driver.resourcePlan(runtime, router));
  }
  const changed = JSON.parse(runtimeBytes); changed.hubVersion = '0.1.15';
  assert.throws(() => driver.resourcePlan(Buffer.from(JSON.stringify(changed)), routerBytes));
});

test('active route must bind the frozen signed descriptor and exact canonical generation', () => {
  const plan = driver.resourcePlan(runtimeBytes, routerBytes);
  const expected = { schemaVersion: 1, descriptorSha256: driver.RESOURCE_PINS['routing/runtime.json'], generation: driver.moduleGeneration(plan.modules.mcp) };
  assert.match(expected.generation, /^[a-f0-9]{64}$/);
  assert.equal(driver.verifyActiveReceipt(expected, plan), expected.generation);
  for (const key of Object.keys(expected)) {
    const altered = { ...expected, [key]: key === 'schemaVersion' ? 2 : 'a'.repeat(64) };
    assert.throws(() => driver.verifyActiveReceipt(altered, plan));
  }
  assert.throws(() => driver.verifyActiveReceipt({ ...expected, extra: true }, plan));
  const shuffled = { ...plan.modules.mcp, files: Object.fromEntries(Object.entries(plan.modules.mcp.files).reverse()) };
  assert.equal(driver.moduleGeneration(shuffled), expected.generation, 'Match Rust BTreeMap generation ordering');
});

test('representative settings differ, contain aliases/missing repeats, and select current preferences', () => {
  const data = f();
  assert.equal(data.current.channels.length, 1); assert.equal(data.legacy.channels.length, 3);
  assert.equal(path.win32.normalize(data.legacy.channels[0].unity_project_path).toLowerCase().replace(/[\\/]+$/, ''),
    path.win32.normalize(data.current.channels[0].unity_project_path).toLowerCase());
  assert.equal(data.legacy.channels[1].unity_project_path, data.legacy.channels[2].unity_project_path);
  assert.notEqual(data.current.active_channel_id, data.legacy.active_channel_id);
  assert.notEqual(data.current.auto_start, data.legacy.auto_start);
  assert.notEqual(data.current.allow_all_tests, data.legacy.allow_all_tests);
  assert.notDeepEqual(data.current.futurePreference, data.legacy.futurePreference);
  assert.equal(data.clients.length, 3); assert.equal(data.stores.length, 3);
  assert.ok(data.untouched.some(item => item.path.endsWith('future-settings.bin')));
  assert.ok(data.untouched.some(item => item.path.endsWith('opencode.jsonc')));
});

test('Hub preferences fixture matches the accepted production Record schema and exact false/false/true flags', () => {
  const data = f();
  const file = data.untouched.find(item => item.path === path.win32.join(env.LOCALAPPDATA, 'CreatorHub', 'preferences', 'hub-preferences.json'));
  assert.ok(file, 'Use the real Hub preferences store, not an opaque sentinel path');
  const document = JSON.parse(file.bytes);
  assert.deepEqual(document, { schemaVersion: 1, preview: false, autoDownload: false, restoreHostedViews: true });
  const rust = fs.readFileSync(path.join(__dirname, '../src-tauri/src/preferences.rs'), 'utf8');
  const record = rust.match(/#\[serde\(rename_all = "camelCase", deny_unknown_fields\)\]\s*struct Record \{([\s\S]*?)\r?\n\}/);
  assert.ok(record, 'Bind the fixture to the strict production preferences record');
  const fields = [...record[1].matchAll(/^\s*(\w+):\s*(u32|Option<bool>),/gm)]
    .map(match => match[1].replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()));
  assert.deepEqual(Object.keys(document).sort(), fields.sort(), 'No obsolete or unknown main preference fields');
  assert.match(rust, /if record\.schema_version != 1/);
  assert.ok(Object.hasOwn(data.current, 'futurePreference'), 'Unknown-field preservation remains covered in MCP settings');
  assert.ok(data.untouched.some(item => item.path.endsWith('future-settings.bin')));
});

function merged(data) {
  return { ...data.current, channels: [...data.current.channels, data.missingChannel], mcp_server_path: 'C:\\Hub\\server\\creator-works-mcp.mjs' };
}

test('merged settings oracle verifies missing project import once and every current field', () => {
  const data = f(), expected = merged(data), bytes = Buffer.from(JSON.stringify(expected));
  driver.verifyMerged(data, bytes, bytes, expected.mcp_server_path);
  const changes = [
    value => { value.auto_start = true; },
    value => { value.active_channel_id = data.missingChannel.id; },
    value => { value.allow_all_tests = true; },
    value => { delete value.futurePreference; },
    value => { value.futurePreference.keep = true; },
    value => { value.channels.pop(); },
    value => { value.channels.push(data.missingChannel); },
    value => { value.channels[0].enabled = true; },
    value => { value.oldOnlyPreference = 'unexpected legacy preference'; },
  ];
  for (const change of changes) {
    const altered = clone(expected); change(altered);
    assert.throws(() => driver.verifyMerged(data, Buffer.from(JSON.stringify(altered)), bytes, expected.mcp_server_path));
    assert.throws(() => driver.verifyMerged(data, bytes, Buffer.from(JSON.stringify(altered)), expected.mcp_server_path));
  }
  assert.throws(() => driver.verifyMerged(data, bytes, bytes, data.oldServer));
});

test('content-addressed backup names bind exact original bytes including line endings', () => {
  const file = 'C:\\Users\\runneradmin\\AppData\\Roaming\\banter-mcp\\launcher-config.json';
  const first = driver.backupFile(file, Buffer.from('original\r\n'), path.win32);
  assert.equal(path.win32.dirname(first), path.win32.join(path.win32.dirname(file), '.creator-hub-settings-backups'));
  assert.ok(first.endsWith(`launcher-config.json.${driver.hash(Buffer.from('original\r\n'))}.bak`));
  assert.notEqual(first, driver.backupFile(file, Buffer.from('original\n'), path.win32));
});

function changedClient(item, router) {
  const entry = { ...item.entry, command: router, args: [],
    env: { ...item.entry.env, CREATOR_WORKS_CONFIG_OWNER: 'creator-hub-v1' } };
  if (item.id === 'codex') return { model: 'keep', future_root: 'untouched', mcp_servers: {
    other: { command: 'unrelated-server', args: ['keep'] }, 'creator-works': entry } };
  const document = JSON.parse(item.bytes); document.mcpServers['creator-works'] = entry; return document;
}

test('three client oracles accept only the reviewed route and exact source-defined ownership marker', () => {
  const ownership = fs.readFileSync(path.join(__dirname, '../modules/mcp/launcher/src-tauri/src/client_ownership.rs'), 'utf8');
  assert.ok(ownership.includes('OWNER_KEY: &str = "CREATOR_WORKS_CONFIG_OWNER"'));
  assert.ok(ownership.includes('OWNER: &str = "creator-hub-v1"'));
  const data = f(), router = 'C:\\managed\\creator-hub-mcp-router.exe';
  for (const item of data.clients) {
    const expected = changedClient(item, router);
    driver.verifyClient(data, item, expected, router);
    for (const mutation of ['root', 'other', 'project', 'timeout', 'env', 'args', 'missing-owner', 'foreign-owner', 'extra-env']) {
      const changed = clone(expected), servers = changed.mcp_servers || changed.mcpServers;
      if (mutation === 'root') delete changed[item.id === 'codex' ? 'future_root' : 'futureRoot'];
      if (mutation === 'other') delete servers.other;
      if (mutation === 'project') servers['creator-works'].env.UNITY_PROJECT_PATH = data.projectB;
      if (mutation === 'timeout') servers['creator-works'].timeout = 1;
      if (mutation === 'env') delete servers['creator-works'].env.CUSTOM_SETTING;
      if (mutation === 'args') servers['creator-works'].args = [data.oldServer];
      if (mutation === 'missing-owner') delete servers['creator-works'].env.CREATOR_WORKS_CONFIG_OWNER;
      if (mutation === 'foreign-owner') servers['creator-works'].env.CREATOR_WORKS_CONFIG_OWNER = 'foreign';
      if (mutation === 'extra-env') servers['creator-works'].env.UNREVIEWED = 'not allowed';
      assert.throws(() => driver.verifyClient(data, item, changed, router), `${item.id}: ${mutation}`);
    }
  }
});

const snapshot = (approve = true) => [{ title: 'Creator Hub - Development Preview', class: 'Tauri Window', handle: 11, controls: [] },
  { title: 'Move to Hub', class: '#32770', handle: 1234, controls: [
    { name: approve ? 'Move to Hub' : 'Not now', id: approve ? 'CommandButton_1000' : 'CommandButton_1001', processId: 123 },
  ] }];

test('native decisions require one exact task dialog and observed owned UIA button ID', () => {
  for (const approve of [true, false]) {
    const windows = snapshot(approve);
    const selected = driver.assertDialog(windows, 123, approve);
    assert.equal(selected.id, approve ? 1000 : 1001);
    assert.equal(selected.name, approve ? 'Move to Hub' : 'Not now');
    const changes = [
      value => { value[1].title = 'Enable MCP controls'; },
      value => { value[1].class = 'Fake Window'; },
      value => { value[1].handle = 0; },
      value => { value[1].controls[0].processId = 456; },
      value => { value[1].controls[0].id = 'CommandButton_9999'; },
      value => { value[1].controls.push(value[1].controls[0]); },
      value => { value.push(value[1]); },
    ];
    for (const change of changes) { const altered = clone(windows); change(altered); assert.throws(() => driver.assertDialog(altered, 123, approve)); }
  }
});

test('native command is finite, quotes image paths, and rechecks native ownership at action time', () => {
  const selected = driver.assertDialog(snapshot(), 123, true);
  const command = driver.dialogCommand(123, "C:\\owned's folder\\creator-hub.exe", selected);
  assert.ok(command.includes("$expectedExecutable='C:\\owned''s folder\\creator-hub.exe'"));
  for (const required of ['GetWindowThreadProcessId', 'GetWindowText', 'GetClassName', 'IsWindowVisible',
    '$b.Current.ProcessId', '$b.Current.AutomationId', '$b.Current.IsEnabled', '$b.Current.IsOffscreen', '0x466']) assert.ok(command.includes(required), required);
  assert.equal(command.match(/::PostMessage\(/g).length, 1);
  assert.throws(() => driver.dialogCommand(0, 'C:\\owned.exe', selected));
  assert.throws(() => driver.dialogCommand(123, 'relative.exe', selected));
  assert.throws(() => driver.dialogCommand(123, 'C:\\owned.exe', { ...selected, name: 'Run arbitrary action' }));
  assert.throws(() => driver.dialogCommand(123, 'C:\\owned.exe', { ...selected, id: 9999 }));
  assert.throws(() => driver.dialogCommand(123, 'C:\\owned.exe', { ...selected, title: 'Some other dialog' }));
});

test('unsigned legacy connections require an exact separate path-bound review, not generic modal approval', () => {
  const f = driver.fixture({ LOCALAPPDATA: 'C:\\Local', APPDATA: 'C:\\Roaming', USERPROFILE: 'C:\\Home' }, 'C:\\fixture', path.win32);
  const content = driver.connectionReview(f, 'C:\\verified\\router.exe');
  const windows = [{ class: '#32770', title: 'Review unverified MCP connections', handle: 1234, controls: [
    { id: 'ContentText', name: content, processId: 123 },
    { id: 'CommandButton_1000', name: 'Move reviewed connections', processId: 123 },
  ] }];
  const selected = driver.assertConnectionDialog(windows, 123, content);
  const command = driver.dialogCommand(123, 'C:\\owned.exe', selected);
  assert.ok(command.includes("$expectedTitle='Review unverified MCP connections'"));
  assert.ok(command.includes('$texts[0].Current.Name -cne $expectedContent'));
  assert.ok(command.includes('$texts[0].Current.ProcessId -ne $targetPid'));
  assert.throws(() => driver.assertDialog(windows, 123, true));
  for (const change of [
    value => { value[0].title = 'Move to Hub'; },
    value => { value[0].controls[0].name = content.replace('verified', 'untrusted'); },
    value => { value[0].controls[0].processId = 456; },
    value => { value[0].controls.push(value[0].controls[0]); },
    value => { value[0].controls[1].name = 'Yes'; },
    value => { value[0].controls[1].id = 'CommandButton_9999'; },
    value => { value.push(value[0]); },
  ]) { const altered = clone(windows); change(altered); assert.throws(() => driver.assertConnectionDialog(altered, 123, content)); }
  assert.throws(() => driver.dialogCommand(123, 'C:\\owned.exe', { ...selected, content: undefined }));
});

const PARSE_SUCCESS = 'Parsed native programs; none executed';
const PARSE_ERROR = 'CREATOR_MIGRATION_PARSE_ERROR';
function parserResult(result, env = process.env) {
  const diagnostics = (result.stdout || '') + (result.stderr || '');
  assert.ok(!diagnostics.includes(PARSE_ERROR), diagnostics);
  const nativeWindows = env.GITHUB_ACTIONS === 'true' && env.RUNNER_OS === 'Windows';
  if (!nativeWindows && result.status === null && ['ENOENT', 'ETIMEDOUT'].includes(result.error?.code)) {
    return `PowerShell parser unavailable: ${result.error.code}; native parse is not accepted`;
  }
  assert.equal(result.error, undefined, `PowerShell parser process failed: ${result.error?.code}`);
  assert.equal(result.status, 0, diagnostics);
  assert.ok((result.stdout || '').includes(PARSE_SUCCESS), 'Parser did not confirm successful syntax checks');
  return null;
}

test('local parser process unavailability may skip, but GitHub Windows parsing is mandatory', () => {
  for (const code of ['ENOENT', 'ETIMEDOUT']) {
    const result = { error: { code }, status: null, stdout: '', stderr: '' };
    assert.match(parserResult(result, {}), /native parse is not accepted/);
    assert.throws(() => parserResult(result, context), /parser process failed/);
  }
  assert.equal(parserResult({ status: 0, stdout: PARSE_SUCCESS, stderr: '' }, {}), null);
  assert.equal(parserResult({ status: 0, stdout: PARSE_SUCCESS, stderr: '' }, context), null);
});

test('syntax errors, other process failures and missing confirmation never become local parser skips', () => {
  for (const env of [{}, context]) {
    for (const result of [
      { status: 1, stdout: '', stderr: 'Unexpected token: invalid syntax' },
      { status: 1, stdout: '', stderr: PARSE_ERROR },
      { status: null, error: { code: 'ETIMEDOUT' }, stdout: '', stderr: PARSE_ERROR },
      { status: null, error: { code: 'EACCES' }, stdout: '', stderr: '' },
      { status: null, signal: 'SIGTERM', stdout: '', stderr: '' },
      { status: 0, stdout: '', stderr: '' },
      { status: 0, stdout: PARSE_SUCCESS, stderr: PARSE_ERROR },
    ]) assert.throws(() => parserResult(result, env));
  }
});

test('parse every embedded native PowerShell program without executing it', { skip: process.platform !== 'win32' }, t => {
  const programs = [driver.REGISTRATIONS, driver.PROCESSES,
    driver.dialogCommand(123, 'C:\\owned.exe', driver.assertDialog(snapshot(), 123, true)),
    driver.dialogCommand(123, 'C:\\owned.exe', { title: 'Review unverified MCP connections',
      name: 'Move reviewed connections', id: 1000, handle: 1234, content: "Reviewed fixture's paths\nand options" })];
  const payload = Buffer.from(JSON.stringify(programs), 'utf8').toString('base64');
  const parser = `$ErrorActionPreference='Stop';try{$programs=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json;foreach($source in $programs){$tokens=$null;$errors=$null;[void][Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);if($errors.Count){throw (($errors|ForEach-Object Message)-join ';')}};'${PARSE_SUCCESS}'}catch{[Console]::Error.WriteLine('${PARSE_ERROR}: '+[string]$_);exit 1}`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(parser, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  const unavailable = parserResult(result);
  if (unavailable) t.skip(unavailable);
});

test('receipt cannot conflate bounded native guide proof with full migration or release authority', () => {
  const report = driver.reportTemplate('a'.repeat(40));
  for (const key of ['passed', 'nativeGuideAccepted', 'migrationAccepted', 'signedUpdateAccepted', 'liveAiAppAccepted',
    'crashRecoveryAccepted', 'backupBeforeEveryWriteAccepted', 'releaseReady', 'userMachineUsed']) assert.equal(report[key], false);
  assert.equal(report.productSource, driver.TARGET.productSource); assert.equal(report.testSource, 'a'.repeat(40));
  assert.equal(report.limitations.length, 3);
});

test('driver uses only ordinary guide controls, read-only inspection and one exact native confirmation per decision', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-windows-016-migration.cjs'), 'utf8');
  const main = source.slice(source.indexOf('async function main('));
  assert.ok(main.indexOf('admission();') < main.indexOf('parseArgs(args)'));
  assert.ok(main.indexOf('admission();') < main.indexOf('fs.statSync'));
  assert.ok(main.includes("path.resolve('artifacts', `native-suite-${Date.now()}`)"));
  const policy = fs.readFileSync(path.join(__dirname, 'native-webview-policy.ps1'), 'utf8');
  const pattern = policy.match(/-notmatch '([^']+)'/)[1], valid = new RegExp(pattern);
  assert.equal(valid.test('native-suite-1234'), true);
  assert.equal(valid.test('native-suite-016-migration-1234'), false);
  assert.equal(valid.test('native-016-migration-1234'), false);
  assert.deepEqual([...main.matchAll(/\.invoke\('([^']+)'/g)].map(match => match[1]), ['convergence_status']);
  assert.equal([...main.matchAll(/locator\('#convergence-move'\)\.click\(\)/g)].length, 2);
  assert.match(main, /nativeDecision\(false\)/); assert.match(main, /nativeDecision\(true\)/);
  assert.doesNotMatch(main, /taskkill|\.kill\(|Stop-Process|dispatchEvent|addInitScript|\.route\(|exposeFunction|auth\.json|\.rmSync\(|unlinkSync|rm -rf/);
  assert.match(main, /assertOwnedDebugging\(state, child\.pid, hub\)/);
  assert.match(main, /@modelcontextprotocol\/sdk\/client\/stdio\.js/);
  assert.match(main, /await oldClient\.listTools/); assert.match(main, /await connect\(f\.entry\)/);
  assert.match(main, /verifyMigratedTarget\(entry, manifest/);
  assert.ok(main.includes("manifest.modules.mcp.files['mcp/server/creator-works-mcp.mjs']"));
  assert.match(main, /await close\(\); await launch\(\)/);
  assert.match(main, /repeatStartupAccepted = true/);
  assert.match(main, /if \(!report\.passed\) \{ report\.nativeGuideAccepted = false/);
  assert.match(main, /migrationAccepted: false, signedUpdateAccepted: false, releaseReady: false/);
});

test('seeded migration waits for its actual guide, not unrelated updater readiness', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-windows-016-migration.cjs'), 'utf8');
  const terms = source.indexOf("await page.locator('#usage-terms-dialog').waitFor({ state: 'hidden' })");
  const ready = source.indexOf("await page.locator('#convergence-move').waitFor({ state: 'visible' })", terms);
  const firstClick = source.indexOf("await page.locator('#convergence-move').click()", ready);
  const confirm = source.indexOf('await nativeDecision(false)', firstClick);
  assert.ok(terms > 0 && ready > terms && firstClick > ready && confirm > firstClick);
  assert.doesNotMatch(source.slice(terms, firstClick), /check-updates|convergence-later.*click/);
  assert.ok(source.includes("document.querySelectorAll('dialog[open]')"));
  assert.match(source, /report\.nativeWindows = JSON\.parse\(native\('snapshot'\)\)/);
});

test('installed EXE and server checks respect their actual bounded artifact sizes and manifest schema', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-windows-016-migration.cjs'), 'utf8');
  assert.match(source, /const hubHash = \(\) => hash\(regular\(hub, 200 \* 1024 \* 1024\)\)/);
  assert.doesNotMatch(source, /hash\(read\(hub\)\)|manifest\.apps/);
  assert.match(source, /fs\.mkdirSync\(path\.dirname\(out\), \{ recursive: true \}\); fs\.mkdirSync\(out, \{ recursive: false \}\)/);
  assert.match(source, /assert\.deepEqual\(projectImage\(\[f\.projectA, f\.projectB\]\), projectBefore/);
});

test('runtime harness dependencies and helper files are checked before baseline installation', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-windows-016-migration.cjs'), 'utf8');
  const installer = source.indexOf('execFileSync(path.join(input.baselines, baseline.asset)');
  for (const marker of ["require('@playwright/test').chromium", "sdk('@modelcontextprotocol/sdk/client/stdio.js')",
    "print('tomllib-ready')", "regular(path.resolve('scripts', helper))"]) {
    const check = source.indexOf(marker); assert.ok(check > 0 && check < installer, marker);
  }
});

test('data-only driver keeps provenance and fixed installer admission before all native actions without build receipts', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-windows-016-migration.cjs'), 'utf8');
  const main = source.slice(source.indexOf('async function main('));
  const firstNative = main.indexOf('assert.deepEqual(registrations(), [])');
  for (const marker of ['admission();', 'validateProvenance(', "assert.equal(hash(regular(installer, TARGET.bytes)), TARGET.installer)",
    'assert.equal(fs.statSync(installer).size, TARGET.bytes)']) assert.ok(main.indexOf(marker) >= 0 && main.indexOf(marker) < firstNative);
  assert.doesNotMatch(source, /installer-checksum\.json|builtin-manifest\.json|verifyStage\(|build-unified\.cjs|assertCandidateMetadata/);
  const install = main.indexOf("execFileSync(installer, ['/UPDATE', '/S', '/NS']");
  const inspect = main.indexOf('manifest = inspectInstalledResources(path.dirname(hub))');
  const launch = main.indexOf("policy('Enable'); await launch()");
  assert.ok(install > 0 && inspect > install && launch > inspect);
  assert.match(main, /verifyMigratedTarget\(entry, manifest/);
  assert.match(main, /inspectActiveRoute\(process\.env\.LOCALAPPDATA, manifest\)/);
  assert.match(source, /pinnedRead\(path\.join\(directory, 'creator-hub\.exe'\), TARGET\.exe\)/);
  assert.match(source, /activeFile, 2048\), activeBytes/);
});

test('captured legacy exception is reviewed once before completion; clients and settings are checked before approval', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-windows-016-migration.cjs'), 'utf8');
  assert.equal([...source.matchAll(/await connectionDecision\(\)/g)].length, 1);
  assert.ok(source.indexOf('await nativeDecision(true)') < source.indexOf('await connectionDecision()'));
  const review = source.slice(source.indexOf('const connectionDecision = async'), source.indexOf('const launch = async'));
  for (const check of ['assertConnectionDialog', 'inspectActiveRoute', 'verifyBackups(f.stores)', 'No client changes before explicit exception approval',
    'Project import precedes the client review', 'ps(dialogCommand']) assert.ok(review.includes(check), check);
  assert.ok(review.indexOf('No client changes before explicit exception approval') < review.indexOf('ps(dialogCommand'));
});
