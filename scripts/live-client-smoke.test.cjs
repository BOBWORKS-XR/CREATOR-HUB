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
    { content: [{ type: 'tool_use', id: 'owned-call', name: 'mcp__acceptance__get_bridge_status' }] },
    { content: [{ type: 'tool_result', tool_use_id: 'owned-call', content: [{ text: JSON.stringify({ ready: false, project: { path: 'fixture' } }) }] }] },
    { type: 'result', is_error: false },
  ), 'fixture');
  assert.equal(result.toolCalled && result.completed && result.fixtureReturned, true);
  assert.equal(result.failure, null);
});

test('model text and another completed tool cannot supply the health-call receipt', () => {
  const result = summarizeClient(stream(
    { type: 'mcp_tool_call', tool: 'get_bridge_status', server: 'acceptance', status: 'failed', error: 'refused' },
    { type: 'mcp_tool_call', tool: 'other_tool', server: 'elsewhere', status: 'completed' },
    { type: 'assistant', content: [{ text: JSON.stringify({ ready: false, project: { path: 'fixture' } }) }] },
    { type: 'result', is_error: false },
  ), 'fixture');
  assert.equal(result.completed, false);
  assert.equal(result.fixtureReturned, false);
});

test('Claude tool-result IDs must match the requested health call', () => {
  const result = summarizeClient(stream(
    { content: [{ type: 'tool_use', id: 'owned-call', name: 'mcp__acceptance__get_bridge_status' }] },
    { content: [{ type: 'tool_result', tool_use_id: 'other-call', content: [{ text: JSON.stringify({ ready: false, project: { path: 'fixture' } }) }] }] },
    { type: 'result', is_error: false },
  ), 'fixture');
  assert.equal(result.fixtureReturned, false);
  assert.equal(result.completed, false);
});

test('provider usage limits stay distinct from authentication and MCP connection', () => {
  const result = summarizeClient(stream(
    { type: 'system', mcp_servers: [{ name: 'acceptance', status: 'connected' }] },
    { type: 'assistant', error: 'rate_limit', api_error: 'usage_limit_reached', is_api_error_message: true },
    { type: 'result', is_error: true, api_error: 'usage_limit_reached', terminal_reason: 'api_error' },
  ), 'fixture');
  assert.equal(result.connected, true);
  assert.equal(result.failure, 'client-provider-usage-limit');
  assert.equal(result.toolCalled, false);
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
