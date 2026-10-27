'use strict';
// Synthetic buffers and mocked API data only. No downloaded or executed product.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const L = require('./native-linux-production-016-input.cjs');
const old = require('./native-linux-016-input.cjs');
const retirement = require('./linux-retirement-package.cjs');
const PRODUCTION_PRIVATE = { sourceCommit: 'a89ed2b90278b33bebd0b4ba29d87904d2fe683b', runId: 40400463940, runAttempt: 1 };
const clone = x => JSON.parse(JSON.stringify(x));
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const pin = b => ({ size: b.length, sha256: hash(b) });
function fixture() {
  const raw = Buffer.alloc(160); Buffer.from([127, 69, 76, 70, 2, 1, 1]).copy(raw); raw[18] = 0x3e;
  const marker = '__TAURI_BUNDLE_TYPE_VAR_UNK'; raw.write(marker, 80, 'ascii');
  const hub = Buffer.from(raw); hub.write('DEB', 80 + marker.length - 3, 'ascii');
  const p = { schemaVersion: 1, cohort: L.COHORT, mode: 'pages', assembly: { sourceCommit: 'a'.repeat(40), sourceTree: 'e'.repeat(40),
    runId: 1, runAttempt: 1, jobId: 2, artifactId: 3, zipBytes: 100, zipSha256: 'b'.repeat(64) },
  pins: Object.fromEntries(L.PINS.map(k => [k, { size: 1, sha256: 'c'.repeat(64) }])) };
  p.pins.rawHub = pin(raw); p.pins.hub = pin(hub); p.pins.service = pin(retirement.SERVICE_BYTES);
  const files = Object.fromEntries([['helper', retirement.HELPER, 0o755], ['policy', retirement.POLICY, 0o644]].map(([key, member, mode]) =>
    [member, { ...p.pins[key], mode, uid: 0, gid: 0 }]));
  const staging = { schemaVersion: 2, acceptanceOnly: true, sourceCommit: p.assembly.sourceCommit, platform: 'linux', arch: 'x86_64',
    rootFeature: 'linux-production-migration', helperFeature: 'production-transaction', profile: L.COHORT,
    productionContract: clone(retirement.PRODUCTION_CONTRACT), files, ...retirement.FLAGS };
  const receipt = { schemaVersion: 1, product: 'com.creatorworks.hub.unix-signed-assembly', platform: 'linux', arch: 'x86_64', hubVersion: '0.1.16',
    assemblyCommit: p.assembly.sourceCommit, privateSource: { ...PRODUCTION_PRIVATE }, handoffSha256: 'd'.repeat(64), compiledFeatures: [...L.FEATURES],
    portableHostBuild: { schemaVersion: 1, version: '0.1.16', target: 'x86_64-unknown-linux-gnu', sourceCommit: p.assembly.sourceCommit,
      sourceTree: p.assembly.sourceTree, compiledFeatures: [...L.FEATURES], startupImageBinding: 1, rawHub: p.pins.rawHub },
    productionMigration: { schemaVersion: 1, profile: L.COHORT, sourceCommit: p.assembly.sourceCommit, sourceTree: p.assembly.sourceTree,
      compiledFeatures: [...L.FEATURES], rawHub: p.pins.rawHub, staging },
    mcpMode: 'writable', privateModulesRecompiled: false, privateModulesResigned: false, nativeGuiAccepted: false, releaseReady: false };
  return { p, receipt, raw, hub };
}
function context() {
  const c = { repo: { owner: 'BOBWORKS-XR', repo: 'CREATOR-HUB' }, eventName: 'workflow_dispatch', ref: L.REF, sha: 'f'.repeat(40) };
  const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512',
    GITHUB_EVENT_NAME: c.eventName, GITHUB_REF: c.ref, GITHUB_SHA: c.sha, RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64' };
  return { c, env };
}
test('production pins its own private payload and rejects the former payload receipt', () => {
  assert.deepEqual(L.PRIVATE, PRODUCTION_PRIVATE);
  assert.ok(Object.isFrozen(L.PRIVATE));
  assert.deepEqual(old.PRIVATE, { sourceCommit: '52e3a537c9d323c81ab259cb82b44bbe0828b414', runId: 39326776585, runAttempt: 1 });
  const { p, receipt } = fixture();
  L.proofs(receipt, p);
  for (const privateSource of [old.PRIVATE, { ...PRODUCTION_PRIVATE, sourceCommit: old.PRIVATE.sourceCommit },
    { ...PRODUCTION_PRIVATE, runId: old.PRIVATE.runId }, { ...PRODUCTION_PRIVATE, runAttempt: 2 }]) {
    assert.throws(() => L.proofs({ ...receipt, privateSource }, p), { code: 'ERR_ASSERTION' });
  }
});
test('production requests the new producer and rejects former or wrong-attempt API evidence before assembly access', async () => {
  const { c, env } = context(), p = fixture().p;
  const boundary = new Error('Private producer accepted; stop before assembly access');
  for (const identity of [PRODUCTION_PRIVATE, old.PRIVATE, { ...PRODUCTION_PRIVATE, runAttempt: 2 }]) {
    const calls = [];
    const repository = { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' };
    const github = { rest: { actions: { async getWorkflowRun({ run_id }) {
      calls.push(run_id);
      if (calls.length > 1) throw boundary;
      return { data: { id: identity.runId, head_sha: identity.sourceCommit, run_attempt: identity.runAttempt,
        status: 'completed', conclusion: 'success', path: '.github/workflows/unix-managed-payload.yml',
        head_branch: 'validation/unix-payload-016', event: 'push', repository, head_repository: repository } };
    } } } };
    const result = L.run({ github, context: c, env, profile: JSON.stringify(p) });
    if (identity === PRODUCTION_PRIVATE) {
      await assert.rejects(result, error => error === boundary);
      assert.deepEqual(calls, [PRODUCTION_PRIVATE.runId, p.assembly.runId]);
    } else {
      await assert.rejects(result, { code: 'ERR_ASSERTION' });
      assert.deepEqual(calls, [PRODUCTION_PRIVATE.runId]);
    }
  }
});
test('production schema is distinct, bounded and documents every exact pin', () => {
  const { p } = fixture(); L.validate(p); L.validate({ ...p, mode: 'migration-cancel' });
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, 'native-linux-production-016-input.schema.json')));
  assert.equal(schema.additionalProperties, false); assert.equal(schema.properties.cohort.const, L.COHORT);
  assert.deepEqual(schema.required, Object.keys(p));
  assert.deepEqual(schema.properties.assembly.required, Object.keys(p.assembly));
  assert.deepEqual(schema.properties.pins.required, L.PINS);
  assert.deepEqual(Object.keys(schema.properties.pins.properties), L.PINS);
  assert.deepEqual(schema.properties.mode.enum, ['pages', 'migration-cancel']);
  assert.equal(schema.$defs.pin.additionalProperties, false);
  assert.equal(schema.$defs.pin.properties.size.maximum, 256 * 1024 * 1024);
  assert.equal(schema.properties.assembly.properties.zipBytes.maximum, 300 * 1024 * 1024);
  const historical = clone(p); delete historical.cohort; delete historical.assembly.sourceTree; delete historical.pins.rawHub;
  old.validate(historical); assert.throws(() => L.validate(historical));
});
test('unknown fields, execution modes, unbound Root and invalid identities refuse', () => {
  for (const mutate of [p => p.mode = 'migration-approve', p => p.mode = 'signed-update', p => p.mode = 'flatpak',
    p => p.cohort = 'integrated-candidate', p => p.url = 'https://example.invalid', p => p.schemaVersion = true,
    p => delete p.assembly.sourceTree, p => p.assembly.sourceTree = 'x'.repeat(40), p => p.assembly.runId = true,
    p => p.assembly.zipBytes = 300 * 1024 * 1024 + 1, p => delete p.pins.rawHub,
    p => p.pins.rawHub.size = 63, p => p.pins.rawHub.size = 256 * 1024 * 1024 + 1,
    p => p.pins.rawHub.path = '/tmp/other', p => p.features = [...L.FEATURES]]) {
    const { p } = fixture(); mutate(p); assert.throws(() => L.validate(p));
  }
});
test('both actual production proofs must agree with the independent tree/raw Root and exact tuple', () => {
  const f = fixture(), good = L.inspectBuffers(f.receipt, f.p, f.raw, f.hub);
  assert.deepEqual(good.compiledFeatures, L.FEATURES); assert.equal(good.rawToPackaged, 'exact-tauri-bundle-marker-deb');
  for (const key of Object.keys(L.FLAGS)) assert.equal(good[key], false);
  for (const mutate of [r => delete r.productionMigration, r => delete r.portableHostBuild,
    r => r.productionMigration.sourceTree = '1'.repeat(40), r => r.portableHostBuild.sourceTree = '1'.repeat(40),
    r => r.productionMigration.rawHub = { size: 64, sha256: '1'.repeat(64) },
    r => r.portableHostBuild.rawHub = { size: 64, sha256: '1'.repeat(64) },
    r => r.assemblyCommit = '1'.repeat(40), r => r.hubVersion = '0.1.14', r => r.nativeGuiAccepted = true,
    r => r.releaseReady = true, r => r.privateSource.runId++, r => r.privateModulesResigned = true,
    r => r.productionMigration.staging.helperFeature = 'experimental-transaction',
    r => r.productionMigration.staging.productionContract.protocolVersion = 1,
    r => r.productionMigration.staging.files[retirement.HELPER].sha256 = '1'.repeat(64),
    r => r.productionMigration.staging.files[retirement.POLICY].mode = 0o666]) {
    const changed = clone(f.receipt); mutate(changed); assert.throws(() => L.proofs(changed, f.p));
  }
  for (const where of ['compiledFeatures', 'productionMigration', 'portableHostBuild']) {
    for (const features of [L.FEATURES.slice(0, -1), [...L.FEATURES, 'experimental-linux-migration'],
      [...L.FEATURES].reverse(), ['integrated-features', 'experimental-flatpak-host', 'experimental-linux-migration']]) {
      const r = clone(f.receipt);
      if (where === 'compiledFeatures') r[where] = features; else r[where].compiledFeatures = features;
      assert.throws(() => L.proofs(r, f.p));
    }
  }
});
test('packaged ELF may differ only by the single exact Tauri DEB marker', () => {
  for (const kind of ['byte', 'size', 'marker', 'architecture', 'duplicate-marker']) {
    const { p, receipt, raw, hub } = fixture();
    if (kind === 'byte') hub[40] ^= 1;
    if (kind === 'size') p.pins.hub.size++;
    if (kind === 'marker') hub.write('RPM', 102, 'ascii');
    if (kind === 'architecture') raw[18] = 0xb7;
    if (kind === 'duplicate-marker') raw.write('__TAURI_BUNDLE_TYPE_VAR_UNK', 120, 'ascii');
    // Re-pin modified bytes where applicable: independent hashing alone is not
    // enough to permit an arbitrary raw-to-packaged transformation.
    if (kind !== 'size') { p.pins.rawHub = pin(raw); p.pins.hub = pin(hub); receipt.productionMigration.rawHub = p.pins.rawHub; receipt.portableHostBuild.rawHub = p.pins.rawHub; }
    assert.throws(() => L.inspectBuffers(receipt, p, raw, hub), kind);
  }
  const f = fixture(); f.p.pins.service.sha256 = '1'.repeat(64); assert.throws(() => L.proofs(f.receipt, f.p));
});
test('invalid invocation or historical branch refuses before read-only API access', async () => {
  const { c, env } = context(); L.admission(c, env);
  let calls = 0;
  const github = { get rest() { calls++; throw Error('API must not be read'); } };
  for (const mutate of [p => p.mode = 'migration-approve', p => delete p.pins.rawHub, p => p.cohort = 'integrated-candidate']) {
    const { p } = fixture(); mutate(p); await assert.rejects(L.run({ github, context: c, env, profile: JSON.stringify(p) }));
  }
  await assert.rejects(L.run({ github, context: c, env, profile: ' '.repeat(16385) }));
  await assert.rejects(L.run({ github, context: { ...c, ref: old.REF }, env, profile: JSON.stringify(fixture().p) }));
  for (const field of ['GITHUB_REPOSITORY_ID', 'GITHUB_SHA', 'GITHUB_EVENT_NAME', 'RUNNER_ENVIRONMENT', 'RUNNER_ARCH']) {
    assert.throws(() => L.admission(c, { ...env, [field]: 'wrong' }));
  }
  assert.equal(calls, 0);
});
test('API commit tree and unchanged private source identities are separately verified', async () => {
  const { p } = fixture();
  const commits = [];
  const ids = { original: '0'.repeat(40), current: p.assembly.sourceTree, modules: '2'.repeat(40), native: '3'.repeat(40), src: '4'.repeat(40), nested: '5'.repeat(40) };
  const github = { rest: { git: {
    async getCommit({ commit_sha }) {
      commits.push(commit_sha);
      return { data: { sha: commit_sha, tree: { sha: commit_sha === PRODUCTION_PRIVATE.sourceCommit ? ids.original : ids.current } } };
    },
    async getTree({ tree_sha }) {
      let tree;
      if ([ids.original, ids.current].includes(tree_sha)) tree = [['modules', ids.modules], ['native', ids.native], ['src-tauri', ids.src]].map(([path, sha]) => ({ path, sha, type: 'tree' }));
      else if (tree_sha === ids.modules) tree = ['mcp', 'project-setup'].map(path => ({ path, sha: '6'.repeat(40), type: 'tree' }));
      else if (tree_sha === ids.native) tree = ['mcp-router', 'host_parent_macos.rs', 'plugins_retirement.rs', 'convergence-server-unix.rs'].map(path => ({ path, sha: '7'.repeat(40), type: path.endsWith('.rs') ? 'blob' : 'tree' }));
      else if (tree_sha === ids.src) tree = [{ path: 'src', sha: ids.nested, type: 'tree' }];
      else tree = ['module_archive.rs', 'catalog-key.pub'].map(path => ({ path, sha: '8'.repeat(40), type: 'blob' }));
      return { data: { truncated: false, tree } };
    },
  } } };
  assert.deepEqual(Object.keys(await L.sourceBinding(github, p.assembly)), old.PRIVATE_PATHS);
  assert.deepEqual(commits, [p.assembly.sourceCommit, PRODUCTION_PRIVATE.sourceCommit, p.assembly.sourceCommit]);
  await assert.rejects(L.sourceBinding(github, { ...p.assembly, sourceTree: '9'.repeat(40) }));
  const saved = github.rest.git.getTree;
  github.rest.git.getTree = async args => {
    const data = await saved(args); if (args.tree_sha === ids.current) data.data.tree.find(row => row.path === 'modules').sha = ids.native;
    return data;
  };
  await assert.rejects(L.sourceBinding(github, p.assembly));
});
test('production gate has no install, dispatch, controller, signer or shell execution path', () => {
  const input = fs.readFileSync(path.join(__dirname, 'native-linux-production-016-input.cjs'), 'utf8');
  assert.doesNotMatch(input, /child_process|execFile|spawn\(|dispatchWorkflow|updateRelease|createRelease|private.key|sign\(/);
  assert.match(input, /neutral\.artifactBinding/); assert.match(input, /neutral\.producer/);
  assert.match(input, /verifyLinuxHub\(raw, packaged, 'deb'\)/);
  assert.match(input, /validateProductionBuildProof/); assert.match(input, /validatePortableBuildProof/);
  assert.equal(old.REF, 'refs/heads/validation/native-linux-016');
  assert.deepEqual(old.PINS, L.PINS.slice(0, -1));
});
