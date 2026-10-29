'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const gate = require('./journal-native-pair-lane.cjs');
const pair = require('./journal-native-pair.cjs');
const api = require('./fixtures/journal-native-pair/api-observations.json');
const fs = require('node:fs');
const path = require('node:path');
test('historical route is not selected by fresh markers', () => {
  assert.equal(gate.isFreshCandidate({ schemaVersion: 1, baseline: { source: '085131ba6f3050a795fd513139a34975658ba321', run: 40538427509, attempt: 1 } }), false);
  const historical = require('./fixtures/native-linux-changed-mcp-profile.json');
  assert.equal(gate.isFreshCandidate(historical), false);
});
test('fresh gate precedes delivery in the continuation job', () => {
  const text = fs.readFileSync(path.join(__dirname, '../.github/workflows/native-linux-production-016-migration.yml'), 'utf8');
  const section = text.split('  changed_delivery:')[1].split('  changed_mcp:')[0];
  assert.ok(section.indexOf('gate.refuseFreshUntilDelivery(profile, api)') > 0);
  assert.ok(section.indexOf('c.sourceReceipt(') < section.indexOf('gate.refuseFreshUntilDelivery(profile, api)'));
  assert.ok(section.indexOf('gate.refuseFreshUntilDelivery(profile, api)') < section.indexOf('await lane.collectDelivery'));
});
test('fresh and mixed identities fail closed before delivery', () => {
  for (const marker of [pair.B.sourceCommit, pair.B.runId, pair.B.artifactId, pair.B.zipSha256,
    'be0adef208c80a60f8599bd466a45b28bde73588', 40899552207, 12909617948]) {
    const profile = { baseline: { marker } };
    assert.equal(gate.isFreshCandidate(profile), true);
    assert.throws(() => gate.refuseFreshUntilDelivery(profile, api), /signed delivery/);
  }
});
test('fresh admission refuses changed live metadata', () => {
  const altered = structuredClone(api); altered.bArtifact.id++;
  assert.throws(() => gate.refuseFreshUntilDelivery({ baseline: { run: pair.B.runId } }, altered));
});
