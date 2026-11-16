'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const target = require('./windows-outgoing-019-target.cjs');
const direct = require('./native-outgoing-direct-019.cjs');
const ROOT = path.resolve(__dirname, '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function retry(read, seconds = 30) {
  let last;
  for (const end = Date.now() + seconds * 1000; Date.now() < end; await delay(250)) {
    try { return await read(); } catch (error) { last = error; }
  }
  throw last || Error('Timed out');
}
function assertProtocol(state, version) {
  assert.ok(['0.1.23', '0.1.24'].includes(version));
  assert.equal(state.version, version); assert.equal(state.protocol, 1); assert.equal(state.integrated, true);
  assert.deepEqual(state.services, { integrated: true, features: ['setup', 'mcp'] });
}
function assertTicket(ticket, lastTool, hub) {
  assert.equal(ticket.schemaVersion, 1); assert.equal(ticket.fromVersion, '0.1.23'); assert.equal(ticket.toVersion, '0.1.24');
  assert.equal(ticket.views.length, 1); const view = ticket.views[0];
  assert.equal(view.app, lastTool); assert.equal(view.direct, true); assert.equal(view.bundled, true);
  assert.equal(path.win32.normalize(view.path).toLowerCase(), path.win32.normalize(hub).toLowerCase());
}
async function observeAutomaticSuccessor({ hub, previousPid, expectedSha256, inventory, hashFile,
  peVersion, onObserved, verifyResources, wait = retry }) {
  const ready = await wait(() => {
    const rows = inventory().filter(item => item.image.toLowerCase() === hub.toLowerCase() && item.pid !== previousPid);
    assert.equal(rows.length, 1, 'Exactly one automatic replacement Root required');
    const record = rows[0];
    assert.equal(record.kernelIdentityVerified, true, 'Replacement Root identity unavailable');
    assert.equal(hashFile(hub), expectedSha256, 'Replacement Root image differs');
    const version = peVersion(24);
    assert.deepEqual(version, [0, 1, 24, 0], 'Replacement Root PE version differs');
    assert.deepEqual(inventory().filter(item => item.pid === record.pid), [record], 'Replacement Root identity changed');
    return { record, version };
  }, 90);
  onObserved(ready.record, ready.version);
  verifyResources();
  return ready;
}
async function completeStartup(page, version, report) {
  assert.ok(['0.1.23','0.1.24'].includes(version));
  const terms=page.locator('#usage-terms-dialog'),guide=page.locator('#convergence-dialog');
  if (version==='0.1.23') {
    await terms.waitFor({state:'visible'}); await page.locator('#usage-terms-checkbox').check();
    await page.locator('#usage-terms-continue').click(); await terms.waitFor({state:'hidden'});
  } else assert.equal(await terms.isVisible(),false,'Terms must survive update');
  await page.waitForFunction(()=>document.querySelector('#convergence-dialog')?.open||!document.querySelector('#check-updates').disabled,null,{timeout:120000});
  if(await guide.isVisible()) { await page.locator('#convergence-later').click(); await guide.waitFor({state:'hidden'}); report.migrationDeferred=true; }
}
async function setUpdatePreferences(page, restore) {
  await direct.showHome(page);
  await page.locator('#update-settings > summary').click();
  for (const [id, value] of [['auto-download', false], ['preview-channel', false], ['restore-hosted-views', restore]]) {
    await page.locator(`#${id}`).setChecked(value);
  }
  await page.locator('#update-settings > summary').click();
}
function assertSavedPreferences(saved, restore) {
  assert.deepEqual(saved, { schemaVersion: 1, preview: false, autoDownload: false, restoreHostedViews: restore });
}
function assertFreshOldConnection(held, freshOld, freshNew, profile) {
  target.assertFreshConnection(held, freshNew, profile);
  target.assertFreshConnection(freshOld, freshNew, profile);
  assert.equal(new Set([...held, ...freshOld, ...freshNew].map(row => row.pid)).size, 6,
    'Fresh old-client connection must not reuse either observed connection');
}
async function continueMcpGuide(page) {
  const guide = page.locator('#feature-mcp [data-field="guide-dialog"]');
  if (await guide.isVisible()) {
    await page.locator('#feature-mcp [data-field="guide-start"]').click();
    await guide.waitFor({ state: 'hidden' });
  }
}
async function checkSdkLookup(page,report,phase) {
  const snapshot=()=>page.evaluate(()=>{
    const root=document.querySelector('#feature-mcp'),field=name=>root?.querySelector('[data-field="'+name+'"]');
    return {text:field('sdk-latest')?.textContent,status:field('status')?.textContent,
      controlsDisabled:field('controls')?.disabled,buttonDisabled:field('sdk-check')?.disabled,
      busy:root?.getAttribute('aria-busy'),errorVisible:field('error')?.hidden===false};
  });
  const evidence={phase,before:await snapshot(),manualRetry:false};
  (report.sdkLookups ||= []).push(evidence);
  try {
    if(evidence.before.text==='Latest Creator SDK not checked.') {
      await page.locator('#feature-mcp [data-field="sdk-check"]').click();evidence.manualRetry=true;
    }
    await page.waitForFunction(()=>{
      const root=document.querySelector('#feature-mcp'),text=root?.querySelector('[data-field="sdk-latest"]')?.textContent;
      return text!=='Latest Creator SDK not checked.'&&text!=='Checking latest Creator SDK...'
        &&root?.querySelector('[data-field="sdk-check"]')?.disabled===false;
    },null,{timeout:25000});
    const state=await snapshot();
    assert.equal(state.status,'Ready');assert.equal(state.controlsDisabled,false);
    assert.equal(state.busy,'false');assert.equal(state.errorVisible,false);assert.equal(state.buttonDisabled,false);
    if(state.text==='Latest SDK could not be checked. Installed versions are still shown below.')evidence.mode='offline';
    else {
      assert.match(state.text,/^Latest Creator SDK: (0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);
      evidence.mode='live';evidence.version=state.text.slice('Latest Creator SDK: '.length);
    }
  } finally { evidence.after=await snapshot(); }
}
async function checkSdkMetadata(page,out,report,target,direct,show) {
  const checked=[];
  for(const [version,mismatch] of [['4.0.25',true],['4.0.27',false]]) {
    const folder=path.join(out,'sdk-metadata-'+version);
    fs.mkdirSync(path.join(folder,'Packages'),{recursive:true});
    const manifest=JSON.stringify({dependencies:{'com.sidequest.creator-sdk':version}});
    const lock=JSON.stringify({dependencies:{'com.sidequest.creator-sdk':{version,dependencies:mismatch?{'com.unity.render-pipelines.universal':'17.4.0'}:{}},'com.unity.render-pipelines.universal':{version:'17.3.0',dependencies:{}}}});
    fs.writeFileSync(path.join(folder,'Packages/manifest.json'),manifest,{flag:'wx'});
    fs.writeFileSync(path.join(folder,'Packages/packages-lock.json'),lock,{flag:'wx'});
    const value=await page.evaluate(async folder=>{
      const call=(command,args={})=>window.CreatorHubNative.invoke('feature_call',{feature:'mcp',command,args});
      const id=await call('begin_ui_operation');try{return await call('get_project_sdk_profile',{unityProjectPath:folder});}finally{await call('finish_ui_operation',{id});}
    },folder);
    assert.equal(value.label,'Creator SDK '+version);assert.equal(value.creatorSdkTested,version==='4.0.25');
    assert.equal(Boolean(value.error),mismatch);assert.equal(value.recommendedToolGroups,mismatch?null:'core,creator');
    assert.equal(fs.readFileSync(path.join(folder,'Packages/manifest.json'),'utf8'),manifest);
    assert.equal(fs.readFileSync(path.join(folder,'Packages/packages-lock.json'),'utf8'),lock);
    checked.push({version,mismatch,profile:value.profile,tested:value.creatorSdkTested,filesUnchanged:true});
  }
  report.sdkMetadata={checked};
  await show('mcp');await continueMcpGuide(page);
  await checkSdkLookup(page,report,'after-automatic-update');
  report.sdkMetadata.lookupNonBlocking=true;await direct.showHome(page);
}
async function main() {
  target.assertAdmission(); // Must precede config/profile reads, installers, policy and native probes.
  const config = target.readConfig(process.env.CREATOR_SELF_UPDATE_LAB_CONFIG);
  target.assertBound(config);
  target.loadContract(config);
  assert.equal(process.env.CREATOR_SELF_UPDATE_TARGET_VERSION, config.targetVersion);
  assert.equal(process.env.CREATOR_SELF_UPDATE_INSTALLER_SHA256, config.pins.installer);
  assert.equal(process.env.CREATOR_SELF_UPDATE_EXECUTABLE_SHA256, config.pins.executable);
  const installer = process.env.CREATOR_SELF_UPDATE_LAB_BASELINE;
  assert.ok(path.isAbsolute(installer || ''));
  const hashFile = file => target.hash(target.readBounded(file, target.LIMITS.installer));
  assert.equal(hashFile(installer), config.baseline.installer);
  const migrationRequested = Object.keys(process.env).some(key => /^CREATOR_MIGRATED_/i.test(key));
  assert.equal(migrationRequested, false, 'This finite outgoing lane does not create or adopt migrated fixture profiles');
  let migrated;
  if (migrationRequested) {
    const handoff = require('./windows-migrated-outgoing-handoff.cjs');
    const inputs = handoff.migrationInputs(process.env);
    handoff.checkOutgoingBaseline(config);
    assert.equal(process.env.CREATOR_OUTGOING_RESTORE, 'true', 'Migrated preferences must not be reseeded');
    migrated = await handoff.runWithMigrationEnvironment(inputs);
    assert.equal(migrated.updateAuthority, false); assert.equal(migrated.successorQualified, false);
    migrated.guard.verify();
  }
  const { chromium } = require('@playwright/test');
  const { assertOwnedDebugging } = require('./windows-incoming-016.cjs');
  const local = process.env.LOCALAPPDATA, roaming = process.env.APPDATA, home = process.env.USERPROFILE;
  for (const folder of [local, roaming, home]) assert.ok(path.win32.isAbsolute(folder || ''));
  const profile = { local, roaming, home };
  const oldRoute = target.managedLocations(local, '0.1.23', home);
  const newRoute = target.managedLocations(local, '0.1.24', home);
  const hub = path.join(local, 'Creator Hub/creator-hub.exe');
  const ticket = path.join(local, 'CreatorHub/hub-updates/hosted-restore.json');
  const clientConfig = path.join(home, '.codex/config.toml');
  const selectedPath = path.join(home, '.claude.json');
  const oldClientPath = path.join(home, '.gemini/config/mcp_config.json');
  const settingsPath = path.join(roaming, 'creator-works-mcp/launcher-config.json');
  const oldSettingsPath = path.join(roaming, 'banter-mcp/launcher-config.json');
  if (!migrated) for (const file of [path.dirname(hub), path.join(local, 'CreatorHub'), path.join(roaming, 'creator-works-mcp'),
    path.join(roaming, 'banter-mcp'), path.join(local, 'CreatorProjectSetup'), clientConfig, selectedPath, oldClientPath,
    oldRoute.base, newRoute.base, path.join(home, '.creator-hub-settings-backups')]) {
    assert.equal(fs.existsSync(file), false, 'Existing runner product/profile refused');
  }
  const out = path.join(ROOT, 'artifacts', `native-suite-${Date.now()}`); fs.mkdirSync(out);
  const lastTool = process.env.CREATOR_OUTGOING_LAST_TOOL || 'setup';
  const restore = (process.env.CREATOR_OUTGOING_RESTORE || 'true') === 'true';
  const report = { passed: false, kind: target.KIND, sourceCommit: config.sourceCommit, baseline: config.baseline,
    pins: config.pins, lastTool, restore, profile, labDiscovery: true, publicDiscovery: false, acceptanceOnly: true,
    nativeUpdateAccepted: false, liveAiAcceptance: false, releaseReady: false };
  if (migrated) Object.assign(report, { migratedContinuation: true, migrationRunId: migrated.runId,
    migrationRunAttempt: migrated.runAttempt, migratedFixtureFilesChecked: migrated.guard.fileCount,
    migrationReceipt: path.relative(ROOT, path.join(migrated.migrationOutput, 'migration-016-report.json')),
    migrationReportSha256: migrated.migrationReportSha256, migrationHarnessSource: process.env.GITHUB_SHA,
    migratedFixtureFilesUnchangedAfterDriverCleanup: false, activeRouteUnchangedAfterCancel: false,
    targetMcpRuntimeVerified: false });
  const ps = (name, args = []) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ROOT, 'scripts', name), ...args], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  const inventory = () => JSON.parse(ps('native-outgoing-process-019.ps1').replace(/^\uFEFF/, ''));
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
  let selectedBefore, selectedAfter, oldClientBefore, settingsReview;
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
  const capture = (name, file) => {
    const bytes = direct.readEvidence(file), saved = path.join(out, name);
    fs.writeFileSync(saved, bytes, { flag: 'wx' });
    protectedFiles.push({ file: saved, sha256: target.hash(bytes) });
    return { file, capture: saved, bytes: bytes.length, sha256: target.hash(bytes) };
  };
  const verifyClients = () => direct.assertClientBytes({ selectedPath, oldClientPath,
    selectedBefore: selectedAfter || selectedBefore, oldClientBefore });
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
    if (selectedBefore) verifyClients();
    await completeStartup(page, version, report);
    if (selectedBefore) verifyClients();
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
    const route = version === '0.1.23' ? oldRoute : newRoute;
    const value = JSON.parse(target.readBounded(route.active, 4096));
    const expected = config.runtime[version === '0.1.23' ? 'baselineDescriptor' : 'targetDescriptor'];
    assert.equal(value.descriptorSha256, expected); assert.match(value.generation, /^[a-f0-9]{64}$/);
    const body = target.readBounded(path.join(path.dirname(route.active), 'descriptors', expected, 'runtime.json'), target.LIMITS.metadata);
    assert.equal(target.hash(body), expected); assert.equal(JSON.parse(body).hubVersion, version);
    target.assertActiveResources(local, version, value, true, home);
    return value;
  }
  function connectionProcesses(transport, route, version) {
    const rows = inventory(), router = rows.find(p => p.pid === transport.pid);
    assert.ok(router); assert.equal(router.image.toLowerCase(), route.command.toLowerCase());
    const nodes = rows.filter(p => p.parentPid === router.pid && /node\.exe$/i.test(p.image));
    assert.equal(nodes.length, 1);
    for (const row of [router, nodes[0]]) {
      assert.equal(row.kernelIdentityVerified, true);
      assert.match(row.startTicks, /^[0-9]+$/); assert.ok(BigInt(row.startTicks) > 0n);
      sameProcess(row);
    }
    target.assertGenerationProcess(nodes[0].image, local, version, home);
    return [router, nodes[0]];
  }
  async function preserved() {
    if (migrated) migrated.guard.verify();
    for (const { file, sha256 } of protectedFiles) assert.equal(hashFile(file), sha256);
    assert.deepEqual(direct.settingsSnapshot(roaming, local), settingsBefore);
    assert.deepEqual(await preferences(), preferencesBefore);
    if (!migrated) assert.equal(fs.existsSync(clientConfig), false);
    verifyClients();
    assert.deepEqual(active(report.afterRoute ? '0.1.24' : '0.1.23'), report.afterRoute || report.beforeRoute, 'Only the approved descriptor may be active');
    assert.equal(sdkClient.getServerVersion().version, target.binding.baseline.manifest.modules.mcp.version);
    sameProcess(sentinelRecord); for (const p of sdkRecords) sameProcess(p);
    await roundTrip(sdkClient); assert.deepEqual(moduleGuis(), []);
  }
  try {
    assert.deepEqual(inventory().filter(p => /creator-hub\.exe$/i.test(p.image)), []);
    if (!migrated) execFileSync(installer, ['/S', '/NS'], { windowsHide: true, timeout: 180000, stdio: 'pipe' });
    assert.equal(hashFile(hub), config.baseline.exe); report.beforePeVersion = peVersion(23);
    target.assertInstalledResources(path.dirname(hub), '0.1.23');
    if (!migrated) {
      const settings = require('./sdk-retention-023.cjs').settings(lastTool, restore);
      protect(settingsPath, settings);
      protect(oldSettingsPath, settings.replaceAll('\n', '\r\n'));
      protect(path.join(local, 'CreatorProjectSetup/editor-roots.json'), '[]\n');
      protect(path.join(path.dirname(hub), 'outgoing-preservation.txt'), 'Keep unmanaged installation content.\n');
      protect(path.join(out, 'synthetic-project/Assets/untouched.txt'), 'Synthetic project content; never opened or repaired.\n');
    } else migrated.guard.verify();
    policyEnabled = true; policy('Enable');
    child = spawn(hub, [], { windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9238' } });
    rootRecord = await retry(() => record(child.pid)); report.beforeRoot = rootRecord;
    await connect('0.1.23');
    await direct.checkPages({ page, showApp: show, processes: moduleGuis, requests, expectedVersion: target.binding.baseline.version,
      screenshot: name => page.screenshot({ path: path.join(out, `baseline-${name}.png`) }) });
    if (!migrated) await direct.prepareManagedRoute(page, { clientConfig, active: oldRoute.active,
      approve: () => retry(() => button('Enable managed routing')) });
    report.beforeRoute = active('0.1.23');
    const entry = { command: oldRoute.command, args: [],
      env: { CREATOR_WORKS_CONFIG_OWNER: 'creator-hub-v1', CREATOR_WORKS_LAUNCHER_CONFIG: settingsPath }, disabled: false };
    const selected = { mcpServers: { 'creator-works': entry, other: { command: 'keep' } },
      preferences: { outgoingSentinel: 'keep' } };
    assert.equal(fs.existsSync(selectedPath), false);
    fs.writeFileSync(selectedPath, JSON.stringify(selected, null, 2) + '\n', { flag: 'wx' });
    const oldEntry = { ...entry, env: { ...entry.env, CREATOR_WORKS_LAUNCHER_CONFIG: oldSettingsPath } };
    protect(oldClientPath, JSON.stringify({ mcpServers: { 'creator-works': oldEntry }, outgoingSentinel: 'keep-old' }, null, 2) + '\r\n');
    selectedBefore = direct.readEvidence(selectedPath); oldClientBefore = direct.readEvidence(oldClientPath);
    report.clients = { selectedBefore: capture('claude-before.json', selectedPath),
      oldBefore: capture('old-client-before.json', oldClientPath),
      currentSettingsBefore: capture('settings-before.json', settingsPath),
      oldSettingsBefore: capture('old-settings-before.json', oldSettingsPath) };
    const sdk = require('node:module').createRequire(path.join(ROOT, 'product/modules/mcp/package.json'));
    const { Client } = sdk('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = sdk('@modelcontextprotocol/sdk/client/stdio.js');
    sdkClient = new Client({ name: 'outgoing-direct-existing-connection', version: '1' });
    sdkTransport = new StdioClientTransport({ command: oldEntry.command, args: oldEntry.args,
      env: { ...process.env, ...oldEntry.env }, stderr: 'ignore' });
    await sdkClient.connect(sdkTransport); await roundTrip(sdkClient);
    sdkRecords = await retry(() => {
      const rows = connectionProcesses(sdkTransport, oldRoute, '0.1.23');
      assert.equal(sdkClient.getServerVersion().version, target.binding.baseline.manifest.modules.mcp.version); return rows;
    });
    report.heldProcessesBefore = sdkRecords;
    sentinel = spawn(process.execPath, [path.join(ROOT, 'scripts/owned-hub-fixture.cjs'), stopFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let ready = ''; sentinel.stdout.on('data', bytes => { ready += bytes; });
    await retry(() => { assert.match(ready, /ready/); assert.equal(sentinel.exitCode, null); }); sentinelRecord = record(sentinel.pid);
    if (!migrated) await setUpdatePreferences(page, restore);
    await retry(() => page.locator('#suite-trigger').isEnabled().then(value => assert.equal(value, true)));
    await show(lastTool); await direct.showHome(page);
    settingsBefore = direct.settingsSnapshot(roaming, local); preferencesBefore = await preferences();
    const prefPath = path.join(local, 'CreatorHub/preferences/hub-preferences.json');
    await retry(() => assertSavedPreferences(JSON.parse(fs.readFileSync(prefPath)), restore));
    protectedFiles.push({ file: prefPath, sha256: hashFile(prefPath) });
    const draft = await page.locator('#feature-setup [data-field="name"]').inputValue();
    await show('mcp'); await continueMcpGuide(page); await direct.showHome(page);
    if (!migrated) await page.evaluate(() => localStorage.setItem('outgoing-preserved', 'direct23-to24'));
    await retry(async () => assert.equal(await page.locator('#hub-update-button').isEnabled(), true), 90);
    const status = await page.evaluate(() => window.CreatorHubNative.invoke('hub_update_status', { online: false, preview: false }));
    assert.equal(status.currentVersion, '0.1.23'); assert.equal(status.availableVersion, '0.1.24'); assert.equal(status.installBlocked, null);
    // The native prompt precedes download/cache reuse. Cancel must preserve both states.
    if (migrated) migrated.guard.verify();
    await page.locator('#hub-update-button').click(); await retry(() => button('Not now'));
    await retry(async () => assert.equal(await page.locator('#hub-update-button').isEnabled(), true));
    sameProcess(rootRecord); assert.equal(hashFile(hub), config.baseline.exe); await preserved();
    assert.deepEqual(active('0.1.23'), report.beforeRoute); report.activeRouteUnchangedAfterCancel = true;
    report.clients.afterUpdateCancel = { selected: capture('claude-update-cancel.json', selectedPath),
      old: capture('old-client-update-cancel.json', oldClientPath) };
    assert.equal(await page.locator('#feature-setup [data-field="name"]').inputValue(), draft);
    assert.equal(fs.existsSync(ticket), false); report.cancelPreserved = true;
    watch = setInterval(() => { try { observedTicket = JSON.parse(target.readBounded(ticket, 32768)); } catch {} }, 20);
    if (migrated) migrated.guard.verify();
    await page.locator('#hub-update-button').click(); await retry(() => button('Update Hub'));
    await retry(() => assert.equal(child.exitCode, 0), 180);
    await browser.close().catch(() => {}); browser = null; page = null;
    // NSIS copies the main EXE before resources; observe its automatic replacement first.
    await observeAutomaticSuccessor({ hub, previousPid: child.pid, expectedSha256: config.pins.executable,
      inventory, hashFile, peVersion,
      onObserved: (record, version) => { rootRecord = record; report.afterRoot = record; report.afterPeVersion = version; },
      verifyResources: () => {
        report.resourceProbe = { phase: 'after-automatic-root', attempts: 1, passed: false };
        target.assertInstalledResources(path.dirname(hub), '0.1.24');
        report.resourceProbe.passed = true;
      } });
    await connect('0.1.24');
    clearInterval(watch); watch = null;
    if (restore) {
      assertTicket(observedTicket, lastTool, hub); await direct.checkRestored(page);
      await page.waitForFunction(feature => document.querySelector(`#feature-${feature} [data-field="status"]`)?.textContent === 'Ready', lastTool);
      assert.equal(await page.locator(`#feature-${lastTool}`).isVisible(), true);
      if (lastTool === 'mcp') await continueMcpGuide(page);
    } else { assert.equal(observedTicket, undefined); await direct.checkHome(page); }
    assert.equal(fs.existsSync(ticket), false);
    await direct.prepareManagedRoute(page, { clientConfig, active: newRoute.active,
      approve: () => { throw Error('Existing physical route must not request new permission'); } });
    report.afterRoute = active('0.1.24');
    assert.equal(report.afterRoute.generation, report.beforeRoute.generation);
    assert.equal(oldRoute.command, newRoute.command);
    if (!migrated) assert.equal(await page.evaluate(() => localStorage.getItem('outgoing-preserved')), 'direct23-to24');
    await preserved();
    await page.screenshot({ path: path.join(out, 'automatic-restart.png') });
    report.restoredLastTool = restore ? lastTool : null;
    for (const feature of ['setup', 'mcp']) {
      await show(feature);
      await page.waitForFunction(name => document.querySelector(`#feature-${name} [data-field="status"]`)?.textContent === 'Ready', feature);
      if (feature === 'mcp') await continueMcpGuide(page);
      const service = await page.evaluate(name => window.CreatorHubNative.invoke('feature_call', {
        feature: name, command: name === 'mcp' ? 'get_onboarding_status' : 'probe_environment',
        args: name === 'mcp' ? { unityProjectPath: null } : {},
      }), feature);
      direct.assertService(feature, service);
    }
    report.clientConnectionsUnchanged = true;
    selectedAfter = direct.readEvidence(selectedPath);
    assert.ok(selectedAfter.equals(selectedBefore),'An ordinary same-route update must not rewrite client settings');
    report.clients.selectedAfter = capture('claude-after.json', selectedPath);
    report.clients.oldAfter = capture('old-client-after.json', oldClientPath);
    report.clients.currentSettingsAfter = capture('settings-after.json', settingsPath);
    report.clients.oldSettingsAfter = capture('old-settings-after.json', oldSettingsPath);
    assert.equal(sdkClient.getServerVersion().version, target.binding.baseline.manifest.modules.mcp.version);
    const reconnect = new Client({ name: 'outgoing-direct-new-connection', version: '1' });
    try {
      const migratedEntry = JSON.parse(selectedAfter).mcpServers['creator-works'];
      assert.equal(migratedEntry.command, newRoute.command);
      const transport = new StdioClientTransport({ command: newRoute.command, args: migratedEntry.args,
        env: { ...process.env, ...migratedEntry.env }, stderr: 'ignore' });
      await reconnect.connect(transport); await roundTrip(reconnect);
      const rows = await retry(() => connectionProcesses(transport, newRoute, '0.1.24'));
      target.assertFreshConnection(sdkRecords, rows, profile);
      assert.equal(reconnect.getServerVersion().version, target.binding.target.manifest.modules.mcp.version);
      report.reconnectedProcesses = rows;
      report.reconnectedServerVersion = reconnect.getServerVersion();
      const oldReconnect = new Client({ name: 'outgoing-direct-fresh-old-client', version: '1' });
      try {
        const retainedEntry = JSON.parse(direct.readEvidence(oldClientPath)).mcpServers['creator-works'];
        assert.equal(retainedEntry.command, oldRoute.command);
        const oldTransport = new StdioClientTransport({ command: oldRoute.command, args: retainedEntry.args,
          env: { ...process.env, ...retainedEntry.env }, stderr: 'ignore' });
        await oldReconnect.connect(oldTransport); await roundTrip(oldReconnect);
        const oldRows = await retry(() => connectionProcesses(oldTransport, oldRoute, '0.1.23'));
        assertFreshOldConnection(sdkRecords, oldRows, rows, profile);
        assert.equal(oldReconnect.getServerVersion().version, target.binding.baseline.manifest.modules.mcp.version);
        report.freshOldProcesses = oldRows; report.freshOldServerVersion = oldReconnect.getServerVersion();
        await preserved();
      } finally { await oldReconnect.close(); }
    }
    finally { await reconnect.close(); }
    await preserved(); await direct.checkCleanDocument(page, requests);
    await checkSdkMetadata(page, out, report, target, direct, show);
    // The automatic replacement was already observed. This is a separate normal restart check.
    report.beforeNormalRestart = rootRecord;
    native('close');
    await retry(() => assert.equal(inventory().some(p => p.pid === rootRecord.pid && p.startTicks === rootRecord.startTicks), false));
    await browser.close(); browser = null; page = null;
    child = spawn(hub, [], { windowsHide: true, stdio: 'ignore',
      env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9238' } });
    rootRecord = await retry(() => record(child.pid));
    assert.equal(rootRecord.kernelIdentityVerified, true); assert.notEqual(rootRecord.pid, report.beforeNormalRestart.pid);
    report.normalRestartRoot = rootRecord;
    assert.equal(hashFile(hub), config.pins.executable); peVersion(24);
    target.assertInstalledResources(path.dirname(hub), '0.1.24');
    await connect('0.1.24');
    assert.equal(fs.existsSync(ticket), false);
    await direct.checkHome(page);
    await direct.checkPages({ page, showApp: show, processes: moduleGuis, requests, expectedVersion: '0.1.24',
      screenshot: name => page.screenshot({ path: path.join(out, `normal-restart-${name}.png`) }) });
    await preserved(); assert.deepEqual(active('0.1.24'), report.afterRoute);
    assert.equal(await page.evaluate(() => localStorage.getItem('outgoing-preserved')), 'direct23-to24');
    verifyClients();
    await show('mcp'); await continueMcpGuide(page);
    await checkSdkLookup(page,report,'after-normal-restart');
    report.sdkMetadata.afterNormalRestartLookupNonBlocking=true; await direct.showHome(page);
    report.normalRestartPreserved = true;
    report.manualCapabilityRetention = require('./sdk-retention-023.cjs').verify(
      lastTool, restore, fs.readFileSync(path.join(roaming, 'creator-works-mcp/launcher-config.json')),
      fs.readFileSync(path.join(roaming, 'banter-mcp/launcher-config.json')));
    report.heldProcessesAfter = sdkRecords.map(saved => record(saved.pid));
    report.heldServerVersion = sdkClient.getServerVersion();
    const registry = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Creator Hub', '/v', 'DisplayVersion'], { encoding: 'utf8', windowsHide: true });
    assert.equal(registry.match(/DisplayVersion\s+REG_SZ\s+(\S+)/)?.[1], '0.1.24');
    assert.deepEqual(report.pageErrors || [], []);
    Object.assign(report, { passed: true, nativeUpdateAccepted: true, automaticRestart: true,
      existingConnectionSurvived: true, newConnectionVerified: true, restorationVerified: true, observedTicket,
      targetMcpRuntimeVerified: true, installedResourcesVerifiedBeforeAndAfter: true, heldGenerationRetained: true });
    if (migrated) report.fixtureSettingsChecksPassed = true;
    else report.settingsPreserved = true;
  } catch (error) {
    if (error.resourceDiagnostic) report.resourceFailure = error.resourceDiagnostic;
    report.error = String(error.stack || error).slice(0, 16000); process.exitCode = 1;
    try { if (page) await page.screenshot({ path: path.join(out, 'failure.png') }); } catch {}
  } finally {
    if (watch) clearInterval(watch);
    try { if (sdkClient) await sdkClient.close(); } catch { report.passed = false; report.sdkCleanupFailed = true; }
    try {
      await retry(() => { for (const saved of [...sdkRecords, ...(report.reconnectedProcesses || []), ...(report.freshOldProcesses || [])])
        assert.equal(inventory().some(p => p.pid === saved.pid && p.startTicks === saved.startTicks), false); });
    } catch { report.passed = false; report.sdkCleanupFailed = true; }
    try { if (rootRecord) { native('close'); await retry(() => assert.equal(inventory().some(p => p.pid === rootRecord.pid && p.startTicks === rootRecord.startTicks), false)); } }
    catch { report.passed = false; report.rootCleanupFailed = true; }
    if (browser) await browser.close().catch(() => {});
    if (policyEnabled) { try { policy('Restore'); report.policyRestored = true; } catch { report.passed = false; report.policyRestored = false; } }
    if (sentinel?.exitCode === null) {
      fs.writeFileSync(stopFile, 'exit', { flag: 'wx' });
      try { await retry(() => assert.equal(sentinel.exitCode, 0)); } catch { report.passed = false; report.sentinelCleanupFailed = true; }
    }
    if (migrated) { try { migrated.guard.verify(); report.migratedFixtureFilesUnchangedAfterDriverCleanup = true; }
      catch (error) { report.passed = false; report.preservationError = String(error); } }
    try {
      if (selectedBefore) verifyClients();
      for (const { file, sha256 } of protectedFiles) assert.equal(hashFile(file), sha256);
      if (report.beforeRoute) assert.deepEqual(active(report.afterRoute ? '0.1.24' : '0.1.23'), report.afterRoute || report.beforeRoute);
      report.fixtureEvidencePreservedAfterCleanup = true;
    } catch (error) { report.passed = false; report.preservationError = String(error); }
    if (!report.passed) process.exitCode = 1;
    fs.writeFileSync(path.join(out, 'outgoing-report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ out, passed: report.passed, releaseReady: false }));
  }
}
module.exports = { assertProtocol, assertTicket, observeAutomaticSuccessor, completeStartup, setUpdatePreferences,
  assertSavedPreferences, assertFreshOldConnection, continueMcpGuide, checkSdkLookup, main };
if (require.main === module) main().catch(error => { console.error(String(error.message).slice(0, 1200)); process.exitCode = 1; });
