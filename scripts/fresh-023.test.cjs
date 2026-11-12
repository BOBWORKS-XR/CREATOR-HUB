'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = structuredClone;
const local = name => fs.readFileSync(path.join(__dirname, name), 'utf8');
function compile(name, replacements) {
  const m = new Module(path.join(__dirname, `virtual-${name}`)); m.filename = path.join(__dirname, `virtual-${name}`);
  m.require = n => Object.hasOwn(replacements, n) ? replacements[n] : require(n);
  m._compile(local(name), m.filename); return m.exports;
}
function unit() {
  // In-memory synthetic reports only; never written or used as native acceptance.
  const b = clone(require('./fixtures/windows-outgoing-019-test-fixture.cjs').binding);
  b.target.source = { commit: '7684ed5d5af5c64a9ec6bef6bdb6708756748187', tree: '67b91f1d50cf9a22a03942aae89e387be473ec31' };
  b.target.privateRelease.source = b.target.source.commit;
  b.target.privateRelease.tag = 'lab-windows-capability-023-20261112-r1';
  b.fixtureQualification.source = clone(b.target.source);
  const q = { ...b.fixtureQualification, schemaVersion: 1, source: clone(b.target.source), minimumHubVersion: '0.1.19', outerSigned: true,
    privateTransportTag: b.target.privateRelease.tag,
    updaterUrl: `https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.23/${b.target.asset}`,
    transportMode: 'private-draft-plus-lab-feed', publicDiscovery: false, publicReleaseRequired: false,
    installer: clone(b.target.installer), executable: clone(b.target.executable), manifest: clone(b.target.manifest), generation: b.target.generation,
    assets: Object.fromEntries(Object.entries(b.target.privateRelease.assets).map(([name, pin]) => [name, { bytes: pin.bytes, sha256: pin.sha256 }])),
    verification: { internalSignaturesVerified: true, descriptorSignatureVerified: true, installerSignatureVerified: true, extractedPayloadsMatch: true,
      negativeProofs: Object.fromEntries(['descriptorTamperRejected', 'installerTamperRejected', 'signatureTamperRejected', 'trustedCommentTamperRejected',
        'wrongPublicKeyRejected', 'rawExeDescriptorRejected', 'encodedMetadataSignatureRejected', 'updateUrlTamperRejected'].map(k => [k, true])) } };
  let bytes;
  const repin = () => { bytes = Buffer.from(JSON.stringify(q)); b.target.verificationReceiptSha256 = sha(bytes); b.fixtureQualification.sha256 = sha(bytes); };
  repin();
  const actualTarget = compile('windows-outgoing-019-target.cjs', { './fixtures/windows-outgoing-019-binding.json': b, './self-update-outgoing-019-feed.cjs': {} });
  const reads = [];
  const target = { ...actualTarget, readBounded: file => {
    if (file.endsWith('windows-fresh-023-qualification.json')) return bytes;
    if (file.endsWith('active.json')) return Buffer.from(JSON.stringify({ schemaVersion: 1, descriptorSha256: b.target.manifest.managedRouting.files['routing/runtime.json'], generation: b.target.generation }));
    throw Error('Unexpected unit file read');
  }, readHash: (file, pin) => reads.push({ file, pin }) };
  const contract = compile('fresh-023-contract.cjs', { './windows-outgoing-019-target.cjs': target, './windows-incoming-016.cjs': {} });
  const native = compile('fresh-023-native.cjs', { './windows-outgoing-019-target.cjs': target, './fresh-023-contract.cjs': contract });
  const input = compile('fresh-023-input.cjs', { './windows-outgoing-019-target.cjs': target, './fresh-023-contract.cjs': contract,
    './install-admission-023.cjs': { admit: () => { throw Error('Unit native admission refused'); } }, './fresh-023-native.cjs': native });
  return { b, q, repin, target, contract, native, input, reads };
}
test('fresh signature contract requires exact23, private transport and every existing tamper proof', () => {
  const u = unit(); u.contract.signedReceipt();
  const changes = [x => x.q.source.tree = 'a'.repeat(40), x => x.q.minimumHubVersion = '0.1.22',
    x => x.q.privateTransportTag += '-wrong', x => x.q.updaterUrl = x.q.updaterUrl.replace('v0.1.23', x.q.privateTransportTag),
    x => x.q.payloadFiles = 14, x => x.q.published = true, x => x.q.outerSigned = false,
    x => x.q.executable.sha256 = 'a'.repeat(64), x => x.q.manifest.modules.mcp.version = '2.7.9'];
  for (const k of Object.keys(u.q.verification.negativeProofs)) changes.push(x => x.q.verification.negativeProofs[k] = false);
  for (const change of changes) { const x = unit(); change(x); x.repin(); assert.throws(() => x.contract.signedReceipt()); }
});
test('pending binding refuses fresh signature admission before any fixture or installer read', () => {
  const u = unit(); u.b.enabled = false; assert.throws(() => u.contract.signedReceipt(), /Pending/);
});
test('fresh route checks target router hashes, never baseline22 retained-router hashes', () => {
  const u = unit(); u.contract.assertRoute('C:/unit/Local');
  for (const name of ['router.json', 'router.minisig', 'creator-hub-mcp-router.exe']) {
    const row = u.reads.find(r => r.file.endsWith(name)); assert.ok(row);
    assert.equal(row.pin, u.b.target.manifest.managedRouting.files[`routing/${name}`]);
    assert.notEqual(row.pin, u.b.baseline.manifest.managedRouting.files[`routing/${name}`]);
  }
  assert.equal(u.reads.length, 14);
});
function auto() {
  return { defaultSelection: 'auto', manifestsUnchanged: true, clientFilesAbsent: true, profiles: {
    creator: { profile: 'creator', groups: 'core,creator', error: false }, banter: { profile: 'banter', groups: 'core,banter', error: false },
    hybrid: { profile: 'hybrid', groups: 'core,banter,creator', error: false }, none: { profile: 'none', groups: 'core', error: false },
    missing: { profile: 'unknown', groups: null, error: true }, malformed: { profile: 'unknown', groups: null, error: true } } };
}
test('native Auto evidence requires exact strict-manifest groups and missing/malformed refusal', () => {
  const u = unit(); u.native.validateAuto(auto());
  for (const change of [x => x.defaultSelection = 'core', x => x.profiles.creator.groups = 'core,banter',
    x => x.profiles.hybrid.groups = 'all', x => x.profiles.missing.error = false, x => x.profiles.malformed.groups = 'core',
    x => x.clientFilesAbsent = false, x => x.manifestsUnchanged = false, x => delete x.profiles.none]) {
    const bad = auto(); change(bad); assert.throws(() => u.native.validateAuto(bad));
  }
});
function pair(u, id) {
  const root = process.env.LOCALAPPDATA || 'C:/unit/Local';
  return [{ pid: id, startTicks: String(id), kernelIdentityVerified: true,
    image: path.win32.join(root, 'creator-hub/mcp-route-v1/windows-x86_64/router-v1/creator-hub-mcp-router.exe') },
  { pid: id + 1, parentPid: id, startTicks: String(id + 1), kernelIdentityVerified: true,
    image: path.win32.join(root, 'creator-hub/runtime-generations/windows-x86_64', u.b.target.generation, 'mcp/server/runtime/node.exe') }];
}
test('held target connection survives unchanged and fresh target processes cannot be reused or foreign', () => {
  const u = unit(), held = pair(u, 10), fresh = pair(u, 20); u.native.validateConnections(held, clone(held), fresh);
  for (const change of [x => x[0].pid = 10, x => x[1].parentPid = 10, x => x[1].kernelIdentityVerified = false,
    x => x[1].image = x[1].image.replace(u.b.target.generation, u.b.baseline.generation), x => x[0].image = 'C:/foreign/router.exe']) {
    const bad = clone(fresh); change(bad); assert.throws(() => u.native.validateConnections(held, clone(held), bad));
  }
  const after = clone(held); after[1].startTicks = '9'; assert.throws(() => u.native.validateConnections(held, after, fresh));
});
test('private input release views reject changed IDs, source, draft state, bytes and asset sets', async () => {
  const u = unit(), b = u.b.target.privateRelease;
  const view = { id: b.id, tag_name: b.tag, target_commitish: b.source, draft: true,
    assets: Object.entries(b.assets).map(([name, pin]) => ({ name, id: pin.id, size: pin.bytes, state: 'uploaded', digest: `sha256:${pin.sha256}` })) };
  u.input.verifyRelease(view);
  for (const change of [x => x.draft = false, x => x.target_commitish = 'a'.repeat(40), x => x.assets[0].id++,
    x => x.assets[0].size++, x => x.assets.pop(), x => x.assets[0].digest = 'sha256:' + 'a'.repeat(64)]) {
    const bad = clone(view); change(bad); assert.throws(() => u.input.verifyRelease(bad));
  }
  let gets = 0; await assert.rejects(u.input.acquire({}, () => { gets++; }), /Unit native admission refused/); assert.equal(gets, 0);
});
test('fresh receipts cannot claim target install from a baseline install or omit cleanup and Auto evidence', () => {
  const u = unit(), env = { GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', EXPECTED_BINDING_SHA256: 'b'.repeat(64) };
  const proof = u.input.proofFor(env);
  const report = { ...u.contract.productProvenance(), harnessSource: env.GITHUB_SHA,
    installerSha256: u.contract.TARGET.installer, executableSha256: u.contract.TARGET.exe,
    normalCloses: [{ pid: 30, exitCode: 0 }, { pid: 31, exitCode: 0 }], autoFixtures: auto(), reopenedAutoFixtures: auto(),
    heldProcessesBefore: pair(u, 10), heldProcessesAfter: pair(u, 10), reconnectedProcesses: pair(u, 20) };
  const positive = ['passed', 'freshInstallAccepted', 'manualNormalRestartAccepted', 'settingsPreserved', 'pluginsRemoved', 'policyRestored',
    'sdkAutoAccepted', 'installedResourcesVerified', 'existingConnectionSurvived', 'newConnectionVerified', 'sdkCleanupVerified', 'cleanupVerified'];
  for (const k of positive) report[k] = true;
  for (const k of ['baselineInstalled', 'migrationAccepted', 'signedUpdateAccepted', 'signedAutomaticRestartAccepted', 'publicDiscovery', 'releaseReady',
    'userMachineUsed', 'formattingEquivalentSettingsAccepted']) report[k] = false;
  u.input.checkReceipt(report, proof, env);
  for (const k of positive) { const bad = clone(report); bad[k] = false; assert.throws(() => u.input.checkReceipt(bad, proof, env)); }
  for (const change of [x => x.baselineInstalled = true, x => x.installerSha256 = u.b.baseline.installer.sha256,
    x => x.normalCloses[1].pid = x.normalCloses[0].pid, x => x.signedAutomaticRestartAccepted = true]) {
    const bad = clone(report); change(bad); assert.throws(() => u.input.checkReceipt(bad, proof, env));
  }
});
test('dedicated workflow is fresh-only, private, exact-source gated and never builds product', () => {
  const { yaml } = require('playwright-core/lib/utilsBundle'), file = path.join(__dirname, '../.github/workflows/windows-install-023.yml');
  const source = fs.readFileSync(file, 'utf8'), document = yaml.parseDocument(source);
  assert.deepEqual(document.errors, []); const workflow = document.toJS();
  assert.deepEqual(Object.keys(workflow.jobs).sort(), ['fresh', 'preflight']);
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.jobs.fresh.runs_on, undefined); assert.equal(workflow.jobs.fresh['runs-on'], 'windows-latest');
  assert.equal(workflow.jobs.fresh.needs, 'preflight');
  for (const job of Object.values(workflow.jobs)) assert.ok(job.if.includes('refs/heads/validation/windows-sdk-capability-fresh-023-20261112'));
  assert.equal(require('./install-admission-023.cjs').BRANCH, 'validation/windows-sdk-capability-fresh-023-20261112');
  assert.ok(source.includes("EXPECTED_HARNESS_COMMIT -cne $env:GITHUB_SHA"));
  assert.ok(source.includes('67b91f1d50cf9a22a03942aae89e387be473ec31'));
  assert.ok(source.includes('fresh-023-input.cjs receipt'));
  assert.doesNotMatch(source, /cargo |npm run build|gh release|git push|native-windows-016-migration/);
  assert.match(local('fresh-023-input.cjs'), /method: 'GET'/); assert.doesNotMatch(local('fresh-023-input.cjs'), /method: '(?:POST|PATCH|PUT|DELETE)'/);
});
test('native fresh entry refuses local execution before installer or user-profile access', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'native-fresh-023.cjs'), 'missing.exe'], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 1); assert.match(result.stderr, /disposable GitHub-hosted Windows runner/);
  assert.doesNotMatch(result.stderr, /ENOENT|Cannot find module/);
});
