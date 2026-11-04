require('./fixtures/windows-019-test-fixture.cjs').install();
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const local = fs.existsSync(path.join(__dirname, 'windows-019-unverified-server-case.cjs'));
const c = require(local ? './windows-019-unverified-server-case.cjs' : './unverified-server-case.cjs');
test('custom saved server is distinct from unchanged old client transport and typed owned router', () => {
  const current = { channels: [], mcp_server_path: 'old', auto_start: false, future: [false, 7] };
  const f = { normalSetup: true, oldServer: 'C:\\old\\server.mjs', projectA: 'C:\\fixture\\Project', current: { ...current }, legacy: { ...current }, stores: [0, 1].map(i => ({ bytes: Buffer.from(JSON.stringify(current)) })), clients: [{ entry: { command: 'C:/router.exe', args: [] } }] };
  const result = c.fixtureCase({ WINDOWS_MIGRATION_CASE: c.CASE }, f, (env, fixture) => { assert.equal(env.WINDOWS_MIGRATION_CASE, 'setup-owned-codex'); return fixture; });
  assert.equal(result, f); assert.equal(f.unverifiedSavedServer, 'C:\\fixture\\Unverified Server\\never-run-custom.mjs');
  for (const item of f.stores) assert.deepEqual(JSON.parse(item.bytes), { ...current, mcp_server_path: f.unverifiedSavedServer });
  assert.equal(f.oldServer, 'C:\\old\\server.mjs'); assert.deepEqual(f.clients[0].entry.args, []);
});
test('separate Use Hub runtime dialog requires exact title, owner, button and mixed-slash target content', () => {
  const target = 'C:\\runtime\\generation\\mcp/server/creator-works-mcp.mjs';
  const dialog = { class: '#32770', title: 'Keep MCP settings working in Hub', handle: 99, controls: [
    { id: 'ContentText', name: c.serverMessage(target), processId: 42 },
    { id: 'CommandButton_1000', name: 'Use Hub runtime', processId: 42 }] };
  assert.equal(c.assertServerDialog([dialog], 42, target).name, 'Use Hub runtime');
  for (const change of [d => d.title = 'Move to Hub', d => d.controls[0].processId = 43,
    d => d.controls[0].name = c.serverMessage('C:\\other'), d => d.controls[1].name = 'Move server path',
    d => d.controls[1].id = 'CommandButton_1001']) {
    const bad = structuredClone(dialog); change(bad); assert.throws(() => c.assertServerDialog([bad], 42, target));
  }
  assert.throws(() => c.assertServerDialog([dialog, dialog], 42, target));
});
test('native server approval is required after client review and before completion', () => {
  const directory = local ? __dirname : path.join(__dirname, 'prepared-02/scripts');
  const source = fs.readFileSync(path.join(directory, 'native-windows-019-migration.cjs'), 'utf8');
  const start = source.indexOf('await connectionDecision();');
  const server = source.indexOf('if (f.unverifiedSavedServer) await serverDecision();', start);
  const complete = source.indexOf("await live.page.locator('#convergence-title')", start);
  assert.ok(start > 0 && server > start && complete > server);
  assert.ok(source.includes("assert.equal(report.serverRuntimeDecision?.length, 1"));
  assert.ok(source.includes("assert.equal(fs.existsSync(f.unverifiedSavedServer), false"));
  assert.ok(source.includes("No saved server replacement before separate approval"));
  assert.ok(source.includes("quote(connection || server ? selected.content : '')"));
  assert.ok(source.includes('verifyBackups([...f.stores, ...f.clients])'));
  assert.ok(source.includes('assert.deepEqual(projectImage([f.projectA, f.projectB]), projectBefore'));
});
