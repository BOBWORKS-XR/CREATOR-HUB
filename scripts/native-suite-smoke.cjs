// Executes real public installers and writable controls on disposable CI only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('@playwright/test');
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.RUNNER_OS !== 'Windows') {
  throw Error('Native suite installation is restricted to a disposable GitHub-hosted Windows runner.');
}
const pins = JSON.parse(fs.readFileSync('scripts/prerelease-apps.json', 'utf8'));
const hub = path.join(process.env.LOCALAPPDATA, 'Creator Hub', 'creator-hub.exe');
const apps = {
  mcp: path.join(process.env.LOCALAPPDATA, 'Creator Works MCP', 'creator-works-mcp-launcher.exe'),
  setup: path.join(process.env.LOCALAPPDATA, 'Creator Project Setup', 'creator-project-setup.exe'),
};
const mcpOnly = process.env.CREATOR_SUITE_BASELINE === 'mcp-only';
const upgrade = mcpOnly || process.env.CREATOR_SUITE_BASELINE === 'legacy';
const selectedApps = mcpOnly ? ['mcp'] : ['setup', 'mcp'];
for (const exe of Object.values(apps)) assert.equal(fs.existsSync(exe), false, 'Expected a clean app installation target');
const out = path.resolve('artifacts', `native-suite-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const report = { passed: false, flow: mcpOnly ? 'mcp-only-upgrade' : upgrade ? 'upgrade' : 'clean-install', hubSha256: hash(hub), checks: [], userMachineUsed: false, unityProjectCreated: false, selfUpdateTested: false };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function native(pid, exe, action, value = '') {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/native-window.ps1'),
    '-TargetPid', String(pid), '-ExpectedExecutable', exe, '-Action', action, '-Value', value], { encoding: 'utf8', timeout: 15000, windowsHide: true });
}
async function retry(fn, seconds = 30) {
  let last;
  for (const end = Date.now() + seconds * 1000; Date.now() < end;) {
    try { return await fn(); } catch (error) { last = error; await delay(250); }
  }
  throw last;
}
let child;
let browser;
let page;
const policyState = path.join(out, 'webview-policy.json');
function webviewPolicy(action) {
  return execFileSync('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/native-webview-policy.ps1'), '-Action', action, '-StateFile', policyState], { encoding: 'utf8', timeout: 30000, windowsHide: true });
}
const backends = {};
const frames = {};
const configPath = path.join(process.env.APPDATA, 'creator-works-mcp', 'launcher-config.json');
const savedProjectName = 'Existing project retained through the real Hub update';
function seedConfig() {
  assert.equal(fs.existsSync(configPath), false);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    channels: upgrade ? [{ id: 'existing-fixture', name: savedProjectName, unity_project_path: path.join(process.env.RUNNER_TEMP, 'Existing project fixture'), scene_path: null, enabled: true }] : [],
    active_channel_id: upgrade ? 'existing-fixture' : null, auto_start: false,
    mcp_server_path: path.join(path.dirname(apps.mcp), 'server', 'creator-works-mcp.mjs'),
    tool_groups: 'core', enable_custom_scripts: false, allow_all_tests: true, automatic_update_checks: false,
  }));
}
async function show(app) {
  await page.locator('#suite-trigger').click();
  await page.locator(`#suite-menu [data-view="${app}"]`).click();
}
async function backend(app) {
  return retry(() => {
    const pid = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `$p=Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}" | Where-Object { $_.ExecutablePath -eq '${apps[app].replaceAll("'", "''")}' }; if (-not $p) { exit 1 }; $p.ProcessId`],
    { encoding: 'utf8', windowsHide: true }).trim();
    assert.match(pid, /^\d+$/);
    return Number(pid);
  });
}
async function closeHosted(app) {
  await show(app);
  await page.locator('#hosted-stop').click();
  await retry(() => native(child.pid, hub, 'button', 'Close view'));
  await page.locator(`#${app}-host-frame`).waitFor({ state: 'detached' });
  await retry(() => {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', `if (Get-Process -Id ${backends[app]} -ErrorAction SilentlyContinue) { exit 1 }`], { windowsHide: true });
  });
  delete backends[app];
}
(async () => {
  if (upgrade) {
    const baselines = {
      setup: { repo: 'CREATOR-PROJECT-SETUP', version: '0.2.2', asset: 'Creator-Project-Setup-0.2.2-Windows-setup.exe', bytes: 2577201,
        sha: 'b3f9ed80e9319c4ce7339836310bbfbf7342da665fef155937a5701eda2229e5', exe: '23006194bd8214b92c980dc1042466d598d6d1daaed26819ab697d67159db49b' },
      mcp: { repo: 'CREATOR-WORKS-UNITY-MCP', version: '2.6.0', asset: 'Creator.Works.MCP_2.6.0_x64-setup.exe', bytes: 26247422,
        sha: '11d6fc0fb95e33023a90a8722cf9234f82de6e175689bd915401bac3d49bc8c2', exe: 'b712aadd91ac63ea64b5bbead28d7dc2fc83d4102f989999d7ea85b427649676' },
    };
    for (const [app, baseline] of Object.entries(baselines)) {
      if (!selectedApps.includes(app)) continue;
      // Only a disposable test prepares these old releases; Hub still blocks defective installers.
      const response = await fetch(`https://github.com/BOBWORKS-XR/${baseline.repo}/releases/download/v${baseline.version}/${baseline.asset}`, { signal: AbortSignal.timeout(120000) });
      assert.equal(response.ok, true);
      const chunks = []; let total = 0;
      for await (const chunk of response.body) { total += chunk.length; assert.ok(total <= baseline.bytes); chunks.push(chunk); }
      assert.equal(total, baseline.bytes);
      const file = path.join(out, baseline.asset);
      fs.writeFileSync(file, Buffer.concat(chunks), { flag: 'wx' });
      assert.equal(hash(file), baseline.sha);
      const installer = spawn(file, ['/S', '/NS'], { windowsHide: true, stdio: 'ignore' });
      await retry(() => { assert.notEqual(installer.exitCode, null); assert.equal(installer.exitCode, 0); }, 180);
      assert.equal(hash(apps[app]), baseline.exe);
      fs.writeFileSync(path.join(path.dirname(apps[app]), 'ci-unmanaged-sentinel.txt'), 'preserve suite test content');
    }
    seedConfig();
  }
  const originalConfigHash = upgrade ? hash(configPath) : null;
  webviewPolicy('Enable');
  child = spawn(hub, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9238', WEBVIEW2_USER_DATA_FOLDER: path.join(out, 'webview') } });
  report.hubPid = child.pid;
  child.on('error', error => { report.hubSpawnError = String(error); });
  browser = await retry(() => chromium.connectOverCDP('http://127.0.0.1:9238'));
  const startup = execFileSync('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/native-startup-diagnostics.ps1')], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  fs.writeFileSync(path.join(out, 'hub-startup.json'), startup);
  const diagnostics = JSON.parse(startup.replace(/^\uFEFF/, ''));
  assert.ok(diagnostics.processes.some(process => process.ParentProcessId === child.pid && process.CommandLine?.includes('--remote-debugging-port=9238')), 'Expected test debugger on Hub browser process');
  assert.ok(diagnostics.listeners.length > 0);
  assert.ok(diagnostics.listeners.every(listener => ['127.0.0.1', '::1'].includes(listener.LocalAddress)), 'Test debugger must listen on loopback only');
  report.checks.push('Disposable test policy enables loopback-only browser connection; shipped Hub executable unchanged');
  page = await retry(async () => {
    const found = browser.contexts().flatMap(context => context.pages()).find(p => p.url().includes('tauri.localhost'));
    assert.ok(found); return found;
  });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.CreatorHubNative && !document.querySelector('#check-updates').disabled, null, { timeout: 120000 });
  assert.equal(await page.locator('#preview-channel').isChecked(), true);
  assert.match(await page.evaluate(() => window.__TAURI__.core.invoke('app_inventory', { check: false, preview: true }).then(() => 'ALLOWED', String)), /trusted shell/);
  const inventory = await page.evaluate(() => window.CreatorHubNative.invoke('app_inventory', { check: true, preview: true }));
  for (const app of selectedApps) {
    const state = inventory.apps.find(item => item.app === app);
    assert.equal(state.availableVersion, pins[app].version);
    assert.equal(state.installed, upgrade);
    if (upgrade) assert.equal(state.updateAvailable, true);
    assert.equal(state.installerInteractive, false);
    assert.ok(!state.issue && !state.installBlocked && !state.checkWarning, JSON.stringify(state));
    await show(app);
    await page.locator('#reopen-app').uncheck();
    await page.locator('#release-button').click();
    await retry(() => native(child.pid, hub, 'button', 'Install'));
    await page.waitForFunction(() => !document.querySelector('#release-button').disabled && document.querySelector('#primary-label').textContent === 'Open app', null, { timeout: 180000 });
    assert.equal(hash(apps[app]), pins[app].executableSha256);
    if (upgrade) assert.equal(fs.readFileSync(path.join(path.dirname(apps[app]), 'ci-unmanaged-sentinel.txt'), 'utf8'), 'preserve suite test content');
    for (const name of ['LICENSE.txt', 'THIRD_PARTY_NOTICES.txt', 'rust-dependencies.json']) assert.ok(fs.statSync(path.join(path.dirname(apps[app]), 'licenses', name)).size > 0);
    report.checks.push(`${app}: real public signed discovery, download, native Install consent, ${upgrade ? 'upgrade preserving unmanaged content' : 'clean install'}, exact installed hash and licenses`);
  }
  if (upgrade) assert.equal(hash(configPath), originalConfigHash);
  else seedConfig();

  for (const app of selectedApps) {
    await show(app);
    await page.locator(`#host-${app}-button`).click();
    backends[app] = await backend(app);
    await retry(() => native(backends[app], apps[app], 'button', app === 'mcp' ? 'Enable MCP controls' : 'Open in Hub'));
    frames[app] = await retry(async () => {
      const element = await page.locator(`#${app}-host-frame`).elementHandle();
      const frame = element && await element.contentFrame();
      assert.ok(frame); return frame;
    });
    if (app === 'setup') {
      await frames.setup.locator('#requirements .requirement').first().waitFor({ timeout: 90000 });
      await frames.setup.locator('#project-name').fill('Unsaved test draft');
    } else {
      await frames.mcp.waitForFunction(() => window.CreatorRuntime?.hosted && !window.CreatorRuntime.readOnly && !document.querySelector('#workspaceControls').disabled);
      assert.equal(await frames.mcp.locator('#browseProjectBtn').isEnabled(), true);
      if (upgrade) {
        assert.match(await frames.mcp.locator('#projectsList').innerText(), new RegExp(savedProjectName));
        assert.equal(await frames.mcp.locator('#projectPath').inputValue(), path.join(process.env.RUNNER_TEMP, 'Existing project fixture'));
        report.checks.push('Valid existing MCP project list and active selection survive upgrade and appear in the hosted interface');
      }
      await frames.mcp.locator('details.advanced-section > summary').click();
      const original = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.equal(original.auto_start, false);
      assert.equal(await frames.mcp.locator('#autoConfig').isChecked(), false);
      await frames.mcp.locator('label[for="autoConfig"]').click();
      assert.equal(await frames.mcp.locator('#autoConfig').isChecked(), true);
      await retry(() => assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).auto_start, true));
      await retry(async () => assert.equal(await frames.mcp.locator('#autoConfig').isEnabled(), true));
      await frames.mcp.locator('label[for="autoConfig"]').click();
      assert.equal(await frames.mcp.locator('#autoConfig').isChecked(), false);
      await retry(() => assert.deepEqual(JSON.parse(fs.readFileSync(configPath, 'utf8')), original));
      await frames.mcp.locator('details.advanced-section > summary').click();
      report.checks.push('MCP normal controls write and restore an isolated launcher preference through the real hosted backend');
    }
    const isolated = await frames[app].evaluate(() => { try { void parent.document.body; return false; } catch { return true; } });
    assert.equal(isolated, true);
    await frames[app].evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(out, `hosted-${app}.png`), animations: 'disabled' });
    report.checks.push(`${app}: verified installed copy opens without an EXE picker, explicit native consent, isolated real hosted UI`);
  }
  await frames.mcp.locator('#browseProjectBtn').click();
  await retry(() => {
    const snapshot = native(backends.mcp, apps.mcp, 'snapshot');
    assert.match(snapshot, /Cancel/);
    fs.writeFileSync(path.join(out, 'mcp-picker.json'), snapshot);
  });
  assert.equal(await page.locator('#hosted-stop').isDisabled(), true);
  assert.doesNotMatch(await page.locator('#action-error').innerText(), /An app operation is running/);
  native(child.pid, hub, 'close');
  await page.waitForFunction(() => {
    const error = document.querySelector('#action-error');
    return !error.classList.contains('hidden') && error.textContent === 'An app operation is running. Cancel the download or finish the installer before closing Hub.';
  });
  assert.equal(child.exitCode, null);
  await retry(() => native(backends.mcp, apps.mcp, 'button', 'Cancel'));
  await page.waitForFunction(() => !document.querySelector('#hosted-stop').disabled);
  report.checks.push('Real MCP folder picker blocks native Hub close with the actual refusal warning; cancellation releases the operation');
  if (!mcpOnly) {
    await show('setup');
    assert.equal(await frames.setup.locator('#project-name').inputValue(), 'Unsaved test draft');
  }
  await show('mcp');
  await page.setViewportSize({ width: 560, height: 680 });
  await page.screenshot({ path: path.join(out, 'hosted-mcp-small.png'), animations: 'disabled' });
  await closeHosted('mcp');
  if (!mcpOnly) {
    await show('setup');
    assert.equal(await frames.setup.locator('#project-name').inputValue(), 'Unsaved test draft');
    await closeHosted('setup');
  } else {
    assert.equal(fs.existsSync(apps.setup), false, 'MCP does not need or install Project Setup');
    report.checks.push('Existing MCP upgrades and runs inside Hub while Project Setup remains uninstalled');
  }
  assert.deepEqual(errors, []);
  report.checks.push(`${mcpOnly ? 'MCP hosted view' : 'Both hosted views'} retain state; closing each drains only its own process; no JavaScript errors`);
  report.passed = true;
})().catch(error => { report.error = String(error.stack || error); process.exitCode = 1; }).finally(async () => {
  report.hubExitBeforeCleanup = child?.exitCode;
  if (child && !report.passed) {
    try { fs.writeFileSync(path.join(out, 'hub-failure-dialogs.json'), native(child.pid, hub, 'snapshot')); } catch (error) { report.windowCaptureError = String(error); }
    try {
      const capture = execFileSync('powershell.exe', ['-NoProfile', '-File', path.resolve('scripts/native-startup-diagnostics.ps1')], { encoding: 'utf8', timeout: 30000, windowsHide: true });
      fs.writeFileSync(path.join(out, 'hub-startup.json'), capture);
    } catch (error) { report.startupCaptureError = String(error); }
  }
  if (page && !report.passed) {
    try { await page.screenshot({ path: path.join(out, 'failure.png') }); } catch {}
    for (const [app, pid] of Object.entries(backends)) {
      try { fs.writeFileSync(path.join(out, `${app}-failure-dialogs.json`), native(pid, apps[app], 'snapshot')); } catch {}
    }
  }
  try { if (child) native(child.pid, hub, 'close'); } catch {}
  if (browser) await browser.close();
  for (let i = 0; child && child.exitCode === null && i < 120; i++) await delay(250);
  if (child && child.exitCode === null) { report.cleanup = 'Hub did not close normally; no process was forced closed.'; report.passed = false; process.exitCode = 1; child.unref(); }
  try { webviewPolicy('Restore'); report.testPolicyRestored = true; } catch (error) { report.testPolicyRestoreError = String(error); report.passed = false; process.exitCode = 1; }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, ...report }, null, 2));
});
