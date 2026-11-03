import assert from 'node:assert/strict';
import test from 'node:test';
import { registerTools } from '../dist/tools/index.js';
import { getMCPReference } from '../dist/tools/get-mcp-reference.js';

test('bundled reference lookup advertises its non-mutating offline contract', () => {
  const tool = registerTools().find(tool => tool.name === 'get_mcp_reference');
  assert.deepEqual(tool.annotations, {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
  });
  const first = getMCPReference({ source: 'manual', query: 'Sequence', limit: 1 });
  const second = getMCPReference({ source: 'manual', query: 'Sequence', limit: 1 });
  assert.equal(first.success, true);
  assert.deepEqual(second, first);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 16 * 1024);
});
