const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { prepare, routeFiles } = require('./managed-router-package.cjs');
const { verifyStage, moduleFiles } = require('./build-unified.cjs');
const { testSigner } = require('./generate-router-test-fixtures.cjs');
test('managed package binds exactly its signed router and retained runtime; changed payloads refuse', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-routing-package-'));
  try {
    const manifest = { schemaVersion: 1, platform: 'windows', arch: 'x86_64', modules: {} };
    for (const id of ['mcp', 'setup']) {
      const names = moduleFiles(id, manifest.platform);
      const files = {};
      for (const name of names) {
        const file = path.join(root, 'modules', name); fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, id); files[name] = crypto.createHash('sha256').update(id).digest('hex');
      }
      manifest.modules[id] = { executable: names[0], version: '1.0.0', files };
    }
    const runtime = require('./mcp-runtime-descriptor.cjs').writeRuntimeDescriptor(root, manifest, '0.1.13');
    const router = path.join(root, 'router.exe'); fs.writeFileSync(router, 'never-executed fixture');
    const signer = testSigner();
    manifest.managedRouting = prepare(root, manifest, router, runtime, file => signer.sign(fs.readFileSync(file)));
    assert.deepEqual(Object.keys(manifest.managedRouting.files).sort(), routeFiles('windows').sort());
    verifyStage(path.join(root, 'modules'), manifest);
    assert.throws(() => prepare(root, manifest, router, runtime, () => ''), /already exists/);
    const file = path.join(root, 'modules/routing/runtime.minisig'); fs.appendFileSync(file, 'modified');
    assert.throws(() => verifyStage(path.join(root, 'modules'), manifest), /package changed/);
    delete manifest.managedRouting.files['routing/runtime.minisig'];
    assert.throws(() => verifyStage(path.join(root, 'modules'), manifest), /Invalid managed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('only fixed native route filenames can enter resources', () => {
  for (const platform of ['windows', 'linux', 'macos']) {
    assert.equal(routeFiles(platform).length, 5);
    assert.ok(routeFiles(platform).every(name => require('./build-unified.cjs').relativeFile(name)));
  }
});
