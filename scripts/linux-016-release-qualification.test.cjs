'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const q = require('./linux-016-release-qualification.cjs');
const native = require('./native-linux-production-016-flatpak.cjs');
const portable = require('./portable-release-descriptor.cjs');
const { fixture: feedFixture } = require('./check-linux-016-release-feed.test.cjs');
const clone = v => structuredClone(v);
function pack(p, name, value) {
  const bytes = Buffer.from(JSON.stringify(value)); const member = `${name}.json`;
  p.members[member] = { size: bytes.length, sha256: q.hash(bytes) }; p.reports[name] = { member, base64: bytes.toString('base64') };
}
function report(p, name) { return q.embedded(p.reports[name], p.members); }
function proof(index = 1) {
  return { runId: 1000 + index, runAttempt: 1, sourceCommit: 'c'.repeat(40), sourceTree: 'd'.repeat(40), jobId: 2000 + index,
    artifact: { id: 3000 + index, name: 'synthetic-unit-test-not-native-acceptance', size: 3, sha256: q.hash(Buffer.from('zip')) },
    members: { 'kept.txt': { size: 1, sha256: q.hash(Buffer.from('x')) } }, reports: {} };
}
function fixture() {
  const f = feedFixture();
  const value = { schemaVersion: 1, kind: 'linux-016-qualified-draft', repository: q.REPO, version: '0.1.16', platform: 'linux-x86_64',
    authorization: 'publish-qualified-draft-only', releaseReady: false, publicAcceptance: false, sourceCommit: q.SOURCE, sourceTree: q.TREE,
    producers: {}, proofs: {}, portableEligibility: { approvedForStable: true, executableSha256: q.ROOT.sha256, checks: Object.fromEntries(portable.CHECKS.map(k => [k, true])) },
    draft: f.qualification.draft, windows: f.qualification.windows };
  for (const [name, fixed] of Object.entries(q.PRODUCERS)) {
    const p = proof(); Object.assign(p, { runId: fixed.runId, sourceCommit: fixed.sourceCommit, sourceTree: fixed.sourceTree, jobId: fixed.jobId || 555 });
    Object.assign(p.artifact, { id: fixed.artifactId, size: fixed.size, sha256: fixed.sha256 }); value.producers[name] = p;
  }
  const root = pid => ({ pid, kernelImageSha256: q.ROOT.sha256 });
  let index = 0;
  for (const [role, family] of Object.entries(q.ROLES)) {
    const p = proof(++index), r = { harnessSource: p.sourceCommit, scenario: role, releaseReady: false };
    if (family === 'incoming') {
      Object.assign(r, { assembly: { sourceCommit: q.SOURCE, sourceTree: q.TREE, runId: q.PRODUCERS.assembly.runId,
        artifactId: q.PRODUCERS.assembly.artifactId, jobId: q.PRODUCERS.assembly.jobId }, directPagesObserved: true,
        manualReopenObserved: true, preservationAccepted: true, freshInstallAccepted: role === 'fresh16', manualPublic012UpgradeAccepted: role === 'public012-to16',
        first16: { root: root(101), visibleVersion: '0.1.16', normalCloseObserved: true, bitmap: { nonblank: true } },
        reopened16: { root: root(102), visibleVersion: '0.1.16', normalCloseObserved: true, bitmap: { nonblank: true } },
        protectedAfterInstall16: {}, protectedAfterFirst: {}, protectedAfterReopen: {}, firstReadJournal: {}, reopenedReadJournal: {} });
      if (role === 'public012-to16') Object.assign(r, { old012: { visibleVersion: '0.1.12', normalCloseObserved: true }, protectedAfter012: {} });
    } else if (family === 'migration') {
      Object.assign(r, { scenarioPassed: true, normalReopenObserved: true, first: { root: root(101), normalCloseObserved: true },
        reopened: { root: root(102), normalCloseObserved: true }, oldRuntimeAfterMigration: {}, oldRuntimeAfterClose: {}, oldRuntimeAfterReopen: {}, operationJournals: {} });
      pack(p, 'binding', { profile: { assembly: { sourceCommit: q.SOURCE, sourceTree: q.TREE }, pins: { deb: q.DEB, hub: q.ROOT } } });
      r.bindingSha256 = p.members['binding.json'].sha256;
      pack(p, 'broker', { scope: 'production-016-disposable-migration', scenario: role, harnessSource: p.sourceCommit, scenarioPassed: true,
        fixtureRelocked: true, inputProofs: role === 'migration-guide-cancel' ? 0 : 1, releaseReady: false });
    } else if (family === 'update') {
      const target = { scope: 'private-source75-updater-lifecycle-only', targetSource: q.PRIVATE17,
        targetRetirementHelper: { size: 1167744, sha256: '501e97da9c93d370caa750c46f4c3f272d546281e8e2eeedfaf4f01193d644be' },
        privateDebApprovalRestoresOldRetirementHelper: true, final016HelperFixRetained: false,
        targetFixNativeAcceptance: false, futurePublic017Qualified: false, releaseReady: false };
      Object.assign(r, { profile: 'production016-private017-native-update', scenarioPassed: true, privateTargetQualification: target,
        fromSource: q.SOURCE, toSource: q.PRIVATE17, initial16Verified: true, nativeConfirmationObserved: true, settingsPreserved: true,
        runtimeSurvived: true, normalFinalClose: true, initialRoot: root(101), initialBitmap: { nonblank: true },
        oldRetirementHelperRestored: role === 'deb-approve' });
      if (role.endsWith('approve')) Object.assign(r, { nativeActions: ['Update Hub'], systemActions: role === 'deb-approve' ? ['Authenticate'] : [],
        oldNormalExit: true, automaticRestartObserved: true, installed17Verified: true, fresh17UiVersion: true, directPagesObserved: true,
        automaticSuccessor: { pid: 102 }, successorBitmap: { nonblank: true } });
      else Object.assign(r, { nativeActions: [role.endsWith('native-cancel') ? 'Not now' : 'Update Hub'], systemActions: role === 'deb-auth-cancel' ? ['Cancel'] : [],
        sealed17Observed: role === 'deb-auth-cancel', oldSelectionUnchanged: true, initialRootSurvived: true, automaticSuccessor: null });
      pack(p, 'broker', { profile: r.profile, scenario: role, scenarioPassed: true, harnessSource: p.sourceCommit,
        privateTargetQualification: target, baselineSource: q.SOURCE, targetSource: q.PRIVATE17, fixtureRelocked: true,
        oldRetirementHelperRestored: r.oldRetirementHelperRestored, tlsCleanup: { temporaryCertificateRemoved: true, originalTrustRestored: true }, releaseReady: false });
      pack(p, 'profile', { baseline: { source: q.SOURCE, deb: q.DEB, hub: q.ROOT, artifact: q.PRODUCERS.assembly.artifactId } });
      pack(p, 'transport', { closeReason: 'caller', rejectedRequestCount: 0, fromVersion: '0.1.16', targetVersion: '0.1.17', publicDiscovery: false, releaseReady: false, requests: [{}] });
    } else {
      Object.assign(r, { profile: 'production-flatpak-host-016', phase: 'complete', coldRoot: root(101) });
      for (const n of ['candidateExecuted', 'flatpakInstalled', 'disclosureCancelAccepted', 'missingHostAccepted', 'portalCaptureAccepted', 'setupCancelAccepted',
        'bootstrapAccepted', 'coldActivationAccepted', 'warmActivationAccepted', 'settingsPreserved', 'normalCloseObserved']) r[n] = true;
      const files = Object.fromEntries(['package-receipt.json', 'Creator Hub_0.1.16_amd64.AppImage', 'Creator.Hub.Native.Support_0.1.16_amd64.AppImage',
        'portable-manifest.unsigned.json', q.NAMES.tar, 'appdir-original-inventory.json', 'appdir-flattened-inventory.json'].map(n => [n, { size: 1, sha256: 'e'.repeat(64) }]));
      const fixed = q.PRODUCERS.portable;
      Object.assign(value.producers.portable.members, files);
      pack(p, 'profile', { schemaVersion: 1, profile: r.profile, mode: 'bootstrap-activation', portable: {
        sourceCommit: q.SOURCE, sourceTree: q.TREE, packagingCommit: fixed.sourceCommit, packagingTree: fixed.sourceTree,
        runId: fixed.runId, runAttempt: 1, jobId: fixed.jobId, artifactId: fixed.artifactId, zip: { size: fixed.size, sha256: fixed.sha256 }, files } });
      pack(p, 'review', { signaturesVerified: true, runtimeEnabled: false, portable: { root: q.ROOT } });
      pack(p, 'transport', { closeReason: 'caller', rejectedRequestCount: 0 });
      pack(p, 'final', { ...r, tlsCleanupVerified: true });
    }
    pack(p, 'session', r); value.proofs[role] = p;
  }
  for (const [n, p] of [[q.NAMES.deb, q.DEB], [q.NAMES.tar, q.TAR], [q.NAMES.image, q.IMAGE], [q.NAMES.alias, q.IMAGE],
    [q.NAMES.manifest, { size: 68007, sha256: 'e999031faf52382dc93145e8195df50d9d86f6b4d3d138f3546881d74882e013' }],
    [q.NAMES.flatpak, native.FIXED.files[q.NAMES.flatpak]]]) Object.assign(value.draft.assets[n], p);
  value.portableEligibility.evidence = ['portable-native-cancel', 'portable-approve', 'flatpak']
    .map(role => `https://github.com/${q.REPO}/actions/runs/${value.proofs[role].runId}`);
  return value;
}
module.exports = { fixture, proof, pack, report };
if (require.main === module) {
  test('portable eligibility rejects unrelated evidence run URLs', () => {
    const v = fixture();
    v.portableEligibility.evidence = ['https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/1'];
    assert.throws(() => q.validateQualification(v), /Portable evidence run URLs/);
  });
  test('portable eligibility cannot promote checks absent from original relevant reports', () => {
    const v = fixture();
    v.portableEligibility.evidence = ['portable-native-cancel', 'portable-approve', 'flatpak']
      .map(role => `https://github.com/${q.REPO}/actions/runs/${v.proofs[role].runId}`);
    assert.throws(() => q.validateQualification(v), /Unqualified portable checks/);
  });
  test('portable evidence derives only supported outcomes and does not read caller checks', () => {
    const v = fixture(), expected = q.derivePortableEvidence(v);
    assert.deepEqual(expected.evidence, v.portableEligibility.evidence);
    assert.deepEqual(expected.unqualified, ['invalidSignatureRefused', 'staleSelectionRefused', 'stageKeptOldSelection',
      'normalOldExitBeforeSelection', 'abnormalExitKeptOldSelection', 'authenticatedReady', 'mcpPreserved']);
    for (const name of portable.CHECKS) assert.equal(expected.checks[name], expected.unqualified.includes(name) ? null : true);
    v.portableEligibility.checks = Object.fromEntries(portable.CHECKS.map(name => [name, 'SPOOFED']));
    assert.deepEqual(q.derivePortableEvidence(v), expected);
    const p = v.proofs['portable-approve'], original = report(p, 'session');
    original.settingsPreserved = false; pack(p, 'session', original);
    assert.throws(() => q.derivePortableEvidence(v));
  });
  test('portable evidence URLs cannot be missing, duplicated, producer-only or aliased', () => {
    for (const mutate of [v => { delete v.portableEligibility.evidence; },
      v => { v.portableEligibility.evidence.pop(); },
      v => { v.portableEligibility.evidence.push(v.portableEligibility.evidence[0]); },
      v => { v.portableEligibility.evidence[0] += '/'; },
      v => { v.portableEligibility.evidence[0] = `https://github.com/${q.REPO}/actions/runs/${v.producers.portable.runId}`; }]) {
      const v = fixture(); mutate(v);
      assert.throws(() => q.validateQualification(v), /Portable evidence run URLs/);
    }
  });
  test('missing actual roles or unsupported checks refuse remote verification before API access', async () => {
    const calls = [], io = { request: async () => { calls.push('api'); throw Error('must not run'); } };
    for (const role of Object.keys(q.ROLES)) {
      const v = fixture(); delete v.proofs[role]; await assert.rejects(q.verifyRemote(v, io));
    }
    await assert.rejects(q.verifyRemote(fixture(), io), /Unqualified portable checks/);
    assert.deepEqual(calls, []);
  });
  test('synthetic structural fixture does not assert remote/native/public acceptance', () => {
    const v = fixture(); assert.equal(q.validateQualificationStructure(v), v); assert.equal(v.releaseReady, false); assert.equal(v.publicAcceptance, false);
    assert.throws(() => q.validateQualification(v), /Unqualified portable checks/);
  });
  test('every documented original native role and broker is mandatory', () => {
    for (const role of Object.keys(q.ROLES)) {
      const v = fixture(); delete v.proofs[role]; assert.throws(() => q.validateQualificationStructure(v));
      const w = fixture(), p = w.proofs[role], r = report(p, 'session'); r.error = 'original failure'; pack(p, 'session', r);
      assert.throws(() => q.validateQualificationStructure(w), /failure/);
    }
    const v = fixture(); const p = v.proofs['deb-approve']; const b = report(p, 'broker'); b.fixtureRelocked = false; pack(p, 'broker', b);
    assert.throws(() => q.validateQualificationStructure(v));
  });
  test('wrong Root/cohort, private draft/017 assets, unknown fields and aggregate promotions refuse', () => {
    for (const mutate of [v => { v.sourceCommit = 'f'.repeat(40); }, v => { v.sourceTree = 'f'.repeat(40); },
      v => { v.draft.id = 411494394; }, v => { v.draft.assets['private017.zip'] = {}; }, v => { v.platform = 'windows-x86_64'; },
      v => { v.releaseReady = true; }, v => { v.producers.assembly.artifact.sha256 = '0'.repeat(64); },
      v => { v.draft.assets[q.NAMES.alias].sha256 = '0'.repeat(64); }, v => { v.draft.assets[q.NAMES.deb].id = v.draft.assets[q.NAMES.tar].id; },
      v => { v.draft.id = v.windows.id; }, v => { v.draft.assets['latest.json'].size = 128 * 1024 + 1; },
      v => { v.draft.assets[q.NAMES.deb + '.sig'].size = 4097; }]) {
      const v = fixture(); mutate(v); assert.throws(() => q.validateQualificationStructure(v));
    }
  });
  test('cancel cannot qualify approval, manual successor cannot substitute restart, private helper disclaimer retained', () => {
    for (const [role, mutate] of [['deb-approve', r => { r.automaticRestartObserved = false; }],
      ['deb-approve', r => { r.privateTargetQualification.futurePublic017Qualified = true; }],
      ['deb-native-cancel', r => { r.automaticSuccessor = { pid: 999 }; }],
      ['portable-approve', r => { r.systemActions = ['Authenticate']; }],
      ['deb-auth-cancel', r => { r.sealed17Observed = false; }],
      ['fresh16', r => { r.reopened16.root.pid = r.first16.root.pid; }],
      ['flatpak', r => { r.warmActivationAccepted = false; }]]) {
      const v = fixture(), p = v.proofs[role], r = report(p, 'session'); mutate(r); pack(p, 'session', r);
      assert.throws(() => q.validateQualificationStructure(v));
    }
  });
  test('original report encoding, member hashes, aliases and evidence bounds are enforced', () => {
    for (const mutate of [p => { p.reports.session.base64 += '\n'; }, p => { p.members['session.json'].sha256 = 'f'.repeat(64); },
      p => { p.members['../foreign.json'] = p.members['session.json']; }, p => { p.members['SESSION.json'] = p.members['session.json']; },
      p => { p.members['session.json'].size = 2 * 1024 ** 2 + 1; }]) {
      const v = fixture(); mutate(v.proofs.fresh16); assert.throws(() => q.validateQualificationStructure(v));
    }
  });
  test('old/foreign baseline bytes and a different Flatpak bootstrap cohort cannot substitute for final016', () => {
    for (const [role, name, mutate] of [
      ['deb-approve', 'profile', r => { r.baseline.deb = { size: 1, sha256: 'a'.repeat(64) }; }],
      ['migration-approve', 'binding', r => { r.profile.pins.hub = { size: 1, sha256: 'a'.repeat(64) }; }],
      ['flatpak', 'profile', r => { r.portable.files['portable-manifest.unsigned.json'].sha256 = 'a'.repeat(64); }]]) {
      const v = fixture(), p = v.proofs[role], r = report(p, name); mutate(r); pack(p, name, r);
      assert.throws(() => q.validateQualificationStructure(v));
    }
  });
  test('metadata routes/platform/signature/checksum/source bindings refuse drift independently of cryptographic tests', t => {
    const v = fixture(); Object.assign(v.portableEligibility, { sourceCommit: q.SOURCE, sourceTree: q.TREE });
    const descriptor = { schemaVersion: 1, appId: 'creator-hub', version: '0.1.16', packageType: 'portable-appdir' };
    t.mock.method(portable, 'descriptor', () => descriptor);
    const encode = v => Buffer.from(JSON.stringify(v) + '\n');
    const bodies = {
      'creator-hub-linux-x86_64.json': encode({ schemaVersion: 1, appId: 'creator-hub', version: '0.1.16', platform: 'linux', architecture: 'x86_64',
        packageType: 'deb', assetName: q.NAMES.deb, byteLength: q.DEB.size, sha256: q.DEB.sha256, executableSha256: q.ROOT.sha256,
        identityProtocol: 0, lifecycleProtocol: 0, installerProtocol: 1 }),
      [q.NAMES.deb + '.sig']: Buffer.from('synthetic-signature-for-routing-only'),
      [q.NAMES.manifest]: encode({}), 'creator-hub-linux-x86_64-portable.json': encode(descriptor),
      'SHA256SUMS.txt': Buffer.from(q.assetNames().filter(n => n !== 'SHA256SUMS.txt').sort().map(n => `${v.draft.assets[n].sha256}  ${n}\n`).join('')),
    };
    bodies['latest.json'] = encode({ version: '0.1.16', platforms: { 'linux-x86_64-deb': {
      url: `https://github.com/${q.REPO}/releases/download/v0.1.16/${q.NAMES.deb}`, signature: bodies[q.NAMES.deb + '.sig'].toString('base64') } } });
    assert.equal(q.verifyDocuments(v, bodies).ready, false);
    for (const [name, mutate] of [
      ['latest.json', r => { r.platforms['windows-x86_64'] = r.platforms['linux-x86_64-deb']; }],
      ['latest.json', r => { r.platforms['linux-x86_64-deb'].url = 'https://example.invalid'; }],
      ['latest.json', r => { r.platforms['linux-x86_64-deb'].signature = 'wrong'; }],
      ['creator-hub-linux-x86_64.json', r => { r.packageType = 'nsis'; }],
      ['creator-hub-linux-x86_64.json', r => { r.sha256 = 'f'.repeat(64); }],
      ['creator-hub-linux-x86_64-portable.json', r => { r.version = '0.1.17'; }]]) {
      const changed = { ...bodies }; const r = JSON.parse(bodies[name]); mutate(r); changed[name] = encode(r);
      assert.throws(() => q.verifyDocuments(v, changed));
    }
    assert.throws(() => q.verifyDocuments(v, { ...bodies, 'SHA256SUMS.txt': Buffer.from('extra private.zip\n') }));
    const changed = { ...bodies, 'latest.json': Buffer.from('{"version":"0.1.16","version":"0.1.16"}\n') };
    assert.throws(() => q.verifyDocuments(v, changed), /Canonical/);
    v.portableEligibility.sourceCommit = 'f'.repeat(40); assert.throws(() => q.verifyDocuments(v, bodies));
    // The public verification path still checks every original byte and signature before this helper.
    assert.throws(() => q.verifyAssets(fixture(), bodies));
  });
  test('exact receipt digest/canonical JSON and no-follow identity checks precede validation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linux016-review-test-'));
    try {
      const file = path.join(dir, 'review.json'), bytes = Buffer.from(JSON.stringify(fixture()) + '\n'); fs.writeFileSync(file, bytes, { flag: 'wx' });
      assert.throws(() => q.loadQualification(file, q.hash(bytes)), /Unqualified portable checks/);
      assert.throws(() => q.loadQualification(file, '0'.repeat(64)), /Original|[a-f0-9]{64}/);
      assert.throws(() => q.canonical(Buffer.from('{"a":1,"a":1}\n')));
      assert.throws(() => q.loadQualification(dir, q.hash(bytes)));
    } finally { fs.rmSync(dir, { recursive: true }); }
  });
  test('immutable API attempt/source/repository/job/time/artifact and complete ZIP map are all checked', async () => {
    const p = proof(), bytes = Buffer.from('zip'), repository = { id: q.REPO_ID, full_name: q.REPO };
    const records = { [`actions/runs/${p.runId}`]: { id: p.runId, run_attempt: 1, head_sha: p.sourceCommit, path: '.github/workflows/native-linux-production-016-incoming.yml',
      event: 'workflow_dispatch', status: 'completed', conclusion: 'success', repository, head_repository: repository },
    [`git/commits/${p.sourceCommit}`]: { sha: p.sourceCommit, tree: { sha: p.sourceTree } },
    [`actions/jobs/${p.jobId}`]: { id: p.jobId, run_id: p.runId, run_attempt: 1, head_sha: p.sourceCommit, name: 'incoming', status: 'completed', conclusion: 'success',
      labels: ['ubuntu-22.04'], started_at: '2026-10-20T00:00:00Z', completed_at: '2026-10-20T00:02:00Z' },
    [`actions/artifacts/${p.artifact.id}`]: { id: p.artifact.id, name: p.artifact.name, expired: false, size_in_bytes: 3, digest: 'sha256:' + p.artifact.sha256,
      workflow_run: { id: p.runId, head_sha: p.sourceCommit, repository_id: q.REPO_ID, head_repository_id: q.REPO_ID }, created_at: '2026-10-20T00:01:00Z' } };
    const run = async (change = () => {}, rows = p.members, raw = bytes) => { const data = clone(records); change(data); return q.verifyProof(p, 'native-linux-production-016-incoming.yml', 'incoming',
      { request: async n => data[n], download: async () => raw, inspectArchive: async () => rows }); };
    await run();
    for (const change of [d => { d[`actions/runs/${p.runId}`].run_attempt++; }, d => { d[`actions/runs/${p.runId}`].conclusion = 'failure'; },
      d => { d[`actions/runs/${p.runId}`].head_repository.id++; }, d => { d[`actions/jobs/${p.jobId}`].name = 'other'; },
      d => { d[`actions/artifacts/${p.artifact.id}`].created_at = '2026-10-21T00:00:00Z'; }, d => { d[`actions/artifacts/${p.artifact.id}`].expired = true; }]) await assert.rejects(run(change));
    await assert.rejects(run(() => {}, {})); await assert.rejects(run(() => {}, p.members, Buffer.from('bad')));
  });
  test('Minisign ED framing matches the pinned crate public vector; production key cannot be overridden', () => {
    const file = require.resolve('./linux-016-release-qualification.cjs'), source = fs.readFileSync(file, 'utf8');
    const vectorKey = 'RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3';
    const body = Buffer.from('test'), sig = Buffer.from('untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==\n');
    const context = { require: createRequire(file), module: { exports: {} }, Buffer, TextDecoder, __dirname: path.dirname(file) };
    vm.runInNewContext(source.replace(/const PUBLIC_KEY = '[^']+';/, `const PUBLIC_KEY = '${vectorKey}';`), context);
    const verify = context.module.exports.verifySignature;
    verify(body, sig); assert.throws(() => verify(Buffer.from('Test'), sig));
    assert.throws(() => verify(body, Buffer.from(sig.toString().replace('timestamp:1556193335', 'timestamp:1556193336'))));
    assert.throws(() => verify(body, Buffer.from(sig.toString().replace('RUQf', 'RWQf'))));
    assert.throws(() => q.verifySignature(body, sig, vectorKey));
  });
  test('existing immutable Root routing bytes verify with the actual production key, without signing', () => {
    // Public test vector retained from Root39430509970, not a new signature or acceptance receipt.
    const body = Buffer.from('eyJzY2hlbWFWZXJzaW9uIjoxLCJwcm9kdWN0IjoiY29tLmNyZWF0b3J3b3Jrcy5odWIubWNwLXJvdXRlciIsInBsYXRmb3JtIjoibGludXgiLCJhcmNoIjoieDg2XzY0IiwicHJvdG9jb2wiOjEsInNoYTI1NiI6ImRmMjRlNTgyNjVhOTliMjgzM2YzOGE1MGEwZTBmYjE3MDcyODlkMGRjODkxZTg5ZWE5MjNjNDdjNTdiZmY0YWYifQ==', 'base64');
    const sig = Buffer.from('untrusted comment: signature from tauri secret key\nRUT+ay+R2gfWMeSN1qB37YfywZbtkdQg5zJ43fRpbb1e61TfPVmHmy8GUDKqqh00aFiOZY6UnGG82NDNUyN29vSlS4G1uf5BowM=\ntrusted comment: timestamp:1792445880\tfile:signing-input-0.json\nU4aq5dMwerFzF/k6MTObHNIHwk/lhmzjvegITWhbZmFvR9LtYl1ynJtGHyvoMQHnNLGt3o0vzTvK1N8om2SeAA==\n');
    assert.equal(q.hash(body), '1315487222bd02492a502b59cea29c530a6ae77b66f11348d07fdcf7efb99eaa');
    q.verifySignature(body, sig); assert.throws(() => q.verifySignature(Buffer.concat([body, Buffer.from(' ')]), sig));
    assert.throws(() => q.verifySignature(body, Buffer.from(sig.toString().replace('2gfW', '2gfX'))));
    assert.throws(() => q.verifySignature(body, Buffer.from(sig.toString() + 'extra\n')));
  });
  test('real stdlib ZIP parser hashes bounded ordinary/empty members and refuses unsafe types/names/corruption', () => {
    const python = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Programs/Python/Python311/python.exe') : 'python3';
    const zip = entries => execFileSync(python, ['-I', '-B', '-c',
      'import io,json,stat,sys,warnings,zipfile\nb=io.BytesIO()\nwith warnings.catch_warnings():\n warnings.simplefilter("ignore")\n with zipfile.ZipFile(b,"w",compression=zipfile.ZIP_DEFLATED) as z:\n  for n,mode,text in json.load(sys.stdin):\n   e=zipfile.ZipInfo(n);e.create_system=3;e.external_attr=mode<<16;z.writestr(e,text.encode())\nsys.stdout.buffer.write(b.getvalue())'],
    { input: JSON.stringify(entries), timeout: 10000, maxBuffer: 65536, windowsHide: true });
    const parse = raw => q.inspectArchive(raw, (_exe, args, options) => execFileSync(python, args, options));
    assert.deepEqual(parse(zip([['nested/report.json', 0o100644, '{}'], ['empty.stderr', 0o100644, '']])), {
      'nested/report.json': { size: 2, sha256: q.hash(Buffer.from('{}')) }, 'empty.stderr': { size: 0, sha256: q.hash(Buffer.alloc(0)) } });
    for (const entries of [[['../foreign', 0o100644, 'x']], [['a', 0o120777, 'target']], [['a', 0o010644, 'x']],
      [['a', 0o104755, 'x']], [['a', 0o100644, 'x'], ['A', 0o100644, 'x']], [['a', 0o100644, 'x'], ['a', 0o100644, 'x']]]) assert.throws(() => parse(zip(entries)));
    const raw = zip([['ordinary', 0o100644, 'x']]); assert.throws(() => parse(raw.subarray(0, raw.length - 22)));
  });
  test('ZIP reader is isolated, bounded and data-only; no extraction or candidate execution', () => {
    let call;
    assert.deepEqual(q.inspectArchive(Buffer.from('zip'), (exe, args, options) => { call = { exe, args, options }; return Buffer.from('{}'); }), {});
    assert.deepEqual(call.args.slice(0, 3), ['-I', '-B', '-c']); assert.ok(call.options.timeout > 0); assert.ok(call.options.maxBuffer <= 2 * 1024 ** 2);
    assert.doesNotMatch(q.ZIP_READER, /extract|subprocess|exec\(|eval\(/);
    assert.match(q.ZIP_READER, /e\.flag_bits&1/); assert.match(q.ZIP_READER, /stat\.S_IFREG/);
  });
}
