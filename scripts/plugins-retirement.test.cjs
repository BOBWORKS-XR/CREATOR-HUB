const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('retired website command cannot launch a browser or depend on the clock', () => {
  const native = read('native/plugins_retirement.rs');
  assert.match(native, /pub fn open_plugins_website\(\) -> Result<\(\), String> \{\s*Err\(RETIRED.into\(\)\)/);
  assert.doesNotMatch(native, /std::process::Command|SystemTime|creatorplugins.store/);
});

test('every native app enforces retirement before dispatch and registers the fixed opener', () => {
  for (const file of ['src-tauri/src/main.rs', 'modules/mcp/launcher/src-tauri/src/lib.rs', 'modules/project-setup/src-tauri/src/lib.rs']) {
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

test('Plugins UI and loader references are removed from all production app shells', () => {
  for (const file of ['src/index.html', 'modules/mcp/launcher/src/index.html', 'modules/project-setup/src/index.html']) {
    assert.doesNotMatch(read(file), /data-view="plugins"|id="view-plugins"|community\.(js|css)|creator-plugins\.png|Creator Plugins/);
  }
  assert.doesNotMatch(read('src/app.js'), /CreatorCommunity|view-plugins|current === 'plugins'|view === 'plugins'/);
  assert.match(read('tests/fixtures/community/legacy-catalogue.js'), /Historical catalogue fixture/);
  assert.match(read('tests/community.spec.js'), /fixtures\/community\/legacy-hub.html/);
});
