'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const reader = require('./windows-022-public-acceptance.cjs');
const contract = require('./windows-022-public-contract.cjs');
const q = require('../packaging/windows/0.1.22-qualification.json');
test('022 public reader accepts only exact R4 candidate and rejects R3', () => {
  reader.requireTarget(q);
  const old = structuredClone(q); old.candidate.sourceCommit = '9bfce62e91088789c2a9d0872c012732f4036060';
  assert.throws(() => reader.requireTarget(old));
});
test('022 public evidence cannot start without reviewed public harness identity', async () => {
  let reads = 0;
  await assert.rejects(reader.verify(q, {}, { request: async () => { reads++; }, download: async () => { reads++; } }));
  assert.equal(reads, 0);
});
test('022 pending publication and lab discoveries cannot be treated as public', () => {
  assert.throws(() => contract.publication({ kind: 'public-021-to-022', publication: null }));
  assert.throws(() => contract.publication({ kind: 'direct-outgoing-021-022', publication: {} }));
});
