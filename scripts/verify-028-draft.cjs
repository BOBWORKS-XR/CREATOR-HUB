'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const path = require('node:path');
const feed = require('./check-release-feed.cjs');
const signatures = require('./windows-020-release-qualification.cjs');

const root = path.resolve(__dirname, '..');
const repo = 'BOBWORKS-XR/CREATOR-HUB', repoId = '1364807512';
const version = '0.1.28', tag = `v${version}`, ref = `refs/tags/${tag}`;
const product = '989bccc6d6e204dc581b662d59b2a0f3471b35b1';
const sourceTree = '834540a1cb1cde1d415d11b0ffdb423c63debb43';
const draftId = 459784740, previousStableId = 457371653;
const installer = 'Creator.Hub_0.1.28_x64-setup.exe';
const descriptor = 'creator-hub-windows-x86_64.json';
const platform = 'windows-x86_64';
const apiRoot = `https://api.github.com/repos/${repo}`;
const files = ['M\t.github/workflows/release.yml', 'A\tscripts/verify-028-draft.cjs'];
// Exact unmodified bytes from private-qualification.json, not private draft asset IDs.
const assets = {
  [installer]: [38833740, '1cb612c8cff49950004d0c429cf4b4ddb9adf2e2821ab72e31e8351490cad1b1'],
  [descriptor]: [505, '64263fc22c0127689f63f0a497152c3be2952eca30fb64ce332c78ad0787925e'],
  [`${descriptor}.minisig`]: [316, '19b15b0e98199491f603239410a034e84f27e9d323a93892929062aa0145f293'],
  'latest.json': [706, '67e3ce13d85604cd53fa5d2efbf3517bbc6366e307298f4a5f16bc0b9df434c4'],
};

function run(exe, args, maxBuffer = 2 * 1024 * 1024) {
  return execFileSync(exe, args, { cwd: root, windowsHide: true, timeout: 90000, maxBuffer });
}
const git = args => run('git', args).toString().trimEnd();
const get = (route, flags = [], maxBuffer) => run('gh', ['api', '--hostname', 'github.com', '--method', 'GET',
  `repos/${repo}/${route}`, ...flags], maxBuffer);
const json = (route, flags) => JSON.parse(get(route, flags));

function verifyCheckout(env = process.env) {
  assert.equal(env.GITHUB_REPOSITORY, repo, 'Wrong workflow repository');
  assert.equal(env.GITHUB_REPOSITORY_ID, repoId, 'Wrong workflow repository ID');
  assert.equal(env.GITHUB_REF, ref, 'Expected the exact final tag');
  const head = git(['rev-parse', 'HEAD']);
  assert.equal(env.GITHUB_SHA, head, 'Workflow SHA differs from checkout');
  assert.equal(git(['show', '-s', '--format=%P', head]), product, 'Expected one parent: the qualified product commit');
  assert.equal(git(['rev-parse', `${product}^{tree}`]), sourceTree, 'Qualified product tree differs');
  assert.deepEqual(git(['diff', '--name-status', '--no-renames', product, head, '--']).split(/\r?\n/), files,
    'The child may only modify the release workflow and add this verifier');
  git(['diff', '--quiet', 'HEAD', '--']);
  return head;
}

function selectDraft(pages) {
  const matches = pages.flat().filter(release => release.tag_name === tag);
  assert.equal(matches.length, 1, 'Expected one visible final-tag release; check draft-read access');
  assert.equal(matches[0].id, draftId, 'Final-tag lookup returned a different draft ID');
  assert.equal(matches[0].draft, true, 'Final-tag release is not a draft');
  return matches[0].id;
}

function verifyRecord(release) {
  assert.equal(release.id, draftId, 'Wrong final draft ID');
  assert.equal(release.url.toLowerCase(), `${apiRoot}/releases/${draftId}`.toLowerCase(), 'Wrong draft repository');
  assert.equal(release.tag_name, tag, 'Wrong draft tag');
  assert.equal(release.target_commitish, product, 'Wrong draft product target');
  assert.equal(release.draft, true, 'Release is not a draft');
  assert.equal(release.prerelease, true, 'Final draft must still be marked prerelease');
  assert.equal(release.published_at, null, 'Draft has a publication timestamp');
  assert.deepEqual(release.assets.map(asset => asset.name).sort(), Object.keys(assets).sort(), 'Wrong final draft asset set');
  const ids = new Set();
  for (const asset of release.assets) {
    const [size, digest] = assets[asset.name];
    assert.ok(Number.isSafeInteger(asset.id) && asset.id > 0 && !ids.has(asset.id), `Invalid asset ID: ${asset.name}`);
    ids.add(asset.id);
    assert.equal(asset.state, 'uploaded', `Asset not uploaded: ${asset.name}`);
    assert.equal(asset.size, size, `Wrong asset size: ${asset.name}`);
    assert.equal(asset.digest, `sha256:${digest}`, `Wrong asset digest: ${asset.name}`);
  }
}

function verifyBodies(bodies) {
  for (const [name, [size, digest]] of Object.entries(assets)) {
    assert.equal(bodies[name].length, size, `Wrong downloaded size: ${name}`);
    assert.equal(createHash('sha256').update(bodies[name]).digest('hex'), digest, `Wrong downloaded hash: ${name}`);
  }
  const desc = JSON.parse(bodies[descriptor]), latest = JSON.parse(bodies['latest.json']);
  assert.deepEqual(desc, {
    schemaVersion: 1, appId: 'creator-hub', version, platform: 'windows', architecture: 'x86_64', packageType: 'nsis',
    assetName: installer, byteLength: assets[installer][0], sha256: assets[installer][1],
    executableSha256: '0d0dac1967c65c1f0ba1373949122596825751e87a9a2c27030794d89a6856f8',
    identityProtocol: 0, lifecycleProtocol: 0, installerProtocol: 1, minHubVersion: '0.1.19',
  }, 'Signed descriptor does not describe the qualified Windows installer');
  assert.equal(latest.version, version, 'Wrong updater version');
  assert.deepEqual(Object.keys(latest.platforms), [platform], 'Unexpected updater platform');
  assert.equal(latest.platforms[platform].url, `https://github.com/${repo}/releases/download/${tag}/${installer}`);
  const key = signatures.publicKey(root);
  signatures.verifySignature(bodies[descriptor], bodies[`${descriptor}.minisig`], key);
  signatures.verifySignature(bodies[installer], Buffer.from(latest.platforms[platform].signature, 'base64'), key);
}

async function readPublicFeed() {
  const response = await fetch(`${apiRoot}/releases?per_page=10`, {
    headers: { 'User-Agent': 'Creator-Hub/0.1' }, signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  assert.ok(response.ok, `Public GitHub release feed HTTP ${response.status}`);
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    assert.ok(bytes <= feed.LEGACY_LIMIT, `Existing public feed exceeds ${feed.LEGACY_LIMIT} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function main() {
  const head = verifyCheckout();
  const remoteTag = json(`git/ref/tags/${tag}`);
  assert.equal(remoteTag.ref, ref, 'Wrong remote tag ref');
  assert.equal(remoteTag.object.type, 'commit', 'Expected a lightweight final tag');
  assert.equal(remoteTag.object.sha, head, 'Final tag does not point at the validation child');
  const old = json('releases/latest');
  assert.equal(old.id, previousStableId, 'Latest release ID differs from the exact 0.1.27 baseline');
  assert.equal(old.tag_name, 'v0.1.27');
  assert.equal(old.draft, false);
  assert.equal(old.prerelease, false);

  const id = selectDraft(json('releases?per_page=100', ['--paginate', '--slurp']));
  const route = `releases/${id}`;
  const release = json(route);
  verifyRecord(release);
  const bodies = Object.fromEntries(release.assets.map(asset => [asset.name,
    get(`releases/assets/${asset.id}`, ['-H', 'Accept: application/octet-stream'], assets[asset.name][0] + 1)]));
  verifyBodies(bodies);

  // Budget the same exact record and assets just read back, not a second tag lookup.
  const current = json(route);
  verifyRecord(current);
  assert.deepEqual(current.assets.map(a => a.id).sort(), release.assets.map(a => a.id).sort(), 'Draft assets changed during verification');
  const budget = feed.inspectDraft(await readPublicFeed(), current, version);
  assert.equal(budget.previousStable, '0.1.27', 'Projected legacy feed lost the previous stable');
  console.log(JSON.stringify({ draft: id, association: head, product, sourceTree, verifiedAssets: 4, installerRebuilt: false, budget }));
}

module.exports = { verifyCheckout, selectDraft, verifyRecord, verifyBodies };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
