'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const feed = require('./self-update-outgoing-018-feed.cjs');
const binding = require('./fixtures/windows-outgoing-018-binding.json');
const KIND = 'direct-outgoing-017-018';
const ASSET = 'Creator_Hub_0.1.18_x64-acceptance-only-setup.exe';
const BASELINE_ASSET = 'Creator.Hub_0.1.17_x64-setup.exe';
const CASES = Object.freeze({ 'mcp-restore': ['mcp', 'true'], 'setup-restore': ['setup', 'true'], 'setup-no-restore': ['setup', 'false'] });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const generation = module => hash(JSON.stringify({ executable: module.executable, version: module.version,
  files: Object.fromEntries(Object.entries(module.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) }));
function validateBinding(value = binding) {
  assert.equal(value.enabled, true, 'Private signed18 metadata is not bound');
  assert.equal(value.kind, KIND); assert.equal(value.baseline.version, '0.1.17'); assert.equal(value.target.version, '0.1.18');
  assert.deepEqual(value.baseline.source, { commit: 'ec7f1d218c187caac30d0170aaaca2dfcdf83766', tree: '11efac78fc7509e8da08de3af7262bfc6369ce5c' });
  assert.deepEqual(value.target.source, { commit: 'd58513d27d35b6c3bd200367e358e20162cc0efa', tree: 'e2f3f8750346dedc9c739912c9aa24eb7e8b7dcf' });
  assert.equal(value.target.recoveryReceiptSha256, 'b03ae78dbae79e246b21fc2f16ba23c48050448d86d87b015aa26924264a19f0');
  assert.equal(value.target.rawSourceUnchanged, false); assert.equal(value.target.originalBuildExitCode, 1);
  assert.equal(value.baseline.installer.sha256, '4b8f3f34ed0d3ca06ba92230b37f8f8b4f75da772cb285a4129d9b3068dd4f9e');
  assert.equal(value.baseline.executable.sha256, 'ab73d243fc6ba7ec956bf59b12679f736ecbefa7131bac678347e5a7b1618337');
  assert.equal(value.target.installer.sha256, '65518b1f4ce59b9468c3b4d77a04ff7d7145eefa99131abdbbf97748db568f00');
  assert.equal(value.target.executable.sha256, 'ce1ebfd38bae2e670fac7f9876b41914e1ee55e5605f703af4aa76aec5cccb10');
  assert.equal(value.baseline.asset, BASELINE_ASSET); assert.equal(value.target.asset, ASSET);
  for (const item of [value.baseline, value.target]) {
    assert.equal(item.generation, generation(item.manifest.modules.mcp));
    const files = { ...item.manifest.modules.mcp.files, ...item.manifest.modules.setup.files, ...item.manifest.managedRouting.files };
    assert.equal(Object.keys(files).length, 15); for (const sha of Object.values(files)) assert.match(sha, /^[a-f0-9]{64}$/);
  }
  assert.notEqual(value.baseline.generation, value.target.generation);
  assert.equal(value.baseline.generation, '7ab7242c624f56d69b914e87e30a1bf68be9b1d7a6e9318cd993993cd9303fab');
  assert.equal(value.target.generation, '31dfb7a9ec10dfafed9113a6c3051211465264cbf8e447ce65d0870f7a61895b');
  assert.equal(value.baseline.manifest.modules.mcp.version, '2.7.7'); assert.equal(value.target.manifest.modules.mcp.version, '2.7.8-fixture.18');
  for (const item of [value.target.descriptor, value.target.descriptorSignature, value.target.latest]) {
    assert.ok(item && item.bytes > 0); assert.match(item.sha256, /^[a-f0-9]{64}$/);
  }
  assert.ok(value.target.privateRelease && Number.isSafeInteger(value.target.privateRelease.id) && value.target.privateRelease.id > 0);
  assert.equal(value.target.privateRelease.source, value.target.source.commit);
  assert.match(value.target.privateRelease.tag, /^lab-windows-outgoing-018-[0-9]+$/);
  assert.deepEqual(Object.keys(value.target.privateRelease.assets).sort(), [ASSET, 'creator-hub-windows-x86_64.json', 'creator-hub-windows-x86_64.json.minisig', 'latest.json'].sort());
  assert.equal(value.exceptionQualification.fixtureUsableForOutgoingTest, true);
  assert.equal(value.exceptionQualification.productionSourceGuardException, false); assert.equal(value.exceptionQualification.outgoingNativeAccepted, false);
  assert.match(value.exceptionQualification.sha256, /^[a-f0-9]{64}$/);
}
function assertHost(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32');
  for (const [key, expected] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_JOB: 'acceptance', GITHUB_REF: 'refs/heads/validation/windows-menu-merge-20261027',
    GITHUB_WORKFLOW_REF: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-outgoing-018.yml@refs/heads/validation/windows-menu-merge-20261027' })) assert.equal(env[key], expected, key);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/); assert.equal(env.EXPECTED_HARNESS_COMMIT, env.GITHUB_SHA);
  assert.ok(Object.hasOwn(CASES, env.CREATOR_OUTGOING_CASE));
  assert.deepEqual([env.CREATOR_OUTGOING_LAST_TOOL, env.CREATOR_OUTGOING_RESTORE], CASES[env.CREATOR_OUTGOING_CASE]);
  assert.equal(env.CREATOR_HOSTED_UPDATE_FIXTURE, undefined);
  validateBinding();
  assert.equal(env.CREATOR_OUTGOING_REVIEW_SHA256, hash(fs.readFileSync(path.join(__dirname, 'fixtures/windows-outgoing-018-binding.json'))));
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
    baseline: { version: '0.1.17', installer: binding.baseline.installer.sha256, exe: binding.baseline.executable.sha256 },
    targetVersion: '0.1.18', directory, pins: { descriptor: binding.target.descriptor.sha256,
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
  return feed.createDirectOutgoing018Contract({ targetVersion: config.targetVersion, baseline: config.baseline, pins: config.pins,
    descriptor: read(feed.DESCRIPTOR, binding.target.descriptor), descriptorSignature: read(`${feed.DESCRIPTOR}.minisig`, binding.target.descriptorSignature),
    installer: read(ASSET, binding.target.installer), manifest: read('latest.json', binding.target.latest) });
}
function readHash(file, expected) {
  const stat = fs.lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink());
  assert.equal(hash(feed.readBounded(file, 512 * 1024 * 1024)), expected, path.basename(file));
}
function itemFor(version) { assert.ok(['0.1.17', '0.1.18'].includes(version)); return version === '0.1.17' ? binding.baseline : binding.target; }
function assertInstalledResources(directory, version) {
  const item = itemFor(version); readHash(path.join(directory, 'creator-hub.exe'), item.executable.sha256);
  const files = { ...item.manifest.modules.mcp.files, ...item.manifest.modules.setup.files, ...item.manifest.managedRouting.files };
  for (const [name, sha] of Object.entries(files)) readHash(path.join(directory, 'modules', name), sha);
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
module.exports = { KIND, ASSET, BASELINE_ASSET, CASES, binding, hash, generation, validateBinding, assertHost, assertAdmission,
  configFor, assertBound, readConfig, loadContract, assertInstalledResources, assertGenerationProcess, assertActiveResources,
  readBounded: feed.readBounded, LIMITS: feed.LIMITS, assertRunner: assertHost, startLabProxy: feed.startLabProxy };
