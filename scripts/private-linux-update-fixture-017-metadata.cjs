'use strict';
// Canonical bodies and provenance checks only; no key selection or signing.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fixture = require('./private-linux-update-fixture-017.cjs');
const original = require('./assemble-unix-payload.cjs');
const builder = require('./build-unified.cjs');
const { runtimeDescriptor } = require('./mcp-runtime-descriptor.cjs');
const native016 = require('./native-linux-016-input.cjs');

const PRODUCT = 'com.creatorworks.hub.private017-derived-handoff';
const BASELINE_MEMBERS = Object.freeze({ deb: 'native-packages/Creator Hub_0.1.16_amd64.deb',
  rawHub: 'creator-hub', manifest: 'builtin-manifest.json', assemblyReceipt: 'signed-unix-assembly.json' });
const BASELINE_PINS = ['deb', 'rawHub', 'hub', 'manifest', 'assemblyReceipt', 'helper', 'policy', 'service'];
const INPUTS = [...original.INPUTS, 'plan.json', 'runtime017.json', 'runtime017.minisig',
  'derivation017.json', 'derivation017.minisig', 'baseline016.zip', 'baseline016-api.json', 'root017-api.json'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const record = bytes => ({ size: bytes.length, sha256: hash(bytes) });
function keys(value, names) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Object required');
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), 'Private017 fields differ');
}
function sha(value, length = 64) { assert.match(value, new RegExp(`^[a-f0-9]{${length}}$`)); }
function id(value) { assert.ok(Number.isSafeInteger(value) && value > 0); }
function pin(value, max = 256 * 1024 * 1024) {
  keys(value, ['size', 'sha256']); id(value.size); assert.ok(value.size <= max); sha(value.sha256);
}
function parse(bytes, pretty = true, limit = 128 * 1024) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= limit, 'Bounded canonical metadata required');
  const value = JSON.parse(bytes.toString('utf8'));
  assert.equal(bytes.toString('utf8'), JSON.stringify(value, null, pretty ? 2 : undefined), 'Noncanonical or duplicate metadata');
  return value;
}
function validatePlan(p) {
  keys(p, ['schemaVersion', 'product', 'hubVersion', 'platform', 'arch', 'rootSource', 'original016', 'baseline016', ...Object.keys(fixture.FLAGS)]);
  assert.equal(p.schemaVersion, 1); assert.equal(p.product, PRODUCT); assert.equal(p.hubVersion, fixture.VERSION);
  assert.equal(p.platform, 'linux'); assert.equal(p.arch, 'x86_64');
  keys(p.rootSource, ['sourceCommit', 'sourceTree']); sha(p.rootSource.sourceCommit, 40); sha(p.rootSource.sourceTree, 40);
  keys(p.original016, original.INPUTS);
  for (const name of original.INPUTS) pin(p.original016[name], name === 'modules.tar.gz' ? 256 * 1024 * 1024 : name.endsWith('.minisig') ? 4096 : 128 * 1024);
  keys(p.baseline016, ['assembly', 'pins']);
  const a = p.baseline016.assembly;
  keys(a, ['sourceCommit', 'sourceTree', 'runId', 'runAttempt', 'jobId', 'artifactId', 'zipBytes', 'zipSha256']);
  sha(a.sourceCommit, 40); sha(a.sourceTree, 40); sha(a.zipSha256);
  for (const name of ['runId', 'runAttempt', 'jobId', 'artifactId', 'zipBytes']) id(a[name]);
  assert.ok(a.zipBytes <= 768 * 1024 * 1024);
  keys(p.baseline016.pins, BASELINE_PINS);
  for (const name of BASELINE_PINS) pin(p.baseline016.pins[name]);
  for (const [name, value] of Object.entries(fixture.FLAGS)) assert.equal(p[name], value, 'No acceptance may be supplied by a derivation plan');
  return p;
}
function validateApi(p, baseline, root) {
  validatePlan(p);
  keys(baseline, ['run', 'job', 'artifact', 'commit']); keys(root, ['commit']);
  native016.artifactBinding(baseline.run, baseline.job, baseline.artifact, p.baseline016.assembly);
  assert.equal(baseline.job.head_sha, p.baseline016.assembly.sourceCommit, 'Baseline job source differs');
  for (const [actual, expected] of [[baseline.commit, p.baseline016.assembly], [root.commit, p.rootSource]]) {
    assert.equal(actual.sha, expected.sourceCommit); assert.equal(actual.tree.sha, expected.sourceTree);
  }
}
function validateOriginal(p, handoff, prepared, records) {
  validatePlan(p); keys(records, original.INPUTS);
  for (const name of original.INPUTS) assert.deepEqual(records[name], p.original016[name], 'Original016 bytes changed');
  const manifest = original.validateHandoff(handoff, prepared, records, 'linux', 'x86_64', '0.1.16');
  assert.equal(handoff.apiProof.expected.version, '0.1.16');
  return manifest;
}
function runtimeBytes(manifest) {
  return Buffer.from(JSON.stringify(runtimeDescriptor(manifest, fixture.VERSION)));
}
function derivationBytes(p, handoff, prepared, records, runtime, signature) {
  const manifest = validateOriginal(p, handoff, prepared, records);
  assert.ok(runtime.equals(runtimeBytes(manifest)), 'New runtime must be the exact017 body for the original private bytes');
  assert.ok(Buffer.isBuffer(signature) && signature.length > 0 && signature.length <= 4096);
  const derived = structuredClone(manifest);
  derived.managedRouting.files['routing/runtime.json'] = hash(runtime);
  derived.managedRouting.files['routing/runtime.minisig'] = hash(signature);
  const body = { schemaVersion: 1, product: PRODUCT, hubVersion: fixture.VERSION, platform: 'linux', arch: 'x86_64',
    plan: record(Buffer.from(JSON.stringify(p, null, 2))), rootSource: p.rootSource,
    original016: { source: handoff.source, files: Object.fromEntries(original.INPUTS.map(name =>
      [name, { size: records[name].size, sha256: records[name].sha256 }])) }, baseline016: p.baseline016,
    runtime017: { body: record(runtime), signature: record(signature) }, builtinManifest: derived, ...fixture.FLAGS };
  return Buffer.from(JSON.stringify(body, null, 2));
}
function validateDerivation(bytes, p, handoff, prepared, records, runtime, signature) {
  parse(bytes);
  assert.ok(bytes.equals(derivationBytes(p, handoff, prepared, records, runtime, signature)), 'Derivation differs from approved original/source/runtime');
  return JSON.parse(bytes).builtinManifest;
}
function verifySignatures(files, records, verifier, execute) {
  for (const [body, sig] of [['handoff.json', 'handoff.minisig'], ['routing/router.json', 'routing/router.minisig'],
    ['routing/runtime.json', 'routing/runtime.minisig'], ['runtime017.json', 'runtime017.minisig'], ['derivation017.json', 'derivation017.minisig']]) {
    assert.equal(String(execute(verifier, [files[body], files[sig]])).trim(),
      `Verified trusted package signature: ${records[body].sha256}. No activation or client changes.`, 'Existing trusted signature verifier refused');
  }
}
function validateBaseline(p, bytes, handoff) {
  validatePlan(p); keys(bytes, Object.keys(BASELINE_MEMBERS));
  for (const name of Object.keys(BASELINE_MEMBERS)) assert.deepEqual(record(bytes[name]), p.baseline016.pins[name], 'Baseline016 member differs');
  const receipt = JSON.parse(bytes.assemblyReceipt), manifest = JSON.parse(bytes.manifest);
  assert.equal(receipt.hubVersion, '0.1.16'); assert.equal(receipt.platform, 'linux'); assert.equal(receipt.arch, 'x86_64');
  assert.equal(receipt.assemblyCommit, p.baseline016.assembly.sourceCommit);
  assert.equal(receipt.handoffSha256, p.original016['handoff.json'].sha256, 'Baseline used a different original016 handoff');
  assert.deepEqual(receipt.privateSource, handoff.source, 'Baseline private producer differs');
  assert.deepEqual(receipt.compiledFeatures, [...fixture.FEATURES]);
  assert.equal(receipt.privateModulesRecompiled, false); assert.equal(receipt.privateModulesResigned, false);
  assert.equal(receipt.nativeGuiAccepted, false); assert.equal(receipt.releaseReady, false);
  builder.validateProductionBuildProof(receipt.productionMigration, receipt.assemblyCommit, [...fixture.FEATURES]);
  builder.validatePortableBuildProof(receipt.portableHostBuild, receipt.assemblyCommit, [...fixture.FEATURES],
    p.baseline016.pins.rawHub, p.baseline016.assembly.sourceTree);
  assert.equal(receipt.productionMigration.sourceTree, p.baseline016.assembly.sourceTree);
  assert.deepEqual(receipt.productionMigration.rawHub, p.baseline016.pins.rawHub);
  for (const [name, key] of [['/usr/libexec/creator-hub-deb-retirement-helper', 'helper'],
    ['/usr/share/polkit-1/actions/com.creatorworks.hub.deb-retirement.policy', 'policy']]) {
    const file = receipt.productionMigration.staging.files[name];
    assert.deepEqual({ size: file.size, sha256: file.sha256 }, p.baseline016.pins[key]);
  }
  assert.equal(manifest.platform, 'linux'); assert.equal(manifest.arch, 'x86_64');
  const originalManifest = structuredClone(manifest); delete originalManifest.payloadArchive;
  assert.deepEqual(originalManifest, handoff.builtinManifest, 'Baseline private/routing bytes differ from original016');
  assert.ok(bytes.rawHub.includes(bytes.manifest), 'Baseline Root does not embed the exact manifest');
  return { receipt, manifest };
}

module.exports = { PRODUCT, BASELINE_MEMBERS, BASELINE_PINS, INPUTS, hash, record, keys, pin, parse,
  validatePlan, validateApi, validateOriginal, runtimeBytes, derivationBytes, validateDerivation, verifySignatures, validateBaseline };
