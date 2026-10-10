const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const test = require('node:test');
const { moduleFiles } = require('./build-unified.cjs');
const { runtimeDescriptor, writeRuntimeDescriptor } = require('./mcp-runtime-descriptor.cjs');

function manifest(platform = 'windows', arch = 'x86_64') {
  const modules = {};
  for (const id of ['mcp', 'setup']) {
    const names = moduleFiles(id, platform);
    modules[id] = { executable: names[0], version: id === 'mcp' ? '2.7.7' : '0.3.7',
      files: Object.fromEntries(names.map(name => [name, crypto.createHash('sha256').update(name).digest('hex')])) };
  }
  return { schemaVersion: 1, platform, arch, modules };
}

test('runtime signing input has the exact scoped identity, target and deterministic generation fields', () => {
  for (const [platform, arch] of [['windows', 'x86_64'], ['linux', 'x86_64'], ['macos', 'aarch64'], ['macos', 'x86_64']]) {
    const value = manifest(platform, arch);
    const before = structuredClone(value);
    const result = runtimeDescriptor(value, '0.1.13');
    assert.equal(result.product, 'com.creatorworks.hub.mcp-runtime');
    assert.equal(result.hubVersion, '0.1.13'); assert.equal(result.platform, platform); assert.equal(result.arch, arch);
    assert.equal(result.module.version, '2.7.7'); assert.deepEqual(Object.keys(result.module.files), moduleFiles('mcp', platform).sort());
    const serialized = JSON.stringify(result);
    value.modules.mcp.files = Object.fromEntries(Object.entries(value.modules.mcp.files).reverse());
    assert.equal(JSON.stringify(runtimeDescriptor(value, '0.1.13')), serialized);
    assert.deepEqual(result.module.files, before.modules.mcp.files);
  }
});

test('runtime input refuses invalid versions, incomplete payloads, wrong targets and executable paths', () => {
  for (const version of ['v0.1.13', '0.1.13+other-build', '../0.1.13', '', null]) {
    assert.throws(() => runtimeDescriptor(manifest(), version), /canonical Hub version/);
  }
  for (const mutate of [value => { value.platform = 'other'; }, value => { value.arch = 'other'; },
    value => { value.modules.mcp.executable = '../other.exe'; }, value => { value.modules.mcp.version = 'garbage'; },
    value => { delete value.modules.mcp.files['mcp/server/runtime/LICENSE']; },
    value => { value.modules.mcp.files['mcp/server/runtime/node.exe'] = 'a'.repeat(63); },
    value => { value.modules.mcp.version = null; },
    value => { value.modules.mcp.files['mcp/server/runtime/node.exe'] = ['a'.repeat(64)]; },
    value => { value.modules.mcp.files['mcp/server/extra.exe'] = 'a'.repeat(64); }]) {
    const value = manifest(); mutate(value); assert.throws(() => runtimeDescriptor(value, '0.1.13'));
  }
});

test('signing input is written once only after actual module bytes match, without activating a route', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-descriptor-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const value = manifest();
  for (const entry of Object.values(value.modules)) {
    for (const name of Object.keys(entry.files)) {
      const file = path.join(directory, 'modules', name);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, name);
    }
  }
  const file = writeRuntimeDescriptor(directory, value, '0.1.13');
  const before = fs.readFileSync(file);
  assert.deepEqual(JSON.parse(before), runtimeDescriptor(value, '0.1.13'));
  assert.throws(() => writeRuntimeDescriptor(directory, value, '0.1.13'), /EEXIST/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['mcp-runtime.json', 'modules']);
});

test('a changed actual runtime refuses metadata production without altering the payload', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'invalid-runtime-descriptor-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const value = manifest();
  for (const entry of Object.values(value.modules)) {
    for (const name of Object.keys(entry.files)) {
      const file = path.join(directory, 'modules', name);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, name);
    }
  }
  const node = path.join(directory, 'modules', 'mcp/server/runtime/node.exe');
  fs.writeFileSync(node, 'changed');
  assert.throws(() => writeRuntimeDescriptor(directory, value, '0.1.13'), /changed/);
  assert.equal(fs.existsSync(path.join(directory, 'mcp-runtime.json')), false);
  assert.equal(fs.readFileSync(node, 'utf8'), 'changed');
});
