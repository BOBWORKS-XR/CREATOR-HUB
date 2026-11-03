'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const candidate = require('./windows-incoming-016.cjs');
const public12 = require('./windows-public12-r2-lab.cjs');

function utcTickLowerBound(milliseconds) {
  assert.ok(Number.isSafeInteger(milliseconds) && milliseconds > 0);
  return (621355968000000000n + BigInt(milliseconds) * 10000n).toString();
}
function matchingHubs(rows) {
  assert.ok(Array.isArray(rows));
  return rows.filter(row => typeof row.image === 'string' && path.win32.basename(row.image).toLowerCase() === 'creator-hub.exe');
}
function captureBaseline({ pid, parentPid, hub, inventory, imageHash, checkRecord }) {
  assert.equal(imageHash(), public12.BASELINE.exe, 'Installed public12 image differs');
  const hubs = matchingHubs(inventory()); assert.equal(hubs.length, 1, 'Expected only the owned baseline Hub');
  assert.equal(hubs[0].pid, pid); assert.equal(hubs[0].parentPid, parentPid);
  checkRecord(hubs[0], hub); return hubs[0];
}
function observeRestart({ baseline, approvalLowerBoundTicks, restarted, hub, inventory, imageHash, checkRecord }) {
  checkRecord(baseline, hub); checkRecord(restarted, hub);
  assert.match(approvalLowerBoundTicks || '', /^[1-9][0-9]{0,18}$/);
  assert.ok(BigInt(baseline.startTicks) < BigInt(approvalLowerBoundTicks), 'Baseline must predate approval attempt');
  assert.ok(BigInt(restarted.startTicks) > BigInt(approvalLowerBoundTicks), 'Restart must postdate approval attempt');
  assert.notEqual(restarted.pid, baseline.pid);
  const hubs = matchingHubs(inventory()); assert.equal(hubs.length, 1, 'Expected exactly one observed restarted Hub');
  assert.deepEqual(hubs[0], restarted, 'Restarted Hub identity changed');
  assert.equal(imageHash(), candidate.TARGET.exe, 'Restarted R2 image differs');
  return { kind: 'observed-signed-update-restart', baselinePid: baseline.pid, baselineStartTicks: baseline.startTicks,
    restartedPid: restarted.pid, restartedStartTicks: restarted.startTicks, approvalLowerBoundTicks,
    baselineImageSha256: public12.BASELINE.exe, restartedImageSha256: candidate.TARGET.exe,
    singletonAtCheckpoints: true, harnessAdditionalLaunch: false, ancestryProven: false, securityAttestation: false };
}
function validateObservation(observation, update, close) {
  assert.deepEqual(Object.keys(observation).sort(), ['kind', 'baselinePid', 'baselineStartTicks', 'restartedPid', 'restartedStartTicks',
    'approvalLowerBoundTicks', 'baselineImageSha256', 'restartedImageSha256', 'singletonAtCheckpoints', 'harnessAdditionalLaunch',
    'ancestryProven', 'securityAttestation'].sort());
  assert.equal(observation.kind, 'observed-signed-update-restart');
  assert.ok(Number.isSafeInteger(observation.baselinePid) && observation.baselinePid > 0);
  assert.ok(Number.isSafeInteger(observation.restartedPid) && observation.restartedPid > 0);
  assert.equal(observation.baselinePid, update.originalPid); assert.equal(observation.restartedPid, update.restartedPid);
  assert.notEqual(observation.baselinePid, observation.restartedPid); assert.equal(close.pid, observation.restartedPid);
  for (const key of ['baselineStartTicks', 'restartedStartTicks', 'approvalLowerBoundTicks']) assert.match(observation[key] || '', /^[1-9][0-9]{0,18}$/);
  assert.ok(BigInt(observation.baselineStartTicks) < BigInt(observation.approvalLowerBoundTicks));
  assert.ok(BigInt(observation.restartedStartTicks) > BigInt(observation.approvalLowerBoundTicks));
  assert.equal(close.startTicks, observation.restartedStartTicks);
  assert.equal(observation.baselineImageSha256, public12.BASELINE.exe); assert.equal(observation.restartedImageSha256, candidate.TARGET.exe);
  assert.equal(observation.singletonAtCheckpoints, true); assert.equal(observation.harnessAdditionalLaunch, false);
  assert.equal(observation.ancestryProven, false); assert.equal(observation.securityAttestation, false);
}

function captureRestarted({ pid, hub, inventory, imageHash, checkRecord }) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  assert.equal(imageHash(), candidate.TARGET.exe, 'Restarted R2 image differs');
  const rows = inventory().filter(row => row.pid === pid); assert.equal(rows.length, 1);
  checkRecord(rows[0], hub); return rows[0];
}
function closeRestarted({ record, hub, inventory, imageHash, checkRecord, closeOwned }) {
  checkRecord(record, hub);
  const current = captureRestarted({ pid: record.pid, hub, inventory, imageHash, checkRecord });
  assert.deepEqual(current, record, 'Restarted R2 process identity changed');
  const result = closeOwned(record);
  assert.equal(result.kind, 'incoming-migration-owned-close-only'); assert.equal(result.state, 'verified');
  assert.equal(result.pid, record.pid); assert.equal(result.startTicks, record.startTicks);
  assert.equal(path.win32.normalize(result.executable).toLowerCase(), path.win32.normalize(hub).toLowerCase());
  assert.equal(result.exitCode, 0); assert.equal(result.migrationContinuationAvailable, false); assert.equal(result.releaseReady, false);
  return result;
}
function cleanupObservedRestart({ record, attempted, close }) {
  if (!record) return { state: 'unverified' };
  if (attempted) return { state: 'already-attempted' };
  return { state: 'verified', receipt: close() };
}
module.exports = { utcTickLowerBound, captureBaseline, observeRestart, validateObservation, captureRestarted, closeRestarted, cleanupObservedRestart };
