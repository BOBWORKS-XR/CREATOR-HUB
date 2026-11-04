'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const CASE = 'setup-owned-codex-unverified-server';
function fixtureCase(env, fixture, baseCase) {
  const special = env.WINDOWS_MIGRATION_CASE === CASE;
  const result = baseCase(special ? { ...env, WINDOWS_MIGRATION_CASE: 'setup-owned-codex' } : env, fixture);
  if (!special) return result;
  assert.equal(result.normalSetup, true);
  const server = path.win32.join(path.win32.dirname(result.projectA), 'Unverified Server', 'never-run-custom.mjs');
  assert.notEqual(server, result.oldServer);
  result.current.mcp_server_path = result.legacy.mcp_server_path = server;
  for (const [index, item] of result.stores.slice(0, 2).entries()) {
    const value = JSON.parse(item.bytes); value.mcp_server_path = server;
    item.bytes = Buffer.from(JSON.stringify(value, null, 2) + (index ? '\r\n' : '\n'));
  }
  result.unverifiedSavedServer = server;
  return result;
}
function serverMessage(server) {
  return 'The saved MCP server could not be verified as a supported previous build. Use the verified MCP runtime included with Hub instead?\n\nThis does not trust or run the old server. Existing AI-client entries are reviewed separately.'
    + `\n\nNew server: ${server}\n\nOnly this path changes. Project selection, options and unknown settings are preserved. Exact local backups and recovery records are kept. Old apps and AI clients are not stopped or removed by this step.`;
}
function assertServerDialog(windows, pid, server) {
  const dialogs = windows.filter(item => item.class === '#32770');
  assert.equal(dialogs.length, 1, 'Exactly one separate server-runtime review required');
  const dialog = dialogs[0]; assert.equal(dialog.title, 'Keep MCP settings working in Hub');
  assert.ok(Number.isSafeInteger(dialog.handle) && dialog.handle > 0);
  const content = serverMessage(server), texts = dialog.controls.filter(item => item.id === 'ContentText');
  assert.equal(texts.length, 1); assert.equal(texts[0].processId, pid); assert.equal(texts[0].name, content);
  const buttons = dialog.controls.filter(item => item.name === 'Use Hub runtime');
  assert.equal(buttons.length, 1); assert.equal(buttons[0].processId, pid); assert.equal(buttons[0].id, 'CommandButton_1000');
  return { title: dialog.title, name: 'Use Hub runtime', id: 1000, handle: dialog.handle, content };
}
module.exports = { CASE, fixtureCase, serverMessage, assertServerDialog };
