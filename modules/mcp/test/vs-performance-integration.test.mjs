import assert from 'node:assert/strict';
import test from 'node:test';
import { generateVSGraph } from '../dist/tools/generate-vs-graph.js';
import { validateVSGraph } from '../dist/tools/validate-vs-graph.js';
import { getMCPReference } from '../dist/tools/get-mcp-reference.js';
import { handleToolCall, registerTools } from '../dist/tools/index.js';

test('performance warnings keep a valid graph valid and never change graph bytes', () => {
  const created = generateVSGraph({ graphName: 'Lift', nodes: [{ id: 'tick', type: 'Update' }] });
  assert.equal(created.success, true);
  assert.ok(created.performanceWarnings.length > 0);
  const before = created.graphJson;
  const checked = validateVSGraph(before, { graphName: 'Assets/Lift.asset' });
  assert.equal(checked.valid, true);
  assert.equal(created.graphJson, before);
  assert.ok(checked.performanceWarnings.length > 0);
  for (const warning of checked.performanceWarnings) {
    assert.equal(warning.graph, 'Assets/Lift.asset');
    assert.equal(warning.unitType, 'Unity.VisualScripting.Update');
    assert.ok(warning.unitId);
    assert.ok(warning.message);
    assert.ok(warning.suggestion);
  }
  assert.ok(checked.warnings.some(text => text.includes('Assets/Lift.asset') && text.includes('Unity.VisualScripting.Update')));
});

test('MCP exposes named advisory validation without treating warnings as a failed tool', async () => {
  assert.ok(registerTools().find(tool => tool.name === 'validate_vs_graph').inputSchema.properties.graphName);
  const created = generateVSGraph({ graphName: 'Lift', nodes: [{ id: 'tick', type: 'Update' }] });
  const result = await handleToolCall('validate_vs_graph', { graphJson: created.graphJson, graphName: 'Lift' }, { projectPath: '', assetsPath: '' });
  assert.notEqual(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).performanceWarnings[0].graph, 'Lift');
});

test('optimization guidance is available as bounded reference excerpts', () => {
  const schema = registerTools().find(tool => tool.name === 'get_mcp_reference').inputSchema;
  assert.ok(schema.properties.source.enum.includes('graph-performance'));
  for (const query of ['polling', 'FixedUpdate', 'cache', 'idle', 'MovePosition', 'subgraph']) {
    const result = getMCPReference({ source: 'graph-performance', query, limit: 1 });
    assert.equal(result.success, true, query);
    assert.ok(result.entries.length, query);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16 * 1024);
  }
});
