'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
let bundledServerPath, sameSettingsExceptServer;
before(async () => {
  ({ bundledServerPath, sameSettingsExceptServer } = await import(
    pathToFileURL(path.resolve(__dirname, '../src/features/runtime-repair.js')).href));
});
function status(command = 'C:\\Users\\fixture\\.creator-hub\\runtime-generations\\windows-x86_64\\generation\\mcp\\server\\runtime\\node.exe') {
  return { managedRouting: true, runtime: { ready: true, bundled: true, command, version: '22.22.2' } };
}
function settings() {
  return { mcp_server_path: 'C:\\old\\server.mjs', active_channel_id: 'first', auto_start: false,
    channels: [{ id: 'first', enabled: false, unity_project_path: 'C:\\fixture\\project', scene_path: null }],
    tool_groups: 'read', enable_custom_scripts: false, allow_all_tests: false, connection_guide_version: 1,
    futurePreference: { nested: { accepted: false, count: 0 }, list: ['retained', null, 7] } };
}
test('verified managed bundled runtime maps only to its adjacent server', () => {
  assert.equal(bundledServerPath(status()),
    'C:/Users/fixture/.creator-hub/runtime-generations/windows-x86_64/generation/mcp/server/creator-works-mcp.mjs');
  assert.equal(bundledServerPath(status('D:/Creator Hub/modules/mcp/server/runtime/node.exe')),
    'D:/Creator Hub/modules/mcp/server/creator-works-mcp.mjs');
  assert.equal(bundledServerPath(status('e:\\Creator Hub/modules\\mcp/server\\RUNTIME/Node.EXE')),
    'e:/Creator Hub/modules/mcp/server/creator-works-mcp.mjs');
});
test('runtime readiness, bundled identity and managed routing must each be literal true', () => {
  for (const value of [false, null, undefined, 0, 1, 'true', {}, []]) {
    for (const field of ['managedRouting', 'ready', 'bundled']) {
      const input = status();
      if (field === 'managedRouting') input[field] = value;
      else input.runtime[field] = value;
      assert.equal(bundledServerPath(input), null, field + ': ' + String(value));
    }
  }
  for (const input of [null, undefined, {}, { managedRouting: true },
    { managedRouting: true, runtime: null }, { managedRouting: true, runtime: {} }])
    assert.equal(bundledServerPath(input), null);
});
test('non-Windows, relative, UNC, extended and URL paths are refused', () => {
  for (const command of ['', 'runtime/node.exe', 'C:runtime/node.exe', '/runtime/node.exe', '\\runtime\\node.exe',
    '//server/share/runtime/node.exe', '\\\\server\\share\\runtime\\node.exe',
    '\\\\?\\C:\\runtime\\node.exe', 'file:///C:/runtime/node.exe', 'https://host/runtime/node.exe'])
    assert.equal(bundledServerPath(status(command)), null, command);
});
test('dot segments, empty segments, alternate streams and incorrect runtime suffix are refused', () => {
  for (const command of ['C:/server/./runtime/node.exe', 'C:/server/../runtime/node.exe',
    'C:/server//runtime/node.exe', 'C://runtime/node.exe', 'C:/server/runtime//node.exe',
    'C:/server:stream/runtime/node.exe', 'C:/server/runtime/node.exe:stream',
    'C:/server/node.exe', 'C:/server/runtime/node', 'C:/server/runtime/node.exe.bak',
    'C:/server/runtime/node.exe/', 'C:/server/runtime/node.exe --flag'])
    assert.equal(bundledServerPath(status(command)), null, command);
});
test('control characters, oversized paths and nonstring commands are refused', () => {
  for (const control of ['\0', '\n', '\r', '\t', String.fromCharCode(31)])
    assert.equal(bundledServerPath(status('C:/server' + control + '/runtime/node.exe')), null);
  for (const command of [null, undefined, 23, {}, [], true, 'C:/' + 'a'.repeat(4096) + '/runtime/node.exe']) {
    const input = status(); input.runtime.command = command;
    assert.equal(bundledServerPath(input), null);
  }
});
test('mapping does not mutate native status or borrow an unverified alternative', () => {
  const input = status(); const original = structuredClone(input);
  input.server = 'C:/untrusted/server.mjs'; input.runtime.server = 'C:/also-untrusted/server.mjs';
  const expected = structuredClone(input); bundledServerPath(input); assert.deepEqual(input, expected);
  delete input.runtime.command; assert.equal(bundledServerPath(input), null);
  assert.equal(original.runtime.command.endsWith('node.exe'), true);
});
test('only the top-level MCP server path may differ', () => {
  const before = settings(), after = structuredClone(before);
  after.mcp_server_path = 'C:/verified/server/creator-works-mcp.mjs';
  assert.equal(sameSettingsExceptServer(before, after), true);
  delete after.mcp_server_path; assert.equal(sameSettingsExceptServer(before, after), true);
  assert.deepEqual(before, settings());
});
test('recursive object member order is irrelevant while array order is retained', () => {
  const before = settings();
  const after = Object.fromEntries(Object.entries(before).reverse());
  after.futurePreference = { list: ['retained', null, 7], nested: { count: 0, accepted: false } };
  after.channels = [{ scene_path: null, unity_project_path: 'C:\\fixture\\project', enabled: false, id: 'first' }];
  assert.equal(sameSettingsExceptServer(before, after), true);
  after.futurePreference.list.reverse(); assert.equal(sameSettingsExceptServer(before, after), false);
});
test('current selection, projects, capabilities, switches and unknown fields are protected', () => {
  const changes = [s => s.active_channel_id = 'other', s => s.auto_start = true, s => s.tool_groups = 'all',
    s => s.enable_custom_scripts = true, s => s.allow_all_tests = true, s => s.connection_guide_version = 2,
    s => s.channels[0].enabled = true, s => s.channels[0].unity_project_path += '-changed',
    s => s.channels.push({ id: 'other' }), s => s.futurePreference.nested.accepted = true,
    s => s.futurePreference.nested.count = '0', s => delete s.futurePreference,
    s => s.newUnknownField = 'added'];
  for (const change of changes) {
    const before = settings(), after = structuredClone(before); change(after);
    assert.equal(sameSettingsExceptServer(before, after), false);
    assert.equal(sameSettingsExceptServer(after, before), false);
  }
});
test('nested server-named fields are not ignored', () => {
  const before = settings(); before.futurePreference.mcp_server_path = 'must stay';
  const after = structuredClone(before); after.futurePreference.mcp_server_path = 'changed';
  assert.equal(sameSettingsExceptServer(before, after), false);
});
test('missing members, nulls and array contents cannot be treated as equivalent', () => {
  for (const [before, after] of [[{ field: null }, {}], [{ field: null }, { field: false }],
    [{ field: 0 }, { field: false }], [{ field: [] }, { field: {} }],
    [{ values: [null] }, { values: [] }], [{ values: ['a', 'b'] }, { values: ['b', 'a'] }]])
    assert.equal(sameSettingsExceptServer(before, after), false);
});
test('nonobject settings and top-level arrays fail closed', () => {
  for (const invalid of [null, undefined, true, false, 0, 1, 'settings', [], [settings()]]) {
    assert.equal(sameSettingsExceptServer(invalid, settings()), false);
    assert.equal(sameSettingsExceptServer(settings(), invalid), false);
  }
});
test('comparison leaves recursively frozen inputs untouched', () => {
  const freeze = value => { if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child); Object.freeze(value);
  } return value; };
  const before = freeze(settings()), after = freeze({ ...settings(), mcp_server_path: 'C:/verified/server.mjs' });
  assert.equal(sameSettingsExceptServer(before, after), true);
  assert.deepEqual(before, settings());
});
