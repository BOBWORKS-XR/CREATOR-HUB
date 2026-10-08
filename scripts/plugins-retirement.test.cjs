const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('native and browser retirement use the same exact UTC cutoff', () => {
  const native = read('native/plugins_retirement.rs');
  const seconds = Number(native.match(/CUTOFF_SECONDS: u64 = ([0-9_]+)/)[1].replaceAll('_', ''));
  assert.equal(seconds * 1000, Date.UTC(2026, 9, 20));
  assert.match(read('src/community.js'), /Date.UTC\(2026, 9, 20\)/);
});

test('every native app enforces retirement before dispatch and registers the fixed opener', () => {
  for (const file of ['src-tauri/src/main.rs', 'modules/mcp/launcher/src-tauri/src/main.rs', 'modules/project-setup/src-tauri/src/main.rs']) {
    const source = read(file);
    assert.match(source, /native\/plugins_retirement.rs/);
    assert.match(source, /plugins_retirement::open_plugins_website,/);
    assert.match(source, /plugins_retirement::command_error\(invoke.message.command\(\)\)/);
    const guard = source.indexOf('plugins_retirement::command_error');
    const dispatch = Math.max(source.indexOf('commands(invoke)'), source.indexOf('handler(invoke)'));
    assert.ok(guard < dispatch && dispatch > 0, file);
  }
  assert.match(read('src-tauri/build.rs'), /"open_plugins_website"/);
  assert.ok(JSON.parse(read('src-tauri/capabilities/default.json')).permissions.includes('allow-open-plugins-website'));
});

test('production catalogue copies are identical and historical UI is fixture-only', () => {
  const current = read('src/community.js');
  for (const file of ['modules/mcp/launcher/src/community.js', 'modules/project-setup/src/community.js']) assert.equal(read(file), current);
  assert.doesNotMatch(current, /community_catalogue|download_community_package|queue_community_import|install_community_menu/);
  assert.match(read('tests/fixtures/community/legacy-catalogue.js'), /Historical catalogue fixture/);
});
