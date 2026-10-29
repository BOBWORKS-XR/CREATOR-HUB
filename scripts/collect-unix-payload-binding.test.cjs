const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fixture } = require('./fixtures/unix-payload-binding.cjs');
const { collect, json } = require('./collect-unix-payload-binding.cjs');

function inputs(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'creator-public-binding-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const value = fixture();
  const file = path.join(root, 'prepared-unix.json');
  fs.writeFileSync(file, JSON.stringify(value.prepared, null, 2));
  return { root, file, value };
}

test('fresh attempt-scoped public API collection remains unsigned and cannot prove ZIP bytes', t => {
  const { file, value } = inputs(t);
  const routes = [];
  const response = collect(value.expected, file, route => {
    routes.push(route);
    if (route === 'actions/runs/101') return value.run;
    if (route === 'actions/artifacts/202') return value.artifact;
    if (route.startsWith('git/commits/')) return value.commit;
    assert.equal(route, 'actions/runs/101/attempts/1/jobs?per_page=100');
    return { jobs: value.jobs, total_count: 1 };
  });
  assert.equal(routes.length, 4);
  assert.equal(response.downloadedZipVerified, false);
  assert.equal(response.releaseReady, false);
});

test('new Linux16 collection retains the fresh API and source binding rather than accepting a relabelled14 result', t => {
  const { file, value } = inputs(t);
  value.expected.version = value.prepared.hubVersion = '0.1.16';
  value.run.head_branch = 'validation/unix-payload-016';
  fs.writeFileSync(file, JSON.stringify(value.prepared, null, 2));
  const request = route => route.startsWith('actions/runs/101/attempts/') ? { jobs: value.jobs, total_count: 1 }
    : route === 'actions/runs/101' ? value.run : route === 'actions/artifacts/202' ? value.artifact : value.commit;
  assert.equal(collect(value.expected, file, request).verified.version, '0.1.16');
  value.run.head_branch = 'validation/unix-payload-014';
  assert.throws(() => collect(value.expected, file, request));
  for (const target of ['macos-intel', 'macos-arm64']) {
    assert.throws(() => collect({ ...value.expected, target }, file, () => assert.fail('No API call')));
  }
});

test('journal A collection binds manual run and independently supplied tree across all evidence', t => {
  const { file, value } = inputs(t);
  Object.assign(value.expected, { version: '0.1.16', producerBranch: 'validation/journal-a-payload-016',
    sourceTree: value.commit.tree.sha });
  value.prepared.hubVersion = '0.1.16';
  value.run.head_branch = value.expected.producerBranch;
  value.run.event = value.prepared.source.event = 'workflow_dispatch';
  fs.writeFileSync(file, JSON.stringify(value.prepared, null, 2));
  const request = route => route.startsWith('actions/runs/101/attempts/') ? { jobs: value.jobs, total_count: 1 }
    : route === 'actions/runs/101' ? value.run : route === 'actions/artifacts/202' ? value.artifact : value.commit;
  const result = collect(value.expected, file, request);
  assert.equal(result.verified.sourceTree, value.expected.sourceTree);
  assert.equal(result.downloadedZipVerified, false); assert.equal(result.releaseReady, false);
  value.commit.tree.sha = 'e'.repeat(40);
  assert.throws(() => collect(value.expected, file, request), /source tree differs/);
  value.commit.tree.sha = value.expected.sourceTree;
  value.run.head_branch = 'validation/journal-b-payload-016';
  assert.throws(() => collect(value.expected, file, request));
  for (const change of [{ sourceTree: undefined }, { producerBranch: 'validation/journal-b-payload-016' },
    { sourceCommit: '../source' }, { extra: true }]) {
    assert.throws(() => collect({ ...value.expected, ...change }, file, () => assert.fail('No API call')));
  }
});

test('malformed independent pins refuse before filesystem or API use', t => {
  const { file, value } = inputs(t);
  for (const change of [{ target: 'constructor' }, { runId: '101/path' }, { artifactId: 0 }, { runAttempt: NaN },
    { sourceCommit: '../source' }, { zipSha256: 'invalid' }, { version: '0.1.13' }]) {
    assert.throws(() => collect({ ...value.expected, ...change }, file, () => assert.fail('No API call')));
  }
});

test('canonical JSON rejects duplicate keys and oversized input', t => {
  const { root } = inputs(t);
  const file = path.join(root, 'bad.json');
  fs.writeFileSync(file, '{"field":1,"field":2}');
  assert.throws(() => json(file), /canonical emitted JSON/);
  fs.writeFileSync(file, ' '.repeat(128 * 1024 + 1));
  assert.throws(() => json(file));
});

test('absolute Windows metadata paths accept either standard separator', { skip: process.platform !== 'win32' }, t => {
  const { file, value } = inputs(t);
  assert.deepEqual(json(file.replaceAll('\\', '/')), value.prepared);
});

test('incomplete job pagination never becomes positive provenance', t => {
  const { file, value } = inputs(t);
  assert.throws(() => collect(value.expected, file, route => {
    if (route === 'actions/runs/101') return value.run;
    if (route === 'actions/artifacts/202') return value.artifact;
    if (route.startsWith('git/commits/')) return value.commit;
    return { jobs: value.jobs, total_count: 101 };
  }), /Incomplete or oversized/);
});
