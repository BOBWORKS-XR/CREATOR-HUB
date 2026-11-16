'use strict';
// Synthetic stopped-record acceptance. No replay, settings rewrite or retirement.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const ROOT = path.resolve(__dirname, '..');
const PARENT_PRODUCT = '05bcaa5417b86792e37ef64f346f7a20c42a3996';
const FAILED_R16_PRODUCT = '9cbe10fe95bf255da4263bdc0187bf3fe443f2ef';
const EXPECTED_OVERLAYS = Object.freeze([
  'modules/mcp/launcher/src-tauri/src/product_settings.rs',
  'modules/mcp/launcher/src-tauri/src/service.rs',
  'src-tauri/build.rs', 'src-tauri/capabilities/default.json',
  'src-tauri/src/convergence_profiles_tests.rs', 'src-tauri/src/convergence.rs', 'src-tauri/src/main.rs',
  'src/convergence.js', 'src/index.html', 'tests/convergence.spec.js',
]);
const TITLE = 'Keep my current setup';
const MESSAGE = 'Keep the setup you have now?\n\n- Back up your current settings and the old setup record.\n- Keep your projects, preferences and AI connections unchanged.\n- Stop reminding you about this old attempt. Nothing is replayed or uninstalled.\n\nThis does not finish the old migration. You can set up MCP normally from the menu.';
const keys = (value, names) => assert.deepEqual(Object.keys(value).sort(), [...names].sort());

function validateCandidate(value, binding, bindingSha256) {
  keys(value, ['schemaVersion', 'ready', 'source', 'sourceReceiptSha256', 'sourceOverlays', 'qualificationSha256', 'buildReportSha256', 'bindingSha256']);
  assert.equal(value.schemaVersion, 1); assert.equal(value.ready, true, 'R17 exact candidate pins pending; native execution refused');
  keys(value.source, ['commit', 'tree']);
  for (const name of ['commit', 'tree']) assert.match(value.source[name], /^[a-f0-9]{40}$/);
  assert.notEqual(value.source.commit, PARENT_PRODUCT, 'R15 cannot exercise root recovery');
  assert.notEqual(value.source.commit, FAILED_R16_PRODUCT, 'Failed R16 cannot qualify R17');
  for (const name of ['sourceReceiptSha256', 'qualificationSha256', 'buildReportSha256', 'bindingSha256']) assert.match(value[name], /^[a-f0-9]{64}$/);
  assert.deepEqual(value.sourceOverlays, [...EXPECTED_OVERLAYS]);
  assert.equal(value.sourceReceiptSha256, binding.fixtureQualification.sourceReceiptSha256);
  assert.deepEqual(value.sourceOverlays, binding.fixtureQualification.sourceProof?.overlays);
  assert.deepEqual(binding.fixtureQualification.sourceProof?.sourceContract?.moduleSourceChanges, EXPECTED_OVERLAYS.slice(0, 2));
  assert.equal(value.bindingSha256, bindingSha256);
  assert.deepEqual(value.source, binding.target.source);
  assert.equal(value.qualificationSha256, binding.target.verificationReceiptSha256);
  assert.equal(value.qualificationSha256, binding.fixtureQualification.sha256);
  assert.equal(value.buildReportSha256, binding.fixtureQualification.buildReportSha256);
  assert.equal(binding.privateOnly, true); assert.equal(binding.target.version, '0.1.23');
  assert.equal(binding.fixtureQualification.published, false);
  return value;
}
function assertCandidate() {
  const candidate = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/root-recovery-candidate.json')));
  assert.equal(candidate.ready, true, 'R17 exact candidate pins pending; native execution refused');
  const target = require('./windows-outgoing-019-target.cjs'); target.validateBinding();
  return validateCandidate(candidate, target.binding,
    hash(fs.readFileSync(path.join(__dirname, 'fixtures/windows-outgoing-019-binding.json'))));
}
function backupName(file, sha256, paths = path) {
  assert.match(sha256, /^[a-f0-9]{64}$/);
  return paths.join(paths.dirname(file), '.creator-hub-settings-backups', `${paths.basename(file)}.${sha256}.bak`);
}
function stoppedRecord(seed) {
  return Buffer.from(JSON.stringify({ policy: 1, phase: 'connections', outcome: 'stopped',
    review_key: hash(seed), retry_blocked: true }) + '\n');
}
function settledStatus(value) {
  assert.equal(value.enabled, true); assert.equal(value.streamlined, true);
  assert.equal(value.stage, 'review'); assert.equal(typeof value.required, 'boolean');
  assert.equal(value.keepCurrentAvailable, false); assert.equal(value.recoveryHelp, null);
  assert.equal(value.retirementAvailable, false);
}
function selectDialog(windows, pid, approve) {
  assert.equal(typeof approve, 'boolean');
  const dialogs = windows.filter(row => row.class === '#32770'); assert.equal(dialogs.length, 1);
  const dialog = dialogs[0]; assert.equal(dialog.title, TITLE);
  assert.ok(Number.isSafeInteger(dialog.handle) && dialog.handle > 0);
  const content = dialog.controls.filter(row => row.id === 'ContentText'); assert.equal(content.length, 1);
  assert.equal(content[0].processId, pid); assert.equal(content[0].name.replace(/\r\n/g, '\n'), MESSAGE);
  const name = approve ? TITLE : 'Not now', id = approve ? 1000 : 1001;
  const buttons = dialog.controls.filter(row => row.name === name); assert.equal(buttons.length, 1);
  assert.equal(buttons[0].processId, pid); assert.equal(buttons[0].id, `CommandButton_${id}`);
  return { title: TITLE, name, id, handle: dialog.handle, content: content[0].name };
}
function dialogCommand(pid, executable, selected, approve) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.ok(path.win32.isAbsolute(executable) && !/[\0\r\n]/.test(executable));
  assert.deepEqual(selected, selectDialog([{ class: '#32770', title: selected.title, handle: selected.handle,
    controls: [{ id: 'ContentText', name: selected.content, processId: pid },
      { id: `CommandButton_${selected.id}`, name: selected.name, processId: pid }] }], pid, approve));
  const quote = value => `'${value.replaceAll("'", "''")}'`;
  return `$targetPid=${pid};$expectedExecutable=${quote(executable)};$dialogHandle=${selected.handle};$buttonId=${selected.id};$buttonName=${quote(selected.name)};$expectedTitle=${quote(TITLE)};$expectedContent=${quote(selected.content)};\n${require('./native-windows-016-migration.cjs').DIALOG_ACTION}`;
}
function inventory(roots, read) {
  const rows = [], seen = new Set(); let total = 0;
  function visit(file) {
    if (seen.has(file) || !fs.existsSync(file)) return; seen.add(file);
    for (let at = file;; at = path.dirname(at)) {
      assert.equal(fs.lstatSync(at).isSymbolicLink(), false, 'Linked fixture refused');
      if (at === path.dirname(at)) break;
    }
    const stat = fs.lstatSync(file);
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
    else {
      assert.ok(stat.isFile() && stat.nlink === 1 && stat.size <= 2 * 1024 * 1024, 'Bounded independent fixture file required');
      const bytes = read(file); total += bytes.length;
      assert.ok(total <= 16 * 1024 * 1024 && rows.length < 1024, 'Fixture inventory limit');
      rows.push({ file, bytes: bytes.length, sha256: hash(bytes) });
    }
  }
  roots.forEach(visit); return rows.sort((a, b) => a.file.localeCompare(b.file, 'en'));
}
function verifyAdditions(before, after, additions) {
  assert.equal(new Set(after.map(row => row.file)).size, after.length);
  const prior = new Map(before.map(row => [row.file, row]));
  for (const row of before) assert.deepEqual(after.find(next => next.file === row.file), row, 'Protected fixture changed or disappeared');
  const added = after.filter(row => !prior.has(row.file));
  assert.deepEqual(added.map(row => row.file).sort(), additions.map(row => row.file).sort(), 'Unexpected recovery writes');
  for (const row of added) {
    const allowed = additions.find(item => item.file === row.file);
    if (allowed.sha256) assert.equal(row.sha256, allowed.sha256, 'Backup bytes differ from source');
  }
  return added;
}
function verifyReceipt(value, batchRow, stores) {
  keys(value, ['policy', 'active', 'batch_sha256', 'store_sha256']);
  assert.equal(value.policy, 1); assert.equal(value.active, true);
  assert.equal(value.batch_sha256, batchRow.sha256);
  assert.deepEqual(value.store_sha256, stores.map(row => row?.sha256 ?? null));
}
function validateProof(proof) {
  assert.equal(proof.kind, 'root-stopped-connections-keep-current'); assert.equal(proof.syntheticStoppedRecord, true);
  for (const name of ['inspectionPreserved', 'cancelPreserved', 'approved', 'backupsVerified', 'journalUnchanged',
    'settingsRoutesProjectsUnchanged', 'reopened', 'noRepeatedApproval', 'receiptUnchanged']) assert.equal(proof[name], true, name);
  for (const name of ['migrationComplete', 'standaloneRetirement', 'liveAiAcceptance', 'releaseReady']) assert.equal(proof[name], false, name);
  assert.deepEqual(proof.decisions, [false, true]);
  assert.match(proof.originalJournalSha256, /^[a-f0-9]{64}$/); assert.match(proof.receiptSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(proof.after, proof.reopen);
  const batch = proof.before.find(row => row.file === proof.journal); assert.ok(batch);
  assert.equal(batch.sha256, proof.originalJournalSha256);
  const stores = proof.storeFiles.map(file => proof.before.find(row => row.file === file)); assert.equal(stores.length, 4);
  verifyReceipt(proof.receipt, batch, stores);
  const expected = [...stores.filter(Boolean), batch].map(row => ({ file: backupName(row.file, row.sha256, path.win32), sha256: row.sha256 }));
  const existing = new Set(proof.before.map(row => path.win32.normalize(row.file)));
  const additions = expected.filter(row => !existing.has(path.win32.normalize(row.file)));
  additions.push({ file: proof.receiptFile, sha256: proof.receiptSha256 });
  verifyAdditions(proof.before, proof.after, additions);
  assert.equal(proof.before.some(row => row.file === proof.receiptFile), false);
}
function createCase({ profile, out, hub, read, psCommand, windows, pid, same }) {
  const f = require('./native-windows-016-settings-only.cjs').fixture(
    { APPDATA: profile.roaming, LOCALAPPDATA: profile.local, USERPROFILE: profile.home }, out);
  const convergence = path.join(profile.local, 'CreatorHub/convergence');
  const journal = path.join(convergence, 'move-v1.json'), receiptFile = path.join(convergence, 'kept-setup-v1.json');
  const storeFiles = [f.current, f.legacy, path.join(profile.roaming, 'creator-works-mcp/hosted-operation-outcomes.json'),
    path.join(profile.local, 'CreatorProjectSetup/editor-roots.json')];
  const roots = [path.dirname(f.current), path.dirname(f.legacy), path.join(profile.local, 'CreatorProjectSetup'),
    convergence, path.join(profile.local, 'CreatorHub/preferences'), path.join(profile.local, 'CreatorHub/consent'),
    path.join(profile.home, '.creator-hub/mcp-route-v1/windows-x86_64/active.json'),
    ...f.untouched.map(row => row.file), ...f.projects];
  const capture = () => inventory(roots, read);
  const proof = { kind: 'root-stopped-connections-keep-current', syntheticStoppedRecord: true, decisions: [],
    journal, receiptFile, storeFiles, migrationComplete: false, standaloneRetirement: false, liveAiAcceptance: false, releaseReady: false };
  const status = page => page.evaluate(() => window.CreatorHubNative.invoke('convergence_status'));
  const stable = page => page.waitForFunction(() => document.querySelector('#convergence-dialog')?.getAttribute('aria-busy') === 'false');
  function unchanged() { assert.deepEqual(capture(), proof.before); }
  async function decision(approve) {
    let selected;
    for (let count = 0; count < 60; count++) {
      same(); const observed = windows();
      if (observed.some(row => row.class === '#32770')) { selected = selectDialog(observed, pid(), approve); break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    assert.ok(selected, 'Expected exact keep-current native confirmation'); same(); unchanged();
    psCommand(dialogCommand(pid(), hub, selected, approve)); proof.decisions.push(approve);
  }
  return {
    seed() {
      for (const file of [journal, receiptFile, f.review]) assert.equal(fs.existsSync(file), false, 'Unexpected root recovery state');
      assert.ok(fs.existsSync(f.current) && fs.existsSync(f.legacy));
      const before = capture();
      const bytes = stoppedRecord(JSON.stringify(before));
      fs.mkdirSync(convergence, { recursive: true }); fs.writeFileSync(journal, bytes, { flag: 'wx' });
      proof.before = capture(); proof.originalJournalSha256 = hash(bytes);
      assert.equal(proof.before.length, before.length + 1);
    },
    async session(page, reopen) {
      if (!reopen) {
        await page.locator('#convergence-dialog').waitFor({ state: 'visible' }); await stable(page);
        const initial = await status(page);
        assert.equal(initial.keepCurrentAvailable, true); assert.equal(initial.required, true);
        assert.ok(initial.recoveryHelp); assert.equal(initial.stage, 'review'); unchanged();
        for (let i = 0; i < 2; i++) {
          await page.locator('#convergence-refresh').click(); await stable(page);
          const inspected = await status(page); assert.equal(inspected.keepCurrentAvailable, true); unchanged();
        }
        proof.inspectionPreserved = true;
        await page.locator('#convergence-keep-current').click(); await decision(false); await stable(page);
        assert.equal(await page.locator('#convergence-error').isVisible(), true);
        assert.equal((await status(page)).keepCurrentAvailable, true); unchanged(); proof.cancelPreserved = true;
        await page.locator('#convergence-keep-current').click(); await decision(true); await stable(page);
        assert.equal(await page.locator('#convergence-title').innerText(), 'Current setup kept');
        const result = await status(page); settledStatus(result);
        assert.match(result.message, /old attempt was not replayed/i); assert.match(result.message, /backed up/i);
        proof.after = capture();
        const batchRow = proof.before.find(row => row.file === journal);
        const stores = storeFiles.map(file => proof.before.find(row => row.file === file));
        const expected = [...stores.filter(Boolean), batchRow].map(row => ({ file: backupName(row.file, row.sha256), sha256: row.sha256 }));
        for (const row of expected) assert.equal(hash(read(row.file)), row.sha256);
        const prior = new Set(proof.before.map(row => row.file));
        verifyAdditions(proof.before, proof.after, [...expected.filter(row => !prior.has(row.file)), { file: receiptFile }]);
        proof.receipt = JSON.parse(read(receiptFile)); verifyReceipt(proof.receipt, batchRow, stores);
        proof.receiptSha256 = hash(read(receiptFile)); proof.approved = true; proof.backupsVerified = true;
        proof.journalUnchanged = true; proof.settingsRoutesProjectsUnchanged = true;
        await page.getByRole('button', { name: 'Continue in Hub', exact: true }).click();
        await page.locator('#convergence-dialog').waitFor({ state: 'hidden' });
      } else {
        await page.waitForFunction(() => document.querySelector('#convergence-dialog')?.open || !document.querySelector('#check-updates').disabled,
          null, { timeout: 90000 });
        settledStatus(await status(page));
        assert.equal(windows().some(row => row.title === TITLE), false);
        if (await page.locator('#convergence-dialog').isVisible()) {
          assert.equal(await page.locator('#convergence-keep-current').isVisible(), false);
          assert.equal(await page.locator('#convergence-recovery').isVisible(), false);
          await page.locator('#convergence-later').click();
        }
        proof.reopen = capture(); assert.deepEqual(proof.reopen, proof.after);
        proof.reopened = true; proof.noRepeatedApproval = true; proof.receiptUnchanged = true;
        validateProof(proof);
      }
      await page.waitForFunction(() => !document.querySelector('#check-updates').disabled, null, { timeout: 90000 });
      await page.screenshot({ path: path.join(out, `root-recovery-${reopen ? 'reopen' : 'kept'}.png`) });
    },
    verify() { assert.deepEqual(capture(), proof.after); validateProof(proof); return proof; },
  };
}
module.exports = { TITLE, MESSAGE, EXPECTED_OVERLAYS, validateCandidate, assertCandidate, backupName, stoppedRecord,
  settledStatus, selectDialog, dialogCommand, inventory, verifyAdditions, verifyReceipt, validateProof, createCase };
if (require.main === module) {
  assert.equal(process.argv[2], 'candidate'); assert.equal(process.argv.length, 3);
  assertCandidate(); console.log(JSON.stringify({ exactCandidateReady: true, published: false }));
}
