require('./fixtures/windows-019-test-fixture.cjs').install();
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const helper = require(fs.existsSync(path.join(__dirname, 'windows-019-setup-owned-case.cjs')) ? './windows-019-setup-owned-case.cjs' : './native-setup-owned-case.cjs');
test('only bounded typed fixture gets this runner current router, never user data', () => {
  const fixture = () => ({ projectA: 'C:\\fixture\\Project', clients: [{ id: 'codex', bytes: Buffer.from('legacy'), entry: {} }, { id: 'claude', bytes: Buffer.from('keep') }] });
  const legacy = fixture(); assert.equal(helper.fixtureCase({}, legacy), legacy); assert.equal(legacy.clients[0].bytes.toString(), 'legacy');
  const actual = helper.fixtureCase({ WINDOWS_MIGRATION_CASE: 'setup-owned-codex', LOCALAPPDATA: 'C:\\Users\\runner\\AppData\\Local' }, fixture());
  assert.equal(actual.normalSetup, true); assert.equal(actual.clients[0].setupOwned, true);
  assert.equal(actual.clients[0].entry.command, 'C:/Users/runner/AppData/Local/creator-hub/mcp-route-v1/windows-x86_64/router-v1/creator-hub-mcp-router.exe');
  assert.deepEqual(actual.clients[0].entry.args, []); assert.equal(actual.clients[1].bytes.toString(), 'keep');
  assert.throws(() => helper.fixtureCase({ WINDOWS_MIGRATION_CASE: 'arbitrary' }, fixture()));
});
test('owned Setup result retains forward slash, no args, exact marker and unrelated keys', () => {
  const router = 'C:\\Users\\runner\\router.exe', entry = helper.setupEntry(router, 'C:\\Project');
  const document = { model: 'keep', future_root: 'untouched', mcp_servers: { other: { command: 'unrelated-server', args: ['keep'] }, 'creator-works': entry } };
  assert.deepEqual(helper.verifyClient({ entry }, document, router), entry);
  for (const change of [v => v.command = v.command.toLowerCase(), v => v.command = router, v => v.args.push('extra'), v => v.env.CREATOR_WORKS_CONFIG_OWNER = 'foreign']) {
    const altered = structuredClone(entry); change(altered);
    assert.throws(() => helper.verifyClient({ entry }, { ...document, mcp_servers: { ...document.mcp_servers, 'creator-works': altered } }, router));
  }
});
