if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.RUNNER_OS !== 'Windows') {
  throw Error('Fresh16 installation requires a disposable GitHub-hosted Windows runner.');
}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('@playwright/test');
const candidate = require('./windows-incoming-016.cjs');
const direct = require('./native-self-update-direct.cjs');
assert.equal(require('../package.json').version, candidate.TARGET.version);
assert.equal(process.argv.length, 3, 'Supply the absolute, reviewed installer path');
const input = candidate.installer(process.argv[2]);
const hub = path.join(process.env.LOCALAPPDATA, 'Creator Hub', 'creator-hub.exe');
assert.equal(fs.existsSync(hub), false, 'Fresh16 requires no installed Hub');
const out = path.resolve('artifacts', `native-suite-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const policyState = path.join(out, 'webview-policy.json'), stop = path.join(out, 'stop-runtime');
const report = { passed: false, freshInstallAccepted: false, migrationAccepted: false, signedUpdateAccepted: false,
  publicDiscovery: false, releaseReady: false, userMachineUsed: false, installerSha256: candidate.TARGET.installer,
  executableSha256: candidate.TARGET.exe, harnessSource: process.env.GITHUB_SHA };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function retry(action, seconds = 90) {
  let last;
  for (const end = Date.now() + seconds * 1000; Date.now() < end;) {
    try { return await action(); } catch (error) { last = error; await delay(250); }
  }
  throw last || Error('Timed out');
}
function ps(script, args = []) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve(script), ...args],
    { encoding: 'utf8', timeout: 30000, windowsHide: true });
}
const policy = action => ps('scripts/native-webview-policy.ps1', ['-Action', action, '-StateFile', policyState]);
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/TOKEN|SECRET|PASSWORD|PRIVATE_KEY|SIGNING|CREDENTIAL|AUTHORIZATION|PROXY|^NODE_OPTIONS$|^NODE_TLS_|^NODE_EXTRA_CA_CERTS$|^SSL_CERT_|^CURL_CA_BUNDLE$|^REQUESTS_CA_BUNDLE$/i.test(key)));
let child, runtime, browser, page, ownedPage = false, before, retained, retainedHash;
function native(action) { return ps('scripts/native-window.ps1', ['-TargetPid', String(child.pid), '-ExpectedExecutable', hub, '-Action', action]); }
function processes() {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter \"Name = 'creator-project-setup.exe' OR Name = 'creator-works-mcp-launcher.exe'\" | Select-Object ProcessId,ParentProcessId,ExecutablePath)"],
  { encoding: 'utf8', windowsHide: true }));
}
function unchanged() {
  assert.deepEqual(direct.settingsSnapshot(process.env.APPDATA, process.env.LOCALAPPDATA), before);
  assert.equal(candidate.hash(fs.readFileSync(retained)), retainedHash);
  assert.equal(runtime.exitCode, null, 'Unrelated Node must survive installer, navigation and normal close');
}
(async () => {
  const settings = { channels: [], active_channel_id: null, auto_start: false, mcp_server_path: '', tool_groups: 'read',
    enable_custom_scripts: false, allow_all_tests: false, automatic_update_checks: false, connection_guide_version: 1,
    incoming16_unknown: { keep: 'exact bytes; no merge or reset' } };
  const seeds = [
    [path.join(process.env.APPDATA, 'creator-works-mcp/launcher-config.json'), JSON.stringify(settings)],
    [path.join(process.env.APPDATA, 'banter-mcp/launcher-config.json'), JSON.stringify(settings)],
    [path.join(process.env.LOCALAPPDATA, 'CreatorProjectSetup/editor-roots.json'), '[]\n'],
  ];
  for (const [file] of seeds) assert.equal(fs.existsSync(file), false, 'Never overwrite pre-existing runner settings');
  for (const [file, bytes] of seeds) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { flag: 'wx' }); }
  before = direct.settingsSnapshot(process.env.APPDATA, process.env.LOCALAPPDATA);
  retained = path.join(process.env.LOCALAPPDATA, 'CreatorHub/retained-import-probe/receipt.json');
  fs.mkdirSync(path.dirname(retained), { recursive: true });
  fs.writeFileSync(retained, '{"testOnly":true,"opaqueRetainedContent":"keep"}\r\n', { flag: 'wx' });
  retainedHash = candidate.hash(fs.readFileSync(retained));
  runtime = spawn(process.execPath, [path.resolve('scripts/owned-hub-fixture.cjs'), stop], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let ready = ''; runtime.stdout.on('data', bytes => { ready += bytes; });
  await retry(() => { assert.match(ready, /ready/); assert.equal(runtime.exitCode, null); });
  const installer = spawn(input, ['/S', '/NS'], { env: environment, windowsHide: true, stdio: 'ignore' });
  await retry(() => assert.equal(installer.exitCode, 0), 120);
  assert.equal(candidate.hash(fs.readFileSync(hub)), candidate.TARGET.exe);
  unchanged();
  policy('Enable');
  child = spawn(hub, [], { env: { ...environment, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9238' }, windowsHide: true, stdio: 'ignore' });
  browser = await retry(() => chromium.connectOverCDP('http://127.0.0.1:9238'));
  page = await retry(() => { const found = browser.contexts().flatMap(context => context.pages()).find(value => value.url().includes('tauri.localhost')); assert.ok(found); return found; });
  page.setDefaultTimeout(30000);
  const requests = direct.watchRequests(page), errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  const state = JSON.parse(ps('scripts/native-startup-diagnostics.ps1').replace(/^\uFEFF/, ''));
  candidate.assertOwnedDebugging(state, child.pid, hub);
  ownedPage = true;
  await page.waitForFunction(() => window.CreatorHubNative);
  await page.locator('#usage-terms-dialog').waitFor({ state: 'visible' });
  await page.locator('#usage-terms-checkbox').check(); await page.locator('#usage-terms-continue').click();
  await page.waitForFunction(() => !document.querySelector('#usage-terms-dialog').open);
  await direct.checkProtocol(page);
  // This fixture deliberately seeds both legacy settings stores, so await its
  // actual migration offer rather than the independently enabled updater.
  await page.locator('#convergence-dialog').waitFor({ state: 'visible' });
  await page.locator('#convergence-later').click(); report.migrationDeferred = true;
  await page.locator('#convergence-dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(() => !document.querySelector('#check-updates').disabled, null, { timeout: 180000 });
  await direct.checkHome(page);
  report.services = await direct.checkPages({ page, requests, processes,
    showApp: async app => { await page.locator('#suite-trigger').click(); await page.locator(`#suite-menu [data-view="${app}"]`).click(); },
    screenshot: app => page.screenshot({ path: path.join(out, `${app}.png`), animations: 'disabled' }) });
  unchanged(); assert.deepEqual(errors, []);
  assert.equal((await page.locator('.footer-version').innerText()).trim(), candidate.TARGET.version);
  native('close'); await retry(() => assert.equal(child.exitCode, 0));
  unchanged(); assert.deepEqual(processes(), []);
  report.freshInstallAccepted = true; report.settingsPreserved = true; report.pluginsRemoved = true;
  report.passed = true;
})().catch(async error => {
  report.error = String(error.stack || error); process.exitCode = 1;
  if (ownedPage) {
    try {
      await page.screenshot({ path: path.join(out, 'failure.png'), animations: 'disabled', timeout: 5000 });
      report.openDialogs = await page.locator('dialog[open]').evaluateAll(dialogs => dialogs.slice(0, 4).map(dialog =>
        ({ id: dialog.id, text: dialog.innerText.slice(0, 1500) })));
    } catch { report.failureCaptureUnavailable = true; }
  }
}).finally(async () => {
  try { if (child?.exitCode === null) native('close'); } catch (error) { report.closeError = String(error); }
  if (browser) await browser.close().catch(() => {});
  try { if (fs.existsSync(policyState)) policy('Restore'); report.policyRestored = true; }
  catch (error) { report.policyError = String(error); report.passed = false; process.exitCode = 1; }
  if (runtime?.exitCode === null) {
    fs.writeFileSync(stop, 'exit', { flag: 'wx' });
    try { await retry(() => assert.equal(runtime.exitCode, 0)); }
    catch (error) { report.cleanupError = String(error); report.passed = false; process.exitCode = 1; }
  }
  if (child?.exitCode === null) { child.unref(); report.passed = false; process.exitCode = 1; }
  fs.writeFileSync(path.join(out, 'fresh-016-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, ...report }));
});
