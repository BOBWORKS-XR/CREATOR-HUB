const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function registry(source, expression, itemPattern) {
  const match = source.match(expression);
  assert.ok(match, 'The explicit command registry could not be read');
  const entries = match[1].split(',').map(value => value.trim()).filter(Boolean);
  assert.ok(entries.length > 0, 'The command registry is empty');
  return entries.map(entry => {
    assert.match(entry, itemPattern, `Unknown command registry syntax: ${entry}`);
    return entry.replaceAll('"', '').split('::').at(-1);
  });
}

function checkRegistry(main, build, capability) {
  const commands = registry(main, /tauri::generate_handler!\[([\s\S]*?)\];/, /^(?:[a-z_]+::)*[a-z_]+$/);
  const declared = registry(build, /AppManifest::new\(\)\.commands\(&\[([\s\S]*?)\]\)/, /^"[a-z_]+"$/);
  assert.equal(new Set(commands).size, commands.length, 'Duplicate invoke command');
  assert.equal(new Set(declared).size, declared.length, 'Duplicate generated permission');
  assert.deepEqual([...commands].sort(), [...declared].sort(), 'Generated permissions differ from the invoke handler');
  assert.deepEqual(capability.windows, ['main']);
  assert.equal(capability.remote, undefined);
  const customPermissions = capability.permissions.filter(permission => !permission.startsWith('core:'));
  assert.deepEqual([...customPermissions].sort(), commands.map(command => `allow-${command.replaceAll('_', '-')}`).sort(),
    'Main-window command grants differ from the invoke handler');
}

test('every registered Hub command has exactly its generated main-window permission', () => {
  const root = path.join(__dirname, '..', 'src-tauri');
  checkRegistry(fs.readFileSync(path.join(root, 'src', 'main.rs'), 'utf8'),
    fs.readFileSync(path.join(root, 'build.rs'), 'utf8'),
    JSON.parse(fs.readFileSync(path.join(root, 'capabilities', 'default.json'), 'utf8')));
});

test('the pre-build check rejects new handlers without permissions and unintended remote or extra grants', () => {
  const main = 'tauri::generate_handler![usage_terms::accept_usage_terms, usage_terms::usage_terms_status];';
  const build = 'AppManifest::new().commands(&["accept_usage_terms", "usage_terms_status"])';
  const capability = { windows: ['main'], permissions: ['allow-accept-usage-terms', 'allow-usage-terms-status'] };
  checkRegistry(main, build, capability);
  assert.throws(() => checkRegistry(main, build.replace(', "usage_terms_status"', ''), capability));
  assert.throws(() => checkRegistry(main, build, { ...capability, permissions: ['allow-accept-usage-terms'] }));
  assert.throws(() => checkRegistry(main, build, { ...capability, windows: ['*'] }));
  assert.throws(() => checkRegistry(main, build, { ...capability, remote: { urls: ['https://example.com'] } }));
  assert.throws(() => checkRegistry(main, build, { ...capability, permissions: [...capability.permissions, 'allow-unrelated'] }));
});

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
