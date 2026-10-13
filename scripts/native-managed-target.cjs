const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function managedLocations(localAppData) {
  assert.ok(path.isAbsolute(localAppData), 'Expected an absolute local data directory');
  const root = path.join(localAppData, 'creator-hub', 'mcp-route-v1', 'windows-x86_64');
  return { active: path.join(root, 'active.json'), command: path.join(root, 'router-v1', 'creator-hub-mcp-router.exe') };
}

function verifyMigratedTarget(entry, manifest, generation, localAppData) {
  if (manifest.managedRouting) {
    assert.equal(manifest.managedRouting.protocol, 1);
    const locations = managedLocations(localAppData);
    assert.equal(fs.realpathSync(entry.command), fs.realpathSync(locations.command));
    assert.deepEqual(entry.args, [], 'Managed clients must not retain mutable server arguments');
    const expected = manifest.managedRouting.files['routing/creator-hub-mcp-router.exe'];
    assert.match(expected, /^[a-f0-9]{64}$/);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(locations.command)).digest('hex'), expected,
      'Fresh native test must consume the exact packaged signed router');
  } else {
    assert.equal(fs.realpathSync(entry.command), fs.realpathSync(path.join(generation, 'mcp/server/runtime/node.exe')));
    assert.equal(fs.realpathSync(entry.args[0]), fs.realpathSync(path.join(generation, 'mcp/server/creator-works-mcp.mjs')));
  }
}

module.exports = { managedLocations, verifyMigratedTarget };
