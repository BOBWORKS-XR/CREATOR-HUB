'use strict';
// Only synthetic data and optional read-only evidence. No signer or native runner is invoked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const crypto = require('node:crypto');
const profile = require('./windows-release-target.cjs');
const signing = require('./windows-017-signing.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = text => hash(Buffer.from('TEST ONLY ' + text));
const bytes = value => Buffer.from(JSON.stringify(value));
function doc(member, body) {
  const b = Buffer.isBuffer(body) ? body : bytes(body);
  return { member, size: b.length, sha256: hash(b), base64: b.toString('base64') };
}
function load(name, replacements = {}) {
  const file = require.resolve('./' + name), local = createRequire(file), module = { exports: {} };
  vm.runInThisContext('(function(require,module,exports,__filename,__dirname){' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file })(
    name => replacements[name] || local(name), module, module.exports, file, path.dirname(file));
  return module.exports;
}
function readers(t, p) {
  t.mock.method(profile, 'getTarget', () => p);
  const q = load('windows-016-release-qualification.cjs');
  const stage = load('windows-017-draft-stage.cjs', { './windows-016-release-qualification.cjs': q });
  const signer = load('windows-017-signing.cjs', {
    './windows-016-release-qualification.cjs': q, './windows-017-draft-stage.cjs': stage,
  });
  return { q, stage, signer };
}
function zip(rows) {
  const local = [], central = []; let offset = 0;
  for (const [name, body] of rows) {
    const n = Buffer.from(name), h = Buffer.alloc(30), c = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(body.length, 22); h.writeUInt16LE(n.length, 26);
    c.writeUInt32LE(0x02014b50); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(body.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    local.push(h, n, body); central.push(c, n); offset += h.length + n.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(rows.length, 8); end.writeUInt16LE(rows.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
function fixture(t) {
  const p = structuredClone(profile.getTarget());
  p.source = { commit: '7'.repeat(40), tree: '8'.repeat(40) }; p.parent = '9'.repeat(40);
  const inputs = [...signing.SDK_FILES_019, 'modules/mcp/unity-extension/Editor/BanterMCPBridge.cs']
    .map(path => ({ path, sha256: digest(path) }));
  const source = { ...p.source, base: p.parent, version: p.version, source: 'C:\\test-only\\source', inputs };
  const raw = { schemaVersion: 1, kind: 'windows-019-clean-build', version: p.version, sourceCommit: p.source.commit,
    sourceTree: p.source.tree, status: 0, signal: null, error: null, phase: 'signed-build', sourceUnchanged: true,
    changed: [], output: 'C:\\test-only\\source\\artifacts\\candidate', logSha256: digest('build log'),
    installerSha256: digest('installer'), executableSha256: digest('exe'), published: false, releaseReady: false };
  for (const key of Object.keys(p.cleanBuild).filter(k => k !== 'kind')) p.cleanBuild[key] = digest(key);
  const result = { schemaVersion: 1, kind: p.cleanBuild.kind, version: p.version, status: 0, error: null,
    sourceCommit: p.source.commit, sourceTree: p.source.tree, sourceUnchanged: true, changed: [], output: raw.output,
    rawBuildResult: null, rawSignal: { present: true, value: null }, rawWrapperSha256: p.cleanBuild.rawWrapperSha256,
    buildInputsSha256: hash(bytes(inputs)), sourceReceiptSha256: hash(bytes(source)),
    installerSha256: raw.installerSha256, executableSha256: raw.executableSha256,
    setupExecutableSha256: p.cleanBuild.setupExecutableSha256, managedManifestSha256: p.cleanBuild.manifestSha256,
    runtimeDescriptorSha256: p.cleanBuild.runtimeSha256, moduleFilesChecked: 15,
    rootPe: { FileVersion: p.version, ProductVersion: p.version },
    verification: { installedResourcesVerified: true, managedSignaturesVerified: true, tamperRejected: true, installerExtractionVerified: true },
    outerSignaturesGenerated: false, nativeAccepted: false, published: false, releaseReady: false };
  const f = { p, inputs, source, raw, result, ...readers(t, p) };
  f.refresh = () => {
    result.rawBuildResult = { size: bytes(raw).length, sha256: hash(bytes(raw)), base64: bytes(raw).toString('base64') };
    Object.assign(result, { output: raw.output, installerSha256: raw.installerSha256, executableSha256: raw.executableSha256,
      buildInputsSha256: hash(bytes(inputs)), sourceReceiptSha256: hash(bytes(source)) });
    Object.assign(p.cleanBuild, { receiptSha256: hash(bytes(result)), rawReceiptSha256: hash(bytes(raw)),
      inputSha256: result.buildInputsSha256, sourceReceiptSha256: result.sourceReceiptSha256,
      installerSha256: raw.installerSha256, executableSha256: raw.executableSha256 });
    f.candidate = { sourceCommit: p.source.commit, sourceTree: p.source.tree, installer: { size: 19, sha256: raw.installerSha256 },
      executableSha256: raw.executableSha256, buildResultSha256: hash(bytes(result)), buildInputsSha256: hash(bytes(inputs)),
      buildResult: doc('postbuild.json', result), buildInputs: doc('inputs.json', inputs), sourceReceipt: doc('source.json', source) };
  };
  f.refresh(); return f;
}
function rawValue(f) {
  const binding = { schemaVersion: 1, releaseId: 101, releaseTag: 'lab-test-019', assetId: 102,
    assetName: 'Creator.Hub_0.1.19_x64-setup.exe', bytes: f.candidate.installer.size,
    sha256: f.raw.installerSha256, receiptSha256: f.p.cleanBuild.rawReceiptSha256 };
  const value = { schemaVersion: 1, kind: f.p.rawKind, version: f.p.version, productionApproval: false,
    releaseReady: false, candidate: f.candidate, proofs: {} };
  for (const [i, mode] of ['fresh', 'guarded'].entries()) {
    value.proofs[mode] = { runId: 200, runAttempt: 1, jobId: 300 + i, sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40),
      artifact: { id: 400 + i, name: `windows-019-raw-${mode}-200`, size: 1, sha256: digest(mode) },
      binding: doc('private-input-binding-019.json', binding), report: doc('installer-evidence/installer-report.json', {
        passed: true, mode, scope: 'ci-exact-candidate-nsis-only', source: { commit: f.p.source.commit, manifestSha256: f.p.cleanBuild.inputSha256 },
        producer: f.raw, candidateReceiptSha256: f.p.cleanBuild.rawReceiptSha256,
        installerSha256: f.raw.installerSha256, executableSha256: f.raw.executableSha256,
        settingsPreserved: true, freshInstallAccepted: mode === 'fresh', guardedInstallerAccepted: mode === 'guarded',
        from: mode === 'fresh' ? null : require('./self-update-baselines.cjs').selectBaseline('0.1.19'),
        installerScope: mode === 'fresh' ? 'fresh-nsis-default-location' : 'guarded-nsis-update-default-location-no-msi',
        nativeGuiAccepted: false, signedUpdateAccepted: false, automaticRestartAccepted: false, migrationAccepted: false, releaseReady: false,
      }) };
  }
  return value;
}
function sdkFixture(f) {
  const qualification = { packageChecksPassed: true, protectedFilesPreserved: true, sourcePreserved: true,
    qualificationPassed: false, releaseAcceptance: false, error: null, protectedFilesCheckError: null, sourceCheckError: null };
  const check = { success: true, validated: true, validation: { success: true, sdkReadyDone: true, nodesBuiltForThisVersion: true,
    creatorSdkVersion: '4.0.22', visualScriptingVersion: '1.9.12' } };
  const operations = { firstRepair: check, repeatRepair: check, reopenedValidation: check, earlierBackupPreserved: true,
    manifestPreserved: true, releaseAcceptance: false, readinessValidation: { success: false, validated: false,
      validation: { nodesBuiltForThisVersion: false, sdkReadyDone: false } } };
  const reopened = { sdkReadyDone: true, customSelectionsPreserved: true, releaseAcceptance: false };
  const result = { kind: 'sdk4022-vs1912-frozen-r2-production-repair', sourceBinding: { mode: 'frozen-git-export',
    sourceCommit: f.p.source.commit, sourceTree: f.p.source.tree, sourceReceiptSha256: f.p.cleanBuild.sourceReceiptSha256,
    files: Object.fromEntries(f.inputs.slice(0, 11).map(row => [row.path, { sha256: row.sha256 }])) },
    childStarted: true, childExitObserved: true, childExitCode: 0, oneTestPassed: true, passed: true, errors: [],
    restoration: { restoredExactly: true }, releaseAcceptance: false,
    beforeBackup: { sha256: digest('backup') }, afterBackup: { sha256: digest('backup') }, qualification: {} };
  const records = { result, qualification, operations, reopened };
  const refresh = () => {
    const pin = name => ({ size: bytes(records[name]).length, sha256: hash(bytes(records[name])) });
    result.qualification = { ...pin('qualification'), packageChecksPassed: true, qualificationPassed: false,
      production: { operations: pin('operations'), reopened: pin('reopened') } };
    f.p.sdkRepair = Object.fromEntries(Object.entries(records).map(([name, value]) => [name, hash(bytes(value))]));
    return Object.fromEntries(Object.entries(records).map(([name, value]) => [name, bytes(value)]));
  };
  return { records, refresh, evidence: refresh() };
}
test('019 raw reader retains the original build digest and producer, linked through typed postbuild', t => {
  const f = fixture(t), value = rawValue(f);
  assert.equal(f.stage.validate(value), value);
  assert.notEqual(f.candidate.buildResultSha256, f.p.cleanBuild.rawReceiptSha256);
  for (const mutate of [v => { v.proofs.fresh.binding.member = 'private-input-binding.json'; },
    v => { v.candidate.buildInputs = doc('inputs.json', []); }, v => { v.candidate.sourceReceipt = doc('source.json', {}); },
    v => { v.candidate.buildInputsSha256 = digest('wrong input'); },
    v => { const p = v.proofs.fresh, r = JSON.parse(Buffer.from(p.report.base64, 'base64'));
      r.candidateReceiptSha256 = v.candidate.buildResultSha256; p.report = doc(p.report.member, r); },
    v => { const p = v.proofs.fresh, r = JSON.parse(Buffer.from(p.report.base64, 'base64'));
      r.producer = f.result; p.report = doc(p.report.member, r); },
    v => { const p = v.proofs.fresh, r = JSON.parse(Buffer.from(p.report.base64, 'base64'));
      r.signedUpdateAccepted = true; p.report = doc(p.report.member, r); }]) {
    const changed = structuredClone(value); mutate(changed); assert.throws(() => f.stage.validate(changed));
  }
  const c = { ...f.candidate, installerSha256: f.raw.installerSha256 };
  f.q.checkFinalReport('guarded', { documents: { report: value.proofs.guarded.report, binding: value.proofs.guarded.binding } }, {
    candidate: c, draft: { assets: { [f.q.FINAL_ASSETS[0]]: { size: 19 } } },
  });
});
test('SDK acceptance derives from four original receipts and exactly eleven R2 identities', t => {
  const f = fixture(t), sdk = sdkFixture(f), rows = f.signer.validateSdkEvidence(sdk.evidence, f.inputs);
  const bindings = { sourceCommit: f.p.source.commit, sdkNormalRepairPassed: true, bridgeRuntimePassed: true,
    bridgeOnlyLfNormalized: true, releaseAcceptance: false, sdkBindingRows: rows, bridgeFrozenSha256: f.inputs.at(-1).sha256 };
  f.signer.sourceBindings(bindings, f.inputs, sdk.evidence);
  assert.equal(rows.length, 11); assert.equal(sdk.records.qualification.qualificationPassed, false);
  for (const mutate of [b => { b.sdkBindingRows[0].path = 'arbitrary.rs'; }, b => { b.sdkBindingRows.pop(); },
    b => { b.sdkBindingRows[0] = b.sdkBindingRows[1]; }, b => { b.sdkBindingRows[0].testedSha256 = digest('old'); },
    b => { b.sdkNormalRepairPassed = false; }, b => { b.bridgeFrozenSha256 = undefined; }]) {
    const changed = structuredClone(bindings); mutate(changed);
    assert.throws(() => f.signer.sourceBindings(changed, f.inputs, sdk.evidence));
  }
  assert.throws(() => f.signer.validateSdkEvidence({ ...sdk.evidence, result: Buffer.from('{}') }, f.inputs));
});
for (const [name, mutate] of [
  ['unfinished restoration', r => { r.result.restoration.restoredExactly = false; }],
  ['lost-stamp accepted', r => { r.operations.readinessValidation.success = true; }],
  ['relabelled qualification', r => { r.qualification.qualificationPassed = true; }],
  ['release acceptance', r => { r.result.releaseAcceptance = true; }],
  ['old source closure', r => { r.result.sourceBinding.files['modules/project-setup/src-tauri/src/lib.rs'].sha256 = digest('old'); }],
  ['missing new metadata source', r => { delete r.result.sourceBinding.files['modules/project-setup/src-tauri/src/sdk_requirements.rs']; }],
]) test('SDK reader refuses ' + name + ' even with repinned synthetic bytes', t => {
  const f = fixture(t), sdk = sdkFixture(f); mutate(sdk.records);
  assert.throws(() => f.signer.validateSdkEvidence(sdk.refresh(), f.inputs));
});
test('collect reads original raw019 archive members without invoking signing or writes', async t => {
  const f = fixture(t), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub019-reader-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  f.source.source = path.join(dir, 'source'); f.raw.output = path.join(f.source.source, 'out');
  const installer = Buffer.from('TEST ONLY installer'), image = Buffer.from('TEST ONLY image');
  f.raw.installerSha256 = hash(installer); f.raw.executableSha256 = hash(image); f.refresh();
  f.candidate.installer.size = installer.length;
  fs.mkdirSync(path.join(f.raw.output, 'installer-extracted'), { recursive: true });
  fs.writeFileSync(path.join(f.raw.output, 'installer.exe'), installer);
  fs.writeFileSync(path.join(f.raw.output, 'installer-extracted/creator-hub.exe'), image);
  fs.writeFileSync(path.join(f.raw.output, 'installer-checksum.json'), bytes({ version: f.p.version,
    sha256: hash(installer), installedExecutableSha256: hash(image) }));
  const sdk = sdkFixture(f), sdkBindingRows = f.signer.validateSdkEvidence(sdk.evidence, f.inputs);
  const content = { buildResult: bytes(f.result), buildInputs: bytes(f.inputs), sourceReceipt: bytes(f.source),
    runtimeBindings: bytes({ sourceCommit: f.p.source.commit, sdkNormalRepairPassed: true, bridgeRuntimePassed: true,
      bridgeOnlyLfNormalized: true, releaseAcceptance: false, sdkBindingRows, bridgeFrozenSha256: f.inputs.at(-1).sha256 }) };
  const plan = { expectedInstallerSha256: hash(installer), expectedExecutableSha256: hash(image), cases: {}, sdkEvidence: {} };
  for (const [name, body] of Object.entries(content)) { plan[name] = path.join(dir, name + '.json'); fs.writeFileSync(plan[name], body); }
  for (const [name, body] of Object.entries(sdk.evidence)) {
    plan.sdkEvidence[name] = path.join(dir, 'sdk-' + name + '.json'); fs.writeFileSync(plan.sdkEvidence[name], body);
  }
  const value = rawValue(f), repo = { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' }, responses = new Map(), archives = new Map();
  responses.set(`git/commits/${f.p.source.commit}`, { sha: f.p.source.commit, tree: { sha: f.p.source.tree }, parents: [{ sha: f.p.parent }] });
  for (const [mode, p] of Object.entries(value.proofs)) {
    const archive = zip([p.report, p.binding].map(d => [d.member, Buffer.from(d.base64, 'base64')]));
    const artifact = { id: p.artifact.id, name: p.artifact.name, size_in_bytes: archive.length, digest: 'sha256:' + hash(archive),
      expired: false, created_at: '2026-11-04T00:01:00Z', workflow_run: { id: 200, head_sha: p.sourceCommit, repository_id: repo.id, head_repository_id: repo.id } };
    responses.set(`actions/artifacts/${p.artifact.id}`, artifact); archives.set(`actions/artifacts/${p.artifact.id}/zip`, archive);
    responses.set('actions/runs/200', { id: 200, run_attempt: 1, head_sha: p.sourceCommit, event: 'workflow_dispatch',
      path: f.p.rawWorkflow, status: 'completed', conclusion: 'success', repository: repo, head_repository: repo });
    responses.set(`actions/jobs/${p.jobId}`, { id: p.jobId, run_id: 200, run_attempt: 1, head_sha: p.sourceCommit,
      name: `install (${mode})`, status: 'completed', conclusion: 'success', labels: ['windows-latest'],
      started_at: '2026-11-04T00:00:00Z', completed_at: '2026-11-04T00:02:00Z' });
    responses.set(`git/commits/${p.sourceCommit}`, { sha: p.sourceCommit, tree: { sha: p.sourceTree } });
    plan.cases[mode] = { runId: 200, jobId: p.jobId, artifactId: p.artifact.id };
  }
  const io = { request: async route => { assert.ok(responses.has(route), route); return responses.get(route); },
    download: async route => { assert.ok(archives.has(route), route); return archives.get(route); } };
  const result = await f.signer.collect(plan, io);
  assert.equal(result.receipt.candidate.buildResultSha256, f.p.cleanBuild.receiptSha256);
  assert.deepEqual(result.sdkEvidenceSha256, f.p.sdkRepair);
  assert.equal(result.receipt.proofs.guarded.binding.member, 'private-input-binding-019.json');
  assert.equal(JSON.parse(Buffer.from(result.receipt.proofs.fresh.report.base64, 'base64')).candidateReceiptSha256, f.p.cleanBuild.rawReceiptSha256);
});
test('source CI rejects the historical branch before job or archive access', async t => {
  const p = structuredClone(profile.getTarget()), { q } = readers(t, p), pin = p.sourceCi;
  const report = Buffer.from('# tests 316\n# pass 316\n# fail 0\n# skipped 0\n# cancelled 0\n');
  const ci = { runId: pin.runId, runAttempt: pin.runAttempt, workflow: pin.workflow, sourceCommit: p.source.commit,
    sourceTree: p.source.tree, scope: 'final-source-checkout', suite: 'mcp-npm', harnessCommit: pin.harnessCommit,
    harnessTree: pin.harnessTree, workflowBlobSha: pin.workflowBlobSha, jobs: [{ id: pin.jobId, name: 'mcp-npm-tests' }],
    artifact: { id: pin.artifactId, name: pin.artifactName, size: pin.artifactSize, sha256: pin.artifactSha256 },
    report: doc('mcp-npm-tests.log', report), jobLog: doc('job.log', Buffer.from(`productCommit=${p.source.commit} productTree=${p.source.tree} workflowCommit=${pin.harnessCommit}`)) };
  const repo = { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' };
  await assert.rejects(q.verifySourceCi(ci, { candidate: { sourceCommit: p.source.commit, sourceTree: p.source.tree },
    repository: repo.full_name, repositoryId: repo.id }, {
    request: async route => {
      if (route === `git/commits/${p.source.commit}`) return { sha: p.source.commit, tree: { sha: p.source.tree } };
      if (route === `git/commits/${pin.harnessCommit}`) return { sha: pin.harnessCommit, tree: { sha: pin.harnessTree } };
      assert.equal(route, `actions/runs/${pin.runId}`);
      return { id: pin.runId, run_attempt: pin.runAttempt, status: 'completed', conclusion: 'success',
        head_sha: pin.harnessCommit, path: pin.workflow, head_branch: 'validation/windows-018-source-tests' };
    }, download: async () => assert.fail('No archive access for wrong source branch'),
  }), /Wrong R2 source-CI branch/);
});
test('source CI admits only the exact 019 branch, workflow and original artifact/job bytes', async t => {
  const f = fixture(t), p = f.p, pin = p.sourceCi;
  const report = Buffer.from('# tests 316\n# pass 316\n# fail 0\n# skipped 0\n# cancelled 0\n');
  const log = Buffer.from(`productCommit=${p.source.commit} productTree=${p.source.tree} workflowCommit=${pin.harnessCommit}`);
  const archive = zip([['mcp-npm-tests.log', report]]);
  const workflow = Buffer.from(`github.ref == 'refs/heads/${pin.branch}'\nref: ${p.source.commit}\n` +
    `$commit -cne '${p.source.commit}'\n$tree -cne '${p.source.tree}'\n` +
    'npm --prefix modules/mcp test 2>&1 | Tee-Object -FilePath mcp-npm-tests.log');
  pin.workflowSha256 = hash(workflow); pin.artifactSize = archive.length; pin.artifactSha256 = hash(archive);
  const ci = { runId: pin.runId, runAttempt: pin.runAttempt, workflow: pin.workflow, sourceCommit: p.source.commit,
    sourceTree: p.source.tree, scope: 'final-source-checkout', suite: 'mcp-npm', harnessCommit: pin.harnessCommit,
    harnessTree: pin.harnessTree, workflowBlobSha: pin.workflowBlobSha, jobs: [{ id: pin.jobId, name: 'mcp-npm-tests' }],
    artifact: { id: pin.artifactId, name: pin.artifactName, size: pin.artifactSize, sha256: pin.artifactSha256 },
    report: doc('mcp-npm-tests.log', report), jobLog: doc('job.log', log) };
  const repo = { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' };
  const responses = new Map([
    [`git/commits/${p.source.commit}`, { sha: p.source.commit, tree: { sha: p.source.tree } }],
    [`git/commits/${pin.harnessCommit}`, { sha: pin.harnessCommit, tree: { sha: pin.harnessTree } }],
    [`actions/runs/${pin.runId}`, { id: pin.runId, run_attempt: pin.runAttempt, status: 'completed', conclusion: 'success',
      head_sha: pin.harnessCommit, path: pin.workflow, head_branch: pin.branch, event: 'push', repository: repo, head_repository: repo }],
    [`actions/jobs/${pin.jobId}`, { id: pin.jobId, name: 'mcp-npm-tests', run_id: pin.runId, run_attempt: pin.runAttempt,
      head_sha: pin.harnessCommit, status: 'completed', conclusion: 'success', labels: ['windows-latest'],
      started_at: '2026-11-04T00:00:00Z', completed_at: '2026-11-04T00:02:00Z' }],
    [`git/trees/${pin.harnessTree}?recursive=1`, { truncated: false, sha: pin.harnessTree,
      tree: [{ path: pin.workflow, type: 'blob', sha: pin.workflowBlobSha }] }],
    [`git/blobs/${pin.workflowBlobSha}`, { sha: pin.workflowBlobSha, encoding: 'base64', size: workflow.length, content: workflow.toString('base64') }],
    [`actions/artifacts/${pin.artifactId}`, { id: pin.artifactId, name: pin.artifactName, size_in_bytes: archive.length,
      digest: 'sha256:' + hash(archive), expired: false, created_at: '2026-11-04T00:01:00Z',
      workflow_run: { id: pin.runId, head_sha: pin.harnessCommit, repository_id: repo.id, head_repository_id: repo.id } }],
  ]);
  const downloads = new Map([[`actions/artifacts/${pin.artifactId}/zip`, archive], [`actions/jobs/${pin.jobId}/logs`, log]]);
  const io = { request: async route => { assert.ok(responses.has(route), route); return responses.get(route); },
    download: async route => { assert.ok(downloads.has(route), route); return downloads.get(route); } };
  const value = { candidate: f.candidate, repository: repo.full_name, repositoryId: repo.id };
  await f.q.verifySourceCi(ci, value, io);
  downloads.set(`actions/jobs/${pin.jobId}/logs`, Buffer.from('altered job bytes'));
  await assert.rejects(f.q.verifySourceCi(ci, value, io), /Original source checkout\/job log changed/);
});
test('019 migration reader accepts only its exact producer scope and preserves coverage refusals', t => {
  const f = fixture(t), c = { ...f.candidate, installerSha256: f.raw.installerSha256 };
  const harness = 'a'.repeat(40), names = [f.q.FINAL_ASSETS[0], 'creator-hub-windows-x86_64.json',
    'creator-hub-windows-x86_64.json.minisig', 'latest.json'];
  const assets = Object.fromEntries(names.map(name => [name, { size: 1, sha256: digest(name) }]));
  const binding = { harnessSource: harness, privateDraft: true, readbackVerified: true, releaseId: 1,
    releaseTag: 'v0.1.19', source: { commit: c.sourceCommit, tree: c.sourceTree }, files: assets };
  const report = { passed: true, releaseReady: false, installerSha256: c.installerSha256,
    executableSha256: c.executableSha256, productSource: c.sourceCommit, productTree: c.sourceTree,
    buildInputsSha256: c.buildInputs.sha256, buildResultSha256: hash(bytes(f.raw)),
    settingsPreserved: true, sourceUnchanged: true, buildProvenance: f.raw,
    scope: 'exact-direct19-three-client-clean-legacy-guide-probe', testSource: harness, inputBinding: binding,
    nativeGuideAccepted: true, cancelAccepted: true, repeatStartupAccepted: true, policyRestored: true,
    installedResourcesVerified: true, migrationAccepted: false, signedUpdateAccepted: false,
    liveAiAppAccepted: false, crashRecoveryAccepted: false, backupBeforeEveryWriteAccepted: false, userMachineUsed: false,
    nativeDecisions: ['Not now', 'Move to Hub'].map(name => ({ name, pid: 1, executableSha256: c.executableSha256 })),
    connectionExceptionDecisions: [{ name: 'Move reviewed connections', executableSha256: c.executableSha256 }],
    backupsPresentAtFirstObservedChange: Array.from({ length: 5 }, (_, i) => ({ file: `file${i}`, backup: `file${i}.bak` })),
    resourcePins: Object.fromEntries(['setup/creator-project-setup.exe', 'routing/creator-hub-mcp-router.exe',
      'routing/router.json', 'routing/router.minisig', 'routing/runtime.json', 'routing/runtime.minisig']
      .map(name => [name, digest(name)])) };
  const verify = record => f.q.checkFinalReport('migration', { sourceCommit: harness,
    documents: { report: doc('migration-016-report.json', record), binding: doc('input-binding.json', binding) } },
  { candidate: c, draft: { id: 1, assets } });
  verify(report);
  for (const scope of ['exact-direct16-three-client-clean-legacy-guide-probe', 'migration-complete', undefined]) {
    assert.throws(() => verify({ ...report, scope }));
  }
  assert.throws(() => verify({ ...report, settingsPreserved: false }));
  assert.throws(() => verify({ ...report, backupsPresentAtFirstObservedChange: [] }));
  assert.throws(() => verify({ ...report, migrationAccepted: true }));
});
test('retained R2 receipts are readable without changing their original bytes or acceptance scope', {
  skip: !process.env.CREATOR_HUB_019_EVIDENCE_ROOT,
}, t => {
  const root = process.env.CREATOR_HUB_019_EVIDENCE_ROOT, p = profile.getTarget(), { q, stage, signer } = readers(t, p);
  const read = name => fs.readFileSync(path.join(root, name)), build = read('hotfix-postbuild-r2.json');
  const inputs = read('hotfix-build-inputs-r2.json'), source = read('hotfix-source-r2.json');
  const candidate = { sourceCommit: p.source.commit, sourceTree: p.source.tree, installer: { size: 38353697, sha256: p.cleanBuild.installerSha256 },
    installerSha256: p.cleanBuild.installerSha256, executableSha256: p.cleanBuild.executableSha256,
    buildResultSha256: hash(build), buildInputsSha256: hash(inputs), buildResult: doc('hotfix-postbuild-r2.json', build),
    buildInputs: doc('hotfix-build-inputs-r2.json', inputs), sourceReceipt: doc('hotfix-source-r2.json', source) };
  const typed = profile.validateCleanBuildInputs(build, candidate, inputs, source);
  assert.ok(Buffer.from(typed.rawBuildResult.base64, 'base64').equals(read('hotfix-build-r2.json')));
  for (const [pin, name] of [[p.rootNative, 'hub'], [p.setupNative, 'setup']]) {
    const receipt = read(`${name}-r2-native.json`), log = read(`${name}-r2-native.log`), result = JSON.parse(receipt);
    assert.equal(hash(receipt), pin.receiptSha256); assert.equal(hash(log), pin.logSha256);
    assert.deepEqual(result.summaries, [{ outcome: 'ok', passed: pin.passed, failed: 0, ignored: pin.ignored }]);
    assert.deepEqual(result.targetedRegressions, pin.regressions.map(name => ({ name, passed: true })));
    for (const name of pin.regressions) assert.ok(log.toString('utf8').includes(`${name} ... ok`));
  }
  const sourceCi = JSON.parse(read('source-ci-input.json')), run = JSON.parse(read('source-ci-run.json'));
  assert.equal(sourceCi.commit, p.sourceCi.harnessCommit); assert.equal(sourceCi.tree, p.sourceCi.harnessTree);
  assert.equal(sourceCi.workflowBlob, p.sourceCi.workflowBlobSha); assert.equal(sourceCi.workflowSha256, p.sourceCi.workflowSha256);
  assert.equal(run.id, p.sourceCi.runId); assert.equal(run.head_branch, p.sourceCi.branch); assert.equal(run.conclusion, 'success');
  assert.equal(hash(read('source-ci-artifact.zip')), p.sourceCi.artifactSha256);
  for (const mode of ['fresh', 'guarded']) {
    const archive = read(`raw-ci-${mode}.zip`), report = 'installer-evidence/installer-report.json', binding = 'private-input-binding-019.json';
    stage.rawReport(mode, { report: doc(report, q.readZipMember(archive, report)), binding: doc(binding, q.readZipMember(archive, binding)) }, { candidate });
  }
  const sdkPath = path.join(root, 'sdk-4022-vs1912-r2-1793782184091/result.json');
  const result = fs.readFileSync(sdkPath), record = JSON.parse(result);
  const rows = signer.validateSdkEvidence({ result, qualification: fs.readFileSync(record.qualification.path),
    operations: fs.readFileSync(record.qualification.production.operations.path), reopened: fs.readFileSync(record.qualification.production.reopened.path) }, JSON.parse(inputs));
  assert.equal(rows.length, 11);
  assert.doesNotThrow(() => profile.requireQualificationPins());
});
