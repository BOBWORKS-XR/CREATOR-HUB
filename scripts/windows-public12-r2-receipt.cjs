'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const lab = require('./windows-public12-r2-lab.cjs');
const feed = require('./self-update-lab-feed.cjs');
const candidate = require('./windows-incoming-016.cjs');
const json = file => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(feed.readBounded(file, 1024 * 1024)));
function checkReceipt(report, lifecycle, config, contract, source) {
  assert.match(source || '', /^[a-f0-9]{40}$/); assert.equal(report.harnessSource, source);
  assert.deepEqual(report.from, lab.BASELINE);
  assert.equal(report.to.version, lab.TARGET.version); assert.equal(report.to.installer, lab.TARGET.installer); assert.equal(report.to.exe, lab.TARGET.exe);
  assert.equal(report.feed.kind, lab.KIND); assert.deepEqual(report.feed.pins, config.pins); assert.deepEqual(contract.pins, config.pins);
  for (const [key, value] of Object.entries(candidate.productProvenance())) assert.deepEqual(report.feed[key], value, key);
  assert.equal(report.sourceKind, 'targeted-public-0.1.12-not-previous-stable');
  for (const key of ['passed', 'selfUpdateTested', 'directHubUpdateTested', 'managedRouteReconnectTested', 'pluginsRemoved', 'policyRestored', 'labDiscovery', 'testOnlyDescriptor']) assert.equal(report[key], true, key);
  for (const key of ['nativeAcceptance', 'publicDiscovery', 'releaseReady', 'userMachineUsed']) assert.equal(report[key], false, key);
  assert.equal(report.originalExitCode, 0); assert.ok(Number.isSafeInteger(report.originalPid) && report.originalPid > 0);
  assert.ok(Number.isSafeInteger(report.restartedPid) && report.restartedPid > 0 && report.restartedPid !== report.originalPid);
  const result = lifecycle.filter(row => row.kind === 'lab-lifecycle-result'); assert.equal(result.length, 1);
  assert.equal(result[0].scenario, 'public-stable'); assert.equal(result[0].actualScope, 'unmodified-public-0.1.12-lab-only');
  for (const key of ['lifecycleSucceeded', 'cleanupVerified', 'systemTlsVerified', 'labDiscovery']) assert.equal(result[0][key], true, key);
  for (const key of ['productAcceptance', 'publicDiscovery', 'liveAiAcceptance', 'releaseReady']) assert.equal(result[0][key], false, key);
  assert.equal(result[0].driverExitCode, 0); assert.equal(result[0].servedRouteCount, 5); assert.equal(result[0].rejectedRequestCount, 0);
}
module.exports = { checkReceipt };
if (require.main === module) {
  try {
    lab.assertHost(); assert.equal(process.argv.length, 5);
    const [reportFile, lifecycleFile, configFile] = process.argv.slice(2).map(file => { assert.ok(path.isAbsolute(file)); return file; });
    const config = json(configFile), contract = lab.loadContract(config);
    const lines = new TextDecoder('utf-8', { fatal: true }).decode(feed.readBounded(lifecycleFile, 1024 * 1024)).split(/\r?\n/).filter(Boolean).map(JSON.parse);
    checkReceipt(json(reportFile), lines, config, contract, process.env.GITHUB_SHA);
    console.log(JSON.stringify({ labEvidenceAccepted: true, nativeAcceptance: false, publicDiscovery: false, releaseReady: false }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
