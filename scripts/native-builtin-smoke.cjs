// Clean-machine hosting acceptance. Never runs against the user's installed apps.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('@playwright/test');
const { verifyStage } = require('./build-unified.cjs');
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.RUNNER_OS !== 'Windows') {
  throw Error('Built-in native acceptance is restricted to a disposable GitHub-hosted Windows runner.');
}
const directory = path.resolve(process.argv[2]);
const descriptor = JSON.parse(fs.readFileSync(path.join(directory, 'builtin-manifest.json')));
verifyStage(path.join(directory, 'modules'), descriptor);
const hub = path.join(directory, 'creator-hub.exe');
const out = path.resolve('artifacts', `native-suite-${Date.now()}`);
fs.mkdirSync(out);
const report = { sourceRevision: process.env.GITHUB_SHA, hubSha256: crypto.createHash('sha256').update(fs.readFileSync(hub)).digest('hex'), checks: [], passed: false };
const backendPids = new Map();
const watchdog = setTimeout(() => {
  report.passed = false;
  report.error = 'Native acceptance exceeded its 5-minute deadline; no successful outcome is assumed.';
  try { if (fs.existsSync(policy)) webviewPolicy('Restore'); }
  catch (error) { report.policyCleanupError = String(error); }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  process.exit(1);
}, 5 * 60 * 1000);
watchdog.unref();
const policy = path.join(out, 'webview-policy.json');
function webviewPolicy(action) {
  execFileSync('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/native-webview-policy.ps1'), '-Action', action, '-StateFile', policy], { windowsHide: true, timeout: 30000 });
}
function native(pid, executable, action, value = '') {
  return execFileSync('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/native-window.ps1'),
    '-TargetPid', String(pid), '-ExpectedExecutable', executable, '-Action', action, '-Value', value], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function retry(action, seconds = 45) {
  let last;
  for (const deadline = Date.now() + seconds * 1000; Date.now() < deadline;) {
    try { return await action(); } catch (error) { last = error; await delay(250); }
  }
  throw last;
}
function registrations() {
  return execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "$names=@('Creator Hub','Creator Works MCP','Creator Project Setup','BANTWORKS MCP'); foreach ($h in @('HKCU:','HKLM:')) { foreach ($n in $names) { if(Test-Path -LiteralPath ($h+'\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+$n)) { throw ('Unexpected app registration: '+$n) } } }"], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
}
async function backendFor(app) {
  return retry(() => {
    const value = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `$p=@(Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}" | Where-Object { $_.Name -eq '${path.basename(descriptor.modules[app].executable)}' }); if($p.Count -ne 1) { throw 'Expected one private backend' }; $p | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress`], { windowsHide: true, encoding: 'utf8', timeout: 15000 }).trim();
    return JSON.parse(value);
  });
}
async function backendExited(pid, executable) {
  await retry(() => {
    const running = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if($p -and $p.ExecutablePath -eq '${executable.replaceAll("'", "''")}') { 'running' }`],
    { windowsHide: true, encoding: 'utf8', timeout: 15000 }).trim();
    assert.equal(running, '', 'Private backend must exit after a declined start or closed view');
  }, 15);
}
let child, browser, page;
(async () => {
  registrations();
  for (const app of ['Creator Works MCP', 'Creator Project Setup']) assert.equal(fs.existsSync(path.join(process.env.LOCALAPPDATA, app)), false);
  const settings = path.join(process.env.APPDATA, 'creator-works-mcp', 'launcher-config.json');
  assert.equal(fs.existsSync(settings), false);
  const oldConfig = Buffer.from(JSON.stringify({ channels: [], active_channel_id: null,
    mcp_server_path: 'C:/old-install/banter-mcp.mjs', auto_start: false, tool_groups: 'full',
    migrationGuard: 'Preserve unknown fields and exact bytes when opening the built-in view' }));
  let expectedConfig = oldConfig;
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, oldConfig, { flag: 'wx' });
  for (const module of Object.values(descriptor.modules)) {
    const file = path.join(directory, 'modules', module.executable);
    const result = require('node:child_process').spawnSync(file, [], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.equal(result.status, 2, 'Private backend must not launch a standalone app');
  }
  report.checks.push('No companion installations; private modules reject standalone launch');
  webviewPolicy('Enable');
  child = spawn(hub, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9238', WEBVIEW2_USER_DATA_FOLDER: path.join(out, 'webview') } });
  browser = await retry(() => chromium.connectOverCDP('http://127.0.0.1:9238'));
  page = await retry(() => {
    const result = browser.contexts().flatMap(context => context.pages()).find(p => p.url().includes('tauri.localhost'));
    if (!result) throw Error('Hub webview is not ready'); return result;
  });
  page.setDefaultTimeout(60000);
  await page.locator('#usage-terms-checkbox').check();
  await page.locator('#usage-terms-continue').click();
  const inventory = await retry(() => page.evaluate(() => window.CreatorHubNative.invoke('app_inventory', { check: true, preview: true })));
  assert.equal(inventory.supported, true);
  for (const app of inventory.apps) {
    assert.equal(app.builtIn, true); assert.equal(app.trusted, true); assert.equal(app.issue, null);
    assert.equal(app.updateAvailable, false); assert.equal(app.detectedCopies.length, 0);
    assert.equal(app.availableVersion, descriptor.modules[app.app].version);
  }
  report.checks.push('Native inventory trusts packaged modules without companion catalogue or registration');
  const denied = await page.evaluate(() => window.CreatorHubNative.invoke('download_app', { app: 'mcp', version: '2.7.7' }).then(() => 'unexpected allow', String));
  assert.match(denied, /built into this Hub/);
  report.checks.push('Separate module installation is rejected natively');
  await page.locator('#hub-pages [data-view="hub"]').click();
  for (const app of ['setup', 'mcp']) {
    await page.locator('#suite-trigger').click();
    await page.locator(`#suite-menu [data-view="${app}"]`).click();
    let { ProcessId: pid, ExecutablePath: executable } = await backendFor(app);
    assert.equal(Number.isInteger(pid), true);
    if (app === 'setup') {
      assert.equal(executable.toLowerCase(), path.join(directory, 'modules', descriptor.modules[app].executable).toLowerCase());
    } else {
      const generations = path.join(process.env.LOCALAPPDATA, 'creator-hub', 'runtime-generations', 'windows-x86_64');
      const generation = path.dirname(path.dirname(executable));
      assert.equal(path.dirname(generation).toLowerCase(), generations.toLowerCase());
      assert.match(path.basename(generation), /^[a-f0-9]{64}$/);
      for (const [name, expected] of Object.entries(descriptor.modules.mcp.files)) {
        const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(generation, name))).digest('hex');
        assert.equal(hash, expected, name);
      }
      const node = path.join(generation, 'mcp/server/runtime/node.exe');
      assert.match(execFileSync(node, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 }), /^v\d+\./);
      const packagedServer = path.join(directory, 'modules/mcp/server');
      const retainedServer = `${packagedServer}.acceptance-old`;
      assert.equal(fs.existsSync(retainedServer), false);
      // Only the disposable candidate's files are moved. This proves path
      // independence, not a signed installer/update or AI-client reconnection.
      fs.renameSync(packagedServer, retainedServer);
      try {
        assert.match(execFileSync(node, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 }), /^v\d+\./);
        assert.equal(fs.existsSync(executable), true);
      } finally { fs.renameSync(retainedServer, packagedServer); }
      report.runtimeGeneration = generation;
      report.checks.push('Actual MCP backend and Node use a verified generation independent of the replaceable Hub package');
    }
    await page.locator('#view-builtin').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#view-detail').isVisible(), false);
    assert.match(await page.locator('#builtin-status').innerText(), /^Opening /);
    assert.match(await page.locator('#builtin-detail').innerText(), /permission prompt/);
    await page.screenshot({ path: path.join(out, `${app}-opening.png`) });
    await retry(() => native(pid, executable, 'button', 'Not now'));
    await retry(async () => assert.equal(await page.locator('#builtin-open').isEnabled(), true));
    assert.match(await page.locator('#builtin-status').innerText(), /^Could not open /);
    assert.match(await page.locator('#builtin-detail').innerText(), /declined/i);
    assert.equal(await page.locator('#view-detail').isVisible(), false);
    assert.equal(await page.locator(`#${app}-host-frame`).count(), 0);
    await backendExited(pid, executable);
    assert.deepEqual(fs.readFileSync(settings), oldConfig, 'Declined startup must not change legacy MCP settings');
    await page.screenshot({ path: path.join(out, `${app}-declined.png`) });
    report.checks.push(`${app}: real native consent decline shows retry, exits the backend and preserves legacy settings`);
    await page.locator('#builtin-open').click();
    const previousExecutable = executable;
    ({ ProcessId: pid, ExecutablePath: executable } = await backendFor(app));
    assert.equal(executable.toLowerCase(), previousExecutable.toLowerCase(), 'Retry must use the same verified module, not an installed companion');
    const expectedHash = descriptor.modules[app].files[descriptor.modules[app].executable];
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex'), expectedHash);
    backendPids.set(app, { pid, executable });
    await retry(() => native(pid, executable, 'button', app === 'setup' ? 'Open in Hub' : 'Enable MCP controls'));
    await page.locator(`#${app}-host-frame`).waitFor();
    const frame = page.frameLocator(`#${app}-host-frame`);
    assert.equal(await page.locator('#context-help-open').isVisible(), false, 'Hub Help must not overlap the module Help');
    await frame.locator('#context-help-open').waitFor({ state: 'visible' });
    if (app === 'setup') {
      await frame.locator('#requirements .requirement').first().waitFor();
      await frame.locator('#project-name').fill('Retained built-in form');
    } else {
      await frame.locator('#setupBtn').waitFor();
      await frame.locator('#checkUpdatesBtn').waitFor({ state: 'hidden' });
      assert.match(await frame.locator('#updateStatus').innerText(), /included with Creator Hub/);
      assert.deepEqual(fs.readFileSync(settings), oldConfig, 'Opening built-in MCP must not migrate the old config');
      await frame.locator('body').evaluate(async server => {
        const invoke = (command, args = {}) => window.CreatorRuntime.invoke(command, args);
        const workflow = await invoke('begin_ui_operation');
        try {
          const config = await invoke('load_config');
          config.mcp_server_path = server;
          config.auto_start = true;
          await invoke('save_config', { config });
        } finally { await invoke('finish_ui_operation', { id: workflow }); }
      }, path.join(report.runtimeGeneration, 'mcp/server/creator-works-mcp.mjs'));
      expectedConfig = fs.readFileSync(settings);
      assert.equal(JSON.parse(expectedConfig).migrationGuard, JSON.parse(oldConfig).migrationGuard);
      assert.equal(JSON.parse(expectedConfig).auto_start, true);
      const backups = path.join(path.dirname(settings), '.creator-hub-settings-backups');
      const beforeImage = fs.readdirSync(backups).find(name => name.startsWith('launcher-config.json.') && name.endsWith('.bak'));
      assert.ok(beforeImage, 'Explicit built-in save must retain a backup first');
      assert.deepEqual(fs.readFileSync(path.join(backups, beforeImage)), oldConfig);
      report.checks.push('Explicit built-in settings save preserves unknown fields and retains the exact original bytes');
    }
    await retry(async () => assert.equal(await page.locator('#hosted-stop').isEnabled(), true));
    await page.screenshot({ path: path.join(out, `${app}.png`) });
    const windows = JSON.parse(native(pid, executable, 'snapshot'));
    assert.equal(windows.filter(w => w.title === (app === 'setup' ? 'Creator Project Setup' : 'Creator Works MCP')).length, 0);
    report.checks.push(`${app}: approved retry opens actual private backend and embedded interface; no standalone window`);
  }
  await page.locator('#suite-trigger').click();
  await page.locator('#suite-menu [data-view="setup"]').click();
  assert.equal(await page.frameLocator('#setup-host-frame').locator('#project-name').inputValue(), 'Retained built-in form');
  report.checks.push('View switching retains the actual Setup form');
  for (const app of ['setup', 'mcp']) {
    if (app === 'mcp') { await page.locator('#suite-trigger').click(); await page.locator('#suite-menu [data-view="mcp"]').click(); }
    await page.locator('#hosted-stop').click();
    await retry(() => native(child.pid, hub, 'button', 'Close view'));
    await page.locator(`#${app}-host-frame`).waitFor({ state: 'detached' });
    const backend = backendPids.get(app);
    await backendExited(backend.pid, backend.executable);
  }
  registrations();
  assert.deepEqual(fs.readFileSync(settings), expectedConfig, 'Closing built-in MCP must preserve the explicitly saved config');
  report.checks.push('Built-in startup preserves legacy settings; closing preserves the explicitly saved settings byte-for-byte');
  report.checks.push('Graceful module close; no separate product registrations created');
  report.passed = true;
})().catch(error => { report.error = String(error.stack || error); process.exitCode = 1; })
  .finally(async () => {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    if (child && child.exitCode === null) {
      try {
        // An unanswered view-close prompt blocks normal window close. Cancel only
        // that known test-owned prompt before requesting a graceful Hub exit.
        try { native(child.pid, hub, 'button', 'Keep open'); } catch { /* No pending close prompt. */ }
        native(child.pid, hub, 'close'); await retry(() => assert.notEqual(child.exitCode, null), 15);
      } catch (error) { report.cleanupError = String(error); report.passed = false; process.exitCode = 1; }
      finally { child.unref(); }
    }
    try {
      if (browser) await Promise.race([browser.close(), new Promise((_, reject) => {
        const timer = setTimeout(() => reject(Error('Browser transport cleanup exceeded 10 seconds.')), 10000);
        timer.unref();
      })]);
    } catch (error) { report.browserCleanupError = String(error); report.passed = false; process.exitCode = 1; }
    try { if (fs.existsSync(policy)) webviewPolicy('Restore'); }
    catch (error) { report.policyCleanupError = String(error); report.passed = false; process.exitCode = 1; }
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    clearTimeout(watchdog);
    process.exit(process.exitCode || 0);
  });
