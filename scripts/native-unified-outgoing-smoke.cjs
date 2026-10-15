// Inert when imported. Real native operations only on the admitted disposable Windows runner.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const target = require('./native-unified-outgoing-target.cjs');
const checks = require('./native-unified-outgoing-checks.cjs');

function assertAdmission(env = process.env, platform = process.platform) {
  target.assertProxy(env);
  assert.equal(platform, 'win32', 'Native outgoing test requires Windows');
  assert.ok(path.isAbsolute(env.CREATOR_SELF_UPDATE_LAB_CONFIG || ''), 'Absolute outgoing config required');
  assert.ok(path.isAbsolute(env.CREATOR_SELF_UPDATE_LAB_BASELINE || ''), 'Stage the reviewed B05 installer first');
}
async function retry(read, seconds = 30) {
  const deadline = Date.now() + seconds * 1000;
  let last;
  do {
    try { return await read(); } catch (error) { last = error; }
    await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  throw last;
}
async function main() {
  assertAdmission(); // Must precede file, registry, SDK, UI, process and policy operations.
  const contract = target.selectLab(process.env.CREATOR_SELF_UPDATE_LAB_CONFIG);
  const labConfig = target.validateConfig(JSON.parse(target.readBounded(process.env.CREATOR_SELF_UPDATE_LAB_CONFIG, target.LIMITS.metadata)));
  const { chromium } = require('playwright');
  const { managedLocations, verifyMigratedTarget } = require('./native-managed-target.cjs');
  const sdk = require('node:module').createRequire(path.resolve(__dirname, '../modules/mcp/package.json'));
  const { Client } = sdk('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = sdk('@modelcontextprotocol/sdk/client/stdio.js');
  const local = process.env.LOCALAPPDATA, roaming = process.env.APPDATA;
  assert.ok(path.isAbsolute(local || '') && path.isAbsolute(roaming || ''));
  const hub = path.join(local, 'Creator Hub', 'creator-hub.exe');
  const config = path.join(roaming, 'creator-works-mcp', 'launcher-config.json');
  const prefs = path.join(local, 'CreatorHub', 'preferences', 'hub-preferences.json');
  const ticket = path.join(local, 'CreatorHub', 'hub-updates', 'hosted-restore.json');
  const setupSettings = path.join(local, 'CreatorProjectSetup', 'editor-roots.json');
  const route = managedLocations(local);
  for (const file of [hub, config, prefs, ticket, setupSettings, route.active, route.command]) {
    assert.equal(fs.existsSync(file), false, 'Fresh disposable profile required; existing installations/settings refused');
  }
  const installer = process.env.CREATOR_SELF_UPDATE_LAB_BASELINE;
  const installerBytes = target.readBounded(installer, target.LIMITS.installer);
  assert.equal(target.hash(installerBytes), target.BASELINE.installer);
  const out = path.resolve(__dirname, '../artifacts', `native-suite-${Date.now()}`);
  fs.mkdirSync(out, { recursive: false });
  const report = checks.newReport(); report.feed = target.discoveryScope(contract);
  const ps = (file, args = []) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.resolve(__dirname, file), ...args], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  const inventory = () => {
    const records = JSON.parse(ps('native-unified-outgoing-process.ps1'));
    assert.ok(Array.isArray(records) && records.length <= 128);
    records.forEach(checks.processRecord); return records;
  };
  const record = pid => {
    const found = inventory().filter(entry => entry.pid === pid);
    assert.equal(found.length, 1, 'Exact expected kernel process missing/unavailable'); return found[0];
  };
  const native = (owner, action, value) => {
    checks.sameProcess(owner, record(owner.pid));
    return ps('native-window.ps1', ['-TargetPid', String(owner.pid), '-ExpectedExecutable', owner.image,
      '-Action', action, ...(value ? ['-Value', value] : [])]);
  };
  const press = async (owner, title, value) => {
    await retry(() => {
      const windows = JSON.parse(native(owner, 'snapshot'));
      const matches = windows.filter(window => window.title === title && window.class === '#32770')
        .flatMap(window => window.controls.filter(control => control.name === value &&
          /^CommandButton_(1000|1001)$/.test(control.id) && control.processId === owner.pid));
      assert.equal(matches.length, 1, 'Exactly one native owned consent control required');
    });
    // Read polling never retries actions. The existing helper retains final native authority.
    native(owner, 'button', value);
    report.nativePermissions ||= []; report.nativePermissions.push({ pid: owner.pid, startTicks: owner.startTicks, title, value });
  };
  const bytes = file => fs.existsSync(file) ? target.readBounded(file, 1024 * 1024) : null;
  const store = file => {
    const value = bytes(file);
    return value === null ? { present: false } : { present: true, size: value.length, sha256: target.hash(value) };
  };
  const hashFile = file => target.hash(target.readBounded(file, target.LIMITS.installer));
  const frames = {}, backends = {};
  let child, root, browser, page, unrelated, sdkClient, sdkTransport, sdkRouter, sdkNode;
  let policyEnabled = false, ticketTimer, observedTicket, ticketError, unrelatedIdentity;
  const stopFile = path.join(out, 'unrelated-stop');
  const sentinel = path.join(path.dirname(hub), 'ci-unified-outgoing-sentinel.txt');
  const policy = action => ps('native-webview-policy.ps1', ['-Action', action, '-StateFile', path.join(out, 'webview-policy.json')]);
  const preferences = () => page.evaluate(() => Object.fromEntries(
    ['preview-channel', 'auto-download', 'restore-hosted-views'].map(id => [id, document.getElementById(id).checked])));
  const show = async app => {
    await page.locator('#suite-trigger').click(); await page.locator(`#suite-menu [data-view="${app}"]`).click();
    if (app === 'hub') await page.locator('#hub-pages [data-view="hub"]').click();
  };
  const connect = async (version, restoring = false) => {
    browser = await retry(() => chromium.connectOverCDP('http://127.0.0.1:9238'), 90);
    page = await retry(() => {
      const pages = browser.contexts().flatMap(context => context.pages()).filter(view => view.url().includes('tauri.localhost'));
      assert.equal(pages.length, 1); return pages[0];
    });
    page.setDefaultTimeout(30000);
    await page.waitForFunction(() => window.CreatorHubNative);
    if (!restoring) {
      await page.locator('#usage-terms-dialog').waitFor({ state: 'visible' });
      await page.locator('#usage-terms-checkbox').check(); await page.locator('#usage-terms-continue').click();
    }
    await retry(async () => assert.equal(await page.evaluate(() => window.CreatorHubNative.invoke('usage_terms_status')), true,
      'Native terms receipt must be saved and survive restart; do not invent a replacement'));
    await page.locator('#usage-terms-dialog').waitFor({ state: 'hidden' });
    if (restoring) await page.waitForFunction(() => document.querySelector('#convergence-dialog')?.open ||
      !document.querySelector('#hosted-restore').classList.contains('hidden'));
    assert.equal(await page.locator('#convergence-dialog').isVisible(), false);
    const diagnostics = JSON.parse(ps('native-startup-diagnostics.ps1'));
    assert.ok(diagnostics.listeners.length && diagnostics.listeners.every(listener => ['127.0.0.1', '::1'].includes(listener.LocalAddress)));
    assert.equal((await page.locator('.footer-version').innerText()).trim(), version);
  };
  const verifyConvergence = async version => {
    const convergence = await retry(() => page.evaluate(() => window.CreatorHubNative.invoke('convergence_status')));
    report.convergence ||= []; report.convergence.push({ version, ...convergence });
    assert.equal(convergence.required, false, 'Fresh/Hub-saved settings unexpectedly require legacy migration; parent repeat-launch gate');
    assert.equal(await page.locator('#convergence-dialog').isVisible(), false);
  };
  const moduleManifest = () => {
    // This is a pinned staging input, not an invented installed resource/receipt.
    // Each actual retained/package backend file is independently checked below.
    return target.readBuiltinManifest(labConfig.builtinManifestPath);
  };
  const backendFor = async (app, manifest) => retry(() => {
    const found = inventory().filter(entry => entry.parentPid === root.pid &&
      path.basename(entry.image).toLowerCase() === path.basename(manifest.modules[app].executable).toLowerCase());
    assert.equal(found.length, 1); const backend = found[0];
    let generation;
    if (app === 'setup') assert.equal(backend.image.toLowerCase(), path.join(path.dirname(hub), 'modules', manifest.modules.setup.executable).toLowerCase());
    else {
      generation = path.dirname(path.dirname(backend.image));
      assert.equal(path.dirname(generation).toLowerCase(), path.join(local, 'creator-hub', 'runtime-generations', 'windows-x86_64').toLowerCase());
      assert.match(path.basename(generation), /^[a-f0-9]{64}$/);
    }
    for (const [name, pin] of Object.entries(manifest.modules[app].files)) {
      assert.equal(hashFile(path.join(generation || path.join(path.dirname(hub), 'modules'), name)), pin);
    }
    return backend;
  });
  const readyFrame = async (app, visible = true) => {
    frames[app] = await retry(async () => {
      const element = await page.locator(`#${app}-host-frame`).elementHandle();
      const frame = element && await element.contentFrame(); assert.ok(frame); return frame;
    });
    if (app === 'setup') await frames[app].locator('#requirements .requirement').first().waitFor({ state: visible ? 'visible' : 'attached', timeout: 90000 });
    else await frames[app].waitForFunction(() => !document.querySelector('#workspaceControls').disabled);
  };
  const approveBackend = async (app, manifest, visible = true) => {
    backends[app] = await backendFor(app, manifest);
    await press(backends[app], app === 'mcp' ? 'Open MCP in Creator Hub?' : 'Open Setup in Creator Hub?',
      app === 'mcp' ? 'Enable MCP controls' : 'Open in Hub');
    await readyFrame(app, visible);
    if (app === 'mcp' && await frames.mcp.locator('#connection-guide-close').isVisible()) await frames.mcp.locator('#connection-guide-close').click();
  };
  const sdkRoundTrip = async client => {
    assert.ok((await client.listTools()).tools.some(tool => tool.name === 'get_mcp_reference'));
    const response = await client.callTool({ name: 'get_mcp_reference', arguments: { source: 'creator-docs', query: 'PersistFileBridge', limit: 1 } });
    assert.equal(response.isError === true, false); assert.equal(JSON.parse(response.content[0].text).success, true);
  };
  const activeRoute = version => {
    const receipt = JSON.parse(target.readBounded(route.active, 4096));
    assert.deepEqual(Object.keys(receipt).sort(), ['descriptorSha256', 'generation', 'schemaVersion']);
    assert.match(receipt.descriptorSha256, /^[a-f0-9]{64}$/);
    assert.match(receipt.generation, /^[a-f0-9]{64}$/);
    const directory = path.join(path.dirname(route.active), 'descriptors', receipt.descriptorSha256);
    const descriptorBytes = target.readBounded(path.join(directory, 'runtime.json'), target.LIMITS.metadata);
    assert.equal(target.hash(descriptorBytes), receipt.descriptorSha256);
    const descriptor = JSON.parse(descriptorBytes);
    const result = { ...receipt, hubVersion: descriptor.hubVersion };
    checks.activeRoute(result, version);
    assert.equal(descriptor.platform, 'windows'); assert.equal(descriptor.arch, 'x86_64');
    assert.equal(descriptor.product, 'com.creatorworks.hub.mcp-runtime');
    assert.deepEqual(descriptor.module, moduleManifest().modules.mcp);
    assert.equal(receipt.generation, path.basename(path.dirname(path.dirname(backends.mcp.image))));
    const signature = target.readBounded(path.join(directory, 'runtime.minisig'), target.LIMITS.signature);
    assert.equal(target.hash(signature), version === target.BASELINE.version ?
      moduleManifest().managedRouting.files['routing/runtime.minisig'] : target.TARGET.runtimeSignature);
    // Receipt metadata alone is not authority. Real SDK router connections below
    // independently execute the signed descriptor/payload verification path.
    return result;
  };
  const snapshot = async forms => ({ root: record(root.pid), backends: Object.fromEntries(['mcp', 'setup'].map(app => [app, record(backends[app].pid)])),
    sdkRouter: record(sdkRouter.pid), sdkNode: record(sdkNode.pid), unrelated: record(unrelated.pid),
    executableSha256: hashFile(hub), stores: Object.fromEntries(Object.entries({ mcp: config, preferences: prefs, setup: setupSettings, installedContent: sentinel }).map(([name, file]) => [name, store(file)])),
    preferences: await preferences(), forms: forms ? { setup: await frames.setup.locator('#project-name').inputValue(),
      mcp: await frames.mcp.locator('#projectPath').inputValue() } : null,
    activeRoute: activeRoute(root.pid === child.pid ? target.BASELINE.version : target.TARGET.version),
    ticketExists: fs.existsSync(ticket), rootExit: { code: child.exitCode, signal: child.signalCode } });
  try {
    const install = spawn(installer, ['/S', '/NS'], { windowsHide: true, stdio: 'ignore' });
    await retry(() => { assert.equal(install.exitCode, 0); assert.equal(install.signalCode, null); }, 120);
    target.assertBaselineBytes(installerBytes, target.readBounded(hub, target.LIMITS.installer));
    const manifest = moduleManifest();
    fs.writeFileSync(sentinel, 'Keep unrelated installed content across the acceptance-only update.', { flag: 'wx' });
    policyEnabled = true; policy('Enable');
    child = spawn(hub, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9238' } });
    root = await retry(() => record(child.pid));
    assert.equal(root.image.toLowerCase(), hub.toLowerCase()); assert.equal(root.parentPid, process.pid);
    await connect(target.BASELINE.version);
    await page.waitForFunction(() => !document.querySelector('#check-updates').disabled, null, { timeout: 180000 });
    await verifyConvergence(target.BASELINE.version);
    const apps = await page.evaluate(() => window.CreatorHubNative.invoke('app_inventory', { check: false, preview: true }));
    assert.equal(apps.supported, true); assert.equal(apps.apps.length, 2);
    assert.ok(apps.apps.every(app => app.builtIn && app.trusted && !app.issue && app.detectedCopies.length === 0));
    await show('setup'); await approveBackend('setup', manifest);
    await show('mcp'); await press(root, 'Enable managed MCP routing', 'Enable managed routing'); await approveBackend('mcp', manifest);
    verifyMigratedTarget({ command: route.command, args: [] }, manifest, null, local);
    await frames.mcp.locator('.advanced-section summary').click();
    assert.equal(await frames.mcp.locator('#autoConfig').isChecked(), false);
    await frames.mcp.locator('label[for="autoConfig"]').click();
    assert.equal(await frames.mcp.locator('#autoConfig').isChecked(), true);
    await retry(() => assert.equal(JSON.parse(bytes(config)).auto_start, true));
    await frames.mcp.locator('label[for="autoConfig"]').click();
    assert.equal(await frames.mcp.locator('#autoConfig').isChecked(), false);
    await retry(() => assert.equal(JSON.parse(bytes(config)).auto_start, false));
    await frames.mcp.locator('#mcpServerPath').fill(path.join(path.dirname(path.dirname(backends.mcp.image)), 'mcp/server/creator-works-mcp.mjs'));
    await frames.mcp.locator('#mcpServerPath').press('Tab');
    await retry(() => assert.equal(JSON.parse(bytes(config)).mcp_server_path, path.join(path.dirname(path.dirname(backends.mcp.image)), 'mcp/server/creator-works-mcp.mjs')));
    await frames.mcp.locator('#projectPath').fill('Unsubmitted MCP project draft');
    await show('setup'); await frames.setup.locator('#project-name').fill('Unsubmitted Setup project draft');
    await show('hub');
    for (const [id, value] of [['preview-channel', false], ['auto-download', true], ['restore-hosted-views', true]]) {
      await page.locator(`#${id}`).setChecked(!value); await page.locator(`#${id}`).setChecked(value);
    }
    await retry(() => assert.deepEqual(JSON.parse(bytes(prefs)), { schemaVersion: 1, preview: false, autoDownload: true, restoreHostedViews: true }));
    unrelated = spawn(process.execPath, [path.join(__dirname, 'owned-hub-fixture.cjs'), stopFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    unrelatedIdentity = await retry(() => record(unrelated.pid));
    assert.equal(unrelatedIdentity.image.toLowerCase(), process.execPath.toLowerCase());
    assert.equal(unrelatedIdentity.parentPid, process.pid);
    sdkClient = new Client({ name: 'unified-outgoing-existing-14', version: '1' });
    sdkTransport = new StdioClientTransport({ command: route.command, args: [], stderr: 'pipe' });
    // Drain stderr without copying private/runtime text into the acceptance report.
    sdkTransport.stderr?.resume(); await sdkClient.connect(sdkTransport); await sdkRoundTrip(sdkClient);
    sdkRouter = record(sdkTransport.pid); assert.equal(sdkRouter.image.toLowerCase(), route.command.toLowerCase());
    assert.equal(sdkRouter.parentPid, process.pid);
    sdkNode = await retry(() => {
      const found = inventory().filter(entry => entry.parentPid === sdkRouter.pid && entry.image.toLowerCase() ===
        path.join(path.dirname(path.dirname(backends.mcp.image)), 'mcp/server/runtime/node.exe').toLowerCase());
      assert.equal(found.length, 1); return found[0];
    });
    await retry(async () => assert.equal(await page.locator('#hub-update-button').isEnabled(), true), 120);
    const update = await page.evaluate(() => window.CreatorHubNative.invoke('hub_update_status', { online: false, preview: false }));
    assert.equal(update.currentVersion, target.BASELINE.version); assert.equal(update.availableVersion, target.TARGET.version);
    assert.equal(update.installBlocked, null); assert.equal(update.warning, null);
    const before = await snapshot(true); report.before = before;
    const preservedBytes = new Map([config, prefs, setupSettings, sentinel].map(file => [file, bytes(file)]));
    const beforeRouteBytes = bytes(route.active);
    await page.screenshot({ path: path.join(out, 'before-update.png') });
    await page.locator('#hub-update-button').click(); await press(root, 'Update Creator Hub', 'Not now');
    await retry(async () => assert.equal(await page.locator('#hub-update-button').isEnabled(), true));
    const cancelled = await snapshot(true); checks.cancelPreserved(before, cancelled); await sdkRoundTrip(sdkClient);
    for (const [file, expected] of preservedBytes) assert.deepEqual(bytes(file), expected, 'Native Cancel changed actual file bytes');
    assert.deepEqual(bytes(route.active), beforeRouteBytes, 'Native Cancel changed exact activation bytes');
    report.cancelled = cancelled; report.checks.push('Native Cancel preserves both drafts, exact process starts, config/preferences bytes, SDK14 and unrelated runtime.');
    ticketTimer = setInterval(() => {
      if (!observedTicket && !ticketError && fs.existsSync(ticket)) {
        try {
          observedTicket = JSON.parse(target.readBounded(ticket, 16 * 1024));
          report.observedRestoreTicket = observedTicket;
          checks.restoreTicket(observedTicket, before);
        }
        catch (error) { ticketError = error; }
      }
    }, 25);
    await page.locator('#hub-update-button').click(); await press(root, 'Update Creator Hub', 'Update Hub');
    await retry(() => { assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null); }, 180);
    await browser.close().catch(() => {}); browser = null; page = null;
    await retry(() => assert.equal(hashFile(hub), target.TARGET.pins.executable), 180);
    root = await retry(() => {
      const found = inventory().filter(entry => entry.image.toLowerCase() === hub.toLowerCase() && entry.pid !== child.pid);
      assert.equal(found.length, 1); return found[0];
    }, 120); // The replacement is never spawned by this driver.
    await connect(target.TARGET.version, true);
    const afterManifest = moduleManifest();
    for (const app of ['setup', 'mcp']) await approveBackend(app, afterManifest, false);
    await page.waitForFunction(() => document.querySelector('#hosted-restore-message').textContent === 'Your app views have reopened. Select an app from the menu.');
    await verifyConvergence(target.TARGET.version);
    clearInterval(ticketTimer); ticketTimer = null;
    if (ticketError) throw ticketError;
    checks.restoreTicket(observedTicket, before);
    assert.equal(await page.locator('#view-hub').isVisible(), true, 'Restoration must not navigate away from Apps');
    const restoredFrames = [];
    for (const app of ['setup', 'mcp']) {
      await show(app); await readyFrame(app); restoredFrames.push(app);
      await page.screenshot({ path: path.join(out, `restored-${app}.png`) });
    }
    await show('hub');
    checks.sameProcess(sdkRouter, record(sdkTransport.pid)); await sdkRoundTrip(sdkClient);
    verifyMigratedTarget({ command: route.command, args: [] }, afterManifest, null, local);
    const reconnects = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      const client = new Client({ name: 'unified-outgoing-new-15', version: '1' });
      const transport = new StdioClientTransport({ command: route.command, args: [], stderr: 'pipe' });
      transport.stderr?.resume();
      try {
        await client.connect(transport); await sdkRoundTrip(client);
        const router = record(transport.pid);
        assert.equal(router.image.toLowerCase(), route.command.toLowerCase()); assert.equal(router.parentPid, process.pid);
        const node = await retry(() => {
          const found = inventory().filter(entry => entry.parentPid === router.pid && entry.image.toLowerCase() ===
            path.join(path.dirname(path.dirname(backends.mcp.image)), 'mcp/server/runtime/node.exe').toLowerCase());
          assert.equal(found.length, 1); return found[0];
        });
        reconnects.push({ router, node, activation: activeRoute(target.TARGET.version) });
      } finally { await client.close(); }
    }
    for (const [file, expected] of preservedBytes) assert.deepEqual(bytes(file), expected, 'Actual before/after file bytes differ');
    const after = await snapshot(false);
    const registry = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Creator Hub', '/v', 'DisplayVersion'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const evidence = { originalExit: { code: child.exitCode, signal: child.signalCode }, manualTargetLaunches: 0,
      footerVersion: (await page.locator('.footer-version').innerText()).trim(), registryVersion: registry.match(/DisplayVersion\s+REG_SZ\s+(\S+)/)?.[1],
      originalBackendsAbsent: Object.values(before.backends).every(backend => !inventory().some(entry => entry.pid === backend.pid)),
      observedTicket, pendingRestore: await page.evaluate(() => window.CreatorHubNative.invoke('pending_hosted_restore')),
      restoreMessage: await page.locator('#hosted-restore-message').innerText(), restoredFrames,
      existingSdkRoundTrip: true, newRouterRoundTrips: reconnects.length,
      actualNativePermissions: report.nativePermissions.filter(permission => ['Open in Hub', 'Enable MCP controls'].includes(permission.value)).length === 4 };
    checks.approvedUpdate(before, after, evidence);
    report.after = after; report.evidence = evidence; report.reconnects = reconnects;
    report.checks.push('Exact signed15 automatic restart, original idle backends gone, both real native-permission views restored, observed ticket consumed, SDK14 survives and new router reconnects twice.');
    report.outgoingHostedUpdateTested = true; report.passed = true;
  } catch (error) {
    report.error = String(error.stack || error); process.exitCode = 1;
    try { if (page) await page.screenshot({ path: path.join(out, 'failure.png') }); } catch { /* Preserve original failure. */ }
  } finally {
    if (ticketTimer) clearInterval(ticketTimer);
    try { if (sdkClient) await sdkClient.close(); } catch (error) { report.sdkCleanupError = String(error); report.passed = false; }
    try {
      if (root && inventory().some(entry => entry.pid === root.pid)) {
        native(root, 'close');
        await retry(() => assert.equal(inventory().some(entry => entry.pid === root.pid), false));
      }
    } catch (error) { report.rootCleanupError = String(error); report.passed = false; }
    try {
      if (unrelated) {
        checks.sameProcess(unrelatedIdentity, record(unrelated.pid));
        fs.writeFileSync(stopFile, 'Stop only this test-owned unrelated fixture.', { flag: 'wx' });
        await retry(() => { assert.equal(unrelated.exitCode, 0); assert.equal(unrelated.signalCode, null); });
      }
    } catch (error) { report.unrelatedCleanupError = String(error); report.passed = false; }
    if (browser) await browser.close().catch(() => {});
    try { if (policyEnabled) { policy('Restore'); report.policyRestored = true; } }
    catch (error) { report.policyCleanupError = String(error); report.passed = false; }
    if (!report.passed) process.exitCode = 1;
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ kind: report.kind, passed: report.passed, report: path.join(out, 'report.json'),
      outgoingHostedUpdateTested: report.outgoingHostedUpdateTested, publicDiscovery: false, productAcceptance: false, releaseReady: false }));
  }
  return report;
}
module.exports = { assertAdmission, main };
if (require.main === module) main().catch(error => { console.error(String(error.message || error)); process.exitCode = 1; });
