'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const p = require('./native-windows-r13-review.cjs');
function status() {
  const currentPath = path.resolve('fixtures/current.json'), legacyPath = path.resolve('fixtures/old.json');
  return { status: 'conflict', currentPath, legacyPath, recovery: [],
    backups: [p.backupName(currentPath, Buffer.from('current')), p.backupName(legacyPath, Buffer.from('legacy'))] };
}
test('fixture differs in preferences without adding active projects or modifying legacy in place', () => {
  const base = { channels: [], active_channel_id: null, auto_start: false };
  const result = p.documents(base, 'C:\\installed\\server.mjs');
  assert.notDeepEqual(result.current, result.legacy);
  assert.deepEqual(JSON.parse(result.current).channels, JSON.parse(result.legacy).channels);
  assert.equal(JSON.parse(result.current).tool_groups, 'read');
  assert.equal(JSON.parse(result.legacy).tool_groups, 'core');
  assert.deepEqual(base, { channels: [], active_channel_id: null, auto_start: false });
});
test('fingerprint binds exact two backups and rejects pending recovery or missing coverage', () => {
  const value = status(), expected = p.fingerprint(value);
  assert.equal(p.fingerprint({ ...value, backups: value.backups.slice().reverse() }), expected);
  for (const change of [v => v.status = 'identical', v => v.backups.pop(), v => v.backups[1] = v.backups[0],
    v => v.recovery.push({ historical_completed: false }), v => v.backups[0] += '.extra']) {
    const bad = structuredClone(value); change(bad); assert.throws(() => p.fingerprint(bad));
  }
});
function proof() {
  return { cancelPreserved: true, approvalObserved: true, backupsVerified: true,
    controlsEnabledBeforeClose: true, controlsEnabledAfterReopen: true, settingsUnchanged: true,
    markerUnchanged: true, noRepeatedApproval: true, decisions: [false, true], statusBefore: 'conflict', statusAfter: 'conflict',
    currentBefore: 'a'.repeat(64), currentAfter: 'a'.repeat(64), legacyBefore: 'b'.repeat(64), legacyAfter: 'b'.repeat(64),
    markerSha256: 'c'.repeat(64), backups: [{ file: 'current', sha256: 'a'.repeat(64) }, { file: 'legacy', sha256: 'b'.repeat(64) }] };
}
test('receipt refuses forgotten approval, changed settings, missing backup and repeated approval', () => {
  p.validateProof(proof());
  for (const change of [v => v.approvalObserved = false, v => v.controlsEnabledAfterReopen = false,
    v => v.markerUnchanged = false, v => v.legacyAfter = 'c'.repeat(64), v => v.currentBefore = v.legacyBefore,
    v => v.backups.pop(), v => v.decisions.push(true), v => v.noRepeatedApproval = false]) {
    const bad = proof(); change(bad); assert.throws(() => p.validateProof(bad));
  }
});
test('native review uses real UI approval and never injects localStorage consent or saves options', () => {
  const source = require('node:fs').readFileSync(__filename.replace('.test.cjs', '.cjs'), 'utf8');
  assert.match(source, /settings\.dialogCommand/);
  assert.match(source, /settings\.loadMcpConfig/);
  assert.match(source, /localStorage\.getItem/);
  assert.doesNotMatch(source, /localStorage\.setItem|taskkill|save_config|writeFileSync\(f\.(current|legacy)/);
});
test('reused dialog selector binds exact PID, body, button and guarded command', () => {
  const fs = require('node:fs');
  const local = path.join(__dirname, 'native-windows-016-settings-only.cjs');
  const settings = require(fs.existsSync(local) ? local : path.join(__dirname,
    'incoming-ci-r12-fresh/selector/source/scripts/native-windows-016-settings-only.cjs'));
  const f = { current: 'C:\\fixture\\current.json', legacy: 'C:\\fixture\\legacy.json' };
  const row = { class: '#32770', title: 'Preserve MCP product settings', handle: 7, controls: [
    { id: 'ContentText', processId: 99, name: settings.confirmation('preserve', f) },
    { id: 'CommandButton_1000', processId: 99, name: 'Keep backups' },
    { id: 'CommandButton_1001', processId: 99, name: 'Keep unchanged' }] };
  for (const approve of [false, true]) {
    const selected = settings.selectDialog([row], 99, 'preserve', approve, f);
    assert.equal(selected.name, approve ? 'Keep backups' : 'Keep unchanged');
    const command = settings.dialogCommand(99, 'C:\\fixture\\creator-hub.exe', selected, 'preserve', approve, f);
    assert.ok(command.includes('$expectedExecutable=')); assert.ok(command.includes('$expectedContent='));
    assert.ok(command.includes('$dialogHandle=7;')); assert.ok(command.includes('$targetPid=99;'));
  }
  assert.throws(() => settings.selectDialog([row], 98, 'preserve', true, f));
  assert.throws(() => settings.selectDialog([row, row], 99, 'preserve', true, f));
  const changed = structuredClone(row); changed.controls[0].name += ' changed';
  assert.throws(() => settings.selectDialog([changed], 99, 'preserve', true, f));
});
