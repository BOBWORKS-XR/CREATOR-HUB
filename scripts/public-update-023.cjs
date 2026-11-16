'use strict';
// Public-only input and receipt boundary. No private transport or updater substitution.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const resources = require('./public-resources-023.cjs');
const binding = require('./fixtures/public-update-023-binding.json');
const { inspectFeed } = require('./check-release-feed.cjs');
const semver = require('semver');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const KIND = 'public-022-to-023';
const ASSET = 'Creator.Hub_0.1.23_x64-setup.exe';
const BASELINE_ASSET = 'Creator.Hub_0.1.22_x64-setup.exe';
const NAMES = [ASSET, 'creator-hub-windows-x86_64.json', 'creator-hub-windows-x86_64.json.minisig', 'latest.json'];
const FEED = 'https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases?per_page=10';
const BRANCH = 'codex/windows-public-023-r17';
const WORKFLOW = 'windows-public-023.yml';
const CASES = { 'mcp-restore': ['mcp', 'true'], 'setup-restore': ['setup', 'true'], 'setup-no-restore': ['setup', 'false'] };
const bindingSha256 = hash(fs.readFileSync(path.join(__dirname, 'fixtures/public-update-023-binding.json')));
const url = (version, name) => `https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v${version}/${name}`;
function validateBinding() {
  assert.equal(binding.kind, KIND); assert.equal(binding.publicOnly, true);
  assert.ok(binding.publication, 'Actual public readback pins pending');
  const p = binding.publication;
  assert.equal(p.tag, 'v0.1.23'); assert.equal(p.draft, false); assert.equal(p.prerelease, false);
  assert.ok(Number.isSafeInteger(p.releaseId) && p.releaseId > 0);
  assert.ok(![447044552, 442967050].includes(p.releaseId));
  assert.match(p.tagCommit, /^[a-f0-9]{40}$/);
  assert.equal(binding.target.source.commit, '117e92c958aac9cb421fe0a130040b775a0a56d4');
  assert.equal(binding.target.source.tree, '01988f5db2018b5803ce0c931301d89348ac3592');
  assert.equal(binding.qualificationSha256, '0a022ae88d72b22e63da0920c99c5baeb0465e45d58c72b98b2ad971a61866e6');
  assert.equal(binding.target.installer.sha256, '4c85dbf3064b136ada3ad20a24c5c6b25ddfb16fe8be941b9dd33058d916f456');
  assert.equal(binding.target.executable.sha256, '966ef4bb22598927f18ec5afd7f75f068c6bb083ca89dd3aac4757afb8f17010');
  assert.equal(binding.baseline.releaseId, 442967050); assert.equal(binding.baseline.assetId, 739544096);
  assert.equal(binding.baseline.installer.sha256, '2bd535e7f3ea90821bb97878e5d97bfa06a90ff0127bef28f8d8a64f2eb7deea');
  assert.equal(binding.baseline.executable.sha256, '73a2afa5cb2ff4fbfbb1d6458efa6d179441cb9336803228ffbc910ee3f94245');
  assert.equal(binding.target.latest.sha256, 'f33a4db80c4d9f3d0ce4b413b4f3485a7b529e6aa428026b6cf7aedc54e3ec32');
  assert.equal(binding.target.latest.bytes, 789);
  assert.deepEqual(Object.keys(p.assets).sort(), [...NAMES].sort());
  const expected = [binding.target.installer, binding.target.descriptor, binding.target.descriptorSignature, binding.target.latest];
  const ids = new Set([binding.baseline.assetId]);
  for (const [i, name] of NAMES.entries()) {
    const a = p.assets[name]; assert.ok(Number.isSafeInteger(a.id) && a.id > 0 && !ids.has(a.id)); ids.add(a.id);
    assert.deepEqual({ bytes: a.size, sha256: a.sha256 }, expected[i]);
  }
  assert.equal(Object.hasOwn(binding.target, 'privateRelease'), false);
  return p;
}
function assertAdmission(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32'); validateBinding();
  for (const [key, expected] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
    GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'acceptance',
    GITHUB_RUN_ATTEMPT: '1', GITHUB_REF: `refs/heads/${BRANCH}`,
    GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/.github/workflows/${WORKFLOW}@refs/heads/${BRANCH}` })) assert.equal(env[key], expected, key);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/); assert.equal(env.EXPECTED_HARNESS_COMMIT, env.GITHUB_SHA);
  assert.equal(env.CREATOR_PUBLIC_BINDING_SHA256, bindingSha256);
  assert.ok(Object.hasOwn(CASES, env.CREATOR_OUTGOING_CASE));
  assert.deepEqual([env.CREATOR_OUTGOING_LAST_TOOL, env.CREATOR_OUTGOING_RESTORE], CASES[env.CREATOR_OUTGOING_CASE]);
  for (const [key, value] of Object.entries(env)) if (/^(?:https?_proxy|all_proxy|no_proxy|node_options|node_use_env_proxy|node_tls_reject_unauthorized|node_extra_ca_certs|ssl_cert_file|ssl_cert_dir|curl_ca_bundle|requests_ca_bundle|gh_token|github_token|creator_.*(?:lab|fixture|migrated|incoming|outgoing_config|outgoing_review).*)$/i.test(key)) {
    assert.ok(value === undefined || value === '', `Public transport refuses ${key}`);
  }
}
function checkRelease(bytes) {
  const p = validateBinding(), summary = inspectFeed(bytes, '0.1.23');
  assert.equal(summary.previousStable, '0.1.22');
  const releases = JSON.parse(bytes), selected = releases.filter(r => r.tag_name === p.tag);
  const stable = releases.filter(r => !r.draft && !r.prerelease)
    .map(r => String(r.tag_name).replace(/^v/, '')).filter(v => semver.valid(v) && !semver.prerelease(v)).sort(semver.rcompare);
  assert.equal(stable[0], '0.1.23', 'Only the exact newest public stable is admitted');
  assert.equal(selected.length, 1); const r = selected[0];
  assert.equal(r.id, p.releaseId); assert.equal(r.draft, false); assert.equal(r.prerelease, false);
  assert.equal(r.assets.length, NAMES.length);
  for (const name of NAMES) {
    const rows = r.assets.filter(a => a.name === name); assert.equal(rows.length, 1);
    const a = rows[0], pin = p.assets[name];
    assert.equal(a.id, pin.id); assert.equal(a.size, pin.size); assert.equal(a.digest, `sha256:${pin.sha256}`);
    assert.equal(a.state, 'uploaded'); assert.equal(a.browser_download_url, url('0.1.23', name));
  }
  const old = releases.filter(r => r.tag_name === 'v0.1.22'); assert.equal(old.length, 1);
  assert.equal(old[0].id, binding.baseline.releaseId); assert.equal(old[0].draft, false); assert.equal(old[0].prerelease, false);
  const assets = old[0].assets.filter(a => a.name === BASELINE_ASSET); assert.equal(assets.length, 1);
  assert.equal(assets[0].id, binding.baseline.assetId); assert.equal(assets[0].size, binding.baseline.installer.bytes);
  assert.equal(assets[0].digest, `sha256:${binding.baseline.installer.sha256}`);
  assert.equal(assets[0].browser_download_url, url('0.1.22', BASELINE_ASSET));
  return summary;
}
async function publicBytes(address, max, fetcher = fetch) {
  assert.ok(address === FEED || address === url('0.1.22', BASELINE_ASSET) || NAMES.some(n => address === url('0.1.23', n)));
  const response = await fetcher(address, { headers: { 'User-Agent': 'Creator-Hub-public-acceptance/0.1.23' },
    signal: AbortSignal.timeout(max > 1048576 ? 180000 : 30000) });
  assert.equal(response.ok, true, `Public HTTP ${response.status}`);
  const parts = []; let length = 0;
  for await (const part of response.body) { length += part.length; assert.ok(length <= max); parts.push(part); }
  assert.ok(length > 0); return Buffer.concat(parts);
}
const directory = () => path.resolve('artifacts/public-update-023-input');
function configFor(dir = directory()) {
  validateBinding();
  return { schemaVersion: 1, kind: KIND, directory: dir, sourceCommit: binding.target.source.commit,
    baseline: { version: '0.1.22', installer: binding.baseline.installer.sha256, exe: binding.baseline.executable.sha256 },
    targetVersion: '0.1.23', pins: { descriptor: binding.target.descriptor.sha256, descriptorSignature: binding.target.descriptorSignature.sha256,
      installer: binding.target.installer.sha256, executable: binding.target.executable.sha256, manifest: binding.target.latest.sha256 },
    runtime: { baselineDescriptor: binding.baseline.manifest.managedRouting.files['routing/runtime.json'], targetDescriptor: binding.target.manifest.managedRouting.files['routing/runtime.json'] } };
}
function assertBound(config) { assert.deepEqual(config, configFor()); }
function readConfig(file) {
  assert.equal(file, path.join(directory(), 'config.json'));
  const config = JSON.parse(resources.readBounded(file, 32768)); assertBound(config); return config;
}
function proofFor(bytes, env = process.env) {
  return { schemaVersion: 1, kind: KIND, harnessSource: env.GITHUB_SHA, bindingSha256,
    source: binding.target.source, releaseId: validateBinding().releaseId, tagCommit: binding.publication.tagCommit,
    publicFeedUrl: FEED, publicFeedSha256: hash(bytes), feed: checkRelease(bytes), baseline: configFor().baseline,
    pins: configFor().pins, authenticatedDownload: false, lab: false, fixture: false };
}
function checkSidecars(dir) {
  const latest = JSON.parse(resources.readBounded(path.join(dir, 'latest.json'), 32768));
  const a = { ...latest }, b = { ...binding.originalLatest }; delete a.notes; delete b.notes;
  assert.deepEqual(a, b, 'Only public notes may differ'); assert.equal(latest.notes, binding.publicNotes);
  assert.equal(latest.platforms['windows-x86_64'].url, url('0.1.23', ASSET));
}
async function prepare() {
  assertAdmission(); const dir = directory(); assert.equal(fs.existsSync(dir), false); fs.mkdirSync(dir, { recursive: true });
  const feed = await publicBytes(FEED, 256 * 1024); checkRelease(feed);
  fs.writeFileSync(path.join(dir, 'public-feed.json'), feed, { flag: 'wx' });
  const pins = { ...binding.publication.assets, [BASELINE_ASSET]: { size: binding.baseline.installer.bytes, sha256: binding.baseline.installer.sha256 } };
  for (const [name, pin] of Object.entries(pins)) {
    const bytes = await publicBytes(url(name === BASELINE_ASSET ? '0.1.22' : '0.1.23', name), pin.size);
    assert.equal(bytes.length, pin.size); assert.equal(hash(bytes), pin.sha256);
    fs.writeFileSync(path.join(dir, name), bytes, { flag: 'wx' });
  }
  checkSidecars(dir);
  fs.writeFileSync(path.join(dir, 'public-input-binding.json'), JSON.stringify(proofFor(feed), null, 2), { flag: 'wx' });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(configFor(), null, 2), { flag: 'wx' });
}
function loadContract(config) {
  assertAdmission(); assertBound(config); const dir = directory();
  const bytes = resources.readBounded(path.join(dir, 'public-feed.json'), 256 * 1024);
  const proof = proofFor(bytes), input = resources.readBounded(path.join(dir, 'public-input-binding.json'), 32768);
  assert.deepEqual(JSON.parse(input), proof);
  for (const [name, pin] of Object.entries(binding.publication.assets)) {
    const b = resources.readBounded(path.join(dir, name), pin.size); assert.equal(b.length, pin.size); assert.equal(hash(b), pin.sha256);
  }
  resources.readHash(path.join(dir, BASELINE_ASSET), binding.baseline.installer.sha256);
  checkSidecars(dir); return { ...proof, inputBindingSha256: hash(input) };
}
module.exports = { ...resources, hash, KIND, ASSET, BASELINE_ASSET, NAMES, CASES, FEED, BRANCH, WORKFLOW, url, binding, bindingSha256,
  validateBinding, assertAdmission, checkRelease, publicBytes, directory, configFor, assertBound, readConfig, proofFor, loadContract, prepare };
if (require.main === module) {
  assert.equal(process.argv[2], 'prepare');
  prepare().catch(error => { console.error(error.message); process.exitCode = 1; });
}
