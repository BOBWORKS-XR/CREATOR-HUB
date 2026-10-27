'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const feed = require('../../../scripts/self-update-lab-feed.cjs');
const KIND = 'direct-outgoing-016-017';
const ASSET = 'Creator_Hub_0.1.17_x64-acceptance-only-setup.exe';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function keys(value, names) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), 'Unexpected outgoing fields');
}
function validateConfig(config) {
  keys(config, ['schemaVersion', 'kind', 'sourceCommit', 'baseline', 'targetVersion', 'directory', 'pins', 'runtime']);
  assert.equal(config.schemaVersion, 1); assert.equal(config.kind, KIND);
  assert.match(config.sourceCommit, /^[a-f0-9]{40}$/);
  keys(config.baseline, ['version', 'installer', 'exe']);
  assert.equal(config.baseline.version, '0.1.16'); assert.equal(config.targetVersion, '0.1.17');
  keys(config.pins, ['descriptor', 'descriptorSignature', 'installer', 'executable', 'manifest']);
  keys(config.runtime, ['baselineDescriptor', 'targetDescriptor']);
  for (const value of [config.baseline.installer, config.baseline.exe, ...Object.values(config.pins), ...Object.values(config.runtime)]) {
    assert.match(value, /^[a-f0-9]{64}$/, 'Reviewed non-placeholder SHA256 required');
  }
  assert.notEqual(config.baseline.installer, config.pins.installer);
  assert.notEqual(config.baseline.exe, config.pins.executable);
  assert.notEqual(config.runtime.baselineDescriptor, config.runtime.targetDescriptor);
  assert.ok(path.isAbsolute(config.directory), 'Absolute signed directory required');
  return config;
}
function reviewConfig(config, expected) {
  assert.match(expected || '', /^[a-f0-9]{64}$/, 'Independent canonical config SHA256 required');
  assert.equal(hash(JSON.stringify(config)), expected, 'Reviewed config bytes differ');
  return validateConfig(config);
}
function loadContract(config, env = process.env) {
  reviewConfig(config, env.CREATOR_OUTGOING_CONFIG_SHA256);
  const read = (name, max) => feed.readBounded(path.join(config.directory, name), max);
  return feed.createDirectOutgoing017Contract({ targetVersion: config.targetVersion, baseline: config.baseline,
    pins: config.pins, descriptor: read(feed.DESCRIPTOR, feed.LIMITS.metadata),
    descriptorSignature: read(`${feed.DESCRIPTOR}.minisig`, feed.LIMITS.signature),
    installer: read(ASSET, feed.LIMITS.installer), manifest: read('latest.json', feed.LIMITS.metadata) });
}
function readConfig(file, env = process.env) {
  assert.ok(path.isAbsolute(file || ''), 'Absolute outgoing config required');
  return reviewConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(feed.readBounded(file, feed.LIMITS.metadata))),
    env.CREATOR_OUTGOING_CONFIG_SHA256);
}
function assertAdmission(env = process.env, platform = process.platform) {
  feed.assertRunner(env);
  assert.equal(platform, 'win32');
  assert.equal(env.CREATOR_HOSTED_UPDATE_FIXTURE, undefined, 'Version masquerade refused');
  for (const name of ['NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'ALL_PROXY', 'NODE_OPTIONS',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE']) assert.equal(env[name], undefined, `Override refused: ${name}`);
  const proxy = new URL(env.HTTPS_PROXY || '');
  assert.equal(proxy.protocol, 'http:'); assert.equal(proxy.hostname, '127.0.0.1');
  assert.ok(Number(proxy.port) > 0 && Number(proxy.port) <= 65535);
  assert.equal(proxy.username + proxy.password + proxy.search + proxy.hash, ''); assert.equal(proxy.pathname, '/');
  assert.equal(env.HTTP_PROXY, env.HTTPS_PROXY); assert.equal(env.NO_PROXY, '127.0.0.1,localhost,::1');
  assert.ok(['mcp', 'setup'].includes(env.CREATOR_OUTGOING_LAST_TOOL || 'setup'));
  assert.ok(['true', 'false'].includes(env.CREATOR_OUTGOING_RESTORE || 'true'));
}
module.exports = { KIND, ASSET, hash, validateConfig, reviewConfig, loadContract, readConfig, assertAdmission,
  assertRunner: feed.assertRunner, readBounded: feed.readBounded, LIMITS: feed.LIMITS, startLabProxy: feed.startLabProxy };
