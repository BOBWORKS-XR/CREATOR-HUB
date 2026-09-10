// Read-only native smoke of an extracted installer payload. No app installs.
const { chromium } = require('@playwright/test');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const exe = path.resolve(process.argv[2] || '');
const expected = process.argv[3];
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.match(expected || '', /^[a-f0-9]{64}$/);
assert.equal(hash(exe), expected);
const running = execFileSync('powershell.exe', ['-NoProfile', '-Command', '@(Get-Process -Name creator-hub -ErrorAction SilentlyContinue).Count'], { windowsHide: true, encoding: 'utf8' }).trim();
assert.equal(running, '0', 'Close earlier Hub windows normally first.');
const configs = () => ['creator-works-mcp', 'banter-mcp'].map(name => {
  const file = path.join(process.env.APPDATA, name, 'launcher-config.json');
  return { name, hash: fs.existsSync(file) ? hash(file) : null };
});
const before = configs();
const out = path.resolve('artifacts', `installer-shell-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const report = { exe, sha256: expected, checks: [], passed: false };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const child = spawn(exe, [], { windowsHide: true, stdio: 'ignore', env: {
  ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9238',
  WEBVIEW2_USER_DATA_FOLDER: path.join(out, 'webview-profile'),
} });
report.pid = child.pid;
let browser;
(async () => {
  for (let attempt = 0; attempt < 80; attempt++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9238'); break; }
    catch { await delay(250); }
  }
  assert(browser, 'No native Hub webview');
  let page;
  for (let attempt = 0; attempt < 80; attempt++) {
    page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('tauri.localhost'));
    if (page) break;
    await delay(250);
  }
  assert(page, 'No native main page');
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.waitForFunction(() => window.CreatorHubNative && /complete|failed|checked/i.test(document.querySelector('#catalog-status').textContent), null, { timeout: 90000 });
  assert.equal(await page.locator('.footer-version').textContent(), '0.1.0-alpha.2');
  const inventory = await page.evaluate(() => window.CreatorHubNative.invoke('app_inventory', { check: false, preview: false }));
  assert(inventory.supported);
  assert(inventory.apps.every(app => app.hostedPreview === null));
  report.checks.push({ name: 'packaged Hub has no embedded previews', passed: true });
  report.apps = inventory.apps.map(app => ({ app: app.app, installed: app.installed, detected: app.detectedCopies.length, verifiedCopies: app.detectedCopies.filter(copy => copy.verified).length, installerBlocked: Boolean(app.installBlocked) }));
  await page.getByRole('button', { name: 'View Creator Works MCP', exact: true }).click();
  assert.equal(await page.locator('#host-mcp-button').isVisible(), false);
  assert.match(await page.locator('#compatibility-detail').textContent(), /future update/);
  const mcp = inventory.apps.find(app => app.app === 'mcp');
  if (mcp.detectedCopies.length) {
    assert.equal(await page.locator('#detected-copies button:enabled').count(), mcp.detectedCopies.filter(copy => copy.verified).length);
    assert(!(await page.locator('#tool-state').textContent()).includes('Not installed'));
  }
  await page.screenshot({ path: path.join(out, 'mcp.png'), fullPage: true });
  await page.getByRole('button', { name: 'All apps' }).click();
  await page.locator('#hub-pages [data-view="projects"]').click();
  await page.waitForFunction(() => /known project/i.test(document.querySelector('#project-status').textContent), null, { timeout: 30000 });
  report.projectStatus = await page.locator('#project-status').textContent();
  await page.screenshot({ path: path.join(out, 'projects.png'), fullPage: true });
  assert.deepEqual(configs(), before);
  assert.deepEqual(errors, []);
  report.checks.push({ name: 'native inventory and project listing; MCP config hashes unchanged', passed: true });
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ readyToClose: true, pid: child.pid, output: out }));
  // Close this owned window normally with the native UI, not a process kill.
  for (let attempt = 0; attempt < 480 && child.exitCode === null; attempt++) await delay(250);
  assert.notEqual(child.exitCode, null, `Close the owned test window, PID ${child.pid}`);
  report.passed = child.exitCode === 0;
  assert(report.passed, 'Hub did not exit normally');
})().catch(error => { report.error = String(error); process.exitCode = 1; }).finally(async () => {
  assert.deepEqual(configs(), before);
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close().catch(() => {});
  child.unref();
  console.log(JSON.stringify({ output: out, passed: report.passed, error: report.error }));
});
