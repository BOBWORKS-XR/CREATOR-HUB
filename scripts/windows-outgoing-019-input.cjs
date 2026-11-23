'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const target = require('./windows-outgoing-019-target.cjs');
const direct = require('./native-outgoing-direct-019.cjs');
const { binding, hash } = target;
const FILES = [target.BASELINE_ASSET, target.ASSET, 'creator-hub-windows-x86_64.json', 'creator-hub-windows-x86_64.json.minisig', 'latest.json'];
function verifyRelease(release, expected) {
  assert.equal(release.id, expected.id); assert.equal(release.tag_name, expected.tag);
  const publicBaseline = expected.id === binding.baseline.releaseId;
  assert.equal(release.draft, !publicBaseline);
  assert.equal(release.target_commitish, publicBaseline ? binding.baseline.source.commit : expected.source);
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
  const baseline = { id: binding.baseline.releaseId, tag: 'v0.1.26', source: binding.baseline.source.commit,
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
function checkMigrationReceipt(report) {
  const {profile,clients}=report;
  assert.deepEqual(Object.keys(profile).sort(),['home','local','roaming']);
  for(const folder of Object.values(profile))assert.ok(path.win32.isAbsolute(folder)&&!folder.split(/[\\/]/).includes('..'));
  const captures=path.dirname(clients.selectedBefore.capture);
  assert.equal(path.dirname(captures),path.resolve(__dirname,'../artifacts'));
  const capture=(row,file,name)=>{assert.equal(row.file,file);assert.equal(row.capture,path.join(captures,name));const bytes=direct.readEvidence(row.capture);assert.equal(bytes.length,row.bytes);assert.equal(hash(bytes),row.sha256);return bytes;};
  const pairs=[['selected',path.join(profile.home,'.claude.json'),'claude'],['old',path.join(profile.home,'.gemini/config/mcp_config.json'),'old-client'],['currentSettings',path.join(profile.roaming,'creator-works-mcp/launcher-config.json'),'settings'],['oldSettings',path.join(profile.roaming,'banter-mcp/launcher-config.json'),'old-settings']];
  for(const [key,file,name] of pairs) {
    const before=capture(clients[key+'Before'],file,name+'-before.json'),after=capture(clients[key+'After'],file,name+'-after.json');
    assert.ok(before.equals(after));assert.ok(direct.readEvidence(file).equals(before));
    if(key==='selected'||key==='old')assert.ok(capture(clients.afterUpdateCancel[key],file,name+'-update-cancel.json').equals(before));
  }
  assert.equal(report.clientReview,undefined);assert.equal(report.clientConnectionsUnchanged,true);
  const old=target.managedLocations(profile.local,'0.1.26',profile.home),next=target.managedLocations(profile.local,'0.1.27',profile.home);
  assert.equal(old.command,next.command);assert.equal(old.active,next.active);assert.equal(old.payload,next.payload);
  target.assertActiveResources(profile.local,'0.1.26',report.beforeRoute,false,profile.home);
  target.assertActiveResources(profile.local,'0.1.27',report.afterRoute,true,profile.home);
  target.assertInstalledResources(path.join(profile.local,'Creator Hub'),'0.1.27');
  target.assertFreshConnection(report.heldProcessesBefore,report.reconnectedProcesses,profile);
  target.assertFreshConnection(report.freshOldProcesses,report.reconnectedProcesses,profile);
  assert.equal(new Set([...report.heldProcessesBefore,...report.freshOldProcesses,...report.reconnectedProcesses].map(p=>p.pid)).size,6);
  assert.equal(report.freshOldServerVersion.version,'2.7.10');
  assert.deepEqual(report.sdkMetadata,{checked:[{version:'4.0.25',mismatch:true,profile:'creator',tested:true,filesUnchanged:true},{version:'4.0.27',mismatch:false,profile:'creator',tested:false,filesUnchanged:true}],lookupNonBlocking:true,afterNormalRestartLookupNonBlocking:true});
  assert.equal(report.sdkLookups?.length,2);
  for(const [i,e] of report.sdkLookups.entries()) {
    assert.equal(e.phase,['after-automatic-update','after-normal-restart'][i]);assert.equal(typeof e.manualRetry,'boolean');
    assert.equal(typeof e.before?.text,'string');assert.equal(e.after?.status,'Ready');assert.equal(e.after.controlsDisabled,false);
    assert.equal(e.after.busy,'false');assert.equal(e.after.errorVisible,false);assert.equal(e.after.buttonDisabled,false);
    if(e.mode==='offline') {assert.equal(e.after.text,'Latest SDK could not be checked. Installed versions are still shown below.');assert.equal(e.version,undefined);}
    else {assert.equal(e.mode,'live');assert.match(e.version,/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/);assert.equal(e.after.text,'Latest Creator SDK: '+e.version);}
  }
}
function checkReceipt(report, rows, config, env = process.env) {
  assert.equal(report.customEditorAbsentInBaseline, true); assert.equal(report.customEditorFoundInTarget, true);
  target.assertBound(config); assert.equal(report.kind, target.KIND); assert.equal(report.sourceCommit, binding.target.source.commit);
  assert.deepEqual(report.baseline, config.baseline); assert.deepEqual(report.pins, config.pins);
  assert.ok(Object.hasOwn(target.CASES,env.CREATOR_OUTGOING_CASE));
  const [tool, restore] = target.CASES[env.CREATOR_OUTGOING_CASE];
  assert.equal(report.lastTool, tool); assert.equal(report.restore, restore === 'true');
  assert.equal(report.restoredLastTool, restore === 'true' ? tool : null);
  assert.deepEqual(report.manualCapabilityRetention, require('./sdk-retention-023.cjs').proof(report.lastTool, report.restore));
  for (const key of ['passed', 'nativeUpdateAccepted', 'automaticRestart', 'cancelPreserved', 'existingConnectionSurvived',
    'newConnectionVerified', 'restorationVerified', 'policyRestored', 'settingsPreserved', 'acceptanceOnly',
    'targetMcpRuntimeVerified', 'installedResourcesVerifiedBeforeAndAfter', 'heldGenerationRetained',
    'activeRouteUnchangedAfterCancel', 'normalRestartPreserved', 'fixtureEvidencePreservedAfterCleanup']) assert.equal(report[key], true, key);
  for (const key of ['publicDiscovery', 'liveAiAcceptance', 'releaseReady']) assert.equal(report[key], false, key);
  assert.deepEqual(report.beforePeVersion, [0, 1, 26, 0]); assert.deepEqual(report.afterPeVersion, [0, 1, 27, 0]);
  assert.notEqual(report.beforeRoot.pid, report.afterRoot.pid);
  const roots=[report.beforeRoot,report.afterRoot,report.normalRestartRoot];
  assert.equal(new Set(roots.map(r=>r.pid)).size,3);
  for(const r of roots){assert.equal(r.kernelIdentityVerified,true);assert.match(r.startTicks,/^[1-9][0-9]*$/);assert.equal(r.image.toLowerCase(),roots[0].image.toLowerCase());}
  assert.ok(BigInt(roots[0].startTicks)<BigInt(roots[1].startTicks)&&BigInt(roots[1].startTicks)<BigInt(roots[2].startTicks));
  assert.deepEqual(report.beforeNormalRestart,report.afterRoot);
  assert.equal(report.afterRoot.kernelIdentityVerified, true);
  assert.deepEqual(report.resourceProbe, { phase: 'after-automatic-root', attempts: 1, passed: true });
  assert.deepEqual(report.heldProcessesAfter, report.heldProcessesBefore);
  checkMigrationReceipt(report);
  assert.equal(report.heldServerVersion.version, binding.baseline.manifest.modules.mcp.version); assert.equal(report.reconnectedServerVersion.version, binding.target.manifest.modules.mcp.version);
  assert.equal(report.beforeRoute.generation, binding.baseline.generation); assert.equal(report.afterRoute.generation, binding.target.generation);
  const finals = rows.filter(row => row.kind === 'lab-lifecycle-result'); assert.equal(finals.length, 1);
  const last = finals[0]; assert.equal(last.scenario, target.KIND);
  assert.equal(last.actualScope, 'exact-direct24-to-qualified25-acceptance-fixture-lab-only');
  for (const key of ['lifecycleSucceeded', 'cleanupVerified', 'systemTlsVerified', 'labDiscovery']) assert.equal(last[key], true, key);
  for (const key of ['publicDiscovery', 'productAcceptance', 'releaseReady']) assert.equal(last[key], false, key);
  assert.equal(last.driverExitCode, 0); assert.equal(last.servedRouteCount, 5); require('./sdk-registry-denial-023.cjs').verifySdkRegistryDenial(last, report);
}
module.exports = { FILES, verifyRelease, acquire, checkMigrationReceipt, checkReceipt };
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
