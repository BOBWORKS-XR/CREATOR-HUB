'use strict';
// GET-only acquisition; admission and immutable pins precede network and disk writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contract = require('./windows-019-contract.cjs');
const API = 'https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases';
function verifyRelease(release, mode, binding = contract.pinned) {
  assert.ok(['raw', 'production'].includes(mode));
  contract[mode === 'raw' ? 'validateRaw' : 'validateProduction'](binding);
  const raw = mode === 'raw', pin = raw ? binding.rawRelease : binding.production;
  assert.equal(release.id, raw ? pin.id : pin.releaseId);
  assert.equal(release.tag_name, raw ? pin.tag : pin.releaseTag);
  assert.equal(release.draft, true); assert.equal(release.prerelease, raw);
  if (!raw) assert.equal(release.target_commitish, pin.targetCommit);
  assert.ok(Array.isArray(release.assets) && release.assets.length <= 64);
  const assets = raw ? { [contract.ASSET]: { id: pin.assetId, size: binding.installer.bytes, sha256: binding.installer.sha256 } } : pin.assets;
  for (const [name, item] of Object.entries(assets)) {
    const found = release.assets.filter(asset => asset.id === item.id || asset.name === name);
    assert.equal(found.length, 1, 'Asset identity must be unique');
    const asset = found[0];
    assert.equal(asset.id, item.id); assert.equal(asset.name, name); assert.equal(asset.state, 'uploaded');
    assert.equal(asset.size, item.size); assert.equal(asset.digest, `sha256:${item.sha256}`);
  }
  return assets;
}
async function responseBytes(response, maximum) {
  assert.equal(response.ok, true, `Private input HTTP ${response.status}`);
  const length = response.headers.get('content-length');
  if (length !== null) assert.ok(/^[0-9]+$/.test(length) && Number(length) <= maximum, 'Response exceeds input bound');
  assert.ok(response.body); const chunks = []; let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length; assert.ok(total <= maximum, 'Response exceeds input bound'); chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total);
}
async function acquire(mode, env = process.env, fetcher = fetch) {
  assert.ok(['raw', 'production'].includes(mode));
  const raw = mode === 'raw';
  const owner = require(raw ? './windows-019-raw.cjs' : './windows-019-production.cjs');
  if (raw) { owner.assertRunner(env); contract.validateRaw(); } else owner.assertHost(env);
  const b = contract.pinned, pin = raw ? b.rawRelease : b.production;
  if (raw) {
    for (const [key, value] of Object.entries({ RELEASE_ID: pin.id, RELEASE_TAG: pin.tag, ASSET_ID: pin.assetId, ASSET_NAME: contract.ASSET })) {
      assert.equal(env[key], String(value), `Dispatch ${key} differs from reviewed fixture`);
    }
  }
  assert.ok(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'Private GET token unavailable');
  const base = path.resolve(raw ? 'raw-input' : 'artifacts/incoming-019');
  const output = raw ? base : path.join(base, 'candidate');
  const receiptFile = raw ? path.resolve('private-input-binding-019.json') : path.join(base, 'input-binding.json');
  const control = path.resolve('artifacts/production-019-control');
  for (const destination of [base, receiptFile, ...(raw ? [] : [control])]) assert.equal(fs.existsSync(destination), false, 'No input clobber');
  async function get(url, maximum, binary = false) {
    const response = await fetcher(url, { headers: { Authorization: `Bearer ${env.GH_TOKEN}`,
      Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' },
    signal: AbortSignal.timeout(180000) });
    return responseBytes(response, maximum);
  }
  const endpoint = `${API}/${raw ? pin.id : pin.releaseId}`;
  const release = async () => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await get(endpoint, 1024 * 1024)));
  const assets = verifyRelease(await release(), mode);
  fs.mkdirSync(output, { recursive: true });
  for (const [name, item] of Object.entries(assets)) {
    const bytes = await get(`${API}/assets/${item.id}`, item.size, true);
    assert.equal(bytes.length, item.size); assert.equal(contract.hash(bytes), item.sha256);
    fs.writeFileSync(path.join(output, name), bytes, { flag: 'wx' });
  }
  verifyRelease(await release(), mode);
  const receipt = raw ? { schemaVersion: 1, releaseId: pin.id, releaseTag: pin.tag, assetId: pin.assetId,
    assetName: contract.ASSET, bytes: b.installer.bytes, sha256: b.installer.sha256, receiptSha256: b.build.resultSha256 }
    : { harnessSource: env.GITHUB_SHA, privateDraft: true, readbackVerified: true, releaseId: pin.releaseId,
      releaseTag: pin.releaseTag, source: b.source, files: assets };
  if (raw) owner.createAdapter().boundIdentity(receipt); else owner.validateAcquisition(receipt, env.GITHUB_SHA);
  fs.writeFileSync(receiptFile, JSON.stringify(receipt, null, 2), { flag: 'wx' });
  if (!raw) {
    const config = { schemaVersion: 1, targetVersion: contract.VERSION, directory: output, pins: owner.PINS };
    owner.loadContract(config);
    fs.mkdirSync(control); fs.writeFileSync(path.join(control, 'config.json'), JSON.stringify(config), { flag: 'wx' });
  }
  console.log(JSON.stringify({ acquired: true, mode, source: b.source, files: Object.keys(assets) }));
}
module.exports = { verifyRelease, responseBytes, acquire };
if (require.main === module) acquire(process.argv[2] || 'production').catch(() => {
  console.error('Exact private 019 input refused; no native acceptance established.'); process.exitCode = 1;
});
