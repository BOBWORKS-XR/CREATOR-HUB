'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const c = require('./windows-017-production.cjs');
const b = require('./fixtures/windows-017-production-binding.json');
function verifyRelease(release) {
  assert.equal(release.id, b.privateRelease.id); assert.equal(release.tag_name, b.privateRelease.tag);
  assert.equal(release.draft, true); assert.equal(release.prerelease, false);
  assert.equal(release.target_commitish, c.SOURCE.commit);
  for (const [name, pin] of Object.entries(b.assets)) {
    const found = release.assets.filter(a => a.id === pin.id); assert.equal(found.length, 1);
    const asset = found[0]; assert.equal(asset.name, name); assert.equal(asset.state, 'uploaded');
    assert.equal(asset.size, pin.size); assert.equal(asset.digest, `sha256:${pin.sha256}`);
  }
}
async function acquire() {
  c.assertHost();
  const base = path.resolve('artifacts/incoming-017');
  assert.equal(fs.existsSync(base), false, 'No input clobber');
  const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' };
  async function get(url, accept = headers.Accept) {
    const result = await fetch(url, { headers: { ...headers, Accept: accept }, signal: AbortSignal.timeout(180000) });
    assert.equal(result.ok, true, `Private input HTTP ${result.status}`); return result;
  }
  const endpoint = `https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases/${b.privateRelease.id}`;
  verifyRelease(await (await get(endpoint)).json());
  fs.mkdirSync(path.join(base, 'candidate'), { recursive: true });
  for (const [name, pin] of Object.entries(b.assets)) {
    const bytes = Buffer.from(await (await get(`https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases/assets/${pin.id}`, 'application/octet-stream')).arrayBuffer());
    assert.equal(bytes.length, pin.size); assert.equal(c.hash(bytes), pin.sha256);
    fs.writeFileSync(path.join(base, 'candidate', name), bytes, { flag: 'wx' });
  }
  verifyRelease(await (await get(endpoint)).json());
  const receipt = { harnessSource: process.env.GITHUB_SHA, privateDraft: true, readbackVerified: true,
    releaseId: b.privateRelease.id, releaseTag: b.privateRelease.tag, source: c.SOURCE, files: b.assets };
  c.validateAcquisition(receipt, process.env.GITHUB_SHA);
  fs.writeFileSync(path.join(base, 'input-binding.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  const config = { schemaVersion: 1, targetVersion: c.TARGET.version, directory: path.join(base, 'candidate'), pins: c.PINS };
  c.loadContract(config);
  fs.mkdirSync('artifacts/production-017-control');
  fs.writeFileSync('artifacts/production-017-control/config.json', JSON.stringify(config), { flag: 'wx' });
  console.log(JSON.stringify({ acquired: true, source: c.SOURCE, releaseId: b.privateRelease.id, files: Object.keys(b.assets) }));
}
module.exports = { verifyRelease, acquire };
if (require.main === module) acquire().catch(error => { console.error(error.message); process.exitCode = 1; });
