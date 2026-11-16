'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { yaml } = require('playwright-core/lib/utilsBundle');
const recovery = require('./native-windows-root-recovery.cjs');
const sha = char => char.repeat(64);
function pins() {
  const source = { commit: 'b'.repeat(40), tree: 'c'.repeat(40) };
  return { candidate: { schemaVersion: 1, ready: true, source, qualificationSha256: sha('d'),
    sourceReceiptSha256: sha('a'), sourceOverlays: [...recovery.EXPECTED_OVERLAYS],
    buildReportSha256: sha('e'), bindingSha256: sha('f') }, binding: { privateOnly: true,
    target: { source, version: '0.1.23', verificationReceiptSha256: sha('d') },
    fixtureQualification: { sha256: sha('d'), buildReportSha256: sha('e'), published: false,
      sourceReceiptSha256: sha('a'), sourceProof: { overlays: [...recovery.EXPECTED_OVERLAYS],
        sourceContract: { moduleSourceChanges: recovery.EXPECTED_OVERLAYS.slice(0, 2) } } } } };
}

test('R17 requires the reviewed overlays and source receipt with the public product-settings API', () => {
  const { candidate, binding } = pins(); recovery.validateCandidate(candidate, binding, sha('f'));
  assert.ok(recovery.EXPECTED_OVERLAYS.includes('src-tauri/src/convergence_profiles_tests.rs'));
  for (const change of [c => c.sourceOverlays.shift(), c => c.sourceOverlays.pop(),
    c => c.sourceOverlays.reverse(), c => c.sourceOverlays.push('package.json'),
    c => c.sourceReceiptSha256 = sha('b'), c => c.source.commit = '9cbe10fe95bf255da4263bdc0187bf3fe443f2ef']) {
    const c = structuredClone(candidate); change(c);
    assert.throws(() => recovery.validateCandidate(c, binding, sha('f')));
  }
  const changed = structuredClone(binding);
  changed.fixtureQualification.sourceProof.sourceContract.moduleSourceChanges.shift();
  assert.throws(() => recovery.validateCandidate(candidate, changed, sha('f')));
  const omitted = structuredClone(candidate);
  omitted.sourceOverlays = omitted.sourceOverlays.filter(name => name !== 'src-tauri/src/convergence_profiles_tests.rs');
  assert.throws(() => recovery.validateCandidate(omitted, binding, sha('f')));
});
test('pending candidate refuses before inherited native admission or acquisition', () => {
  const pending = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/root-recovery-candidate.json')));
  assert.equal(pending.ready, true); recovery.assertCandidate();
  assert.throws(() => recovery.validateCandidate({ ...pending, ready: false }, {}, ''), /pins pending/);
  const { candidate, binding } = pins(); recovery.validateCandidate(candidate, binding, sha('f'));
  for (const change of [c => c.ready = false, c => c.source.commit = '05bcaa5417b86792e37ef64f346f7a20c42a3996',
    c => c.qualificationSha256 = sha('a'), c => c.buildReportSha256 = sha('a'), c => c.bindingSha256 = sha('a'),
    c => c.extra = true]) {
    const c = structuredClone(candidate); change(c); assert.throws(() => recovery.validateCandidate(c, binding, sha('f')));
  }
});
test('synthetic record is explicitly stopped connections, never a fabricated success', () => {
  const record = JSON.parse(recovery.stoppedRecord('synthetic inventory'));
  assert.equal(record.policy, 1); assert.equal(record.phase, 'connections'); assert.equal(record.outcome, 'stopped');
  assert.equal(record.retry_blocked, true); assert.match(record.review_key, /^[a-f0-9]{64}$/);
});
function dialog(approve) {
  return { title: recovery.TITLE, class: '#32770', handle: 900, controls: [
    { id: 'ContentText', name: recovery.MESSAGE, processId: 55 },
    { id: `CommandButton_${approve ? 1000 : 1001}`, name: approve ? recovery.TITLE : 'Not now', processId: 55 } ] };
}
test('native decision requires exact owner, body, title and fixed task button', () => {
  for (const approve of [false, true]) {
    const good = dialog(approve); const selected = recovery.selectDialog([good], 55, approve);
    const command = recovery.dialogCommand(55, 'C:/fixture/creator-hub.exe', selected, approve);
    assert.match(command, /GetWindowThreadProcessId/); assert.match(command, /expectedContent/);
    for (const mutate of [d => d.title = 'Other', d => d.controls[0].name += 'changed',
      d => d.controls[0].processId++, d => d.controls[1].processId++, d => d.controls[1].id = 'CommandButton_1002',
      d => d.handle = 0]) {
      const changed = structuredClone(good); mutate(changed);
      assert.throws(() => recovery.selectDialog([changed], 55, approve));
    }
    assert.throws(() => recovery.selectDialog([good, good], 55, approve));
    assert.throws(() => recovery.dialogCommand(55, 'relative.exe', selected, approve));
  }
});
test('success permits independent review but refuses uncleared old state or migration completion', () => {
  const good = { enabled: true, streamlined: true, stage: 'review', required: false,
    keepCurrentAvailable: false, recoveryHelp: null, retirementAvailable: false };
  recovery.settledStatus(good); recovery.settledStatus({ ...good, required: true });
  for (const delta of [{ recoveryHelp: 'pending' }, { recoveryHelp: undefined }, { keepCurrentAvailable: true },
    { keepCurrentAvailable: undefined }, { stage: 'complete' }, { retirementAvailable: true }, { enabled: false }])
    assert.throws(() => recovery.settledStatus({ ...good, ...delta }));
});
function proof() {
  const journal = 'C:\\fixture\\convergence\\move-v1.json', receiptFile = 'C:\\fixture\\convergence\\kept-setup-v1.json';
  const storeFiles = ['C:\\fixture\\current.json', 'C:\\fixture\\legacy.json', 'C:\\fixture\\outcomes.json', 'C:\\fixture\\editors.json'];
  const before = [{ file: journal, bytes: 200, sha256: sha('a') },
    { file: storeFiles[0], bytes: 400, sha256: sha('b') }, { file: storeFiles[1], bytes: 400, sha256: sha('c') },
    { file: 'C:\\fixture\\active.json', bytes: 100, sha256: sha('d') },
    { file: 'C:\\fixture\\project\\Assets\\Retained.txt', bytes: 50, sha256: sha('e') }];
  const after = [...before, ...before.slice(0, 3).map(row => ({ ...row,
    file: recovery.backupName(row.file, row.sha256, path.win32) })), { file: receiptFile, bytes: 200, sha256: sha('f') }];
  return { kind: 'root-stopped-connections-keep-current', syntheticStoppedRecord: true,
    inspectionPreserved: true, cancelPreserved: true, approved: true, backupsVerified: true,
    journalUnchanged: true, settingsRoutesProjectsUnchanged: true, reopened: true,
    noRepeatedApproval: true, receiptUnchanged: true, migrationComplete: false,
    standaloneRetirement: false, liveAiAcceptance: false, releaseReady: false,
    decisions: [false, true], journal, receiptFile, storeFiles, originalJournalSha256: sha('a'),
    receiptSha256: sha('f'), before, after, reopen: structuredClone(after),
    receipt: { policy: 1, active: true, batch_sha256: sha('a'), store_sha256: [sha('b'), sha('c'), null, null] } };
}
test('proof binds exact protected inventory, backup bodies and durable receipt across reopen', () => {
  recovery.validateProof(proof());
  for (const mutate of [p => p.decisions.reverse(), p => p.reopened = false, p => p.migrationComplete = true,
    p => p.after[0].sha256 = sha('b'), p => p.after[3].sha256 = sha('a'), p => p.after[4].sha256 = sha('a'),
    p => p.after.pop(), p => p.after.push({ file: 'C:\\fixture\\unexpected.json', bytes: 1, sha256: sha('a') }),
    p => p.receipt.active = false, p => p.receipt.store_sha256[1] = sha('a'),
    p => p.receipt.batch_sha256 = sha('b'), p => p.receipt.extra = true, p => p.reopen.pop()]) {
    const changed = proof(); mutate(changed); assert.throws(() => recovery.validateProof(changed));
  }
});
test('only absent exact before-image backup destinations can be added', () => {
  const before = [{ file: 'store', bytes: 2, sha256: sha('a') }];
  recovery.verifyAdditions(before, [...before, { file: 'backup', bytes: 2, sha256: sha('a') }], [{ file: 'backup', sha256: sha('a') }]);
  assert.throws(() => recovery.verifyAdditions(before, [], []));
  assert.throws(() => recovery.verifyAdditions(before, [...before, { file: 'unknown' }], []));
  assert.throws(() => recovery.verifyAdditions(before, [...before, { file: 'backup', sha256: sha('b') }], [{ file: 'backup', sha256: sha('a') }]));
});
test('hook runs after the four existing sessions and before recovery dialog auto-dismiss', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-windows-r12-fresh.cjs'), 'utf8');
  assert.ok(source.indexOf('await recoveryCase.session(page, recoveryReopen)') < source.indexOf('if (reviewReopen !== null)'));
  assert.ok(source.indexOf('report.productReview = reviewCase.verify()') < source.indexOf('recoveryCase.seed()'));
  assert.match(source, /recoveryCase\.seed\(\); await launch\(false, null, false\); await close\(\)/);
  assert.match(source, /await launch\(false, null, true\); await close\(\)/);
  assert.match(source, /recoveryModule\.validateProof\(report.rootRecovery\)/);
  assert.match(source, /normalCloses.length, 6/);
  assert.ok(source.indexOf('recoveryModule.assertCandidate();', source.indexOf('async function acquire')) < source.indexOf('admission();', source.indexOf('async function acquire')));
  assert.doesNotMatch(source, /taskkill|Stop-Process|\.kill\(/);
});
test('leaf uses UI for the one mutation and never replays or resets a journal', () => {
  const source = fs.readFileSync(__filename.replace('.test.cjs', '.cjs'), 'utf8');
  assert.match(source, /locator\('#convergence-keep-current'\)\.click\(\)/);
  assert.doesNotMatch(source, /invoke\(['"](?:keep_current_convergence|move_to_hub|retire_convergence_apps|prepare_convergence)['"]/);
  assert.doesNotMatch(source, /unlinkSync|rmSync|writeFileSync\([^\n]*flag: ['"]w['"]|taskkill|Stop-Process|\.kill\(/);
  assert.match(source, /writeFileSync\(journal, bytes, \{ flag: 'wx' \}\)/);
});
test('upgrade matrix and entire upgrade job remain the exact R15 workflow', () => {
  const read = file => yaml.parse(fs.readFileSync(file, 'utf8'));
  const current = read(path.join(__dirname, '../.github/workflows/windows-outgoing-019.yml'));
  const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.equal(hash(current.jobs.acceptance), '399dd8dac09371b45013f167c6a6069accb03a2857e55424c0f558c660b6a8c8');
  assert.equal(hash(current.on), 'b5bf6c866be174e00e4cab005c7dda8f75214f98a7b5436d1eb16697bd38ded0');
});
module.exports = { proof };
