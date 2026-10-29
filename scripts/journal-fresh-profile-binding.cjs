'use strict';
// Unbound identity check. It does not fetch, extract, verify signatures or authorize native execution.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const pair = require('./journal-native-pair.cjs');
const signed = require('./journal-signed-017-retained.cjs');
const PROFILE = Object.freeze({ size: 11728, sha256: 'ef2b5a589d934bf48306ddfd53d133513f3ab4d22b9622672f76887cb7acb095' });
const ASSET = Object.freeze({ id: 689113479, name: signed.CARRIER.name, size: signed.CARRIER.size,
  digest: 'sha256:' + signed.CARRIER.sha256, state: 'uploaded' });
function assetBinding(release, listing, asset) {
  assert.equal(release.id, 411494394); assert.equal(release.tag_name, 'v0.1.13-validation'); assert.equal(release.draft, true);
  assert.ok(Array.isArray(listing) && listing.length < 100);
  const matches = listing.filter(a => a.id === ASSET.id || a.name === ASSET.name);
  assert.equal(matches.length, 1);
  for (const [key, value] of Object.entries(ASSET)) { assert.equal(matches[0][key], value); assert.equal(asset[key], value); }
}
function profile(raw) {
  assert.ok(Buffer.isBuffer(raw)); assert.equal(raw.length, PROFILE.size);
  assert.equal(crypto.createHash('sha256').update(raw).digest('hex'), PROFILE.sha256);
  const p = JSON.parse(raw), a = JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures/journal-a-native-incoming.UNBOUND.json'))).assembly;
  assert.equal(p.profile, 'production016-private017-native-update'); assert.equal(p.schemaVersion, 1);
  for (const [field, key] of [['source','sourceCommit'],['tree','sourceTree'],['run','runId'],['job','jobId'],['artifact','artifactId']]) {
    assert.equal(p.baseline[field], a[key]); assert.equal(p.artifacts.assembly16[field], a[key]);
    assert.equal(p.artifacts.assembly17[field], pair.B[key]);
  }
  assert.deepEqual(p.baseline.zip, {size: a.zipBytes, sha256: a.zipSha256});
  assert.deepEqual(p.artifacts.assembly16.zip, p.baseline.zip);
  assert.deepEqual(p.artifacts.assembly17.zip, {size: pair.B.zipBytes, sha256: pair.B.zipSha256});
  assert.equal(p.artifacts.assembly16.attempt, 1); assert.equal(p.artifacts.assembly17.attempt, 1);
  assert.equal(p.artifacts.assembly16.branch, 'validation/journal-a-assembly-016');
  assert.equal(p.artifacts.assembly17.branch, 'validation/linux-private-update-fixture-017');
  const d = p.deliveries.signedDeb17;
  assert.deepEqual(Object.keys(p.deliveries), ['signedDeb17']);
  assert.equal(d.asset, ASSET.id); assert.equal(d.name, ASSET.name);
  assert.deepEqual(d.zip, {size: signed.CARRIER.size, sha256: signed.CARRIER.sha256});
  assert.deepEqual(d.files, Object.fromEntries(Object.entries(signed.PINS).map(([n, [size, sha256]]) => [n, {size, sha256}])));
  return p;
}
function assess(raw, release, listing, asset, evidence, api) {
  profile(raw); assetBinding(release, listing, asset);
  const identity = pair.assess(evidence, api);
  assert.equal(identity.dispatchAuthorized, false);
  return {status: 'PROFILE_AND_DRAFT_IDENTITY_UNBOUND', profileSha256: PROFILE.sha256,
    draftAssetBound: true, downloadedAssetVerifiedHere: false, signatureVerifiedHere: false,
    sourceReceiptBound: false, nativeExecutionAuthorized: false, releaseReady: false};
}
module.exports = { PROFILE, ASSET, assetBinding, profile, assess };
