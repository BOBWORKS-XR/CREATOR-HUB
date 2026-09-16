// Exercises public, unchanged installers on a disposable Windows runner only.
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
const from = { version: '0.1.4', installer: '9eab81b86a291fa70ca3a9d3cb0f6c71a76bd4b527aa88aca387abb210375ea8', exe: '68aa863c53798d03e4ac9eab75b6f6e22ca13f7517e976e9a04e2cf176e17cfa' };
const to = { version: '0.1.5', installer: '79f3a6a2851ec25d1d533eff85c0bc09764a3f1175c1928662c6915697495f5b', exe: '4c350035598e596dfcd351d83bd406e88b864c6e8485b914254fb57324b00594' };
assert.equal(to.version, require('../package.json').version, 'Update acceptance pins for the intended release; testing an older update is not sufficient');
const hub = path.join(process.env.LOCALAPPDATA, 'Creator Hub', 'creator-hub.exe');
assert.equal(fs.existsSync(hub), false, 'Expected a fresh runner without Hub installed');
const out = path.resolve('artifacts', `native-suite-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const report = { passed: false, from, to, checks: [], userMachineUsed: false, selfUpdateTested: false };
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
let child, browser, page, ownedPid;
async function connect() {
  browser = await retry(() => chromium.connectOverCDP('http://127.0.0.1:9238'), 90);
  page = await retry(() => {
    const found = browser.contexts().flatMap(context => context.pages()).find(p => p.url().includes('tauri.localhost'));
    assert.ok(found); return found;
  });
  page.setDefaultTimeout(30000);
  await page.waitForFunction(() => window.CreatorHubNative && !document.querySelector('#check-updates').disabled, null, { timeout: 180000 });
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
(async () => {
  report.feed = await checkLive(to.version);
  assert.equal(report.feed.previousStable, from.version, 'Exercise the previous public stable Hub, not an arbitrary older baseline');
  const installer = path.join(out, `Creator-Hub-${from.version}-Windows-setup.exe`);
  execFileSync('curl.exe', ['--fail', '--location', '--silent', '--show-error', '--max-time', '120', '--output', installer,
    `https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v${from.version}/Creator-Hub-${from.version}-Windows-setup.exe`], { windowsHide: true, timeout: 130000 });
  assert.equal(hash(installer), from.installer);
  const setup = spawn(installer, ['/S', '/NS'], { windowsHide: true, stdio: 'ignore' });
  await retry(() => assert.equal(setup.exitCode, 0), 120);
  assert.equal(hash(hub), from.exe);
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
  report.checks.push(`Unmodified installed Hub ${from.version} discovers public signed ${to.version} and enables its actual Update Hub button`);
  await page.screenshot({ path: path.join(out, 'before-update.png') });
  await page.locator('#hub-update-button').click();
  await retry(() => native(child.pid, 'button', 'Not now'));
  await retry(async () => assert.equal(await page.locator('#hub-update-button').isEnabled(), true));
  assert.equal(child.exitCode, null);
  assert.equal(hash(hub), from.exe);
  assert.equal(hash(sentinel), sentinelHash);
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
  await connect();
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
  fs.writeFileSync(path.join(out, 'self-update-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, ...report }, null, 2));
});
