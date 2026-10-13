const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeClient } = require('./live-client-smoke.cjs');
const stream = (...events) => events.map(event => JSON.stringify(event)).join('\n');

test('expired client authentication is distinct from a successful MCP connection', () => {
  const result = summarizeClient(stream(
    { type: 'system', mcp_servers: [{ name: 'acceptance', status: 'connected' }] },
    { type: 'assistant', error: 'authentication_failed' },
    { type: 'result', is_error: true, subtype: 'success' },
  ), 'fixture');
  assert.deepEqual(result, { connected: true, toolCalled: false, completed: false,
    fixtureReturned: false, failure: 'client-authentication-failed' });
});

test('Claude requires a real health call and its exact disposable response', () => {
  const result = summarizeClient(stream(
    { content: [{ type: 'tool_use', name: 'mcp__acceptance__get_bridge_status' }] },
    { content: [{ text: JSON.stringify({ ready: false, project: { path: 'fixture' } }) }] },
    { type: 'result', is_error: false },
  ), 'fixture');
  assert.equal(result.toolCalled && result.completed && result.fixtureReturned, true);
  assert.equal(result.failure, null);
});

test('Codex completion cannot substitute a different project response', () => {
  const result = summarizeClient(stream(
    { type: 'mcp_tool_call', tool: 'get_bridge_status', server: 'acceptance', status: 'completed',
      result: { text: JSON.stringify({ ready: false, project: { path: 'another-project' } }) } },
  ), 'fixture');
  assert.equal(result.toolCalled && result.completed, true);
  assert.equal(result.fixtureReturned, false);
});

test('unstructured output and synthetic success text are not a tool call', () => {
  const result = summarizeClient('broken json\n' + stream({ type: 'result', is_error: false, result: 'It worked.' }), 'fixture');
  assert.equal(result.toolCalled, false);
  assert.equal(result.fixtureReturned, false);
});
