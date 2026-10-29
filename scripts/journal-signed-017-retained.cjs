'use strict';
// Exact local evidence binding only; never downloads, verifies a signature or grants execution.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const SOURCE = 'a61e7b0152689b7fa25fd0f4fe3e7d3894751cc5';
const TREE = 'ab48fbce32accb627a5f5e0de2f496699c2317b4';
const CARRIER = Object.freeze({ name: 'signed-private-deb017-carrier-40903331594.zip', size: 64479116,
  sha256: '9719b4d8d205b4d8a61c0b4bb77c056110a227e7f0a8aa9aba23f7787da7bbde' });
const PINS = Object.freeze({
  'Creator_Hub_0.1.17_amd64-acceptance-only.deb': [64519358, '61a32fe588280366c3d6f8b76323764867bca8c3537d30a45c33ed2302be4a43'],
  'Creator_Hub_0.1.17_amd64-acceptance-only.deb.minisig': [329, 'f58b0587727cad13049642245eb7bb309b51dfd481366ee89245f290076dfce6'],
  'creator-hub-linux-x86_64-deb.json': [514, 'c2862a4b6c0c9d7d3dccc232079bf4436c0d8695e8a88ed8a3bccf6dad04a16c'],
  'creator-hub-linux-x86_64-deb.json.minisig': [311, '24f9e75cbea3b8afcfa59df70ee0ff595ef21b93a9efb2313de223788f91b885'],
  'fresh-api.json': [57246, 'a554d4de0308cffc570e678258e6c47f6d4a5843e45825dcacc6c7c6034ccd7e'],
  'latest.json': [751, '3e9362038eeb37cdac6f0caae08a0b7d8b4124e8dbb210de5f62a81f988742ef'],
  'plan.json': [4789, 'bab785cdbce7faee4a9ab9cca9fea9b27ca9268b2f73483024286f03c1531401'],
  'private-deb-qualification-receipt.json': [1983, '574bd90ad64d53e5d3c9506f6ba4e6f2e07def1a0e5d68d5d0025326d55e76b4'],
});
const RECEIPTS = Object.freeze({
  receipt: [387, '2f536c4640f12ea04609ae962b05a891e9d3590931dc5f33db744f3a52aa922f'],
  independent: [958, '9f3c9c6b30b3c66eb05eec2e6eb7dd1a30daa957e1db982d2000ed7f422f62e2'],
  filePins: [1142, '94aabf1779035f3732541041033f639a35318f68336c8fccf8dce5ab6def355c'],
});
const sha = raw => crypto.createHash('sha256').update(raw).digest('hex');
function bound(raw, pin) {
  assert.ok(Buffer.isBuffer(raw)); assert.equal(raw.length, pin[0]); assert.equal(sha(raw), pin[1]);
}
function inspectCarrier(raw) {
  bound(raw, [CARRIER.size, CARRIER.sha256]);
  return {status: 'LOCAL_CARRIER_BYTES_ONLY', membersVerifiedHere: false, draftAssetBound: false,
    nativeExecutionAuthorized: false, releaseReady: false};
}
function inspect(files, receipts) {
  assert.deepEqual(Object.keys(files).sort(), Object.keys(PINS).sort());
  assert.deepEqual(Object.keys(receipts).sort(), Object.keys(RECEIPTS).sort());
  for (const [name, pin] of Object.entries(PINS)) bound(files[name], pin);
  for (const [name, pin] of Object.entries(RECEIPTS)) bound(receipts[name], pin);
  const receipt = JSON.parse(receipts.receipt), verified = JSON.parse(receipts.independent);
  const pins = JSON.parse(receipts.filePins), plan = JSON.parse(files['plan.json']);
  const q = JSON.parse(files['private-deb-qualification-receipt.json']);
  for (const [name, [size, sha256]] of Object.entries(PINS)) assert.deepEqual(pins[name], {size, sha256});
  assert.deepEqual(Object.keys(pins).sort(), Object.keys(PINS).sort());
  assert.equal(receipt.source, SOURCE); assert.equal(receipt.tree, TREE);
  assert.equal(receipt.planSha256, PINS['plan.json'][1]); assert.equal(receipt.signaturesVerified, true);
  assert.equal(receipt.authorizedBodiesSigned, 2); assert.equal(receipt.writerInvocations, 1);
  for (const key of ['candidateExecuted', 'automaticRetry', 'uploaded', 'releaseReady']) assert.equal(receipt[key], false);
  assert.equal(plan.rootSource.sourceCommit, SOURCE); assert.equal(plan.rootSource.sourceTree, TREE);
  assert.equal(plan.producer.runId, 40903331594); assert.equal(plan.producer.jobId, 123551467029);
  assert.equal(plan.producer.artifactId, 12909839246); assert.equal(plan.producer.runAttempt, 1);
  assert.equal(q.planSha256, PINS['plan.json'][1]); assert.deepEqual(q.rootSource, plan.rootSource);
  assert.deepEqual(q.producer, plan.producer); assert.equal(q.signatures['creator-hub-linux-x86_64-deb.json.minisig'].sha256, PINS['creator-hub-linux-x86_64-deb.json.minisig'][1]);
  assert.equal(q.signatures['Creator_Hub_0.1.17_amd64-acceptance-only.deb.minisig'].sha256, PINS['Creator_Hub_0.1.17_amd64-acceptance-only.deb.minisig'][1]);
  assert.equal(verified.signaturesVerified, true); assert.equal(verified.mode, 'verify');
  assert.deepEqual(verified.deb, {sha256: PINS['Creator_Hub_0.1.17_amd64-acceptance-only.deb'][1], size: 64519358});
  assert.equal(verified.installedHub.sha256, '822e46106d5caaf36890965d3020fb49b2235e91517eb33bd5d2f4210d5b5690');
  assert.equal(verified.applicationLaunched, false); assert.equal(verified.releaseReady, false);
  return {status: 'LOCAL_SIGNED_BYTES_BOUND_TO_RETAINED_VERIFICATION', signatureVerifiedHere: false,
    draftAssetBound: false, sourceReceiptBound: false, nativeExecutionAuthorized: false, releaseReady: false};
}
module.exports = { PINS, RECEIPTS, CARRIER, inspect, inspectCarrier };
