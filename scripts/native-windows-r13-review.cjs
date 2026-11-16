'use strict';
// A second, synthetic settings case inside the admitted fresh hosted-runner job.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const KEY = 'creator-hub.mcp-product-review.v1';
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
    'controlsEnabledAfterReopen', 'settingsUnchanged', 'markerUnchanged', 'noRepeatedApproval']) assert.equal(proof[key], true, key);
  assert.deepEqual(proof.decisions, [false, true]);
  assert.equal(proof.statusBefore, 'conflict'); assert.equal(proof.statusAfter, 'conflict');
  assert.equal(proof.currentBefore, proof.currentAfter); assert.equal(proof.legacyBefore, proof.legacyAfter);
  assert.notEqual(proof.currentBefore, proof.legacyBefore);
  for (const value of [proof.currentBefore, proof.legacyBefore, proof.markerSha256]) assert.match(value, /^[a-f0-9]{64}$/);
  assert.equal(proof.backups.length, 2); assert.equal(new Set(proof.backups.map(row => row.file)).size, 2);
  assert.deepEqual(proof.backups.map(row => row.sha256).sort(), [proof.currentBefore, proof.legacyBefore].sort());
}
function createCase({ profile, out, hub, read, psCommand, windows, pid, same }) {
  const settings = require('./native-windows-016-settings-only.cjs');
  const f = settings.fixture({ APPDATA: profile.roaming, LOCALAPPDATA: profile.local, USERPROFILE: profile.home }, out);
  const docs = documents(f.config, path.join(path.dirname(hub), 'modules/mcp/server/creator-works-mcp.mjs'));
  const proof = { decisions: [], currentBefore: hash(docs.current), legacyBefore: hash(docs.legacy) };
  let markerBefore;
  function preserved() {
    assert.ok(read(f.current).equals(docs.current)); assert.ok(read(f.legacy).equals(docs.legacy));
    for (const item of f.untouched) assert.ok(read(item.file).equals(item.bytes));
    assert.equal(fs.existsSync(f.review), false, 'Backup review is not convergence approval');
  }
  function checkedBackups(report) {
    assert.equal(report.currentPath, f.current); assert.equal(report.legacyPath, f.legacy);
    const expected = [[f.current, docs.current], [f.legacy, docs.legacy]].map(([file, body]) => {
      const backup = backupName(file, body); assert.ok(read(backup).equals(body));
      return { file: backup, sha256: hash(body) };
    });
    assert.deepEqual([...report.backups].sort(), expected.map(row => row.file).sort());
    for (const directory of [f.current, f.legacy].map(file => path.dirname(backupName(file, Buffer.alloc(0)))))
      assert.deepEqual(fs.readdirSync(directory).sort(), expected.filter(row => path.dirname(row.file) === directory).map(row => path.basename(row.file)).sort());
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
      assert.deepEqual(loaded[key], docs.expected[key]);
    assert.equal(await page.locator('#feature-mcp [data-field="project"]').inputValue(), docs.expected.channels[0].unity_project_path);
    assert.equal(await page.locator('#feature-mcp [data-field="groups"]').inputValue(), docs.expected.tool_groups);
    preserved();
  }
  async function decision(approve) {
    let selected;
    for (let count = 0; count < 60; count++) {
      try { same(); selected = settings.selectDialog(windows(), pid(), 'preserve', approve, f); break; }
      catch (error) { if (count === 59) throw error; await new Promise(resolve => setTimeout(resolve, 250)); }
    }
    same(); preserved();
    psCommand(settings.dialogCommand(pid(), hub, selected, 'preserve', approve, f));
    proof.decisions.push(approve);
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
        markerBefore = await marker(page);
        assert.deepEqual(JSON.parse(markerBefore), { version: 1, fingerprint: fingerprint(reviewed) });
        proof.markerSha256 = hash(markerBefore); proof.approvalObserved = true; proof.backupsVerified = true;
        proof.controlsEnabledBeforeClose = true;
      } else {
        await ready(page); const reviewed = await status(page); proof.statusAfter = reviewed.status;
        assert.deepEqual(checkedBackups(reviewed), proof.backups); assert.equal(await marker(page), markerBefore);
        assert.equal(windows().filter(row => row.title === 'Preserve MCP product settings').length, 0);
        proof.controlsEnabledAfterReopen = true; proof.markerUnchanged = true; proof.noRepeatedApproval = true;
        proof.currentAfter = hash(read(f.current)); proof.legacyAfter = hash(read(f.legacy)); proof.settingsUnchanged = true;
        validateProof(proof);
      }
      await page.screenshot({ path: path.join(out, `review-${reopen ? 'reopen' : 'approved'}.png`) });
      return proof;
    },
    verify() { preserved(); validateProof(proof); return proof; },
  };
}
module.exports = { KEY, backupName, documents, fingerprint, validateProof, createCase };
