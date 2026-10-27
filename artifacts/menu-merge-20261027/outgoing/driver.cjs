'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const target = require('./target.cjs');
const direct = require('../../../scripts/native-self-update-direct.cjs');
const ROOT = path.resolve(__dirname, '../../..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function retry(read, seconds = 30) {
  let last;
  for (const end = Date.now() + seconds * 1000; Date.now() < end; await delay(250)) {
    try { return await read(); } catch (error) { last = error; }
  }
  throw last || Error('Timed out');
}
function assertProtocol(state, version) {
  assert.ok(['0.1.16', '0.1.17'].includes(version));
  assert.equal(state.version, version); assert.equal(state.protocol, 1); assert.equal(state.integrated, true);
  assert.deepEqual(state.services, { integrated: true, features: ['setup', 'mcp'] });
}
function assertTicket(ticket, lastTool, hub) {
  assert.equal(ticket.schemaVersion, 1); assert.equal(ticket.fromVersion, '0.1.16'); assert.equal(ticket.toVersion, '0.1.17');
  assert.equal(ticket.views.length, 1); const view = ticket.views[0];
  assert.equal(view.app, lastTool); assert.equal(view.direct, true); assert.equal(view.bundled, true);
  assert.equal(path.win32.normalize(view.path).toLowerCase(), path.win32.normalize(hub).toLowerCase());
}
async function completeStartup(page, version, report) {
  assert.ok(['0.1.16', '0.1.17'].includes(version));
  const terms = page.locator('#usage-terms-dialog'), guide = page.locator('#convergence-dialog');
  if (version === '0.1.16') {
    await terms.waitFor({ state: 'visible' });
    await page.locator('#usage-terms-checkbox').check(); await page.locator('#usage-terms-continue').click();
    await terms.waitFor({ state: 'hidden' });
    await guide.waitFor({ state: 'visible' });
    await page.locator('#convergence-later').click();
    await guide.waitFor({ state: 'hidden' }); report.migrationDeferred = true;
  } else {
    assert.equal(report.migrationDeferred, true, 'Initial migration review must have been visibly deferred');
    assert.equal(await terms.isVisible(), false, 'Terms must survive update');
  }
  await page.waitForFunction(() => document.querySelector('#convergence-dialog')?.open || !document.querySelector('#check-updates').disabled,
    null, { timeout: 120000 });
  assert.equal(await guide.isVisible(), false, 'The deferred unchanged review must stay deferred');
  if (version === '0.1.17') report.migrationDeferralPreserved = true;
}
async function setUpdatePreferences(page, restore) {
  await direct.showHome(page);
  await page.locator('#update-settings > summary').click();
  for (const [id, value] of [['auto-download', false], ['preview-channel', false], ['restore-hosted-views', restore]]) {
    await page.locator(`#${id}`).setChecked(value);
  }
  await page.locator('#update-settings > summary').click();
}
async function main() {
  target.assertAdmission(); // Must precede config/profile reads, installers, policy and native probes.
  const config = target.readConfig(process.env.CREATOR_SELF_UPDATE_LAB_CONFIG);
  target.loadContract(config);
  assert.equal(process.env.CREATOR_SELF_UPDATE_TARGET_VERSION, config.targetVersion);
  assert.equal(process.env.CREATOR_SELF_UPDATE_INSTALLER_SHA256, config.pins.installer);
  assert.equal(process.env.CREATOR_SELF_UPDATE_EXECUTABLE_SHA256, config.pins.executable);
  const installer = process.env.CREATOR_SELF_UPDATE_LAB_BASELINE;
  assert.ok(path.isAbsolute(installer || ''));
  const hashFile = file => target.hash(target.readBounded(file, target.LIMITS.installer));
  assert.equal(hashFile(installer), config.baseline.installer);
  const { chromium } = require('@playwright/test');
  const { managedLocations } = require('../../../scripts/native-managed-target.cjs');
  const { assertOwnedDebugging } = require('../../../scripts/windows-incoming-016.cjs');
  const local = process.env.LOCALAPPDATA, roaming = process.env.APPDATA, home = process.env.USERPROFILE;
  for (const folder of [local, roaming, home]) assert.ok(path.isAbsolute(folder));
  const hub = path.join(local, 'Creator Hub/creator-hub.exe'), route = managedLocations(local);
  const ticket = path.join(local, 'CreatorHub/hub-updates/hosted-restore.json');
  const clientConfig = path.join(home, '.codex/config.toml');
  for (const file of [path.dirname(hub), path.join(local, 'CreatorHub'), path.join(roaming, 'creator-works-mcp'),
    path.join(roaming, 'banter-mcp'), path.join(local, 'CreatorProjectSetup'), clientConfig, path.join(home, '.claude.json')]) {
    assert.equal(fs.existsSync(file), false, 'Existing runner product/profile refused');
  }
  const out = path.join(ROOT, 'artifacts', `native-suite-${Date.now()}`); fs.mkdirSync(out);
  const lastTool = process.env.CREATOR_OUTGOING_LAST_TOOL || 'setup';
  const restore = (process.env.CREATOR_OUTGOING_RESTORE || 'true') === 'true';
  const report = { passed: false, kind: target.KIND, sourceCommit: config.sourceCommit, baseline: config.baseline,
    pins: config.pins, lastTool, restore, labDiscovery: true, publicDiscovery: false, acceptanceOnly: true,
    nativeUpdateAccepted: false, liveAiAcceptance: false, releaseReady: false };
  const ps = (name, args = []) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ROOT, 'scripts', name), ...args], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  const inventory = () => JSON.parse(ps('native-unified-outgoing-process.ps1').replace(/^\uFEFF/, ''));
  const record = pid => { const rows = inventory().filter(p => p.pid === pid); assert.equal(rows.length, 1); return rows[0]; };
  const moduleGuis = () => inventory().filter(p => /(?:creator-works-mcp-launcher|creator-project-setup)\.exe$/i.test(p.image));
  const sameProcess = saved => assert.deepEqual(record(saved.pid), saved, 'Process identity changed');
  const peVersion = patch => {
    const info = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$v=(Get-Item -LiteralPath '${hub.replaceAll("'", "''")}').VersionInfo;ConvertTo-Json -Compress -InputObject @($v.FileMajorPart,$v.FileMinorPart,$v.FileBuildPart,$v.FilePrivatePart)`],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }));
    assert.deepEqual(info, [0, 1, patch, 0], 'Installed PE version differs'); return info;
  };
  let child, browser, page, rootRecord, sentinel, sentinelRecord, sdkClient, sdkTransport, policyEnabled = false, watch;
  let observedTicket, requests = [], settingsBefore, preferencesBefore, sdkRecords = [];
  const stopFile = path.join(out, 'stop-owned-sentinel'), protectedFiles = [];
  const native = action => {
    sameProcess(rootRecord);
    return ps('native-window.ps1', ['-TargetPid', String(rootRecord.pid), '-ExpectedExecutable', hub, '-Action', action]);
  };
  const button = value => {
    sameProcess(rootRecord);
    return ps('native-window.ps1', ['-TargetPid', String(rootRecord.pid), '-ExpectedExecutable', hub, '-Action', 'button', '-Value', value]);
  };
  const policy = action => ps('native-webview-policy.ps1', ['-Action', action, '-StateFile', path.join(out, 'webview-policy.json')]);
  const protect = (file, bytes) => {
    assert.equal(fs.existsSync(file), false); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes, { flag: 'wx' }); protectedFiles.push({ file, sha256: hashFile(file) });
  };
  const preferences = () => page.evaluate(() => Object.fromEntries(['auto-download', 'preview-channel', 'restore-hosted-views']
    .map(id => [id, document.getElementById(id).checked])));
  const show = async feature => {
    await page.locator('#suite-trigger').click(); await page.locator(`#suite-menu [data-view="${feature}"]`).click();
  };
  async function connect(version) {
    const debugging = () => {
      sameProcess(rootRecord);
      assertOwnedDebugging(JSON.parse(ps('native-startup-diagnostics.ps1').replace(/^\uFEFF/, '')), rootRecord.pid, hub);
    };
    await retry(debugging, 90);
    browser = await retry(() => chromium.connectOverCDP('http://127.0.0.1:9238'), 90);
    debugging();
    page = await retry(() => { const result = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('tauri.localhost')); assert.ok(result); return result; });
    page.setDefaultTimeout(30000); requests = direct.watchRequests(page);
    page.on('pageerror', error => { (report.pageErrors ||= []).push(String(error)); });
    await page.waitForFunction(() => window.CreatorHubNative);
    await completeStartup(page, version, report);
    assertProtocol(await page.evaluate(async () => ({ version: window.CreatorHubNative.version,
      protocol: window.__CREATOR_HUB_FEATURE_PROTOCOL__, integrated: window.CreatorHubNative.integratedFeatures,
      services: await window.CreatorHubNative.invoke('feature_status') })), version);
    assert.equal((await page.locator('.footer-version').innerText()).trim(), version);
    await direct.checkCleanDocument(page, requests);
  }
  async function roundTrip(client) {
    assert.ok((await client.listTools()).tools.some(t => t.name === 'get_mcp_reference'));
    const result = await client.callTool({ name: 'get_mcp_reference', arguments: { source: 'creator-docs', query: 'PersistFileBridge', limit: 1 } });
    assert.notEqual(result.isError, true); assert.equal(JSON.parse(result.content[0].text).success, true);
  }
  function active(version) {
    const value = JSON.parse(target.readBounded(route.active, 4096));
    const expected = config.runtime[version === '0.1.16' ? 'baselineDescriptor' : 'targetDescriptor'];
    assert.equal(value.descriptorSha256, expected); assert.match(value.generation, /^[a-f0-9]{64}$/);
    const body = target.readBounded(path.join(path.dirname(route.active), 'descriptors', expected, 'runtime.json'), target.LIMITS.metadata);
    assert.equal(target.hash(body), expected); assert.equal(JSON.parse(body).hubVersion, version);
    return value;
  }
  async function preserved() {
    for (const { file, sha256 } of protectedFiles) assert.equal(hashFile(file), sha256);
    assert.deepEqual(direct.settingsSnapshot(roaming, local), settingsBefore);
    assert.deepEqual(await preferences(), preferencesBefore);
    assert.equal(fs.existsSync(clientConfig), false);
    sameProcess(sentinelRecord); for (const p of sdkRecords) sameProcess(p);
    await roundTrip(sdkClient); assert.deepEqual(moduleGuis(), []);
  }
  try {
    assert.deepEqual(inventory().filter(p => /creator-hub\.exe$/i.test(p.image)), []);
    execFileSync(installer, ['/S', '/NS'], { windowsHide: true, timeout: 180000, stdio: 'pipe' });
    assert.equal(hashFile(hub), config.baseline.exe); report.beforePeVersion = peVersion(16);
    const settings = '{"channels":[],"auto_start":false,"futureOption":{"keep":true}}\n';
    protect(path.join(roaming, 'creator-works-mcp/launcher-config.json'), settings);
    protect(path.join(roaming, 'banter-mcp/launcher-config.json'), settings.replaceAll('\n', '\r\n'));
    protect(path.join(local, 'CreatorProjectSetup/editor-roots.json'), '[]\n');
    protect(path.join(home, '.claude.json'), '{"mcpServers":{},"outgoingSentinel":"keep"}\n');
    protect(path.join(path.dirname(hub), 'outgoing-preservation.txt'), 'Keep unmanaged installation content.\n');
    protect(path.join(out, 'synthetic-project/Assets/untouched.txt'), 'Synthetic project content; never opened or repaired.\n');
    policyEnabled = true; policy('Enable');
    child = spawn(hub, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9238' } });
    rootRecord = await retry(() => record(child.pid)); report.beforeRoot = rootRecord;
    await connect('0.1.16');
    await direct.checkPages({ page, showApp: show, processes: moduleGuis, requests,
      screenshot: name => page.screenshot({ path: path.join(out, `baseline-${name}.png`) }) });
    await direct.prepareManagedRoute(page, { clientConfig, active: route.active,
      approve: () => retry(() => button('Enable managed routing')) });
    report.beforeRoute = active('0.1.16');
    const sdk = require('node:module').createRequire(path.join(ROOT, 'modules/mcp/package.json'));
    const { Client } = sdk('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = sdk('@modelcontextprotocol/sdk/client/stdio.js');
    sdkClient = new Client({ name: 'outgoing-direct-existing-connection', version: '1' });
    sdkTransport = new StdioClientTransport({ command: route.command, args: [], stderr: 'ignore' });
    await sdkClient.connect(sdkTransport); await roundTrip(sdkClient);
    sdkRecords = await retry(() => {
      const rows = inventory(), router = rows.find(p => p.pid === sdkTransport.pid);
      assert.ok(router); assert.equal(router.image.toLowerCase(), route.command.toLowerCase());
      const node = rows.filter(p => p.parentPid === router.pid && /node\.exe$/i.test(p.image));
      assert.equal(node.length, 1); return [router, node[0]];
    });
    sentinel = spawn(process.execPath, [path.join(ROOT, 'scripts/owned-hub-fixture.cjs'), stopFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let ready = ''; sentinel.stdout.on('data', bytes => { ready += bytes; });
    await retry(() => { assert.match(ready, /ready/); assert.equal(sentinel.exitCode, null); }); sentinelRecord = record(sentinel.pid);
    await setUpdatePreferences(page, restore);
    await retry(() => page.locator('#suite-trigger').isEnabled().then(value => assert.equal(value, true)));
    await show(lastTool); await direct.showHome(page);
    settingsBefore = direct.settingsSnapshot(roaming, local); preferencesBefore = await preferences();
    const prefPath = path.join(local, 'CreatorHub/preferences/hub-preferences.json');
    await retry(() => { const saved = JSON.parse(fs.readFileSync(prefPath)); assert.equal(saved.restoreHostedViews, restore); assert.equal(saved.autoDownload, false); assert.equal(saved.previewChannel, false); });
    protectedFiles.push({ file: prefPath, sha256: hashFile(prefPath) });
    const draft = await page.locator('#feature-setup [data-field="name"]').inputValue();
    await page.evaluate(() => localStorage.setItem('outgoing-preserved', 'direct16-to17'));
    await retry(async () => assert.equal(await page.locator('#hub-update-button').isEnabled(), true), 90);
    const status = await page.evaluate(() => window.CreatorHubNative.invoke('hub_update_status', { online: false, preview: false }));
    assert.equal(status.currentVersion, '0.1.16'); assert.equal(status.availableVersion, '0.1.17'); assert.equal(status.installBlocked, null);
    // Auto-download is off: first click downloads, next invokes the native approval.
    if (!status.downloaded) {
      await page.locator('#hub-update-button').click();
      await retry(async () => { const s = await page.evaluate(() => window.CreatorHubNative.invoke('hub_update_status', { online: false, preview: false })); assert.equal(s.downloaded, true); }, 120);
    }
    await page.locator('#hub-update-button').click(); await retry(() => button('Not now'));
    await retry(async () => assert.equal(await page.locator('#hub-update-button').isEnabled(), true));
    sameProcess(rootRecord); assert.equal(hashFile(hub), config.baseline.exe); await preserved();
    assert.equal(await page.locator('#feature-setup [data-field="name"]').inputValue(), draft);
    assert.equal(fs.existsSync(ticket), false); report.cancelPreserved = true;
    watch = setInterval(() => { try { observedTicket = JSON.parse(target.readBounded(ticket, 32768)); } catch {} }, 20);
    await page.locator('#hub-update-button').click(); await retry(() => button('Update Hub'));
    await retry(() => assert.equal(child.exitCode, 0), 180);
    await browser.close().catch(() => {}); browser = null; page = null;
    await retry(() => assert.equal(hashFile(hub), config.pins.executable), 180);
    report.afterPeVersion = peVersion(17);
    // Deliberately no launch here: a replacement process must appear automatically.
    rootRecord = await retry(() => { const rows = inventory().filter(p => p.image.toLowerCase() === hub.toLowerCase() && p.pid !== child.pid); assert.equal(rows.length, 1); return rows[0]; }, 90);
    report.afterRoot = rootRecord; await connect('0.1.17');
    clearInterval(watch); watch = null;
    if (restore) {
      assertTicket(observedTicket, lastTool, hub); await direct.checkRestored(page);
      await page.waitForFunction(feature => document.querySelector(`#feature-${feature} [data-field="status"]`)?.textContent === 'Ready', lastTool);
      assert.equal(await page.locator(`#feature-${lastTool}`).isVisible(), true);
    } else { assert.equal(observedTicket, undefined); await direct.checkHome(page); }
    assert.equal(fs.existsSync(ticket), false);
    assert.equal(await page.evaluate(() => localStorage.getItem('outgoing-preserved')), 'direct16-to17');
    await preserved();
    await page.screenshot({ path: path.join(out, 'automatic-restart.png') });
    report.restoredLastTool = restore ? lastTool : null;
    for (const feature of ['setup', 'mcp']) {
      await show(feature);
      await page.waitForFunction(name => document.querySelector(`#feature-${name} [data-field="status"]`)?.textContent === 'Ready', feature);
      const service = await page.evaluate(name => window.CreatorHubNative.invoke('feature_call', {
        feature: name, command: name === 'mcp' ? 'get_onboarding_status' : 'probe_environment',
        args: name === 'mcp' ? { unityProjectPath: null } : {},
      }), feature);
      direct.assertService(feature, service);
    }
    await direct.prepareManagedRoute(page, { clientConfig, active: route.active, approve: () => { throw Error('Existing route must not require new consent'); } });
    report.afterRoute = active('0.1.17');
    const reconnect = new Client({ name: 'outgoing-direct-new-connection', version: '1' });
    try {
      const transport = new StdioClientTransport({ command: route.command, args: [], stderr: 'ignore' });
      await reconnect.connect(transport); await roundTrip(reconnect);
      const router = record(transport.pid); assert.notEqual(router.pid, sdkRecords[0].pid);
      assert.equal(router.image.toLowerCase(), route.command.toLowerCase());
      const nodes = inventory().filter(p => p.parentPid === router.pid && /node\.exe$/i.test(p.image));
      assert.equal(nodes.length, 1); assert.equal(nodes[0].image, sdkRecords[1].image);
      report.reconnectedProcesses = [router, nodes[0]];
    }
    finally { await reconnect.close(); }
    await preserved(); await direct.checkCleanDocument(page, requests);
    const registry = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Creator Hub', '/v', 'DisplayVersion'], { encoding: 'utf8', windowsHide: true });
    assert.equal(registry.match(/DisplayVersion\s+REG_SZ\s+(\S+)/)?.[1], '0.1.17');
    assert.deepEqual(report.pageErrors || [], []);
    Object.assign(report, { passed: true, nativeUpdateAccepted: true, automaticRestart: true, settingsPreserved: true,
      existingConnectionSurvived: true, newConnectionVerified: true, restorationVerified: true, observedTicket });
  } catch (error) {
    report.error = String(error.stack || error).slice(0, 16000); process.exitCode = 1;
    try { if (page) await page.screenshot({ path: path.join(out, 'failure.png') }); } catch {}
  } finally {
    if (watch) clearInterval(watch);
    try { if (sdkClient) await sdkClient.close(); } catch { report.passed = false; report.sdkCleanupFailed = true; }
    try { if (rootRecord) { native('close'); await retry(() => assert.equal(inventory().some(p => p.pid === rootRecord.pid && p.startTicks === rootRecord.startTicks), false)); } }
    catch { report.passed = false; report.rootCleanupFailed = true; }
    if (browser) await browser.close().catch(() => {});
    if (policyEnabled) { try { policy('Restore'); report.policyRestored = true; } catch { report.passed = false; report.policyRestored = false; } }
    if (sentinel?.exitCode === null) {
      fs.writeFileSync(stopFile, 'exit', { flag: 'wx' });
      try { await retry(() => assert.equal(sentinel.exitCode, 0)); } catch { report.passed = false; report.sentinelCleanupFailed = true; }
    }
    if (!report.passed) process.exitCode = 1;
    fs.writeFileSync(path.join(out, 'outgoing-report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ out, passed: report.passed, releaseReady: false }));
  }
}
module.exports = { assertProtocol, assertTicket, completeStartup, setUpdatePreferences, main };
if (require.main === module) main().catch(error => { console.error(String(error.message).slice(0, 1200)); process.exitCode = 1; });
