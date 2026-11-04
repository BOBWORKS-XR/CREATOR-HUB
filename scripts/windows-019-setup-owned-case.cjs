'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
function setupEntry(router, project) {
  return { command: router.replaceAll('\\', '/'), args: [], startup_timeout_sec: 20, tool_timeout_sec: 600,
    env: { CREATOR_WORKS_CONFIG_OWNER: 'creator-hub-v1', UNITY_PROJECT_PATH: project.replaceAll('\\', '/'), CREATOR_WORKS_TOOL_GROUPS: 'read' } };
}
function fixtureCase(env, fixture) {
  const kind = env.WINDOWS_MIGRATION_CASE || 'legacy';
  assert.ok(['legacy', 'setup-owned-codex'].includes(kind), 'Unknown bounded migration case');
  if (kind === 'setup-owned-codex') {
    assert.ok(path.win32.isAbsolute(env.LOCALAPPDATA), 'Absolute disposable local data required');
    const codex = fixture.clients.find(item => item.id === 'codex'); assert.ok(codex);
    const router = path.win32.join(env.LOCALAPPDATA, 'creator-hub/mcp-route-v1/windows-x86_64/router-v1/creator-hub-mcp-router.exe');
    const entry = setupEntry(router, fixture.projectA);
    // Matches final R8 build_codex_mcp_config's normal managed Setup output.
    codex.bytes = Buffer.from(`# Keep this comment\r\nmodel='keep'\r\nfuture_root='untouched'\r\n[mcp_servers.other]\r\ncommand='unrelated-server'\r\nargs=['keep']\r\n\n[mcp_servers.creator-works]\ncommand = ${JSON.stringify(entry.command)}\nargs = []\nstartup_timeout_sec = 20\ntool_timeout_sec = 600\n\n[mcp_servers.creator-works.env]\nCREATOR_WORKS_CONFIG_OWNER = "creator-hub-v1"\nUNITY_PROJECT_PATH = ${JSON.stringify(entry.env.UNITY_PROJECT_PATH)}\nCREATOR_WORKS_TOOL_GROUPS = "read"\n`);
    codex.entry = entry; codex.setupOwned = true; fixture.normalSetup = true;
  }
  return fixture;
}
function verifyClient(item, document, router) {
  const actual = document.mcp_servers['creator-works'];
  assert.deepEqual(actual, item.entry);
  assert.equal(actual.command, router.replaceAll('\\', '/'));
  assert.deepEqual(actual.args, []);
  assert.equal(actual.env.CREATOR_WORKS_CONFIG_OWNER, 'creator-hub-v1');
  assert.deepEqual(document, { model: 'keep', future_root: 'untouched', mcp_servers: {
    other: { command: 'unrelated-server', args: ['keep'] }, 'creator-works': actual } });
  return actual;
}
module.exports = { setupEntry, fixtureCase: (env, fixture) => require('./windows-019-unverified-server-case.cjs').fixtureCase(env, fixture, fixtureCase), verifyClient };
