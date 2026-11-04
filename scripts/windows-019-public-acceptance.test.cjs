'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const guard = require('./windows-019-public-acceptance.cjs');
const q = require('./windows-016-release-qualification.cjs');
const profile = require('./windows-release-target.cjs');
const signature = require('./linux-016-release-qualification.cjs');
const realVerifySignature = signature.verifySignature;
const { updaterManifest } = require('./release-descriptor.cjs');
const { inspectFeed } = require('./check-release-feed.cjs');
const { selectBaseline } = require('./self-update-baselines.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const digest = s => hash(Buffer.from('TEST ONLY ' + s));
const encode = value => Buffer.from(JSON.stringify(value));
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
  const target = structuredClone(profile.getTarget());
  target.source = { commit: '7'.repeat(40), tree: '8'.repeat(40) }; target.parent = '9'.repeat(40);
  target.cleanBuild.installerSha256 = digest('installer'); target.cleanBuild.executableSha256 = digest('installed EXE');
  target.cleanBuild.manifestSha256 = digest('manifest');
  t.mock.method(profile, 'getTarget', () => target);
  const encodedSignature = Buffer.from('untrusted comment: TEST ONLY installer signature\nnot-a-real-signature').toString('base64');
  const bodies = {
    [guard.ASSETS[1]]: Buffer.from(encodedSignature + '\n'),
    'creator-hub-windows-x86_64.json': encode({ schemaVersion: 1, appId: 'creator-hub', version: target.version,
      platform: 'windows', architecture: 'x86_64', packageType: 'nsis', assetName: guard.ASSETS[0], byteLength: 123,
      sha256: target.cleanBuild.installerSha256, executableSha256: target.cleanBuild.executableSha256,
      identityProtocol: 0, lifecycleProtocol: 0, installerProtocol: 1, minHubVersion: target.minimumHub }),
    'creator-hub-windows-x86_64.json.minisig': Buffer.from('TEST ONLY descriptor signature'),
    'latest.json': encode(updaterManifest({ repo: 'CREATOR-HUB' }, target.version, guard.ASSETS[0], encodedSignature)),
  };
  const assets = Object.fromEntries(guard.ASSETS.map((name, i) => [name, { id: i + 100, size: 123, sha256: digest(name) }]));
  assets[guard.ASSETS[0]].sha256 = target.cleanBuild.installerSha256;
  const qualification = { candidate: { sourceCommit: target.source.commit, sourceTree: target.source.tree,
    installerSha256: target.cleanBuild.installerSha256, executableSha256: target.cleanBuild.executableSha256 }, draft: { id: 401, assets } };
  const binding = { schemaVersion: 1, kind: 'public-018-to-019', version: target.version, source: target.source,
    releaseId: 401, assets, executable: { size: 321, sha256: target.cleanBuild.executableSha256 },
    manifestSha256: target.cleanBuild.manifestSha256,
    sdkInputs: { packageJsonSha256: digest('sdk package'), packageLockSha256: digest('sdk lock') },
    resources: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`file-${i}`, digest('resource ' + i)])) };
  const workflow = Buffer.from('TEST ONLY reviewed public workflow'), pin = {
    harnessCommit: 'a'.repeat(40), harnessTree: 'b'.repeat(40), workflowSha256: hash(workflow), bindingSha256: '' };
  const baseline = selectBaseline('0.1.19');
  const input = { schemaVersion: 1, kind: binding.kind, harnessSource: pin.harnessCommit, bindingSha256: '', source: binding.source,
    releaseId: binding.releaseId, assets, executable: binding.executable, resources: binding.resources, sdkInputs: binding.sdkInputs,
    baseline, authenticatedDownload: false, lab: false, fixture: false,
    publicFeedUrl: 'https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases?per_page=10' };
  const rows = Object.entries(binding.resources).map(([name, sha256]) => ({ name: `modules/${name}`, sha256, size: 1 }));
  const report = { kind: binding.kind, passed: true, selfUpdateTested: true, publicDiscovery: true, cancelPreserved: true,
    automaticRestart: true, settingsPreserved: true, managedRouteReconnectTested: true, directHubUpdateTested: true,
    rootCleanupVerified: true, runtimeCleanupVerified: true, policyRestored: true, labDiscovery: false,
    userMachineUsed: false, harnessAdditionalLaunch: false, sourceKind: 'unmodified-public-stable', discoveryKind: 'public-github-discovery',
    harnessSource: pin.harnessCommit, targetSource: binding.source, publicBindingSha256: '', from: { ...baseline },
    to: { version: target.version, installer: qualification.candidate.installerSha256, exe: qualification.candidate.executableSha256 },
    originalExitCode: 0, originalPid: 1000, restartedPid: 1001, approvalLowerBoundTicks: '200', sdkConnections: 2,
    beforeRoot: { pid: 1000, startTicks: '100', image: 'C:\\test\\creator-hub.exe', kernelIdentityVerified: true },
    afterRoot: { pid: 1001, startTicks: '300', image: 'C:\\test\\creator-hub.exe', kernelIdentityVerified: true },
    settingsBefore: { hub: digest('settings') }, settingsAfter: { hub: digest('settings') },
    resourceProbe: { phase: 'after-automatic-root', attempts: 1, passed: true }, installedResources: rows,
    publicProof: { resources: rows, publicFeedUrl: input.publicFeedUrl, authenticatedDownload: false,
      source: binding.source, releaseId: binding.releaseId } };
  const repo = { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' }, responses = new Map(), calls = [];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'public19-review-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const options = { publicRun: '100', association: 'd'.repeat(40), sha256: digest('qualification'), publicReview: path.join(directory, 'review.json') };
  const review = { ...pin, kind: 'windows-019-public-harness-review', version: '0.1.19', baselineVersion: '0.1.18',
    releaseId: 401, qualificationSha256: options.sha256 };
  const f = { target, bodies, assets, qualification, binding, input, report, pin, options, review, calls, responses };
  const sigCalls = []; t.mock.method(signature, 'verifySignature', (...args) => sigCalls.push(args)); f.sigCalls = sigCalls;
  f.refresh = () => {
    for (const [name, body] of Object.entries(bodies)) if (name !== 'SHA256SUMS.txt') assets[name] = { ...assets[name], size: body.length, sha256: hash(body) };
    bodies['SHA256SUMS.txt'] = Buffer.from(guard.ASSETS.filter(n => n !== 'SHA256SUMS.txt').sort().map(n => `${assets[n].sha256}  ${n}\n`).join(''));
    assets['SHA256SUMS.txt'] = { ...assets['SHA256SUMS.txt'], size: bodies['SHA256SUMS.txt'].length, sha256: hash(bodies['SHA256SUMS.txt']) };
    const bindingBytes = encode(binding); pin.bindingSha256 = hash(bindingBytes); review.bindingSha256 = pin.bindingSha256;
    report.publicBindingSha256 = pin.bindingSha256; input.bindingSha256 = pin.bindingSha256;
    f.feedBytes = encode([{ id: 401, tag_name: 'v0.1.19', draft: false, prerelease: false,
      assets: guard.ASSETS.map(name => ({ name, ...assets[name], digest: `sha256:${assets[name].sha256}` })) },
    { id: 400, tag_name: 'v0.1.18', draft: false, prerelease: false, assets: [] }]);
    input.feed = inspectFeed(f.feedBytes, '0.1.19'); input.publicFeedSha256 = hash(f.feedBytes);
    report.publicProof.publicFeedSha256 = hash(f.feedBytes); report.publicProof.bindingSha256 = pin.bindingSha256;
    const inputBytes = encode(input); report.publicProof.inputBindingSha256 = hash(inputBytes);
    const reviewBytes = encode(review); fs.writeFileSync(options.publicReview, reviewBytes); options.publicReviewSha256 = hash(reviewBytes);
    f.archive = zip(Object.entries({ ...bodies, 'public-feed.json': f.feedBytes, 'self-update-report.json': encode(report), 'public-input-binding.json': inputBytes }));
    options.publicArtifactSha256 = hash(f.archive);
    responses.set('actions/runs/100', { id: 100, run_attempt: 1, event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
      head_sha: pin.harnessCommit, path: '.github/workflows/self-update-acceptance.yml', repository: repo, head_repository: repo });
    responses.set(`git/commits/${pin.harnessCommit}`, { sha: pin.harnessCommit, tree: { sha: pin.harnessTree } });
    responses.set(`git/trees/${pin.harnessTree}?recursive=1`, { sha: pin.harnessTree, truncated: false, tree: [
      { path: '.github/workflows/self-update-acceptance.yml', type: 'blob', sha: '1'.repeat(40) },
      { path: 'scripts/fixtures/windows-public-019-binding.json', type: 'blob', sha: '2'.repeat(40) }] });
    for (const [id, body] of [['1', workflow], ['2', bindingBytes]]) responses.set(`git/blobs/${id.repeat(40)}`,
      { sha: id.repeat(40), encoding: 'base64', content: body.toString('base64'), size: body.length });
    responses.set('actions/runs/100/jobs?per_page=100', { total_count: 1, jobs: [{ id: 200, name: 'self-update', run_id: 100,
      run_attempt: 1, head_sha: pin.harnessCommit, status: 'completed', conclusion: 'success', labels: ['windows-latest'],
      started_at: '2026-11-04T10:00:00Z', completed_at: '2026-11-04T10:10:00Z' }] });
    responses.set('actions/runs/100/artifacts?per_page=100', { artifacts: [{ id: 300, name: 'hub-public-self-update', expired: false,
      size_in_bytes: f.archive.length, digest: 'sha256:' + hash(f.archive), created_at: '2026-11-04T10:05:00Z',
      workflow_run: { id: 100, head_sha: pin.harnessCommit, repository_id: repo.id, head_repository_id: repo.id } }] });
  };
  f.io = { request: async route => { calls.push(route); assert.ok(responses.has(route), route); return responses.get(route); },
    download: async route => { calls.push(route); assert.equal(route, 'actions/artifacts/300/zip'); return f.archive; } };
  f.refresh(); return f;
}
test('exact PUBLIC18 to current019 proof verifies original ZIP and five metadata bodies', async t => {
  const f = fixture(t), result = await guard.verify(f.qualification, f.options, f.io);
  assert.equal(result.version, '0.1.19'); assert.equal(result.publicAcceptance, true);
  assert.equal(result.artifactId, 300); assert.equal(f.sigCalls.length, 1);
});
test('wrong active target, source, installer or six-asset inventory refuses before transport', async t => {
  for (const change of [f => { f.target.version = '0.1.18'; }, f => { f.target.predecessor = '0.1.14'; },
    f => { f.qualification.candidate.sourceCommit = '6'.repeat(40); }, f => { f.qualification.candidate.sourceTree = '6'.repeat(40); },
    f => { f.qualification.candidate.installerSha256 = digest('old'); }, f => { f.qualification.candidate.executableSha256 = digest('old'); },
    f => { delete f.assets[guard.ASSETS[1]]; }, f => { f.assets.extra = { id: 999, size: 1, sha256: digest('extra') }; }]) {
    const f = fixture(t); change(f); await assert.rejects(guard.verify(f.qualification, f.options, f.io)); assert.deepEqual(f.calls, []);
  }
});
test('PUBLIC14, lab, manual restart and missing preservation cannot qualify PUBLIC18 acceptance', t => {
  for (const change of [f => { f.report.from = selectBaseline('0.1.18'); }, f => { f.report.labDiscovery = true; },
    f => { f.report.fixture = true; }, f => { f.report.publicDiscovery = false; }, f => { f.report.cancelPreserved = false; },
    f => { f.report.automaticRestart = false; }, f => { f.report.harnessAdditionalLaunch = true; },
    f => { f.report.afterRoot.startTicks = '100'; }, f => { f.report.afterRoot.kernelIdentityVerified = false; },
    f => { f.report.settingsAfter = {}; }, f => { f.report.sdkConnections = 1; },
    f => { f.report.rootCleanupVerified = false; }, f => { f.report.runtimeCleanupVerified = false; },
    f => { f.report.resourceProbe.attempts = 2; }, f => { f.report.installedResources[0].sha256 = digest('wrong resource'); },
    f => { f.input.authenticatedDownload = true; }, f => { f.report.pageErrors = ['error']; }]) {
    const f = fixture(t); change(f);
    assert.throws(() => guard.validateEvidence(f.qualification, f.binding, f.report, f.input, f.feedBytes, f.bodies, f.pin));
  }
});
test('repinned metadata cannot change protocol, installed EXE, updater URL or installer signature relationship', t => {
  for (const change of [f => { const d = JSON.parse(f.bodies['creator-hub-windows-x86_64.json']); d.installerProtocol = 0; f.bodies['creator-hub-windows-x86_64.json'] = encode(d); },
    f => { const d = JSON.parse(f.bodies['creator-hub-windows-x86_64.json']); d.executableSha256 = digest('other exe'); f.bodies['creator-hub-windows-x86_64.json'] = encode(d); },
    f => { const d = JSON.parse(f.bodies['creator-hub-windows-x86_64.json']); d.minHubVersion = '0.1.18'; f.bodies['creator-hub-windows-x86_64.json'] = encode(d); },
    f => { const d = JSON.parse(f.bodies['latest.json']); d.platforms['windows-x86_64'].url = 'https://invalid.example/installer'; f.bodies['latest.json'] = encode(d); },
    f => { f.bodies[guard.ASSETS[1]] = Buffer.from('old installer signature'); }]) {
    const f = fixture(t); change(f); f.refresh();
    assert.throws(() => guard.validateEvidence(f.qualification, f.binding, f.report, f.input, f.feedBytes, f.bodies, f.pin));
  }
});
test('run, job, branch-tree binding, artifact and original review drift all refuse', async t => {
  for (const change of [f => { f.responses.get('actions/runs/100').head_sha = '0'.repeat(40); },
    f => { f.responses.get('actions/runs/100').conclusion = 'failure'; },
    f => { f.responses.get('actions/runs/100/jobs?per_page=100').jobs[0].conclusion = 'failure'; },
    f => { f.responses.get(`git/blobs/${'2'.repeat(40)}`).content = Buffer.from('{}').toString('base64'); },
    f => { f.responses.get('actions/runs/100/artifacts?per_page=100').artifacts[0].expired = true; },
    f => { f.archive = Buffer.from('changed ZIP'); }, f => { f.options.publicReviewSha256 = digest('wrong review'); }]) {
    const f = fixture(t); change(f); await assert.rejects(guard.verify(f.qualification, f.options, f.io));
  }
});
test('synthetic descriptor signature is refused by the real verifier', t => {
  const f = fixture(t); t.mock.method(signature, 'verifySignature', realVerifySignature);
  assert.throws(() => guard.validateEvidence(f.qualification, f.binding, f.report, f.input, f.feedBytes, f.bodies, f.pin));
});
test('wrong public feed asset identity or old baseline cannot be hidden by a matching input hash', t => {
  for (const change of [r => { r[0].assets.pop(); }, r => { r[0].assets[0].id = 999; }, r => { r[0].assets[0].digest = 'sha256:' + digest('bad'); },
    r => { r[0].id = 999; }, r => { r[1].tag_name = 'v0.1.14'; }]) {
    const f = fixture(t), releases = JSON.parse(f.feedBytes); change(releases); f.feedBytes = encode(releases);
    f.input.feed = inspectFeed(f.feedBytes, '0.1.19'); f.input.publicFeedSha256 = hash(f.feedBytes); f.report.publicProof.publicFeedSha256 = hash(f.feedBytes);
    assert.throws(() => guard.validateEvidence(f.qualification, f.binding, f.report, f.input, f.feedBytes, f.bodies, f.pin));
  }
});
function publisher(version, readers) {
  const file = require.resolve('./publish-hub-draft.cjs'), local = createRequire(file), module = { exports: {} };
  vm.runInThisContext('(function(require,module,exports,__filename,__dirname){' + fs.readFileSync(file, 'utf8') + '\n})', { filename: file })(
    name => name === './windows-release-target.cjs' ? { getTarget: () => ({ version }) }
      : readers[name] || local(name), module, module.exports, file, path.dirname(file));
  return module.exports;
}
for (const version of ['0.1.18', '0.1.19']) test(`publisher selects only the ${version} public reader without publishing`, async () => {
  const calls = [], options = { platform: 'windows-x86_64', association: 'a'.repeat(40), sha256: digest('q'), promoteLatest: false };
  const qualified = { draft: { id: 401 } };
  const readers = Object.fromEntries(['018', '019'].map(v => [`./windows-${v}-public-acceptance.cjs`, { verify: async () => {
    calls.push(v); return { publicAcceptance: true, version: `0.1.${Number(v)}`, releaseId: 401, association: options.association, qualificationSha256: options.sha256 };
  } }]));
  const result = await publisher(version, readers).finishPublicRelease(version, {
    checkReadiness: () => qualified,
    verifyPublishedQualification: async () => ({ releaseIsPublic: true, sourceCiVerified: true, nativeEvidenceVerified: true,
      signaturesVerified: true, releaseAssociationVerified: true, associationBuilt: false, releaseAssociationCommit: options.association,
      qualificationSha256: options.sha256, draftId: 401, version, platform: options.platform }),
    checkLive: async () => ({ previousStable: selectBaseline(version).version }),
    promote: () => assert.fail('No promotion allowed'), getLatest: () => assert.fail('No latest lookup allowed'),
  }, options);
  assert.equal(result.ready, false); assert.deepEqual(calls, [version === '0.1.19' ? '019' : '018']);
});
test('public19 association files are required only in the new release profile', () => {
  for (const version of ['0.1.18', '0.1.19']) {
    const file = require.resolve('./windows-016-release-qualification.cjs'), local = createRequire(file), module = { exports: {} };
    const p = { ...profile.getTarget(), version };
    vm.runInThisContext('(function(require,module,exports){' + fs.readFileSync(file, 'utf8') + '\nmodule.exports.allowed=ASSOCIATION_FILES;})')(
      name => name === './windows-release-target.cjs' ? { getTarget: () => p } : local(name), module, module.exports);
    assert.equal(module.exports.allowed.includes('scripts/windows-019-public-acceptance.cjs'), version === '0.1.19');
    assert.equal(module.exports.allowed.includes('scripts/windows-019-public-acceptance.test.cjs'), version === '0.1.19');
  }
});
