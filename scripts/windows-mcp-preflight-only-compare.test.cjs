'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const compare = require('./windows-mcp-preflight-only-compare.cjs');
const { PREFLIGHT, pinnedPreflight } = require('./native-installed-baseline.cjs');
const sha = 'a'.repeat(40);
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: 'refs/heads/validation/windows-menu-merge-20261027',
  GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-outgoing-017.yml@refs/heads/validation/windows-menu-merge-20261027',
  CREATOR_PREFLIGHT_ONLY: '1', CREATOR_PREFLIGHT_SOURCE: sha, GITHUB_SHA: sha, GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '123',
  NODE_OPTIONS: '', NODE_PATH: '',
  GITHUB_WORKSPACE: path.resolve('.'), RUNNER_TEMP: path.resolve('temp'), LOCALAPPDATA: path.resolve('local'), SystemRoot: path.resolve('windows') };
test('admission rejects local, unreviewed and non-dispatch contexts', () => {
  compare.admit(env, 'win32');
  assert.throws(() => compare.admit(env, 'linux'));
  for (const key of Object.keys(env).filter(key => !['NODE_OPTIONS', 'NODE_PATH'].includes(key))) assert.throws(() => compare.admit({ ...env, [key]: '' }, 'win32'));
  assert.throws(() => compare.admit({ ...env, GITHUB_SHA: 'b'.repeat(40) }, 'win32'));
  assert.throws(() => compare.main({}));
});
test('excluded environment values are not read and parent Node launch overrides fail', () => {
  const input = new Proxy({ ...env, API_KEY: 'private-value', INNOCUOUS_NAME: 'private-value', GITHUB_TOKEN: 'private-value' }, {
    get(target, key) { if (['API_KEY', 'INNOCUOUS_NAME', 'GITHUB_TOKEN'].includes(key)) throw Error('excluded value was read'); return target[key]; },
  });
  compare.admit(input, 'win32');
  const sample = compare.cleanEnvironment(input);
  assert.equal(Object.hasOwn(sample, 'API_KEY'), false); assert.equal(Object.hasOwn(sample, 'INNOCUOUS_NAME'), false);
  assert.equal(Object.hasOwn(sample, 'GITHUB_TOKEN'), false);
  for (const key of ['NODE_OPTIONS', 'NODE_PATH']) assert.throws(() => compare.admit({ ...env, [key]: 'private-value' }, 'win32'));
  assert.throws(() => compare.cleanEnvironment({ PATH: 'a', Path: 'b' }), /Duplicate/);
});
test('retained original preflight has the independently pinned bytes', () => {
  const original = fs.readFileSync(path.resolve(__dirname, '..', PREFLIGHT.retainedPath));
  assert.equal(pinnedPreflight(original).bytes.length, 3329);
  assert.equal(PREFLIGHT.sha256, '42858c4e86296fcdf966b170e946063cdf91c59c9341e8fdb7783d96ec737000');
  assert.throws(() => pinnedPreflight(Buffer.from('modified')));
});
test('only PATH and PSModulePath change between filtered environments', () => {
  const clean = compare.cleanEnvironment({ PATH: 'original', psmodulepath: 'original-modules', SYSTEMROOT: 'C:\\Windows',
    GITHUB_TOKEN: 'secret', CREATOR_VALUE: 'secret', NODE_OPTIONS: 'secret', HTTP_PROXY: 'secret', TEMP: 'C:\\temp' });
  const accepted = compare.comparisonEnvironment(clean, 'C:\\Windows');
  assert.deepEqual(clean, { PATH: 'original', psmodulepath: 'original-modules', SYSTEMROOT: 'C:\\Windows', TEMP: 'C:\\temp' });
  assert.equal(accepted.PATH, 'C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\WindowsPowerShell\\v1.0');
  assert.equal(accepted.PSModulePath, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
  assert.deepEqual(Object.fromEntries(Object.entries(clean).filter(([k]) => !/^(?:PATH|PSModulePath)$/i.test(k))),
    Object.fromEntries(Object.entries(accepted).filter(([k]) => !/^(?:PATH|PSModulePath)$/i.test(k))));
  for (const sample of [clean, accepted]) for (const key of Object.keys(sample)) assert.ok(compare.SAMPLE_ENV.has(key.toLowerCase()));
  const source = fs.readFileSync(path.join(__dirname, 'windows-mcp-preflight-only-compare.cjs'), 'utf8');
  assert.match(source, /curated-windows-allowlist-not-exact-installer-environment/);
  assert.doesNotMatch(source, /same-filter-as-migration-current-runner-not-original|installerSanitized/);
});
test('comparison runs only the supplied script, classifies without raw output and measures deadline', () => {
  const calls = [], times = [100, 15101, 20000, 20500];
  const busy = 'The selected MCP launcher or private runtime is still running.';
  const result = compare.runComparison({ shell: 'x86-powershell', script: 'pinned.ps1', installDir: 'C:\\fixture', clean: { x: '1' }, accepted: { x: '2' },
    now: () => times.shift(), run: (shell, args, options) => {
      calls.push({ shell, args, options });
      return { status: calls.length === 1 ? 10 : 11, stdout: Buffer.from(calls.length === 1 ? busy : 'private secret'), stderr: Buffer.alloc(0), signal: null };
    } });
  assert.equal(calls.length, 2); assert.ok(calls.every(x => x.shell === 'x86-powershell' && x.args.includes('pinned.ps1') && x.options.timeout === 30000));
  assert.equal(result.curatedHarnessPaths.classification, 'selected-process-running');
  assert.equal(result.curatedHarnessPaths.withinInstallerDeadline, false);
  assert.equal(result.acceptedSystemPaths.classification, 'unrecognized-output');
  assert.doesNotMatch(JSON.stringify(result), /private|secret/);
  const timeout = compare.summarize({ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } }, 30000);
  assert.equal(timeout.error, 'ETIMEDOUT'); assert.equal(timeout.withinInstallerDeadline, null);
  assert.equal(timeout.completed, false); assert.equal(timeout.preflightSucceeded, null); assert.equal(timeout.classification, 'not-observed');
  const spawnFailure = compare.summarize({ status: null, signal: null, error: { code: 'ENOENT' } }, 1);
  assert.equal(spawnFailure.withinInstallerDeadline, null); assert.equal(spawnFailure.completed, false);
  assert.equal(spawnFailure.preflightSucceeded, null); assert.equal(spawnFailure.classification, 'not-observed');
  assert.deepEqual(compare.comparisonOutcome({ curatedHarnessPaths: spawnFailure, acceptedSystemPaths: result.acceptedSystemPaths }),
    { recordingComplete: false, allPreflightsSucceeded: null });
  assert.deepEqual(compare.comparisonOutcome(result), { recordingComplete: true, allPreflightsSucceeded: false });
  const overflow = compare.summarize({ status: null, stdout: Buffer.alloc(20000, 120), error: { code: 'ENOBUFS' } }, 100);
  assert.equal(overflow.outputTruncatedOrOverflow, true); assert.equal(overflow.classification, 'not-observed');
  const completedOverflow = compare.summarize({ status: 0, signal: null, stdout: Buffer.alloc(20000, 120) }, 100);
  assert.equal(completedOverflow.completed, true); assert.equal(completedOverflow.preflightSucceeded, true);
  assert.deepEqual(compare.comparisonOutcome({ curatedHarnessPaths: completedOverflow, acceptedSystemPaths: result.acceptedSystemPaths }),
    { recordingComplete: false, allPreflightsSucceeded: null });
});
test('only 32-bit PE machine is accepted by the hosted entry point', () => {
  const b = Buffer.alloc(128); b.write('MZ'); b.writeUInt32LE(64, 0x3c); b.write('PE\0\0', 64, 'binary'); b.writeUInt16LE(0x14c, 68);
  assert.equal(compare.peMachine(b), 0x14c); b.writeUInt16LE(0x8664, 68); assert.notEqual(compare.peMachine(b), 0x14c);
  assert.throws(() => compare.peMachine(Buffer.alloc(64)));
  const source = fs.readFileSync(path.join(__dirname, 'windows-mcp-preflight-only-compare.cjs'), 'utf8');
  assert.match(source, /assert\.equal\(peMachine\(shellBytes\), 0x14c/);
  assert.doesNotMatch(source, /execFileSync\(|installer\.exe|\.kill\(/i);
});
test('registered workflow isolates opt-in from acceptance and mixed migration for all mode combinations', () => {
  const yaml = fs.readFileSync(path.join(__dirname, '../.github/workflows/windows-outgoing-017.yml'), 'utf8');
  const condition = job => {
    const match = yaml.match(new RegExp(`^  ${job}:\\r?\\n    if: ([^\\r\\n]+)`, 'm'));
    assert.ok(match, job);
    const value = match[1];
    assert.ok(value.includes("github.event_name == 'workflow_dispatch'"));
    assert.ok(value.includes("github.ref == 'refs/heads/validation/windows-menu-merge-20261027'"));
    const tail = value.slice(value.indexOf(' && ', value.indexOf('github.ref')) + 4);
    assert.match(tail, /^[!&. a-z_]+$/);
    return Function('inputs', `return (${tail});`);
  };
  const acceptance = condition('acceptance'), mixed = condition('mixed-public-diagnostic'), preflight = condition('preflight-only-diagnostic');
  for (const migrated of [false, true]) for (const mixed_public_diagnostic of [false, true]) for (const preflight_only_diagnostic of [false, true]) {
    const v = { migrated, mixed_public_diagnostic, preflight_only_diagnostic };
    assert.equal(acceptance(v), !mixed_public_diagnostic && !preflight_only_diagnostic);
    assert.equal(mixed(v), mixed_public_diagnostic && !migrated && !preflight_only_diagnostic);
    assert.equal(preflight(v), preflight_only_diagnostic && !mixed_public_diagnostic && !migrated);
    assert.ok([acceptance(v), mixed(v), preflight(v)].filter(Boolean).length <= 1);
  }
  const job = yaml.split(/\r?\n  preflight-only-diagnostic:\r?\n/)[1]; assert.ok(job);
  assert.match(job, /CREATOR_PREFLIGHT_SOURCE: \$\{\{ inputs\.mixed_expected_source \}\}/);
  assert.match(job, /NODE_OPTIONS: ''/); assert.match(job, /NODE_PATH: ''/);
  const admission = job.indexOf("require('./scripts/windows-mcp-preflight-only-compare.cjs').admit()");
  assert.ok(admission >= 0 && admission < job.indexOf('node --test scripts/windows-mcp-preflight-only-compare.test.cjs'));
  assert.match(job, /node --test scripts\/windows-mcp-preflight-only-compare\.test\.cjs/);
  assert.match(job, /node scripts\/windows-mcp-preflight-only-compare\.cjs/);
  assert.doesNotMatch(job, /download-artifact|installer\.exe|--migration|native-mixed-public-diagnostic\.ps1/i);
});
