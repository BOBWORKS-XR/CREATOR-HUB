'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const bound = require('./journal-signed-017-retained.cjs');
test('incomplete, substituted, or extra signed files cannot be accepted', () => {
  assert.throws(() => bound.inspect({}, {}));
  const files = Object.fromEntries(Object.keys(bound.PINS).map(name => [name, Buffer.alloc(0)]));
  const receipts = Object.fromEntries(Object.keys(bound.RECEIPTS).map(name => [name, Buffer.alloc(0)]));
  assert.throws(() => bound.inspect(files, receipts));
  assert.throws(() => bound.inspect({...files, extra: Buffer.alloc(0)}, receipts));
  assert.throws(() => bound.inspect(files, {...receipts, extra: Buffer.alloc(0)}));
  assert.throws(() => bound.inspectCarrier(Buffer.alloc(0)));
});
