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
  GITHUB_REF: 'refs/heads/validation/native-linux-journal-production-016', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_WORKFLOW_REF: repo.full_name + '/.github/workflows/native-linux-production-016-migration.yml@refs/heads/validation/native-linux-journal-production-016',
  RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
  CREATOR_NATIVE_LINUX_PRODUCTION_016: '1', CREATOR_MIGRATION_016_EXECUTE: 'true',
  CREATOR_MIGRATION_016_SCENARIO: 'migration-approve', CREATOR_MIGRATED_UPDATE_EXECUTE: 'true',
  UPDATE_EXECUTE: 'true', UPDATE_SCENARIO: 'deb-approve', UPDATE_PROFILE_SHA256: c.PROFILE_SHA,
  CREATOR_CHANGED_MCP_SOURCE_RECEIPT_SHA256: 'b'.repeat(64), GITHUB_SHA: context.sha,
  GITHUB_RUN_ID: String(context.runId), GITHUB_RUN_ATTEMPT: '1' };

test('exact reviewed profile keeps A1 separate from packaging donor', () => {
  assert.equal(p.baseline.source, 'be0adef208c80a60f8599bd466a45b28bde73588');
  assert.equal(p.artifacts.assembly17.source, 'a61e7b0152689b7fa25fd0f4fe3e7d3894751cc5');
  assert.equal(p.deliveries.signedDeb17.asset, 689113479);
  assert.equal(Object.keys(p.objects).length, 13);
  assert.equal(c.hash(fs.readFileSync(path.join(__dirname, 'fixtures/journal-a-native-incoming.UNBOUND.json'))), c.INCOMING_SHA);
  assert.equal(c.canonical(p).equals(raw), true);
});

for (const [name, changed] of [
  ['newline change', Buffer.concat([raw, Buffer.from('\n')])],
  ['donor substitution', Buffer.from(raw.toString().replace('be0adef2', 'c5bd13a5'))],
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
  head_branch: 'validation/native-linux-journal-production-016', path: '.github/workflows/native-linux-production-016-migration.yml',
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

const deliveryRecord = () => ({ schemaVersion: 1, source: context.sha, run: context.runId, attempt: 1,
  profileSha256: c.PROFILE_SHA, release: clone(release), asset: clone(asset), listing: [clone(asset)],
  dataOnly: true, ...c.FALSE });
const transferArtifact = () => ({ id: 987654, name: 'changed-mcp-delivery-12345-1',
  size_in_bytes: 64475000, expired: false, digest: 'sha256:' + 'd'.repeat(64),
  workflow_run: { id: context.runId, head_sha: context.sha, head_branch: 'validation/native-linux-journal-production-016',
    repository_id: repo.id, head_repository_id: repo.id } });

test('collector has the fixed API and common admission does not require a future artifact ID', () => {
  assert.equal(typeof c.collectDelivery, 'function');
  assert.equal(env.CREATOR_CHANGED_MCP_DELIVERY_ARTIFACT, undefined);
  c.admission(context, env);
});

test('delivery API accepts exactly the canonical source/run/profile/draft observation', () => {
  const value = deliveryRecord();
  assert.deepEqual(c.deliveryAPI(c.canonical(value), p, context, env), value);
});
for (const [label, mutate] of [
  ['unknown field', v => { v.extra = true; }],
  ['missing listing', v => { delete v.listing; }],
  ['different source', v => { v.source = p.baseline.source; }],
  ['different run', v => { v.run++; }],
  ['string run', v => { v.run = String(v.run); }],
  ['different attempt', v => { v.attempt++; }],
  ['different profile', v => { v.profileSha256 = 'e'.repeat(64); }],
  ['not data-only', v => { v.dataOnly = false; }],
  ['public draft', v => { v.release.draft = false; }],
  ['different asset', v => { v.asset.id++; }],
  ['duplicate listing', v => { v.listing.push(clone(v.asset)); }],
  ['self-certified acceptance', v => { v.releaseReady = true; }],
  ['string false', v => { v.unityAccepted = 'false'; }],
]) test('staged delivery API refuses ' + label, () => {
  const value = deliveryRecord(); mutate(value);
  assert.throws(() => c.deliveryAPI(c.canonical(value), p, context, env));
});
test('staged delivery API refuses ambiguous or noncanonical JSON', () => {
  const good = c.canonical(deliveryRecord());
  for (const changed of [Buffer.concat([good, Buffer.from('\n')]),
    Buffer.from(good.toString().replace('"schemaVersion": 1,', '"schemaVersion": 0, "schemaVersion": 1,')),
    Buffer.from('{}')]) assert.throws(() => c.deliveryAPI(changed, p, context, env));
});

test('delivery artifact association is exact to the current workflow source/run/attempt', () => {
  c.deliveryArtifact(transferArtifact(), 987654, context, env);
});
for (const [label, mutate] of [
  ['different ID', v => { v.id++; }],
  ['different name', v => { v.name += '-other'; }],
  ['expired', v => { v.expired = true; }],
  ['missing digest', v => { delete v.digest; }],
  ['wrong digest algorithm', v => { v.digest = 'sha512:' + 'd'.repeat(64); }],
  ['non-hex digest', v => { v.digest = 'sha256:' + 'g'.repeat(64); }],
  ['empty artifact', v => { v.size_in_bytes = 0; }],
  ['different workflow run', v => { v.workflow_run.id++; }],
  ['different source', v => { v.workflow_run.head_sha = p.baseline.source; }],
  ['different branch', v => { v.workflow_run.head_branch += '-foreign'; }],
  ['foreign repository', v => { v.workflow_run.repository_id = 1; }],
  ['foreign head repository', v => { v.workflow_run.head_repository_id = 1; }],
]) test('native delivery artifact refuses ' + label, () => {
  const value = transferArtifact(); mutate(value);
  assert.throws(() => c.deliveryArtifact(value, 987654, context, env));
});

test('collector unbound-source refusal occurs before any private API access', async () => {
  let calls = 0;
  const github = new Proxy({}, { get() { calls++; throw Error('Unexpected API'); } });
  await assert.rejects(c.collectDelivery({ github, context, raw, env: { ...env, CREATOR_CHANGED_MCP_SOURCE_RECEIPT_SHA256: '' } }));
  assert.equal(calls, 0);
});

test('native route contains no draft-release query or private asset download fallback', () => {
  const body = c.run.toString();
  assert.equal(/rest\.repos|getRelease|listReleaseAssets|application\/octet-stream/.test(body), false);
  assert.match(body, /getArtifact/);
  assert.match(body, /CREATOR_CHANGED_MCP_DELIVERY_ARTIFACT/);
});

function routeFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'changed-delivery-route-')));
  t.after(() => {
    assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('changed-delivery-route-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const workspace = path.join(root, 'workspace'), temp = path.join(root, 'runner');
  fs.mkdirSync(workspace); fs.mkdirSync(temp);
  const git = args => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '--quiet']);
  fs.writeFileSync(path.join(workspace, 'source.txt'), 'original source\n', { flag: 'wx' });
  git(['-c', 'core.autocrlf=false', 'add', '--', 'source.txt']);
  git(['-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'read-only data-route fixture']);
  const source = git(['rev-parse', 'HEAD']).trim();
  const ctx = { ...context, sha: source };
  const values = { ...env, GITHUB_SHA: source, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: temp };
  values.CREATOR_CHANGED_MCP_SOURCE_RECEIPT_SHA256 = c.hash(c.canonical(c.sourceReceipt(workspace, source)));
  const modes = new Map(), fds = new Map(), opened = [], writes = [], calls = [];
  const original = { lstat: fs.lstatSync, fstat: fs.fstatSync, open: fs.openSync,
    write: fs.writeFileSync, mkdir: fs.mkdirSync };
  const uidDescriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
  if (!uidDescriptor) {
    Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
    t.after(() => { delete process.getuid; });
  }
  // Only POSIX owner/mode metadata is modeled on Windows. Real bytes, crypto,
  // Git blob checks, link/type/size/identity checks and the actual guards run.
  const modeled = (st, file) => {
    const override = modes.get(file);
    if (!override) return st;
    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
      mode: (st.mode & ~0o7777) | override.mode, uid: override.uid,
    });
  };
  t.mock.method(fs, 'lstatSync', (file, ...args) => modeled(original.lstat(file, ...args), String(file)));
  t.mock.method(fs, 'openSync', (file, ...args) => {
    const fd = original.open(file, ...args); fds.set(fd, String(file)); opened.push(String(file)); return fd;
  });
  t.mock.method(fs, 'fstatSync', (fd, ...args) => modeled(original.fstat(fd, ...args), fds.get(fd)));
  t.mock.method(fs, 'writeFileSync', (file, body, options) => {
    original.write(file, body, options);
    if (options && typeof options === 'object' && Number.isInteger(options.mode)) {
      modes.set(String(file), { mode: options.mode, uid: process.getuid() });
    }
    writes.push({ file: String(file), mode: options?.mode, flag: options?.flag });
  });
  t.mock.method(fs, 'mkdirSync', (file, options) => {
    const result = original.mkdir(file, options);
    if (options && typeof options === 'object' && Number.isInteger(options.mode)) {
      modes.set(String(file), { mode: options.mode, uid: process.getuid() });
    }
    return result;
  });
  t.mock.method(fs, 'chmodSync', () => { throw Error('Permission repair is not allowed'); });
  const state = { current: { ...clone(current), head_sha: source }, release: clone(release),
    asset: clone(asset), listing: [clone(asset)], artifact: transferArtifact(),
    carrier: Buffer.from('not the immutable carrier'), successor: Buffer.from('not the original successor'),
    forbidPrivate: false };
  state.artifact.workflow_run.head_sha = source;
  const github = { rest: {
    actions: {
      getWorkflowRun: async ({ run_id }) => {
        calls.push('run:' + run_id);
        return { data: run_id === ctx.runId ? state.current : producer(Object.values(p.artifacts).find(v => v.run === run_id)).run };
      },
      getJobForWorkflowRun: async ({ job_id }) => {
        calls.push('job:' + job_id); return { data: producer(Object.values(p.artifacts).find(v => v.job === job_id)).job };
      },
      getArtifact: async ({ artifact_id }) => {
        calls.push('artifact:' + artifact_id);
        return { data: artifact_id === 987654 ? state.artifact : producer(Object.values(p.artifacts).find(v => v.artifact === artifact_id)).artifact };
      },
      downloadArtifact: async ({ artifact_id, archive_format }) => {
        calls.push('download:' + artifact_id); assert.equal(artifact_id, p.artifacts.assembly17.artifact);
        assert.equal(archive_format, 'zip'); return { data: state.successor };
      },
    },
    git: { getCommit: async ({ commit_sha }) => {
      calls.push('commit:' + commit_sha); return { data: producer(Object.values(p.artifacts).find(v => v.source === commit_sha)).commit };
    } },
    repos: {
      getRelease: async args => {
        if (state.forbidPrivate) throw Error('Native private release query forbidden');
        calls.push('release'); assert.equal(args.release_id, 411494394); return { data: state.release };
      },
      listReleaseAssets: async args => {
        if (state.forbidPrivate) throw Error('Native private listing forbidden');
        calls.push('listing'); assert.equal(args.per_page, 100); assert.equal(args.page, 1); return { data: state.listing };
      },
      getReleaseAsset: async args => {
        if (state.forbidPrivate) throw Error('Native private asset query forbidden');
        assert.equal(args.asset_id, e.asset);
        if (args.headers) { calls.push('asset-binary'); assert.equal(args.headers.accept, 'application/octet-stream'); return { data: state.carrier }; }
        calls.push('asset-metadata'); return { data: state.asset };
      },
    },
  } };
  function put(file, body, mode = 0o600) {
    fs.writeFileSync(file, body, { flag: 'wx', mode });
  }
  function stage(body = state.carrier, mode = 0o644) {
    const dir = path.join(temp, 'native-linux-changed-mcp-delivery'); fs.mkdirSync(dir, { mode: 0o755 });
    const api = { ...deliveryRecord(), source };
    put(path.join(dir, 'delivery-api.json'), c.canonical(api), mode); put(path.join(dir, 'signedDeb17.zip'), body, mode);
    return dir;
  }
  return { root, workspace, temp, context: ctx, env: values, github, state, calls, writes, modes, opened, put, stage };
}

test('collector proves actual Git-source digest before its first API, without artifact-ID admission', async t => {
  const f = routeFixture(t); f.env.CREATOR_CHANGED_MCP_SOURCE_RECEIPT_SHA256 = 'f'.repeat(64);
  await assert.rejects(c.collectDelivery({ github: f.github, context: f.context, raw, env: f.env }));
  assert.deepEqual(f.calls, []); assert.deepEqual(fs.readdirSync(f.temp), []);
});
test('collector refuses a foreign current harness before any draft query', async t => {
  const f = routeFixture(t); f.state.current.head_sha = p.baseline.source;
  await assert.rejects(c.collectDelivery({ github: f.github, context: f.context, raw, env: f.env }));
  assert.deepEqual(f.calls, ['run:' + context.runId]); assert.deepEqual(fs.readdirSync(f.temp), []);
});
test('collector closes metadata gates before binary acquisition', async t => {
  const f = routeFixture(t); f.state.asset.digest = 'sha256:' + 'f'.repeat(64);
  await assert.rejects(c.collectDelivery({ github: f.github, context: f.context, raw, env: f.env }));
  assert.deepEqual(f.calls, ['run:' + context.runId, 'release', 'listing', 'asset-metadata']);
  assert.deepEqual(fs.readdirSync(f.temp), []);
});
test('collector exact call order refuses wrong bytes before creating an output directory', async t => {
  const f = routeFixture(t);
  await assert.rejects(c.collectDelivery({ github: f.github, context: f.context, raw, env: f.env }));
  assert.deepEqual(f.calls, ['run:' + context.runId, 'release', 'listing', 'asset-metadata', 'asset-binary']);
  assert.deepEqual(fs.readdirSync(f.temp), []);
});
for (const id of [undefined, '', '0', '01', '-1', '9007199254740992', 'other']) {
  test('native artifact ID refuses before API: ' + String(id), async t => {
    const f = routeFixture(t); f.env.CREATOR_CHANGED_MCP_DELIVERY_ARTIFACT = id;
    await assert.rejects(c.run({ github: f.github, context: f.context, raw, env: f.env }));
    assert.deepEqual(f.calls, []);
  });
}
test('native foreign delivery association refuses before staged-input access or any download', async t => {
  const f = routeFixture(t); f.env.CREATOR_CHANGED_MCP_DELIVERY_ARTIFACT = '987654';
  f.state.forbidPrivate = true; f.state.artifact.workflow_run.head_sha = p.baseline.source;
  await assert.rejects(c.run({ github: f.github, context: f.context, raw, env: f.env }));
  assert.deepEqual(f.calls, ['run:' + context.runId, 'artifact:987654']);
});
for (const [label, mutate] of [
  ['extra member', (f, dir) => f.put(path.join(dir, 'extra.json'), Buffer.from('{}'))],
  ['foreign owner', (f, dir) => f.modes.set(path.join(dir, 'delivery-api.json'), { mode: 0o644, uid: process.getuid() + 1 })],
  ['group write', (f, dir) => f.modes.set(path.join(dir, 'delivery-api.json'), { mode: 0o664, uid: process.getuid() })],
  ['executable file', (f, dir) => f.modes.set(path.join(dir, 'delivery-api.json'), { mode: 0o755, uid: process.getuid() })],
]) test('native fixed staged pair refuses ' + label + ' before original producer queries', async t => {
  const f = routeFixture(t); f.env.CREATOR_CHANGED_MCP_DELIVERY_ARTIFACT = '987654'; f.state.forbidPrivate = true;
  const dir = f.stage(); mutate(f, dir);
  await assert.rejects(c.run({ github: f.github, context: f.context, raw, env: f.env }));
  assert.deepEqual(f.calls, ['run:' + context.runId, 'artifact:987654']);
});
for (const mode of [0o600, 0o644]) test('staged explicit artifact mode is accepted only on the new owned read path: ' + mode, t => {
  const f = routeFixture(t), file = path.join(f.temp, 'body'); f.put(file, Buffer.from('data'), mode);
  assert.equal(c.regular(file, 4, { owned: true, publicArtifact: true }).toString(), 'data');
  if (mode === 0o644) assert.throws(() => c.regular(file, 4, { owned: true }));
});

for (const entry of ['collectDelivery', 'run']) {
  test(entry + ' rejects a dirty actual tracked Git blob before all APIs', async t => {
    const f = routeFixture(t); f.env.CREATOR_CHANGED_MCP_DELIVERY_ARTIFACT = '987654';
    fs.writeFileSync(path.join(f.workspace, 'source.txt'), 'changed after source review\n');
    await assert.rejects(c[entry]({ github: f.github, context: f.context, raw, env: f.env }), /Checkout differs/);
    assert.deepEqual(f.calls, []); assert.deepEqual(fs.readdirSync(f.temp), []);
  });
  test(entry + ' rejects an external source-receipt digest mismatch before all APIs', async t => {
    const f = routeFixture(t); f.env.CREATOR_CHANGED_MCP_DELIVERY_ARTIFACT = '987654';
    f.env.CREATOR_CHANGED_MCP_SOURCE_RECEIPT_SHA256 = 'e'.repeat(64);
    await assert.rejects(c[entry]({ github: f.github, context: f.context, raw, env: f.env }), /Independently reviewed source receipt/);
    assert.deepEqual(f.calls, []); assert.deepEqual(fs.readdirSync(f.temp), []);
  });
  test(entry + ' rejects a different joined profile before all APIs', async t => {
    const f = routeFixture(t); f.env.CREATOR_CHANGED_MCP_DELIVERY_ARTIFACT = '987654';
    const different = Buffer.from(raw); different[100] ^= 1;
    await assert.rejects(c[entry]({ github: f.github, context: f.context, raw: different, env: f.env }));
    assert.deepEqual(f.calls, []); assert.deepEqual(fs.readdirSync(f.temp), []);
  });
}
for (const name of ['delivery-api.json', 'signedDeb17.zip']) {
  test('native staged pair refuses a real hardlink without opening it: ' + name, async t => {
    const f = routeFixture(t); f.env.CREATOR_CHANGED_MCP_DELIVERY_ARTIFACT = '987654'; f.state.forbidPrivate = true;
    const dir = f.stage(), file = path.join(dir, name);
    fs.linkSync(file, path.join(f.root, 'retained-hardlink'));
    assert.equal(fs.lstatSync(file).nlink, 2);
    f.opened.length = 0;
    await assert.rejects(c.run({ github: f.github, context: f.context, raw, env: f.env }));
    assert.deepEqual(f.calls, ['run:' + context.runId, 'artifact:987654']);
    assert.equal(f.opened.includes(file), false);
  });
}
for (const [label, mutate] of [
  ['wrong receipt source', (f, dir) => {
    const api = { ...deliveryRecord(), source: p.baseline.source };
    fs.writeFileSync(path.join(dir, 'delivery-api.json'), c.canonical(api));
  }],
  ['wrong receipt attempt', (f, dir) => {
    const api = { ...deliveryRecord(), source: f.context.sha, attempt: 2 };
    fs.writeFileSync(path.join(dir, 'delivery-api.json'), c.canonical(api));
  }],
  ['directory instead of a regular receipt', (f, dir) => {
    const file = path.join(dir, 'delivery-api.json'); fs.unlinkSync(file); fs.mkdirSync(file);
  }],
  ['foreign staged directory owner', (f, dir) => f.modes.set(dir, { mode: 0o755, uid: process.getuid() + 1 })],
  ['group-writable staged directory', (f, dir) => f.modes.set(dir, { mode: 0o775, uid: process.getuid() })],
  ['wrong carrier bytes', () => {}],
]) test('native fixed staged pair refuses ' + label + ' without private fallback', async t => {
  const f = routeFixture(t); f.env.CREATOR_CHANGED_MCP_DELIVERY_ARTIFACT = '987654'; f.state.forbidPrivate = true;
  const dir = f.stage(); mutate(f, dir);
  await assert.rejects(c.run({ github: f.github, context: f.context, raw, env: f.env }));
  assert.deepEqual(f.calls, ['run:' + context.runId, 'artifact:987654']);
  assert.equal(fs.existsSync(path.join(f.temp, 'native-linux-migrated-update-input')), false);
});
test('native fixed staged directory refuses a real symlink or Windows junction', async t => {
  const f = routeFixture(t); f.env.CREATOR_CHANGED_MCP_DELIVERY_ARTIFACT = '987654'; f.state.forbidPrivate = true;
  const staged = f.stage(), target = path.join(f.root, 'retained-stage'); fs.renameSync(staged, target);
  fs.symlinkSync(target, staged, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(fs.lstatSync(staged).isSymbolicLink(), true);
  await assert.rejects(c.run({ github: f.github, context: f.context, raw, env: f.env }));
  assert.deepEqual(f.calls, ['run:' + context.runId, 'artifact:987654']);
});

let retainedCarrier, retainedA1, retainedB17;
function retained(t, variable, pin) {
  const file = process.env[variable];
  if (!file) { t.skip('Retained actual immutable ZIP fixture not supplied; no download or native claim'); return null; }
  const bytes = fs.readFileSync(file); assert.equal(bytes.length, pin.size); assert.equal(c.hash(bytes), pin.sha256); return bytes;
}
test('collector retained actual ZIP writes exactly two fresh600 files after all five read-only API calls', async t => {
  retainedCarrier ||= retained(t, 'CREATOR_CHANGED_MCP_TEST_CARRIER', e.zip); if (!retainedCarrier) return;
  const f = routeFixture(t); f.state.carrier = retainedCarrier;
  const result = await c.collectDelivery({ github: f.github, context: f.context, raw, env: f.env });
  assert.equal(result.dataOnly, true); assert.equal(result.releaseReady, false);
  const dir = path.join(f.temp, 'native-linux-changed-mcp-delivery');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['delivery-api.json', 'signedDeb17.zip']);
  assert.equal(fs.readFileSync(path.join(dir, 'signedDeb17.zip')).equals(retainedCarrier), true);
  c.deliveryAPI(fs.readFileSync(path.join(dir, 'delivery-api.json')), p, f.context, f.env);
  assert.deepEqual(f.calls, ['run:' + context.runId, 'release', 'listing', 'asset-metadata', 'asset-binary']);
  const output = f.writes.filter(row => path.dirname(row.file) === dir);
  assert.equal(output.length, 2); assert.ok(output.every(row => row.mode === 0o600 && row.flag === 'wx'));
  await assert.rejects(c.collectDelivery({ github: f.github, context: f.context, raw, env: f.env }), /EEXIST/);
});
test('native retained actual A1/B017/staged carrier keeps five C files and downloads only original B017', async t => {
  retainedCarrier ||= retained(t, 'CREATOR_CHANGED_MCP_TEST_CARRIER', e.zip); if (!retainedCarrier) return;
  retainedA1 ||= retained(t, 'CREATOR_CHANGED_MCP_TEST_A1_ZIP', p.artifacts.assembly16.zip); if (!retainedA1) return;
  retainedB17 ||= retained(t, 'CREATOR_CHANGED_MCP_TEST_B17_ZIP', p.artifacts.assembly17.zip); if (!retainedB17) return;
  const f = routeFixture(t); f.state.forbidPrivate = true; f.state.successor = retainedB17;
  f.env.CREATOR_CHANGED_MCP_DELIVERY_ARTIFACT = '987654'; f.stage(retainedCarrier, 0o644);
  const incoming = path.join(f.temp, 'native-linux-production-016-input'); fs.mkdirSync(incoming, { mode: 0o700 });
  f.put(path.join(incoming, 'profile.json'), fs.readFileSync(path.join(__dirname, 'fixtures/journal-a-native-incoming.UNBOUND.json')));
  f.put(path.join(incoming, 'assembly.zip'), retainedA1);
  const result = await c.run({ github: f.github, context: f.context, raw, env: f.env });
  const output = path.join(f.temp, 'native-linux-migrated-update-input');
  assert.deepEqual(fs.readdirSync(output).sort(), ['acquisition.json', 'assembly17.zip', 'profile.json', 'signedDeb17.zip', 'source-receipt.json']);
  assert.deepEqual(result.downloadedRoles, ['assembly17']); assert.equal(result.deliveryArtifact.id, 987654);
  assert.deepEqual(f.calls, ['run:' + context.runId, 'artifact:987654',
    ...['assembly16', 'assembly17'].flatMap(role => { const row = p.artifacts[role];
      return ['run:' + row.run, 'job:' + row.job, 'artifact:' + row.artifact, 'commit:' + row.source]; }),
    'download:' + p.artifacts.assembly17.artifact]);
  const acquisition = JSON.parse(fs.readFileSync(path.join(output, 'acquisition.json')));
  assert.deepEqual(Object.keys(acquisition).sort(), ['schemaVersion', 'source', 'run', 'attempt', 'profileSha256',
    'sourceReceiptSha256', 'harnessRun', 'proof', 'release', 'asset', 'dataOnly', ...Object.keys(c.FALSE)].sort());
  assert.equal(acquisition.source, f.context.sha); assert.equal(acquisition.asset.id, e.asset);
  assert.ok(f.writes.filter(row => path.dirname(row.file) === output).every(row => row.mode === 0o600 && row.flag === 'wx'));
  assert.equal(fs.readFileSync(path.join(output, 'signedDeb17.zip')).equals(retainedCarrier), true);
  await assert.rejects(c.run({ github: f.github, context: f.context, raw, env: f.env }), /EEXIST/);
  assert.equal(f.calls.filter(call => call.startsWith('download:')).length, 1);
  assert.equal(fs.readFileSync(path.join(output, 'signedDeb17.zip')).equals(retainedCarrier), true);
});
