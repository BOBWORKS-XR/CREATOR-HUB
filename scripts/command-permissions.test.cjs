const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Hub self-update commands are registered and allowed only in the main window', () => {
  const root = path.join(__dirname, '..', 'src-tauri');
  const build = fs.readFileSync(path.join(root, 'build.rs'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src', 'main.rs'), 'utf8');
  const capability = JSON.parse(fs.readFileSync(path.join(root, 'capabilities', 'default.json'), 'utf8'));
  assert.deepEqual(capability.windows, ['main']);
  assert.equal(capability.remote, undefined);
  for (const command of ['hub_update_status', 'download_hub_update', 'install_hub_update', 'pending_hosted_restore', 'restore_hosted_app', 'complete_hosted_restore']) {
    assert.ok(build.includes(`"${command}"`), `${command} missing from generated permissions`);
    assert.ok(main.includes(`${command.includes('restore') ? 'hosted_restore' : 'self_update'}::${command},`), `${command} missing from invoke handler`);
    assert.ok(capability.permissions.includes(`allow-${command.replaceAll('_', '-')}`), `${command} blocked by main-window ACL`);
  }
});

test('MCP disconnect is registered and allowed only in the trusted main window', () => {
  const root = path.join(__dirname, '..', 'src-tauri');
  const build = fs.readFileSync(path.join(root, 'build.rs'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src', 'main.rs'), 'utf8');
  const capability = JSON.parse(fs.readFileSync(path.join(root, 'capabilities', 'default.json'), 'utf8'));
  assert.deepEqual(capability.windows, ['main']);
  assert.equal(capability.remote, undefined);
  assert.ok(build.includes('"disconnect_mcp"'), 'disconnect_mcp missing from generated permissions');
  assert.ok(main.includes('        disconnect_mcp,'), 'disconnect_mcp missing from invoke handler');
  assert.ok(capability.permissions.includes('allow-disconnect-mcp'), 'disconnect_mcp blocked by main-window ACL');
  assert.ok(main.includes('Hub commands are available only to its trusted shell.'));
});
