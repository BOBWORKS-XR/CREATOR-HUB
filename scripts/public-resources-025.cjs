'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const hash=b=>require('node:crypto').createHash('sha256').update(b).digest('hex');
const {readBounded}=require('./read-bounded-input.cjs');
const binding=require('./fixtures/public-update-025-binding.json');
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
function itemFor(version) { assert.ok(['0.1.26', '0.1.27'].includes(version)); return version === '0.1.26' ? binding.baseline : binding.target; }
function assertInstalledResources(directory, version) {
  const item = itemFor(version); readHash(path.join(directory, 'creator-hub.exe'), item.executable.sha256, 'creator-hub.exe');
  const files = { ...item.manifest.modules.mcp.files, ...item.manifest.modules.setup.files, ...item.manifest.managedRouting.files };
  for (const [name, sha] of Object.entries(files)) readHash(path.join(directory, 'modules', name), sha, `modules/${name}`);
}
function managedLocations(local, version, home) {
  itemFor(version);
  assert.ok(path.win32.isAbsolute(local), 'Explicit Windows LocalAppData required');
  assert.ok(path.win32.isAbsolute(home || ''), 'Explicit Windows home required; no AppData fallback');
  const base = path.join(home, '.creator-hub');
  const root = path.join(base, 'mcp-route-v1/windows-x86_64');
  const router = 'router-v2';
  return { base, root, router, active: path.join(root, 'active.json'),
    command: path.join(root, router, 'creator-hub-mcp-router.exe'),
    payload: path.join(base, 'runtime-generations/windows-x86_64', itemFor(version).generation) };
}
function assertGenerationProcess(image, local, version, home) {
  const expected = path.join(managedLocations(local, version, home).payload, 'mcp/server/runtime/node.exe');
  assert.equal(path.win32.normalize(image).toLowerCase(), path.win32.normalize(expected).toLowerCase());
  readHash(expected, itemFor(version).manifest.modules.mcp.files['mcp/server/runtime/node.exe']);
}
function assertActiveResources(local, version, value, current = true, home) {
  const item = itemFor(version), locations = managedLocations(local, version, home), root = locations.root;
  const files = item.manifest.managedRouting.files;
  assert.deepEqual(value, { schemaVersion: 1, descriptorSha256: files['routing/runtime.json'], generation: item.generation });
  for (const name of ['runtime.json', 'runtime.minisig']) readHash(path.join(root, 'descriptors', value.descriptorSha256, name), files[`routing/${name}`]);
  for (const name of ['router.json', 'router.minisig', 'creator-hub-mcp-router.exe'])
    readHash(path.join(root, locations.router, name), files[`routing/${name}`]);
  const identity = JSON.parse(readBounded(path.join(root, locations.router, 'router.json'), 32768));
  assert.deepEqual(identity, { schemaVersion: 1, product: 'com.creatorworks.hub.mcp-router',
    platform: 'windows', arch: 'x86_64', protocol: 1,
    storeBinding: 2, sha256: files['routing/creator-hub-mcp-router.exe'] });
  for (const [name, sha] of Object.entries(item.manifest.modules.mcp.files)) readHash(path.join(locations.payload, name), sha);
  if (current) assert.deepEqual(JSON.parse(readBounded(path.join(root, 'active.json'), 4096)), value);
}
function assertFreshConnection(held, fresh, profile) {
  assert.equal(held.length, 2); assert.equal(fresh.length, 2);
  for (const row of [...held, ...fresh]) {
    assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0);
    assert.match(row.startTicks, /^[0-9]+$/); assert.ok(BigInt(row.startTicks) > 0n);
    assert.equal(row.kernelIdentityVerified, true);
  }
  assert.equal(new Set([...held, ...fresh].map(row => row.pid)).size, 4, 'Genuinely new router and runtime required');
  for (const rows of [held, fresh]) assert.equal(rows[1].parentPid, rows[0].pid);
  const normalize = image => path.win32.normalize(image).toLowerCase();
  assert.ok(profile && profile.local && profile.home, 'Explicit old/new profile roots required');
  for (const [rows, version] of [[held, '0.1.26'], [fresh, '0.1.27']]) {
    const locations = managedLocations(profile.local, version, profile.home);
    assert.equal(normalize(rows[0].image), normalize(locations.command), 'Exact version-bound router required');
    assert.equal(normalize(rows[1].image), normalize(path.join(locations.payload, 'mcp/server/runtime/node.exe')),
      'Exact version-bound generation required');
  }
}

module.exports={readHash,readBounded,managedLocations,assertInstalledResources,assertGenerationProcess,assertActiveResources,assertFreshConnection,LIMITS:{installer:536870912,metadata:32768}};
