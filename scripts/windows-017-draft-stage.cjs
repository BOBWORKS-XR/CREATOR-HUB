'use strict';
// Stage only already-signed final bytes. No private key, signer, dispatch or publisher is invoked.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const q = require('./windows-016-release-qualification.cjs');
const target = q.RELEASE_TARGET, VERSION = q.FINAL_VERSION;
const REPO = 'BOBWORKS-XR/CREATOR-HUB', REPO_ID = 1364807512, TAG = `v${VERSION}`;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function keys(value, expected) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); assert.deepEqual(Object.keys(value).sort(), [...expected].sort()); }
function digest(value) { assert.match(value || '', /^[a-f0-9]{64}$/); assert.notEqual(value, '0'.repeat(64)); }
function positive(value) { assert.ok(Number.isSafeInteger(value) && value > 0); }
function read(file, limit) {
  const stat = fs.lstatSync(file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= limit);
  const bytes = fs.readFileSync(file); assert.equal(bytes.length, stat.size); return bytes;
}
function document(pin) {
  keys(pin, ['member', 'size', 'sha256', 'base64']); positive(pin.size); digest(pin.sha256);
  assert.ok(pin.size <= 256 * 1024 && /^[A-Za-z0-9_./-]+$/.test(pin.member) && !pin.member.split('/').some(p => !p || p === '.' || p === '..'));
  assert.ok(typeof pin.base64 === 'string' && pin.base64.length <= 350000);
  const bytes = Buffer.from(pin.base64, 'base64'); assert.equal(bytes.toString('base64'), pin.base64);
  assert.equal(bytes.length, pin.size); assert.equal(hash(bytes), pin.sha256); return bytes;
}
function rawReport(mode, proof, value) {
  const r = JSON.parse(document(proof.report)), binding = JSON.parse(document(proof.binding)), c = value.candidate;
  assert.equal(r.passed, true); assert.equal(r.mode, mode); assert.equal(r.scope, 'ci-exact-candidate-nsis-only');
  assert.deepEqual(r.source, { commit: c.sourceCommit, manifestSha256: c.buildInputsSha256 });
  assert.equal(r.candidateReceiptSha256, c.buildResultSha256);
  assert.equal(r.installerSha256, c.installer.sha256); assert.equal(r.executableSha256, c.executableSha256);
  assert.equal(r.settingsPreserved, true); assert.ok(!r.error);
  assert.equal(r.freshInstallAccepted, mode === 'fresh'); assert.equal(r.guardedInstallerAccepted, mode === 'guarded');
  for (const flag of ['nativeGuiAccepted', 'signedUpdateAccepted', 'automaticRestartAccepted', 'migrationAccepted', 'releaseReady']) assert.equal(r[flag], false);
  assert.equal(r.installerScope, mode === 'fresh' ? 'fresh-nsis-default-location' : 'guarded-nsis-update-default-location-no-msi');
  if (mode === 'fresh') assert.equal(r.from, null);
  else {
    const baseline = require('./self-update-baselines.cjs').selectBaseline(VERSION);
    for (const field of ['version', 'installer', 'exe']) assert.equal(r.from[field], baseline[field]);
  }
  keys(binding, ['schemaVersion', 'releaseId', 'releaseTag', 'assetId', 'assetName', 'bytes', 'sha256', 'receiptSha256']);
  assert.equal(binding.schemaVersion, 1); positive(binding.releaseId); positive(binding.assetId);
  assert.notEqual(binding.releaseId, 432509311); assert.notEqual(binding.releaseId, 424919952);
  assert.match(binding.releaseTag, /^lab-[A-Za-z0-9._-]+$/);
  assert.ok(binding.assetName.startsWith(`Creator.Hub_${VERSION}_`) && /^[A-Za-z0-9._-]+\.exe$/.test(binding.assetName));
  assert.equal(binding.bytes, c.installer.size); assert.equal(binding.sha256, c.installer.sha256); assert.equal(binding.receiptSha256, c.buildResultSha256);
  assert.equal(r.producer.kind, target.rawProducer); assert.equal(r.producer.sourceTree, c.sourceTree);
  assert.equal(r.producer.buildResultSha256, c.buildResultSha256); assert.deepEqual(r.producer.privateAsset, binding);
  if (target.rootBuild) {
    require('./windows-release-target.cjs').validateRootOnlyProjection(r.producer.rootOnlyAssembly,
      document(c.buildResult), document(c.originalBuildResult), { ...c, installerSha256: c.installer.sha256 });
  }
  return binding;
}
function validate(value) {
  require('./windows-release-target.cjs').requireSource();
  keys(value, ['schemaVersion', 'kind', 'version', 'productionApproval', 'releaseReady', 'candidate', 'proofs']);
  assert.equal(value.schemaVersion, 1); assert.equal(value.kind, target.rawKind); assert.equal(value.version, VERSION);
  assert.equal(value.productionApproval, false); assert.equal(value.releaseReady, false);
  const c = value.candidate;
  keys(c, ['sourceCommit', 'sourceTree', 'installer', 'executableSha256', 'buildResultSha256', 'buildInputsSha256', 'buildResult',
    ...(target.rootBuild ? ['originalBuildResult'] : [])]);
  assert.equal(c.sourceCommit, q.FINAL_SOURCE.commit); assert.equal(c.sourceTree, q.FINAL_SOURCE.tree);
  keys(c.installer, ['size', 'sha256']); positive(c.installer.size); assert.ok(c.installer.size <= 256 * 1024 * 1024);
  for (const d of [c.installer.sha256, c.executableSha256, c.buildResultSha256, c.buildInputsSha256]) digest(d);
  const buildBytes = document(c.buildResult); assert.equal(hash(buildBytes), c.buildResultSha256);
  require('./windows-release-target.cjs').validateBuildRecord(buildBytes,
    { ...c, installerSha256: c.installer.sha256 }, target.rootBuild ? document(c.originalBuildResult) : undefined);
  if (target.rootBuild) assert.equal(c.buildInputsSha256, target.rootBuild.inputSha256);
  keys(value.proofs, ['fresh', 'guarded']);
  for (const [mode, p] of Object.entries(value.proofs)) {
    keys(p, ['runId', 'runAttempt', 'jobId', 'sourceCommit', 'sourceTree', 'artifact', 'report', 'binding']);
    for (const id of [p.runId, p.runAttempt, p.jobId, p.artifact.id]) positive(id);
    assert.match(p.sourceCommit, /^[a-f0-9]{40}$/); assert.match(p.sourceTree, /^[a-f0-9]{40}$/);
    keys(p.artifact, ['id', 'name', 'size', 'sha256']); positive(p.artifact.size); digest(p.artifact.sha256);
    assert.ok(p.artifact.size <= 2 * 1024 * 1024); assert.equal(p.artifact.name, `${target.rawArtifactPrefix}-${mode}-${p.runId}`);
    rawReport(mode, p, value);
  }
  assert.notEqual(value.proofs.fresh.jobId, value.proofs.guarded.jobId);
  assert.deepEqual(rawReport('fresh', value.proofs.fresh, value), rawReport('guarded', value.proofs.guarded, value));
  return value;
}
function load(file, expected) {
  digest(expected); const bytes = read(file, 2 * 1024 * 1024); assert.equal(hash(bytes), expected);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes), value = JSON.parse(text);
  assert.ok(text.trim() === JSON.stringify(value) || text.trim() === JSON.stringify(value, null, 2)); return validate(value);
}
async function verifyRaw(value, io) {
  validate(value);
  const source = await io.request(`git/commits/${value.candidate.sourceCommit}`);
  assert.equal(source.sha, q.FINAL_SOURCE.commit); assert.equal(source.tree.sha, q.FINAL_SOURCE.tree);
  assert.deepEqual(source.parents.map(p => p.sha), [q.FINAL_PARENT]);
  for (const [mode, p] of Object.entries(value.proofs)) {
    const commit = await io.request(`git/commits/${p.sourceCommit}`); assert.equal(commit.sha, p.sourceCommit); assert.equal(commit.tree.sha, p.sourceTree);
    const run = await io.request(`actions/runs/${p.runId}`), job = await io.request(`actions/jobs/${p.jobId}`), a = await io.request(`actions/artifacts/${p.artifact.id}`);
    for (const [key, expected] of Object.entries({ id: p.runId, run_attempt: p.runAttempt, event: 'workflow_dispatch', head_sha: p.sourceCommit,
      status: 'completed', conclusion: 'success', path: target.rawWorkflow })) assert.equal(run[key], expected);
    for (const repo of [run.repository, run.head_repository]) { assert.equal(repo.id, REPO_ID); assert.equal(repo.full_name, REPO); }
    for (const [key, expected] of Object.entries({ id: p.jobId, run_id: p.runId, run_attempt: p.runAttempt, head_sha: p.sourceCommit,
      name: `install (${mode})`, status: 'completed', conclusion: 'success' })) assert.equal(job[key], expected);
    assert.ok(job.labels.includes('windows-latest'));
    for (const [key, expected] of Object.entries({ id: p.artifact.id, name: p.artifact.name, size_in_bytes: p.artifact.size,
      digest: `sha256:${p.artifact.sha256}`, expired: false })) assert.equal(a[key], expected);
    for (const [key, expected] of Object.entries({ id: p.runId, head_sha: p.sourceCommit, repository_id: REPO_ID, head_repository_id: REPO_ID })) assert.equal(a.workflow_run[key], expected);
    const times = [job.started_at, a.created_at, job.completed_at].map(Date.parse);
    assert.ok(times.every(Number.isFinite) && times[0] <= times[1] && times[1] <= times[2]);
    const archive = await io.download(`actions/artifacts/${p.artifact.id}/zip`, p.artifact.size + 1);
    assert.equal(archive.length, p.artifact.size); assert.equal(hash(archive), p.artifact.sha256);
    for (const doc of [p.report, p.binding]) assert.ok(q.readZipMember(archive, doc.member).equals(document(doc)));
  }
  return { rawInstallerProtocolVerified: true, productionApproval: false, releaseReady: false };
}
function localAssets(value, directory, executable) {
  const bodies = Object.fromEntries(q.FINAL_ASSETS.map(name => [name, read(path.join(directory, name), name.endsWith('.exe') ? 256 * 1024 * 1024 : 32768)]));
  assert.equal(hash(read(executable, 256 * 1024 * 1024)), value.candidate.executableSha256);
  assert.equal(bodies[q.FINAL_ASSETS[0]].length, value.candidate.installer.size);
  assert.equal(hash(bodies[q.FINAL_ASSETS[0]]), value.candidate.installer.sha256);
  const assets = Object.fromEntries(Object.entries(bodies).map(([name, bytes]) => [name, { size: bytes.length, sha256: hash(bytes) }]));
  q.checkFinalPayload({ candidate: { installerSha256: value.candidate.installer.sha256, executableSha256: value.candidate.executableSha256 }, draft: { assets } }, bodies);
  return { bodies, assets };
}
async function absent(io) {
  const repo = await io.request(''); assert.equal(repo.id, REPO_ID); assert.equal(repo.full_name, REPO); assert.equal(repo.permissions?.push, true);
  for (let page = 1; page <= 10; page++) {
    const releases = await io.request(`releases?per_page=100&page=${page}`); assert.ok(Array.isArray(releases) && releases.length <= 100);
    assert.ok(!releases.some(r => r.tag_name === TAG), 'v0.1.17 already exists; inspect it manually, never overwrite or auto-resume');
    if (releases.length < 100) return;
  }
  throw Error('Could not establish complete release inventory; no draft created');
}
function draftMetadata(release, source, pins) {
  positive(release.id); assert.notEqual(release.id, 432509311); assert.equal(release.tag_name, TAG);
  assert.equal(release.draft, true); assert.equal(release.prerelease, false); assert.equal(release.target_commitish, source);
  assert.equal(release.assets.length, pins ? q.FINAL_ASSETS.length : 0);
  if (!pins) return;
  const ids = new Set();
  for (const name of q.FINAL_ASSETS) {
    const rows = release.assets.filter(a => a.name === name); assert.equal(rows.length, 1); const a = rows[0]; positive(a.id); assert.ok(!ids.has(a.id)); ids.add(a.id);
    assert.equal(a.state, 'uploaded'); assert.equal(a.size, pins[name].size); assert.equal(a.digest, `sha256:${pins[name].sha256}`);
  }
}
function parents(directory) {
  assert.ok(path.isAbsolute(directory)); let current = path.parse(directory).root;
  for (const part of path.relative(current, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part); const s = fs.lstatSync(current); assert.ok(s.isDirectory() && !s.isSymbolicLink());
  }
}
async function stage(value, options, io, verifyLocal = localAssets) {
  validate(value); await verifyRaw(value, io);
  const checked = verifyLocal(value, options.assets, options.executable), notes = read(options.notes, 20000);
  await absent(io);
  const output = path.resolve(options.output); parents(path.dirname(output)); assert.equal(fs.existsSync(output), false, 'Stage attempt exists; retain and review before retry');
  fs.mkdirSync(output); const assetDir = path.join(output, 'assets'); fs.mkdirSync(assetDir);
  for (const name of q.FINAL_ASSETS) fs.writeFileSync(path.join(assetDir, name), checked.bodies[name], { flag: 'wx' });
  fs.writeFileSync(path.join(output, 'intent.json'), JSON.stringify({ version: VERSION, source: value.candidate.sourceCommit,
    assets: checked.assets, notesSha256: hash(notes), productionApproval: false, releaseReady: false }, null, 2), { flag: 'wx' });
  try {
    const release = await io.createDraft({ tag_name: TAG, target_commitish: value.candidate.sourceCommit, draft: true, prerelease: false,
      make_latest: 'false', name: `Creator Hub ${VERSION}`, body: notes.toString('utf8') });
    draftMetadata(release, value.candidate.sourceCommit);
    fs.writeFileSync(path.join(output, 'created.json'), JSON.stringify({ id: release.id, draft: true }), { flag: 'wx' });
    await io.upload(q.FINAL_ASSETS.map(name => path.join(assetDir, name)));
    const uploaded = await io.request(`releases/${release.id}`); draftMetadata(uploaded, value.candidate.sourceCommit, checked.assets);
    const assets = {};
    for (const a of uploaded.assets) {
      const bytes = await io.download(`releases/assets/${a.id}`, a.size + 1);
      assert.ok(bytes.equals(checked.bodies[a.name]), `Remote asset differs: ${a.name}`); assets[a.name] = { id: a.id, size: a.size, sha256: hash(bytes) };
    }
    draftMetadata(await io.request(`releases/${release.id}`), value.candidate.sourceCommit, checked.assets);
    const receipt = { kind: target.draftKind, draftId: release.id, version: VERSION, draft: true,
      initialCompiledSourceTarget: value.candidate.sourceCommit, assets, rawInstallerProtocolVerified: true, signingInvoked: false,
      associationRetargetRequired: true, productionApproval: false, releaseReady: false };
    fs.writeFileSync(path.join(output, 'stage-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' }); return receipt;
  } catch (error) {
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify({ remoteState: 'requires-independent-review', automaticRetry: false,
      productionApproval: false, releaseReady: false }), { flag: 'wx' }); throw error;
  }
}
function services() {
  const execute = (args, input, maxBuffer = 2 * 1024 * 1024) => execFileSync('gh', args, { input, windowsHide: true, timeout: 180000, maxBuffer });
  return {
    request: async route => JSON.parse(execute(['api', '--method', 'GET', `repos/${REPO}${route ? '/' + route : ''}`])),
    download: async (route, max) => execute(['api', `repos/${REPO}/${route}`, ...(route.startsWith('releases/assets/') ? ['-H', 'Accept: application/octet-stream'] : [])], undefined, max),
    createDraft: async payload => JSON.parse(execute(['api', '--method', 'POST', `repos/${REPO}/releases`, '--input', '-'], JSON.stringify(payload))),
    upload: async files => execute(['release', 'upload', TAG, ...files, '--repo', REPO]),
  };
}
module.exports = { hash, document, validate, load, rawReport, verifyRaw, localAssets, absent, stage, services };
if (require.main === module) {
  (async () => {
    const { values } = parseArgs({ options: { receipt: { type: 'string' }, sha256: { type: 'string' }, assets: { type: 'string' },
      executable: { type: 'string' }, notes: { type: 'string' }, output: { type: 'string' }, check: { type: 'boolean' }, stage: { type: 'boolean' } } });
    assert.ok(Boolean(values.check) !== Boolean(values.stage), 'Choose --check or --stage');
    const value = load(values.receipt, values.sha256), io = services();
    if (values.check) return verifyRaw(value, io);
    return stage(value, values, io);
  })().then(result => console.log(JSON.stringify(result)), error => { console.error(`Draft stage refused: ${error.message}`); process.exitCode = 1; });
}
