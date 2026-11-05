'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const api = require('./public-update-020.cjs');
const reader = require('./windows-020-public-acceptance.cjs');
const encode = v => Buffer.from(JSON.stringify(v));
function publishedBinding() {
  const b = structuredClone(api.binding);
  b.publication = { ...structuredClone(b.stagedPublic), tagCommit: b.target.source.commit, draft: false, prerelease: false };
  return b;
}
function loadWith(b) {
  const file = path.join(__dirname, 'public-update-020.cjs'), mod = { exports: {} }, real = createRequire(file);
  new Function('require', 'module', 'exports', '__dirname', fs.readFileSync(file, 'utf8'))(
    n => n === './fixtures/public-update-020-binding.json' ? b : real(n), mod, mod.exports, __dirname);
  return mod.exports;
}
function environment(a = api) {
  return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_JOB: 'acceptance', GITHUB_RUN_ATTEMPT: '1', GITHUB_REF: a.REF,
    GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/.github/workflows/self-update-acceptance.yml@${a.REF}`,
    GITHUB_SHA: 'a'.repeat(40), EXPECTED_HARNESS_COMMIT: 'a'.repeat(40), CREATOR_PUBLIC_BINDING_SHA256: a.bindingSha256,
    CREATOR_PUBLIC_UPDATE_020: '1', CREATOR_SELF_UPDATE_TARGET_VERSION: '0.1.20', CREATOR_OUTGOING_CASE: 'mcp-restore',
    CREATOR_OUTGOING_LAST_TOOL: 'mcp', CREATOR_OUTGOING_RESTORE: 'true' };
}
function feed(b) {
  return encode([{ id: b.publication.releaseId, tag_name: 'v0.1.20', draft: false, prerelease: false,
    assets: Object.entries(b.publication.assets).map(([name, p]) => ({ name, ...p, digest: 'sha256:' + p.sha256, browser_download_url: api.url('0.1.20', name) })) },
  { id: b.baseline.releaseId, tag_name: 'v0.1.19', draft: false, prerelease: false, assets: [{ name: api.BASELINE_ASSET,
    id: b.baseline.assetId, size: b.baseline.installer.bytes, digest: 'sha256:' + b.baseline.installer.sha256,
    browser_download_url: api.url('0.1.19', api.BASELINE_ASSET) }] }]);
}
test('pending binding fails before runtime admission', () => {
  if (!api.binding.publication) assert.throws(() => api.assertAdmission(environment(), 'win32'), /pending/);
  else api.assertAdmission(environment(), 'win32');
});
test('exact finite public metadata accepted in simulation only', () => { const b = publishedBinding(); api.publication(b); api.checkRelease(feed(b), b); });
for (const key of ['HTTPS_PROXY', 'http_proxy', 'NO_PROXY', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'GH_TOKEN',
  'CREATOR_SELF_UPDATE_LAB_CONFIG', 'CREATOR_HOSTED_UPDATE_FIXTURE', 'CREATOR_MIGRATED_PROFILE']) {
  test('rejects environment injection: ' + key, () => {
    const a = loadWith(publishedBinding()); assert.throws(() => a.assertAdmission({ ...environment(a), [key]: 'injected' }, 'win32'));
  });
}
test('rejects self-hosted, wrong hash, wrong case, wrong version and rerun', () => {
  const a = loadWith(publishedBinding()), env = environment(a); a.assertAdmission(env, 'win32');
  for (const patch of [{ RUNNER_ENVIRONMENT: 'self-hosted' }, { EXPECTED_HARNESS_COMMIT: 'b'.repeat(40) },
    { CREATOR_PUBLIC_BINDING_SHA256: 'b'.repeat(64) }, { CREATOR_OUTGOING_RESTORE: 'false' },
    { CREATOR_SELF_UPDATE_TARGET_VERSION: '0.1.21' }, { GITHUB_RUN_ATTEMPT: '2' }]) assert.throws(() => a.assertAdmission({ ...env, ...patch }, 'win32'));
  assert.throws(() => a.assertAdmission(env, 'linux'));
});
test('refuses private draft, wrong installer, missing asset and replayed baseline', () => {
  for (const mutate of [b => b.publication.releaseId = 435162323, b => b.publication.draft = true,
    b => b.publication.assets[api.ASSET].sha256 = 'c'.repeat(64), b => delete b.publication.assets['latest.json']]) {
    const b = publishedBinding(); mutate(b); assert.throws(() => api.publication(b));
  }
  for (const mutate of [r => r[0].draft = true, r => r[0].assets[0].digest = 'bad',
    r => r[0].assets[0].browser_download_url = 'https://localhost/fake', r => r[1].id++,
    r => r[1].tag_name = 'v0.1.18']) {
    const b = publishedBinding(), rows = JSON.parse(feed(b)); mutate(rows);
    assert.throws(() => api.checkRelease(encode(rows), b));
  }
});
test('public network helper rejects lab URL and enforces bound without network', async () => {
  let calls = 0;
  const fetcher = async (url, options) => { calls++; assert.equal(options.headers.Authorization, undefined);
    return { ok: true, body: [Buffer.from('abc')] }; };
  await assert.rejects(api.publicBytes('https://localhost/latest.json', 10, fetcher)); assert.equal(calls, 0);
  await assert.rejects(api.publicBytes(api.FEED, 2, fetcher));
  assert.equal((await api.publicBytes(api.FEED, 3, fetcher)).toString(), 'abc');
});
test('restart is observed, not relaunched or same PID', () => {
  const before = { pid: 1, image: 'C:/test/creator-hub.exe', startTicks: '100', kernelIdentityVerified: true };
  const after = { ...before, pid: 2, startTicks: '300' };
  api.checkRestart(before, after, '200');
  assert.throws(() => api.checkRestart(before, { ...after, pid: 1 }, '200'));
  assert.throws(() => api.checkRestart(before, { ...after, startTicks: '199' }, '200'));
});
test('native driver keeps real cancellation and changed generation guards', () => {
  const text = fs.readFileSync(path.join(__dirname, 'native-public-update-020.cjs'), 'utf8'); new vm.Script(text);
  assert.ok(text.indexOf('target.assertAdmission()') < text.indexOf('target.readConfig('));
  for (const needed of ["button('Not now')", "button('Update Hub')", "active('0.1.19'), report.beforeRoute",
    'target.checkRestart(', 'assert.notEqual(report.afterRoute.generation, report.beforeRoute.generation)',
    'target.assertGenerationProcess', 'await preserved()', 'report.sdkCleanupVerified = true', 'target.verifySdk()']) assert.ok(text.includes(needed), needed);
  assert.ok(!/CREATOR_SELF_UPDATE_LAB_|startLabProxy|self-update-outgoing-019-feed/.test(text));
});
test('finite reader accepts only exact R3 and six staged assets', () => {
  const b = publishedBinding(); const q = { version: '0.1.20', platform: 'windows-x86_64', candidate: {
    sourceCommit: b.target.source.commit, sourceTree: b.target.source.tree, installerSha256: b.target.installer.sha256,
    executableSha256: b.target.executable.sha256 }, draft: { id: b.publication.releaseId, assets: b.publication.assets } };
  reader.requireTarget(q, b);
  for (const mutate of [v => v.version = '0.1.19', v => v.candidate.sourceCommit = 'f'.repeat(40),
    v => v.candidate.executableSha256 = 'f'.repeat(64), v => v.draft.id = 435162323]) {
    const changed = structuredClone(q); mutate(changed); assert.throws(() => reader.requireTarget(changed, b));
  }
});
test('workflow remains manual, read-only and three-case with one aggregate', () => {
  const y = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/self-update-acceptance.yml'), 'utf8');
  assert.ok(y.includes('workflow_dispatch:')); assert.ok(!/\n  push:|contents: write|gh release|build-unified|cargo build/.test(y));
  for (const name of ['mcp-restore', 'setup-restore', 'setup-no-restore', 'hub-public-self-update-020', 'merge-multiple: true']) assert.ok(y.includes(name));
});
function evidenceFixture(caseName = 'mcp-restore') {
  const b = publishedBinding(), a = loadWith(b), env = environment(a);
  const bytes = feed(b), bindingHash = api.hash(encode(b));
  const pin = { harnessCommit: env.GITHUB_SHA, bindingSha256: bindingHash, inputBindingSha256: '' };
  const input = { schemaVersion: 1, kind: b.kind, harnessSource: pin.harnessCommit, bindingSha256: bindingHash,
    source: b.target.source, releaseId: b.publication.releaseId, tagCommit: b.publication.tagCommit,
    publicFeedUrl: api.FEED, publicFeedSha256: api.hash(bytes), feed: api.checkRelease(bytes, b),
    baseline: a.configFor(path.resolve('artifacts/public-update-020-input')).baseline,
    pins: a.configFor(path.resolve('artifacts/public-update-020-input')).pins,
    authenticatedDownload: false, lab: false, fixture: false };
  pin.inputBindingSha256 = api.hash(encode(input));
  const proc = (pid, version, ticks = '100') => ({ pid, startTicks: ticks, kernelIdentityVerified: true,
    image: `C:/test/runtime-generations/windows-x86_64/${b[version].generation}/mcp/server/runtime/node.exe` });
  const rootProc = (pid, ticks) => ({ pid, startTicks: ticks, kernelIdentityVerified: true, image: 'C:/test/creator-hub.exe' });
  const route = item => ({ schemaVersion: 1, descriptorSha256: item.manifest.managedRouting.files['routing/runtime.json'], generation: item.generation });
  const restore = api.CASES[caseName][1] === 'true';
  const settings = { 'test-only-settings': { exists: true, sha256: 'c'.repeat(64) } };
  const preferences = { 'auto-download': false, 'preview-channel': false, 'restore-hosted-views': restore };
  const report = { kind: b.kind, harnessSource: pin.harnessCommit, sourceCommit: b.target.source.commit,
    baseline: input.baseline, lastTool: api.CASES[caseName][0], restore, restoredLastTool: restore ? api.CASES[caseName][0] : null,
    beforePeVersion: [0, 1, 19, 0], afterPeVersion: [0, 1, 20, 0], beforeRoot: rootProc(10, '100'), afterRoot: rootProc(20, '300'), approvalLowerBoundTicks: '200',
    resourceProbe: { phase: 'after-automatic-root', attempts: 1, passed: true }, beforeRoute: route(b.baseline), afterRoute: route(b.target),
    heldServerVersion: { version: '2.7.7' }, reconnectedServerVersion: { version: '2.7.8' },
    heldProcessesBefore: [proc(30, 'baseline'), proc(31, 'baseline')], heldProcessesAfter: [proc(30, 'baseline'), proc(31, 'baseline')],
    reconnectedProcesses: [proc(40, 'target', '400'), proc(41, 'target', '400')],
    settingsBefore: settings, settingsAfter: settings, preferencesBefore: preferences, preferencesAfter: preferences,
    publicProof: { ...input, inputBindingSha256: pin.inputBindingSha256 } };
  for (const k of ['passed', 'publicDiscovery', 'nativeUpdateAccepted', 'automaticRestart', 'cancelPreserved', 'settingsPreserved',
    'existingConnectionSurvived', 'newConnectionVerified', 'restorationVerified', 'changedMcpGenerationProven',
    'installedResourcesVerifiedBeforeAndAfter', 'heldGenerationRetained', 'activeRouteUnchangedAfterCancel',
    'sdkCleanupVerified', 'rootCleanupVerified', 'sentinelCleanupVerified', 'policyRestored']) report[k] = true;
  for (const k of ['labDiscovery', 'liveAiAcceptance', 'releaseReady', 'harnessAdditionalLaunch', 'userMachineUsed']) report[k] = false;
  const q = { version: '0.1.20', platform: 'windows-x86_64', candidate: { sourceCommit: b.target.source.commit,
    sourceTree: b.target.source.tree, installerSha256: b.target.installer.sha256, executableSha256: b.target.executable.sha256 },
    draft: { id: b.publication.releaseId, assets: b.publication.assets } };
  const bodies = Object.fromEntries(api.ASSETS.filter(n => n !== api.ASSET).map(n => [n, fs.readFileSync(path.join(__dirname, 'fixtures/public020', n))]));
  return { b, q, pin, input, report, bytes, bodies, caseName };
}
function validate(f) { return reader.validateEvidence(f.q, f.b, f.report, f.input, f.bytes, f.bodies, f.pin, f.caseName); }
test('reader checks all three synthetic case reports against real staged sidecars', () => {
  for (const name of reader.CASES) validate(evidenceFixture(name));
});
test('reader rejects changed settings, lab evidence, stale generation, source, cleanup and sidecar', () => {
  for (const mutate of [f => f.report.settingsAfter = {}, f => f.report.labDiscovery = true,
    f => f.report.afterRoute.generation = f.b.baseline.generation, f => f.report.reconnectedServerVersion.version = '2.7.7',
    f => f.report.sourceCommit = 'b'.repeat(40), f => f.report.sdkCleanupVerified = false,
    f => f.bodies['latest.json'] = Buffer.from('{}'), f => f.report.heldProcessesAfter = []]) {
    const f = evidenceFixture(); mutate(f); assert.throws(() => validate(f));
  }
});
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
function remoteFixture() {
  const cases = reader.CASES.map(n => evidenceFixture(n)), f = cases[0];
  const bindingBytes = encode(f.b), workflow = fs.readFileSync(path.resolve(__dirname, '../.github/workflows/self-update-acceptance.yml'));
  const review = { kind: 'windows-020-public-harness-review', version: '0.1.20', baselineVersion: '0.1.19',
    releaseId: f.q.draft.id, qualificationSha256: 'd'.repeat(64), harnessCommit: f.pin.harnessCommit,
    harnessTree: 'c'.repeat(40), workflowSha256: api.hash(workflow), bindingSha256: api.hash(bindingBytes) };
  const rows = cases.flatMap(c => [[`${c.caseName}/outgoing-report.json`, encode(c.report)],
    [`${c.caseName}/public-input-binding.json`, encode(c.input)], [`${c.caseName}/public-feed.json`, c.bytes],
    ...Object.entries(c.bodies).map(([name, bytes]) => [`${c.caseName}/${name}`, bytes])]);
  const archive = zip(rows), directory = fs.mkdtempSync(path.join(__dirname, 'reader-fixture-'));
  const options = { publicRun: '100', publicArtifactSha256: api.hash(archive), publicReview: path.join(directory, 'review.json'),
    publicReviewSha256: api.hash(encode(review)), sha256: review.qualificationSha256, association: f.b.publication.tagCommit };
  fs.writeFileSync(options.publicReview, encode(review), { flag: 'wx' });
  const repo = { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' };
  const jobs = [...reader.CASES.map(n => 'acceptance-' + n), 'evidence'].map((name, i) => ({ id: i + 1, name, run_id: 100,
    run_attempt: 1, head_sha: review.harnessCommit, status: 'completed', conclusion: 'success',
    labels: [name === 'evidence' ? 'ubuntu-latest' : 'windows-latest'], started_at: '2026-11-05T10:00:00Z', completed_at: '2026-11-05T10:02:00Z' }));
  const responses = new Map([
    ['actions/runs/100', { id: 100, run_attempt: 1, event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
      head_sha: review.harnessCommit, head_branch: 'validation/windows-public-update-020-20261105', path: reader.WORKFLOW, repository: repo, head_repository: repo }],
    [`git/commits/${review.harnessCommit}`, { sha: review.harnessCommit, tree: { sha: review.harnessTree } }],
    [`git/trees/${review.harnessTree}?recursive=1`, { sha: review.harnessTree, truncated: false, tree: [
      { type: 'blob', path: reader.WORKFLOW, sha: 'e'.repeat(40) }, { type: 'blob', path: reader.BINDING, sha: 'f'.repeat(40) }] }],
    [`git/blobs/${'e'.repeat(40)}`, { sha: 'e'.repeat(40), encoding: 'base64', size: workflow.length, content: workflow.toString('base64') }],
    [`git/blobs/${'f'.repeat(40)}`, { sha: 'f'.repeat(40), encoding: 'base64', size: bindingBytes.length, content: bindingBytes.toString('base64') }],
    ['actions/runs/100/jobs?per_page=100', { total_count: 4, jobs }],
    ['actions/runs/100/artifacts?per_page=100', { artifacts: [{ id: 500, name: 'hub-public-self-update-020', size_in_bytes: archive.length,
      expired: false, digest: 'sha256:' + api.hash(archive), created_at: '2026-11-05T10:01:00Z',
      workflow_run: { id: 100, head_sha: review.harnessCommit, repository_id: repo.id, head_repository_id: repo.id } }] }],
  ]);
  const io = { request: async r => { assert.ok(responses.has(r), r); return responses.get(r); },
    download: async (r, bound) => { assert.equal(r, 'actions/artifacts/500/zip'); assert.equal(bound, archive.length + 1); return archive; } };
  return { ...f, io, options, responses };
}
test('verify(qualification, options) reads one aggregate with all three original reports', async () => {
  const f = remoteFixture(), result = await reader.verify(f.q, f.options, f.io);
  assert.equal(result.publicAcceptance, true); assert.equal(result.version, '0.1.20');
  assert.equal(result.association, f.options.association); assert.equal(result.qualificationSha256, f.options.sha256);
  assert.deepEqual(result.cases.map(c => c.case), reader.CASES);
});
test('remote reader refuses failed jobs, wrong repo, artifact replay, and archive corruption', async () => {
  for (const mutate of [f => f.responses.get('actions/runs/100').head_repository.id++,
    f => f.responses.get('actions/runs/100/jobs?per_page=100').jobs[0].conclusion = 'failure',
    f => f.responses.get('actions/runs/100/artifacts?per_page=100').artifacts[0].workflow_run.id++,
    f => f.options.publicArtifactSha256 = 'f'.repeat(64), f => f.options.association = 'f'.repeat(40)]) {
    const f = remoteFixture(); mutate(f); await assert.rejects(reader.verify(f.q, f.options, f.io));
  }
});
