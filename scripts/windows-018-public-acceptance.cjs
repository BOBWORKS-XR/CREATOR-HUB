'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { inspectFeed } = require('./check-release-feed.cjs');
const { selectBaseline } = require('./self-update-baselines.cjs');
const q = require('./windows-016-release-qualification.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const REPO = 'BOBWORKS-XR/CREATOR-HUB';
const FEED_URL = `https://api.github.com/repos/${REPO}/releases?per_page=10`;
function positive(value) { assert.ok(Number.isSafeInteger(value) && value > 0); }
function digest(value) { assert.match(value || '', /^[a-f0-9]{64}$/); }
function loadReview(file, expectedSha256, qualification) {
  digest(expectedSha256);
  assert.equal(typeof file, 'string');
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size > 0 && stat.size <= 16384);
  const bytes = fs.readFileSync(file); assert.equal(bytes.length, stat.size); assert.equal(hash(bytes), expectedSha256);
  const review = JSON.parse(bytes);
  assert.deepEqual(Object.keys(review).sort(), ['kind', 'version', 'baselineVersion', 'releaseId', 'qualificationSha256',
    'harnessCommit', 'harnessTree', 'workflowSha256', 'bindingSha256'].sort());
  assert.equal(review.kind, 'windows-018-public-harness-review');
  assert.equal(review.version, '0.1.18'); assert.equal(review.baselineVersion, '0.1.14');
  assert.equal(review.releaseId, qualification.draft.id);
  assert.match(review.harnessCommit, /^[a-f0-9]{40}$/); assert.match(review.harnessTree, /^[a-f0-9]{40}$/);
  for (const key of ['qualificationSha256', 'workflowSha256', 'bindingSha256']) digest(review[key]);
  return review;
}
function resources(rows, pins) {
  assert.ok(Array.isArray(rows)); assert.equal(rows.length, 15); assert.equal(Object.keys(pins).length, 15);
  const names = new Set();
  for (const row of rows) {
    assert.ok(!names.has(row.name)); names.add(row.name);
    assert.equal(typeof row.name, 'string'); assert.ok(row.name.startsWith('modules/'));
    const relative = row.name.slice(8);
    assert.ok(Object.hasOwn(pins, relative), 'Unknown installed resource');
    digest(row.sha256); digest(pins[relative]); assert.equal(row.sha256, pins[relative]);
    positive(row.size); assert.ok(row.size <= 512 * 1024 * 1024);
  }
  assert.deepEqual([...names].sort(), Object.keys(pins).map(name => `modules/${name}`).sort());
}
function validateEvidence(qualification, binding, report, input, feedBytes, bodies, pin) {
  assert.equal(binding.version, '0.1.18'); assert.equal(binding.kind, 'public-014-to-018');
  assert.deepEqual(binding.source, { commit: qualification.candidate.sourceCommit, tree: qualification.candidate.sourceTree });
  assert.equal(binding.releaseId, qualification.draft.id); assert.deepEqual(binding.assets, qualification.draft.assets);
  assert.equal(binding.executable.sha256, qualification.candidate.executableSha256);
  assert.equal(binding.manifestSha256, q.RELEASE_TARGET.rootBuild.manifestSha256);
  for (const key of ['passed', 'selfUpdateTested', 'publicDiscovery', 'cancelPreserved', 'automaticRestart',
    'settingsPreserved', 'managedRouteReconnectTested', 'directHubUpdateTested', 'rootCleanupVerified', 'runtimeCleanupVerified', 'policyRestored']) assert.equal(report[key], true, key);
  for (const key of ['labDiscovery', 'userMachineUsed', 'harnessAdditionalLaunch']) assert.equal(report[key], false, key);
  for (const key of ['fixture', 'lab', 'testOnlyDescriptor']) assert.ok(report[key] === undefined || report[key] === false, key);
  for (const [key, value] of Object.entries(report)) if (/error$/i.test(key)) assert.ok(!value, key);
  assert.deepEqual(report.pageErrors || [], []);
  assert.equal(report.kind, binding.kind); assert.equal(report.sourceKind, 'unmodified-public-stable');
  assert.equal(report.discoveryKind, 'public-github-discovery'); assert.equal(report.harnessSource, pin.harnessCommit);
  assert.deepEqual(report.targetSource, binding.source); assert.equal(report.publicBindingSha256, pin.bindingSha256);
  const baseline = selectBaseline('0.1.18');
  for (const key of ['version', 'installer', 'exe']) assert.equal(report.from[key], baseline[key]);
  assert.deepEqual(report.to, { version: '0.1.18', installer: qualification.candidate.installerSha256, exe: qualification.candidate.executableSha256 });
  assert.equal(report.originalExitCode, 0); positive(report.originalPid); positive(report.restartedPid);
  assert.notEqual(report.originalPid, report.restartedPid); assert.equal(report.beforeRoot.pid, report.originalPid); assert.equal(report.afterRoot.pid, report.restartedPid);
  for (const record of [report.beforeRoot, report.afterRoot]) { assert.equal(record.kernelIdentityVerified, true); assert.match(record.startTicks, /^[0-9]+$/); }
  assert.equal(report.beforeRoot.image.toLowerCase(), report.afterRoot.image.toLowerCase());
  assert.ok(BigInt(report.beforeRoot.startTicks) < BigInt(report.approvalLowerBoundTicks));
  assert.ok(BigInt(report.afterRoot.startTicks) > BigInt(report.approvalLowerBoundTicks));
  assert.equal(report.sdkConnections, 2);
  assert.ok(report.settingsBefore && typeof report.settingsBefore === 'object' && Object.keys(report.settingsBefore).length > 0);
  assert.deepEqual(report.settingsBefore, report.settingsAfter);
  assert.deepEqual(report.resourceProbe, { phase: 'after-automatic-root', attempts: 1, passed: true });
  resources(report.installedResources, binding.resources); resources(report.publicProof.resources, binding.resources);
  assert.equal(input.schemaVersion, 1); assert.equal(input.kind, binding.kind); assert.equal(input.harnessSource, pin.harnessCommit);
  assert.equal(input.bindingSha256, pin.bindingSha256); assert.equal(input.releaseId, binding.releaseId);
  assert.deepEqual(input.source, binding.source); assert.deepEqual(input.assets, binding.assets); assert.deepEqual(input.resources, binding.resources);
  assert.deepEqual(input.executable, binding.executable); assert.deepEqual(input.sdkInputs, binding.sdkInputs);
  assert.deepEqual(input.baseline, baseline);
  for (const key of ['authenticatedDownload', 'lab', 'fixture']) assert.equal(input[key], false);
  const feed = inspectFeed(feedBytes, '0.1.18'); assert.equal(feed.previousStable, baseline.version);
  assert.deepEqual(input.feed, feed); assert.equal(input.publicFeedUrl, FEED_URL); assert.equal(input.publicFeedSha256, hash(feedBytes));
  assert.equal(report.publicProof.publicFeedUrl, FEED_URL); assert.equal(report.publicProof.publicFeedSha256, hash(feedBytes));
  assert.equal(report.publicProof.authenticatedDownload, false); assert.equal(report.publicProof.bindingSha256, pin.bindingSha256);
  assert.equal(report.publicProof.releaseId, binding.releaseId); assert.deepEqual(report.publicProof.source, binding.source);
  assert.deepEqual(Object.keys(bodies).sort(), q.FINAL_ASSETS.filter(name => !name.endsWith('.exe')).sort());
  for (const [name, bytes] of Object.entries(bodies)) {
    const asset = binding.assets[name]; assert.ok(asset); assert.equal(bytes.length, asset.size); assert.equal(hash(bytes), asset.sha256);
  }
  const signature = require('./linux-016-release-qualification.cjs').verifySignature;
  signature(bodies['creator-hub-windows-x86_64.json'], bodies['creator-hub-windows-x86_64.json.minisig']);
}
function services() {
  const get = (route, limit, binary) => execFileSync('gh', ['api', ...(binary ? ['-H', 'Accept: application/octet-stream'] : []), `repos/${REPO}/${route}`],
    { windowsHide: true, timeout: 60000, maxBuffer: limit });
  return { request: async route => JSON.parse(get(route, 4 * 1024 * 1024, false)), download: async (route, limit) => get(route, limit, true) };
}
async function verify(qualification, options, io = services()) {
  const pin = loadReview(options.publicReview, options.publicReviewSha256, qualification);
  assert.equal(pin.qualificationSha256, options.sha256);
  const runId = Number(options.publicRun); positive(runId); digest(options.publicArtifactSha256);
  const run = await io.request(`actions/runs/${runId}`);
  for (const [key, value] of Object.entries({ id: runId, run_attempt: 1, event: 'workflow_dispatch', status: 'completed',
    conclusion: 'success', head_sha: pin.harnessCommit, path: '.github/workflows/self-update-acceptance.yml' })) assert.equal(run[key], value, key);
  for (const repo of [run.repository, run.head_repository]) { assert.equal(repo.id, 1364807512); assert.equal(repo.full_name, REPO); }
  const commit = await io.request(`git/commits/${pin.harnessCommit}`); assert.equal(commit.sha, pin.harnessCommit); assert.equal(commit.tree.sha, pin.harnessTree);
  const tree = await io.request(`git/trees/${pin.harnessTree}?recursive=1`); assert.equal(tree.sha, pin.harnessTree); assert.equal(tree.truncated, false);
  const member = name => { const rows = tree.tree.filter(row => row.path === name && row.type === 'blob'); assert.equal(rows.length, 1); return rows[0]; };
  const readBlob = async entry => { const b = await io.request(`git/blobs/${entry.sha}`); assert.equal(b.sha, entry.sha); assert.equal(b.encoding, 'base64');
    const bytes = Buffer.from(b.content, 'base64'); assert.equal(bytes.length, b.size); return bytes; };
  const workflow = await readBlob(member('.github/workflows/self-update-acceptance.yml')); assert.equal(hash(workflow), pin.workflowSha256);
  const bindingBytes = await readBlob(member('scripts/fixtures/windows-public-018-binding.json')); assert.equal(hash(bindingBytes), pin.bindingSha256);
  const jobs = await io.request(`actions/runs/${runId}/jobs?per_page=100`); assert.equal(jobs.total_count, 1);
  const job = jobs.jobs[0];
  for (const [key, value] of Object.entries({ name: 'self-update', run_id: runId, run_attempt: 1, head_sha: pin.harnessCommit,
    status: 'completed', conclusion: 'success' })) assert.equal(job[key], value, key);
  positive(job.id); assert.ok(job.labels.includes('windows-latest'));
  const listing = await io.request(`actions/runs/${runId}/artifacts?per_page=100`);
  const matching = listing.artifacts.filter(a => a.name === 'hub-public-self-update'); assert.equal(matching.length, 1);
  const artifact = matching[0]; positive(artifact.id); positive(artifact.size_in_bytes); assert.ok(artifact.size_in_bytes <= 64 * 1024 * 1024);
  assert.equal(artifact.expired, false); assert.equal(artifact.digest, 'sha256:' + options.publicArtifactSha256);
  assert.equal(artifact.workflow_run.id, runId); assert.equal(artifact.workflow_run.head_sha, pin.harnessCommit);
  for (const key of ['repository_id', 'head_repository_id']) assert.equal(artifact.workflow_run[key], 1364807512);
  const times = [job.started_at, artifact.created_at, job.completed_at].map(Date.parse);
  assert.ok(times.every(Number.isFinite) && times[0] <= times[1] && times[1] <= times[2]);
  const archive = await io.download(`actions/artifacts/${artifact.id}/zip`, artifact.size_in_bytes + 1);
  assert.equal(archive.length, artifact.size_in_bytes); assert.equal(hash(archive), options.publicArtifactSha256);
  const read = name => q.readZipMember(archive, name), reportBytes = read('self-update-report.json'), inputBytes = read('public-input-binding.json');
  const report = JSON.parse(reportBytes), input = JSON.parse(inputBytes), binding = JSON.parse(bindingBytes);
  assert.equal(report.publicProof.inputBindingSha256, hash(inputBytes));
  const bodies = Object.fromEntries(q.FINAL_ASSETS.filter(n => !n.endsWith('.exe')).map(n => [n, read(n)]));
  validateEvidence(qualification, binding, report, input, read('public-feed.json'), bodies, pin);
  return { publicAcceptance: true, version: '0.1.18', releaseId: qualification.draft.id, association: options.association,
    qualificationSha256: options.sha256, harnessCommit: pin.harnessCommit, runId, jobId: job.id, artifactId: artifact.id,
    publicReviewSha256: options.publicReviewSha256, artifactSha256: hash(archive), reportSha256: hash(reportBytes), inputBindingSha256: hash(inputBytes) };
}
module.exports = { verify, validateEvidence, resources, services, loadReview };
