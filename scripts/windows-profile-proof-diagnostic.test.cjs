'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const diagnostic = require('./windows-profile-proof-diagnostic.cjs');

const sha = 'a'.repeat(40);
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_JOB: 'profile-proof-diagnostic', GITHUB_REF: 'refs/heads/validation/windows-menu-merge-20261027',
  GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-incoming-016.yml@refs/heads/validation/windows-menu-merge-20261027',
  CREATOR_PROFILE_PROOF_DIAGNOSTIC: '1', GITHUB_RUN_ATTEMPT: '1', GITHUB_RUN_ID: '123', GITHUB_SHA: sha,
  CREATOR_INCOMING_MIGRATION_SOURCE: sha, GITHUB_WORKSPACE: path.resolve('workspace'), RUNNER_TEMP: path.resolve('temp'),
  USERPROFILE: path.resolve('profile'), APPDATA: path.resolve('profile/AppData/Roaming'), LOCALAPPDATA: path.resolve('profile/AppData/Local'),
  SystemRoot: path.resolve('windows'), ProgramFiles: path.resolve('programs') };
function proof() { return { kind: 'incoming-migration-profile-proof', sid: 'S-1-5-21-1-2-3-1001', ownerSid: 'S-1-5-21-1-2-3-1001',
  profile: env.USERPROFILE, appData: env.APPDATA, localAppData: env.LOCALAPPDATA, pathsChecked: 7, handleBound: false, compromisedRunnerResistance: false }; }

test('hosted job admission refuses changed context or source', () => {
  diagnostic.admit(env, 'win32');
  assert.throws(() => diagnostic.admit(env, 'linux'));
  for (const key of Object.keys(env)) assert.throws(() => diagnostic.admit({ ...env, [key]: '' }, 'win32'));
  assert.throws(() => diagnostic.admit({ ...env, CREATOR_INCOMING_MIGRATION_SOURCE: 'b'.repeat(40) }, 'win32'));
});
test('proof contract rejects identity, path, count and scope drift', () => {
  diagnostic.checkProof(proof(), env, 7);
  for (const change of [p => p.sid = 'bad', p => p.ownerSid = 'S-1-5-21-1-2-3-2', p => p.profile = env.RUNNER_TEMP,
    p => p.appData = env.RUNNER_TEMP, p => p.localAppData = env.RUNNER_TEMP, p => p.pathsChecked = 6,
    p => p.handleBound = true, p => p.compromisedRunnerResistance = true, p => p.extra = true]) {
    const value = proof(); change(value); assert.throws(() => diagnostic.checkProof(value, env, 7));
  }
});
test('Git child receives only bounded system settings and no preload or Git overrides', () => {
  const clean = diagnostic.gitEnvironment({ ...env, PATH: 'untrusted', NODE_OPTIONS: '--require evil', NODE_PATH: 'evil',
    GIT_CONFIG_COUNT: '1', GIT_EXEC_PATH: 'evil', SECRET: 'secret' });
  assert.deepEqual(Object.keys(clean).sort(), ['SystemRoot', 'windir', 'PATH', 'HOME', 'USERPROFILE',
    'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_TERMINAL_PROMPT', 'GIT_OPTIONAL_LOCKS'].sort());
  assert.doesNotMatch(clean.PATH, /untrusted/);
  assert.equal(clean.GIT_CONFIG_NOSYSTEM, '1'); assert.equal(clean.GIT_CONFIG_GLOBAL, 'NUL');
});
test('refusals expose only bounded stage codes, never raw child output or errors', () => {
  for (const name of diagnostic.PROOF_STAGES) {
    assert.equal(diagnostic.proofFailure(`PROFILE_PROOF_REFUSED:${name}\r\n`), `PROOF_${name}`);
  }
  for (const stderr of [null, '', 'C:\\private\\path S-1-5-21-1-2-3-1001', 'PROFILE_PROOF_REFUSED:NOT_A_STAGE\n',
    'PROFILE_PROOF_REFUSED:PROFILE_OWNER_MISMATCH\nC:\\private', 'PROFILE_PROOF_REFUSED:PROFILE_ACL_WRITE\nextra']) {
    assert.equal(diagnostic.proofFailure(stderr), 'PROOF_CHILD');
  }
  let captured;
  try { diagnostic.at('SOURCE_CHECK', () => { throw Error('private path'); }); } catch (error) { captured = error; }
  assert.equal(diagnostic.publicFailure(captured), 'SOURCE_CHECK');
  assert.equal(diagnostic.publicFailure(Error('private SID')), 'PROOF_CHILD');
  const ps = fs.readFileSync(path.join(__dirname, 'native-incoming-migration-profile-proof.ps1'), 'utf8');
  const stages = [...ps.matchAll(/\$stage = '([A-Z_]+)'/g)].map(match => match[1]);
  assert.deepEqual([...new Set(stages)].sort(), [...diagnostic.PROOF_STAGES].sort());
  assert.match(ps, /Error\.WriteLine\('PROFILE_PROOF_REFUSED:' \+ \$stage\)/);
  assert.doesNotMatch(ps, /WriteLine\(\$_|WriteLine\(\$Error/);
});
test('owner category is bounded and never changes the owner mismatch refusal', () => {
  for (const category of ['ADMINISTRATORS', 'SYSTEM', 'OTHER']) {
    const line = `PROFILE_PROOF_REFUSED:PROFILE_OWNER_MISMATCH:${category}\r\n`;
    assert.equal(diagnostic.proofFailure(line), 'PROOF_PROFILE_OWNER_MISMATCH');
    assert.equal(diagnostic.proofOwnerCategory(line), category);
  }
  for (const line of ['PROFILE_PROOF_REFUSED:PROFILE_OWNER_MISMATCH:TOKEN',
    'PROFILE_PROOF_REFUSED:PROFILE_OWNER_MISMATCH:S-1-5-18',
    'PROFILE_PROOF_REFUSED:PROFILE_OWNER_MISMATCH:SYSTEM\nC:\\private',
    'PROFILE_PROOF_REFUSED:PROFILE_OWNER_READ:SYSTEM']) {
    assert.equal(diagnostic.proofFailure(line), 'PROOF_CHILD');
    assert.equal(diagnostic.proofOwnerCategory(line), undefined);
  }
  let error;
  try { diagnostic.at('PROOF_PROFILE_OWNER_MISMATCH', () => { throw Error('private'); }); } catch (caught) { error = caught; }
  error.ownerCategory = 'SYSTEM';
  assert.equal(diagnostic.publicFailure(error), 'PROOF_PROFILE_OWNER_MISMATCH');
  assert.equal(diagnostic.publicOwnerCategory(error), 'SYSTEM');
  error.ownerCategory = 'S-1-5-18'; assert.equal(diagnostic.publicOwnerCategory(error), undefined);
  const ps = fs.readFileSync(path.join(__dirname, 'native-incoming-migration-profile-proof.ps1'), 'utf8');
  assert.match(ps, /if \(\$owner -cne \$sid\) \{ throw 'Profile owner differs from token\.' \}/);
  assert.match(ps, /\$ownerCategory -cin @\('ADMINISTRATORS', 'SYSTEM', 'OTHER'\)/);
});
test('workflow isolates opt-in from native acceptance and proof does not write fixtures', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/windows-incoming-016.yml'), 'utf8');
  const acceptance = workflow.split('  acceptance:')[1].split('  signed012:')[0];
  const job = workflow.split('  profile-proof-diagnostic:')[1].split('  inert-process-probe:')[0];
  assert.doesNotMatch(acceptance, /inputs\.mode == 'profile-proof-diagnostic'/);
  assert.match(job, /github\.event_name == 'workflow_dispatch'.*inputs\.mode == 'profile-proof-diagnostic'/);
  assert.match(job, /node --test scripts\/windows-profile-proof-diagnostic\.test\.cjs/);
  assert.match(job, /node scripts\/windows-profile-proof-diagnostic\.cjs/);
  const clear = job.indexOf('Clear Node overrides before Node-based actions');
  const checkout = job.indexOf('uses: actions/checkout@v6');
  const bind = job.indexOf('Bind checkout HEAD before checkout code');
  const setup = job.indexOf('uses: actions/setup-node@v6');
  const tests = job.indexOf('node --test scripts/windows-profile-proof-diagnostic.test.cjs');
  assert.ok(clear >= 0 && clear < checkout && checkout < bind && bind < setup && setup < tests);
  assert.match(job, /NODE_OPTIONS=.*NODE_PATH=.*NODE_V8_COVERAGE=.*NODE_REPL_EXTERNAL_MODULE=/);
  assert.match(job, /\$start\.Environment\.Clear\(\)/);
  assert.match(job, /Git\\cmd\\git\.exe/);
  assert.match(job, /\$head -cne \$env:GITHUB_SHA/);
  assert.doesNotMatch(job, /npm ci|download-artifact|upload-artifact|installer|native-self-update/);
  const source = fs.readFileSync(path.join(__dirname, 'windows-profile-proof-diagnostic.cjs'), 'utf8');
  assert.doesNotMatch(source, /writeFile|mkdir|unlink|rmSync|install/i);
  assert.match(source, /identityAttestation: false/); assert.match(source, /snapshotAuthorized: false/);
  assert.match(source, /spawnSync\(gitExe/); assert.match(source, /env: gitEnvironment\(env\)/);
});
test('PowerShell proof parses without executing or inspecting the local profile', { skip: process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' }, () => {
  const file = path.join(__dirname, 'native-incoming-migration-profile-proof.ps1').replace(/'/g, "''");
  const command = `$t=$null;$e=$null;[void][Management.Automation.Language.Parser]::ParseFile('${file}',[ref]$t,[ref]$e);if($e.Count){exit 1}`;
  const shell = path.join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
    { timeout: 15000, windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.error ? result.error.message : 'PowerShell parse failed');
});
