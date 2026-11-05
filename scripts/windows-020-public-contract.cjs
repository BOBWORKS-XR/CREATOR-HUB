'use strict';
// Pure read-only contracts shared by the evidence reader and native harness.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { inspectFeed } = require('./check-release-feed.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const KIND = 'public-019-to-020';
const ASSET = 'Creator.Hub_0.1.20_x64-setup.exe';
const BASELINE_ASSET = 'Creator.Hub_0.1.19_x64-setup.exe';
const CASES = Object.freeze({ 'mcp-restore': ['mcp', 'true'], 'setup-restore': ['setup', 'true'], 'setup-no-restore': ['setup', 'false'] });
const FEED = 'https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases?per_page=10';
const ASSETS = Object.freeze([ASSET, ASSET + '.sig', 'creator-hub-windows-x86_64.json', 'creator-hub-windows-x86_64.json.minisig', 'latest.json', 'SHA256SUMS.txt']);
const url = (version, name) => `https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v${version}/${name}`;

function publication(value) {
  assert.equal(value.kind, KIND);
  const p = value.publication;
  assert.ok(p, 'Public release pins pending; no native acceptance is authorized');
  assert.ok(Number.isSafeInteger(p.releaseId) && p.releaseId > 0 && p.releaseId !== 435162323);
  assert.match(p.tagCommit, /^[a-f0-9]{40}$/);
  assert.equal(p.tag, 'v0.1.20'); assert.equal(p.draft, false); assert.equal(p.prerelease, false);
  assert.equal(p.releaseId, value.stagedPublic.releaseId);
  assert.deepEqual(p.assets, value.stagedPublic.assets, 'Only the six exact staged official assets are admitted');
  assert.deepEqual(Object.keys(p.assets).sort(), [...ASSETS].sort());
  const expected = { [ASSET]: value.target.installer, 'creator-hub-windows-x86_64.json': value.target.descriptor,
    'creator-hub-windows-x86_64.json.minisig': value.target.descriptorSignature, 'latest.json': value.target.latest };
  const ids = new Set([value.baseline.assetId]);
  for (const [name, pin] of Object.entries(p.assets)) {
    assert.ok(Number.isSafeInteger(pin.id) && pin.id > 0 && !ids.has(pin.id)); ids.add(pin.id);
    assert.ok(Number.isSafeInteger(pin.size) && pin.size > 0 && pin.size <= (name === ASSET ? value.target.installer.bytes : 32768));
    assert.match(pin.sha256, /^[a-f0-9]{64}$/);
    if (expected[name] && name !== 'latest.json') assert.deepEqual({ bytes: pin.size, sha256: pin.sha256 }, expected[name], name);
  }
  return p;
}
function checkRelease(bytes, value) {
  const p = publication(value), summary = inspectFeed(bytes, '0.1.20');
  assert.equal(summary.previousStable, '0.1.19');
  const releases = JSON.parse(bytes);
  const matches = releases.filter(r => r.tag_name === 'v0.1.20'); assert.equal(matches.length, 1);
  const r = matches[0]; assert.equal(r.id, p.releaseId); assert.equal(r.draft, false); assert.equal(r.prerelease, false);
  assert.equal(r.assets.length, ASSETS.length);
  for (const [name, pin] of Object.entries(p.assets)) {
    const rows = r.assets.filter(a => a.name === name); assert.equal(rows.length, 1, name);
    assert.equal(rows[0].id, pin.id); assert.equal(rows[0].size, pin.size);
    assert.equal(rows[0].digest, 'sha256:' + pin.sha256); assert.equal(rows[0].browser_download_url, url('0.1.20', name));
  }
  const old = releases.filter(r => r.tag_name === 'v0.1.19'); assert.equal(old.length, 1);
  assert.equal(old[0].id, value.baseline.releaseId); assert.equal(old[0].draft, false); assert.equal(old[0].prerelease, false);
  const installers = old[0].assets.filter(a => a.name === BASELINE_ASSET); assert.equal(installers.length, 1);
  assert.equal(installers[0].id, value.baseline.assetId); assert.equal(installers[0].size, value.baseline.installer.bytes);
  assert.equal(installers[0].digest, 'sha256:' + value.baseline.installer.sha256);
  assert.equal(installers[0].browser_download_url, url('0.1.19', BASELINE_ASSET));
  return summary;
}
function checkRestart(before, after, lowerBound) {
  assert.equal(before.kernelIdentityVerified, true); assert.equal(after.kernelIdentityVerified, true);
  assert.notEqual(before.pid, after.pid);
  assert.equal(before.image.toLowerCase(), after.image.toLowerCase());
  assert.ok(BigInt(before.startTicks) < BigInt(lowerBound) && BigInt(after.startTicks) > BigInt(lowerBound));
}
module.exports = { hash, KIND, ASSET, BASELINE_ASSET, CASES, FEED, ASSETS, url, publication, checkRelease, checkRestart };
