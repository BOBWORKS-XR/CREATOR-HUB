const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

assert.ok(process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted' && process.env.RUNNER_OS === 'Windows', 'Native lifecycle acceptance requires a disposable GitHub-hosted Windows runner.');
const { chromium } = require('@playwright/test');
const pin = require('./installed-acceptance-pin.json');
const executable = path.join(process.env.LOCALAPPDATA, 'Creator Project Setup', 'creator-project-setup.exe');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.equal(hash(executable), pin.executableSha256);
const out = path.resolve('dist/native-lifecycle');
fs.mkdirSync(out, { recursive: false });
const report = { passed: false, executableSha256: pin.executableSha256, candidateSource: pin.sourceRevision, candidateRunId: pin.runId, acceptanceSource: process.env.GITHUB_SHA, checks: [], productionUserMachineUsed: false, noUnityInstallation: true };
const child = spawn(executable, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9240', WEBVIEW2_USER_DATA_FOLDER: path.join(out, 'webview') } });
child.on('error', error => { report.launchError = String(error); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(fn, milliseconds = 30000) {
  let error;
  for (const deadline = Date.now() + milliseconds; Date.now() < deadline;) {
    try { return await fn(); } catch (failure) { error = failure; await delay(200); }
  }
  throw error ?? Error('Native lifecycle deadline expired.');
}
function native(action = 'state', dialog = 0) {
  const shell = path.join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
  return JSON.parse(execFileSync(shell, ['-NoProfile', '-NonInteractive', '-File', path.resolve('scripts/native-lifecycle-window.ps1'), '-TargetPid', String(child.pid), '-Executable', executable, '-ExpectedSha256', pin.executableSha256, '-Action', action, '-DialogHandle', String(dialog)], { windowsHide: true, encoding: 'utf8', timeout: 15000 }));
}
async function run() {
  let browser, page, dialog;
  try {
    browser = await wait(() => chromium.connectOverCDP('http://127.0.0.1:9240'), 60000);
    page = await wait(() => { const found = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('tauri.localhost')); assert.ok(found); return found; });
    await page.waitForFunction(() => window.CreatorRuntime?.invoke && window.CreatorRuntime?.listen && window.__TAURI__?.core?.invoke);
    const icon = await page.evaluate(async () => {
      const image = document.querySelector('#suite-plugins img');
      await image.decode();
      const response = await fetch(image.src);
      if (!response.ok) throw new Error('Packaged Plugins artwork could not be read.');
      return { src: image.getAttribute('src'), width: image.naturalWidth, bytes: [...new Uint8Array(await response.arrayBuffer())] };
    });
    assert.equal(icon.src, 'icons/creator-plugins.png');
    assert.equal(icon.width, 256);
    assert.equal(crypto.createHash('sha256').update(Buffer.from(icon.bytes)).digest('hex'), 'ff107f1c0bca0380f35f25754fd023d60311fa4457f6fd84255a8f41f78fee6d');
    report.checks.push('The packaged frontend decodes the exact approved transparent Plugins PNG.');
    await wait(() => { assert.equal(native().busy, 0); }, 60000);
    await page.evaluate(async () => {
      window.nativeCloseRefusals = 0;
      window.chooserResult = { pending: true };
      await window.CreatorRuntime.listen('creator-lifecycle-close-blocked', () => window.nativeCloseRefusals++);
      // Use the real guarded command; never add test-only IPC or synthetic properties.
      window.CreatorRuntime.invoke('choose_community_project').then(result => { window.chooserResult = { pending: false, result }; }, error => { window.chooserResult = { pending: false, error: String(error) }; });
    });
    const busy = await wait(() => { const state = native(); assert.equal(state.protocol, 1); assert.equal(state.busy, 1); assert.equal(state.closing, 0); assert.equal(state.dialogs.length, 1); return state; });
    dialog = busy.dialogs[0].handle;
    report.chooser = busy;
    report.checks.push('Exact installed executable published busy protocol state during its actual native folder chooser.');
    native('close');
    await page.waitForFunction(() => window.nativeCloseRefusals === 1);
    assert.equal(child.exitCode, null);
    assert.equal(native().busy, 1);
    await page.screenshot({ path: path.join(out, 'busy-close-refused.png') });
    report.checks.push('Actual main-window WM_CLOSE was refused before chooser cancellation, with the real refusal event.');
    native('cancel', dialog);
    await page.waitForFunction(() => window.chooserResult?.pending === false);
    assert.deepEqual(await page.evaluate(() => window.chooserResult), { pending: false, result: null });
    dialog = null;
    await wait(() => { assert.equal(native().busy, 0); });
    report.checks.push('Cancel returned null and released the actual operation guard without selecting or changing a project.');
    native('close');
    await wait(() => { assert.notEqual(child.exitCode, null); });
    assert.equal(child.exitCode, 0);
    assert.equal(hash(executable), pin.executableSha256);
    report.checks.push('Idle WM_CLOSE exited the same installed executable normally.');
    report.passed = true;
  } catch (error) {
    report.error = error.stack;
    if (page && !page.isClosed()) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    try { report.failureState = native(); } catch (failure) { report.captureError = String(failure); }
  } finally {
    if (dialog != null && child.exitCode === null) {
      try { native('cancel', dialog); await wait(() => { assert.equal(native().busy, 0); }, 10000); }
      catch (error) { report.cleanupError = String(error); report.passed = false; }
    }
    if (child.exitCode === null) {
      try { native('close'); await wait(() => { assert.notEqual(child.exitCode, null); }, 10000); }
      catch (error) { report.cleanupError = String(error); report.passed = false; }
    }
    if (browser) await browser.close().catch(() => {});
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    if (child.exitCode === null) child.unref();
    process.exitCode = report.passed ? 0 : 1;
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
