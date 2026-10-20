'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('./private-linux-update-fixture-017-metadata.cjs');
const { data, json } = require('./fixtures/private-linux-update-fixture-017.cjs');

test('017 canonical runtime and wrapper preserve the entire original016 handoff/carrier/provenance', () => {
  const f = data(), original = json(f.handoff), prepared = json(f.prepared), files = json(f.originalRecords);
  const derived = m.validateDerivation(f.files['derivation017.json'], f.plan, f.handoff, f.prepared, f.originalRecords,
    f.files['runtime017.json'], f.files['runtime017.minisig']);
  assert.deepEqual(derived.modules, f.manifest.modules);
  assert.equal(JSON.parse(f.files['runtime017.json']).hubVersion, '0.1.17');
  assert.equal(f.handoff.hubVersion, '0.1.16'); assert.equal(f.prepared.hubVersion, '0.1.16');
  assert.equal(f.handoff.apiProof.expected.version, '0.1.16');
  assert.deepEqual(json(f.handoff), original); assert.deepEqual(json(f.prepared), prepared); assert.deepEqual(json(f.originalRecords), files);
  const wrapper = m.parse(f.files['derivation017.json']);
  for (const key of ['nativeGuiAccepted', 'migrationAccepted', 'authenticationAccepted', 'signedUpdateAccepted', 'restartAccepted', 'releaseReady']) assert.equal(wrapper[key], false);
  for (const key of Object.keys(f.manifest.managedRouting.files)) if (!key.startsWith('routing/runtime.')) assert.equal(derived.managedRouting.files[key], f.manifest.managedRouting.files[key]);
});

test('017 plans reject altered versions, original byte pins, unknown fields and acceptance relabels', () => {
  for (const mutate of [p => { p.hubVersion = '0.1.16'; }, p => { p.platform = 'macos'; }, p => { p.releaseReady = true; },
    p => { p.authenticationAccepted = true; }, p => { p.extra = 1; }, p => { p.rootSource.sourceTree = 'bad'; },
    p => { p.original016['modules.tar.gz'].size = true; }, p => { p.original016['unknown'] = p.original016['handoff.json']; }]) {
    const f = data(); mutate(f.plan); assert.throws(() => m.validatePlan(f.plan));
  }
  const f = data(); f.originalRecords['modules.tar.gz'] = { ...f.originalRecords['modules.tar.gz'], sha256: 'f'.repeat(64) };
  assert.throws(() => m.validateOriginal(f.plan, f.handoff, f.prepared, f.originalRecords), /Original016 bytes/);
  const relabelled = data(); relabelled.handoff.hubVersion = '0.1.17';
  assert.throws(() => m.validateOriginal(relabelled.plan, relabelled.handoff, relabelled.prepared, relabelled.originalRecords));
});

test('new signatures/source/tree/runtime are all bound by the wrapper, never adopted from old metadata', () => {
  const f = data();
  for (const mutate of [x => { x.rootSource.sourceTree = 'a'.repeat(40); }, x => { x.runtime017.signature.sha256 = 'b'.repeat(64); },
    x => { x.original016.files['modules.tar.gz'].sha256 = 'c'.repeat(64); }, x => { x.releaseReady = true; },
    x => { x.builtinManifest.modules.setup.version = '0.0.0'; }]) {
    const changed = m.parse(f.files['derivation017.json']); mutate(changed);
    assert.throws(() => m.validateDerivation(json(changed), f.plan, f.handoff, f.prepared, f.originalRecords,
      f.files['runtime017.json'], f.files['runtime017.minisig']));
  }
  assert.throws(() => m.derivationBytes(f.plan, f.handoff, f.prepared, f.originalRecords,
    f.files['routing/runtime.json'], f.files['runtime017.minisig']), /exact017 body/);
  assert.throws(() => m.parse(Buffer.from('{"x":1,"x":2}'), false), /duplicate/);
  assert.throws(() => m.parse(Buffer.concat([f.files['derivation017.json'], Buffer.from('\n')])), /Noncanonical/);
});

test('original/new metadata use the existing trusted verifier for all five signatures; no local signing interface', () => {
  const f = data(), records = Object.fromEntries(Object.entries(f.files).map(([name, bytes]) => [name, m.record(bytes)]));
  const paths = Object.fromEntries(Object.keys(f.files).map(name => [name, `/owned-input/${name}`])), calls = [];
  m.verifySignatures(paths, records, '/trusted/verify-package-input', (program, args) => {
    calls.push(args); assert.equal(program, '/trusted/verify-package-input');
    const name = args[0].slice('/owned-input/'.length);
    return `Verified trusted package signature: ${records[name].sha256}. No activation or client changes.`;
  });
  assert.equal(calls.length, 5);
  assert.deepEqual(calls[0], [paths['handoff.json'], paths['handoff.minisig']]);
  assert.deepEqual(calls[4], [paths['derivation017.json'], paths['derivation017.minisig']]);
  let count = 0;
  assert.throws(() => m.verifySignatures(paths, records, '/trusted/verify-package-input', () => { count++; return 'signature rejected'; }), /trusted signature verifier/);
  assert.equal(count, 1);
  assert.equal(Object.hasOwn(m, 'signingKey'), false); assert.equal(Object.hasOwn(m, 'signDetached'), false);
});

test('baseline and actual017 API identities are independently bound to source/tree/run/attempt/job/artifact', () => {
  const f = data(); m.validateApi(f.plan, f.baselineApi, f.rootApi);
  for (const mutate of [b => { b.run.head_sha = 'f'.repeat(40); }, b => { b.job.head_sha = 'f'.repeat(40); }, b => { b.job.run_attempt++; },
    b => { b.artifact.digest = 'sha256:' + 'f'.repeat(64); }, b => { b.commit.tree.sha = 'a'.repeat(40); },
    b => { b.artifact.expired = true; }, b => { b.job.id++; }]) {
    const copy = structuredClone(f.baselineApi); mutate(copy); assert.throws(() => m.validateApi(f.plan, copy, f.rootApi));
  }
  assert.throws(() => m.validateApi(f.plan, f.baselineApi, { commit: { ...f.rootApi.commit, sha: 'a'.repeat(40) } }));
});

test('baseline production016 helper/portable proofs must bind the same independently pinned raw Root and source', () => {
  const f = data(); m.validateBaseline(f.plan, f.baseBytes, f.handoff);
  const changed = { ...f.baseBytes, rawHub: Buffer.from('wrong Root') };
  assert.throws(() => m.validateBaseline(f.plan, changed, f.handoff), /Baseline016 member differs/);
  for (const mutate of [r => { r.compiledFeatures = ['integrated-features']; }, r => { r.productionMigration.staging.helperFeature = 'experimental-transaction'; },
    r => { r.productionMigration.sourceTree = 'a'.repeat(40); }, r => { r.privateModulesResigned = true; },
    r => { r.handoffSha256 = 'f'.repeat(64); }, r => { r.privateSource.sourceCommit = 'f'.repeat(40); }]) {
    const other = data(), receipt = JSON.parse(other.baseBytes.assemblyReceipt); mutate(receipt);
    other.baseBytes.assemblyReceipt = json(receipt); other.plan.baseline016.pins.assemblyReceipt = m.record(other.baseBytes.assemblyReceipt);
    assert.throws(() => m.validateBaseline(other.plan, other.baseBytes, other.handoff));
  }
  const other = data(), manifest = JSON.parse(other.baseBytes.manifest);
  manifest.modules.mcp.version = '0.0.0';
  const previous = other.baseBytes.manifest;
  other.baseBytes.manifest = json(manifest);
  other.baseBytes.rawHub = Buffer.concat([other.baseBytes.rawHub.subarray(0, -previous.length), other.baseBytes.manifest]);
  for (const name of ['manifest', 'rawHub']) other.plan.baseline016.pins[name] = m.record(other.baseBytes[name]);
  const receipt = JSON.parse(other.baseBytes.assemblyReceipt);
  receipt.productionMigration.rawHub = receipt.portableHostBuild.rawHub = other.plan.baseline016.pins.rawHub;
  other.baseBytes.assemblyReceipt = json(receipt); other.plan.baseline016.pins.assemblyReceipt = m.record(other.baseBytes.assemblyReceipt);
  assert.throws(() => m.validateBaseline(other.plan, other.baseBytes, other.handoff), /Baseline private\/routing bytes differ/);
});
