import assert from 'node:assert/strict';
import test from 'node:test';
import { handleToolCall, registerTools } from '../dist/tools/index.js';

test('Udon lessons can be retrieved offline by topic without opening a project', async () => {
  const tool = registerTools().find(t => t.name === 'get_mcp_reference');
  assert.ok(tool.inputSchema.properties.source.enum.includes('udon-porting'));
  assert.equal(tool.annotations.readOnlyHint, true);
  for (const [query, expected] of [
    ['SDK equivalents', 'Banter'], ['interaction', 'backing UdonBehaviour'],
    ['prefab overrides', 'explicitly stored zero'], ['arity', 'before a guard'],
    ['multiplayer', 'late join'], ['working copies', 'auto-upload'],
  ]) {
    const reply = await handleToolCall(tool.name, { source: 'udon-porting', query, limit: 1 }, {});
    const result = JSON.parse(reply.content[0].text);
    assert.equal(result.success, true);
    assert.equal(result.returned, 1);
    assert.ok(result.entries[0].text.includes(expected), query);
    assert.match(result.guidance, /does not convert/);
  }
});
