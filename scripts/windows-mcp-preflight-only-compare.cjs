'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const KIND = 'disposable-preflight-only-environment-comparison';
const SAMPLE_ENV = new Set(['systemroot', 'windir', 'systemdrive', 'comspec', 'userprofile', 'appdata', 'localappdata',
  'homedrive', 'homepath', 'username', 'userdomain', 'programfiles', 'programfiles(x86)', 'programw6432',
  'processor_architecture', 'number_of_processors', 'temp', 'tmp', 'path', 'psmodulepath']);
const LIMIT = 16384;
function admit(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32');
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
    GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch', CREATOR_PREFLIGHT_ONLY: '1', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_REF: 'refs/heads/validation/windows-menu-merge-20261027',
    GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-outgoing-017.yml@refs/heads/validation/windows-menu-merge-20261027' })) assert.equal(env[key], value, key);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/); assert.equal(env.GITHUB_SHA, env.CREATOR_PREFLIGHT_SOURCE);
  assert.match(env.GITHUB_RUN_ID || '', /^[1-9][0-9]*$/);
  for (const name of Object.keys(env)) if (/^(?:NODE_OPTIONS|NODE_PATH)$/i.test(name))
    assert.equal(env[name], '', 'Node launch overrides refused');
  for (const key of ['GITHUB_WORKSPACE', 'RUNNER_TEMP', 'LOCALAPPDATA', 'SystemRoot']) assert.ok(path.isAbsolute(env[key] || ''), key);
}
function preflightLibrary() {
  return require(path.join(__dirname, 'native-installed-baseline.cjs'));
}
function cleanEnvironment(env) {
  const clean = {}, seen = new Set();
  for (const key of Object.keys(env)) {
    const name = key.toLowerCase();
    if (!SAMPLE_ENV.has(name)) continue;
    assert.ok(!seen.has(name), 'Duplicate Windows environment variable refused');
    seen.add(name); clean[key] = env[key];
  }
  return clean;
}
function comparisonEnvironment(clean, systemRoot) {
  const result = { ...clean };
  for (const key of Object.keys(result)) if (/^(?:PATH|PSModulePath)$/i.test(key)) delete result[key];
  const system = path.win32.join(systemRoot, 'System32');
  result.PATH = [system, systemRoot, path.win32.join(system, 'WindowsPowerShell/v1.0')].join(';');
  result.PSModulePath = path.win32.join(system, 'WindowsPowerShell/v1.0/Modules');
  return result;
}
function peMachine(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length >= 64 && bytes.toString('ascii', 0, 2) === 'MZ');
  const offset = bytes.readUInt32LE(0x3c);
  assert.ok(offset <= bytes.length - 6 && bytes.toString('binary', offset, offset + 4) === 'PE\0\0');
  return bytes.readUInt16LE(offset + 4);
}
function summarize(result, elapsedMs) {
  const out = Buffer.isBuffer(result.stdout) ? result.stdout.subarray(0, LIMIT) : Buffer.alloc(0);
  const err = Buffer.isBuffer(result.stderr) ? result.stderr.subarray(0, LIMIT) : Buffer.alloc(0);
  const overflow = (result.stdout?.length || 0) > LIMIT || (result.stderr?.length || 0) > LIMIT || result.error?.code === 'ENOBUFS';
  const completed = !result.error && Number.isSafeInteger(result.status) && result.signal == null;
  const classification = !completed ? 'not-observed' : overflow ? 'truncated-output' : preflightLibrary().parseProbeOutput(out, 'preflight').classification;
  return { elapsedMs, completed, withinInstallerDeadline: completed ? elapsedMs <= 15000 : null,
    preflightSucceeded: completed ? result.status === 0 : null,
    status: Number.isSafeInteger(result.status) ? result.status : null,
    signal: result.signal === 'SIGTERM' ? 'SIGTERM' : result.signal == null ? null : 'other',
    error: result.error?.code === 'ETIMEDOUT' ? 'ETIMEDOUT' : result.error ? 'other' : null,
    classification, stdoutBytesObserved: out.length, stderrBytesObserved: err.length,
    outputTruncatedOrOverflow: overflow };
}
function comparisonOutcome(results) {
  const rows = [results.curatedHarnessPaths, results.acceptedSystemPaths];
  const recordingComplete = rows.every(row => row.completed === true && row.outputTruncatedOrOverflow === false);
  return { recordingComplete, allPreflightsSucceeded: recordingComplete ? rows.every(row => row.preflightSucceeded === true) : null };
}
function runComparison({ shell, script, installDir, clean, accepted, run = spawnSync, now = () => Number(process.hrtime.bigint() / 1000000n) }) {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', script, '-InstallDir', `${installDir}\\.`];
  const results = {};
  for (const [name, env] of [['curatedHarnessPaths', clean], ['acceptedSystemPaths', accepted]]) {
    const start = now();
    const result = run(shell, args, { env, windowsHide: true, timeout: 30000, maxBuffer: LIMIT, encoding: 'buffer' });
    results[name] = summarize(result, Math.max(0, now() - start));
  }
  return results;
}
function main(env = process.env) {
  admit(env);
  assert.equal(fs.realpathSync(process.cwd()).toLowerCase(), fs.realpathSync(env.GITHUB_WORKSPACE).toLowerCase());
  const tempRoot = fs.realpathSync(env.RUNNER_TEMP), local = fs.realpathSync(env.LOCALAPPDATA);
  const installDir = path.join(local, 'Creator Works MCP');
  assert.equal(fs.existsSync(installDir), false, 'Fresh disposable MCP namespace required');
  const shell = path.join(env.SystemRoot, 'SysWOW64/WindowsPowerShell/v1.0/powershell.exe');
  assert.ok(fs.statSync(shell).size <= 32 * 1024 * 1024);
  const shellBytes = fs.readFileSync(shell);
  assert.equal(peMachine(shellBytes), 0x14c, '32-bit PowerShell required');
  const { PREFLIGHT, pinnedPreflight } = preflightLibrary();
  const retainedPath = path.resolve(__dirname, '..', PREFLIGHT.retainedPath), retainedStat = fs.lstatSync(retainedPath);
  assert.ok(retainedStat.isFile() && !retainedStat.isSymbolicLink() && retainedStat.size <= 65536);
  const retained = fs.readFileSync(retainedPath);
  const pinned = pinnedPreflight(retained);
  const scratch = fs.mkdtempSync(path.join(tempRoot, 'creator-preflight-only-'));
  const script = path.join(scratch, 'pinned-preflight.ps1');
  let results, cleanupVerified = false;
  try {
    fs.writeFileSync(script, pinned.bytes, { flag: 'wx' });
    const clean = cleanEnvironment(env), accepted = comparisonEnvironment(clean, env.SystemRoot);
    results = runComparison({ shell, script, installDir, clean, accepted });
  } finally {
    if (fs.existsSync(script)) fs.unlinkSync(script);
    fs.rmdirSync(scratch); cleanupVerified = true;
  }
  const output = path.join(env.GITHUB_WORKSPACE, 'artifacts', 'preflight-only-comparison.json');
  const receipt = { kind: KIND, source: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID,
    scriptSha256: PREFLIGHT.sha256, shellSha256: crypto.createHash('sha256').update(shellBytes).digest('hex'), shellBits: 32,
    scope: 'preflight-only-no-installer', sampleEnvironment: 'curated-windows-allowlist-not-exact-installer-environment',
    sameAsOriginalRunner: false, originalNsExecResultCaptured: false,
    pathsOnlyDiffer: true, executionOrder: ['curatedHarnessPaths', 'acceptedSystemPaths'], timingComparisonProvesCause: false,
    installDirectoryAbsentBefore: true, installerExecuted: false, guardChanged: false, probeTimeoutMs: 30000,
    processValuesExported: false, outputContainsRawText: false, cleanupVerified, ...comparisonOutcome(results), results, releaseReady: false };
  fs.writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  return receipt;
}
module.exports = { KIND, SAMPLE_ENV, LIMIT, admit, cleanEnvironment, comparisonEnvironment, peMachine, summarize, comparisonOutcome, runComparison, main };
if (require.main === module) {
  try { const receipt = main(); console.log(JSON.stringify(receipt)); if (!receipt.recordingComplete) process.exitCode = 1; }
  catch (error) { console.error('Preflight-only comparison refused or failed.'); process.exitCode = 1; }
}
