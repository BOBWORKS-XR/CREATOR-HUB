'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const profile = require('./windows-release-target.cjs');
// Retain the original R8 refusal tests without selecting R8 in production.
test.mock.method(profile, 'getTarget', () => require('./fixtures/windows-release-target-018.cjs'));
const q = require('./windows-016-release-qualification.cjs');
test('historical R8 fixture pins its distinct CI and actual verified successor19', () => {
  const target = profile.requireSource();
  assert.equal(target.version, '0.1.18'); assert.equal(target.successor, '0.1.19'); assert.equal(target.minimumHub, '0.1.12');
  assert.deepEqual(target.source, { commit: '930a2886b6872a08a4a25be4738a5a01a4e911d2', tree: 'a1af9bf6c56b221352f8b3feb1fd65259200e9dc' });
  assert.equal(target.parent, '032bb101823fcfff1c5b85f863bb7381db8285e4');
  assert.equal(target.sourceCi.runId, 41718350946); assert.equal(target.sourceCi.expectedTests, 316);
  assert.equal(target.rootBuild.receiptSha256, 'c83dec8051be90c7b1017b0cc2746e43f94a5ea5c8c9e326d99248fb5187dacb');
  assert.notEqual(target.sourceCi.harnessCommit, target.source.commit);
  assert.equal(target.runtime.verificationReceiptSha256, '4e2e33bb0eb31dc20182105e02a454cac50c93a5e847974889258357b990c00e');
  assert.equal(target.successorEvidence.sourceCommit, 'b6c806254746563e81a6715231d7ef6dfa081fc1');
  assert.ok(Object.isFrozen(target));
  assert.equal(q.FINAL_ASSETS[0], 'Creator.Hub_0.1.18_x64-setup.exe');
});
test('retired16 and17 publishers refuse before any readiness or remote operation', async () => {
  for (const version of ['0.1.16', '0.1.17']) {
    let calls = 0;
    await assert.rejects(require('./publish-hub-draft.cjs').publishDraft(version,
      { checkReadiness: () => { calls++; } }, { platform: 'windows-x86_64' }), /superseded/);
    assert.equal(calls, 0);
  }
});
test('previous test18 fixture cannot be requalified by the final18 pipeline', () => {
  assert.throws(() => q.verifyOutgoing18Recovery('never-read.json', q.OUTGOING18_RECOVERY.receipt), /superseded/);
  assert.throws(() => q.validateSourceCi({ scope: 'final-source', runId: 1, runAttempt: 1, workflow: '.github/workflows/ci.yml',
    sourceCommit: 'ec7f1d218c187caac30d0170aaaca2dfcdf83766', sourceTree: q.R6_SOURCE.tree, jobs: [{ id: 2, name: 'old' }] },
  { sourceCommit: q.FINAL_SOURCE.commit, sourceTree: q.FINAL_SOURCE.tree }));
});
test('new source-CI capture does not use predecessor IDs', async () => {
  let calls = 0;
  await assert.rejects(q.captureSourceCi({ request: async () => { throw Error('Unexpected request'); }, download: async route => {
    calls++; assert.equal(route, 'actions/artifacts/13270513189/zip'); throw Error('Stopped before transport');
  } }), /Stopped before transport/);
  assert.equal(calls, 1);
});
test('split production lanes retain legacy combined and every outgoing gate', () => {
  for (const role of ['combined', 'combined-owned', 'combined-custom', 'migration', 'mcp-restore', 'setup-restore', 'setup-no-restore'])
    assert.ok(q.FINAL_ROLES.includes(role));
  const lanes = profile.getTarget().productionLanes;
  q.checkNativeLane('fresh', { ...lanes.incoming, jobName: 'incoming (fresh, 0.1.12)' });
  q.checkNativeLane('incoming012', { ...lanes.incoming, jobName: 'incoming (incoming12, 0.1.12)' });
  q.checkNativeLane('incoming014', { ...lanes.incoming, jobName: 'incoming (incoming14, 0.1.14)' });
  q.checkNativeLane('combined-custom', { ...lanes.custom, jobName: 'incoming-migration (setup-owned-codex-unverified-server)' });
  assert.throws(() => q.checkNativeLane('combined-custom', { ...lanes.incoming, jobName: 'incoming-migration (setup-owned-codex-unverified-server)' }));
  assert.throws(() => q.checkNativeLane('incoming012', { ...lanes.incoming, jobName: 'incoming (incoming14)' }));
  q.checkNativeLane('combined', { ...lanes.standard, jobName: 'incoming-migration (legacy)' });
  q.checkNativeLane('combined-owned', { ...lanes.standard, jobName: 'incoming-migration (setup-owned-codex)' });
  assert.throws(() => q.checkNativeLane('combined', { ...lanes.incoming, jobName: 'incoming-migration (legacy)' }));
  q.checkNativeLane('mcp-restore', { ...lanes.outgoing, jobName: q.FINAL_JOB_NAMES['mcp-restore'] });
  assert.throws(() => q.checkNativeLane('mcp-restore', { ...lanes.standard, jobName: q.FINAL_JOB_NAMES['mcp-restore'] }));
});
test('all eleven exact GitHub matrix names reject truncated, swapped and altered names', () => {
  const names = {
    fresh: 'incoming (fresh, 0.1.12)', incoming012: 'incoming (incoming12, 0.1.12)', incoming014: 'incoming (incoming14, 0.1.14)',
    guarded: 'install (guarded)', migration: 'incoming-migration (legacy)', combined: 'incoming-migration (legacy)',
    'combined-owned': 'incoming-migration (setup-owned-codex)', 'combined-custom': 'incoming-migration (setup-owned-codex-unverified-server)',
    'mcp-restore': 'acceptance (mcp-restore, mcp, true)', 'setup-restore': 'acceptance (setup-restore, setup, true)',
    'setup-no-restore': 'acceptance (setup-no-restore, setup, false)',
  };
  assert.deepEqual(q.FINAL_JOB_NAMES, names);
  const lanes = profile.getTarget().productionLanes;
  for (const [role, name] of Object.entries(names)) {
    const lane = role.includes('-restore') ? lanes.outgoing : role === 'fresh' || role.startsWith('incoming') ? lanes.incoming
      : role === 'combined-custom' ? lanes.custom : lanes.standard;
    q.checkNativeLane(role, { ...lane, jobName: name });
    for (const jobName of [name + ' ', name.replace(/, 0\.1\.\d+/, ''), names.guarded]) {
      if (jobName !== name) assert.throws(() => q.checkNativeLane(role, { ...lane, jobName }));
    }
  }
});
test('local restart hashes and counts cannot claim private migration completion or reuse after-install proof', () => {
  const t = profile.getTarget();
  const c = { sourceCommit: t.source.commit, sourceTree: t.source.tree, executableSha256: t.rootBuild.executableSha256 };
  const value = { normalRestart: { receiptSha256: t.localRestart.receiptSha256, passed: true, projectCount: 30,
    settingsAndPhaseFiles: 4, configuredClients: 3, rootSourceCommit: c.sourceCommit, installedRootSha256: c.executableSha256, retainedMigrationCompleted: false },
  sdkAfterRestart: { receiptSha256: t.localRestart.sdkReceiptSha256, componentSourceCommit: t.rootBuild.reusedSourceCommit,
    referenceSuccess: true, settingsUnchanged: true }, productionApproval: false, releaseReady: false };
  q.validateLocalRestartEvidence(value, c);
  for (const mutate of [v => { v.normalRestart.retainedMigrationCompleted = true; },
    v => { v.normalRestart.receiptSha256 = t.realCodex.receiptSha256; }, v => { v.normalRestart.projectCount = 28; },
    v => { v.sdkAfterRestart.componentSourceCommit = c.sourceCommit; }, v => { v.privateSettings = {}; }]) {
    const changed = structuredClone(value); mutate(changed); assert.throws(() => q.validateLocalRestartEvidence(changed, c));
  }
});
const real = profile.getTarget();
function buildFixture(t, mutate = () => {}) {
  const crypto = require('node:crypto'), hash = b => crypto.createHash('sha256').update(b).digest('hex');
  const fields = { sourceCommit: real.source.commit, sourceTree: real.source.tree,
    reusedSourceCommit: real.rootBuild.reusedSourceCommit, reusedSourceTree: real.rootBuild.reusedSourceTree,
    sourceReceipt: { sha256: real.rootBuild.sourceReceiptSha256 }, rawSourceUnchanged: false,
    rawSourceChanges: [...real.rootBuild.generatedSchemas], generatedSchemaChanges: [...real.rootBuild.generatedSchemas],
    compilerInputsUnchanged: true, frozenSourceUnchanged: true, reusedR7InputsUnchanged: true,
    inputInventorySha256: real.rootBuild.inputSha256, afterInventorySha256: real.rootBuild.afterSha256,
    managedSignaturesRegenerated: false, outerSignaturesGenerated: false, nativeGuiAccepted: false,
    migrationAccepted: false, signedUpdateAccepted: false, published: false, releaseReady: false };
  const original = { ...fields, status: 1, phase: 'root-tauri-nsis', error: 'Nonregular or oversized input' };
  const originalBytes = Buffer.from(JSON.stringify(original));
  const result = { ...fields, status: 0, kind: real.rootBuild.kind,
    originalBuildResult: { status: 1, sha256: hash(originalBytes) },
    installerSha256: real.rootBuild.installerSha256, executableSha256: real.rootBuild.executableSha256,
    managedManifestSha256: real.rootBuild.manifestSha256, runtimeDescriptorSha256: real.rootBuild.runtimeSha256,
    moduleFilesChecked: 15, rootPe: { FileVersion: '0.1.18', ProductVersion: '0.1.18' }, installerPreflight: { exitCode: 10 } };
  mutate(result);
  const bytes = Buffer.from(JSON.stringify(result));
  t.mock.method(profile, 'getTarget', () => ({ ...real, rootBuild: { ...real.rootBuild,
    receiptSha256: hash(bytes), originalSha256: hash(originalBytes) } }));
  return { bytes, originalBytes, candidate: { sourceCommit: real.source.commit, sourceTree: real.source.tree,
    installerSha256: real.rootBuild.installerSha256, executableSha256: real.rootBuild.executableSha256 } };
}
test('typed post-build validation preserves failure and raw schema changes without generic success promotion', t => {
  const f = buildFixture(t);
  const result = profile.validateBuildRecord(f.bytes, f.candidate, f.originalBytes);
  assert.equal(result.rawSourceUnchanged, false); assert.equal(result.originalBuildResult.status, 1);
  assert.throws(() => profile.validateBuildRecord(f.bytes, f.candidate), /must remain attached/);
  assert.throws(() => profile.validateBuildRecord(Buffer.from('{}'), f.candidate, f.originalBytes));
});
test('native provenance uses the exact Root-only record, never an invented unchanged flag', t => {
  const f = buildFixture(t), result = JSON.parse(f.bytes), original = JSON.parse(f.originalBytes);
  const names = ['kind', 'sourceCommit', 'sourceTree', 'reusedSourceCommit', 'reusedSourceTree', 'rawSourceUnchanged',
    'rawSourceChanges', 'generatedSchemaChanges', 'compilerInputsUnchanged', 'frozenSourceUnchanged', 'reusedR7InputsUnchanged',
    'sourceReceipt', 'inputInventorySha256', 'afterInventorySha256', 'exception', 'aliases', 'verifierSha256', 'finalizerSha256'];
  const projection = Object.fromEntries(names.map(name => [name, result[name]]));
  projection.originalBuildResult = { ...result.originalBuildResult, receipt: original };
  const doc = (member, bytes) => ({ member, size: bytes.length,
    sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') });
  const candidate = { ...f.candidate, buildResult: doc('build.json', f.bytes), originalBuildResult: doc('original.json', f.originalBytes) };
  const report = { compilerInputsUnchanged: true, rawSourceUnchanged: false, rootOnlyAssembly: projection };
  q.checkReportSource(report, candidate);
  assert.throws(() => q.checkReportSource({ ...report, sourceUnchanged: true }, candidate));
  assert.throws(() => q.checkReportSource({ ...report, rawSourceUnchanged: true }, candidate));
  const changed = structuredClone(report); changed.rootOnlyAssembly.originalBuildResult.status = 0;
  assert.throws(() => q.checkReportSource(changed, candidate));
});
for (const [name, change] of [
  ['raw true promotion', r => { r.rawSourceUnchanged = true; }],
  ['extra source change', r => { r.rawSourceChanges = ['src-tauri/src/convergence.rs']; }],
  ['compiler drift', r => { r.compilerInputsUnchanged = false; }],
  ['failure relabel', r => { r.originalBuildResult.status = 0; }],
  ['new runtime signature', r => { r.managedSignaturesRegenerated = true; }],
  ['wrong PE', r => { r.rootPe.ProductVersion = '0.1.17'; }],
]) test('typed post-build validation rejects ' + name, t => {
  const f = buildFixture(t, change);
  assert.throws(() => profile.validateBuildRecord(f.bytes, f.candidate, f.originalBytes));
});
test('final receipt keeps the private blocked migration explicitly unresolved', () => {
  const known = structuredClone(real.privateMigrationLimitation);
  profile.validatePrivateMigrationLimitation(known);
  for (const change of [v => { v.status = 'completed'; }, v => { v.recordRetained = false; },
    v => { v.localMigrationAccepted = true; }, v => { v.automaticRecovery = 'passed'; }]) {
    const value = structuredClone(known); change(value);
    assert.throws(() => profile.validatePrivateMigrationLimitation(value));
  }
  assert.throws(() => profile.validatePrivateMigrationLimitation(undefined));
});
function localFixture(t, mutate = () => {}) {
  const crypto = require('node:crypto'), hash = b => crypto.createHash('sha256').update(b).digest('hex');
  const names = ['mixed_separator_receipt_is_the_same_reviewed_windows_path', 'mixed_separator_saved_fields_preserve_all_other_values_exactly',
    'mixed_separator_receipt_and_saved_fields_are_read_only_validation', 'wrong_receipt_path_never_renews_snapshots',
    'wrong_saved_path_or_preference_never_renews_snapshots', 'false_or_missing_changed_never_accepts_changed_stores',
    'later_store_error_cannot_partially_renew_first_snapshot'];
  const root = { sourceCommit: real.source.commit, sourceTree: real.source.tree,
    installedArtifactSha256: real.rootBuild.executableSha256, runtimeDescriptorSha256: real.rootBuild.runtimeSha256,
    passed: true, exitCode: 0, published: false, compilerInputsUnchanged: true, rawSourceUnchanged: true, generatedSchemaChanges: [],
    summaries: [{ outcome: 'ok', passed: 523, failed: 0, ignored: 14 }], targetedRegressions: names.map(name => ({ name, passed: true })) };
  const client = { sourceCommit: real.source.commit, installedExeSha256: real.rootBuild.executableSha256,
    runtimeDescriptorSha256: real.rootBuild.runtimeSha256, eventStreamSha256: real.realCodex.eventStreamSha256,
    passed: true, exitCode: 0, unexpectedToolEvents: 0, settingsUnchanged: true, positiveReference: true, published: false,
    checks: [{ tool: 'get_bridge_status', count: 1 }, { tool: 'get_mcp_reference', count: 1 }],
    scope: 'after installation; separate from normal Hub restart' };
  const value = { root, client, log: names.map(name => `test ${name} ... ok`).join('\n')
    + '\ntest result: ok. 523 passed; 0 failed; 14 ignored;' };
  mutate(value);
  const doc = (member, bytes) => ({ member, size: bytes.length, sha256: hash(bytes), base64: bytes.toString('base64') });
  const log = doc('root.log', Buffer.from(value.log)); root.logSha256 = log.sha256;
  const receipt = doc('root.json', Buffer.from(JSON.stringify(root))), codex = doc('codex.json', Buffer.from(JSON.stringify(client)));
  t.mock.method(profile, 'getTarget', () => ({ ...real,
    rootNative: { ...real.rootNative, receiptSha256: receipt.sha256, logSha256: log.sha256 },
    realCodex: { ...real.realCodex, receiptSha256: codex.sha256 } }));
  return { evidence: { rootNative: { receipt, log }, realCodex: codex },
    candidate: { sourceCommit: real.source.commit, sourceTree: real.source.tree, executableSha256: real.rootBuild.executableSha256 } };
}
test('local Root and model evidence keeps its exact source and limited acceptance scope', t => {
  const f = localFixture(t), summary = q.captureLocalEvidence(f.evidence, f.candidate);
  q.validateLocalEvidence(summary, f.candidate);
  assert.doesNotMatch(JSON.stringify(summary), /base64|command|project|config|scope/);
  assert.throws(() => q.validateLocalEvidence({ ...summary, privateConfig: 'not allowed' }, f.candidate));
});
for (const [name, change] of [
  ['wrong Root source', v => { v.root.sourceCommit = '1'.repeat(40); }],
  ['Root test failure', v => { v.root.summaries[0].failed = 1; }],
  ['missing new regression', v => { v.root.targetedRegressions.pop(); }],
  ['altered log count', v => { v.log = v.log.replace('523 passed', '522 passed'); }],
  ['wrong model binary', v => { v.client.installedExeSha256 = '2'.repeat(64); }],
  ['model settings change', v => { v.client.settingsUnchanged = false; }],
  ['extra model tool call', v => { v.client.unexpectedToolEvents = 1; }],
  ['invented restart scope', v => { v.client.scope = 'normal GUI restart passed'; }],
]) test('local evidence refuses ' + name, t => {
  const f = localFixture(t, change); assert.throws(() => q.captureLocalEvidence(f.evidence, f.candidate));
});
