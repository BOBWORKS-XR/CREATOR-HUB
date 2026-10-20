'use strict';
// Finite reviewed Linux016 publication input. Mocks and inspection flags are not acceptance.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const feed = require('./check-linux-016-release-feed.cjs');
const portable = require('./portable-release-descriptor.cjs');
const native = require('./native-linux-production-016-flatpak.cjs');
const { checkSources } = require('./check-unified-sources.cjs');
const REPO = feed.REPO, REPO_ID = 1364807512;
const SOURCE = '4d9e073465928b9e00719d5ba594343281cd1280';
const TREE = 'e338ffaea6ab359fb37a212f96ac2d6172b6484c';
const PUBLIC_KEY = 'RWT+ay+R2gfWMYih7RvbGIueJl/HWLefIoYABjB2O68PaDXh4W7zu8VP';
const ROOT = Object.freeze({ size: 28808088, sha256: 'bb7087c07ea4b68c70c1e6f7c6630f83199950d0af8158c9541d6ed317dc6811' });
const DEB = Object.freeze({ size: 64351274, sha256: '73497fcf96112e85427f8ba92ff2dcc1816e7f95a6d3a0fe9f8be1893f951d18' });
const TAR = Object.freeze({ size: 164473696, sha256: 'a1df9859259bab9038bad737cadc0480c10a3a03ac388d16e589afbf364ebbf1' });
const IMAGE = Object.freeze({ size: 143362552, sha256: '105fd28ecf535c0a42d6052af6c1ebd2fd4a5c812aa870c3fe2ba325d0a90314' });
const MANIFEST = Object.freeze({ size: 68007, sha256: 'e999031faf52382dc93145e8195df50d9d86f6b4d3d138f3546881d74882e013' });
const PRIVATE17 = '75a99ff4a267064aaa3ac9e30039bc91dc791d89';
const NAMES = Object.freeze({ deb: 'Creator.Hub_0.1.16_amd64.deb', image: 'Creator.Hub_0.1.16_amd64.AppImage',
  alias: 'Creator.Hub.Native.Support_0.1.16_amd64.AppImage', tar: 'creator-hub-linux-x86_64-0.1.16.appdir.tar.gz',
  manifest: 'creator-hub-linux-x86_64-0.1.16.portable-manifest.json', flatpak: 'Creator.Hub_0.1.16_x86_64.flatpak' });
const ASSETS = Object.freeze([NAMES.deb, NAMES.deb + '.sig', feed.CATALOG, feed.CATALOG + '.minisig', 'latest.json',
  NAMES.image, NAMES.alias, NAMES.tar, NAMES.manifest, NAMES.manifest + '.minisig', feed.PORTABLE,
  feed.PORTABLE + '.minisig', NAMES.flatpak, 'SHA256SUMS.txt']);
const ROLES = Object.freeze(Object.fromEntries([
  ...['fresh16', 'public012-to16'].map(n => [n, 'incoming']),
  ...['migration-guide-cancel', 'migration-first-system-cancel', 'migration-second-system-cancel', 'migration-approve'].map(n => [n, 'migration']),
  ...['deb-native-cancel', 'deb-auth-cancel', 'deb-approve', 'portable-native-cancel', 'portable-approve'].map(n => [n, 'update']),
  ['flatpak', 'flatpak'],
]));
const PRODUCERS = Object.freeze({
  assembly: { runId: 39430509970, jobId: 118654160337, artifactId: 12268801490, sourceCommit: SOURCE, sourceTree: TREE,
    workflow: 'unix-managed-assembly.yml', size: 183661772, sha256: 'ffc211f64dd131f926cc3b47bdb93513aa8c2096afbc08f8a0968517f139016d' },
  portable: { runId: 39435741602, jobId: 118672158000, artifactId: 12273135520,
    sourceCommit: 'b75da4e5c1e7d4d09eada4e89c94040b9e0c6aae', sourceTree: '62d3fc2df55ca3540117737b6a86d6fb48fc6e3a',
    workflow: 'linux-016-portable-production.yml', size: 451816231, sha256: '25ba6649c3886fd685c1dc7bab7f49e405569fe015674528529e9e3b901ccab5' },
  flatpak: { runId: native.FIXED.runId, artifactId: native.FIXED.artifactId, sourceCommit: native.FIXED.harnessSource,
    sourceTree: native.FIXED.harnessTree, workflow: 'flatpak-native-production-016.yml', ...native.FIXED.zip },
});
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function keys(v, names) { assert.ok(v && typeof v === 'object' && !Array.isArray(v)); assert.deepEqual(Object.keys(v).sort(), [...names].sort(), 'Closed qualification fields required'); }
function id(v) { assert.ok(Number.isSafeInteger(v) && v > 0, 'Positive immutable ID/size required'); }
function sha(v, n = 64) { assert.ok(typeof v === 'string' && new RegExp(`^[a-f0-9]{${n}}$`).test(v)); }
function pin(p, max = 768 * 1024 ** 2, empty = false) {
  keys(p, ['size', 'sha256']); assert.ok(Number.isSafeInteger(p.size) && p.size >= (empty ? 0 : 1) && p.size <= max); sha(p.sha256);
}
function bound(bytes, p) { assert.ok(Buffer.isBuffer(bytes)); assert.deepEqual({ size: bytes.length, sha256: hash(bytes) }, { size: p.size, sha256: p.sha256 }, 'Original bytes differ'); return bytes; }
function json(bytes) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
function member(n) { assert.ok(typeof n === 'string' && n.length <= 256 && !/[\x00-\x1f\x7f\\:]/.test(n) && n.split('/').every(p => p && p !== '.' && p !== '..'), 'Unsafe archive member'); }
function embedded(report, members) {
  keys(report, ['member', 'base64']); member(report.member);
  const p = members[report.member]; assert.ok(p); pin(p, 2 * 1024 ** 2);
  assert.ok(typeof report.base64 === 'string' && report.base64.length <= 2800000);
  const bytes = Buffer.from(report.base64, 'base64'); assert.equal(bytes.toString('base64'), report.base64);
  return json(bound(bytes, p));
}
function noFailure(v) {
  if (!v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v)) {
    if (/^(?:error|refusal|recovery|closeError|logError|labCloseError|tlsCleanupError|trustCleanup|transportCleanup|relockRefusal|cleanupError)$/.test(k)) assert.ok(!x, 'Original proof contains failure/unknown cleanup');
    if (/^(?:disposableTeardownRequired|disposableTeardown|disposableTeardownUnknown|labTeardownUnknown|captureRefused|tlsCleanupRefused|relockRefused)$/.test(k)) assert.notEqual(x, true, 'Original proof requires teardown/review');
  }
}
function flags(r) { assert.equal(r.releaseReady, false, 'Do not promote component scope'); }
function root(r, expected = ROOT) { assert.ok(r && Number.isSafeInteger(r.pid) && r.pid > 1); assert.equal(r.kernelImageSha256, expected.sha256, 'Actual owned Root differs'); }
function reportContract(role, p) {
  const family = ROLES[role], reports = Object.fromEntries(Object.entries(p.reports).map(([n, e]) => [n, embedded(e, p.members)]));
  const r = reports.session; for (const r of Object.values(reports)) noFailure(r);
  if (family !== 'flatpak') assert.equal(r.harnessSource, p.sourceCommit); flags(r);
  if (family === 'incoming') {
    keys(reports, ['session']); assert.equal(r.scenario, role);
    assert.equal(r.assembly.sourceCommit, SOURCE); assert.equal(r.assembly.sourceTree, TREE); assert.equal(r.assembly.runId, PRODUCERS.assembly.runId);
    assert.equal(r.assembly.artifactId, PRODUCERS.assembly.artifactId); assert.equal(r.assembly.jobId, PRODUCERS.assembly.jobId);
    for (const n of ['directPagesObserved', 'manualReopenObserved', 'preservationAccepted']) assert.equal(r[n], true);
    assert.equal(r.freshInstallAccepted, role === 'fresh16'); assert.equal(r.manualPublic012UpgradeAccepted, role === 'public012-to16');
    for (const s of [r.first16, r.reopened16]) {
      root(s.root); assert.equal(s.visibleVersion, '0.1.16'); assert.equal(s.normalCloseObserved, true); assert.equal(s.bitmap.nonblank, true);
    }
    assert.notEqual(r.first16.root.pid, r.reopened16.root.pid);
    for (const n of ['protectedAfterInstall16', 'protectedAfterFirst', 'protectedAfterReopen', 'firstReadJournal', 'reopenedReadJournal']) assert.ok(r[n] && typeof r[n] === 'object');
    if (role === 'public012-to16') { assert.equal(r.old012.visibleVersion, '0.1.12'); assert.equal(r.old012.normalCloseObserved, true); assert.ok(r.protectedAfter012); }
  } else if (family === 'migration') {
    keys(reports, ['session', 'broker', 'binding']); const b = reports.broker;
    assert.equal(r.scenario, role); assert.equal(r.scenarioPassed, true); assert.equal(r.normalReopenObserved, true);
    assert.equal(b.scenario, role); assert.equal(b.harnessSource, p.sourceCommit); assert.equal(b.scenarioPassed, true); assert.equal(b.fixtureRelocked, true);
    assert.equal(b.scope, 'production-016-disposable-migration'); assert.equal(b.inputProofs === 0, role === 'migration-guide-cancel');
    const binding = reports.binding; assert.equal(binding.profile.assembly.sourceCommit, SOURCE); assert.equal(binding.profile.assembly.sourceTree, TREE);
    assert.deepEqual(binding.profile.pins.deb, DEB); assert.deepEqual(binding.profile.pins.hub, ROOT);
    assert.equal(r.bindingSha256, p.members[p.reports.binding.member].sha256);
    for (const s of [r.first, r.reopened]) { root(s.root); assert.equal(s.normalCloseObserved, true); }
    assert.notEqual(r.first.root.pid, r.reopened.root.pid);
    for (const n of ['oldRuntimeAfterMigration', 'oldRuntimeAfterClose', 'oldRuntimeAfterReopen', 'operationJournals']) assert.ok(r[n]);
  } else if (family === 'update') {
    keys(reports, ['session', 'broker', 'profile', 'transport']); const b = reports.broker;
    for (const v of [r, b]) {
      assert.equal(v.scenario, role); assert.equal(v.profile, 'production016-private017-native-update'); assert.equal(v.scenarioPassed, true);
      assert.equal(v.harnessSource, p.sourceCommit);
      assert.deepEqual(v.privateTargetQualification, { scope: 'private-source75-updater-lifecycle-only', targetSource: PRIVATE17,
        targetRetirementHelper: { size: 1167744, sha256: '501e97da9c93d370caa750c46f4c3f272d546281e8e2eeedfaf4f01193d644be' },
        privateDebApprovalRestoresOldRetirementHelper: true, final016HelperFixRetained: false,
        targetFixNativeAcceptance: false, futurePublic017Qualified: false, releaseReady: false }); flags(v);
    }
    assert.equal(reports.profile.baseline.source, SOURCE); assert.deepEqual(reports.profile.baseline.deb, DEB); assert.deepEqual(reports.profile.baseline.hub, ROOT);
    assert.equal(reports.profile.baseline.artifact, PRODUCERS.assembly.artifactId); assert.equal(r.fromSource, SOURCE); assert.equal(r.toSource, PRIVATE17);
    assert.equal(b.baselineSource, SOURCE); assert.equal(b.targetSource, PRIVATE17); assert.equal(b.fixtureRelocked, true);
    assert.deepEqual(b.tlsCleanup, { temporaryCertificateRemoved: true, originalTrustRestored: true });
    for (const n of ['initial16Verified', 'nativeConfirmationObserved', 'settingsPreserved', 'runtimeSurvived', 'normalFinalClose']) assert.equal(r[n], true);
    root(r.initialRoot); assert.equal(r.initialBitmap.nonblank, true);
    assert.deepEqual(r.privateTargetQualification, b.privateTargetQualification);
    assert.equal(r.oldRetirementHelperRestored, role === 'deb-approve'); assert.equal(b.oldRetirementHelperRestored, role === 'deb-approve');
    const t = reports.transport; assert.equal(t.closeReason, 'caller'); assert.equal(t.rejectedRequestCount, 0);
    assert.equal(t.fromVersion, '0.1.16'); assert.equal(t.targetVersion, '0.1.17'); assert.equal(t.publicDiscovery, false); flags(t); assert.ok(t.requests.length > 0);
    if (role.endsWith('native-cancel') || role === 'deb-auth-cancel') {
      assert.deepEqual(r.nativeActions, [role.endsWith('native-cancel') ? 'Not now' : 'Update Hub']);
      assert.deepEqual(r.systemActions, role === 'deb-auth-cancel' ? ['Cancel'] : []);
      assert.equal(r.oldSelectionUnchanged, true); assert.equal(r.initialRootSurvived, true); assert.equal(r.automaticSuccessor, null);
      if (role === 'deb-auth-cancel') assert.equal(r.sealed17Observed, true);
    } else {
      assert.deepEqual(r.nativeActions, ['Update Hub']); assert.deepEqual(r.systemActions, role === 'deb-approve' ? ['Authenticate'] : []);
      for (const n of ['oldNormalExit', 'automaticRestartObserved', 'installed17Verified', 'fresh17UiVersion', 'directPagesObserved']) assert.equal(r[n], true);
      assert.ok(r.automaticSuccessor && r.automaticSuccessor.pid !== r.initialRoot.pid); assert.equal(r.successorBitmap.nonblank, true);
    }
  } else {
    keys(reports, ['session', 'final', 'review', 'profile', 'transport']);
    assert.equal(r.profile, 'production-flatpak-host-016'); assert.equal(r.phase, 'complete');
    for (const n of ['candidateExecuted', 'flatpakInstalled', 'disclosureCancelAccepted', 'missingHostAccepted', 'portalCaptureAccepted',
      'setupCancelAccepted', 'bootstrapAccepted', 'coldActivationAccepted', 'warmActivationAccepted', 'settingsPreserved', 'normalCloseObserved']) assert.equal(r[n], true);
    assert.deepEqual(reports.final, { ...r, tlsCleanupVerified: true });
    const profile = native.validateProfile(reports.profile); assert.equal(profile.portable.sourceCommit, SOURCE); assert.equal(profile.portable.sourceTree, TREE);
    assert.equal(profile.portable.runId, PRODUCERS.portable.runId); root(r.coldRoot, { sha256: reports.review.portable.root.sha256 });
    assert.equal(reports.review.signaturesVerified, true); assert.equal(reports.review.runtimeEnabled, false);
    assert.equal(reports.transport.closeReason, 'caller'); assert.equal(reports.transport.rejectedRequestCount, 0);
  }
  return reports;
}
function proof(p, reportNames) {
  keys(p, ['runId', 'runAttempt', 'sourceCommit', 'sourceTree', 'jobId', 'artifact', 'members', 'reports']);
  for (const n of ['runId', 'runAttempt', 'jobId']) id(p[n]); sha(p.sourceCommit, 40); sha(p.sourceTree, 40);
  keys(p.artifact, ['id', 'name', 'size', 'sha256']); id(p.artifact.id); pin({ size: p.artifact.size, sha256: p.artifact.sha256 });
  assert.ok(typeof p.artifact.name === 'string' && p.artifact.name.length > 0 && p.artifact.name.length <= 256);
  assert.ok(Object.keys(p.members).length > 0 && Object.keys(p.members).length <= 1024);
  const names = new Set(); let total = 0;
  for (const [n, v] of Object.entries(p.members)) { member(n); pin(v, 768 * 1024 ** 2, true); assert.ok(!names.has(n.toLowerCase()), 'Aliased ZIP member'); names.add(n.toLowerCase()); total += v.size; }
  assert.ok(total <= 1024 ** 3); keys(p.reports, reportNames);
  for (const r of Object.values(p.reports)) embedded(r, p.members);
}
function assetNames() { return [...ASSETS]; }
function validateQualificationStructure(v) {
  keys(v, ['schemaVersion', 'kind', 'repository', 'version', 'platform', 'authorization', 'releaseReady', 'publicAcceptance',
    'sourceCommit', 'sourceTree', 'producers', 'proofs', 'portableEligibility', 'draft', 'windows']);
  assert.equal(v.schemaVersion, 1); assert.equal(v.kind, 'linux-016-qualified-draft'); assert.equal(v.repository, REPO);
  assert.equal(v.version, '0.1.16'); assert.equal(v.platform, 'linux-x86_64'); assert.equal(v.authorization, 'publish-qualified-draft-only');
  assert.equal(v.releaseReady, false); assert.equal(v.publicAcceptance, false); assert.equal(v.sourceCommit, SOURCE); assert.equal(v.sourceTree, TREE);
  keys(v.producers, Object.keys(PRODUCERS));
  for (const [name, p] of Object.entries(v.producers)) {
    proof(p, []); const f = PRODUCERS[name];
    for (const n of ['runId', 'sourceCommit', 'sourceTree']) assert.equal(p[n], f[n]); assert.equal(p.runAttempt, 1);
    if (f.jobId) assert.equal(p.jobId, f.jobId);
    assert.equal(p.artifact.id, f.artifactId); assert.equal(p.artifact.size, f.size); assert.equal(p.artifact.sha256, f.sha256);
  }
  keys(v.proofs, Object.keys(ROLES));
  for (const [role, p] of Object.entries(v.proofs)) {
    const family = ROLES[role];
    proof(p, { incoming: ['session'], migration: ['session', 'broker', 'binding'], update: ['session', 'broker', 'profile', 'transport'],
      flatpak: ['session', 'final', 'review', 'profile', 'transport'] }[family]); reportContract(role, p);
  }
  const fp = reportContract('flatpak', v.proofs.flatpak), pp = fp.profile.portable;
  for (const [n, expected] of Object.entries({ packagingCommit: PRODUCERS.portable.sourceCommit, packagingTree: PRODUCERS.portable.sourceTree,
    jobId: PRODUCERS.portable.jobId, artifactId: PRODUCERS.portable.artifactId })) assert.equal(pp[n], expected);
  assert.deepEqual(pp.zip, { size: PRODUCERS.portable.size, sha256: PRODUCERS.portable.sha256 });
  for (const [name, p] of Object.entries(pp.files)) assert.deepEqual(p, v.producers.portable.members[name], 'Flatpak bootstrap must use the exact original portable producer members');
  assert.equal(fp.session.coldRoot.kernelImageSha256, v.portableEligibility.executableSha256);
  keys(v.draft, ['id', 'assets']); id(v.draft.id); assert.notEqual(v.draft.id, 411494394, 'Never publish validation draft'); keys(v.draft.assets, ASSETS);
  const ids = new Set();
  for (const p of Object.values(v.draft.assets)) {
    keys(p, ['id', 'size', 'sha256']); id(p.id); pin({ size: p.size, sha256: p.sha256 }); assert.ok(!ids.has(p.id)); ids.add(p.id);
  }
  for (const [name, p] of Object.entries(v.draft.assets)) {
    if (/\.(?:sig|minisig)$/.test(name)) assert.ok(p.size <= 4096, 'Bounded detached signature required');
    if ([feed.CATALOG, feed.PORTABLE, 'latest.json'].includes(name)) assert.ok(p.size <= 128 * 1024, 'Bounded public metadata required');
    if (name === 'SHA256SUMS.txt') assert.ok(p.size <= 8192, 'Bounded checksum closure required');
  }
  for (const [n, p] of [[NAMES.deb, DEB], [NAMES.tar, TAR], [NAMES.image, IMAGE], [NAMES.alias, IMAGE],
    [NAMES.manifest, MANIFEST], [NAMES.flatpak, native.FIXED.files[NAMES.flatpak]]]) {
    assert.deepEqual({ size: v.draft.assets[n].size, sha256: v.draft.assets[n].sha256 }, p, 'Frozen product asset differs');
  }
  assert.equal(v.windows.tag, 'v0.1.14'); id(v.windows.id); assert.notEqual(v.draft.id, v.windows.id, 'Never publish through the Windows release ID');
  assert.ok(Array.isArray(v.windows.assets) && v.windows.assets.length > 0);
  for (const a of v.windows.assets) { id(a.id); id(a.size); assert.match(a.digest, /^sha256:[a-f0-9]{64}$/); }
  // Structure alone is not acceptance; validateQualification binds these claims below.
  assert.equal(v.portableEligibility.approvedForStable, true); keys(v.portableEligibility.checks, portable.CHECKS);
  for (const n of portable.CHECKS) assert.equal(v.portableEligibility.checks[n], true, 'Missing documented portable acceptance');
  return v;
}
function derivePortableEvidence(v) {
  const roles = ['portable-native-cancel', 'portable-approve', 'flatpak'];
  const reports = Object.fromEntries(roles.map(role => [role, reportContract(role, v.proofs[role])]));
  const cancel = reports['portable-native-cancel'].session, approve = reports['portable-approve'].session;
  const flatpak = reports.flatpak;
  // No original report establishes the remaining checks. In particular, an
  // unrelated EOF-only process surviving is not proof of a live MCP connection.
  const checks = Object.fromEntries(portable.CHECKS.map(name => [name, null]));
  Object.assign(checks, {
    installCancelReadOnly: cancel.oldSelectionUnchanged === true && cancel.initialRootSurvived === true
      && cancel.automaticSuccessor === null,
    signedPackageVerified: flatpak.review.signaturesVerified === true,
    automaticRestart: approve.automaticRestartObserved === true,
    selectedImageVerified: approve.installed17Verified === true && approve.fresh17UiVersion === true,
    settingsPreserved: cancel.settingsPreserved === true && approve.settingsPreserved === true && flatpak.session.settingsPreserved === true,
    normalNewExit: approve.normalFinalClose === true,
  });
  return { evidence: roles.map(role => {
    id(v.proofs[role].runId);
    return `https://github.com/${REPO}/actions/runs/${v.proofs[role].runId}`;
  }), checks, unqualified: portable.CHECKS.filter(name => checks[name] !== true) };
}
function validateQualification(v) {
  validateQualificationStructure(v);
  const derived = derivePortableEvidence(v);
  assert.ok(Array.isArray(v.portableEligibility.evidence), 'Portable evidence run URLs required');
  assert.deepEqual([...v.portableEligibility.evidence].sort(), [...derived.evidence].sort(),
    'Portable evidence run URLs must match the exact original relevant proofs');
  assert.equal(derived.unqualified.length, 0, 'Unqualified portable checks: ' + derived.unqualified.join(', '));
  assert.deepEqual(v.portableEligibility.checks, derived.checks, 'Portable checks differ from original proof outcomes');
  return v;
}
function canonical(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 32 * 1024 ** 2);
  const v = json(bytes); assert.ok(bytes.equals(Buffer.from(JSON.stringify(v) + '\n')) || bytes.equals(Buffer.from(JSON.stringify(v, null, 2) + '\n')), 'Canonical reviewed JSON required'); return v;
}
function fileIdentity(s) {
  // Access time can change because this reader opened the file; it is not content identity.
  return ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].map(k => s[k]);
}
function loadQualification(file, expectedHash) {
  sha(expectedHash); const before = fs.lstatSync(file, { bigint: true });
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size <= 32n * 1024n ** 2n);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    assert.deepEqual(fileIdentity(fs.fstatSync(fd, { bigint: true })), fileIdentity(before));
    const bytes = fs.readFileSync(fd); assert.equal(hash(bytes), expectedHash);
    assert.deepEqual(fileIdentity(fs.fstatSync(fd, { bigint: true })), fileIdentity(before));
    assert.deepEqual(fileIdentity(fs.lstatSync(file, { bigint: true })), fileIdentity(before));
    return validateQualification(canonical(bytes));
  } finally { fs.closeSync(fd); }
}
function verifySignature(body, signature) {
  // Minisign ED framing matches pinned minisign-verify 0.2.5; OpenSSL owns both cryptographic primitives.
  assert.ok(Buffer.isBuffer(body) && body.length > 0 && body.length <= 256 * 1024 ** 2 && Buffer.isBuffer(signature) && signature.length <= 4096);
  const lines = new TextDecoder('utf-8', { fatal: true }).decode(signature).trimEnd().split(/\r?\n/);
  assert.equal(lines.length, 4); assert.ok(lines[0].startsWith('untrusted comment: ') && lines[2].startsWith('trusted comment: '));
  const decode = (s, length) => { const b = Buffer.from(s, 'base64'); assert.equal(b.length, length); assert.equal(b.toString('base64'), s); return b; };
  const key = decode(PUBLIC_KEY, 42), packet = decode(lines[1], 74), global = decode(lines[3], 64);
  assert.equal(packet.subarray(0, 2).toString(), 'ED', 'Legacy/unknown Minisign algorithm refused'); assert.ok(packet.subarray(2, 10).equals(key.subarray(2, 10)));
  const publicKey = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.subarray(10)]), format: 'der', type: 'spki' });
  assert.equal(crypto.verify(null, crypto.createHash('blake2b512').update(body).digest(), publicKey, packet.subarray(10)), true, 'Production signature refused');
  assert.equal(crypto.verify(null, Buffer.concat([packet.subarray(10), Buffer.from(lines[2].slice(17))]), publicKey, global), true, 'Trusted comment signature refused');
}
function verifyAssets(v, bodies) {
  keys(bodies, ASSETS);
  for (const n of ASSETS) bound(bodies[n], v.draft.assets[n]);
  for (const [body, sig] of [[NAMES.deb, NAMES.deb + '.sig'], [feed.CATALOG, feed.CATALOG + '.minisig'],
    [feed.PORTABLE, feed.PORTABLE + '.minisig'], [NAMES.manifest, NAMES.manifest + '.minisig']]) verifySignature(bodies[body], bodies[sig]);
  return verifyDocuments(v, bodies);
}
function verifyDocuments(v, bodies) {
  const catalog = canonical(bodies[feed.CATALOG]);
  if (catalog.minHubVersion !== undefined) { assert.match(catalog.minHubVersion, /^0\.1\.(?:0|[1-9][0-9]*)$/); assert.ok(Number(catalog.minHubVersion.slice(4)) <= 16); }
  const { minHubVersion, ...catalogBody } = catalog;
  assert.deepEqual(catalogBody, { schemaVersion: 1, appId: 'creator-hub', version: '0.1.16', platform: 'linux', architecture: 'x86_64',
    packageType: 'deb', assetName: NAMES.deb, byteLength: DEB.size, sha256: DEB.sha256, executableSha256: ROOT.sha256,
    identityProtocol: 0, lifecycleProtocol: 0, installerProtocol: 1 });
  const latest = canonical(bodies['latest.json']); assert.equal(latest.version, '0.1.16');
  assert.deepEqual(latest.platforms, { 'linux-x86_64-deb': { url: `https://github.com/${REPO}/releases/download/v0.1.16/${NAMES.deb}`, signature: bodies[NAMES.deb + '.sig'].toString('base64') } });
  const descriptor = portable.descriptor(bodies[NAMES.manifest], { byteLength: TAR.size, sha256: TAR.sha256 }, v.portableEligibility);
  assert.deepEqual(canonical(bodies[feed.PORTABLE]), descriptor); assert.equal(v.portableEligibility.sourceCommit, SOURCE); assert.equal(v.portableEligibility.sourceTree, TREE);
  assert.equal(bodies['SHA256SUMS.txt'].toString('utf8'), ASSETS.filter(n => n !== 'SHA256SUMS.txt').sort().map(n => `${v.draft.assets[n].sha256}  ${n}\n`).join(''));
  return { signaturesVerified: true, ready: false };
}
// No extraction and no candidate execution: stdlib ZIP decoder hashes complete original inventories.
const ZIP_READER = String.raw`import base64,hashlib,io,json,stat,sys,zipfile
raw=sys.stdin.buffer.read(768*1024**2+1); assert len(raw)<=768*1024**2
rows={}; names=set(); total=0
with zipfile.ZipFile(io.BytesIO(raw)) as z:
 assert len(z.infolist())<=1024
 for e in z.infolist():
  n=e.filename; mode=e.external_attr>>16
  assert n and len(n)<=256 and not any(ord(c)<32 or ord(c)==127 or c in '\\:' for c in n)
  assert all(p and p not in ('.','..') for p in n.split('/'))
  assert n.lower() not in names; names.add(n.lower())
  assert not e.is_dir() and not e.flag_bits&1 and e.compress_type in (0,8)
  assert stat.S_IFMT(mode) in (0,stat.S_IFREG) and not mode&0o7000 and 0<=e.file_size<=768*1024**2
  total+=e.file_size; assert total<=1024**3
  h=hashlib.sha256(); size=0
  with z.open(e) as s:
   while True:
    b=s.read(65536)
    if not b: break
    size+=len(b); assert size<=e.file_size; h.update(b)
  assert size==e.file_size; rows[n]={'size':size,'sha256':h.hexdigest()}
print(json.dumps(rows,separators=(',',':')))`;
function inspectArchive(bytes, execute = execFileSync) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length <= 768 * 1024 ** 2);
  return json(execute(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', '-c', ZIP_READER],
    { input: bytes, timeout: 180000, maxBuffer: 2 * 1024 ** 2, windowsHide: true, stdio: 'pipe' }));
}
function services(overrides = {}) {
  const execute = execFileSync;
  return { request: async route => json(execute('gh', ['api', '--hostname', 'github.com', `repos/${REPO}/${route}`],
    { timeout: 30000, maxBuffer: 2 * 1024 ** 2, windowsHide: true })),
  download: async (route, maximum) => execute('gh', ['api', '--hostname', 'github.com', `repos/${REPO}/${route}`, '-H',
    `Accept: ${route.startsWith('releases/assets/') ? 'application/octet-stream' : 'application/json'}`], { timeout: 180000, maxBuffer: maximum, windowsHide: true }),
  inspectArchive, readFeed: feed.readLiveFeed, ...overrides };
}
async function verifyProof(p, workflow, jobName, io) {
  const r = await io.request(`actions/runs/${p.runId}`), c = await io.request(`git/commits/${p.sourceCommit}`);
  assert.equal(r.id, p.runId); assert.equal(r.run_attempt, p.runAttempt); assert.equal(r.head_sha, p.sourceCommit);
  assert.equal(r.path, '.github/workflows/' + workflow); assert.equal(r.event, 'workflow_dispatch'); assert.equal(r.status, 'completed'); assert.equal(r.conclusion, 'success');
  for (const repo of [r.repository, r.head_repository]) { assert.equal(repo.id, REPO_ID); assert.equal(repo.full_name, REPO); }
  assert.equal(c.sha, p.sourceCommit); assert.equal(c.tree.sha, p.sourceTree);
  const j = await io.request(`actions/jobs/${p.jobId}`);
  for (const [k, x] of Object.entries({ id: p.jobId, run_id: p.runId, run_attempt: p.runAttempt, head_sha: p.sourceCommit, status: 'completed', conclusion: 'success' })) assert.equal(j[k], x);
  if (jobName) assert.equal(j.name, jobName); assert.ok(j.labels.includes('ubuntu-22.04'));
  const a = await io.request(`actions/artifacts/${p.artifact.id}`);
  for (const [k, x] of Object.entries({ id: p.artifact.id, name: p.artifact.name, expired: false, size_in_bytes: p.artifact.size, digest: 'sha256:' + p.artifact.sha256 })) assert.equal(a[k], x);
  for (const [k, x] of Object.entries({ id: p.runId, head_sha: p.sourceCommit, repository_id: REPO_ID, head_repository_id: REPO_ID })) assert.equal(a.workflow_run[k], x);
  const times = [j.started_at, a.created_at, j.completed_at].map(Date.parse); assert.ok(times.every(Number.isFinite) && times[0] <= times[1] && times[1] <= times[2]);
  const raw = bound(await io.download(`actions/artifacts/${p.artifact.id}/zip`, p.artifact.size + 1), p.artifact);
  assert.deepEqual(await io.inspectArchive(raw), p.members, 'Complete original ZIP inventory differs');
}
async function verifyDraft(v, io) {
  const draft = await io.request(`releases/${v.draft.id}`);
  assert.equal(draft.id, v.draft.id); assert.equal(draft.draft, true); feed.linuxAssets(draft, v.draft.assets);
  const bodies = {};
  for (const n of ASSETS) bodies[n] = bound(await io.download(`releases/assets/${v.draft.assets[n].id}`, v.draft.assets[n].size + 1), v.draft.assets[n]);
  verifyAssets(v, bodies); return draft;
}
async function verifyRemote(value, overrides = {}) {
  const v = validateQualification(value), io = services(overrides);
  const rootPath = path.resolve(__dirname, '..'); checkSources(rootPath, JSON.parse(fs.readFileSync(path.join(rootPath, 'modules/suite.json'), 'utf8')));
  for (const [name, p] of Object.entries(v.producers)) await verifyProof(p, PRODUCERS[name].workflow, name === 'assembly' ? null : 'package', io);
  for (const [role, p] of Object.entries(v.proofs)) {
    const family = ROLES[role]; await verifyProof(p, `native-linux-production-016-${family}.yml`, family === 'flatpak' ? 'bootstrap' : family, io);
  }
  return { draft: await verifyDraft(v, io), ready: false, publicAcceptance: false };
}
module.exports = { REPO, REPO_ID, SOURCE, TREE, PUBLIC_KEY, ROOT, DEB, TAR, IMAGE, PRIVATE17, NAMES, ROLES, PRODUCERS,
  assetNames, hash, bound, canonical, embedded, proof, reportContract, validateQualificationStructure, derivePortableEvidence, validateQualification, loadQualification,
  verifySignature, verifyAssets, verifyDocuments, ZIP_READER, inspectArchive, services, verifyProof, verifyDraft, verifyRemote };
