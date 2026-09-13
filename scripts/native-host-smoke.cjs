// Explicit native acceptance. Only the optional project-parent flag creates a fresh project.
const { chromium } = require('@playwright/test');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setupOperationFinished } = require('./native-smoke-state.cjs');
const hub = path.resolve(process.env.CREATOR_HUB_EXE || '../CREATOR-PROJECT-SETUP/src-tauri/target/release/creator-hub.exe');
const setup = path.resolve(process.env.CREATOR_SETUP_EXE || '../CREATOR-PROJECT-SETUP/src-tauri/target/release/creator-project-setup.exe');
const mcp = process.env.CREATOR_MCP_EXE ? path.resolve(process.env.CREATOR_MCP_EXE) : null;
const lifecyclePreview = process.env.CREATOR_HOST_SMOKE_MCP_EVENTS === '1';
if (lifecyclePreview && !mcp) throw Error('Read-only lifecycle acceptance requires an exact MCP executable.');
const out = path.resolve('artifacts', `hosted-native-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const report = { started: new Date().toISOString(), hub, setup, hubSha256: crypto.createHash('sha256').update(fs.readFileSync(hub)).digest('hex'), setupSha256: crypto.createHash('sha256').update(fs.readFileSync(setup)).digest('hex'), checks: [] };
for (const [name, actual] of [['HUB', report.hubSha256], ['SETUP', report.setupSha256]]) {
  const expected = process.env[`CREATOR_HOST_SMOKE_${name}_SHA256`];
  if (expected) assert.equal(actual, expected.toLowerCase(), `${name} candidate changed before launch`);
}
let requestedProject = null;
if (process.env.CREATOR_HOST_SMOKE_PROJECT_PARENT) {
  const parent = path.resolve(process.env.CREATOR_HOST_SMOKE_PROJECT_PARENT);
  assert.equal(fs.statSync(parent).isDirectory(), true);
  const name = process.env.CREATOR_HOST_SMOKE_PROJECT_NAME || `CreatorHostedSmoke-${Date.now()}`;
  assert.match(name, /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/, 'Use a single, safe project folder name');
  requestedProject = { parent, name, path: path.join(parent, name) };
  assert.equal(fs.existsSync(requestedProject.path), false, 'Never reuse or overwrite a project');
}
if (mcp) { report.mcp = mcp; report.mcpSha256 = crypto.createHash('sha256').update(fs.readFileSync(mcp)).digest('hex'); }
const configMetadata = () => ['creator-works-mcp', 'banter-mcp'].map(name => {
  const file = path.join(process.env.APPDATA, name, 'launcher-config.json');
  if (!fs.existsSync(file)) return { name, exists: false };
  const stat = fs.statSync(file);
  return { name, exists: true, size: stat.size, modified: stat.mtimeMs, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
});
const beforeConfigs = configMetadata();
const port = 9238;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function native(pid, executable, action, value = '') {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/native-window.ps1'), '-TargetPid', String(pid), '-ExpectedExecutable', executable, '-Action', action, '-Value', value], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
}
async function retry(fn, seconds = 20) {
  let last;
  for (let end = Date.now() + seconds * 1000; Date.now() < end;) { try { return await fn(); } catch (error) { last = error; await delay(250); } }
  throw last;
}
async function childPid(executable) {
  return retry(() => {
    const value = execFileSync('powershell.exe', ['-NoProfile', '-Command', `$p=Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}" | Where-Object { $_.ExecutablePath -eq '${executable.replaceAll("'", "''")}' }; if (-not $p) { exit 1 }; $p.ProcessId`], { windowsHide: true, encoding: 'utf8' }).trim();
    if (!/^\d+$/.test(value)) throw Error('No unique hosted app child');
    return Number(value);
  });
}
async function switchTo(page, app) {
  await page.locator('#suite-trigger').click();
  await page.locator(`#suite-menu [data-view="${app}"]`).click();
  await page.locator('#suite-menu').waitFor({ state: 'hidden' });
}
const child = spawn(hub, process.env.CREATOR_HOST_SMOKE_LAUNCH === '1' ? ['--open-app', 'setup'] : [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}`, WEBVIEW2_USER_DATA_FOLDER: path.join(out, 'webview-profile') } });
const extraProcesses = [];
async function launchAgain(args, expected = 0) {
  const process = spawn(hub, args, { windowsHide: true, stdio: 'ignore' });
  extraProcesses.push(process);
  await retry(() => { if (process.exitCode === null) throw Error('Second Hub did not exit after routing'); return process.exitCode; });
  assert.equal(process.exitCode, expected);
}
let browser;
let liveSetupFrame;
let leaveBusyOperation = false;
(async () => {
  browser = await retry(() => chromium.connectOverCDP(`http://127.0.0.1:${port}`));
  const page = await retry(async () => { const p = browser.contexts().flatMap(context => context.pages()).find(p => p.url().includes('tauri.localhost')); if (!p) throw Error('Hub webview is not ready'); return p; });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  report.console = [];
  page.on('console', message => { if (['warning','error'].includes(message.type()) && report.console.length < 30) report.console.push(message.text()); });
  await page.waitForFunction(() => window.CreatorHubNative && !document.querySelector('#catalog-status').textContent.startsWith('Checking'), null, { timeout: 60000 });
  const raw = await page.evaluate(() => window.__TAURI__.core.invoke('app_inventory', { check:false, preview:false }).then(() => 'UNEXPECTED ALLOW', String));
  assert.match(raw, /trusted shell/);
  report.checks.push({ name: 'raw native Hub commands denied without shell authority', result: raw });
  const legitimate = await page.evaluate(() => window.CreatorHubNative.invoke('app_inventory', { check:false, preview:false }));
  assert.equal(legitimate.supported, true);
  report.checks.push({ name: 'trusted native inventory works', result: true });
  if (process.env.CREATOR_HOST_SMOKE_LAUNCH === '1') {
    assert.equal(await page.locator('#tool-title').innerText(), 'Creator Project Setup');
    await launchAgain(['--open-app', 'mcp']);
    await page.waitForFunction(() => document.querySelector('#tool-title').textContent === 'Creator Works MCP');
    await launchAgain(['--open-app', 'setup']);
    await page.waitForFunction(() => document.querySelector('#tool-title').textContent === 'Creator Project Setup');
    await launchAgain(['--open-app', 'mcp', '--install', 'setup'], 2);
    assert.equal(await page.locator('#tool-title').innerText(), 'Creator Project Setup');
    await launchAgain([]);
    await page.locator('#view-hub').waitFor({ state: 'visible' });
    report.checks.push({ name: 'actual second launches route views into existing Hub and exit; invalid arguments rejected', result: true });
  }
  await page.screenshot({ path: path.join(out, 'native-hub.png') });
  if (process.env.CREATOR_HOST_SMOKE_PROJECTS === '1') {
    const unauthorized = await page.evaluate(() => window.__TAURI__.core.invoke('project_inventory').then(() => 'UNEXPECTED ALLOW', String));
    assert.match(unauthorized, /trusted shell/);
    await page.locator('#hub-pages [data-view="projects"]').click();
    await page.waitForFunction(() => document.querySelector('#project-status').textContent.includes('known projects'));
    const sdkRows = await page.locator('.project-row').count();
    assert.ok(sdkRows > 0);
    await page.screenshot({ path: path.join(out, 'native-projects.png') });
    await page.locator('#project-sdk').selectOption('all');
    const allRows = await page.locator('.project-row').count();
    assert.ok(allRows >= sdkRows);
    const unknown = await page.evaluate(() => window.CreatorHubNative.invoke('open_unity_project', { id: 'not-a-listed-project' }).then(() => 'UNEXPECTED ALLOW', String));
    assert.match(unknown, /no longer listed/);
    await page.locator('#project-search').fill('no matching project fixture');
    assert.equal(await page.locator('.project-row').count(), 0);
    await page.locator('#hub-pages [data-view="hub"]').click();
    await page.locator('#hub-pages [data-view="projects"]').click();
    assert.equal(await page.locator('#project-search').inputValue(), 'no matching project fixture');
    assert.deepEqual(configMetadata(), beforeConfigs);
    assert.deepEqual(errors, []);
    report.checks.push({ name: 'native Projects discovery, filters, retained search, shell authority and unknown-ID launch refusal', result: { allRows, sdkRows } });
    report.checks.push({ name: 'MCP configuration metadata unchanged; no valid Unity launch requested', result: true });
  }
  if (process.env.CREATOR_HOST_SMOKE_OPEN === '1') {
    let frame = null;
    let setupBackendPid = null;
    if (process.env.CREATOR_HOST_SMOKE_SKIP_SETUP !== '1') {
    const setupState = legitimate.apps.find(app => app.app === 'setup');
    assert.ok(setupState, 'Setup is missing from native inventory');
    const adjacentSetup = path.join(path.dirname(hub), 'creator-project-setup.exe');
    const route = setupState.installedPath ? 'installed' : fs.existsSync(adjacentSetup) ? 'adjacent' : 'picker';
    const selectedSetup = setupState.installedPath || (route === 'adjacent' ? adjacentSetup : setup);
    assert.equal(path.toNamespacedPath(selectedSetup).toLowerCase(), path.toNamespacedPath(setup).toLowerCase(), 'Native selection differs from expected Setup');
    if (route === 'installed') {
      assert.equal(setupState.trusted, true, 'Installed Setup is not verified');
      assert.equal(setupState.hostedCompatible, true, 'Installed Setup does not match the compiled hosting pin');
    }
    if (process.env.CREATOR_HOST_SMOKE_SETUP_ROUTE) assert.equal(route, process.env.CREATOR_HOST_SMOKE_SETUP_ROUTE);
    report.checks.push({ name: 'native Setup route matches exact expected candidate', result: { route, path: selectedSetup } });
    await page.evaluate(() => {
      const original = window.CreatorHubNative.invoke;
      window.nativeSetupEvidence = {};
      window.CreatorHubNative = { invoke: async (...args) => {
        const result = await original(...args);
        if (args[0] === 'start_hosted_app' && args[1].app === 'setup') window.nativeSetupEvidence.session = result.session;
        if (args[0] === 'hosted_app_call' && args[1].command === 'probe_environment') window.nativeSetupEvidence.environment = result;
        if (args[0] === 'hosted_app_call' && args[1].command === 'create_project') window.nativeSetupEvidence.creation = result;
        return result;
      } };
    });
    await page.getByRole('button', { name: 'View Creator Project Setup', exact:true }).click();
    await page.locator('#host-setup-button').click();
    if (route === 'picker') await retry(() => native(child.pid, hub, 'file', setup));
    if (process.env.CREATOR_HOST_SMOKE_EXPECT_RUNNING_GUARD === '1') {
      await page.waitForFunction(() => document.querySelector('#action-error').textContent.includes('already running'));
      report.checks.push({ name:'running standalone Setup prevents a second hosted backend', result:await page.locator('#action-error').innerText() });
      report.passed = true;
      return;
    }
    const backendPid = await retry(() => {
      const value = execFileSync('powershell.exe', ['-NoProfile','-Command', `$p=Get-CimInstance Win32_Process -Filter "ParentProcessId=${child.pid}" | Where-Object { $_.ExecutablePath -eq '${setup.replaceAll("'", "''")}' }; if (-not $p) { exit 1 }; $p.ProcessId`], { windowsHide:true, encoding:'utf8' }).trim();
      if (!/^\d+$/.test(value)) throw Error('No unique hosted Setup child');
      return Number(value);
    });
    setupBackendPid = backendPid;
    await retry(() => native(backendPid, setup, 'button', 'Open in Hub'));
    // WebView2's srcdoc child can report an empty URL to CDP; use its frame tree identity.
    frame = await retry(async () => {
      const value = page.frames().find(frame => frame.parentFrame() === page.mainFrame());
      if (!value) throw Error('Hosted frame not attached');
      return value;
    });
    liveSetupFrame = frame;
    await frame.locator('#requirements .requirement').first().waitFor({ timeout:60000 });
    report.checks.push({ name:'actual Setup backend returned installed environment', result: await frame.locator('#requirements').innerText() });
    const windows = JSON.parse(native(backendPid, setup, 'snapshot'));
    assert.equal(windows.filter(window => window.title === 'Creator Project Setup').length, 0);
    report.checks.push({ name:'Setup has no standalone top-level window', result:true });
    await frame.locator('#project-name').fill('Hosted native form retained');
    await page.locator('#suite-trigger').click(); await page.locator('#suite-menu [data-view="hub"]').click();
    await page.locator('#suite-trigger').click(); await page.locator('#suite-menu [data-view="setup"]').click();
    assert.equal(await frame.locator('#project-name').inputValue(), 'Hosted native form retained');
    report.checks.push({ name:'native view switching retains form', result:true });
    const isolation = await frame.locator('body').evaluate(async () => {
      let parentDenied = false; try { void parent.document.body; } catch { parentDenied = true; }
      let raw = 'Tauri API absent';
      if (window.__TAURI__?.core) raw = await Promise.race([
        window.__TAURI__.core.invoke('app_inventory', { check:false, preview:false }).then(() => 'UNEXPECTED ALLOW', String),
        new Promise(resolve => setTimeout(() => resolve('No reply after 1s; inspect CSP/authority evidence'), 1000)),
      ]);
      return { parentDenied, raw, shellKey:typeof window.__CREATOR_SHELL_KEY__ };
    });
    assert.equal(isolation.parentDenied, true); assert.notEqual(isolation.raw, 'UNEXPECTED ALLOW'); assert.equal(isolation.shellKey, 'undefined');
    report.checks.push({ name:'native child isolation', result:isolation });
    await frame.locator('#browse-button').click();
    await retry(() => native(backendPid, setup, 'snapshot')).then(text => fs.writeFileSync(path.join(out, 'picker.json'), text));
    native(child.pid, hub, 'close');
    await delay(500);
    assert.equal(child.exitCode, null);
    report.checks.push({ name:'native Hub close refused during real Setup folder picker', result:true });
    await retry(() => native(backendPid, setup, 'button', 'Cancel'));
    await page.waitForFunction(() => !document.querySelector('#hosted-stop').disabled);
    if (requestedProject) {
      const { parent, name: projectName, path: projectPath } = requestedProject;
      assert.equal(fs.existsSync(projectPath), false);
      report.testProject = projectPath;
      report.environmentBefore = await page.evaluate(() => window.nativeSetupEvidence.environment);
      if (process.env.CREATOR_HOST_SMOKE_EXISTING_REQUIREMENTS_ONLY === '1') {
        assert.equal(report.environmentBefore?.ready, true, 'Missing prerequisites: no installation authorized');
        assert.equal(report.environmentBefore?.hubInstalled, true, 'Unity Hub must already be installed');
        assert.equal(await frame.locator('#requirements .bad').count(), 0);
      }
      await page.evaluate(async () => {
        window.nativeProgress = [];
        window.nativeProgressDropped = 0;
        await window.__TAURI__.event.listen('hosted-app-event', ({ payload }) => {
          if (payload.session !== window.nativeSetupEvidence.session || !['setup-progress', 'requirements-progress'].includes(payload.name)) return;
          if (window.nativeProgress.length >= 200) { window.nativeProgressDropped++; return; }
          window.nativeProgress.push({ name: payload.name, ...payload.payload });
        });
      });
      await frame.locator('#project-name').fill(projectName);
      await frame.locator('#parent-folder').fill(parent);
      await frame.locator('#create-button').click();
      console.log(`Creating disposable project through hosted UI: ${projectPath}`);
      await frame.locator('#activity').waitFor({ state:'visible' });
      native(child.pid, hub, 'close');
      await delay(500);
      assert.equal(child.exitCode, null);
      report.checks.push({ name:'native close refused during real Unity creation', result:true });
      await page.locator('#suite-trigger').click(); await page.locator('#suite-menu [data-view="hub"]').click();
      await page.waitForFunction(() => window.nativeProgress.some(event => event.name === 'setup-progress' && event.step >= 3), null, { timeout:180000 });
      await switchTo(page, 'setup');
      report.requirementsDuringImport = await frame.locator('#requirements').innerText();
      assert.equal(await frame.locator('#requirements .bad').count(), 0);
      await page.screenshot({ path: path.join(out, 'native-hosted-setup-import.png') });
      await switchTo(page, 'hub');
      await frame.waitForFunction(setupOperationFinished, null, { timeout:900000, polling:250 });
      await switchTo(page, 'setup');
      report.creationResult = await frame.locator('#result').innerText();
      report.progress = await page.evaluate(() => window.nativeProgress);
      report.progressDropped = await page.evaluate(() => window.nativeProgressDropped);
      report.nativeSetupEvidence = await page.evaluate(() => window.nativeSetupEvidence);
      assert.match(report.creationResult, /Ready/);
      assert.equal(report.nativeSetupEvidence.creation?.success, true);
      assert.equal(path.resolve(report.nativeSetupEvidence.creation.projectPath), projectPath);
      assert.ok(fs.existsSync(path.join(projectPath, 'ProjectSettings', 'ProjectVersion.txt')));
      assert.ok(report.progress.some(event => event.name === 'setup-progress' && event.step >= 3));
      assert.ok(report.progress.some(event => event.name === 'setup-progress' && event.environment?.ready === true), 'Fresh checked requirements must reach the hosted view');
      assert.ok(report.progress.some(event => event.name === 'requirements-progress'), 'Native prerequisite/licence progress must reach Hub');
      report.checks.push({ name:'real Unity creation, validation and hidden-view progress', result:report.creationResult });
    }
    await page.screenshot({ path:path.join(out, 'native-hosted-setup.png') });
    }
    if (mcp) {
      // Capture native outcomes for assertions only; never log configuration contents.
      await page.evaluate(async () => {
        const original = window.CreatorHubNative.invoke;
        window.testHosted = {};
        window.testMcpLifecycle = [];
        await window.__TAURI__.event.listen('hosted-app-event', ({ payload }) => {
          if (payload.name === 'creator-mcp-lifecycle' && window.testMcpLifecycle.length < 1000) window.testMcpLifecycle.push(payload);
        });
        window.CreatorHubNative = { invoke: async (...args) => {
          const result = await original(...args);
          if (args[0] === 'start_hosted_app') window.testHosted[args[1].app] = { session: result.session, hostingRevision: result.hostingRevision, effectiveMode: result.effectiveMode };
          if (args[0] === 'hosted_app_call' && args[1].command === 'get_hosted_snapshot') window.testMcpSnapshot = { resourceDir: result.resourceDir, readOnly: result.readOnly };
          return result;
        } };
      });
      const formBefore = frame ? await frame.locator('#project-name').inputValue() : null;
      await switchTo(page, 'mcp');
      await page.locator('#host-mcp-button').click();
      const mcpPid = await childPid(mcp);
      await retry(() => native(mcpPid, mcp, 'button', 'Open read-only preview'));
      const mcpFrame = await retry(async () => {
        const value = await page.locator('#mcp-host-frame').elementHandle();
        const content = value && await value.contentFrame();
        if (!content) throw Error('MCP frame not ready');
        return content;
      });
      await mcpFrame.locator('#hostedPreviewStatus').filter({ hasText: /configuration/i }).waitFor();
      await page.waitForFunction(() => window.testMcpSnapshot?.readOnly === true);
      if (lifecyclePreview) {
        const mode = await page.evaluate(() => window.testHosted.mcp);
        assert.equal(mode.hostingRevision, 2);
        assert.equal(mode.effectiveMode, 'read-only');
        await page.waitForFunction(() => window.testMcpLifecycle.at(-1)?.payload.state === 'idle');
        for (const command of ['begin_ui_operation', 'save_config']) {
          const rejected = await page.evaluate(command => window.CreatorHubNative.invoke('hosted_app_call', { session: window.testHosted.mcp.session, command, args: {} }).then(() => 'UNEXPECTED ALLOW', String), command);
          assert.match(rejected, /not available/);
        }
        report.checks.push({ name: 'explicit revision 2 remains read-only; workflow and configuration commands rejected', result: true });
      }
      const snapshot = await page.evaluate(() => window.testMcpSnapshot);
      assert.equal(path.toNamespacedPath(snapshot.resourceDir).toLowerCase(), path.toNamespacedPath(path.dirname(mcp)).toLowerCase());
      assert.equal(await mcpFrame.locator('#setupBtn').isDisabled(), true);
      assert.equal(await mcpFrame.locator('#updateBridgesBtn').isDisabled(), true);
      report.checks.push({ name: 'MCP runs read-only with its own native resource directory', result: snapshot });
      const mcpWindows = JSON.parse(native(mcpPid, mcp, 'snapshot'));
      assert.equal(mcpWindows.filter(w => /Creator Works MCP/i.test(w.title)).length, 0);
      report.checks.push({ name: 'MCP has no standalone top-level window', result: true });
      const denied = await page.evaluate(() => window.CreatorHubNative.invoke('hosted_app_call', { session: window.testHosted.mcp.session, command: 'create_project', args: {} }).then(() => 'UNEXPECTED ALLOW', String));
      assert.match(denied, /not available/);
      report.checks.push({ name: 'actual MCP native session cannot call Setup commands', result: denied });
      await mcpFrame.locator('#hostedBrowse').click();
      await retry(() => native(mcpPid, mcp, 'snapshot')).then(text => fs.writeFileSync(path.join(out, 'mcp-picker.json'), text));
      if (lifecyclePreview) await page.waitForFunction(() => {
        const latest = window.testMcpLifecycle.at(-1)?.payload;
        return latest?.state === 'busy' && latest.commandsInFlight === 1;
      });
      native(child.pid, hub, 'close');
      await delay(500);
      assert.equal(child.exitCode, null);
      await retry(() => native(mcpPid, mcp, 'button', 'Cancel'));
      await page.waitForFunction(() => !document.querySelector('#hosted-stop').disabled);
      if (lifecyclePreview) await page.waitForFunction(() => window.testMcpLifecycle.at(-1)?.payload.state === 'idle');
      report.checks.push({ name: 'MCP native picker works and protects busy Hub close', result: true });
      await switchTo(page, frame ? 'setup' : 'hub');
      if (frame) assert.equal(await frame.locator('#project-name').inputValue(), formBefore);
      await switchTo(page, 'mcp');
      await mcpFrame.locator('#hostedRefresh').click();
      await page.waitForFunction(() => !document.querySelector('#hosted-stop').disabled);
      await page.screenshot({ path: path.join(out, 'native-hosted-mcp.png') });
      report.checks.push({ name: frame ? 'both actual app views persist across switches' : 'native MCP view retained when switching to Hub and back', result: true });
      await page.locator('#hosted-stop').click();
      await retry(() => native(child.pid, hub, 'button', 'Close view'));
      await page.locator('#mcp-host-frame').waitFor({ state: 'detached' });
      await switchTo(page, frame ? 'setup' : 'hub');
      if (frame) assert.equal(await frame.locator('#project-name').inputValue(), formBefore);
      const exited = await retry(() => {
        const result = execFileSync('powershell.exe', ['-NoProfile', '-Command', `if (Get-Process -Id ${mcpPid} -ErrorAction SilentlyContinue) { exit 1 }; 'exited'`], { windowsHide: true, encoding: 'utf8' });
        return result.trim();
      });
      assert.equal(exited, 'exited');
      if (lifecyclePreview) {
        await page.waitForFunction(() => window.testMcpLifecycle.at(-1)?.payload.state === 'draining');
        const events = await page.evaluate(() => window.testMcpLifecycle);
        const session = await page.evaluate(() => window.testHosted.mcp.session);
        assert.ok(events.length >= 8);
        assert.equal(events[0].payload.state, 'idle');
        assert.equal(events[0].payload.sequence, 0);
        assert.equal(events.at(-1).payload.state, 'draining');
        for (let index = 0; index < events.length; index++) {
          const event = events[index];
          assert.equal(event.session, session);
          assert.equal(event.payload.workflowActive, false);
          assert.ok(Buffer.byteLength(JSON.stringify(event)) + 1 <= 512);
          assert.ok(Number.isSafeInteger(event.payload.sequence));
          if (index) assert.ok(event.payload.sequence > events[index - 1].payload.sequence);
        }
        report.lifecycle = events.map(event => event.payload);
        report.checks.push({ name: 'native ordered bounded lifecycle events, busy picker and normal EOF draining', result: true });
      } else {
        const legacy = await page.evaluate(() => ({ events: window.testMcpLifecycle, mode: window.testHosted.mcp }));
        assert.deepEqual(legacy.events, []);
        assert.equal(legacy.mode.hostingRevision, undefined);
        assert.equal(legacy.mode.effectiveMode, undefined);
        report.checks.push({ name: 'legacy initializer retains original reply shape and emits no lifecycle events', result: true });
      }
      report.checks.push({ name: frame ? 'closing MCP exits only its hosted backend; Setup draft preserved' : 'closing MCP exits its hosted backend', result: true });
      assert.deepEqual(configMetadata(), beforeConfigs);
      report.checks.push({ name: 'current and legacy MCP configuration metadata and hashes unchanged', result: true });
    }
    if (frame && !mcp) {
      await switchTo(page, 'setup');
      await page.locator('#hosted-stop').click();
      await retry(() => native(child.pid, hub, 'button', 'Close view'));
      await retry(async () => { if (!frame.isDetached()) throw Error('Setup view is still attached'); });
      await retry(() => execFileSync('powershell.exe', ['-NoProfile', '-Command', `if (Get-Process -Id ${setupBackendPid} -ErrorAction SilentlyContinue) { exit 1 }`], { windowsHide: true, encoding: 'utf8' }));
      report.checks.push({ name: 'normal Close Setup detaches the view and exits its exact backend', result: true });
      liveSetupFrame = null;
    }
    assert.deepEqual(errors, []);
    report.checks.push({ name:'native JavaScript errors', result:errors });
  }
  assert.deepEqual(configMetadata(), beforeConfigs);
  report.checks.push({ name: 'current and legacy MCP configuration metadata and hashes unchanged', result: true });
  report.passed = true;
})().catch(async error => {
  report.passed = false;
  report.error = String(error.stack || error);
  process.exitCode = 1;
  if (liveSetupFrame && browser?.isConnected()) {
    try {
      const active = await liveSetupFrame.evaluate(() => {
        const activity = document.querySelector('#activity');
        return Boolean(activity && !activity.classList.contains('hidden'));
      });
      if (active) {
        console.log('The test failed while Setup is busy; waiting for its owned operation without closing Hub.');
        leaveBusyOperation = true;
        await liveSetupFrame.waitForFunction(setupOperationFinished, null, { timeout:900000, polling:250 });
        report.operationAfterTestFailure = await liveSetupFrame.locator('#result').textContent();
        leaveBusyOperation = false;
      }
    } catch (waitError) {
      leaveBusyOperation = true;
      report.pendingOperation = String(waitError.message);
    }
  }
}).finally(async () => {
  for (const extra of extraProcesses) if (extra.exitCode === null) {
    try { native(extra.pid, hub, 'close'); } catch { /* Never force-close a test or user process. */ }
  }
  if (!leaveBusyOperation) {
    try { native(child.pid, hub, 'close'); } catch (error) { report.cleanup = String(error.message); }
  }
  for (let i=0; i<120 && child.exitCode === null && !leaveBusyOperation; i++) {
    await delay(250);
    if (i === 40 || i === 80) { try { native(child.pid, hub, 'close'); } catch { /* The exact test process may already have exited. */ } }
  }
  if (child.exitCode === null) { report.cleanup = 'Test Hub remains open, possibly busy. Nothing was force-closed.'; process.exitCode = 1; child.unref(); }
  if (browser && child.exitCode !== null) await browser.close();
  for (const extra of extraProcesses) if (extra.exitCode === null) { report.extraCleanup = 'A secondary test process remains open.'; process.exitCode = 1; extra.unref(); }
  if (report.cleanup || report.extraCleanup) report.passed = false;
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({out, ...report}, null, 2));
});
