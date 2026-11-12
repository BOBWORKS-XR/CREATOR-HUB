'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const f = require('./sdk-retention-023.cjs');
for (const [lastTool, restore, expected] of [['mcp', true, 'core,banter'], ['setup', true, 'read'], ['setup', false, 'all']]) {
  test(`manual ${expected} survives without Auto conversion or byte normalization`, () => {
    const current = f.settings(lastTool, restore), legacy = current.replaceAll('\n', '\r\n');
    assert.equal(f.verify(lastTool, restore, current, legacy).toolGroups, expected);
    for (const changed of ['auto', 'core', 'core,creator'])
      assert.throws(() => f.verify(lastTool, restore, current.replace(expected, changed), legacy));
    assert.throws(() => f.verify(lastTool, restore, current, current));
    assert.throws(() => f.verify(lastTool, restore, current.replace('true', 'false'), legacy));
  });
}
test('unknown case cannot manufacture a successful retention proof', () => {
  assert.throws(() => f.proof('unknown', true)); assert.throws(() => f.proof('mcp', false));
});
