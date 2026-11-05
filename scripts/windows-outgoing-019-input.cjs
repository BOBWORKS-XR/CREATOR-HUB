'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const target = require('./windows-outgoing-019-target.cjs');
const { binding, hash } = target;
const FILES = [target.BASELINE_ASSET, target.ASSET, 'creator-hub-windows-x86_64.json', 'creator-hub-windows-x86_64.json.minisig', 'latest.json'];
function verifyRelease(release, expected) {
  assert.equal(release.id, expected.id); assert.equal(release.tag_name, expected.tag);
  const publicBaseline = expected.id === binding.baseline.releaseId;
  assert.equal(release.draft, !publicBaseline);
  assert.equal(release.target_commitish, publicBaseline ? 'a23ab742d649e1c8572f3072c767b92479073b49' : expected.source);
  for (const [name, pin] of Object.entries(expected.assets)) {
    const matches = release.assets.filter(asset => asset.id === pin.id); assert.equal(matches.length, 1);
    const asset = matches[0]; assert.equal(asset.name, name); assert.equal(asset.state, 'uploaded');
    assert.equal(asset.size, pin.bytes); assert.equal(asset.digest, `sha256:${pin.sha256}`);
  }
}
async function acquire() {
  target.assertHost();
  const base = path.resolve('artifacts/outgoing-019');
  assert.equal(fs.existsSync(base), false, 'Refusing to reuse input directory');
  const baseline = { id: binding.baseline.releaseId, tag: 'v0.1.19', source: binding.baseline.source.commit,
    assets: { [target.BASELINE_ASSET]: { id: binding.baseline.assetId, ...binding.baseline.installer } } };
  const successor = binding.target.privateRelease;
  const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' };
  const get = async (route, binary = false) => {
    const response = await fetch(`https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/${route}`,
      { headers: { ...headers, Accept: binary ? 'application/octet-stream' : headers.Accept }, signal: AbortSignal.timeout(180000) });
    assert.equal(response.ok, true, `Private input HTTP ${response.status}`); return response;
  };
  for (const release of [baseline, successor]) verifyRelease(await (await get(`releases/${release.id}`)).json(), release);
  fs.mkdirSync(path.join(base, 'data'), { recursive: true });
  for (const release of [baseline, successor]) {
    for (const [name, pin] of Object.entries(release.assets)) {
      assert.ok(FILES.includes(name));
      const bytes = Buffer.from(await (await get(`releases/assets/${pin.id}`, true)).arrayBuffer());
      assert.equal(bytes.length, pin.bytes); assert.equal(hash(bytes), pin.sha256);
      fs.writeFileSync(path.join(base, 'data', name), bytes, { flag: 'wx' });
    }
    verifyRelease(await (await get(`releases/${release.id}`)).json(), release);
  }
  assert.deepEqual(fs.readdirSync(path.join(base, 'data')).sort(), [...FILES].sort());
  const config = target.configFor(path.join(base, 'data')), configSha256 = hash(JSON.stringify(config));
  target.loadContract(config, { ...process.env, CREATOR_OUTGOING_CONFIG_SHA256: configSha256 });
  fs.writeFileSync(path.join(base, 'runner-config.json'), JSON.stringify(config), { flag: 'wx' });
  fs.writeFileSync(path.join(base, 'input-binding.json'), JSON.stringify({ harnessSource: process.env.GITHUB_SHA,
    reviewSha256: process.env.CREATOR_OUTGOING_REVIEW_SHA256, case: process.env.CREATOR_OUTGOING_CASE,
    baseline, successor, configSha256, verificationReceiptSha256: binding.target.verificationReceiptSha256, privateOnly: true }, null, 2), { flag: 'wx' });
  return { configSha256 };
}
function checkReceipt(report, rows, config, env = process.env) {
  target.assertBound(config); assert.equal(report.kind, target.KIND); assert.equal(report.sourceCommit, binding.target.source.commit);
  assert.deepEqual(report.baseline, config.baseline); assert.deepEqual(report.pins, config.pins);
  const [tool, restore] = target.CASES[env.CREATOR_OUTGOING_CASE];
  assert.equal(report.lastTool, tool); assert.equal(report.restore, restore === 'true');
  assert.equal(report.restoredLastTool, restore === 'true' ? tool : null);
  for (const key of ['passed', 'nativeUpdateAccepted', 'automaticRestart', 'cancelPreserved', 'existingConnectionSurvived',
    'newConnectionVerified', 'restorationVerified', 'policyRestored', 'settingsPreserved', 'acceptanceOnly',
    'changedMcpGenerationProven', 'installedResourcesVerifiedBeforeAndAfter', 'heldGenerationRetained']) assert.equal(report[key], true, key);
  for (const key of ['publicDiscovery', 'liveAiAcceptance', 'releaseReady']) assert.equal(report[key], false, key);
  assert.deepEqual(report.beforePeVersion, [0, 1, 19, 0]); assert.deepEqual(report.afterPeVersion, [0, 1, 20, 0]);
  assert.notEqual(report.beforeRoot.pid, report.afterRoot.pid);
  assert.equal(report.afterRoot.kernelIdentityVerified, true);
  assert.deepEqual(report.resourceProbe, { phase: 'after-automatic-root', attempts: 1, passed: true });
  assert.deepEqual(report.heldProcessesAfter, report.heldProcessesBefore);
  assert.equal(report.heldServerVersion.version, binding.baseline.manifest.modules.mcp.version); assert.equal(report.reconnectedServerVersion.version, binding.target.manifest.modules.mcp.version);
  assert.equal(report.beforeRoute.generation, binding.baseline.generation); assert.equal(report.afterRoute.generation, binding.target.generation);
  const finals = rows.filter(row => row.kind === 'lab-lifecycle-result'); assert.equal(finals.length, 1);
  const last = finals[0]; assert.equal(last.scenario, target.KIND);
  assert.equal(last.actualScope, 'exact-direct19-to-changed20-acceptance-fixture-lab-only');
  for (const key of ['lifecycleSucceeded', 'cleanupVerified', 'systemTlsVerified', 'labDiscovery']) assert.equal(last[key], true, key);
  for (const key of ['publicDiscovery', 'productAcceptance', 'releaseReady']) assert.equal(last[key], false, key);
  assert.equal(last.driverExitCode, 0); assert.equal(last.servedRouteCount, 5); assert.equal(last.rejectedRequestCount, 0);
}
module.exports = { FILES, verifyRelease, acquire, checkReceipt };
if (require.main === module) (async () => {
  if (process.argv[2] === 'source') {
    target.assertHost(); console.log(JSON.stringify(binding.target.source));
  } else if (process.argv[2] === 'acquire') console.log(JSON.stringify(await acquire()));
  else {
    target.assertHost(); assert.equal(process.argv[2], 'receipt'); assert.equal(process.argv.length, 5);
    const reportBytes = fs.readFileSync(process.argv[3]), rows = fs.readFileSync(process.argv[4], 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const config = target.readConfig(path.resolve('artifacts/outgoing-019/runner-config.json'));
    checkReceipt(JSON.parse(reportBytes), rows, config);
    fs.writeFileSync('artifacts/outgoing-019/acceptance-binding.json', JSON.stringify({ passed: true, case: process.env.CREATOR_OUTGOING_CASE,
      harnessSource: process.env.GITHUB_SHA, reportSha256: hash(reportBytes), lifecycleSha256: hash(fs.readFileSync(process.argv[4])),
      baselineSource: binding.baseline.source, targetSource: binding.target.source, verificationReceiptSha256: binding.target.verificationReceiptSha256,
      acceptanceOnly: true, publicDiscovery: false, releaseReady: false }, null, 2), { flag: 'wx' });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
