'use strict';
// Read-only evidence reader. Qualification/source authority remains with the parent.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const REVIEW = require('./windows-022-review.json');
assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'windows-022-review.json'))).digest('hex'), 'e164c010e565c86edd1d299e31c1bbd06607f1e28e63f8fc3663b6e8635ce29d', 'Reviewed pins changed');
const { execFileSync } = require('node:child_process');
const public20 = require('./windows-022-public-contract.cjs');
const archiveTools = require('./public-update-evidence-io.cjs');
const { hash } = public20;
const WORKFLOW = '.github/workflows/self-update-acceptance.yml';
const BINDING = 'scripts/fixtures/public-update-022-binding.json';
const REPO = 'BOBWORKS-XR/CREATOR-HUB';
const CASES = ['mcp-restore', 'setup-restore', 'setup-no-restore'];
function positive(n) { assert.ok(Number.isSafeInteger(n) && n > 0); }
function digest(s, n = 64) { assert.match(s || '', new RegExp(`^[a-f0-9]{${n}}$`)); assert.notEqual(s, '0'.repeat(n)); }
function requireTarget(q, b) {
  assert.equal(q.version, '0.1.22'); assert.equal(q.platform, 'windows-x86_64');
  const c = q.candidate;
  assert.equal(c.sourceCommit, REVIEW.sourceCommit);
  assert.equal(c.sourceTree, REVIEW.sourceTree);
  assert.equal(c.installerSha256, REVIEW.installerSha256);
  assert.equal(c.executableSha256, REVIEW.executableSha256);
  positive(q.draft.id); assert.equal(q.draft.id, REVIEW.draftId);
  assert.deepEqual(Object.keys(q.draft.assets).sort(), [...public20.ASSETS].sort());
  assert.equal(q.draft.assets['latest.json'].sha256, REVIEW.latestSha256);
  if (b) {
    public20.publication(b);
    assert.equal(b.publication.releaseId, q.draft.id); assert.deepEqual(b.publication.assets, q.draft.assets);
    assert.deepEqual(b.target.source, { commit: c.sourceCommit, tree: c.sourceTree });
    assert.equal(b.target.installer.sha256, c.installerSha256); assert.equal(b.target.executable.sha256, c.executableSha256);
    assert.equal(b.baseline.installer.sha256, "09dd6563e5e93a533f7ddedc600c785f56d123f55d1e29a8eada6ab3941cf2b3");
    assert.equal(b.baseline.executable.sha256, "b29fe05699196383bbd376f23af934fe9f603761c3de285f16e6c4a3095222f5");
    assert.equal(b.baseline.manifest.modules.mcp.version, '2.7.9'); assert.equal(b.target.manifest.modules.mcp.version, '2.7.9');
    for (const item of [b.baseline, b.target]) {
      const m = item.manifest.modules.mcp;
      const generation = hash(JSON.stringify({ executable: m.executable, version: m.version,
        files: Object.fromEntries(Object.entries(m.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) }));
      assert.equal(item.generation, generation);
    }
    assert.deepEqual(b.target.manifest, REVIEW.manifest);
  }
}
function loadReview(file, expectedHash, q) {
  requireTarget(q); digest(expectedHash);
  const s = fs.lstatSync(file); assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size > 0 && s.size <= 16384);
  const bytes = fs.readFileSync(file); assert.equal(bytes.length, s.size); assert.equal(hash(bytes), expectedHash);
  const r = JSON.parse(bytes);
  assert.deepEqual(Object.keys(r).sort(), ['kind', 'version', 'baselineVersion', 'releaseId', 'qualificationSha256',
    'harnessCommit', 'harnessTree', 'workflowSha256', 'bindingSha256'].sort());
  assert.equal(r.kind, 'windows-022-public-harness-review'); assert.equal(r.version, '0.1.22'); assert.equal(r.baselineVersion, '0.1.21');
  assert.equal(r.releaseId, q.draft.id); digest(r.harnessCommit, 40); digest(r.harnessTree, 40);
  for (const k of ['qualificationSha256', 'workflowSha256', 'bindingSha256']) digest(r[k]); return r;
}
function route(actual, item) {
  assert.deepEqual(actual, { schemaVersion: 1, descriptorSha256: item.manifest.managedRouting.files['routing/runtime.json'], generation: item.generation });
}
function validateEvidence(q, b, report, input, feedBytes, bodies, pin, caseName) {
  requireTarget(q, b); assert.ok(CASES.includes(caseName));
  const expected = public20.CASES[caseName]; assert.equal(report.lastTool, expected[0]); assert.equal(report.restore, expected[1] === 'true');
  for (const k of ['passed', 'publicDiscovery', 'nativeUpdateAccepted', 'automaticRestart', 'cancelPreserved', 'settingsPreserved',
    'existingConnectionSurvived', 'newConnectionVerified', 'restorationVerified', 'targetMcpRuntimeVerified',
    'installedResourcesVerifiedBeforeAndAfter', 'heldGenerationRetained', 'activeRouteUnchangedAfterCancel',
    'sdkCleanupVerified', 'rootCleanupVerified', 'sentinelCleanupVerified', 'policyRestored']) assert.equal(report[k], true, k);
  for (const k of ['labDiscovery', 'liveAiAcceptance', 'releaseReady', 'harnessAdditionalLaunch', 'userMachineUsed']) assert.equal(report[k], false, k);
  for (const [k, v] of Object.entries(report)) if (/error|failed|fixture|migratedContinuation/i.test(k)) assert.ok(!v || (Array.isArray(v) && !v.length), k);
  assert.deepEqual(report.pageErrors || [], []); assert.equal(report.kind, 'public-021-to-022');
  assert.ok(report.settingsBefore && Object.keys(report.settingsBefore).length > 0);
  assert.deepEqual(report.settingsBefore, report.settingsAfter); assert.deepEqual(report.preferencesBefore, report.preferencesAfter);
  assert.deepEqual(report.preferencesBefore, { 'auto-download': false, 'preview-channel': false, 'restore-hosted-views': expected[1] === 'true' });
  assert.equal(report.harnessSource, pin.harnessCommit); assert.equal(report.sourceCommit, b.target.source.commit);
  assert.deepEqual(report.baseline, { version: '0.1.21', installer: b.baseline.installer.sha256, exe: b.baseline.executable.sha256 });
  assert.deepEqual(report.beforePeVersion, [0, 1, 21, 0]); assert.deepEqual(report.afterPeVersion, [0, 1, 22, 0]);
  public20.checkRestart(report.beforeRoot, report.afterRoot, report.approvalLowerBoundTicks);
  assert.deepEqual(report.resourceProbe, { phase: 'after-automatic-root', attempts: 1, passed: true });
  route(report.beforeRoute, b.baseline); route(report.afterRoute, b.target);
  assert.equal(report.heldServerVersion.version, '2.7.9'); assert.equal(report.reconnectedServerVersion.version, '2.7.9');
  assert.equal(report.heldProcessesBefore.length, 2); assert.equal(report.reconnectedProcesses.length, 2);
  assert.deepEqual(report.heldProcessesAfter, report.heldProcessesBefore);
  const oldNode = report.heldProcessesBefore[1], newNode = report.reconnectedProcesses[1];
  for (const record of [...report.heldProcessesBefore, ...report.reconnectedProcesses]) {
    positive(record.pid); assert.equal(record.kernelIdentityVerified, true); assert.match(record.startTicks, /^[1-9][0-9]*$/);
  }
  assert.notEqual(oldNode.pid, newNode.pid); assertFreshConnection(report.heldProcessesBefore, report.reconnectedProcesses, b.baseline.generation, b.target.generation);
  for (const [node, item] of [[oldNode, b.baseline], [newNode, b.target]]) {
    assert.ok(node.image.replaceAll('\\', '/').toLowerCase().endsWith(`/runtime-generations/windows-x86_64/${item.generation}/mcp/server/runtime/node.exe`));
  }
  assert.equal(report.restoredLastTool, report.restore ? report.lastTool : null);
  assert.equal(input.kind, b.kind); assert.equal(input.harnessSource, pin.harnessCommit); assert.equal(input.bindingSha256, pin.bindingSha256);
  assert.deepEqual(input.source, b.target.source); assert.equal(input.releaseId, q.draft.id);
  assert.equal(input.tagCommit, b.publication.tagCommit); assert.equal(input.publicFeedUrl, public20.FEED);
  assert.equal(input.publicFeedSha256, hash(feedBytes)); assert.deepEqual(input.feed, public20.checkRelease(feedBytes, b));
  for (const k of ['authenticatedDownload', 'lab', 'fixture']) assert.equal(input[k], false);
  assert.deepEqual(report.publicProof, { ...input, inputBindingSha256: pin.inputBindingSha256 });
  assert.deepEqual(Object.keys(bodies).sort(), public20.ASSETS.filter(n => n !== public20.ASSET).sort());
  for (const [name, bytes] of Object.entries(bodies)) { assert.equal(bytes.length, b.publication.assets[name].size); assert.equal(hash(bytes), b.publication.assets[name].sha256); }
  const latest = JSON.parse(bodies['latest.json']), original = { ...b.originalLatest }, actual = { ...latest };
  delete original.notes; delete actual.notes; assert.deepEqual(actual, original);
  assert.equal(latest.platforms['windows-x86_64'].url, public20.url('0.1.22', public20.ASSET));
  assert.equal(bodies[public20.ASSET + '.sig'].toString().trim(), latest.platforms['windows-x86_64'].signature.trim());
  assert.equal(bodies['SHA256SUMS.txt'].toString(), public20.ASSETS.filter(n => n !== 'SHA256SUMS.txt').sort()
    .map(n => `${b.publication.assets[n].sha256}  ${n}\n`).join(''));
}
function services(execute = execFileSync) {
  const get = archiveTools.createGhReader(execute);
  return { request: async r => JSON.parse(get(r, 4 * 1024 * 1024, false)), download: async (r, limit) => get(r, limit, true) };
}
async function verify(q, options, io = services()) {
  const pin = loadReview(options.publicReview, options.publicReviewSha256, q);
  assert.equal(pin.qualificationSha256, options.sha256); digest(options.association, 40); digest(options.publicArtifactSha256);
  const runId = Number(options.publicRun); positive(runId);
  const run = await io.request(`actions/runs/${runId}`);
  for (const [k, v] of Object.entries({ id: runId, run_attempt: 1, event: 'workflow_dispatch', status: 'completed', conclusion: 'success',
    head_sha: pin.harnessCommit, head_branch: REVIEW.publicBranch, path: WORKFLOW })) assert.equal(run[k], v, k);
  for (const repo of [run.repository, run.head_repository]) { assert.equal(repo.id, 1364807512); assert.equal(repo.full_name, REPO); }
  const commit = await io.request(`git/commits/${pin.harnessCommit}`); assert.equal(commit.sha, pin.harnessCommit); assert.equal(commit.tree.sha, pin.harnessTree);
  const tree = await io.request(`git/trees/${pin.harnessTree}?recursive=1`); assert.equal(tree.sha, pin.harnessTree); assert.equal(tree.truncated, false);
  const blob = async name => {
    const entries = tree.tree.filter(e => e.path === name && e.type === 'blob'); assert.equal(entries.length, 1);
    const b = await io.request(`git/blobs/${entries[0].sha}`); assert.equal(b.sha, entries[0].sha); assert.equal(b.encoding, 'base64');
    const bytes = Buffer.from(b.content, 'base64'); assert.equal(bytes.length, b.size); return bytes;
  };
  assert.equal(hash(await blob(WORKFLOW)), pin.workflowSha256);
  const bindingBytes = await blob(BINDING); assert.equal(hash(bindingBytes), pin.bindingSha256); const binding = JSON.parse(bindingBytes);
  requireTarget(q, binding); assert.equal(binding.publication.tagCommit, options.association);
  const listing = await io.request(`actions/runs/${runId}/jobs?per_page=100`); assert.equal(listing.total_count, 4); assert.equal(listing.jobs.length, 4);
  const names = [...CASES.map(c => 'acceptance-' + c), 'evidence'];
  assert.deepEqual(listing.jobs.map(j => j.name).sort(), names.sort());
  for (const j of listing.jobs) {
    positive(j.id); assert.equal(j.run_id, runId); assert.equal(j.run_attempt, 1); assert.equal(j.head_sha, pin.harnessCommit);
    assert.equal(j.status, 'completed'); assert.equal(j.conclusion, 'success');
    assert.ok(j.labels.includes(j.name === 'evidence' ? 'ubuntu-latest' : 'windows-latest'));
  }
  const artifacts = await io.request(`actions/runs/${runId}/artifacts?per_page=100`);
  const matches = artifacts.artifacts.filter(a => a.name === 'hub-public-self-update-022'); assert.equal(matches.length, 1);
  const a = matches[0]; positive(a.id); positive(a.size_in_bytes); assert.ok(a.size_in_bytes <= 64 * 1024 * 1024);
  assert.equal(a.expired, false); assert.equal(a.digest, 'sha256:' + options.publicArtifactSha256);
  assert.equal(a.workflow_run.id, runId); assert.equal(a.workflow_run.head_sha, pin.harnessCommit);
  for (const k of ['repository_id', 'head_repository_id']) assert.equal(a.workflow_run[k], 1364807512);
  const job = listing.jobs.find(j => j.name === 'evidence');
  const times = [job.started_at, a.created_at, job.completed_at].map(Date.parse);
  assert.ok(times.every(Number.isFinite) && times[0] <= times[1] && times[1] <= times[2]);
  const archive = await io.download(`actions/artifacts/${a.id}/zip`, a.size_in_bytes + 1);
  assert.equal(archive.length, a.size_in_bytes); assert.equal(hash(archive), options.publicArtifactSha256);
  const results = [];
  for (const name of CASES) {
    const read = file => archiveTools.readZipMember(archive, `${name}/${file}`);
    const reportBytes = read('outgoing-report.json'), inputBytes = read('public-input-binding.json');
    const report = JSON.parse(reportBytes), input = JSON.parse(inputBytes);
    const bodies = Object.fromEntries(public20.ASSETS.filter(n => n !== public20.ASSET).map(n => [n, read(n)]));
    validateEvidence(q, binding, report, input, read('public-feed.json'), bodies, { ...pin, inputBindingSha256: hash(inputBytes) }, name);
    results.push({ case: name, reportSha256: hash(reportBytes), inputBindingSha256: hash(inputBytes) });
  }
  return { publicAcceptance: true, version: '0.1.22', releaseId: q.draft.id, association: options.association,
    qualificationSha256: options.sha256, harnessCommit: pin.harnessCommit, runId, jobId: job.id, artifactId: a.id,
    publicReviewSha256: options.publicReviewSha256, artifactSha256: hash(archive), cases: results };
}
function assertFreshConnection(held, fresh, oldGeneration, newGeneration) {
  assert.equal(held.length, 2); assert.equal(fresh.length, 2);
  assert.equal(new Set([...held, ...fresh].map(row => row.pid)).size, 4);
  const norm = image => path.win32.normalize(image).toLowerCase();
  let root;
  for (const [rows, gen] of [[held, oldGeneration], [fresh, newGeneration]]) {
    digest(gen);
    for (const row of rows) { positive(row.pid, Number.MAX_SAFE_INTEGER); assert.equal(row.kernelIdentityVerified, true);
      assert.match(row.startTicks, /^[1-9][0-9]*$/); }
    assert.equal(rows[1].parentPid, rows[0].pid);
    assert.equal(norm(rows[0].image), norm(held[0].image));
    const image = norm(rows[1].image), suffix = norm(`creator-hub/runtime-generations/windows-x86_64/${gen}/mcp/server/runtime/node.exe`);
    assert.ok(path.win32.isAbsolute(image) && image.endsWith('\\' + suffix));
    const currentRoot = image.slice(0, -suffix.length);
    if (root === undefined) root = currentRoot; else assert.equal(currentRoot, root);
  }
}
module.exports = { verify, validateEvidence, requireTarget, loadReview, services, CASES, WORKFLOW, BINDING };
