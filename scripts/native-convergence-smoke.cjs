const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('@playwright/test');
const { createRequire } = require('node:module');
const { install, requireDisposable } = require('./native-installed-baseline.cjs');
const { verifyStage } = require('./build-unified.cjs');
const { managedLocations, verifyMigratedTarget } = require('./native-managed-target.cjs');

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const hash = file => digest(fs.readFileSync(file));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function admission(env = process.env) {
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
    GITHUB_REF: 'refs/heads/validation/convergence-014', CREATOR_CONVERGENCE_NATIVE_TEST: '1' })) {
    assert.equal(env[key], value, 'Convergence acceptance requires the exact disposable runner context');
  }
}

function retainedOptions(before, after) {
  const expected = JSON.parse(before);
  const actual = JSON.parse(after);
  expected.mcp_server_path = actual.mcp_server_path;
  assert.deepEqual(actual, expected, 'Only the explicitly reviewed saved server path may change');
}

async function retry(action, seconds = 30) {
  let last;
  for (const end = Date.now() + seconds * 1000; Date.now() < end;) {
    try { return await action(); } catch (error) { last = error; await delay(200); }
  }
  throw last || Error('Native acceptance deadline exceeded');
}

function native(pid, executable, action, value = '') {
  return execFileSync('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/native-window.ps1'),
    '-TargetPid', String(pid), '-ExpectedExecutable', executable, '-Action', action, '-Value', value],
  { windowsHide: true, encoding: 'utf8', timeout: 15000 });
}

async function press(pid, executable, title, label) {
  await retry(() => {
    const windows = JSON.parse(native(pid, executable, 'snapshot'));
    assert.equal(windows.filter(window => window.title === title
      && window.controls.some(control => control.name === label)).length, 1);
  });
  // Readiness can be polled; the action itself is issued exactly once.
  native(pid, executable, 'button', label);
}

function registrationNames() {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "$names=@('Creator Hub','Creator Works MCP','Creator Project Setup'); $found=@(); foreach($name in $names) { if(Test-Path -LiteralPath ('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+$name)) { $found+=$name } }; ConvertTo-Json -InputObject @($found) -Compress"],
  { windowsHide: true, encoding: 'utf8', timeout: 15000 }));
}

async function main(candidate) {
  // No candidate, persistent-store, registry or installed-app inspection before admission.
  admission(); requireDisposable();
  candidate = path.resolve(candidate);
  const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'builtin-manifest.json')));
  assert.equal(manifest.managedRouting?.protocol, 1);
  verifyStage(path.join(candidate, 'modules'), manifest);
  const out = path.resolve('artifacts', `native-suite-${Date.now()}`);
  fs.mkdirSync(out, { recursive: true });
  const report = { scope: 'actual-first-launch-convergence-not-signed-update', harnessSourceRevision: process.env.GITHUB_SHA,
    candidateSourceRevision: process.env.CREATOR_CANDIDATE_SOURCE, checks: [], passed: false,
    liveAiAppAccepted: false, signedInAppUpdateAccepted: false, releaseReady: false };
  let child, browser, page, oldClient, oldTransport, policyEnabled = false;
  const policy = path.join(out, 'webview-policy.json');
  const sdk = createRequire(path.resolve('modules/mcp/package.json'));
  const { Client } = sdk('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = sdk('@modelcontextprotocol/sdk/client/stdio.js');
  const config = path.join(process.env.APPDATA, 'creator-works-mcp/launcher-config.json');
  const legacyConfig = path.join(process.env.APPDATA, 'banter-mcp/launcher-config.json');
  const editors = path.join(process.env.LOCALAPPDATA, 'CreatorProjectSetup/editor-roots.json');
  const oldRoot = path.join(process.env.LOCALAPPDATA, 'Creator Works MCP');
  const oldNode = path.join(oldRoot, 'server/runtime/node.exe');
  const oldServer = path.join(oldRoot, 'server/creator-works-mcp.mjs');
  const project = path.join(out, 'existing-project');
  const entry = { command: oldNode, args: [oldServer], timeout: 37,
    env: { UNITY_PROJECT_PATH: project, CREATOR_WORKS_TOOL_GROUPS: 'read', CUSTOM_SETTING: 'keep' } };
  const sourceConfig = Buffer.from(JSON.stringify({ channels: [], active_channel_id: null,
    mcp_server_path: oldServer, auto_start: false, tool_groups: 'full', futureOption: 'preserve',
    nestedFutureOption: { enabled: false, list: [1, 'keep'] } }));
  const editorBytes = Buffer.from(JSON.stringify([path.join(out, 'saved-editors')]));
  const clients = [
    { id: 'codex', path: path.join(process.env.USERPROFILE, '.codex/config.toml'),
      bytes: Buffer.from(`model='keep'\n[mcp_servers.other]\ncommand='keep'\n[mcp_servers.creator-works]\ncommand=${JSON.stringify(oldNode.replaceAll('\\', '/'))}\nargs=[${JSON.stringify(oldServer)}]\ntimeout=37\n[mcp_servers.creator-works.env]\nUNITY_PROJECT_PATH=${JSON.stringify(project)}\nCREATOR_WORKS_TOOL_GROUPS='read'\nCUSTOM_SETTING='keep'\n`) },
    ...['claude', 'claudeDesktop'].map(id => ({ id,
      path: id === 'claude' ? path.join(process.env.USERPROFILE, '.claude.json')
        : path.join(process.env.APPDATA, 'Claude/claude_desktop_config.json'),
      bytes: Buffer.from(JSON.stringify({ preferences: { keep: false },
        mcpServers: { other: { command: 'keep' }, 'creator-works': entry } })) })),
  ];
  const unchanged = () => {
    for (const file of [config, legacyConfig]) assert.deepEqual(fs.readFileSync(file), sourceConfig);
    assert.deepEqual(fs.readFileSync(editors), editorBytes);
    for (const client of clients) assert.deepEqual(fs.readFileSync(client.path), client.bytes);
  };
  const webviewPolicy = action => execFileSync('powershell.exe', ['-NoProfile', '-File',
    path.resolve('scripts/native-webview-policy.ps1'), '-Action', action, '-StateFile', policy],
  { windowsHide: true, timeout: 30000 });
  try {
    const installed = install('upgrade', candidate, out, () => {
      fs.mkdirSync(project);
      for (const item of [{ path: config, bytes: sourceConfig }, { path: legacyConfig, bytes: sourceConfig },
        { path: editors, bytes: editorBytes }, ...clients]) {
        assert.equal(fs.existsSync(item.path), false, 'Disposable profile must have no previous fixture settings');
        fs.mkdirSync(path.dirname(item.path), { recursive: true });
        fs.writeFileSync(item.path, item.bytes, { flag: 'wx' });
      }
    });
    const hub = path.join(installed.directory, 'creator-hub.exe');
    report.installedHubSha256 = hash(hub);
    const serverFiles = fs.readdirSync(path.join(oldRoot, 'server'), { recursive: true, withFileTypes: true })
      .filter(item => item.isFile()).map(item => path.join(item.parentPath, item.name));
    assert.equal(serverFiles.length, 9);
    const retainedFiles = serverFiles.map(file => ({ file, sha256: hash(file) }));
    unchanged();
    assert.deepEqual(registrationNames(), ['Creator Hub', 'Creator Works MCP', 'Creator Project Setup']);
    report.checks.push('Exact published baselines upgraded by the real current installer; all settings/client bytes and legacy registrations initially preserved');
    oldClient = new Client({ name: 'existing-before-convergence', version: '1' });
    oldTransport = new StdioClientTransport({ ...entry, stderr: 'pipe' });
    await oldClient.connect(oldTransport, { timeout: 10000 }); oldTransport.stderr?.resume();
    assert.ok((await oldClient.listTools({}, { timeout: 10000 })).tools.length > 0);
    webviewPolicy('Enable'); policyEnabled = true;
    child = spawn(hub, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9238',
      WEBVIEW2_USER_DATA_FOLDER: path.join(out, 'webview') } });
    browser = await retry(() => chromium.connectOverCDP('http://127.0.0.1:9238'));
    page = await retry(() => {
      const found = browser.contexts().flatMap(context => context.pages()).find(p => p.url().includes('tauri.localhost'));
      assert.ok(found); return found;
    });
    page.setDefaultTimeout(45000);
    await page.locator('#usage-terms-checkbox').check(); await page.locator('#usage-terms-continue').click();
    await page.locator('#convergence-dialog').waitFor({ state: 'visible' });
    await page.locator('#convergence-prepare').click();
    await press(child.pid, hub, 'Move to unified Creator Hub', 'Keep existing');
    await page.locator('#convergence-error').waitFor({ state: 'visible' }); unchanged();
    assert.equal(await page.locator('#convergence-connections').isVisible(), false);
    report.checks.push('Real first-launch native backup cancellation leaves all stores/clients and installations unchanged');
    await page.locator('#convergence-prepare').click();
    await press(child.pid, hub, 'Move to unified Creator Hub', 'Back up and continue');
    await page.locator('#convergence-connections').waitFor({ state: 'visible' });
    const backupReport = await page.evaluate(() => window.CreatorHubNative.invoke('convergence_status'));
    assert.equal(backupReport.stage, 'backed-up'); assert.equal(backupReport.backups.length, 3);
    assert.ok(backupReport.backups.some(file => fs.readFileSync(file).equals(sourceConfig)));
    unchanged();
    for (const file of [backupReport.backups[0], config]) {
      const original = fs.readFileSync(file);
      const changed = Buffer.from(original);
      changed[changed.length - 1] ^= 1;
      try {
        fs.writeFileSync(file, changed);
        await page.locator('#convergence-connections').click();
        await page.locator('#convergence-error').waitFor({ state: 'visible' });
        const refused = await page.evaluate(() => window.CreatorHubNative.invoke('convergence_status'));
        assert.equal(refused.stage, 'backed-up');
        assert.equal(refused.retirementAvailable, false);
        assert.deepEqual(fs.readFileSync(file), changed, 'Refusal must not repair or overwrite changed evidence');
        for (const client of clients) assert.deepEqual(fs.readFileSync(client.path), client.bytes);
        assert.deepEqual(registrationNames(), ['Creator Hub', 'Creator Works MCP', 'Creator Project Setup']);
        const windows = JSON.parse(native(child.pid, hub, 'snapshot'));
        assert.equal(windows.some(window => window.title === 'Enable managed MCP routing'), false);
      } finally {
        fs.writeFileSync(file, original);
      }
      unchanged();
    }
    report.checks.push('Actual guide refuses same-length backup and live-settings drift before routing or retirement; changed evidence is not overwritten');
    await page.locator('#convergence-connections').click();
    await press(child.pid, hub, 'Enable managed MCP routing', 'Enable managed routing');
    const backend = await retry(() => {
      const result = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `$p=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}" | Where-Object Name -EQ 'creator-works-mcp-launcher.exe'); if($p.Count -ne 1) { throw 'Expected exact owned private backend' }; $p | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress`],
      { windowsHide: true, encoding: 'utf8', timeout: 15000 }));
      assert.equal(Number.isInteger(result.ProcessId), true); return result;
    });
    await press(backend.ProcessId, backend.ExecutablePath, 'Open MCP in Creator Hub?', 'Enable MCP controls');
    await press(backend.ProcessId, backend.ExecutablePath, 'Review existing MCP connections', 'Move selected connections');
    await press(backend.ProcessId, backend.ExecutablePath, 'Keep MCP settings working in Hub', 'Move server path');
    await page.locator('#convergence-retire').waitFor({ state: 'visible', timeout: 90000 });
    const reviewed = await page.evaluate(() => window.CreatorHubNative.invoke('convergence_status'));
    assert.equal(reviewed.stage, 'connections-reviewed'); assert.equal(reviewed.retirementAvailable, true);
    for (const file of [config, legacyConfig]) retainedOptions(sourceConfig, fs.readFileSync(file));
    assert.deepEqual(fs.readFileSync(editors), editorBytes);
    const route = managedLocations(process.env.LOCALAPPDATA);
    for (const item of clients) {
      let changed;
      if (item.id === 'codex') {
        changed = JSON.parse(execFileSync('python', ['-c',
          "import json,sys,tomllib; d=tomllib.load(open(sys.argv[1],'rb')); assert d['model']=='keep' and d['mcp_servers']['other']['command']=='keep'; print(json.dumps(d['mcp_servers']['creator-works']))", item.path],
        { windowsHide: true, encoding: 'utf8', timeout: 15000 }));
      } else {
        const json = JSON.parse(fs.readFileSync(item.path));
        assert.equal(json.preferences.keep, false); assert.equal(json.mcpServers.other.command, 'keep');
        changed = json.mcpServers['creator-works'];
      }
      verifyMigratedTarget(changed, manifest, null, process.env.LOCALAPPDATA);
      assert.equal(changed.timeout, 37); assert.deepEqual(changed.env.UNITY_PROJECT_PATH, project);
      assert.equal(changed.env.CUSTOM_SETTING, 'keep'); assert.equal(changed.env.CREATOR_WORKS_TOOL_GROUPS, 'read');
    }
    report.checks.push('Native reviewed batch preserves three client options/projects/unrelated servers and changes only the backed-up product server path');
    await page.locator('#convergence-retire').click();
    await press(child.pid, hub, 'Retire standalone Creator apps', 'Keep existing');
    await page.locator('#convergence-error').waitFor({ state: 'visible' });
    assert.deepEqual(registrationNames(), ['Creator Hub', 'Creator Works MCP', 'Creator Project Setup']);
    assert.ok((await oldClient.listTools({}, { timeout: 10000 })).tools.length > 0);
    await page.locator('#convergence-retire').click();
    await press(child.pid, hub, 'Retire standalone Creator apps', 'Finish migration');
    await page.locator('#convergence-title').filter({ hasText: 'Migration complete' }).waitFor({ timeout: 120000 });
    assert.deepEqual(registrationNames(), ['Creator Hub']);
    for (const app of ['Creator Works MCP', 'Creator Project Setup']) {
      const binary = app === 'Creator Works MCP' ? 'creator-works-mcp-launcher.exe' : 'creator-project-setup.exe';
      assert.equal(fs.existsSync(path.join(process.env.LOCALAPPDATA, app, binary)), false);
      assert.equal(fs.existsSync(path.join(process.env.LOCALAPPDATA, app, 'uninstall.exe')), false);
    }
    for (const file of retainedFiles) assert.equal(hash(file.file), file.sha256);
    for (const file of [config, legacyConfig]) retainedOptions(sourceConfig, fs.readFileSync(file));
    assert.deepEqual(fs.readFileSync(editors), editorBytes);
    assert.ok((await oldClient.listTools({}, { timeout: 10000 })).tools.length > 0);
    for (const command of [entry, { command: route.command, args: [], env: entry.env }]) {
      const client = new Client({ name: 'post-convergence-reconnect', version: '1' });
      const transport = new StdioClientTransport({ ...command, stderr: 'pipe' });
      try {
        await client.connect(transport, { timeout: 10000 }); transport.stderr?.resume();
        assert.ok((await client.listTools({}, { timeout: 10000 })).tools.length > 0);
      } finally { await client.close(); }
    }
    await page.screenshot({ path: path.join(out, 'convergence-complete.png') });
    await page.locator('#convergence-later').click();
    const completed = await page.evaluate(() => window.CreatorHubNative.invoke('convergence_status'));
    assert.equal(completed.required, false); assert.equal(completed.stage, 'complete');
    report.checks.push('Native cleanup cancellation then approval retires both exact GUI registrations, retains all nine runtime files, preserves old live stdio and reconnects via old and signed-router paths');
    await page.waitForFunction(() => {
      const check = document.querySelector('#check-updates');
      const status = document.querySelector('#catalog-status');
      return check && !check.disabled && status?.textContent === 'Update check complete. Installation always needs your approval.';
    });
    report.closeReadiness = await page.evaluate(() => ({
      checkEnabled: !document.querySelector('#check-updates').disabled,
      catalogueStatus: document.querySelector('#catalog-status').textContent,
      hubStatus: document.querySelector('#hub-update-status').textContent,
    }));
    await page.evaluate(async () => {
      window.convergenceCloseBlocked = [];
      await window.__TAURI__.event.listen('close-blocked', event => window.convergenceCloseBlocked.push(String(event.payload).slice(0, 4096)));
    });
    native(child.pid, hub, 'close');
    await retry(() => assert.notEqual(child.exitCode, null)); assert.equal(child.exitCode, 0);
    await browser.close(); browser = null;
    const retainedAfterMigration = [config, legacyConfig, editors, ...clients.map(client => client.path)]
      .map(file => ({ file, bytes: fs.readFileSync(file) }));
    child = spawn(hub, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9238',
      WEBVIEW2_USER_DATA_FOLDER: path.join(out, 'webview') } });
    browser = await retry(() => chromium.connectOverCDP('http://127.0.0.1:9238'));
    page = await retry(() => {
      const found = browser.contexts().flatMap(context => context.pages()).find(view => view.url().includes('tauri.localhost'));
      assert.ok(found); return found;
    });
    page.setDefaultTimeout(45000);
    await page.waitForFunction(() => window.CreatorHubNative && !document.querySelector('#check-updates').disabled
      && document.querySelector('#catalog-status')?.textContent === 'Update check complete. Installation always needs your approval.');
    report.repeatMigratedLaunch = await page.evaluate(() => window.CreatorHubNative.invoke('convergence_status'));
    assert.equal(report.repeatMigratedLaunch.required, false, 'Completed migration must not prompt again because original legacy data was retained');
    assert.deepEqual(report.repeatMigratedLaunch.legacyApps, []);
    assert.equal(await page.locator('#convergence-dialog').isVisible(), false);
    assert.equal(await page.locator('#usage-terms-dialog').isVisible(), false, 'Actual accepted terms must survive restart');
    for (const file of retainedAfterMigration) assert.deepEqual(fs.readFileSync(file.file), file.bytes);
    for (const file of retainedFiles) assert.equal(hash(file.file), file.sha256);
    assert.deepEqual(registrationNames(), ['Creator Hub']);
    assert.ok((await oldClient.listTools({}, { timeout: 10000 })).tools.length > 0);
    native(child.pid, hub, 'close');
    await retry(() => assert.notEqual(child.exitCode, null)); assert.equal(child.exitCode, 0);
    await oldClient.close(); oldClient = null;
    report.checks.push('Actual post-migration restart keeps the approved legacy image, settings, client routes and old live stdio without asking to migrate again');
    report.passed = true;
  } catch (error) {
    report.error = String(error); report.stack = error.stack;
    if (page) report.closeBlocked = await page.evaluate(() => window.convergenceCloseBlocked || []).catch(() => null);
    if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    process.exitCode = 1;
  } finally {
    if (oldClient) await oldClient.close().catch(() => {});
    if (child && child.exitCode === null) {
      try { native(child.pid, child.spawnfile, 'close'); }
      catch (error) { report.closeError = String(error); }
    }
    if (browser) await browser.close();
    if (policyEnabled) try { webviewPolicy('Restore'); } catch (error) { report.policyCleanupError = String(error); report.passed = false; process.exitCode = 1; }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, error: report.error || null,
      signedInAppUpdateAccepted: false, liveAiAppAccepted: false, releaseReady: false, report: path.join(out, 'report.json') }));
  }
}

module.exports = { admission, retainedOptions };
if (require.main === module) main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
