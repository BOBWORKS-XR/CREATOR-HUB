if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.RUNNER_OS !== 'Windows') {
  throw Error('Fresh23 installation requires a disposable GitHub-hosted Windows runner.');
}
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { chromium } = require('@playwright/test');
const candidate = require('./fresh-023-contract.cjs');
const direct = require('./fresh-023-direct.cjs');
require('./install-admission-023.cjs').admit('fresh');
candidate.signedReceipt();
const fresh = require('./fresh-023-native.cjs');
fresh.assertFreshNamespace();
assert.equal(process.argv.length, 3, 'Supply the absolute, reviewed installer path');
const input = candidate.installer(process.argv[2]);
const hub = path.join(process.env.LOCALAPPDATA, 'Creator Hub', 'creator-hub.exe');
assert.equal(fs.existsSync(hub), false, 'Fresh23 requires no installed Hub');
const out = path.resolve('artifacts', `native-suite-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const policyState = path.join(out, 'webview-policy.json'), stop = path.join(out, 'stop-runtime');
const report = { baselineInstalled: false, installedResourcesVerified: false, passed: false, freshInstallAccepted: false, migrationAccepted: false, signedUpdateAccepted: false,
  formattingEquivalentSettingsAccepted: false, manualNormalRestartAccepted: false, signedAutomaticRestartAccepted: false, normalCloses: [],
  publicDiscovery: false, releaseReady: false, userMachineUsed: false, installerSha256: candidate.TARGET.installer,
  executableSha256: candidate.TARGET.exe, ...candidate.productProvenance(), harnessSource: process.env.GITHUB_SHA };
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
let child, runtime, browser, page, held, ownedPage = false, before, retained, retainedHash, seededSettings;
function native(action) { return ps('scripts/native-window.ps1', ['-TargetPid', String(child.pid), '-ExpectedExecutable', hub, '-Action', action]); }
function processes() {
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
    "ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter \"Name = 'creator-project-setup.exe' OR Name = 'creator-works-mcp-launcher.exe'\" | Select-Object ProcessId,ParentProcessId,ExecutablePath)"],
  { encoding: 'utf8', windowsHide: true }));
}
function unchanged() {
  assert.deepEqual(direct.settingsSnapshot(process.env.APPDATA, process.env.LOCALAPPDATA), before);
  for (const [file, bytes] of seededSettings) assert.deepEqual(fs.readFileSync(file), bytes, 'Original formatting must survive unchanged');
  assert.equal(candidate.hash(fs.readFileSync(retained)), retainedHash);
  assert.equal(runtime.exitCode, null, 'Unrelated Node must survive installer, navigation and normal close');
}
async function launchOwned() {
  ownedPage = false;
  assert.equal(candidate.hash(fs.readFileSync(hub)), candidate.TARGET.exe);
  candidate.assertInstalled(path.dirname(hub));
  child = spawn(hub, [], { env: { ...environment, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9238' }, windowsHide: true, stdio: 'ignore' });
  // Wait for this new process tree to own CDP before attaching to its page.
  await retry(() => {
    assert.equal(child.exitCode, null);
    const state = JSON.parse(ps('scripts/native-startup-diagnostics.ps1').replace(/^\uFEFF/, ''));
    candidate.assertOwnedDebugging(state, child.pid, hub);
  });
  browser = await retry(() => chromium.connectOverCDP('http://127.0.0.1:9238'));
  page = await retry(() => { const found = browser.contexts().flatMap(context => context.pages()).find(value => value.url().includes('tauri.localhost')); assert.ok(found); return found; });
  page.setDefaultTimeout(30000);
  const state = JSON.parse(ps('scripts/native-startup-diagnostics.ps1').replace(/^\uFEFF/, ''));
  candidate.assertOwnedDebugging(state, child.pid, hub);
  ownedPage = true;
  const requests = direct.watchRequests(page), errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.waitForFunction(() => window.CreatorHubNative);
  return { requests, errors };
}
async function inspectPages(observed, prefix = '') {
  await direct.checkHome(page);
  const services = await direct.checkPages({ page, requests: observed.requests, processes,
    showApp: app => candidate.showPage(page, app),
    screenshot: app => page.screenshot({ path: path.join(out, `${prefix}${app}.png`), animations: 'disabled' }) });
  await candidate.showPage(page, 'hub'); await direct.checkHome(page);
  unchanged(); assert.deepEqual(observed.errors, []);
  assert.equal((await page.locator('.footer-version').innerText()).trim(), candidate.TARGET.version);
  return services;
}
async function closeOwned() {
  native('close'); await retry(() => assert.equal(child.exitCode, 0));
  unchanged(); assert.deepEqual(processes(), []);
  report.normalCloses.push({ pid: child.pid, exitCode: child.exitCode });
  ownedPage = false;
  await browser.close(); browser = null; page = null;
}
(async () => {
  seededSettings = [];
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
  candidate.assertInstalled(path.dirname(hub)); report.installedResourcesVerified = true;
  unchanged();
  policy('Enable');
  const first = await launchOwned();
  await page.locator('#usage-terms-dialog').waitFor({ state: 'visible' });
  await page.locator('#usage-terms-checkbox').check(); await page.locator('#usage-terms-continue').click();
  await page.waitForFunction(() => !document.querySelector('#usage-terms-dialog').open);
  await direct.checkProtocol(page);
  assert.equal(await page.locator('#convergence-dialog').isVisible(), false, 'Clean profile must not require migration');
  await page.waitForFunction(() => !document.querySelector('#check-updates').disabled, null, { timeout: 180000 });
  report.autoFixtures = await fresh.checkAuto(page, out);
  report.services = await inspectPages(first);
  held = await fresh.hold(page, out, () => retry(() => ps('scripts/native-window.ps1',
    ['-TargetPid', String(child.pid), '-ExpectedExecutable', hub, '-Action', 'button', '-Value', 'Enable managed routing'])));
  await closeOwned();
  const second = await launchOwned();
  assert.notEqual(child.pid, report.normalCloses[0].pid, 'Manual reopen must create a new process');
  await direct.checkProtocol(page);
  await page.waitForFunction(() => !document.querySelector('#check-updates').disabled, null, { timeout: 180000 });
  assert.equal(await page.locator('#usage-terms-dialog').isVisible(), false, 'Terms acceptance must persist');
  assert.equal(await page.locator('#convergence-dialog').isVisible(), false, 'The deferred unchanged review must stay deferred');
  report.reopenedAutoFixtures = await fresh.checkAuto(page, out, true);
  report.reopenedServices = await inspectPages(second, 'reopened-');
  await held.verify(report);
  await closeOwned();
  report.formattingEquivalentSettingsAccepted = false; report.sdkAutoAccepted = true; report.manualNormalRestartAccepted = true;
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
  try { if (held) { await held.close(); report.sdkCleanupVerified = true; } }
  catch (error) { report.sdkCleanupError = String(error); report.passed = false; process.exitCode = 1; }
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
  report.cleanupVerified = report.passed && report.sdkCleanupVerified === true && report.policyRestored === true && child?.exitCode === 0 && runtime?.exitCode === 0;
  if (!report.cleanupVerified) { report.passed = false; process.exitCode = 1; }
  fs.writeFileSync(path.join(out, 'fresh-023-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, ...report }));
});
