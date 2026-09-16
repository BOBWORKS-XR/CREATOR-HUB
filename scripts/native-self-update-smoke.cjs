// Public-stable acceptance and a separately labelled version-only runtime fixture.
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.RUNNER_OS !== 'Windows') {
  throw Error('Self-update installation is restricted to a disposable GitHub-hosted Windows runner.');
}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('@playwright/test');
const { checkLive } = require('./check-release-feed.cjs');
const { verifyPluginsIcon } = require('./verify-plugins-icon.cjs');
const from = { version: '0.1.5', installer: '79f3a6a2851ec25d1d533eff85c0bc09764a3f1175c1928662c6915697495f5b', exe: '4c350035598e596dfcd351d83bd406e88b864c6e8485b914254fb57324b00594' };
const to = { version: '0.1.6', installer: '96e0059f0cbcc4ce1dc66ed86d05ad0274e9e63b108db5febe1e61120fd28adb', exe: 'ea6df01fd6200b28125cb5302db6ca6dcc24a70279a729adb35cd572a08a4ea9' };
assert.equal(to.version, require('../package.json').version, 'Update acceptance pins for the intended release; testing an older update is not sufficient');
const fixture = process.env.CREATOR_HOSTED_UPDATE_FIXTURE ? JSON.parse(fs.readFileSync(process.env.CREATOR_HOSTED_UPDATE_FIXTURE, 'utf8')) : null;
if (fixture) {
  assert.equal(fixture.testOnly, true);
  assert.equal(fixture.fromVersion, from.version);
  assert.equal(fixture.toVersion, to.version);
  assert.match(fixture.installerSha256, /^[a-f0-9]{64}$/);
  assert.match(fixture.executableSha256, /^[a-f0-9]{64}$/);
  from.installer = fixture.installerSha256; from.exe = fixture.executableSha256;
}
const hub = path.join(process.env.LOCALAPPDATA, 'Creator Hub', 'creator-hub.exe');
assert.equal(fs.existsSync(hub), false, 'Expected a fresh runner without Hub installed');
const out = path.resolve('artifacts', `native-suite-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const report = { passed: false, from, to, checks: [], userMachineUsed: false, selfUpdateTested: false };
report.sourceKind = fixture ? 'version-only-runtime-fixture-not-public-stable' : 'unmodified-public-stable';
if (fixture) report.fixture = fixture;
const policyState = path.join(out, 'webview-policy.json');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function powershell(script, args = []) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(script), ...args], { encoding: 'utf8', timeout: 30000, windowsHide: true });
}
function native(pid, action, value = '') { return powershell('scripts/native-window.ps1', ['-TargetPid', String(pid), '-ExpectedExecutable', hub, '-Action', action, '-Value', value]); }
function policy(action) { return powershell('scripts/native-webview-policy.ps1', ['-Action', action, '-StateFile', policyState]); }
function diagnostics() { return JSON.parse(powershell('scripts/native-startup-diagnostics.ps1').replace(/^\uFEFF/, '')); }
async function retry(fn, seconds = 30) {
  let last;
  for (const end = Date.now() + seconds * 1000; Date.now() < end;) {
    try { return await fn(); } catch (error) { last = error; await delay(250); }
  }
  throw last || Error('Timed out');
}
let child, browser, page, ownedPid, unrelatedRuntime;
const runtimeStop = path.join(out, 'stop-unrelated-runtime');
const apps = {
  setup: path.join(process.env.LOCALAPPDATA, 'Creator Project Setup', 'creator-project-setup.exe'),
  mcp: path.join(process.env.LOCALAPPDATA, 'Creator Works MCP', 'creator-works-mcp-launcher.exe'),
};
const configPath = path.join(process.env.APPDATA, 'creator-works-mcp', 'launcher-config.json');
const backends = {}, frames = {};
let configHash;
async function connect(waitReady = true) {
  browser = await retry(() => chromium.connectOverCDP('http://127.0.0.1:9238'), 90);
  page = await retry(() => {
    const found = browser.contexts().flatMap(context => context.pages()).find(p => p.url().includes('tauri.localhost'));
    assert.ok(found); return found;
  });
  page.setDefaultTimeout(30000);
  await page.waitForFunction(() => window.CreatorHubNative);
  if (waitReady) await page.waitForFunction(() => !document.querySelector('#check-updates').disabled, null, { timeout: 180000 });
  const state = diagnostics();
  assert.ok(state.listeners.length);
  assert.ok(state.listeners.every(listener => ['127.0.0.1', '::1'].includes(listener.LocalAddress)));
  return state;
}
async function showApps() {
  await page.locator('#suite-trigger').click();
  await page.locator('#suite-menu [data-view="hub"]').click();
  await page.locator('#hub-pages [data-view="hub"]').click();
}
async function showApp(app) {
  await page.locator('#suite-trigger').click();
  await page.locator(`#suite-menu [data-view="${app}"]`).click();
}
function processes() {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter \"Name = 'creator-project-setup.exe' OR Name = 'creator-works-mcp-launcher.exe'\" | Select-Object ProcessId,ParentProcessId,ExecutablePath)"], { encoding: 'utf8', windowsHide: true }));
}
async function approveHosted(app) {
  backends[app] = await retry(() => {
    const found = processes().filter(p => p.ParentProcessId === ownedPid && p.ExecutablePath?.toLowerCase() === apps[app].toLowerCase());
    assert.equal(found.length, 1); return found[0].ProcessId;
  });
  await retry(() => powershell('scripts/native-window.ps1', ['-TargetPid', String(backends[app]), '-ExpectedExecutable', apps[app],
    '-Action', 'button', '-Value', app === 'mcp' ? 'Enable MCP controls' : 'Open in Hub']));
}
async function readyFrame(app) {
  frames[app] = await retry(async () => {
    const element = await page.locator(`#${app}-host-frame`).elementHandle();
    const frame = element && await element.contentFrame(); assert.ok(frame); return frame;
  });
  if (app === 'setup') await frames[app].locator('#requirements .requirement').first().waitFor({ timeout: 90000 });
  else await frames[app].waitForFunction(() => !document.querySelector('#workspaceControls').disabled);
}
async function installCompanions() {
  const pins = require('./prerelease-apps.json');
  for (const [app, exe] of Object.entries(apps)) {
    assert.equal(fs.existsSync(exe), false);
    const pin = pins[app], installer = path.join(out, pin.assetName);
    const repo = app === 'setup' ? 'CREATOR-PROJECT-SETUP' : 'CREATOR-WORKS-UNITY-MCP';
    execFileSync('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--max-time', '180', '--output', installer,
      `https://github.com/BOBWORKS-XR/${repo}/releases/download/v${pin.version}/${pin.assetName}`], { windowsHide: true, timeout: 190000 });
    assert.equal(hash(installer), pin.installerSha256);
    const setup = spawn(installer, ['/S', '/NS'], { windowsHide: true, stdio: 'ignore' });
    await retry(() => assert.equal(setup.exitCode, 0), 120);
    assert.equal(hash(exe), pin.executableSha256);
  }
  assert.equal(fs.existsSync(configPath), false);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ channels: [], active_channel_id: null, auto_start: false,
    mcp_server_path: path.join(path.dirname(apps.mcp), 'server', 'creator-works-mcp.mjs'), tool_groups: 'core',
    enable_custom_scripts: false, allow_all_tests: true, automatic_update_checks: false }), { flag: 'wx' });
  configHash = hash(configPath);
  unrelatedRuntime = spawn(process.execPath, [path.resolve('scripts/owned-hub-fixture.cjs'), runtimeStop], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  unrelatedRuntime.stdout.on('data', chunk => { output += chunk; });
  await retry(() => { assert.match(output, /ready/); assert.equal(unrelatedRuntime.exitCode, null); });
}
(async () => {
  report.feed = await checkLive(to.version);
  assert.equal(report.feed.previousStable, from.version, 'Exercise the previous public stable Hub, not an arbitrary older baseline');
  const installer = fixture ? fixture.installerPath : path.join(out, `Creator-Hub-${from.version}-Windows-setup.exe`);
  if (!fixture) execFileSync('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--max-time', '120', '--output', installer,
    `https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v${from.version}/Creator-Hub-${from.version}-Windows-setup.exe`], { windowsHide: true, timeout: 130000 });
  assert.equal(hash(installer), from.installer);
  const setup = spawn(installer, ['/S', '/NS'], { windowsHide: true, stdio: 'ignore' });
  await retry(() => assert.equal(setup.exitCode, 0), 120);
  assert.equal(hash(hub), from.exe);
  if (fixture) await installCompanions();
  const sentinel = path.join(path.dirname(hub), 'ci-self-update-sentinel.txt');
  fs.writeFileSync(sentinel, 'Preserve unmanaged installed content.', { flag: 'wx' });
  const sentinelHash = hash(sentinel);
  policy('Enable');
  child = spawn(hub, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9238' } });
  ownedPid = child.pid;
  report.originalPid = child.pid;
  await connect();
  assert.equal((await page.locator('.footer-version').innerText()).trim(), from.version);
  if (fixture) {
    for (const app of Object.keys(apps)) {
      await showApp(app);
      await page.locator(`#host-${app}-button`).click();
      await approveHosted(app);
      await readyFrame(app);
    }
    await showApp('setup');
    await frames.setup.locator('#project-name').fill('Keep this draft when update is cancelled');
    report.beforeBackendPids = { ...backends };
  }
  await showApps();
  await retry(async () => assert.equal(await page.locator('#hub-update-button').isEnabled(), true), 120);
  assert.ok((await page.locator('#hub-update-status').innerText()).includes(`Version ${to.version}`));
  assert.equal(await page.locator('#hub-update-warning').isVisible(), false);
  const state = await page.evaluate(() => window.CreatorHubNative.invoke('hub_update_status', { online: false, preview: true }));
  assert.equal(state.currentVersion, from.version);
  assert.equal(state.availableVersion, to.version);
  assert.equal(state.installBlocked, null);
  assert.equal(state.warning, null);
  const preference = 'self-update-preserves-storage';
  await page.evaluate(value => localStorage.setItem('creator-hub.ci-self-update', value), preference);
  report.before = state;
  report.checks.push(`${report.sourceKind} ${from.version} discovers public signed ${to.version} and enables its actual Update Hub button`);
  await page.screenshot({ path: path.join(out, 'before-update.png') });
  await page.locator('#hub-update-button').click();
  await retry(() => native(child.pid, 'button', 'Not now'));
  await retry(async () => assert.equal(await page.locator('#hub-update-button').isEnabled(), true));
  assert.equal(child.exitCode, null);
  assert.equal(hash(hub), from.exe);
  assert.equal(hash(sentinel), sentinelHash);
  if (fixture) {
    assert.equal(await frames.setup.locator('#project-name').inputValue(), 'Keep this draft when update is cancelled');
    const live = processes().map(p => p.ProcessId);
    assert.ok(Object.values(backends).every(pid => live.includes(pid)));
    assert.equal(hash(configPath), configHash);
    assert.equal(unrelatedRuntime.exitCode, null);
    report.checks.push('Native Cancel leaves both hosted backends, unsaved Setup form, MCP settings and unrelated Node runtime intact');
  }
  report.checks.push(`Native Not now preserves the running ${from.version} executable and settings`);
  await page.locator('#hub-update-button').click();
  await retry(() => native(child.pid, 'button', 'Update Hub'));
  await retry(() => assert.equal(child.exitCode, 0), 180);
  report.originalExitCode = child.exitCode;
  if (browser) { await browser.close().catch(() => {}); browser = null; page = null; }
  await retry(() => assert.equal(hash(hub), to.exe), 180);
  // Do not manually launch the replacement: automatic restart is the assertion.
  const restarted = await retry(() => {
    const state = diagnostics();
    const matches = state.processes.filter(p => p.ExecutablePath?.toLowerCase() === hub.toLowerCase() && p.ProcessId !== child.pid);
    assert.equal(matches.length, 1); return matches[0];
  }, 120);
  ownedPid = restarted.ProcessId;
  report.restartedPid = ownedPid;
  await connect(!fixture);
  if (fixture) {
    for (const app of Object.keys(apps)) await approveHosted(app);
    await page.waitForFunction(() => document.querySelector('#hosted-restore-message').textContent.includes('views have reopened'));
    await page.waitForFunction(() => !document.querySelector('#check-updates').disabled);
    assert.equal(fs.existsSync(path.join(process.env.LOCALAPPDATA, 'CreatorHub', 'hub-updates', 'hosted-restore.json')), false);
    assert.equal(hash(configPath), configHash);
    assert.equal(unrelatedRuntime.exitCode, null);
    const live = processes().map(p => p.ProcessId);
    assert.ok(Object.values(report.beforeBackendPids).every(pid => !live.includes(pid)), 'All original owned backends exited');
    assert.equal(await page.locator('#view-hub').isVisible(), true, 'Restoring views keeps Apps as the initial page');
    for (const app of Object.keys(apps)) {
      await showApp(app);
      await readyFrame(app);
      await page.screenshot({ path: path.join(out, `restored-${app}.png`), animations: 'disabled' });
    }
    await showApps();
    report.afterBackendPids = { ...backends };
    report.hostedViewsUpdateTested = true;
    report.checks.push('New updater closes owned views automatically, exact signed public target installs/restarts, both real views reopen after native permission, consumed ticket and unchanged MCP settings; unrelated Node survives');
  }
  assert.equal((await page.locator('.footer-version').innerText()).trim(), to.version);
  assert.equal(await page.evaluate(() => localStorage.getItem('creator-hub.ci-self-update')), preference);
  assert.equal(hash(sentinel), sentinelHash);
  const registry = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Creator Hub', '/v', 'DisplayVersion'], { encoding: 'utf8', windowsHide: true });
  assert.equal(registry.match(/DisplayVersion\s+REG_SZ\s+(\S+)/)?.[1], to.version);
  assert.equal(await page.locator('#view-hub').isVisible(), true, 'Restart opens Apps by default');
  await page.screenshot({ path: path.join(out, 'after-restart.png') });
  await page.locator('#suite-trigger').click();
  await page.locator('#suite-menu [data-view="plugins"]').click();
  report.pluginsIcon = await verifyPluginsIcon(page, '#suite-trigger .plugins-mark img', hash('src/icons/creator-plugins.png'));
  await page.locator('#suite-menu').waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(out, 'updated-plugins-icon.png') });
  report.checks.push('Restarted app opens Apps and renders the exact accepted transparent Plugins icon');
  report.checks.push(`Actual in-app consent downloads/verifies, exits ${from.version}, installs exact ${to.version} and automatically restarts without a manual launch`);
  report.checks.push(`Restarted footer and uninstall registry show ${to.version}; browser preference and unmanaged installation file survive`);
  if (fixture) {
    for (const app of Object.keys(apps)) {
      await showApp(app);
      await page.locator('#hosted-stop').click();
      await retry(() => native(ownedPid, 'button', 'Close view'));
      await retry(() => assert.ok(!processes().some(p => p.ProcessId === backends[app])));
    }
  }
  report.selfUpdateTested = true;
  report.passed = true;
})().catch(error => { report.error = String(error.stack || error); process.exitCode = 1; }).finally(async () => {
  if (!report.passed) {
    try { fs.writeFileSync(path.join(out, 'startup.json'), JSON.stringify(diagnostics(), null, 2)); } catch (error) { report.diagnosticError = String(error); }
    try { if (ownedPid) fs.writeFileSync(path.join(out, 'dialogs.json'), native(ownedPid, 'snapshot')); } catch (error) { report.dialogError = String(error); }
    try { if (page) await page.screenshot({ path: path.join(out, 'failure.png') }); } catch {}
  }
  try { if (ownedPid) native(ownedPid, 'close'); } catch {}
  if (browser) await browser.close().catch(() => {});
  try { policy('Restore'); report.policyRestored = true; } catch (error) { report.policyError = String(error); report.passed = false; process.exitCode = 1; }
  if (child?.exitCode === null) child.unref();
  if (unrelatedRuntime?.exitCode === null) {
    fs.writeFileSync(runtimeStop, 'exit', { flag: 'wx' });
    try { await retry(() => assert.equal(unrelatedRuntime.exitCode, 0)); }
    catch (error) { report.runtimeCleanupError = String(error); report.passed = false; process.exitCode = 1; }
  }
  fs.writeFileSync(path.join(out, 'self-update-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, ...report }, null, 2));
});
