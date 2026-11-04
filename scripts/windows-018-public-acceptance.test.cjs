'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const profile = require('./windows-release-target.cjs');
test.mock.method(profile, 'getTarget', () => require('./fixtures/windows-release-target-018.cjs'));
const guard = require('./windows-018-public-acceptance.cjs');
const q = require('./windows-016-release-qualification.cjs');
const signature = require('./linux-016-release-qualification.cjs');
const productionVerifySignature = signature.verifySignature;
const { inspectFeed } = require('./check-release-feed.cjs');
const { selectBaseline } = require('./self-update-baselines.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value));

test('public services preserve ZIP bytes without a release-asset Accept header', async () => {
  const calls = [], archive = Buffer.from([0x50, 0x4b, 3, 4, 0x1b, 0, 255]);
  const execute = (command, args, options) => {
    assert.equal(command, 'gh'); assert.equal(options.stdio, 'pipe'); calls.push(args);
    if (args.includes('--help')) return ' --allow-escape-sequences   Allow raw bytes\n';
    if (args.at(-1).endsWith('/zip')) {
      assert.deepEqual(args, ['api', '--allow-escape-sequences', 'repos/BOBWORKS-XR/CREATOR-HUB/actions/artifacts/13279092411/zip']);
      assert.equal(options.maxBuffer, archive.length + 1); return archive;
    }
    if (args.at(-1).includes('/releases/assets/')) {
      assert.ok(args.includes('Accept:application/octet-stream')); return archive;
    }
    assert.ok(!args.includes('-H') && !args.includes('--allow-escape-sequences'));
    return encode({ id: 41736189437 });
  };
  const io = guard.services(execute);
  assert.deepEqual(await io.request('actions/runs/41736189437'), { id: 41736189437 });
  const captured = await io.download('actions/artifacts/13279092411/zip', archive.length + 1);
  assert.ok(captured.equals(archive)); assert.equal(hash(captured), hash(archive));
  assert.deepEqual(await io.download('releases/assets/707135294', archive.length + 1), archive);
  assert.equal(calls.filter(args => args.includes('--help')).length, 1);
});

function fixture(t) {
  const target = profile.getTarget();
  const bodies = Object.fromEntries(q.FINAL_ASSETS.filter(name => !name.endsWith('.exe'))
    .map(name => [name, Buffer.from(`TEST ONLY ${name}`)]));
  const assets = Object.fromEntries(q.FINAL_ASSETS.map((name, i) => [name,
    { id: i + 100, size: bodies[name]?.length || 123, sha256: bodies[name] ? hash(bodies[name]) : 'c'.repeat(64) }]));
  const qualification = { candidate: { sourceCommit: target.source.commit, sourceTree: target.source.tree,
    installerSha256: assets[q.FINAL_ASSETS[0]].sha256, executableSha256: target.rootBuild.executableSha256 }, draft: { id: 401, assets } };
  const binding = { schemaVersion: 1, kind: 'public-014-to-018', version: '0.1.18',
    source: target.source, releaseId: 401, assets, executable: { size: 19371008, sha256: target.rootBuild.executableSha256 },
    manifestSha256: target.rootBuild.manifestSha256, sdkInputs: { packageJsonSha256: 'a'.repeat(64), packageLockSha256: 'b'.repeat(64) },
    resources: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`file-${i}`, hash(Buffer.from(String(i)))])) };
  const bindingBytes = encode(binding), workflow = Buffer.from('TEST ONLY reviewed workflow');
  const pin = { harnessCommit: 'a'.repeat(40), harnessTree: 'b'.repeat(40), workflowSha256: hash(workflow), bindingSha256: hash(bindingBytes) };
  const feedBytes = encode([{ tag_name: 'v0.1.18', draft: false, prerelease: false, assets: q.FINAL_ASSETS.map(name => ({ name })) },
    { tag_name: 'v0.1.14', draft: false, prerelease: false, assets: [] }]);
  const input = { schemaVersion: 1, kind: binding.kind, harnessSource: pin.harnessCommit, bindingSha256: pin.bindingSha256,
    source: binding.source, releaseId: binding.releaseId, assets, executable: binding.executable, resources: binding.resources,
    sdkInputs: binding.sdkInputs, baseline: selectBaseline('0.1.18'), authenticatedDownload: false, lab: false, fixture: false,
    publicFeedUrl: 'https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases?per_page=10',
    publicFeedSha256: hash(feedBytes), feed: inspectFeed(feedBytes, '0.1.18') };
  const rows = Object.entries(binding.resources).map(([name, sha256]) => ({ name: `modules/${name}`, sha256, size: 1 }));
  const report = { kind: binding.kind, passed: true, selfUpdateTested: true, publicDiscovery: true,
    cancelPreserved: true, automaticRestart: true, settingsPreserved: true, managedRouteReconnectTested: true,
    directHubUpdateTested: true, rootCleanupVerified: true, runtimeCleanupVerified: true, policyRestored: true,
    labDiscovery: false, userMachineUsed: false, harnessAdditionalLaunch: false, sourceKind: 'unmodified-public-stable',
    discoveryKind: 'public-github-discovery', harnessSource: pin.harnessCommit, targetSource: binding.source,
    publicBindingSha256: pin.bindingSha256, from: selectBaseline('0.1.18'),
    to: { version: '0.1.18', installer: qualification.candidate.installerSha256, exe: qualification.candidate.executableSha256 },
    originalExitCode: 0, originalPid: 1000, restartedPid: 1001, approvalLowerBoundTicks: '200', sdkConnections: 2,
    beforeRoot: { pid: 1000, startTicks: '100', image: 'C:\\test\\creator-hub.exe', kernelIdentityVerified: true },
    afterRoot: { pid: 1001, startTicks: '300', image: 'C:\\test\\creator-hub.exe', kernelIdentityVerified: true },
    settingsBefore: { hub: 'e'.repeat(64) }, settingsAfter: { hub: 'e'.repeat(64) },
    resourceProbe: { phase: 'after-automatic-root', attempts: 1, passed: true }, installedResources: rows,
    publicProof: { resources: rows, inputBindingSha256: hash(encode(input)), publicFeedUrl: input.publicFeedUrl,
      publicFeedSha256: input.publicFeedSha256, authenticatedDownload: false, bindingSha256: pin.bindingSha256,
      source: binding.source, releaseId: binding.releaseId } };
  const archive = Buffer.from('TEST ONLY archive, member decoding mocked separately');
  const repo = { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' };
  const runId = 100, jobId = 200, artifactId = 300;
  const responses = new Map([
    [`actions/runs/${runId}`, { id: runId, run_attempt: 1, event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
      head_sha: pin.harnessCommit, path: '.github/workflows/self-update-acceptance.yml', repository: repo, head_repository: repo }],
    [`git/commits/${pin.harnessCommit}`, { sha: pin.harnessCommit, tree: { sha: pin.harnessTree } }],
    [`git/trees/${pin.harnessTree}?recursive=1`, { sha: pin.harnessTree, truncated: false, tree: [
      { path: '.github/workflows/self-update-acceptance.yml', type: 'blob', sha: '1'.repeat(40) },
      { path: 'scripts/fixtures/windows-public-018-binding.json', type: 'blob', sha: '2'.repeat(40) }] }],
    [`git/blobs/${'1'.repeat(40)}`, { sha: '1'.repeat(40), encoding: 'base64', content: workflow.toString('base64'), size: workflow.length }],
    [`git/blobs/${'2'.repeat(40)}`, { sha: '2'.repeat(40), encoding: 'base64', content: bindingBytes.toString('base64'), size: bindingBytes.length }],
    [`actions/runs/${runId}/jobs?per_page=100`, { total_count: 1, jobs: [{ id: jobId, name: 'self-update', run_id: runId,
      run_attempt: 1, head_sha: pin.harnessCommit, status: 'completed', conclusion: 'success', labels: ['windows-latest'],
      started_at: '2026-11-03T20:00:00Z', completed_at: '2026-11-03T20:10:00Z' }] }],
    [`actions/runs/${runId}/artifacts?per_page=100`, { artifacts: [{ id: artifactId, name: 'hub-public-self-update', expired: false,
      size_in_bytes: archive.length, digest: 'sha256:' + hash(archive), created_at: '2026-11-03T20:05:00Z',
      workflow_run: { id: runId, head_sha: pin.harnessCommit, repository_id: repo.id, head_repository_id: repo.id } }] }],
  ]);
  t.mock.method(profile, 'getTarget', () => ({ ...target, publicAcceptance: pin }));
  const signatureCalls = [];
  t.mock.method(signature, 'verifySignature', (...args) => { signatureCalls.push(args); });
  const members = { ...bodies, 'public-feed.json': feedBytes };
  t.mock.method(q, 'readZipMember', (bytes, name) => {
    assert.deepEqual(bytes, archive);
    if (name === 'self-update-report.json') return encode(report);
    if (name === 'public-input-binding.json') return encode(input);
    assert.ok(Object.hasOwn(members, name)); return members[name];
  });
  const io = { request: async route => { assert.ok(responses.has(route), route); return responses.get(route); },
    download: async route => { assert.equal(route, `actions/artifacts/${artifactId}/zip`); return archive; } };
  const options = { publicRun: String(runId), publicArtifactSha256: hash(archive), association: 'd'.repeat(40), sha256: 'e'.repeat(64) };
  const review = { ...pin, kind: 'windows-018-public-harness-review', version: '0.1.18', baselineVersion: '0.1.14',
    releaseId: qualification.draft.id, qualificationSha256: options.sha256 };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'public18-review-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const reviewBytes = encode(review);
  options.publicReview = path.join(directory, 'review.json'); options.publicReviewSha256 = hash(reviewBytes);
  fs.writeFileSync(options.publicReview, reviewBytes, { flag: 'wx' });
  return { qualification, binding, report, input, feedBytes, bodies, pin, options, io, responses, signatureCalls };
}

test('public proof verifies exact API provenance, artifact bytes, metadata and runtime evidence', async t => {
  const f = fixture(t), result = await guard.verify(f.qualification, f.options, f.io);
  assert.equal(result.publicAcceptance, true); assert.equal(result.jobId, 200); assert.equal(result.artifactId, 300);
  assert.equal(result.reportSha256, hash(encode(f.report))); assert.equal(f.signatureCalls.length, 1);
});

test('unknown, duplicate, missing-hash and changed resource rows fail closed', () => {
  const pins = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`file-${i}`, 'a'.repeat(64)]));
  const good = Object.keys(pins).map(name => ({ name: `modules/${name}`, sha256: pins[name], size: 1 }));
  guard.resources(good, pins);
  for (const change of [rows => rows.forEach((r, i) => { r.name = `modules/unknown-${i}`; delete r.sha256; }),
    rows => { delete rows[0].sha256; }, rows => { rows[0].name = rows[1].name; },
    rows => { rows[0].sha256 = 'b'.repeat(64); }, rows => { rows[0].size = 0; }]) {
    const rows = structuredClone(good); change(rows); assert.throws(() => guard.resources(rows, pins));
  }
});

test('lab, fixture, wrong target, absent restart, settings, SDK or cleanup evidence refuses', t => {
  const changes = [f => { f.report.labDiscovery = true; }, f => { f.report.fixture = true; },
    f => { f.input.authenticatedDownload = true; }, f => { f.report.to.exe = '0'.repeat(64); },
    f => { f.report.from.version = '0.1.12'; }, f => { f.report.automaticRestart = false; },
    f => { f.report.afterRoot.kernelIdentityVerified = false; }, f => { f.report.afterRoot.startTicks = '100'; },
    f => { delete f.report.settingsBefore; delete f.report.settingsAfter; },
    f => { f.report.settingsAfter = {}; }, f => { f.report.sdkConnections = 1; },
    f => { f.report.rootCleanupVerified = false; }, f => { f.report.resourceProbe.attempts = 2; },
    f => { f.report.pageErrors = ['error']; }, f => { delete f.bodies['SHA256SUMS.txt']; }];
  for (const change of changes) {
    const f = fixture(t); change(f);
    assert.throws(() => guard.validateEvidence(f.qualification, f.binding, f.report, f.input, f.feedBytes, f.bodies, f.pin));
  }
});

test('changed run, checkout, workflow, job or artifact provenance refuses', async t => {
  const changes = [f => { f.responses.get('actions/runs/100').head_sha = '0'.repeat(40); },
    f => { f.responses.get('actions/runs/100').conclusion = 'failure'; },
    f => { f.responses.get(`git/commits/${f.pin.harnessCommit}`).tree.sha = '0'.repeat(40); },
    f => { f.responses.get(`git/blobs/${'1'.repeat(40)}`).content = Buffer.from('tampered').toString('base64'); },
    f => { f.responses.get('actions/runs/100/jobs?per_page=100').jobs[0].conclusion = 'failure'; },
    f => { f.responses.get('actions/runs/100/artifacts?per_page=100').artifacts[0].expired = true; },
    f => { f.options.publicArtifactSha256 = '0'.repeat(64); },
    f => { f.report.publicProof.inputBindingSha256 = '0'.repeat(64); }];
  for (const change of changes) {
    const f = fixture(t); change(f); await assert.rejects(guard.verify(f.qualification, f.options, f.io));
  }
});

test('synthetic signatures cannot pass the production verifier', t => {
  const f = fixture(t); t.mock.method(signature, 'verifySignature', productionVerifySignature);
  assert.throws(() => guard.validateEvidence(f.qualification, f.binding, f.report, f.input, f.feedBytes, f.bodies, f.pin));
});

test('separately reviewed harness receipt requires exact bytes and matching qualification', async t => {
  const f = fixture(t);
  for (const options of [{ ...f.options, publicReviewSha256: '0'.repeat(64) },
    { ...f.options, sha256: '0'.repeat(64) }, { ...f.options, publicReview: undefined }]) {
    await assert.rejects(guard.verify(f.qualification, options, f.io));
  }
  const review = JSON.parse(fs.readFileSync(f.options.publicReview)); review.version = '0.1.19';
  const bytes = encode(review); fs.writeFileSync(f.options.publicReview, bytes);
  await assert.rejects(guard.verify(f.qualification, { ...f.options, publicReviewSha256: hash(bytes) }, f.io));
});
