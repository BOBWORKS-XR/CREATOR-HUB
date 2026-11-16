'use strict';
// One clean hosted-runner install. No migration, project creation or update acceptance claim.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const target = require('./windows-outgoing-019-target.cjs');
const direct = require('./native-outgoing-direct-019.cjs');
const input = require('./windows-outgoing-019-input.cjs');
const { assertOwnedDebugging, showPage } = require('./windows-incoming-016.cjs');
const BRANCH = 'codex/windows-root-ui-023-20261116-r12-ci1';
const WORKFLOW = '.github/workflows/windows-outgoing-019.yml';
const ROOT = path.resolve(__dirname, '..');
const NAMES = [target.ASSET, 'creator-hub-windows-x86_64.json', 'creator-hub-windows-x86_64.json.minisig', 'latest.json'];
const CLOSE_MESSAGE = 'MCP has an unfinished interface workflow, but its native operation has returned.\n\nClose Hub anyway? Earlier completed changes and recovery records will be kept. Nothing will be rolled back or marked successful. Existing AI connections, Unity and unrelated processes will not be stopped. Check the last outcome before repeating work.';
const POLICY = '2026-09-28-v1';
function admission(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32'); target.validateBinding();
  for (const [name, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
    GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'fresh',
    GITHUB_REF: `refs/heads/${BRANCH}`, GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${WORKFLOW}@refs/heads/${BRANCH}` }))
    assert.equal(env[name], value, name);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/); assert.equal(env.EXPECTED_HARNESS_COMMIT, env.GITHUB_SHA);
  assert.equal(env.CREATOR_OUTGOING_REVIEW_SHA256, target.hash(fs.readFileSync(path.join(__dirname, 'fixtures/windows-outgoing-019-binding.json'))));
  for (const name of Object.keys(env)) assert.ok(!/^CREATOR_(?!OUTGOING_REVIEW_SHA256$)/i.test(name)
    && !/^WEBVIEW2_/i.test(name) && !/^(NODE_OPTIONS|NODE_PATH|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|ALL_PROXY|HTTP_PROXY|HTTPS_PROXY|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(name), `Unexpected override: ${name}`);
}
function freshPaths(profile, paths = path) {
  for (const name of ['home', 'local', 'roaming']) assert.ok(paths.isAbsolute(profile[name] || ''));
  return [paths.join(profile.local, 'Creator Hub'), paths.join(profile.local, 'CreatorHub'),
    paths.join(profile.local, 'creator-hub'), paths.join(profile.home, '.creator-hub'),
    paths.join(profile.local, 'Creator Works MCP'), paths.join(profile.local, 'Banter MCP'),
    paths.join(profile.local, 'Creator Project Setup'), paths.join(profile.local, 'CreatorProjectSetup'),
    paths.join(profile.roaming, 'creator-works-mcp'), paths.join(profile.roaming, 'banter-mcp'),
    paths.join(profile.home, '.codex/config.toml'), paths.join(profile.home, '.claude.json'),
    paths.join(profile.roaming, 'Claude/claude_desktop_config.json'),
    paths.join(profile.home, '.gemini/config/mcp_config.json'), paths.join(profile.roaming, 'opencode/opencode.json'),
    paths.join(profile.roaming, 'opencode/opencode.jsonc'), paths.join(profile.local, 'com.creatorworks.hub')];
}
function assertFresh(profile, exists = fs.existsSync, paths = path) {
  for (const file of freshPaths(profile, paths)) assert.equal(exists(file), false, 'Existing product/settings refused');
}
function environment(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|PRIVATE_KEY|SIGNING|CREDENTIAL|AUTHORIZATION|PROXY|^NODE_OPTIONS$|^NODE_PATH$|^NODE_TLS_|^NODE_EXTRA_CA_CERTS$|^SSL_CERT_|^CURL_CA_BUNDLE$|^REQUESTS_CA_BUNDLE$/i.test(key)));
}
function settingsFiles(profile) {
  return [path.join(profile.roaming, 'creator-works-mcp/launcher-config.json'), path.join(profile.roaming, 'banter-mcp/launcher-config.json'),
    path.join(profile.local, 'CreatorProjectSetup/editor-roots.json'), path.join(profile.local, 'CreatorHub/consent/hub-usage-terms.json'),
    path.join(profile.local, 'CreatorHub/preferences/hub-preferences.json'), ...freshPaths(profile).slice(10, 16)];
}
function consentRecord(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 2048, 'Native consent record required');
  const value = JSON.parse(bytes.toString());
  assert.deepEqual(Object.keys(value).sort(), ['acceptedAtMs', 'policyVersion', 'schemaVersion']);
  assert.equal(value.schemaVersion, 1); assert.equal(value.policyVersion, POLICY);
  assert.ok(Number.isSafeInteger(value.acceptedAtMs) && value.acceptedAtMs > 0);
  return value;
}
function closeDialog(windows) {
  const matches = windows.filter(window => window.title === 'Close Creator Hub?');
  if (!matches.length) return false;
  assert.equal(matches.length, 1); const dialog = matches[0];
  assert.equal(dialog.class, '#32770');
  assert.ok(dialog.controls.some(control => control.name.replace(/\r\n/g, '\n') === CLOSE_MESSAGE), 'Exact R12 close message required');
  const buttons = dialog.controls.filter(control => control.name === 'Close Hub');
  assert.equal(buttons.length, 1); assert.match(buttons[0].id, /^CommandButton_(1000|1001)$/);
  return true;
}
async function closeNormally({ request, exitCode, snapshot: windows, approve, delay, attempts = 60 }) {
  request(); let approved = false;
  for (let i = 0; i < attempts; i++) {
    await delay(); // Deliver a normal exit event before attempting another synchronous inventory.
    const code = exitCode();
    if (code !== null) { assert.equal(code, 0, 'Normal Hub close failed'); return; }
    if (!approved) {
      let observed;
      try { observed = windows(); }
      catch (error) {
        await delay();
        const closed = exitCode();
        if (closed === null) throw error;
        assert.equal(closed, 0, 'Normal Hub close failed'); return;
      }
      if (closeDialog(observed)) { approve(); approved = true; }
    }
  }
  throw Error('Normal Hub close timed out; no process was force-closed');
}
function snapshot(files) {
  return files.map(file => {
    if (!fs.existsSync(file)) return { file, bytes: null, sha256: null };
    const bytes = target.readBounded(file, 2 * 1024 * 1024);
    return { file, bytes: bytes.length, sha256: target.hash(bytes) };
  });
}
function outputDirectory(root, stamp = Date.now(), paths = path) {
  assert.ok(Number.isSafeInteger(stamp) && stamp > 0);
  return paths.join(root, 'artifacts', `native-suite-${stamp}`);
}
function checkReceipt(report) {
  assert.equal(report.kind, 'r12-fresh-install'); assert.equal(report.sourceCommit, target.binding.target.source.commit);
  assert.equal(report.bindingSha256, target.hash(fs.readFileSync(path.join(__dirname, 'fixtures/windows-outgoing-019-binding.json'))));
  assert.deepEqual(report.installer, target.binding.target.installer); assert.deepEqual(report.executable, target.binding.target.executable);
  for (const key of ['passed', 'cleanAdmission', 'firstLaunchAccepted', 'mcpAvailable', 'normalRestartAccepted',
    'settingsUnchanged', 'installedResourcesVerified', 'policyRestored', 'cleanupVerified']) assert.equal(report[key], true, key);
  for (const key of ['migrationAccepted', 'signedUpdateAccepted', 'publicDiscovery', 'liveAiAcceptance', 'releaseReady', 'cleanupForced']) assert.equal(report[key], false, key);
  assert.ok(Array.isArray(report.settingsBeforeReopen) && report.settingsBeforeReopen.length > 0);
  assert.deepEqual(report.settingsBeforeReopen, report.settingsAfterReopen);
  assert.ok(path.win32.isAbsolute(report.profile?.local || ''));
  const consentFile = path.join(report.profile.local, 'CreatorHub/consent/hub-usage-terms.json');
  for (const [proof, rows] of [[report.consentBeforeReopen, report.settingsBeforeReopen], [report.consentAfterReopen, report.settingsAfterReopen]]) {
    assert.ok(proof); assert.equal(proof.file, consentFile);
    consentRecord(Buffer.from(JSON.stringify(proof.record)));
    assert.match(proof.sha256 || '', /^[a-f0-9]{64}$/); assert.ok(proof.bytes > 0 && proof.bytes <= 2048);
    const matches = rows.filter(row => row.file === consentFile); assert.equal(matches.length, 1);
    assert.deepEqual(matches[0], { file: proof.file, bytes: proof.bytes, sha256: proof.sha256 });
  }
  assert.deepEqual(report.consentBeforeReopen, report.consentAfterReopen);
  assert.equal(report.normalCloses.length, 2); assert.equal(new Set(report.normalCloses.map(row => row.pid)).size, 2);
  for (const row of report.normalCloses) { assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0); assert.equal(row.exitCode, 0); }
}
async function acquire() {
  admission();
  const directory = path.join(ROOT, 'artifacts/fresh-r12-inputs'); assert.equal(fs.existsSync(directory), false);
  const release = target.binding.target.privateRelease;
  const get = async (route, binary = false) => {
    const response = await fetch(`https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/${route}`, {
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2026-03-10' }, signal: AbortSignal.timeout(120000) });
    assert.equal(response.ok, true, `Private input HTTP ${response.status}`); return response;
  };
  input.verifyRelease(await (await get(`releases/${release.id}`)).json(), release);
  fs.mkdirSync(directory, { recursive: true });
  for (const name of NAMES) {
    const pin = release.assets[name], bytes = Buffer.from(await (await get(`releases/assets/${pin.id}`, true)).arrayBuffer());
    assert.equal(bytes.length, pin.bytes); assert.equal(target.hash(bytes), pin.sha256);
    fs.writeFileSync(path.join(directory, name), bytes, { flag: 'wx' });
  }
  input.verifyRelease(await (await get(`releases/${release.id}`)).json(), release);
  validateInputs(directory);
  return { acquired: true, releaseId: release.id, assets: 4, published: false };
}
function validateInputs(directory) {
  assert.deepEqual(fs.readdirSync(directory).sort(), [...NAMES].sort());
  const bytes = {};
  for (const name of NAMES) {
    const pin = target.binding.target.privateRelease.assets[name]; bytes[name] = target.readBounded(path.join(directory, name), pin.bytes);
    assert.equal(bytes[name].length, pin.bytes); assert.equal(target.hash(bytes[name]), pin.sha256);
  }
  const t = target.binding.target, b = target.binding.baseline;
  require('./self-update-outgoing-019-feed.cjs').createDirectOutgoing019Contract({ targetVersion: t.version,
    baseline: { version: b.version, installer: b.installer.sha256, exe: b.executable.sha256 },
    pins: { descriptor: t.descriptor.sha256, descriptorSignature: t.descriptorSignature.sha256,
      installer: t.installer.sha256, executable: t.executable.sha256, manifest: t.latest.sha256 },
    descriptor: bytes[NAMES[1]], descriptorSignature: bytes[NAMES[2]], installer: bytes[NAMES[0]], manifest: bytes[NAMES[3]] });
}
async function main() {
  admission(); const directory = path.join(ROOT, 'artifacts/fresh-r12-inputs'); validateInputs(directory);
  const env = environment();
  const ps = (name, args = []) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, name), ...args],
    { env, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  const profile = { home: process.env.USERPROFILE, local: process.env.LOCALAPPDATA, roaming: process.env.APPDATA };
  const actual = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "@{home=[Environment]::GetFolderPath('UserProfile');local=[Environment]::GetFolderPath('LocalApplicationData');roaming=[Environment]::GetFolderPath('ApplicationData')}|ConvertTo-Json -Compress"],
  { env, encoding: 'utf8', timeout: 15000, windowsHide: true }));
  for (const name of Object.keys(profile)) assert.equal(path.win32.normalize(profile[name]).toLowerCase(), path.win32.normalize(actual[name]).toLowerCase(), 'Redirected profile refused');
  for (const folder of Object.values(profile)) for (let at = folder; ; at = path.dirname(at)) {
    assert.equal(fs.lstatSync(at).isSymbolicLink(), false, 'Linked profile refused');
    if (at === path.dirname(at)) break;
  }
  assertFresh(profile);
  const inventory = () => JSON.parse(ps('native-outgoing-process-019.ps1').replace(/^\uFEFF/, ''));
  const moduleRows = () => inventory().filter(row => /(?:creator-project-setup|creator-works-mcp-launcher)\.exe$/i.test(row.image));
  assert.deepEqual(inventory().filter(row => /creator-(?:hub|project-setup|works-mcp-launcher|hub-mcp-router)\.exe$/i.test(row.image)), []);
  const out = outputDirectory(ROOT); fs.mkdirSync(out, { recursive: false });
  const hub = path.join(profile.local, 'Creator Hub/creator-hub.exe'), policyFile = path.join(out, 'webview-policy.json');
  const report = { kind: 'r12-fresh-install', sourceCommit: target.binding.target.source.commit,
    bindingSha256: target.hash(fs.readFileSync(path.join(__dirname, 'fixtures/windows-outgoing-019-binding.json'))),
    installer: target.binding.target.installer, executable: target.binding.target.executable, profile, cleanAdmission: true,
    normalCloses: [], passed: false, cleanupForced: false, migrationAccepted: false, signedUpdateAccepted: false,
    publicDiscovery: false, liveAiAcceptance: false, releaseReady: false };
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function retry(action, seconds = 30) { let last; for (const end = Date.now() + seconds * 1000; Date.now() < end;) {
    try { return await action(); } catch (error) { last = error; await delay(250); }
  } throw last || Error('Bounded wait expired'); }
  let child, browser, page, owned, policyEnabled = false, closeAttempted = false;
  const record = pid => { const rows = inventory().filter(row => row.pid === pid); assert.equal(rows.length, 1); return rows[0]; };
  const same = () => assert.deepEqual(record(owned.pid), owned);
  async function close() {
    closeAttempted = true; same();
    await closeNormally({
      request: () => ps('native-window.ps1', ['-TargetPid', String(owned.pid), '-ExpectedExecutable', hub, '-Action', 'close']),
      exitCode: () => child.exitCode,
      snapshot: () => { same(); return JSON.parse(ps('native-window.ps1', ['-TargetPid', String(owned.pid), '-ExpectedExecutable', hub, '-Action', 'snapshot'])); },
      approve: () => { same(); ps('native-window.ps1', ['-TargetPid', String(owned.pid), '-ExpectedExecutable', hub, '-Action', 'button', '-Value', 'CloseCreatorHub']); },
      delay: () => delay(250),
    });
    report.normalCloses.push({ pid: owned.pid, exitCode: child.exitCode });
    await browser.close(); browser = null; page = null; child = null; owned = null; assert.deepEqual(moduleRows(), []);
  }
  async function launch(first) {
    closeAttempted = false;
    target.assertInstalledResources(path.dirname(hub), '0.1.23');
    child = spawn(hub, [], { env: { ...env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9238' }, windowsHide: true, stdio: 'ignore' });
    owned = await retry(() => record(child.pid)); assert.equal(owned.image.toLowerCase(), hub.toLowerCase()); assert.equal(owned.kernelIdentityVerified, true);
    await retry(() => { same(); assertOwnedDebugging(JSON.parse(ps('native-startup-diagnostics.ps1').replace(/^\uFEFF/, '')), owned.pid, hub); }, 60);
    browser = await require('@playwright/test').chromium.connectOverCDP('http://127.0.0.1:9238');
    same(); assertOwnedDebugging(JSON.parse(ps('native-startup-diagnostics.ps1').replace(/^\uFEFF/, '')), owned.pid, hub);
    page = await retry(() => { const p = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('tauri.localhost')); assert.ok(p); return p; });
    page.setDefaultTimeout(30000); const errors = [], requests = direct.watchRequests(page);
    page.on('pageerror', error => errors.push(String(error)));
    await page.waitForFunction(() => window.CreatorHubNative);
    if (first) {
      await page.locator('#usage-terms-dialog').waitFor({ state: 'visible' });
      await page.locator('#usage-terms-checkbox').check(); await page.locator('#usage-terms-continue').click();
      await page.locator('#usage-terms-dialog').waitFor({ state: 'hidden' });
    } else assert.equal(await page.locator('#usage-terms-dialog').isVisible(), false);
    await page.waitForFunction(() => !document.querySelector('#check-updates').disabled, null, { timeout: 90000 });
    assert.equal(await page.locator('#usage-terms-dialog').isVisible(), false, 'Terms must remain accepted');
    assert.equal(await page.evaluate(() => window.CreatorHubNative.invoke('usage_terms_status')), true, 'Native consent status required');
    assert.equal(await page.locator('#convergence-dialog').isVisible(), false, 'Clean runner must not offer migration');
    await direct.checkHome(page);
    const services = await direct.checkPages({ page, expectedVersion: '0.1.23', requests, processes: moduleRows,
      showApp: feature => showPage(page, feature), screenshot: feature => page.screenshot({ path: path.join(out, `${first ? 'first' : 'reopen'}-${feature}.png`) }) });
    assert.equal(services.mcp.project, null); assert.deepEqual(errors, []);
    assert.equal((await page.locator('.footer-version').innerText()).trim(), '0.1.23');
    const settings = await page.evaluate(() => window.CreatorHubNative.invoke('feature_call', { feature: 'mcp', command: 'load_config', args: {} }));
    assert.deepEqual(settings.channels, []); assert.equal(settings.active_channel_id, null);
    report.mcpAvailable = true; return services;
  }
  try {
    execFileSync(path.join(directory, target.ASSET), ['/S', '/NS'], { env, windowsHide: true, timeout: 120000, stdio: 'pipe' });
    target.assertInstalledResources(path.dirname(hub), '0.1.23');
    assert.ok(snapshot(settingsFiles(profile)).every(row => row.sha256 === null), 'Installer must not create settings');
    ps('native-webview-policy.ps1', ['-Action', 'Enable', '-StateFile', policyFile]); policyEnabled = true;
    report.firstServices = await launch(true); report.firstLaunchAccepted = true;
    await close(); report.settingsBeforeReopen = snapshot(settingsFiles(profile));
    const readConsent = () => {
      const file = path.join(profile.local, 'CreatorHub/consent/hub-usage-terms.json');
      const bytes = target.readBounded(file, 2048);
      return { file, bytes: bytes.length, sha256: target.hash(bytes), record: consentRecord(bytes) };
    };
    report.consentBeforeReopen = readConsent();
    report.reopenedServices = await launch(false); await close();
    report.settingsAfterReopen = snapshot(settingsFiles(profile)); assert.deepEqual(report.settingsAfterReopen, report.settingsBeforeReopen);
    report.consentAfterReopen = readConsent(); assert.deepEqual(report.consentAfterReopen, report.consentBeforeReopen);
    target.assertInstalledResources(path.dirname(hub), '0.1.23');
    report.normalRestartAccepted = true; report.settingsUnchanged = true; report.installedResourcesVerified = true; report.passed = true;
  } catch (error) { report.errorSha256 = target.hash(String(error.stack || error)); report.error = String(error.message).slice(0, 600); report.passed = false; }
  finally {
    if (child?.exitCode === null && owned) {
      if (!closeAttempted) try { await close(); } catch { report.passed = false; report.cleanupError = true; }
      if (child?.exitCode === null) { report.passed = false; report.cleanupError = true; child.unref(); }
    }
    if (browser) await browser.close().catch(() => { report.passed = false; });
    try { if (policyEnabled || fs.existsSync(policyFile)) ps('native-webview-policy.ps1', ['-Action', 'Restore', '-StateFile', policyFile]); report.policyRestored = true; }
    catch { report.passed = false; report.policyRestored = false; }
    try { report.cleanupVerified = inventory().every(row => row.image.toLowerCase() !== hub.toLowerCase()) && moduleRows().length === 0; }
    catch { report.cleanupVerified = false; }
    if (!report.cleanupVerified) report.passed = false;
    try { checkReceipt(report); } catch { report.passed = false; }
    fs.writeFileSync(path.join(out, 'fresh-r12-report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify({ passed: report.passed, releaseReady: false, out })); process.exitCode = report.passed ? 0 : 1;
}
module.exports = { BRANCH, admission, freshPaths, assertFresh, environment, snapshot, outputDirectory, checkReceipt, consentRecord, closeDialog, closeNormally, CLOSE_MESSAGE };
if (require.main === module) {
  const action = process.argv[2]; assert.ok(action === 'acquire' || action === 'run');
  (action === 'acquire' ? acquire() : main()).then(result => { if (result) console.log(JSON.stringify(result)); })
    .catch(error => { console.error(JSON.stringify({ failed: true, error: String(error.message).slice(0, 600) })); process.exitCode = 1; });
}
