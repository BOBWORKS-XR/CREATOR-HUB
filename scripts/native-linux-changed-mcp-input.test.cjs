'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const c = require('./native-linux-changed-mcp-input.cjs');
const raw = fs.readFileSync(path.join(__dirname, 'fixtures/native-linux-changed-mcp-profile.json'));
const p = c.profile(raw);
const clone = value => JSON.parse(JSON.stringify(value));
const repo = { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' };
const context = { sha: 'a'.repeat(40), runId: 12345 };
const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: repo.full_name, GITHUB_REPOSITORY_ID: '1364807512',
  GITHUB_REF: 'refs/heads/validation/native-linux-production-016', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: repo.full_name + '/.github/workflows/native-linux-production-016-migration.yml@refs/heads/validation/native-linux-production-016',
  RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
  CREATOR_NATIVE_LINUX_PRODUCTION_016: '1', CREATOR_MIGRATION_016_EXECUTE: 'true',
  CREATOR_MIGRATION_016_SCENARIO: 'migration-approve', CREATOR_MIGRATED_UPDATE_EXECUTE: 'true',
  UPDATE_EXECUTE: 'true', UPDATE_SCENARIO: 'deb-approve', UPDATE_PROFILE_SHA256: c.PROFILE_SHA,
  CREATOR_CHANGED_MCP_SOURCE_RECEIPT_SHA256: 'b'.repeat(64), GITHUB_SHA: context.sha,
  GITHUB_RUN_ID: String(context.runId), GITHUB_RUN_ATTEMPT: '1' };

test('exact reviewed profile keeps A1 separate from packaging donor', () => {
  assert.equal(p.baseline.source, 'ee48f25905947e0795eccb9d1d6c67f28f270545');
  assert.equal(p.artifacts.assembly17.source, 'dea67abb681ff99d3d0cd756954605a3c58627a6');
  assert.equal(p.deliveries.signedDeb17.asset, 683714773);
  assert.equal(Object.keys(p.objects).length, 13);
  assert.equal(c.hash(fs.readFileSync(path.join(__dirname, 'fixtures/native-linux-changed-mcp-incoming.json'))), c.INCOMING_SHA);
  assert.equal(c.canonical(p).equals(raw), true);
});

for (const [name, changed] of [
  ['newline change', Buffer.concat([raw, Buffer.from('\n')])],
  ['donor substitution', Buffer.from(raw.toString().replace('ee48f259', 'f00cd443'))],
  ['single-byte mutation', Buffer.from(raw.map((x, i) => i === 100 ? x ^ 1 : x))],
]) test('profile refuses ' + name, () => assert.throws(() => c.profile(changed)));

test('truthful isolated execution context admitted', () => c.admission(context, env));
for (const key of Object.keys(env)) test('context refuses missing ' + key, () => {
  const changed = { ...env }; delete changed[key];
  assert.throws(() => c.admission(context, changed));
});
for (const key of ['NODE_OPTIONS', 'LD_PRELOAD', 'PYTHONPATH', 'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS']) {
  test('context refuses ' + key + ' override', () => assert.throws(() => c.admission(context, { ...env, [key]: 'foreign' })));
}
test('context refuses fake producer source as harness', () => assert.throws(() => c.admission({ ...context, sha: p.baseline.source }, env)));

function producer(e) {
  return {
    run: { id: e.run, run_attempt: e.attempt, head_sha: e.source, head_branch: e.branch,
      path: e.workflow, event: 'workflow_dispatch', status: 'completed', conclusion: 'success', repository: repo, head_repository: repo },
    job: { id: e.job, run_id: e.run, run_attempt: e.attempt, head_sha: e.source,
      status: 'completed', conclusion: 'success', labels: ['ubuntu-22.04'] },
    artifact: { id: e.artifact, name: e.name, expired: false, size_in_bytes: e.zip.size,
      digest: 'sha256:' + e.zip.sha256, workflow_run: { id: e.run, head_sha: e.source, head_branch: e.branch } },
    commit: { sha: e.source, tree: { sha: e.tree } },
  };
}
for (const role of ['assembly16', 'assembly17']) {
  test('original producer API shape ' + role, () => c.producer(producer(p.artifacts[role]), p.artifacts[role]));
  for (const [label, mutate] of [
    ['failed producer', v => { v.run.conclusion = 'failure'; }],
    ['foreign tree', v => { v.commit.tree.sha = 'c'.repeat(40); }],
    ['wrong attempt', v => { v.job.run_attempt = 2; }],
    ['expired artifact', v => { v.artifact.expired = true; }],
    ['replaced bytes', v => { v.artifact.digest = 'sha256:' + 'd'.repeat(64); }],
    ['foreign repository', v => { v.run.repository = { ...repo, id: 1 }; }],
  ]) test(role + ' refuses ' + label, () => {
    const v = producer(p.artifacts[role]); mutate(v);
    assert.throws(() => c.producer(v, p.artifacts[role]));
  });
}

const current = { id: context.runId, head_sha: context.sha, run_attempt: 1,
  head_branch: 'validation/native-linux-production-016', path: '.github/workflows/native-linux-production-016-migration.yml',
  event: 'workflow_dispatch', status: 'in_progress', conclusion: null, repository: repo, head_repository: repo };
test('current original harness API is not a producer API', () => c.harness(current, context, env));
for (const [label, mutate] of [
  ['completed run', v => { v.status = 'completed'; }],
  ['different head', v => { v.head_sha = p.baseline.source; }],
  ['different workflow', v => { v.path = '.github/workflows/release.yml'; }],
  ['foreign head repository', v => { v.head_repository.id = 1; }],
]) test('current harness refuses ' + label, () => {
  const v = clone(current); mutate(v); assert.throws(() => c.harness(v, context, env));
});

const release = { id: 411494394, tag_name: 'v0.1.13-validation', draft: true };
const e = p.deliveries.signedDeb17;
const asset = { id: e.asset, name: e.name, size: e.zip.size, state: 'uploaded', digest: 'sha256:' + e.zip.sha256 };
test('private uploaded delivery metadata', () => c.delivery(release, asset, [asset], e));
for (const [label, r, a, listing] of [
  ['public release', { ...release, draft: false }, asset, [asset]],
  ['unfinished upload', release, { ...asset, state: 'starter' }, [asset]],
  ['different digest', release, { ...asset, digest: null }, [asset]],
  ['duplicate listing', release, asset, [asset, asset]],
  ['incomplete listing', release, asset, Array(100).fill(asset)],
]) test('delivery refuses ' + label, () => assert.throws(() => c.delivery(r, a, listing, e)));

test('source receipt hashes every original Git blob and rejects dirty source', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub-changed-source-')));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '--quiet']);
  fs.writeFileSync(path.join(root, 'source.txt'), 'reviewed\n', { flag: 'wx' });
  fs.writeFileSync(path.join(root, 'empty.txt'), '', { flag: 'wx' });
  git(['-c', 'core.autocrlf=false', 'add', '--', 'source.txt', 'empty.txt']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'source fixture']);
  const source = git(['rev-parse', 'HEAD']).trim();
  const first = c.sourceReceipt(root, source);
  assert.deepEqual(Object.keys(first.files), ['empty.txt', 'source.txt']);
  assert.equal(first.files['source.txt'].sha256, c.hash(Buffer.from('reviewed\n')));
  assert.equal(first.files['empty.txt'].size, 0);
  assert.equal(c.canonical(c.sourceReceipt(root, source)).equals(c.canonical(first)), true);
  fs.writeFileSync(path.join(root, 'source.txt'), 'changed\n');
  assert.throws(() => c.sourceReceipt(root, source), /Checkout differs/);
  assert.throws(() => c.sourceReceipt(root, 'e'.repeat(40)));
});

test('unbound source refuses before API calls, downloads or writes', async () => {
  let calls = 0;
  const github = new Proxy({}, { get() { calls++; throw new Error('Unexpected API'); } });
  await assert.rejects(c.run({ github, context, raw, env: { ...env, CREATOR_CHANGED_MCP_SOURCE_RECEIPT_SHA256: '' } }));
  assert.equal(calls, 0);
});

test('no product acceptance is represented by input acquisition', () => {
  assert.equal(Object.keys(c.FALSE).length, 6);
  assert.ok(Object.values(c.FALSE).every(value => value === false));
  assert.equal(/downloadArtifact\([\s\S]*?assembly16/.test(c.run.toString()), false);
});
