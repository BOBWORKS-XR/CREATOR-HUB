'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {readBounded}=require('./read-bounded-input.cjs');
const binding=require('./fixtures/public-update-020-binding.json');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function readHash(file, expected, relativePath = path.basename(file)) {
  let stat, bytes;
  try {
    stat = fs.lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink());
    bytes = readBounded(file, 512 * 1024 * 1024);
    assert.equal(hash(bytes), expected, relativePath);
  } catch (error) {
    error.resourceDiagnostic = { relativePath, absolutePath: file, expectedSha256: expected,
      lstat: stat ? { isFile: stat.isFile(), isDirectory: stat.isDirectory(), isSymbolicLink: stat.isSymbolicLink(), size: stat.size, mtimeMs: stat.mtimeMs } : null,
      actualSha256: bytes ? hash(bytes) : null, hashAvailable: Boolean(bytes), code: error.code || null };
    error.message = `${relativePath}: ${error.message}`;
    throw error;
  }
}
function itemFor(version) { assert.ok(['0.1.19', '0.1.20'].includes(version)); return version === '0.1.19' ? binding.baseline : binding.target; }
function assertInstalledResources(directory, version) {
  const item = itemFor(version); readHash(path.join(directory, 'creator-hub.exe'), item.executable.sha256, 'creator-hub.exe');
  const files = { ...item.manifest.modules.mcp.files, ...item.manifest.modules.setup.files, ...item.manifest.managedRouting.files };
  for (const [name, sha] of Object.entries(files)) readHash(path.join(directory, 'modules', name), sha, `modules/${name}`);
}
function payloadRoot(local, version) { return path.join(local, 'creator-hub/runtime-generations/windows-x86_64', itemFor(version).generation); }
function assertGenerationProcess(image, local, version) {
  const expected = path.join(payloadRoot(local, version), 'mcp/server/runtime/node.exe');
  assert.equal(path.win32.normalize(image).toLowerCase(), path.win32.normalize(expected).toLowerCase());
  readHash(expected, itemFor(version).manifest.modules.mcp.files['mcp/server/runtime/node.exe']);
}
function assertActiveResources(local, version, value, current = true) {
  const item = itemFor(version), root = path.join(local, 'creator-hub/mcp-route-v1/windows-x86_64');
  const files = item.manifest.managedRouting.files;
  assert.deepEqual(value, { schemaVersion: 1, descriptorSha256: files['routing/runtime.json'], generation: item.generation });
  for (const name of ['runtime.json', 'runtime.minisig']) readHash(path.join(root, 'descriptors', value.descriptorSha256, name), files[`routing/${name}`]);
  for (const name of ['router.json', 'router.minisig', 'creator-hub-mcp-router.exe'])
    readHash(path.join(root, 'router-v1', name), binding.baseline.manifest.managedRouting.files[`routing/${name}`]);
  for (const [name, sha] of Object.entries(item.manifest.modules.mcp.files)) readHash(path.join(payloadRoot(local, version), name), sha);
  if (current) assert.deepEqual(JSON.parse(readBounded(path.join(root, 'active.json'), 4096)), value);
}

module.exports={readHash,assertInstalledResources,assertGenerationProcess,assertActiveResources,readBounded,hash,LIMITS:{installer:536870912,metadata:32768}};
