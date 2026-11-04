'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const { readBounded } = require('./read-bounded-input.cjs');
const { inspectFeed, LEGACY_LIMIT } = require('./check-release-feed.cjs');
const { selectBaseline } = require('./self-update-baselines.cjs');
const bindingBytes = fs.readFileSync(path.join(__dirname, 'fixtures/windows-public-019-binding.json'));
const binding = JSON.parse(bindingBytes);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const bindingSha256 = hash(bindingBytes);
const directory = () => path.resolve('artifacts/self-update-target');
const assetUrl = name => 'https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.19/' + name;
const feedUrl = 'https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases?per_page=10';
const assets = ['Creator.Hub_0.1.19_x64-setup.exe', 'Creator.Hub_0.1.19_x64-setup.exe.sig',
  'creator-hub-windows-x86_64.json', 'creator-hub-windows-x86_64.json.minisig', 'latest.json', 'SHA256SUMS.txt'];

function admit(env = process.env) {
  for (const [name, expected] of Object.entries({
    GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'self-update', GITHUB_RUN_ATTEMPT: '1',
    CREATOR_PUBLIC_SELF_UPDATE_019: '1', CREATOR_SELF_UPDATE_TARGET_VERSION: '0.1.19',
  })) assert.equal(env[name], expected, name);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
  assert.match(env.GITHUB_WORKFLOW_REF || '', /^BOBWORKS-XR\/CREATOR-HUB\/\.github\/workflows\/self-update-acceptance\.yml@refs\//);
  const forbidden = /^(?:https?_proxy|all_proxy|no_proxy|node_options|node_use_env_proxy|node_tls_reject_unauthorized|node_extra_ca_certs|ssl_cert_file|ssl_cert_dir|curl_ca_bundle|requests_ca_bundle|creator_hosted_update_fixture|creator_self_update_lab_config|creator_public12_r2_lab|creator_incoming_migration_diagnostic)$/i;
  for (const [name, value] of Object.entries(env)) if (forbidden.test(name)) assert.ok(value === undefined || value === '', 'Public acceptance forbids ' + name);
  assert.equal(binding.schemaVersion, 1); assert.equal(binding.version, '0.1.19'); assert.equal(binding.kind, 'public-018-to-019');
  assert.equal(selectBaseline(binding.version).version, '0.1.18');
  assert.deepEqual(Object.keys(binding.assets).sort(), [...assets].sort());
  assert.deepEqual(Object.keys(binding.sdkInputs).sort(), ['packageJsonSha256', 'packageLockSha256']);
  assert.equal(Object.keys(binding.resources).length, 15);
}

function checkRelease(feedBytes) {
  const summary = inspectFeed(feedBytes, binding.version);
  assert.equal(summary.previousStable, '0.1.18');
  const releases = JSON.parse(feedBytes).filter(item => item.tag_name === 'v0.1.19' && item.draft === false);
  assert.equal(releases.length, 1, 'Exactly one public 019 release is required');
  const release = releases[0];
  assert.equal(release.id, binding.releaseId); assert.equal(release.prerelease, false);
  assert.deepEqual(Object.keys(binding.assets).sort(), [...assets].sort());
  assert.equal(release.assets.length, assets.length);
  for (const [name, pin] of Object.entries(binding.assets)) {
    const matches = release.assets.filter(asset => asset.name === name);
    assert.equal(matches.length, 1, name);
    const asset = matches[0]; assert.equal(asset.id, pin.id, name); assert.equal(asset.size, pin.size, name);
    assert.equal(asset.browser_download_url, assetUrl(name));
    assert.equal(asset.digest, 'sha256:' + pin.sha256, name);
  }
  return summary;
}

async function publicBytes(url, max, fetcher = fetch) {
  assert.ok(url === feedUrl || assets.some(name => url === assetUrl(name)), 'Only canonical public GitHub URLs are accepted');
  const response = await fetcher(url, { headers: { 'User-Agent': 'Creator-Hub-public-acceptance/0.1.19' },
    signal: AbortSignal.timeout(max > 1024 * 1024 ? 120000 : 30000) });
  assert.equal(response.ok, true, 'Public download failed: ' + response.status);
  const parts = []; let size = 0;
  for await (const part of response.body) {
    size += part.length; assert.ok(size <= max, 'Public response exceeds bound'); parts.push(part);
  }
  assert.ok(size > 0); return Buffer.concat(parts);
}

function verifySdk() {
  const root = path.resolve('.public-sdk/modules/mcp');
  for (const [name, sha] of Object.entries({ 'package.json': binding.sdkInputs.packageJsonSha256,
    'package-lock.json': binding.sdkInputs.packageLockSha256 })) {
    assert.equal(hash(readBounded(path.join(root, name), 1024 * 1024)), sha, name);
  }
  const sdk = createRequire(path.join(root, 'package.json'));
  const packageFile = path.resolve(path.dirname(sdk.resolve('@modelcontextprotocol/sdk/client/index.js')), '../../../package.json');
  assert.equal(JSON.parse(readBounded(packageFile, 32768)).version, '1.32.0');
  return sdk;
}

function readHash(file, expected, name) {
  let stat, bytes;
  try {
    stat = fs.lstatSync(file);
    bytes = readBounded(file, 512 * 1024 * 1024);
    assert.equal(hash(bytes), expected, name);
    return { name, size: bytes.length, sha256: expected };
  } catch (error) {
    error.resourceDiagnostic = { name, size: stat?.size ?? null, sha256: bytes ? hash(bytes) : null, expected };
    throw error;
  }
}

function verifyResources(root, read = readHash) {
  assert.ok(path.isAbsolute(root)); assert.equal(Object.keys(binding.resources).length, 15);
  read(path.join(root, 'creator-hub.exe'), binding.executable.sha256, 'creator-hub.exe');
  return Object.entries(binding.resources).map(([name, sha]) => read(path.join(root, 'modules', name), sha, 'modules/' + name));
}

async function prepare(env = process.env, fetcher = fetch) {
  admit(env);
  const root = directory(); assert.equal(fs.existsSync(root), false, 'Fresh target directory required');
  fs.mkdirSync(root, { recursive: true });
  const feed = await publicBytes(feedUrl, LEGACY_LIMIT, fetcher);
  checkRelease(feed);
  fs.writeFileSync(path.join(root, 'public-feed.json'), feed, { flag: 'wx' });
  for (const [name, pin] of Object.entries(binding.assets)) {
    const bytes = await publicBytes(assetUrl(name), pin.size, fetcher);
    assert.equal(bytes.length, pin.size, name); assert.equal(hash(bytes), pin.sha256, name);
    fs.writeFileSync(path.join(root, name), bytes, { flag: 'wx' });
  }
  const input = inputFor(feed, env);
  fs.writeFileSync(path.join(root, 'public-input-binding.json'), JSON.stringify(input, null, 2), { flag: 'wx' });
  return input;
}
function inputFor(feed, env) {
  return { schemaVersion: 1, kind: binding.kind, harnessSource: env.GITHUB_SHA, bindingSha256,
    publicFeedUrl: feedUrl, publicFeedSha256: hash(feed), feed: checkRelease(feed),
    source: binding.source, releaseId: binding.releaseId, assets: binding.assets,
    baseline: selectBaseline(binding.version), executable: binding.executable, resources: binding.resources,
    sdkInputs: binding.sdkInputs, authenticatedDownload: false, lab: false, fixture: false };
}

function verifyPrepared(env = process.env) {
  admit(env);
  const root = directory(), feed = readBounded(path.join(root, 'public-feed.json'), LEGACY_LIMIT);
  checkRelease(feed);
  for (const [name, pin] of Object.entries(binding.assets)) {
    const bytes = readBounded(path.join(root, name), pin.size);
    assert.equal(bytes.length, pin.size); assert.equal(hash(bytes), pin.sha256, name);
  }
  const inputBytes = readBounded(path.join(root, 'public-input-binding.json'), 32768);
  const input = JSON.parse(inputBytes);
  assert.deepEqual(input, inputFor(feed, env));
  const resources = verifyResources(path.join(root, 'extracted'));
  readHash(path.join(root, 'extracted/$PLUGINSDIR/creator-hub-preflight.exe'), binding.executable.sha256, 'creator-hub-preflight.exe');
  return { inputBindingSha256: hash(inputBytes), bindingSha256, source: binding.source, releaseId: binding.releaseId,
    resources, publicFeedSha256: hash(feed), publicFeedUrl: feedUrl, authenticatedDownload: false };
}

// The old helper's kernel-identity contract is retained without its diagnostic-only dependency.
function checkRecord(record, expected) {
  assert.ok(record && typeof record === 'object' && !Array.isArray(record));
  assert.ok(Number.isInteger(record.pid) && record.pid > 0 && record.pid <= 2147483647);
  assert.match(record.startTicks, /^[1-9][0-9]{0,18}$/); assert.equal(record.kernelIdentityVerified, true);
  assert.ok(typeof record.image === 'string' && path.win32.isAbsolute(record.image));
  assert.equal(path.win32.normalize(record.image).toLowerCase(), path.win32.normalize(expected).toLowerCase());
}
function observeRoot({ rows, pid, hub, expectedHash, imageHash }) {
  assert.equal(imageHash(), expectedHash);
  const hubs = rows.filter(row => path.win32.basename(row.image || '').toLowerCase() === 'creator-hub.exe');
  assert.equal(hubs.length, 1, 'Exactly one Root must be present'); assert.equal(hubs[0].pid, pid);
  checkRecord(hubs[0], hub); return hubs[0];
}
function checkRestart(before, after, lowerBound) {
  assert.notEqual(before.pid, after.pid);
  assert.equal(path.win32.normalize(before.image).toLowerCase(), path.win32.normalize(after.image).toLowerCase());
  assert.ok(BigInt(before.startTicks) < BigInt(lowerBound) && BigInt(after.startTicks) > BigInt(lowerBound));
}
const ticks = () => (621355968000000000n + BigInt(Date.now()) * 10000n).toString();
module.exports = { binding, bindingSha256, admit, checkRelease, publicBytes, inputFor, prepare, verifyPrepared, verifySdk,
  readHash, verifyResources, observeRoot, checkRestart, ticks };
if (require.main === module) {
  const mode = process.argv[2];
  if (mode === 'prepare') prepare().then(value => console.log(JSON.stringify(value)), fail);
  else if (mode === 'verify') {
    try { console.log(JSON.stringify(verifyPrepared())); } catch (error) { fail(error); }
  } else fail(Error('Expected prepare or verify'));
}
function fail(error) { console.error(error); process.exitCode = 1; }
