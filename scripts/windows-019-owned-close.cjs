'use strict';
// Close-only diagnostic. No migration continuation or acceptance authority is provided.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function admit(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32');
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
    RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'incoming-migration',
    GITHUB_REF: 'refs/heads/validation/windows-019-production',
    GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-019-production.yml@refs/heads/validation/windows-019-production',
    CREATOR_PRODUCTION_019_MIGRATION: '1', GITHUB_RUN_ATTEMPT: '1' })) assert.equal(env[key], value, key);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/); assert.equal(env.GITHUB_SHA, env.CREATOR_PRODUCTION_019_SOURCE);
  assert.ok(path.win32.isAbsolute(env.LOCALAPPDATA || '') && path.win32.isAbsolute(env.SystemRoot || ''));
}
function expectedImage(env) { return path.win32.join(env.LOCALAPPDATA, 'Creator Hub', 'creator-hub.exe'); }
function checkRecord(record, expected) {
  assert.ok(record && typeof record === 'object' && !Array.isArray(record));
  assert.ok(Number.isInteger(record.pid) && record.pid > 0 && record.pid <= 2147483647);
  assert.match(record.startTicks, /^[1-9][0-9]{0,18}$/); assert.equal(record.kernelIdentityVerified, true);
  assert.ok(typeof record.image === 'string' && path.win32.isAbsolute(record.image));
  assert.equal(path.win32.normalize(record.image).toLowerCase(), path.win32.normalize(expected).toLowerCase());
}
function evaluateClose(result, record, expected) {
  checkRecord(record, expected);
  const refusal = () => ({ kind: 'incoming-migration-owned-close-only', state: 'unknown',
    migrationContinuationAvailable: false, releaseReady: false });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout) || result.stdout.length > 4096) return refusal();
  let value;
  try { value = JSON.parse(result.stdout.toString('utf8').replace(/^\uFEFF/, '')); } catch { return refusal(); }
  if (value.kind !== 'incoming-migration-owned-close-only' || value.state !== 'verified' || value.pid !== record.pid ||
      value.startTicks !== record.startTicks || typeof value.executable !== 'string' ||
      path.win32.normalize(value.executable).toLowerCase() !== path.win32.normalize(expected).toLowerCase() ||
      value.exitCode !== 0 || value.migrationContinuationAvailable !== false || value.releaseReady !== false) return refusal();
  return { kind: value.kind, state: 'verified', pid: record.pid, startTicks: record.startTicks, executable: expected,
    exitCode: 0, migrationContinuationAvailable: false, releaseReady: false };
}
function closeOwned(record, env = process.env) {
  admit(env); const expected = expectedImage(env); checkRecord(record, expected);
  const shell = path.win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = path.join(__dirname, 'native-incoming-migration-owned-close-019.ps1');
  const allowed = new Set(['systemroot', 'windir', 'systemdrive', 'temp', 'tmp', 'localappdata', 'userprofile',
    'github_actions', 'runner_environment', 'runner_os', 'runner_arch', 'github_repository', 'github_repository_id',
    'github_event_name', 'github_job', 'github_ref', 'github_workflow_ref', 'github_run_attempt', 'github_sha',
    'creator_production_019_migration', 'creator_production_019_source']);
  const clean = {};
  for (const key of Object.keys(env)) if (allowed.has(key.toLowerCase())) clean[key] = env[key];
  const system = path.win32.join(env.SystemRoot, 'System32');
  clean.PATH = [system, env.SystemRoot, path.win32.join(system, 'WindowsPowerShell/v1.0')].join(';');
  clean.PSModulePath = path.win32.join(system, 'WindowsPowerShell/v1.0/Modules');
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-TargetPid', String(record.pid), '-StartTicks', record.startTicks, '-ExpectedExecutable', expected],
  { env: clean, windowsHide: true, timeout: 45000, maxBuffer: 4096, encoding: 'buffer' });
  const receipt = evaluateClose(result, record, expected);
  if (receipt.state !== 'verified') throw Object.assign(Error('Owned close was not verified; migration remains unavailable.'), { receipt });
  return receipt;
}
module.exports = { admit, expectedImage, checkRecord, evaluateClose, closeOwned };
