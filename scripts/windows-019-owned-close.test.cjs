require('./fixtures/windows-019-test-fixture.cjs').install();
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const helper = require('./windows-019-owned-close.cjs');
const sha = 'a'.repeat(40);
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_JOB: 'incoming-migration', GITHUB_REF: 'refs/heads/validation/windows-019-production',
  GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-019-production.yml@refs/heads/validation/windows-019-production',
  CREATOR_PRODUCTION_019_MIGRATION: '1', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: sha, CREATOR_PRODUCTION_019_SOURCE: sha,
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
test('PowerShell close guard pins the authoritative raw019 executable, not a historical fork', () => {
  const contract = require('./windows-019-contract.cjs');
  // Read disk explicitly: the other tests install synthetic pins in require.cache.
  const binding = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/windows-019-binding.json'), 'utf8'));
  contract.validateRaw(binding);
  const source = fs.readFileSync(path.join(__dirname, 'native-incoming-migration-owned-close-019.ps1'), 'utf8');
  const check = text => {
    const matches = [...text.matchAll(/\(Get-FileHash -LiteralPath \$expected -Algorithm SHA256\)\.Hash\.ToLowerInvariant\(\) -cne '([a-f0-9]{64})'/g)];
    assert.equal(matches.length, 1, 'One exact executable hash guard is required');
    assert.equal(matches[0][1], binding.executable.sha256, 'PowerShell executable pin differs from the validated raw019 binding');
  };
  check(source);
  assert.throws(() => check(source.replace(binding.executable.sha256, 'ae1d15ff3919ee9947e21d8542bcab50abf044e1bf047ce2c87abac4ccebfdc9')));
  assert.throws(() => check(source.replace(binding.executable.sha256, '')));
  assert.throws(() => check(source + source));
  assert.ok(source.includes("throw 'R2 executable differs.'"));
  assert.doesNotMatch(source, /R8 executable differs/);
});
test('native helper holds identity handle, requests one normal close, waits and never kills', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-incoming-migration-owned-close-019.ps1'), 'utf8');
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
