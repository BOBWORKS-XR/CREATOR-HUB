'use strict';
// A second, synthetic settings case inside the admitted fresh hosted-runner job.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const KEY = 'creator-hub.mcp-product-review.v1';
const normalize = value => value.replaceAll('\\', '/');
function exceptServer(value) { const result = structuredClone(value); delete result.mcp_server_path; return result; }
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const bytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
function backupName(file, body) {
  return path.join(path.dirname(file), '.creator-hub-settings-backups', `${path.basename(file)}.${hash(body)}.bak`);
}
function documents(config, server) {
  const current = { ...config, mcp_server_path: server, tool_groups: 'read',
    futurePreference: { keep: ['current', false, 13] } };
  const legacy = { ...current, tool_groups: 'core', futurePreference: { keep: ['legacy', true, 12] } };
  return { current: bytes(current), legacy: bytes(legacy), expected: current };
}
function fingerprint(report) {
  assert.equal(report.status, 'conflict');
  assert.ok(Array.isArray(report.recovery) && report.recovery.every(row => row.historical_completed === true));
  assert.equal(new Set(report.backups).size, 2);
  const files = [report.currentPath, report.legacyPath].map(file => {
    assert.ok(path.isAbsolute(file));
    const prefix = path.join(path.dirname(file), '.creator-hub-settings-backups', path.basename(file) + '.');
    const found = report.backups.filter(name => name.startsWith(prefix) && /^[a-f0-9]{64}\.bak$/.test(name.slice(prefix.length)));
    assert.equal(found.length, 1); return [file, found[0]];
  });
  return JSON.stringify({ status: report.status, currentPath: report.currentPath, legacyPath: report.legacyPath, files });
}
function validateProof(proof) {
  for (const key of ['cancelPreserved', 'approvalObserved', 'backupsVerified', 'controlsEnabledBeforeClose',
    'controlsEnabledAfterReopen', 'settingsUnchanged', 'markerUnchanged', 'noRepeatedApproval', 'runtimeRepairApproved', 'runtimeRepairCancelled',
    'onlyServerChanged', 'oldServerAbsent', 'renewedReview', 'managedRouteUnchanged', 'initialRouteUnbound', 'repairVisibleBeforeBinding']) assert.equal(proof[key], true, key);
  assert.deepEqual(proof.decisions, [false, true, true]);
  assert.equal(proof.statusBefore, 'conflict'); assert.equal(proof.statusAfter, 'conflict');
  assert.notEqual(proof.currentBefore, proof.currentAfter); assert.equal(proof.legacyBefore, proof.legacyAfter);
  assert.notEqual(proof.currentBefore, proof.legacyBefore);
  for (const value of [proof.currentBefore, proof.legacyBefore, proof.markerSha256]) assert.match(value, /^[a-f0-9]{64}$/);
  assert.equal(proof.backups.length, 2); assert.equal(new Set(proof.backups.map(row => row.file)).size, 2);
  assert.deepEqual(proof.backups.map(row => row.sha256).sort(), [proof.currentAfter, proof.legacyBefore].sort());
  assert.ok(proof.initialBackupRetained); assert.equal(proof.initialBackupRetained.sha256, proof.currentBefore);
  for (const client of [proof.clientAfterRepair, proof.clientAfterReopen]) {
    assert.equal(client?.serverVersion, '2.7.10');
    for (const key of ['readOnlyCallPassed', 'settingsUnchanged', 'processesExited']) assert.equal(client[key], true);
    assert.ok(Number.isSafeInteger(client.routerPid) && client.routerPid > 0);
    assert.ok(Number.isSafeInteger(client.runtimePid) && client.runtimePid > 0 && client.runtimePid !== client.routerPid);
  }
  assert.equal(new Set([proof.clientAfterRepair.routerPid, proof.clientAfterRepair.runtimePid,
    proof.clientAfterReopen.routerPid, proof.clientAfterReopen.runtimePid]).size, 4);
}
function createCase({ profile, out, hub, read, psCommand, windows, pid, same, env, inventory }) {
  const settings = require('./native-windows-016-settings-only.cjs');
  const f = settings.fixture({ APPDATA: profile.roaming, LOCALAPPDATA: profile.local, USERPROFILE: profile.home }, out);
  const oldServer = path.join(out, 'missing-standalone/server/creator-works-mcp.mjs');
  const docs = documents(f.config, oldServer);
  const codexConfig = path.join(profile.home, '.codex/config.toml');
  f.untouched = f.untouched.filter(item => item.file !== codexConfig);
  let expectedCurrent = docs.current, expectedConfig = docs.expected;
  const originalCurrent = docs.current;
  const routeFile = path.join(profile.home, '.creator-hub/mcp-route-v1/windows-x86_64/active.json');
  let routeBefore;
  const proof = { decisions: [], currentBefore: hash(docs.current), legacyBefore: hash(docs.legacy) };
  let markerBefore;
  let expectedRepairServer;
  function preserved() {
    assert.ok(read(f.current).equals(expectedCurrent)); assert.ok(read(f.legacy).equals(docs.legacy));
    for (const item of f.untouched) assert.ok(read(item.file).equals(item.bytes));
    assert.equal(fs.existsSync(oldServer), false);
    assert.equal(fs.existsSync(codexConfig), false);
    if (routeBefore !== undefined) assert.ok(read(routeFile).equals(routeBefore));
    assert.equal(fs.existsSync(f.review), false, 'Backup review is not convergence approval');
  }
  function checkedBackups(report) {
    assert.equal(report.currentPath, f.current); assert.equal(report.legacyPath, f.legacy);
    const expected = [[f.current, expectedCurrent], [f.legacy, docs.legacy]].map(([file, body]) => {
      const backup = backupName(file, body); assert.ok(read(backup).equals(body));
      return { file: backup, sha256: hash(body) };
    });
    assert.deepEqual([...report.backups].sort(), expected.map(row => row.file).sort());
    const retained = [{ file: backupName(f.current, originalCurrent), sha256: hash(originalCurrent) }, ...expected];
    assert.ok(read(retained[0].file).equals(originalCurrent));
    proof.initialBackupRetained = retained[0];
    for (const directory of [f.current, f.legacy].map(file => path.dirname(backupName(file, Buffer.alloc(0)))))
      assert.deepEqual(fs.readdirSync(directory).sort(), [...new Set(retained.filter(row => path.dirname(row.file) === directory).map(row => path.basename(row.file)))].sort());
    fingerprint(report); return expected;
  }
  const status = page => page.evaluate(() => window.CreatorHubNative.invoke('feature_call', { feature: 'mcp', command: 'product_settings_status', args: {} }));
  const marker = page => page.evaluate(key => localStorage.getItem(key), KEY);
  async function ready(page) {
    await page.waitForFunction(() => {
      const root = document.querySelector('#feature-mcp');
      return root && !root.hidden && root.getAttribute('aria-busy') === 'false' && root.querySelector('[data-field="status"]')?.textContent === 'Ready';
    });
    await settings.assertMcpControls(page, true);
    const loaded = await settings.loadMcpConfig(page);
    for (const key of ['channels', 'active_channel_id', 'mcp_server_path', 'tool_groups', 'auto_start', 'enable_custom_scripts', 'allow_all_tests'])
      assert.deepEqual(loaded[key], expectedConfig[key]);
    assert.equal(await page.locator('#feature-mcp [data-field="project"]').inputValue(), expectedConfig.channels[0].unity_project_path);
    assert.equal(await page.locator('#feature-mcp [data-field="groups"]').inputValue(), expectedConfig.tool_groups);
    preserved();
  }
  async function decision(approve) {
    let selected;
    for (let count = 0; count < 60; count++) {
      try { same(); selected = settings.selectDialog(windows(), pid(), 'preserve', approve, f); break; }
      catch (error) { if (count === 59) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    same();
    if (expectedCurrent === originalCurrent) preserved();
    else {
      const changed = JSON.parse(read(f.current));
      assert.deepEqual(exceptServer(changed), exceptServer(JSON.parse(originalCurrent)));
      assert.equal(normalize(changed.mcp_server_path), expectedRepairServer);
      assert.ok(read(f.legacy).equals(docs.legacy));
      for (const item of f.untouched) assert.ok(read(item.file).equals(item.bytes));
    }
    psCommand(settings.dialogCommand(pid(), hub, selected, 'preserve', approve, f));
    proof.decisions.push(approve);
  }
  async function bindForReadOnlyClient(page) {
    const direct = require('./native-outgoing-direct-019.cjs');
    await direct.prepareManagedRoute(page, { clientConfig: codexConfig, active: routeFile,
      approve: async () => {
        let found = false;
        for (let count = 0; count < 60; count++) {
        same();
        const matches = windows().filter(row => row.title === 'Enable managed MCP routing');
        if (matches.length) { assert.equal(matches.length, 1); found = true; break; }
        await new Promise(resolve => setTimeout(resolve, 250));
        }
        assert.equal(found, true, 'Expected native managed-route consent'); same();
        // Existing native helper rechecks PID, executable, title, enabled control and task ID.
        const quote = value => "'" + value.replaceAll("'", "''") + "'";
        const helper = path.join(__dirname, 'native-window.ps1');
        psCommand(`& ${quote(helper)} -TargetPid ${pid()} -ExpectedExecutable ${quote(hub)} -Action button -Value 'Enable managed routing'`);
      } });
    if (routeBefore === undefined) routeBefore = read(routeFile);
    else assert.ok(read(routeFile).equals(routeBefore));

  }
  return {
    seed() {
      for (const item of f.untouched) {
        if (fs.existsSync(item.file)) item.bytes = read(item.file);
      }
      for (const item of [...f.untouched.filter(item => !fs.existsSync(item.file)),
        { file: f.current, bytes: docs.current }, { file: f.legacy, bytes: docs.legacy }]) {
        assert.equal(fs.existsSync(item.file), false, 'Refuse existing fixture path');
        for (let at = path.dirname(item.file); ; at = path.dirname(at)) {
          if (fs.existsSync(at)) assert.equal(fs.lstatSync(at).isSymbolicLink(), false);
          if (at === path.dirname(at)) break;
        }
        fs.mkdirSync(path.dirname(item.file), { recursive: true }); fs.writeFileSync(item.file, item.bytes, { flag: 'wx' });
      }
      preserved();
    },
    async session(page, reopen) {
      if (await page.locator('#convergence-dialog').isVisible()) {
        await page.locator('#convergence-later').click(); await page.locator('#convergence-dialog').waitFor({ state: 'hidden' });
      }
      await require('./windows-incoming-016.cjs').showPage(page, 'mcp');
      await page.waitForFunction(settings.reviewSettled, false);
      const before = await status(page); assert.equal(before.status, 'conflict'); preserved();
      if (!reopen) {
        proof.statusBefore = before.status; assert.deepEqual(before.backups, []);
        assert.equal(await marker(page), null); await settings.assertMcpControls(page, false);
        const review = page.locator('#feature-mcp [data-field="product-review"]');
        await review.click(); await decision(false); await page.waitForFunction(settings.reviewSettled, true);
        preserved(); assert.deepEqual((await status(page)).backups, []); assert.equal(await marker(page), null);
        await settings.assertMcpControls(page, false); proof.cancelPreserved = true;
        await review.click(); await decision(true); await ready(page);
        const reviewed = await status(page); proof.backups = checkedBackups(reviewed);
        const initialMarker = await marker(page);
        assert.deepEqual(JSON.parse(initialMarker), { version: 1, fingerprint: fingerprint(reviewed) });
        const runtime = await page.evaluate(() => window.CreatorHubNative.invoke('feature_call', { feature: 'mcp', command: 'get_onboarding_status', args: { unityProjectPath: null } }));
        assert.equal(runtime.managedRouting, false, 'Repair must be available before managed-route binding');
        assert.equal(fs.existsSync(routeFile), false, 'Initial repair must not depend on active route state');
        assert.equal(await page.locator('#feature-mcp [data-field="repair-runtime"]').isVisible(), true);
        proof.initialRouteUnbound = true; proof.repairVisibleBeforeBinding = true; assert.equal(runtime.runtime.ready, true); assert.equal(runtime.runtime.bundled, true);
        const nodePath = normalize(runtime.runtime.command); assert.match(nodePath, /^[A-Za-z]:\/.+\/runtime\/node\.exe$/i);
        assert.equal(nodePath.split('/').some(part => part === '.' || part === '..'), false);
        const server = nodePath.replace(/\/runtime\/node\.exe$/i, '/creator-works-mcp.mjs');
        expectedRepairServer = server;
        const beforeRepair = read(f.current);
        await page.locator('#feature-mcp [data-field="repair-runtime"]').click();
        let prompt = page.getByRole('dialog', { name: 'Use Hub MCP runtime?', exact: true });
        await prompt.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.waitForFunction(settings.reviewSettled, false);
        assert.ok(read(f.current).equals(beforeRepair)); assert.equal(await marker(page), initialMarker);
        proof.runtimeRepairCancelled = true;
        await page.locator('#feature-mcp [data-field="repair-runtime"]').click();
        prompt = page.getByRole('dialog', { name: 'Use Hub MCP runtime?', exact: true });
        expectedCurrent = Buffer.alloc(0); // The UI owns the one admitted write; no harness settings rewrite.
        await prompt.getByRole('button', { name: 'Use Hub runtime', exact: true }).click();
        await decision(true);
        expectedCurrent = read(f.current); expectedConfig = JSON.parse(expectedCurrent);
        assert.deepEqual(exceptServer(expectedConfig), exceptServer(JSON.parse(beforeRepair)));
        assert.equal(normalize(expectedConfig.mcp_server_path), server);
        assert.notEqual(hash(expectedCurrent), hash(beforeRepair));
        await ready(page);
        const repairedReport = await status(page); proof.backups = checkedBackups(repairedReport);
        markerBefore = await marker(page);
        assert.notEqual(markerBefore, initialMarker);
        assert.deepEqual(JSON.parse(markerBefore), { version: 1, fingerprint: fingerprint(repairedReport) });
        proof.runtimeRepairApproved = true; proof.onlyServerChanged = true; proof.oldServerAbsent = true;
        proof.renewedReview = true; proof.managedRouteUnchanged = true;
        assert.equal(fs.existsSync(routeFile), false, 'Repair must not create or activate a route');
        await bindForReadOnlyClient(page);
        proof.clientAfterRepair = await require('./native-windows-r14-client.cjs').probe({ profile, env, inventory, settingsPath: f.current });
        proof.markerSha256 = hash(markerBefore); proof.approvalObserved = true; proof.backupsVerified = true;
        proof.controlsEnabledBeforeClose = true;
      } else {
        await ready(page); const reviewed = await status(page); proof.statusAfter = reviewed.status;
        assert.deepEqual(checkedBackups(reviewed), proof.backups); assert.equal(await marker(page), markerBefore);
        assert.equal(windows().filter(row => row.title === 'Preserve MCP product settings').length, 0);
        proof.controlsEnabledAfterReopen = true; proof.markerUnchanged = true; proof.noRepeatedApproval = true;
        proof.currentAfter = hash(read(f.current)); proof.legacyAfter = hash(read(f.legacy)); proof.settingsUnchanged = true;
        await bindForReadOnlyClient(page);
        proof.clientAfterReopen = await require('./native-windows-r14-client.cjs').probe({ profile, env, inventory, settingsPath: f.current });
        validateProof(proof);
      }
      await page.screenshot({ path: path.join(out, `review-${reopen ? 'reopen' : 'approved'}.png`) });
      return proof;
    },
    verify() { preserved(); validateProof(proof); return proof; },
  };
}
module.exports = { KEY, backupName, documents, fingerprint, validateProof, exceptServer, createCase };


