// Fixed, acceptance-only B03 -> outer-only 15. Never a public12 baseline override.
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const feed = require('./self-update-lab-feed.cjs');

const KIND = 'unified-outgoing-14-15';
const BASELINE = Object.freeze({ version: '0.1.14',
  sourceCommit: 'a914bb96abaca8837f586c25c341d24fe58fe73d',
  installer: 'edc47ecca5e80ce950d5b8ecf6bb32c46fa531e163b9d6ab7722b143a02a4e7a',
  exe: 'dd74917a67e360a479158d81149a385ad813da9213661959928543a8f366dfca',
  runtimeDescriptor: '68e32d4c1afe42e66756dbbecd9306c41442584780bf3e1f41355d8b6f1b0d19',
  builtinManifest: '2dff1bf72723703afb8e0fd66e17b4af3b6510675c042bc9a4fb08f75f6c9464' });
const TARGET = Object.freeze({ version: '0.1.15',
  runtimeDescriptor: '712c74d83ebdacc9a8beb45f19c962be2862db01bb2b95f604e3947886351183',
  runtimeSignature: '7c627fecbf4936b799170415e152453e885516b5095d43237976f4c59877c85c',
  asset: 'Creator_Hub_0.1.15_x64-acceptance-only-setup.exe',
  pins: Object.freeze({
    descriptor: '9342f77a3e235fc427422b24d54a701af0646d678dc43e67da1bf9971213fa94',
    descriptorSignature: '8ad9a7082f1fe5b8535ae6235e13b2335af10d508396696ed8c01f67e2f00fd4',
    installer: 'aef9b9fa3045dbd8f4e0770ef51d037a2f9add3240a7f738b5a2d5b32505eb61',
    executable: '13690d6ca45f9b45bd7c05892ab2d1999962c84588f893d29609624abdaf21df',
    manifest: '42f7ec53952721ac76e638da595c0faeee93ab31a0d120aeaf0a5f2ae0843566',
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
  assert.equal(config.baselineVersion, BASELINE.version, 'Only genuine B03 14 is admitted');
  assert.equal(config.targetVersion, TARGET.version, 'Only reviewed outer-only 15 is admitted');
  assert.deepEqual(config.pins, TARGET.pins, 'Reviewed outgoing pins changed');
  assert.ok(typeof config.directory === 'string' && path.isAbsolute(config.directory), 'Absolute signed input directory required');
  assert.ok(typeof config.builtinManifestPath === 'string' && path.isAbsolute(config.builtinManifestPath), 'Absolute staged built-in manifest required');
  return config;
}
function readBuiltinManifest(file) {
  const bytes = feed.readBounded(file, feed.LIMITS.metadata);
  assert.equal(hash(bytes), BASELINE.builtinManifest, 'Reviewed B03 private manifest differs');
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
  assert.equal(hash(installer), BASELINE.installer, 'Exact B03 NSIS installer required');
  assert.equal(hash(executable), BASELINE.exe, 'Installed B03 executable required, not the pre-NSIS build');
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
