'use strict';
const assert = require('node:assert/strict');
function selected(lastTool, restore) {
  assert.ok(['mcp', 'setup'].includes(lastTool)); assert.equal(typeof restore, 'boolean');
  assert.ok(lastTool !== 'mcp' || restore);
  return lastTool === 'mcp' ? 'core,banter' : restore ? 'read' : 'all';
}
function settings(lastTool, restore) {
  return JSON.stringify({ channels: [], auto_start: false, futureOption: { keep: true },
    tool_groups: selected(lastTool, restore) }) + '\n';
}
function proof(lastTool, restore) {
  return { schemaVersion: 1, mode: 'manual', toolGroups: selected(lastTool, restore),
    currentBytesPreserved: true, legacyBytesPreserved: true, unrelatedFieldsPreserved: true };
}
function verify(lastTool, restore, current, legacy) {
  const expected = settings(lastTool, restore);
  assert.deepEqual(Buffer.from(current), Buffer.from(expected));
  assert.deepEqual(Buffer.from(legacy), Buffer.from(expected.replaceAll('\n', '\r\n')));
  return proof(lastTool, restore);
}
module.exports = { selected, settings, proof, verify };
