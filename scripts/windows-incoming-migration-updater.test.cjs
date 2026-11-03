'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const updater = require('./windows-incoming-migration-updater.cjs');
const close = require('./windows-incoming-migration-owned-close.cjs');
const candidate = require('./windows-incoming-016.cjs');
const direct = require('./native-self-update-direct.cjs');
const public12 = require('./windows-public12-r2-lab.cjs');

const hub = 'C:\\runner\\Creator Hub\\creator-hub.exe';
const record = () => ({ pid: 42, startTicks: '123456', image: hub, parentPid: 7, kernelIdentityVerified: true });
const receipt = () => ({ kind: 'incoming-migration-owned-close-only', state: 'verified', pid: 42, startTicks: '123456',
  executable: hub, exitCode: 0, migrationContinuationAvailable: false, releaseReady: false });
function input() { return { pid: 42, hub, inventory: () => [record()], imageHash: () => candidate.TARGET.exe, checkRecord: close.checkRecord }; }

test('capture binds exact R2 image and kernel process record', () => {
  assert.deepEqual(updater.captureRestarted(input()), record());
  assert.throws(() => updater.captureRestarted({ ...input(), imageHash: () => 'changed' }));
  assert.throws(() => updater.captureRestarted({ ...input(), inventory: () => [] }));
  assert.throws(() => updater.captureRestarted({ ...input(), inventory: () => [record(), record()] }));
  assert.throws(() => updater.captureRestarted({ ...input(), inventory: () => [{ ...record(), kernelIdentityVerified: false }] }));
  assert.throws(() => updater.captureRestarted({ ...input(), inventory: () => [{ ...record(), image: 'C:\\other.exe' }] }));
});
test('CI restart observation requires singleton checkpoints, exact images and post-approval start', () => {
  const baseline = { ...record(), pid: 10, parentPid: 7, startTicks: '100' }, restarted = { ...record(), pid: 42, startTicks: '300' };
  const original = { pid: 10, parentPid: 7, hub, inventory: () => [baseline], imageHash: () => public12.BASELINE.exe, checkRecord: close.checkRecord };
  assert.deepEqual(updater.captureBaseline(original), baseline);
  assert.throws(() => updater.captureBaseline({ ...original, inventory: () => [baseline, { ...baseline, pid: 11 }] }));
  assert.throws(() => updater.captureBaseline({ ...original, parentPid: 8 }));
  assert.throws(() => updater.captureBaseline({ ...original, imageHash: () => 'wrong' }));
  const args = { baseline, approvalLowerBoundTicks: '200', restarted, hub, inventory: () => [restarted],
    imageHash: () => candidate.TARGET.exe, checkRecord: close.checkRecord };
  const observed = updater.observeRestart(args);
  assert.equal(observed.ancestryProven, false); assert.equal(observed.securityAttestation, false); assert.equal(observed.singletonAtCheckpoints, true);
  assert.throws(() => updater.observeRestart({ ...args, approvalLowerBoundTicks: '300' }));
  assert.throws(() => updater.observeRestart({ ...args, restarted: { ...restarted, pid: baseline.pid } }));
  assert.throws(() => updater.observeRestart({ ...args, inventory: () => [restarted, { ...restarted, pid: 43 }] }));
  assert.throws(() => updater.observeRestart({ ...args, inventory: () => [{ ...restarted, startTicks: '301' }] }));
  assert.throws(() => updater.observeRestart({ ...args, imageHash: () => 'wrong' }));
  const update = { originalPid: 10, restartedPid: 42 }, closeReceipt = { pid: 42, startTicks: '300' };
  updater.validateObservation(observed, update, closeReceipt);
  for (const change of [{ ancestryProven: true }, { securityAttestation: true }, { singletonAtCheckpoints: false },
    { harnessAdditionalLaunch: true }, { restartedStartTicks: '199' }, { approvalLowerBoundTicks: '0' }, { extra: true }]) {
    assert.throws(() => updater.validateObservation({ ...observed, ...change }, update, closeReceipt));
  }
  assert.equal(updater.utcTickLowerBound(1), '621355968000010000');
});
test('normal close runs once only for the same captured process and returns a verified receipt', () => {
  let calls = 0;
  const args = { ...input(), record: record(), closeOwned(value) { calls++; assert.deepEqual(value, record()); return receipt(); } };
  assert.deepEqual(updater.closeRestarted(args), receipt()); assert.equal(calls, 1);
  assert.throws(() => updater.closeRestarted({ ...args, inventory: () => [{ ...record(), startTicks: '999' }] }));
  assert.equal(calls, 1);
  assert.throws(() => updater.closeRestarted({ ...args, imageHash: () => 'changed' })); assert.equal(calls, 1);
  for (const bad of [{ state: 'unknown' }, { pid: 44 }, { startTicks: '999' }, { exitCode: 1 },
    { executable: 'C:\\other.exe' }, { releaseReady: true }, { migrationContinuationAvailable: true }]) {
    assert.throws(() => updater.closeRestarted({ ...args, closeOwned: () => ({ ...receipt(), ...bad }) }));
  }
});
test('normal close timeout or refusal propagates without a second close attempt', () => {
  for (const error of [Object.assign(Error('timeout'), { code: 'ETIMEDOUT' }), Error('owned close refused')]) {
    let calls = 0;
    assert.throws(() => updater.closeRestarted({ ...input(), record: record(), closeOwned() { calls++; throw error; } }), value => value === error);
    assert.equal(calls, 1);
  }
});
test('failed restart observation never authorizes cleanup close', () => {
  let authorized, closes = 0;
  const baseline = { ...record(), pid: 10, startTicks: '100' }, restarted = { ...record(), startTicks: '199' };
  try {
    const observed = updater.observeRestart({ baseline, approvalLowerBoundTicks: '200', restarted, hub,
      inventory: () => [restarted], imageHash: () => candidate.TARGET.exe, checkRecord: close.checkRecord });
    authorized = observed && restarted;
  } catch {}
  assert.deepEqual(updater.cleanupObservedRestart({ record: authorized, attempted: false, close: () => { closes++; } }), { state: 'unverified' });
  assert.equal(closes, 0);
  assert.deepEqual(updater.cleanupObservedRestart({ record: restarted, attempted: true, close: () => { closes++; } }), { state: 'already-attempted' });
  assert.equal(closes, 0);
  const source = fs.readFileSync(path.join(__dirname, 'native-self-update-smoke.cjs'), 'utf8');
  const observe = source.indexOf('const observation = updater.observeRestart(');
  const authorize = source.indexOf('restartedRecord = captured; report.observedRestart = observation;', observe);
  assert.ok(observe > 0 && authorize > observe);
  assert.match(source, /cleanupObservedRestart\(\{ record: restartedRecord, attempted: restartedCloseAttempted, close: closeRestartedOnce \}\)/);
});
test('preinstalled hook is scoped before inputs and standard install is unchanged', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-self-update-smoke.cjs'), 'utf8');
  assert.ok(source.indexOf("require('./windows-incoming-migration-owned-snapshot.cjs').admit()") < source.indexOf("require('node:fs')"));
  assert.match(source, /owned\.checkPreinstalledFixture\(\{ env: process\.env, out: fixtureRoot, recorded \}\)/);
  assert.match(source, /if \(!incomingPreinstalled\) \{\s*const setup = spawn\(installer, \['\/S', '\/NS'\]/);
  assert.match(source, /assert\.equal\(fs\.existsSync\(hub\), false, 'Expected a fresh runner without Hub installed'\)/);
  assert.match(source, /preinstalledFixture\.owned\.checkFixtureBytes/);
  assert.match(source, /assert\.equal\(restartedCloseAttempted, false/);
  assert.match(source, /report\.closeError = 'Restarted Hub close not verified\.'/);
  const capture = source.indexOf('baselineRecord = updater.captureBaseline(');
  const timestamp = source.indexOf('approvalLowerBoundTicks = require(');
  const approval = source.indexOf("native(child.pid, 'button', 'Update Hub')");
  assert.ok(capture > 0 && capture < timestamp && timestamp < approval);
  assert.match(source, /if \(incomingPreinstalled\) \{\s*approvalLowerBoundTicks[\s\S]*?native\(child\.pid, 'button', 'Update Hub'\)/);
  assert.equal((source.match(/spawn\(hub,/g) || []).length, 1);
  const services = source.slice(source.indexOf('async function checkUpdatedBuiltIns()'), source.indexOf('const sdk = require(', source.indexOf('async function checkUpdatedBuiltIns()')));
  assert.ok(services.indexOf('if (incomingPreinstalled) {') < services.indexOf('direct.prepareManagedRoute'));
  assert.match(services, /managedRouteReconnectTested = false/);
});
test('fixture deferral performs one visible click and checks exact fixture before and after', async () => {
  const calls = [], page = { locator(selector) { return { waitFor: async options => calls.push([selector, options.state]),
    click: async () => calls.push([selector, 'click']) }; } };
  const verifyFixture = () => calls.push('verify');
  await direct.deferFixtureMigration({ page, verifyFixture, readStatus: async () => ({ stage: 'review', required: true, backups: [] }) });
  assert.deepEqual(calls, [['#convergence-dialog', 'visible'], 'verify', ['#convergence-later', 'click'],
    ['#convergence-dialog', 'hidden'], ['#convergence-reopen', 'visible'], 'verify']);
  calls.length = 0;
  await assert.rejects(direct.deferFixtureMigration({ page, verifyFixture, readStatus: async () => ({ stage: 'complete', required: false, backups: [] }) }));
  assert.equal(calls.some(value => Array.isArray(value) && value[1] === 'click'), false);
  calls.length = 0; let checks = 0;
  await assert.rejects(direct.deferFixtureMigration({ page, readStatus: async () => ({ stage: 'review', required: true, backups: [] }),
    verifyFixture() { if (++checks === 2) throw Error('fixture changed'); } }), /fixture changed/);
  assert.equal(calls.filter(value => Array.isArray(value) && value[1] === 'click').length, 1);
});
