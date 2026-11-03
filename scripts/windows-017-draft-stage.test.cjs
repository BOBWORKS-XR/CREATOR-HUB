'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
require('./fixtures/windows-release-target.cjs').install();
const s = require('./windows-017-draft-stage.cjs');
const q = require('./windows-016-release-qualification.cjs');
function doc(member, data) {
  const bytes = Buffer.from(JSON.stringify(data)); return { member, size: bytes.length, sha256: s.hash(bytes), base64: bytes.toString('base64') };
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
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16); return Buffer.concat([...local, directory, end]);
}
function fixture() {
  const source = q.FINAL_SOURCE, harness = '1'.repeat(40), tree = '2'.repeat(40), installer = Buffer.from('TEST ONLY installer');
  const build = doc('build-result.json', { status: 0, sourceUnchanged: true, changed: [], sourceCommit: source.commit,
    sourceTree: source.tree, installerSha256: s.hash(installer), executableSha256: '3'.repeat(64) });
  const candidate = { sourceCommit: source.commit, sourceTree: source.tree, installer: { size: installer.length, sha256: s.hash(installer) },
    executableSha256: '3'.repeat(64), buildResultSha256: build.sha256, buildInputsSha256: '4'.repeat(64), buildResult: build };
  const binding = { schemaVersion: 1, releaseId: 12345, releaseTag: 'lab-r6-test', assetId: 12346,
    assetName: 'Creator.Hub_0.1.18_x64-r6-test-setup.exe', bytes: installer.length, sha256: s.hash(installer), receiptSha256: build.sha256 };
  const value = { schemaVersion: 1, kind: 'windows-018-raw-installer-qualification', version: '0.1.18', productionApproval: false, releaseReady: false, candidate, proofs: {} };
  const responses = new Map(), archives = new Map(), calls = [];
  responses.set(`git/commits/${source.commit}`, { sha: source.commit, tree: { sha: source.tree }, parents: [{ sha: q.FINAL_PARENT }] });
  responses.set(`git/commits/${harness}`, { sha: harness, tree: { sha: tree } });
  const repo = { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' };
  for (const [i, mode] of ['fresh', 'guarded'].entries()) {
    const report = doc('installer-report.json', { passed: true, mode, scope: 'ci-exact-candidate-nsis-only',
      source: { commit: source.commit, manifestSha256: candidate.buildInputsSha256 },
      producer: { kind: 'local-r7-build', sourceTree: source.tree, buildResultSha256: build.sha256, privateAsset: binding },
      candidateReceiptSha256: build.sha256, installerSha256: candidate.installer.sha256, executableSha256: candidate.executableSha256,
      from: mode === 'fresh' ? null : require('./self-update-baselines.cjs').selectBaseline('0.1.18'),
      installerScope: mode === 'fresh' ? 'fresh-nsis-default-location' : 'guarded-nsis-update-default-location-no-msi',
      freshInstallAccepted: mode === 'fresh', guardedInstallerAccepted: mode === 'guarded', settingsPreserved: true,
      nativeGuiAccepted: false, signedUpdateAccepted: false, automaticRestartAccepted: false, migrationAccepted: false, releaseReady: false });
    const input = doc('private-input-binding.json', binding), archive = zip([['installer-evidence/installer-report.json', Buffer.from(report.base64, 'base64')],
      ['private-input-binding.json', Buffer.from(input.base64, 'base64')]]);
    const p = { runId: 200, runAttempt: 1, jobId: 300 + i, sourceCommit: harness, sourceTree: tree,
      artifact: { id: 400 + i, name: `windows-r5-raw-${mode}-200`, size: archive.length, sha256: s.hash(archive) }, report, binding: input };
    value.proofs[mode] = p; archives.set(`actions/artifacts/${p.artifact.id}/zip`, archive);
    responses.set('actions/runs/200', { id: 200, run_attempt: 1, event: 'workflow_dispatch', head_sha: harness, status: 'completed', conclusion: 'success',
      path: '.github/workflows/windows-r5-raw-installer.yml', repository: repo, head_repository: repo });
    responses.set(`actions/jobs/${p.jobId}`, { id: p.jobId, run_id: 200, run_attempt: 1, head_sha: harness, name: `install (${mode})`,
      status: 'completed', conclusion: 'success', labels: ['windows-latest'], started_at: '2026-11-03T10:00:00Z', completed_at: '2026-11-03T10:02:00Z' });
    responses.set(`actions/artifacts/${p.artifact.id}`, { id: p.artifact.id, name: p.artifact.name, size_in_bytes: archive.length,
      digest: `sha256:${p.artifact.sha256}`, expired: false, created_at: '2026-11-03T10:01:00Z',
      workflow_run: { id: 200, head_sha: harness, repository_id: repo.id, head_repository_id: repo.id } });
  }
  const bodies = Object.fromEntries(q.FINAL_ASSETS.map(name => [name, Buffer.from(`TEST ONLY ${name}`)]));
  const checked = { bodies, assets: Object.fromEntries(Object.entries(bodies).map(([name, bytes]) => [name, { size: bytes.length, sha256: s.hash(bytes) }])) };
  let created;
  responses.set('', { ...repo, permissions: { push: true } }); responses.set('releases?per_page=100&page=1', []);
  const io = {
    request: async route => { calls.push(['get', route]);
      if (route === 'releases/500') return { ...created, assets: q.FINAL_ASSETS.map((name, i) => ({ name, id: 600 + i,
        state: 'uploaded', size: bodies[name].length, digest: `sha256:${s.hash(bodies[name])}` })) };
      assert.ok(responses.has(route), route); return structuredClone(responses.get(route)); },
    download: async route => { calls.push(['download', route]);
      if (archives.has(route)) return Buffer.from(archives.get(route));
      return Buffer.from(bodies[q.FINAL_ASSETS[Number(route.split('/').at(-1)) - 600]]); },
    createDraft: async payload => { calls.push(['create', payload]); created = { ...payload, id: 500, assets: [] }; return created; },
    upload: async files => { calls.push(['upload', files]); },
  };
  return { value, io, responses, archives, checked, calls };
}
function tempOptions(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub017-stage-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const notes = path.join(root, 'notes.md'); fs.writeFileSync(notes, 'Unpublished test candidate');
  return { notes, output: path.join(root, 'attempt'), assets: root, executable: path.join(root, 'not-executed.exe') };
}
test('raw protocol qualification preserves the actual narrow nonacceptance flags', () => {
  const { value } = fixture(); assert.equal(s.validate(value), value);
  for (const change of [v => { v.productionApproval = true; }, v => { v.candidate.sourceCommit = q.FINAL_PARENT; },
    v => { const p = v.proofs.fresh, r = JSON.parse(Buffer.from(p.report.base64, 'base64')); r.signedUpdateAccepted = true; p.report = doc(p.report.member, r); },
    v => { const p = v.proofs.guarded, r = JSON.parse(Buffer.from(p.report.base64, 'base64')); r.guardedInstallerAccepted = false; p.report = doc(p.report.member, r); }]) {
    const bad = structuredClone(value); change(bad); assert.throws(() => s.validate(bad));
  }
});
test('raw runs and original artifact bytes must pass before staging', async () => {
  const f = fixture(); assert.equal((await s.verifyRaw(f.value, f.io)).productionApproval, false);
  f.responses.get('actions/jobs/300').conclusion = 'failure'; await assert.rejects(s.verifyRaw(f.value, f.io));
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 0);
});
test('signed draft staging creates only a new unpublished 017 draft and reads back all six assets', async t => {
  const f = fixture(), options = tempOptions(t);
  const result = await s.stage(f.value, options, f.io, () => f.checked);
  assert.equal(result.draft, true); assert.equal(result.productionApproval, false); assert.equal(result.releaseReady, false);
  assert.equal(result.signingInvoked, false); assert.equal(result.associationRetargetRequired, true);
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 1);
  const payload = f.calls.find(c => c[0] === 'create')[1];
  assert.equal(payload.tag_name, 'v0.1.18'); assert.equal(payload.draft, true); assert.equal(payload.prerelease, false); assert.equal(payload.make_latest, 'false');
  assert.equal(f.calls.find(c => c[0] === 'upload')[1].length, 6);
  assert.ok(fs.existsSync(path.join(options.output, 'stage-receipt.json')));
});
test('existing 017 release and failed local signatures cause no create or upload', async t => {
  for (const reason of ['exists', 'signature']) {
    const f = fixture(), options = tempOptions(t);
    if (reason === 'exists') f.responses.set('releases?per_page=100&page=1', [{ tag_name: 'v0.1.18', draft: true }]);
    await assert.rejects(s.stage(f.value, options, f.io, () => { if (reason === 'signature') throw Error('Invalid signature'); return f.checked; }));
    assert.equal(f.calls.filter(c => c[0] === 'create' || c[0] === 'upload').length, 0);
  }
});
test('partial upload is retained for manual review without overwrite or automatic retry', async t => {
  const f = fixture(), options = tempOptions(t); f.io.upload = async () => { throw Error('Upload interrupted'); };
  await assert.rejects(s.stage(f.value, options, f.io, () => f.checked), /interrupted/);
  assert.ok(fs.existsSync(path.join(options.output, 'failure.json')));
  assert.equal(fs.existsSync(path.join(options.output, 'stage-receipt.json')), false);
  await assert.rejects(s.stage(f.value, options, f.io, () => f.checked), /Stage attempt exists/);
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 1);
});
test('staging module has no key, signing, dispatch, deletion or publishing execution path', () => {
  const source = fs.readFileSync(require.resolve('./windows-017-draft-stage.cjs'), 'utf8');
  assert.doesNotMatch(source, /SIGNING_KEY|catalog\.key|signer',\s*'sign|workflow',\s*'run|draft=false|--clobber|release',\s*'delete/);
  assert.throws(() => s.localAssets(fixture().value, os.tmpdir(), path.join(os.tmpdir(), 'absent.exe')));
});
function signingFixture(t) {
  const f = fixture(), options = tempOptions(t), root = path.dirname(options.notes);
  const sourceRoot = path.join(root, 'source'), output = path.join(sourceRoot, 'artifacts/unified/r6');
  fs.mkdirSync(path.join(output, 'installer-extracted'), { recursive: true });
  const installer = Buffer.from('TEST ONLY installer'), executable = Buffer.from('TEST ONLY EXE');
  const installerHash = s.hash(installer), exeHash = s.hash(executable);
  fs.writeFileSync(path.join(output, 'installer.exe'), installer); fs.writeFileSync(path.join(output, 'installer-extracted/creator-hub.exe'), executable);
  fs.writeFileSync(path.join(output, 'installer-checksum.json'), JSON.stringify({ version: '0.1.18', sha256: installerHash, installedExecutableSha256: exeHash }));
  const rows = Array.from({ length: 9 }, (_, i) => ({ path: `modules/project-setup/test-${i}.rs`, sha256: '5'.repeat(64) }));
  rows.push({ path: 'modules/mcp/unity-extension/Editor/BanterMCPBridge.cs', sha256: '6'.repeat(64) });
  const bindings = { sourceCommit: q.FINAL_SOURCE.commit, sdkNormalRepairPassed: true, bridgeRuntimePassed: true,
    bridgeOnlyLfNormalized: true, bridgeFrozenSha256: '6'.repeat(64), releaseAcceptance: false,
    sdkBindingRows: rows.slice(0, 9).map(r => ({ path: r.path, candidateSha256: r.sha256, testedSha256: r.sha256, match: 'exact' })) };
  const inputFile = path.join(root, 'inputs.json'), buildFile = path.join(root, 'build.json'), sourceFile = path.join(root, 'source.json'), bindingsFile = path.join(root, 'bindings.json');
  fs.writeFileSync(inputFile, JSON.stringify(rows)); fs.writeFileSync(bindingsFile, JSON.stringify(bindings));
  fs.writeFileSync(sourceFile, JSON.stringify({ commit: q.FINAL_SOURCE.commit, tree: q.FINAL_SOURCE.tree, source: sourceRoot }));
  const build = { status: 0, error: null, signal: null, sourceUnchanged: true, changed: [], sourceCommit: q.FINAL_SOURCE.commit,
    sourceTree: q.FINAL_SOURCE.tree, installerSha256: installerHash, executableSha256: exeHash, output };
  fs.writeFileSync(buildFile, JSON.stringify(build)); const buildHash = s.hash(fs.readFileSync(buildFile));
  const inputHash = s.hash(fs.readFileSync(inputFile));
  for (const p of Object.values(f.value.proofs)) {
    const report = JSON.parse(Buffer.from(p.report.base64, 'base64')), binding = JSON.parse(Buffer.from(p.binding.base64, 'base64'));
    binding.receiptSha256 = buildHash; report.producer.privateAsset = binding;
    report.producer.buildResultSha256 = buildHash; report.candidateReceiptSha256 = buildHash;
    report.source.manifestSha256 = inputHash; report.executableSha256 = exeHash;
    p.report = doc(p.report.member, report); p.binding = doc(p.binding.member, binding);
    const archive = zip([[p.report.member, Buffer.from(p.report.base64, 'base64')], [p.binding.member, Buffer.from(p.binding.base64, 'base64')]]);
    f.archives.set(`actions/artifacts/${p.artifact.id}/zip`, archive);
    const metadata = f.responses.get(`actions/artifacts/${p.artifact.id}`); metadata.size_in_bytes = archive.length; metadata.digest = `sha256:${s.hash(archive)}`;
  }
  return { ...f, plan: { buildResult: buildFile, buildInputs: inputFile, sourceReceipt: sourceFile, runtimeBindings: bindingsFile,
    platformRoot: root, signingKeyPath: path.join(root, 'test-only-key-not-read'),
    expectedInstallerSha256: installerHash, expectedExecutableSha256: exeHash, output: path.join(root, 'signing-prepared'),
    cases: Object.fromEntries(Object.entries(f.value.proofs).map(([mode, p]) => [mode, { runId: p.runId, jobId: p.jobId, artifactId: p.artifact.id }])) } };
}
test('canonical signing preparation derives real raw reports and writes no signed output', async t => {
  const signer = require('./windows-017-signing.cjs'), f = signingFixture(t); let supportCalls = 0;
  const result = await signer.prepare(f.plan, f.io, () => { supportCalls++; return {}; });
  assert.equal(supportCalls, 1); assert.equal(result.signingInvoked, false); assert.equal(result.productionApproval, false);
  const raw = JSON.parse(fs.readFileSync(path.join(f.plan.output, 'raw-installer-qualification.json'))); s.validate(raw);
  const protocol = JSON.parse(fs.readFileSync(path.join(f.plan.output, 'installer-protocol.json')));
  assert.equal(protocol.approvedForStable, true); assert.equal(protocol.installerProtocol, 1); assert.equal(protocol.minHubVersion, '0.1.12');
  assert.equal(protocol.productionApproval, false); assert.match(protocol.approvalScope, /NSIS installer protocol only/);
  const command = fs.readFileSync(path.join(f.plan.output, 'launch-sign.cmd'), 'utf8');
  assert.match(command, /release-descriptor\.cjs" hub 0\.1\.18/); assert.match(command, /set "NODE_OPTIONS="/);
  assert.ok(command.includes(`set "CREATOR_HUB_SIGNING_KEY_PATH=${f.plan.signingKeyPath}"`));
  assert.equal(fs.existsSync(path.join(f.plan.output, 'signed')), false);
  assert.equal(f.calls.filter(c => c[0] === 'create' || c[0] === 'upload').length, 0);
});
test('signing preparation requires explicit local paths without embedding an operator profile', async t => {
  const signer = require('./windows-017-signing.cjs');
  for (const key of ['platformRoot', 'signingKeyPath']) {
    const f = signingFixture(t); delete f.plan[key];
    await assert.rejects(signer.prepare(f.plan, f.io, () => { throw Error('Support must not be read'); }));
    assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.plan.output), false);
  }
  assert.throws(() => signer.launchText(path.resolve('unused'), 'relative-key'));
  assert.throws(() => signer.launchText(path.resolve('unused'), path.resolve('key%INJECT%')));
  assert.doesNotMatch(fs.readFileSync(require.resolve('./windows-017-signing.cjs'), 'utf8'), /C:[\\/]+Users[\\/]+/i);
});
test('failed raw acceptance or wrong final hash cannot create a signing receipt', async t => {
  const signer = require('./windows-017-signing.cjs');
  for (const reason of ['job', 'hash']) {
    const f = signingFixture(t); let supportCalled = false;
    if (reason === 'job') f.responses.get('actions/jobs/300').conclusion = 'failure';
    else f.plan.expectedInstallerSha256 = 'f'.repeat(64);
    await assert.rejects(signer.prepare(f.plan, f.io, () => { supportCalled = true; return {}; }));
    assert.equal(supportCalled, false); assert.equal(fs.existsSync(f.plan.output), false);
  }
});
