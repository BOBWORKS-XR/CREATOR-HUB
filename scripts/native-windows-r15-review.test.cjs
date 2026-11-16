'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const p = require('./native-windows-r15-review.cjs');
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
    markerUnchanged: true, noRepeatedApproval: true, runtimeRepairApproved: true, runtimeRepairCancelled: true,
    onlyServerChanged: true, oldServerAbsent: true, initialRouteUnbound: true, repairVisibleBeforeBinding: true, renewedReview: true, managedRouteUnchanged: true, decisions: [false, true, true], statusBefore: 'conflict', statusAfter: 'conflict',
    currentBefore: 'a'.repeat(64), currentAfter: 'd'.repeat(64), legacyBefore: 'b'.repeat(64), legacyAfter: 'b'.repeat(64),
    markerSha256: 'c'.repeat(64), initialBackupRetained: { file: 'old', sha256: 'a'.repeat(64) },
    clientAfterRepair: { serverVersion: '2.7.10', readOnlyCallPassed: true, settingsUnchanged: true, processesExited: true, routerPid: 10, runtimePid: 11 },
    clientAfterReopen: { serverVersion: '2.7.10', readOnlyCallPassed: true, settingsUnchanged: true, processesExited: true, routerPid: 20, runtimePid: 21 },
    backups: [{ file: 'current', sha256: 'd'.repeat(64) }, { file: 'legacy', sha256: 'b'.repeat(64) }] };
}
test('receipt refuses forgotten approval, changed settings, missing backup and repeated approval', () => {
  p.validateProof(proof());
  for (const change of [v => v.approvalObserved = false, v => v.controlsEnabledAfterReopen = false,
    v => v.markerUnchanged = false, v => v.legacyAfter = 'c'.repeat(64), v => v.currentBefore = v.legacyBefore,
    v => v.backups.pop(), v => v.decisions.push(true), v => v.noRepeatedApproval = false, v => v.onlyServerChanged = false, v => v.runtimeRepairApproved = false,
    v => v.managedRouteUnchanged = false, v => v.initialBackupRetained.sha256 = 'b'.repeat(64),
    v => delete v.clientAfterRepair, v => v.clientAfterReopen.routerPid = v.clientAfterRepair.routerPid,
    v => v.clientAfterReopen.settingsUnchanged = false]) {
    const bad = proof(); change(bad); assert.throws(() => p.validateProof(bad));
  }
});
test('native review uses real UI repair and never injects localStorage consent or rewrites fixture stores', () => {
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
test('cancel wait accepts signed R13 wording only after the native workflow returns', () => {
  const fs = require('node:fs');
  const local = path.join(__dirname, 'native-windows-016-settings-only.cjs');
  const settings = require(fs.existsSync(local) ? local : path.join(__dirname,
    'incoming-ci-r13b/cancel-fix/source/scripts/native-windows-016-settings-only.cjs'));
  const document = (busy, text) => ({ querySelector: () => ({
    getAttribute: () => busy,
    querySelector: () => ({ textContent: text }),
  }) });
  assert.equal(settings.reviewSettled(true, document('false', 'Review stopped. Earlier completed changes may remain.')), true);
  assert.equal(settings.reviewSettled(true, document('true', 'Review stopped. Earlier completed changes may remain.')), false);
  for (const text of ['Ready', 'Your saved setup is ready.', 'Settings retained without explicit approval'])
    assert.equal(settings.reviewSettled(true, document('false', text)), false);
});

test('runtime repair permits only the current server key, retaining nested names and array ordering', () => {
  const before = { mcp_server_path: 'old', channels: [{ id: 'a' }], unknown: { mcp_server_path: 'nested' } };
  const after = { ...before, mcp_server_path: 'new' };
  assert.deepEqual(p.exceptServer(before), p.exceptServer(after));
  assert.notDeepEqual(p.exceptServer(before), p.exceptServer({ ...after, unknown: { mcp_server_path: 'changed' } }));
});


test('unbound repair is exercised before any route activation, without hidden detail actions', () => {
  const source = require('node:fs').readFileSync(__filename.replace('.test.cjs', '.cjs'), 'utf8');
  const session = source.slice(source.indexOf('    async session('));
  assert.ok(session.indexOf('runtime.managedRouting, false') < session.indexOf('await bindForReadOnlyClient(page)'));
  assert.ok(session.indexOf("Use Hub runtime', exact: true }).click()") < session.indexOf('await bindForReadOnlyClient(page)'));
  assert.doesNotMatch(session, /data-field="product-check"/);
});

