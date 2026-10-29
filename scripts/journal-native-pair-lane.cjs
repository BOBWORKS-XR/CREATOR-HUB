'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pair = require('./journal-native-pair.cjs');
const incoming = require('./fixtures/journal-a-native-incoming.UNBOUND.json').assembly;
const markers = new Set([incoming, pair.B].flatMap(p =>
  ['sourceCommit', 'sourceTree', 'runId', 'jobId', 'artifactId', 'zipSha256'].map(key => String(p[key]))));
const names = { aProfile: 'a-profile', aManifest: 'a-manifest', binding: 'b-binding',
  bAudit: 'b-audit', bSignatures: 'b-signatures', bRuntime: 'b-runtime',
  bPlan: 'b-plan', bDerivation: 'b-derivation' };
function isFreshCandidate(value) {
  if (value === null || typeof value !== 'object') return markers.has(String(value));
  return Object.values(value).some(isFreshCandidate);
}
function evidence() {
  return Object.fromEntries(Object.entries(names).map(([key, name]) =>
    [key, fs.readFileSync(path.join(__dirname, 'fixtures/journal-native-pair', name + '.json'))]));
}
function refuseFreshUntilDelivery(profile, api) {
  assert.ok(isFreshCandidate(profile), 'Fresh pair marker required');
  const result = pair.assess(evidence(), api);
  assert.equal(result.dispatchAuthorized, false);
  throw new Error('Fresh A/017 pair remains blocked: signed delivery and final source binding are not admitted');
}
module.exports = { isFreshCandidate, refuseFreshUntilDelivery };
