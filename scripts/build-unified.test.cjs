const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { relativeFile, moduleFiles, verifyStage } = require('./build-unified.cjs');

test('native built-in acceptance refuses the user PC before inspecting apps', () => {
  const result = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, 'native-builtin-smoke.cjs')], {
    encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '' }, windowsHide: true,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restricted to a disposable/);
});

test('bundle file names cannot traverse or use alternate absolute paths', () => {
  assert.equal(relativeFile('mcp/server/runtime/node.exe'), true);
  for (const name of ['', '../mcp', '/mcp', 'C:/mcp', 'mcp\\file', 'mcp//file', 'mcp/./file']) assert.equal(relativeFile(name), false, name);
});
test('both internal backends must exist and match their build hashes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-builtins-'));
  try {
    const manifest = { schemaVersion: 1, platform: 'windows', arch: 'x86_64', modules: {} };
    for (const id of ['mcp', 'setup']) {
      const names = moduleFiles(id, manifest.platform);
      const files = {};
      for (const name of names) {
        fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
        fs.writeFileSync(path.join(dir, name), id);
        files[name] = crypto.createHash('sha256').update(id).digest('hex');
      }
      manifest.modules[id] = { executable: names[0], version: '1.0.0', files };
    }
    verifyStage(dir, manifest);
    const original = manifest.modules.mcp.files;
    manifest.modules.mcp.files = { [manifest.modules.mcp.executable]: original[manifest.modules.mcp.executable] };
    assert.throws(() => verifyStage(dir, manifest), /incomplete/);
    manifest.modules.mcp.files = original;
    for (const version of ['invalid', null, undefined, 277, '', 'v2.7.7', '02.7.7']) {
      manifest.modules.mcp.version = version;
      assert.throws(() => verifyStage(dir, manifest), /module payload/);
    }
    manifest.modules.mcp.version = '1.0.0';
    const runtime = moduleFiles('mcp', 'windows').find(name => name.endsWith('/runtime/node.exe'));
    fs.unlinkSync(path.join(dir, runtime));
    assert.throws(() => verifyStage(dir, manifest));
    fs.writeFileSync(path.join(dir, runtime), 'mcp');
    fs.writeFileSync(path.join(dir, manifest.modules.mcp.executable), 'changed');
    assert.throws(() => verifyStage(dir, manifest), /changed/);
    fs.unlinkSync(path.join(dir, manifest.modules.mcp.executable));
    assert.throws(() => verifyStage(dir, manifest));
    delete manifest.modules.mcp;
    assert.throws(() => verifyStage(dir, manifest), /manifest/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
