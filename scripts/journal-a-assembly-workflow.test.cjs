const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/unix-managed-assembly.yml'), 'utf8').replace(/\r\n/g, '\n');
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';

test('journal A has no push trigger and both package guards retain fixed profile checks', () => {
  assert.match(workflow, /push:\s*\n\s*branches: \[validation\/unix-assembly-014\]/);
  assert.equal((workflow.match(/Journal A requires the fixed manual production and portable profile/g) || []).length, 2);
  assert.match(workflow, /needs: candidate-options/);
  assert.match(workflow, /assert len\(inputs\) == 1 and inputs\[0\]\['target'\] == 'linux' and inputs\[0\]\['os'\] == 'ubuntu-22\.04'/);
  assert.match(workflow, /assert\.equal\(release\.draft,true\)/);
  assert.match(workflow, /assert\.equal\(crypto\.createHash\('sha256'\)\.update\(bytes\)\.digest\('hex'\),digest\)/);
  const preflight = workflow.indexOf('run: node --test scripts/journal-a-assembly-workflow.test.cjs\n');
  assert.ok(preflight > 0 && preflight < workflow.indexOf('npm run build:unified -- ci-signed-unix-hub'));
  const { yaml } = require('playwright-core/lib/utilsBundle');
  const steps = yaml.parse(workflow, { uniqueKeys: true }).jobs.assembly.steps;
  const index = steps.findIndex(step => step.name === 'Check the journal A assembly workflow guards');
  assert.ok(index >= 0 && index < steps.findIndex(step => step.name === 'Verify trusted handoff and compile only the outer native Hub'));
  assert.equal(steps[index].run, 'node --test scripts/journal-a-assembly-workflow.test.cjs');
  assert.equal(steps[index].if, undefined);
  assert.equal(steps[index]['continue-on-error'], undefined);
});

test('early workflow guard rejects all wrong A profiles before input staging', t => {
  if (process.platform === 'win32' && !fs.existsSync(bash)) return t.skip('Git Bash unavailable');
  const block = workflow.split('      - name: Refuse conflicting candidate profiles before any download\n')[1].split('  stage-input:\n')[0];
  const script = block.slice(block.indexOf('          set -euo pipefail')).split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n')
    .replace('python3 - <<', `${process.platform === 'win32' ? 'python' : 'python3'} - <<`);
  const env = { ...process.env, GITHUB_REF: 'refs/heads/validation/journal-a-assembly-016', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512',
    CREATOR_LINUX_PRODUCTION_MIGRATION_016: '1', CREATOR_LINUX_PORTABLE_HOST_CANDIDATE: '1',
    CREATOR_LINUX_INTEGRATED_CANDIDATE: '0', CREATOR_LINUX_RETIREMENT_TEST_CANDIDATE: '0',
    SIGNED_INPUTS: JSON.stringify([{ target: 'linux', os: 'ubuntu-22.04' }]) };
  const run = changes => spawnSync(bash, ['-c', script], { env: { ...env, ...changes }, encoding: 'utf8', timeout: 15000, windowsHide: true });
  const positive = run({}); assert.equal(positive.status, 0, positive.stderr || positive.error?.message);
  for (const change of [{ GITHUB_EVENT_NAME: 'push' }, { CREATOR_LINUX_PRODUCTION_MIGRATION_016: '0' },
    { CREATOR_LINUX_PORTABLE_HOST_CANDIDATE: '0' }, { CREATOR_LINUX_INTEGRATED_CANDIDATE: '1' },
    { CREATOR_LINUX_RETIREMENT_TEST_CANDIDATE: '1' }, { GITHUB_REPOSITORY_ID: '1' },
    { SIGNED_INPUTS: JSON.stringify([{ target: 'macos', os: 'ubuntu-22.04' }]) },
    { SIGNED_INPUTS: JSON.stringify([{ target: 'linux', os: 'ubuntu-22.04' }, { target: 'linux', os: 'ubuntu-22.04' }]) }]) {
    assert.notEqual(run(change).status, 0, JSON.stringify(change));
  }
  assert.notEqual(run({ GITHUB_REF: 'refs/heads/validation/journal-a-assembly-016-extra' }).status, 0);
});
