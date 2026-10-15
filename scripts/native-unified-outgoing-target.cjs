// Fixed, acceptance-only B05 -> outer-only 15. Never a public12 baseline override.
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const feed = require('./self-update-lab-feed.cjs');

const KIND = 'unified-outgoing-14-15';
const BASELINE = Object.freeze({ version: '0.1.14',
  sourceCommit: 'db862739d01088ba9be335d0522f8f129222a48b',
  installer: '284820f92de487e8a0f1bb5b3b99cafe5e073f0402a9350a2ea6e76fa9543157',
  exe: 'cd5e3fd2829727d06444c0f3266b178798d1b55c63df651be12eb38ac4523a86',
  runtimeDescriptor: '1b78bb735b41df55ea90ff59e72b41c410ff04115edcd88fcdc9d63878503e04',
  builtinManifest: '6be984c3358ce956154ecf6aa38532320e0be2765d54285a12183319121bb4cb' });
const TARGET = Object.freeze({ version: '0.1.15',
  runtimeDescriptor: 'ce1c3dff78465797f3b076459f272be4231b15f163416a15598a6b154afacdb7',
  runtimeSignature: 'eaf29525c977087cffcf1d31a6889053378b30420da5065720fa33c5a1fd1842',
  asset: 'Creator_Hub_0.1.15_x64-acceptance-only-setup.exe',
  pins: Object.freeze({
    descriptor: '71c1b171c50057d017cb5537ddca3e5969a603fa0f80c558b06841e80f56c9e2',
    descriptorSignature: '2e13732502c46f97db1df79e29b16098af1e3946dda6a215e917465aa07d57c8',
    installer: 'af98b72c460b741e4c09afa0c2314c8d1976a7888943608aabfe2caade17149a',
    executable: '7d62790ecd9fd0576ae97f72665f25febfbe62549ca6699b43dd4603182ffc06',
    manifest: '45bd238e757e07dadf5114e0355fff3e0ee2d2bca36cd350f5ef26272ada7366',
  }) });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function keys(value, expected, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), label);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), label);
}
function validateConfig(config) {
  keys(config, ['schemaVersion', 'kind', 'baselineVersion', 'targetVersion', 'directory', 'builtinManifestPath', 'pins'], 'Outgoing config fields');
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.kind, KIND);
  assert.equal(config.baselineVersion, BASELINE.version, 'Only genuine B05 14 is admitted');
  assert.equal(config.targetVersion, TARGET.version, 'Only reviewed outer-only 15 is admitted');
  assert.deepEqual(config.pins, TARGET.pins, 'Reviewed outgoing pins changed');
  assert.ok(typeof config.directory === 'string' && path.isAbsolute(config.directory), 'Absolute signed input directory required');
  assert.ok(typeof config.builtinManifestPath === 'string' && path.isAbsolute(config.builtinManifestPath), 'Absolute staged built-in manifest required');
  return config;
}
function readBuiltinManifest(file) {
  const bytes = feed.readBounded(file, feed.LIMITS.metadata);
  assert.equal(hash(bytes), BASELINE.builtinManifest, 'Reviewed B05 private manifest differs');
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.platform, 'windows'); assert.equal(manifest.arch, 'x86_64');
  assert.equal(manifest.modules.mcp.version, '2.7.7'); assert.equal(manifest.modules.setup.version, '0.3.7');
  assert.equal(manifest.managedRouting.protocol, 1);
  return manifest;
}
function requireFactory() {
  assert.equal(typeof feed.createUnifiedOutgoingContract, 'function',
    'Owner integration required: fixed createUnifiedOutgoingContract(input); public12 factory is not a substitute');
  return feed.createUnifiedOutgoingContract;
}
function verifyContract(contract) {
  assert.equal(contract.targetVersion, TARGET.version);
  assert.equal(contract.baseline.version, BASELINE.version);
  assert.equal(contract.baseline.installer, BASELINE.installer);
  assert.equal(contract.baseline.exe, BASELINE.exe);
  assert.deepEqual(contract.pins, TARGET.pins);
  const prefix = `/BOBWORKS-XR/CREATOR-HUB/releases/download/v${TARGET.version}/`;
  assert.deepEqual(contract.routes.map(({ host, path: routePath }) => ({ host, path: routePath })), [
    { host: 'api.github.com', path: feed.FEED_PATH },
    ...[feed.DESCRIPTOR, `${feed.DESCRIPTOR}.minisig`, TARGET.asset, 'latest.json']
      .map(name => ({ host: 'github.com', path: `${prefix}${name}` })),
  ], 'Exactly the existing five bounded routes required');
  return contract;
}
function loadContract(config) {
  validateConfig(config);
  const factory = requireFactory(); // Refuse before reading installer bytes if owner API is absent.
  readBuiltinManifest(config.builtinManifestPath);
  const read = (name, max) => feed.readBounded(path.join(config.directory, name), max);
  const input = { targetVersion: TARGET.version, pins: { ...TARGET.pins },
    descriptor: read(feed.DESCRIPTOR, feed.LIMITS.metadata),
    descriptorSignature: read(`${feed.DESCRIPTOR}.minisig`, feed.LIMITS.signature),
    installer: read(TARGET.asset, feed.LIMITS.installer), manifest: read('latest.json', feed.LIMITS.metadata) };
  for (const name of ['descriptor', 'descriptorSignature', 'installer', 'manifest']) {
    assert.equal(hash(input[name]), TARGET.pins[name], `${name} differs from reviewed fixture`);
  }
  return verifyContract(factory(input));
}
function assertBaselineBytes(installer, executable) {
  assert.ok(Buffer.isBuffer(installer) && installer.length > 0 && installer.length <= feed.LIMITS.installer);
  assert.ok(Buffer.isBuffer(executable) && executable.length > 0 && executable.length <= feed.LIMITS.installer);
  assert.equal(hash(installer), BASELINE.installer, 'Exact B05 NSIS installer required');
  assert.equal(hash(executable), BASELINE.exe, 'Installed B05 executable required, not the pre-NSIS build');
}
function assertProxy(env) {
  feed.assertRunner(env);
  assert.equal(env.CREATOR_HOSTED_UPDATE_FIXTURE, undefined, 'No baseline version masquerade');
  for (const name of ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'ALL_PROXY', 'NODE_OPTIONS',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE']) {
    assert.equal(env[name], undefined, `Unreviewed TLS/environment override: ${name}`);
  }
  const url = new URL(env.HTTPS_PROXY || '');
  assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1' && /^\d+$/.test(url.port) &&
    Number(url.port) > 0 && Number(url.port) <= 65535 && !url.username && !url.password &&
    url.pathname === '/' && !url.search && !url.hash, 'Owned loopback proxy required');
  assert.equal(env.HTTP_PROXY, env.HTTPS_PROXY, 'HTTP/HTTPS must share the owned proxy');
  assert.equal(env.NO_PROXY, '127.0.0.1,localhost,::1');
}
function selectLab(configPath, env = process.env) {
  assertProxy(env);
  assert.ok(path.isAbsolute(configPath), 'Absolute outgoing config path required');
  const config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(feed.readBounded(configPath, feed.LIMITS.metadata)));
  const contract = loadContract(config);
  for (const [name, expected] of Object.entries({ CREATOR_SELF_UPDATE_TARGET_VERSION: TARGET.version,
    CREATOR_SELF_UPDATE_INSTALLER_SHA256: TARGET.pins.installer,
    CREATOR_SELF_UPDATE_EXECUTABLE_SHA256: TARGET.pins.executable })) {
    assert.equal(env[name], expected, `Lifecycle target binding differs: ${name}`);
  }
  return contract;
}
function discoveryScope(contract) {
  verifyContract(contract);
  return { kind: KIND, labDiscovery: true, publicDiscovery: false, acceptanceOnly: true,
    baselineVersion: BASELINE.version, baselineSourceCommit: BASELINE.sourceCommit,
    targetVersion: TARGET.version, pins: { ...TARGET.pins }, frameworkSdkOnly: true,
    liveAiAcceptance: false, productAcceptance: false, releaseReady: false };
}
module.exports = { KIND, BASELINE, TARGET, hash, validateConfig, readBuiltinManifest, verifyContract, requireFactory,
  loadContract, assertBaselineBytes, assertProxy, selectLab, discoveryScope,
  assertRunner: feed.assertRunner, readBounded: feed.readBounded, LIMITS: feed.LIMITS,
  startLabProxy: feed.startLabProxy };
