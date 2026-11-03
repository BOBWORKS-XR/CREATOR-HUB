'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/windows-incoming-016.yml'), 'utf8');
const job = workflow.split('  incoming-migration-diagnostic:')[1]?.split('  profile-proof-diagnostic:')[0];
test('incoming diagnostic is manual and mutually exclusive with existing modes', () => {
  assert.ok(job);
  assert.match(job, /github\.event_name == 'workflow_dispatch'.*github\.ref == 'refs\/heads\/validation\/windows-menu-merge-20261027'.*inputs\.mode == 'incoming-migration-diagnostic'/);
  for (const name of ['acceptance', 'signed012', 'profile-proof-diagnostic']) {
    const block = workflow.split(`  ${name}:`)[1]; assert.ok(block, name);
    const condition = block.split('\n').find(line => line.trimStart().startsWith('if:'));
    assert.ok(condition && !condition.includes("inputs.mode == 'incoming-migration-diagnostic'"), name);
  }
});
test('source, runner, artifact and signed feed bind before native work', () => {
  const checkout = job.indexOf('uses: actions/checkout@v6'), source = job.indexOf('Bind trusted runner and exact checkout before repository code');
  const setup = job.indexOf('uses: actions/setup-node@v6'), artifact = job.indexOf('Bind immutable signed012 artifact');
  const tests = job.indexOf('Test diagnostic, fixture, ownership and existing migration guards');
  const baselines = job.indexOf('Stage exact original legacy installers'), run = job.indexOf('Signed012 update then migration on the same synthetic profile');
  assert.ok(job.indexOf('Clear Node overrides') < checkout && checkout < source && source < setup && setup < artifact && artifact < tests && tests < baselines && baselines < run);
  for (const pin of ['818bcb983490e20ade5816b4dbb2f5ea98bcaa33484faefa7b9747d12d64b788',
    'c8cc58a35b6b8f8461e078110cbd72462566b19974ac13c547ca80edf5f860da',
    '7326d054ac23b7ac560e2c3488933203a33f0033586b1c33988ce7f316e4c51a',
    '986745ff133fbd8a4d4c5dc3de17cecafbc500e4af06badb323bf3a632476eea',
    'fac846563720eb4dae665a814ea28d0556800ebaf75aba7e8ee0be7f1979a5cd']) assert.ok(job.includes(pin));
  for (const marker of ['$start.Environment.Clear()', 'INCOMING_EXPECTED_SOURCE -cne $env:GITHUB_SHA', 'github-hosted',
    'artifact.digest', 'artifact.workflow_run.id', "run.path -cne '.github/workflows/windows-016-input.yml'", 'Compare-Object',
    'windows-incoming-migration-owned-close.test.cjs', 'windows-incoming-migration-updater.test.cjs', 'owned-close.ps1']) assert.ok(job.includes(marker), marker);
});
test('diagnostic retains reports and forbids release or broad acceptance claims', () => {
  for (const marker of ['incomingDiagnosticMain(process.argv.slice(1))', 'normalCloseObserved', 'labCleanupObserved',
    'migrationNetworkObserved', 'migrationIsolationProven', 'processTransfer', 'releaseReady', 'if: always()',
    'artifacts/native-suite-*/*.jsonl', 'artifacts/native-suite-*/*.json']) assert.ok(job.includes(marker), marker);
  assert.doesNotMatch(job, /contents: write|gh release|npm publish|upload-release|releaseReady\s*=\s*true/);
});
test('diagnostic artifact excludes startup process command lines while retaining receipts', () => {
  const upload = job.slice(job.indexOf('uses: actions/upload-artifact@v4'));
  const json = upload.indexOf('artifacts/native-suite-*/*.json');
  const excluded = upload.indexOf('!artifacts/native-suite-*/startup.json');
  assert.ok(json >= 0 && excluded > json);
  assert.match(upload, /artifacts\/native-suite-\*\/\*\.jsonl/);
  assert.doesNotMatch(upload.slice(excluded), /\n\s+artifacts\/native-suite-\*\/\*\.json(?:\s|$)/);
});
