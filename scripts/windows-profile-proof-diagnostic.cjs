'use strict';
// A trusted-host diagnostic, not identity attestation or a fixture authorization.
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const PROOF_STAGES = Object.freeze(['ADMISSION', 'REQUEST', 'TOKEN', 'PROFILE_REGISTRY', 'PROFILE_MATCH', 'PROFILE_OWNER_READ',
  'PROFILE_OWNER_MISMATCH', 'ROOTS', 'PATH_INPUT', 'PATH_SCOPE', 'PATH_ATTRIBUTES', 'PATH_REPARSE', 'PROFILE_ACL_READ', 'PROFILE_ACL_WRITE', 'OUTPUT']);
const CODES = new Set(['LAUNCHER_ADMISSION', 'SOURCE_CHECK', 'PROOF_CHILD', 'PROOF_CONTRACT',
  ...PROOF_STAGES.map(stage => `PROOF_${stage}`)]);
class Refusal extends Error {
  constructor(code, ownerCategory) { super('Diagnostic refused'); this.code = code; this.ownerCategory = ownerCategory; }
}
function at(code, callback) {
  try { return callback(); } catch { throw new Refusal(code); }
}
function proofFailure(stderr) {
  if (typeof stderr !== 'string') return 'PROOF_CHILD';
  if (/^PROFILE_PROOF_REFUSED:PROFILE_OWNER_MISMATCH:(?:ADMINISTRATORS|SYSTEM|OTHER)\r?\n?$/.test(stderr)) return 'PROOF_PROFILE_OWNER_MISMATCH';
  const match = /^PROFILE_PROOF_REFUSED:([A-Z_]+)\r?\n?$/.exec(stderr);
  return match && PROOF_STAGES.includes(match[1]) ? `PROOF_${match[1]}` : 'PROOF_CHILD';
}
function proofOwnerCategory(stderr) {
  if (typeof stderr !== 'string') return undefined;
  return /^PROFILE_PROOF_REFUSED:PROFILE_OWNER_MISMATCH:(ADMINISTRATORS|SYSTEM|OTHER)\r?\n?$/.exec(stderr)?.[1];
}
function publicFailure(error) {
  return error instanceof Refusal && CODES.has(error.code) ? error.code : 'PROOF_CHILD';
}
function publicOwnerCategory(error) {
  return error instanceof Refusal && error.code === 'PROOF_PROFILE_OWNER_MISMATCH' &&
    ['ADMINISTRATORS', 'SYSTEM', 'OTHER'].includes(error.ownerCategory) ? error.ownerCategory : undefined;
}

function admit(env, platform) {
  assert.equal(platform, 'win32');
  for (const [name, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
    GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'profile-proof-diagnostic',
    GITHUB_REF: 'refs/heads/validation/windows-menu-merge-20261027',
    GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-incoming-016.yml@refs/heads/validation/windows-menu-merge-20261027',
    CREATOR_PROFILE_PROOF_DIAGNOSTIC: '1', GITHUB_RUN_ATTEMPT: '1' })) assert.equal(env[name], value, name);
  assert.match(env.GITHUB_RUN_ID || '', /^[1-9][0-9]*$/);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
  assert.equal(env.CREATOR_INCOMING_MIGRATION_SOURCE, env.GITHUB_SHA);
  for (const name of ['GITHUB_WORKSPACE', 'RUNNER_TEMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'ProgramFiles'])
    assert.ok(path.isAbsolute(env[name] || ''), name);
}
function checkProof(proof, env, count) {
  assert.deepEqual(Object.keys(proof).sort(), ['kind', 'sid', 'ownerSid', 'profile', 'appData', 'localAppData', 'pathsChecked', 'handleBound', 'compromisedRunnerResistance'].sort());
  assert.equal(proof.kind, 'incoming-migration-profile-proof');
  assert.match(proof.sid || '', /^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/);
  assert.equal(proof.ownerSid, proof.sid);
  for (const [key, name] of [['profile', 'USERPROFILE'], ['appData', 'APPDATA'], ['localAppData', 'LOCALAPPDATA']])
    assert.equal(path.resolve(proof[key]).toLowerCase(), path.resolve(env[name]).toLowerCase());
  assert.equal(proof.pathsChecked, count); assert.equal(proof.handleBound, false); assert.equal(proof.compromisedRunnerResistance, false);
}
function gitEnvironment(env) {
  return { SystemRoot: env.SystemRoot, windir: env.SystemRoot,
    PATH: `${path.join(env.ProgramFiles, 'Git', 'cmd')};${path.join(env.SystemRoot, 'System32')}`,
    HOME: env.RUNNER_TEMP, USERPROFILE: env.RUNNER_TEMP, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: 'NUL',
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}
function run(env = process.env) {
  at('LAUNCHER_ADMISSION', () => admit(env, process.platform));
  const gitExe = path.join(env.ProgramFiles, 'Git', 'cmd', 'git.exe');
  at('SOURCE_CHECK', () => {
    const git = spawnSync(gitExe, ['-c', `safe.directory=${env.GITHUB_WORKSPACE}`, 'rev-parse', 'HEAD'],
      { cwd: env.GITHUB_WORKSPACE, env: gitEnvironment(env), encoding: 'utf8', timeout: 10000, maxBuffer: 8192, windowsHide: true });
    assert.equal(git.status, 0); assert.equal(git.stdout.trim(), env.GITHUB_SHA);
  });
  const paths = [env.USERPROFILE, env.APPDATA, env.LOCALAPPDATA, env.GITHUB_WORKSPACE, env.RUNNER_TEMP,
    path.join(env.APPDATA, 'creator-hub-profile-proof-nonexistent'), path.join(env.LOCALAPPDATA, 'creator-hub-profile-proof-nonexistent')];
  const keys = ['SystemRoot', 'windir', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'ProgramFiles', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'GITHUB_WORKSPACE', 'RUNNER_TEMP',
    'GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'RUNNER_OS', 'RUNNER_ARCH', 'GITHUB_REPOSITORY', 'GITHUB_REPOSITORY_ID', 'GITHUB_EVENT_NAME', 'GITHUB_JOB', 'GITHUB_REF',
    'GITHUB_WORKFLOW_REF', 'CREATOR_PROFILE_PROOF_DIAGNOSTIC', 'CREATOR_INCOMING_MIGRATION_SOURCE', 'GITHUB_SHA', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT'];
  const childEnv = Object.fromEntries(keys.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  const shell = path.join(env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
  const child = at('PROOF_CHILD', () => spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'native-incoming-migration-profile-proof.ps1')],
    { input: JSON.stringify({ paths }), encoding: 'utf8', env: childEnv, timeout: 30000, maxBuffer: 16384, windowsHide: true }));
  if (child.status !== 0) throw new Refusal(proofFailure(child.stderr), proofOwnerCategory(child.stderr));
  at('PROOF_CONTRACT', () => checkProof(JSON.parse(child.stdout), env, paths.length));
  return { kind: 'read-only-hosted-profile-diagnostic', source: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID,
    sourceHeadMatched: true, profileChecksPassed: true, ownerCategory: 'TOKEN', fixtureWrites: false, identityAttestation: false,
    handleBound: false, compromisedRunnerResistance: false, snapshotAuthorized: false, releaseReady: false };
}
if (require.main === module) {
  try { process.stdout.write(`${JSON.stringify(run())}\n`); }
  catch (error) {
    const category = publicOwnerCategory(error);
    process.stderr.write(`Read-only hosted profile diagnostic refused: ${publicFailure(error)}${category ? `; ownerCategory=${category}` : ''}\n`);
    process.exitCode = 1;
  }
}
module.exports = { admit, checkProof, gitEnvironment, run, at, proofFailure, proofOwnerCategory, publicFailure, publicOwnerCategory, PROOF_STAGES };
