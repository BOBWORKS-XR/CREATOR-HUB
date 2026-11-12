'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const feed = require('./self-update-outgoing-019-feed.cjs');
const binding = require('./fixtures/windows-outgoing-019-binding.json');
const KIND = 'direct-outgoing-022-023';
const ASSET = 'Creator.Hub_0.1.23_x64-setup.exe';
const BASELINE_ASSET = 'Creator.Hub_0.1.22_x64-setup.exe';
const CASES = Object.freeze({ 'mcp-restore': ['mcp', 'true'], 'setup-restore': ['setup', 'true'], 'setup-no-restore': ['setup', 'false'] });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const generation = module => hash(JSON.stringify({ executable: module.executable, version: module.version,
  files: Object.fromEntries(Object.entries(module.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) }));
const RESOURCE_PATHS = Object.freeze([
  "mcp/creator-works-mcp-launcher.exe",
  "mcp/server/LICENSE",
  "mcp/server/THIRD_PARTY_NOTICES.md",
  "mcp/server/creator-works-mcp.mjs",
  "mcp/server/runtime/LICENSE",
  "mcp/server/runtime/VERSION",
  "mcp/server/runtime/node.exe",
  "mcp/server/unity-extension/Editor/BanterMCPBridge.cs",
  "mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png",
  "routing/creator-hub-mcp-router.exe",
  "routing/router.json",
  "routing/router.minisig",
  "routing/runtime.json",
  "routing/runtime.minisig",
  "setup/creator-project-setup.exe"
]);
const SUPERSEDED_SOURCES = Object.freeze(['930a2886b6872a08a4a25be4738a5a01a4e911d2',
  'b6c806254746563e81a6715231d7ef6dfa081fc1', '3bed5cc1881cb6c85ef67abd493c68c2ffdb71b3']);
function pin(value, label, max = 512 * 1024 * 1024) {
  assert.ok(value && Number.isSafeInteger(value.bytes) && value.bytes > 0 && value.bytes <= max, label);
  assert.match(value.sha256 || '', /^[a-f0-9]{64}$/, label);
}
function source(value) {
  assert.match(value?.commit || '', /^[a-f0-9]{40}$/); assert.match(value?.tree || '', /^[a-f0-9]{40}$/);
  assert.ok(!SUPERSEDED_SOURCES.includes(value.commit), 'Published18, old lab19 and withdrawn19 source cannot qualify');
}
function validateBindingShape(value) {
  assert.equal(value.schemaVersion, 1); assert.equal(value.enabled, true, 'Pending exact22/private23 pins: native admission refused');
  assert.equal(value.privateOnly, true); assert.equal(value.kind, KIND);
  assert.equal(value.baseline.version, '0.1.22'); assert.equal(value.target.version, '0.1.23');
  assert.equal(value.baseline.asset, BASELINE_ASSET); assert.equal(value.target.asset, ASSET);
  for (const item of [value.baseline, value.target]) {
    source(item.source); pin(item.installer, 'installer'); pin(item.executable, 'executable');
    assert.equal(item.buildExitCode, 0); assert.equal(item.sourceUnchanged, true);
    assert.match(item.verificationReceiptSha256 || '', /^[a-f0-9]{64}$/);
    const manifest = item.manifest;
    assert.equal(manifest?.schemaVersion, 1); assert.equal(manifest.platform, 'windows'); assert.equal(manifest.arch, 'x86_64');
    assert.deepEqual(Object.keys(manifest.modules).sort(), ['mcp', 'setup']);
    assert.equal(manifest.modules.mcp.executable, 'mcp/creator-works-mcp-launcher.exe');
    assert.equal(manifest.modules.setup.executable, 'setup/creator-project-setup.exe');
    assert.match(manifest.modules.mcp.version, /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/);
    assert.match(manifest.modules.setup.version, /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/);
    assert.equal(manifest.managedRouting.protocol, 1);
    const files = { ...manifest.modules.mcp.files, ...manifest.modules.setup.files, ...manifest.managedRouting.files };
    assert.deepEqual(Object.keys(files).sort(), RESOURCE_PATHS);
    assert.deepEqual(Object.keys(manifest.modules.mcp.files).sort(), RESOURCE_PATHS.filter(name => name.startsWith('mcp/')));
    assert.deepEqual(Object.keys(manifest.modules.setup.files).sort(), RESOURCE_PATHS.filter(name => name.startsWith('setup/')));
    assert.deepEqual(Object.keys(manifest.managedRouting.files).sort(), RESOURCE_PATHS.filter(name => name.startsWith('routing/')));
    for (const sha of Object.values(files)) assert.match(sha, /^[a-f0-9]{64}$/);
    assert.equal(item.generation, generation(manifest.modules.mcp));
  }
  assert.notEqual(value.baseline.source.commit, value.target.source.commit);
  assert.notEqual(value.baseline.source.tree, value.target.source.tree);
  assert.notEqual(value.baseline.installer.sha256, value.target.installer.sha256);
  assert.notEqual(value.baseline.executable.sha256, value.target.executable.sha256);
  assert.equal(value.target.generation, generation(value.target.manifest.modules.mcp));
  assert.notEqual(value.baseline.manifest.modules.mcp.version, value.target.manifest.modules.mcp.version);
  for (const item of [value.baseline, value.target]) assert.equal(item.manifest.modules.setup.version, '0.3.7');
  assert.equal(value.target.manifest.modules.mcp.version, '2.7.10');
  assert.equal(value.baseline.manifest.modules.mcp.version, '2.7.9');
  for (const key of ['releaseId', 'assetId']) assert.ok(Number.isSafeInteger(value.baseline[key]) && value.baseline[key] > 0);
  for (const key of ['descriptor', 'descriptorSignature', 'latest']) pin(value.target[key], key, key === 'descriptorSignature' ? 4096 : 32768);
  const release = value.target.privateRelease;
  assert.ok(release && Number.isSafeInteger(release.id) && release.id > 0);
  assert.notEqual(value.baseline.releaseId, release.id);
  assert.equal(release.source, value.target.source.commit);
  assert.match(release.tag, /^lab-windows-capability-023-[a-z0-9-]+$/);
  const assetPins = { [ASSET]: value.target.installer, 'creator-hub-windows-x86_64.json': value.target.descriptor,
    'creator-hub-windows-x86_64.json.minisig': value.target.descriptorSignature, 'latest.json': value.target.latest };
  assert.deepEqual(Object.keys(release.assets).sort(), Object.keys(assetPins).sort());
  const ids = [value.baseline.assetId];
  for (const [name, expected] of Object.entries(assetPins)) {
    const actual = release.assets[name]; assert.ok(Number.isSafeInteger(actual.id) && actual.id > 0);
    assert.deepEqual({ bytes: actual.bytes, sha256: actual.sha256 }, expected); ids.push(actual.id);
  }
  assert.equal(new Set(ids).size, ids.length);
  const q = value.fixtureQualification;
  assert.equal(q.kind, 'outgoing23-candidate-only-verified'); assert.deepEqual(q.source, value.target.source);
  assert.equal(q.sha256, value.target.verificationReceiptSha256);
  assert.equal(q.sourceUnchanged, true); assert.equal(q.buildExitCode, 0);
  assert.ok(Number.isSafeInteger(q.inputCount) && q.inputCount > 0); assert.equal(q.payloadFiles, 15);
  assert.equal(q.fixtureUsableForOutgoingTest, true);
  for (const key of ['productionSourceGuardException', 'productionApproval', 'outgoingNativeAccepted', 'published', 'releaseReady']) assert.equal(q[key], false, key);
}
function validateBinding(value = binding) {
  validateBindingShape(value);
  assert.deepEqual(value, binding, 'Only the exact independently reviewed checked-in binding is admitted');
}
function assertHost(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32');
  for (const [key, expected] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_JOB: 'acceptance', GITHUB_REF: 'refs/heads/validation/windows-sdk-capability-023-20261112-r5',
    GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-outgoing-019.yml@refs/heads/validation/windows-sdk-capability-023-20261112-r5' })) assert.equal(env[key], expected, key);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/); assert.equal(env.EXPECTED_HARNESS_COMMIT, env.GITHUB_SHA);
  assert.ok(Object.hasOwn(CASES, env.CREATOR_OUTGOING_CASE));
  assert.deepEqual([env.CREATOR_OUTGOING_LAST_TOOL, env.CREATOR_OUTGOING_RESTORE], CASES[env.CREATOR_OUTGOING_CASE]);
  assert.equal(env.CREATOR_HOSTED_UPDATE_FIXTURE, undefined);
  validateBinding();
  assert.equal(env.CREATOR_OUTGOING_REVIEW_SHA256, hash(fs.readFileSync(path.join(__dirname, 'fixtures/windows-outgoing-019-binding.json'))));
}
function assertAdmission(env = process.env, platform = process.platform) {
  assertHost(env, platform);
  for (const name of ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'ALL_PROXY', 'NODE_OPTIONS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE']) assert.equal(env[name], undefined, name);
  const proxy = new URL(env.HTTPS_PROXY || '');
  assert.equal(proxy.protocol, 'http:'); assert.equal(proxy.hostname, '127.0.0.1');
  assert.ok(Number(proxy.port) > 0 && Number(proxy.port) <= 65535);
  assert.equal(proxy.username + proxy.password + proxy.search + proxy.hash, ''); assert.equal(proxy.pathname, '/');
  assert.equal(env.HTTP_PROXY, env.HTTPS_PROXY); assert.equal(env.NO_PROXY, '127.0.0.1,localhost,::1');
}
function configFor(directory) {
  validateBinding(); assert.ok(path.isAbsolute(directory));
  return { schemaVersion: 1, kind: KIND, sourceCommit: binding.target.source.commit,
    baseline: { version: '0.1.22', installer: binding.baseline.installer.sha256, exe: binding.baseline.executable.sha256 },
    targetVersion: '0.1.23', directory, pins: { descriptor: binding.target.descriptor.sha256,
      descriptorSignature: binding.target.descriptorSignature.sha256, installer: binding.target.installer.sha256,
      executable: binding.target.executable.sha256, manifest: binding.target.latest.sha256 },
    runtime: { baselineDescriptor: binding.baseline.manifest.managedRouting.files['routing/runtime.json'],
      targetDescriptor: binding.target.manifest.managedRouting.files['routing/runtime.json'] } };
}
function assertBound(config) { assert.deepEqual(config, configFor(config.directory)); }
function readConfig(file, env = process.env) {
  assert.ok(path.isAbsolute(file));
  const value = JSON.parse(feed.readBounded(file, 32768));
  assert.match(env.CREATOR_OUTGOING_CONFIG_SHA256 || '', /^[a-f0-9]{64}$/);
  assert.equal(hash(JSON.stringify(value)), env.CREATOR_OUTGOING_CONFIG_SHA256); assertBound(value); return value;
}
function loadContract(config, env = process.env) {
  assertBound(config); assert.equal(hash(JSON.stringify(config)), env.CREATOR_OUTGOING_CONFIG_SHA256);
  const read = (name, expected) => { const bytes = feed.readBounded(path.join(config.directory, name), expected.bytes);
    assert.equal(bytes.length, expected.bytes); assert.equal(hash(bytes), expected.sha256); return bytes; };
  read(BASELINE_ASSET, binding.baseline.installer);
  return feed.createDirectOutgoing019Contract({ targetVersion: config.targetVersion, baseline: config.baseline, pins: config.pins,
    descriptor: read(feed.DESCRIPTOR, binding.target.descriptor), descriptorSignature: read(`${feed.DESCRIPTOR}.minisig`, binding.target.descriptorSignature),
    installer: read(ASSET, binding.target.installer), manifest: read('latest.json', binding.target.latest) });
}
function readHash(file, expected, relativePath = path.basename(file)) {
  let stat, bytes;
  try {
    stat = fs.lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink());
    bytes = feed.readBounded(file, 512 * 1024 * 1024);
    assert.equal(hash(bytes), expected, relativePath);
  } catch (error) {
    error.resourceDiagnostic = { relativePath, absolutePath: file, expectedSha256: expected,
      lstat: stat ? { isFile: stat.isFile(), isDirectory: stat.isDirectory(), isSymbolicLink: stat.isSymbolicLink(), size: stat.size, mtimeMs: stat.mtimeMs } : null,
      actualSha256: bytes ? hash(bytes) : null, hashAvailable: Boolean(bytes), code: error.code || null };
    error.message = `${relativePath}: ${error.message}`;
    throw error;
  }
}
function itemFor(version) { assert.ok(['0.1.22', '0.1.23'].includes(version)); return version === '0.1.22' ? binding.baseline : binding.target; }
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
  if (current) assert.deepEqual(JSON.parse(feed.readBounded(path.join(root, 'active.json'), 4096)), value);
}
function assertFreshConnection(held, fresh) {
  assert.equal(held.length, 2); assert.equal(fresh.length, 2);
  for (const row of [...held, ...fresh]) {
    assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0);
    assert.match(row.startTicks, /^[0-9]+$/); assert.ok(BigInt(row.startTicks) > 0n);
    assert.equal(row.kernelIdentityVerified, true);
  }
  assert.equal(new Set([...held, ...fresh].map(row => row.pid)).size, 4, 'Genuinely new router and runtime required');
  for (const rows of [held, fresh]) assert.equal(rows[1].parentPid, rows[0].pid);
  const normalize = image => path.win32.normalize(image).toLowerCase();
  assert.equal(normalize(fresh[0].image), normalize(held[0].image), 'Retained owned router required');
  let root;
  for (const [rows, item] of [[held, binding.baseline], [fresh, binding.target]]) {
    const image = normalize(rows[1].image);
    const suffix = normalize(path.win32.join('creator-hub/runtime-generations/windows-x86_64', item.generation, 'mcp/server/runtime/node.exe'));
    assert.ok(path.win32.isAbsolute(image) && image.endsWith('\\' + suffix), 'Exact qualified generation runtime required');
    const parent = image.slice(0, -suffix.length);
    if (root === undefined) root = parent;
    else assert.equal(parent, root, 'Same owned runtime root required');
  }
}
module.exports = { assertFreshConnection, KIND, ASSET, BASELINE_ASSET, CASES, binding, hash, generation, RESOURCE_PATHS, validateBindingShape, validateBinding, assertHost, assertAdmission,
  configFor, assertBound, readConfig, loadContract, assertInstalledResources, assertGenerationProcess, assertActiveResources,
  readHash, readBounded: feed.readBounded, LIMITS: feed.LIMITS, assertRunner: assertHost, startLabProxy: feed.startLabProxy };
