const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

test('Linux Setup permission questions use the in-process GTK backend, not undeclared Zenity', () => {
  const source = fs.readFileSync(path.join(__dirname, '../modules/project-setup/src-tauri/Cargo.toml'), 'utf8');
  const linux = source.split('[target.\'cfg(target_os = "linux")\'.dependencies]')[1]?.split('\n[')[0];
  assert.ok(linux, 'Retain a Linux-only dependency selection');
  assert.match(linux, /tauri-plugin-dialog = \{ version = "2", default-features = false, features = \["gtk3"\] \}/);
  assert.doesNotMatch(linux, /xdg-portal/);
  const other = source.split('[target.\'cfg(not(target_os = "linux"))\'.dependencies]')[1]?.split('\n[')[0];
  assert.match(other || '', /tauri-plugin-dialog = "2"/);
});

test('Hub and MCP retain the same default GTK dialog backend without platform-specific overrides', () => {
  for (const file of ['src-tauri/Cargo.toml', 'modules/mcp/launcher/src-tauri/Cargo.toml']) {
    const source = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(source, /^tauri-plugin-dialog = "2"\r?$/m);
    assert.doesNotMatch(source, /features = \["xdg-portal"\]/);
  }
});

test('native Linux producer checks the actual locked feature graph before compiling modules', () => {
  const source = fs.readFileSync(path.join(__dirname, '../.github/workflows/unix-managed-payload.yml'), 'utf8');
  assert.ok(source.indexOf('scripts/linux-dialog-backend.test.cjs') < source.indexOf('name: Prepare only native private modules'));
  assert.match(source, /cargo tree --locked --manifest-path modules\/project-setup\/src-tauri\/Cargo.toml --target x86_64-unknown-linux-gnu -e features -i rfd/);
  assert.doesNotMatch(source.slice(0, source.indexOf('permissions:')), /paths:/);
});
