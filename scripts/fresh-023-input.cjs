'use strict';
// Future private GET-only acquisition and receipt verification. No installer execution here.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const contract = require('./fresh-023-contract.cjs');
const target = require('./windows-outgoing-019-target.cjs');
const { admit } = require('./install-admission-023.cjs');
function verifyRelease(view) {
  const expected = target.binding.target.privateRelease;
  assert.equal(view.id, expected.id); assert.equal(view.tag_name, expected.tag);
  assert.equal(view.target_commitish, expected.source); assert.equal(view.draft, true);
  assert.deepEqual(view.assets.map(a => a.name).sort(), Object.keys(expected.assets).sort());
  for (const row of view.assets) {
    const pin = expected.assets[row.name]; assert.equal(row.id, pin.id); assert.equal(row.size, pin.bytes); assert.equal(row.state, 'uploaded');
    if (row.digest != null) assert.equal(row.digest, `sha256:${pin.sha256}`);
  }
}
function proofFor(env) {
  return { schemaVersion: 1, kind: 'private-fresh-023-signed-release-input', harnessSource: env.GITHUB_SHA,
    runId: Number(env.GITHUB_RUN_ID), bindingSha256: env.EXPECTED_BINDING_SHA256, source: contract.SOURCE,
    qualificationSha256: target.binding.target.verificationReceiptSha256,
    privateRelease: target.binding.target.privateRelease, targetOnly: true, baselineInstalled: false, downloadedBytesVerified: true };
}
function validateProof(proof, env) {
  assert.ok(Number.isSafeInteger(proof.runId) && proof.runId > 0);
  assert.deepEqual(proof, proofFor(env));
}
async function acquire(env = process.env, get = null) {
  admit('fresh', env); contract.signedReceipt();
  assert.ok(Number.isSafeInteger(Number(env.GITHUB_RUN_ID)) && Number(env.GITHUB_RUN_ID) > 0);
  const base = path.resolve('artifacts/fresh-023'), data = path.join(base, 'data');
  assert.equal(fs.existsSync(base), false, 'New acquisition namespace required');
  const release = target.binding.target.privateRelease;
  const api = 'https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/';
  if (!get) {
    assert.ok(env.GH_TOKEN, 'Disposable job authorization required for private asset GETs');
    get = async (endpoint, binary = false) => {
      assert.match(endpoint, /^(?:releases\/[0-9]+|releases\/assets\/[0-9]+)$/);
      const response = await fetch(api + endpoint, { method: 'GET', redirect: binary ? 'follow' : 'error',
        signal: AbortSignal.timeout(180000), headers: { Authorization: `Bearer ${env.GH_TOKEN}`,
          Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json' } });
      assert.equal(response.status, 200, `Private read failed (${response.status})`);
      const limit = binary ? 512 * 1024 * 1024 : 256 * 1024;
      const chunks = []; let count = 0;
      for await (const bytes of response.body) { count += bytes.length; assert.ok(count <= limit); chunks.push(bytes); }
      const bytes = Buffer.concat(chunks); return binary ? bytes : JSON.parse(bytes);
    };
  }
  verifyRelease(await get(`releases/${release.id}`));
  fs.mkdirSync(data, { recursive: true });
  for (const name of contract.FILES) {
    const pin = release.assets[name], bytes = await get(`releases/assets/${pin.id}`, true);
    assert.ok(Buffer.isBuffer(bytes)); assert.equal(bytes.length, pin.bytes); assert.equal(contract.hash(bytes), pin.sha256);
    fs.writeFileSync(path.join(data, name), bytes, { flag: 'wx' });
  }
  verifyRelease(await get(`releases/${release.id}`));
  const read = name => fs.readFileSync(path.join(data, name));
  const b = target.binding;
  require('./self-update-outgoing-019-feed.cjs').createDirectOutgoing019Contract({ targetVersion: '0.1.23',
    baseline: { version: '0.1.22', installer: b.baseline.installer.sha256, exe: b.baseline.executable.sha256 },
    pins: { descriptor: b.target.descriptor.sha256, descriptorSignature: b.target.descriptorSignature.sha256,
      installer: b.target.installer.sha256, executable: b.target.executable.sha256, manifest: b.target.latest.sha256 },
    descriptor: read('creator-hub-windows-x86_64.json'), descriptorSignature: read('creator-hub-windows-x86_64.json.minisig'),
    installer: read(contract.TARGET.asset), manifest: read('latest.json') });
  const proof = proofFor(env); validateProof(proof, env);
  fs.writeFileSync(path.join(base, 'input-binding.json'), JSON.stringify(proof, null, 2) + '\n', { flag: 'wx' });
  return { data, proofSha256: contract.hash(fs.readFileSync(path.join(base, 'input-binding.json'))) };
}
function checkReceipt(report, proof, env) {
  contract.signedReceipt(); validateProof(proof, env);
  assert.equal(report.harnessSource, env.GITHUB_SHA);
  for (const [key, value] of Object.entries(contract.productProvenance())) assert.deepEqual(report[key], value, key);
  assert.equal(report.installerSha256, contract.TARGET.installer); assert.equal(report.executableSha256, contract.TARGET.exe);
  for (const key of ['passed', 'freshInstallAccepted', 'manualNormalRestartAccepted', 'settingsPreserved', 'pluginsRemoved',
    'policyRestored', 'sdkAutoAccepted', 'installedResourcesVerified', 'existingConnectionSurvived', 'newConnectionVerified',
    'sdkCleanupVerified', 'cleanupVerified']) assert.equal(report[key], true, key);
  for (const key of ['baselineInstalled', 'migrationAccepted', 'signedUpdateAccepted', 'signedAutomaticRestartAccepted',
    'publicDiscovery', 'releaseReady', 'userMachineUsed', 'formattingEquivalentSettingsAccepted']) assert.equal(report[key], false, key);
  assert.equal(report.normalCloses.length, 2); assert.notEqual(report.normalCloses[0].pid, report.normalCloses[1].pid);
  for (const row of report.normalCloses) { assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0); assert.equal(row.exitCode, 0); }
  require('./fresh-023-native.cjs').validateAuto(report.autoFixtures);
  require('./fresh-023-native.cjs').validateAuto(report.reopenedAutoFixtures);
  require('./fresh-023-native.cjs').validateConnections(report.heldProcessesBefore, report.heldProcessesAfter, report.reconnectedProcesses);
}
module.exports = { verifyRelease, proofFor, validateProof, acquire, checkReceipt };
if (require.main === module) (async () => {
  admit('fresh'); contract.signedReceipt();
  if (process.argv[2] === 'acquire') { assert.equal(process.argv.length, 3); console.log(JSON.stringify(await acquire())); }
  else {
    assert.equal(process.argv[2], 'receipt'); assert.equal(process.argv.length, 4);
    const bytes = target.readBounded(path.resolve(process.argv[3]), 512 * 1024);
    const proofBytes = target.readBounded(path.resolve('artifacts/fresh-023/input-binding.json'), 65536);
    checkReceipt(JSON.parse(bytes), JSON.parse(proofBytes), process.env);
    fs.writeFileSync('artifacts/fresh-023/acceptance-binding.json', JSON.stringify({ passed: true, kind: 'private-fresh-023-acceptance',
      harnessSource: process.env.GITHUB_SHA, source: contract.SOURCE, bindingSha256: process.env.EXPECTED_BINDING_SHA256,
      qualificationSha256: target.binding.target.verificationReceiptSha256, reportSha256: contract.hash(bytes),
      inputProofSha256: contract.hash(proofBytes), freshInstallAccepted: true, signedUpdateAccepted: false,
      publicDiscovery: false, releaseReady: false }, null, 2) + '\n', { flag: 'wx' });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
