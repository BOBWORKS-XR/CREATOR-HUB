'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const helper = require('./windows-017-owned-close.cjs');
const sha = 'a'.repeat(40);
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_JOB: 'incoming-migration', GITHUB_REF: 'refs/heads/validation/windows-menu-merge-20261027',
  GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-017-production.yml@refs/heads/validation/windows-menu-merge-20261027',
  CREATOR_PRODUCTION_017_MIGRATION: '1', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: sha, CREATOR_PRODUCTION_017_SOURCE: sha,
  LOCALAPPDATA: 'C:\\Users\\runneradmin\\AppData\\Local', SystemRoot: 'C:\\Windows' };
const image = helper.expectedImage(env);
const record = { pid: 42, startTicks: '638000000000000000', image, kernelIdentityVerified: true };
const receipt = { kind: 'incoming-migration-owned-close-only', state: 'verified', pid: record.pid, startTicks: record.startTicks,
  executable: image, exitCode: 0, migrationContinuationAvailable: false, releaseReady: false };
const result = value => ({ status: 0, stdout: Buffer.from(JSON.stringify(value)) });

test('close-only admission refuses local, other job and unreviewed source', () => {
  helper.admit(env, 'win32'); assert.throws(() => helper.admit(env, 'linux'));
  for (const key of Object.keys(env)) assert.throws(() => helper.admit({ ...env, [key]: '' }, 'win32'));
  assert.throws(() => helper.admit({ ...env, GITHUB_SHA: 'b'.repeat(40) }, 'win32'));
});
test('captured PID, start time, image and kernel identity are mandatory', () => {
  helper.checkRecord(record, image);
  for (const bad of [{ ...record, pid: 0 }, { ...record, startTicks: '0' }, { ...record, startTicks: 'not-ticks' },
    { ...record, image: 'C:\\other.exe' }, { ...record, kernelIdentityVerified: false }]) assert.throws(() => helper.checkRecord(bad, image));
});
test('only exact successful close-and-wait receipt is admitted', () => {
  assert.equal(helper.evaluateClose(result(receipt), record, image).state, 'verified');
  for (const bad of [{ ...receipt, state: 'unknown' }, { ...receipt, pid: 43 }, { ...receipt, startTicks: '638000000000000001' },
    { ...receipt, executable: 'C:\\other.exe' }, { ...receipt, exitCode: 1 }, { ...receipt, releaseReady: true },
    { ...receipt, migrationContinuationAvailable: true }]) assert.equal(helper.evaluateClose(result(bad), record, image).state, 'unknown');
  for (const failed of [{ status: 1, stdout: result(receipt).stdout }, { status: null, error: { code: 'ETIMEDOUT' } },
    { status: 0, stdout: Buffer.from('invalid') }, { status: 0, stdout: Buffer.alloc(4097) }]) {
    const refused = helper.evaluateClose(failed, record, image);
    assert.equal(refused.state, 'unknown'); assert.equal(refused.migrationContinuationAvailable, false); assert.equal(refused.releaseReady, false);
  }
});
test('native helper holds identity handle, requests one normal close, waits and never kills', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-incoming-migration-owned-close-017.ps1'), 'utf8');
  for (const text of ['$process.SafeHandle', '$StartTicks', 'QueryFullProcessImageName', '$windows.Count -ne 1',
    'GetWindowThreadProcessId', 'PostMessage', 'WaitForExit(30000)', "state='unknown'", 'migrationContinuationAvailable=$false']) assert.ok(source.includes(text), text);
  assert.doesNotMatch(source, /Stop-Process|\.Kill\(|taskkill/i);
  assert.ok(source.indexOf('$process.SafeHandle') < source.indexOf('::PostMessage('));
  assert.ok(source.indexOf('::PostMessage(') < source.indexOf('WaitForExit(30000)'));
  assert.doesNotMatch(source, /IsPathFullyQualified/);
  assert.match(source, /\$ExpectedExecutable -cnotmatch '\^\[A-Za-z\]:\\\\'/);
  assert.match(source, /\[IO\.Path\]::GetFullPath\(\$ExpectedExecutable\) -ine \$expected/);
  const driveAbsolute = /^[A-Za-z]:\\/;
  for (const valid of ['C:\\Users\\runner\\app.exe', 'd:\\app.exe']) assert.match(valid, driveAbsolute);
  for (const invalid of ['C:relative.exe', '\\\\server\\share\\app.exe', '\\rooted.exe', 'app.exe']) assert.doesNotMatch(invalid, driveAbsolute);
});
