'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const resources = require('./public-update-resources-022.cjs');
const { LEGACY_LIMIT } = require('./check-release-feed.cjs');
const binding = require('./fixtures/public-update-022-binding.json');
const contract = require('./windows-022-public-contract.cjs');
const { hash, KIND, ASSET, BASELINE_ASSET, CASES, FEED, ASSETS, url, checkRestart } = contract;
const { readBounded } = resources;
const REF = 'refs/heads/validation/windows-public-update-022-20261112';
const bindingSha256 = hash(fs.readFileSync(path.join(__dirname, 'fixtures/public-update-022-binding.json')));

function publication(value = binding) {
  return contract.publication(value);
}
function assertAdmission(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32');
  for (const [key, expected] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
    GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'acceptance',
    GITHUB_RUN_ATTEMPT: '1', GITHUB_REF: REF,
    GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/.github/workflows/self-update-acceptance.yml@${REF}`,
    CREATOR_PUBLIC_UPDATE_022: '1', CREATOR_SELF_UPDATE_TARGET_VERSION: '0.1.22' })) assert.equal(env[key], expected, key);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/); assert.equal(env.EXPECTED_HARNESS_COMMIT, env.GITHUB_SHA);
  assert.equal(env.CREATOR_PUBLIC_BINDING_SHA256, bindingSha256);
  assert.ok(Object.hasOwn(CASES, env.CREATOR_OUTGOING_CASE));
  assert.deepEqual([env.CREATOR_OUTGOING_LAST_TOOL, env.CREATOR_OUTGOING_RESTORE], CASES[env.CREATOR_OUTGOING_CASE]);
  const forbidden = /^(?:https?_proxy|all_proxy|no_proxy|node_options|node_use_env_proxy|node_tls_reject_unauthorized|node_extra_ca_certs|ssl_cert_file|ssl_cert_dir|curl_ca_bundle|requests_ca_bundle|gh_token|github_token|creator_.*(?:lab|fixture|migrated|migration|production_0(?:19|20|21|22)|incoming|outgoing_config|outgoing_review).*)$/i;
  for (const [key, value] of Object.entries(env)) if (forbidden.test(key)) assert.ok(value === undefined || value === '', key);
  publication();
}
function checkRelease(bytes, value = binding) {
  return contract.checkRelease(bytes, value);
}
async function publicBytes(address, max, fetcher = fetch) {
  assert.ok(address === FEED || address === url('0.1.21', BASELINE_ASSET) || ASSETS.some(n => address === url('0.1.22', n)));
  const response = await fetcher(address, { headers: { 'User-Agent': 'Creator-Hub-public-acceptance/0.1.22' },
    signal: AbortSignal.timeout(max > 1048576 ? 120000 : 30000) });
  assert.equal(response.ok, true, `Public download HTTP ${response.status}`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; assert.ok(size <= max); chunks.push(chunk); }
  assert.ok(size > 0); return Buffer.concat(chunks);
}
function directory() { return path.resolve('artifacts/public-update-022-input'); }
function configFor(dir) {
  assert.ok(path.isAbsolute(dir));
  return { schemaVersion: 1, kind: KIND, directory: dir, sourceCommit: binding.target.source.commit,
    baseline: { version: '0.1.21', installer: binding.baseline.installer.sha256, exe: binding.baseline.executable.sha256 },
    targetVersion: '0.1.22', pins: { descriptor: binding.target.descriptor.sha256, descriptorSignature: binding.target.descriptorSignature.sha256,
      installer: binding.target.installer.sha256, executable: binding.target.executable.sha256, manifest: publication().assets['latest.json'].sha256 },
    runtime: { baselineDescriptor: binding.baseline.manifest.managedRouting.files['routing/runtime.json'],
      targetDescriptor: binding.target.manifest.managedRouting.files['routing/runtime.json'] } };
}
function assertBound(config) { assert.deepEqual(config, configFor(directory())); }
function readConfig(file) {
  assert.equal(file, path.join(directory(), 'config.json'));
  const config = JSON.parse(readBounded(file, 32768)); assertBound(config); return config;
}
function proofFor(bytes, env) {
  return { schemaVersion: 1, kind: KIND, harnessSource: env.GITHUB_SHA, bindingSha256,
    source: binding.target.source, releaseId: publication().releaseId, tagCommit: publication().tagCommit,
    publicFeedUrl: FEED, publicFeedSha256: hash(bytes), feed: checkRelease(bytes),
    baseline: configFor(directory()).baseline, pins: configFor(directory()).pins,
    authenticatedDownload: false, lab: false, fixture: false };
}
function checkSidecars(dir) {
  const latest = JSON.parse(readBounded(path.join(dir, 'latest.json'), 32768));
  const original = { ...binding.originalLatest }, reviewed = { ...latest };
  delete original.notes; delete reviewed.notes;
  assert.deepEqual(reviewed, original, 'Only public updater notes may differ from signed R4 staging');
  assert.equal(typeof latest.notes, 'string');
  assert.equal(latest.version, '0.1.22');
  assert.equal(latest.platforms['windows-x86_64'].url, url('0.1.22', ASSET));
  assert.equal(readBounded(path.join(dir, ASSET + '.sig'), 4096).toString().trim(), latest.platforms['windows-x86_64'].signature.trim());
  const sums = readBounded(path.join(dir, 'SHA256SUMS.txt'), 32768).toString().trim().split(/\r?\n/);
  const expected = ASSETS.filter(n => n !== 'SHA256SUMS.txt'); assert.equal(sums.length, expected.length);
  const parsed = new Map();
  for (const line of sums) { const m = /^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$/.exec(line); assert.ok(m); assert.ok(!parsed.has(m[2])); parsed.set(m[2], m[1]); }
  for (const name of expected) assert.equal(parsed.get(name), publication().assets[name].sha256);
}
async function prepare(env = process.env) {
  assertAdmission(env);
  const dir = directory(); assert.equal(fs.existsSync(dir), false); fs.mkdirSync(dir);
  const bytes = await publicBytes(FEED, LEGACY_LIMIT); checkRelease(bytes);
  fs.writeFileSync(path.join(dir, 'public-feed.json'), bytes, { flag: 'wx' });
  const pins = { ...publication().assets, [BASELINE_ASSET]: { size: binding.baseline.installer.bytes, sha256: binding.baseline.installer.sha256 } };
  for (const [name, pin] of Object.entries(pins)) {
    const body = await publicBytes(url(name === BASELINE_ASSET ? '0.1.21' : '0.1.22', name), pin.size);
    assert.equal(body.length, pin.size); assert.equal(hash(body), pin.sha256);
    fs.writeFileSync(path.join(dir, name), body, { flag: 'wx' });
  }
  checkSidecars(dir);
  fs.writeFileSync(path.join(dir, 'public-input-binding.json'), JSON.stringify(proofFor(bytes, env), null, 2), { flag: 'wx' });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(configFor(dir), null, 2), { flag: 'wx' });
}
function loadContract(config, env = process.env) {
  assertAdmission(env); assertBound(config);
  const dir = directory(), bytes = readBounded(path.join(dir, 'public-feed.json'), LEGACY_LIMIT);
  const proof = proofFor(bytes, env);
  const input = readBounded(path.join(dir, 'public-input-binding.json'), 32768);
  assert.deepEqual(JSON.parse(input), proof);
  for (const [name, pin] of Object.entries(publication().assets)) {
    const body = readBounded(path.join(dir, name), pin.size); assert.equal(body.length, pin.size); assert.equal(hash(body), pin.sha256);
  }
  resources.readHash(path.join(dir, BASELINE_ASSET), binding.baseline.installer.sha256);
  checkSidecars(dir); return { ...proof, inputBindingSha256: hash(input) };
}
function verifySdk() {
  const dir = path.resolve('product/modules/mcp');
  for (const [name, expected] of Object.entries(binding.sdkInputs)) assert.equal(hash(readBounded(path.join(dir, name), 1048576)), expected);
  const sdk = createRequire(path.join(dir, 'package.json'));
  const file = path.resolve(path.dirname(sdk.resolve('@modelcontextprotocol/sdk/client/index.js')), '../../../package.json');
  assert.equal(JSON.parse(readBounded(file, 32768)).version, '1.32.0'); return sdk;
}
const ticks = () => (621355968000000000n + BigInt(Date.now()) * 10000n).toString();
module.exports = { ...resources, KIND, ASSET, BASELINE_ASSET, CASES, binding, bindingSha256, FEED, REF, ASSETS, url,
  publication, assertAdmission, checkRelease, publicBytes, configFor, assertBound, readConfig, loadContract,
  checkSidecars, verifySdk, checkRestart, ticks, prepare };
if (require.main === module) {
  if (process.argv[2] !== 'prepare') throw Error('Expected prepare');
  prepare().catch(error => { console.error(error); process.exitCode = 1; });
}
