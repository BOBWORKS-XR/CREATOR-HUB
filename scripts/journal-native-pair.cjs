'use strict';
// Data-only identity check. No download, signature verification or execution authority.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const neutral = require('./native-linux-016-input.cjs');
const production = require('./native-linux-production-016-input.cjs');

const B = Object.freeze({ sourceCommit: 'a61e7b0152689b7fa25fd0f4fe3e7d3894751cc5',
  sourceTree: 'ab48fbce32accb627a5f5e0de2f496699c2317b4', runId: 40903331594, runAttempt: 1,
  jobId: 123551467029, artifactId: 12909839246, zipBytes: 128433738,
  zipSha256: '2dcce20200c14fe88098a48ef5768cb63a91a01de14a2c82bf44a4672bf1a86a' });
const DONOR = Object.freeze({ sourceCommit: 'c5bd13a5145aa54a50f28f073e1543826a210a4e',
  sourceTree: '6c6953a0b4901b56eeadb4647d7dde34a375761a', runId: 40891664484, runAttempt: 1,
  jobId: 123509810248 });
const A_PRODUCER = Object.freeze({ sourceCommit: 'f9c6da1af4ea51fc0214fba058c3946c1cda255a',
  sourceTree: 'c747ce8b9cd65169ba478162f9abb6c500be6186', runId: 40893082867, runAttempt: 1,
  jobId: 123514798864 });
const EVIDENCE = Object.freeze({
  aProfile: [1763, '08f2df3b8139f00f5bd5b84619218228c7878d62ae0e4ec180fdcaaec6b87fc3'],
  aManifest: [3663, '8f7e7efa742207a20980dbb8099b6a0d982cef11bbdd4fb91dd17e4984fa6b4a'],
  binding: [4389, '7528167e40cfeb7a11a1afb4cd3ef1123ec3cb1a181d32d846e8acd00dd5a223'],
  bAudit: [3310, '74ca4da1263b1467e7371c6ecb8d7bba03a0fb6f6dbff8537e3ba0791a772456'],
  bSignatures: [2093, '682dd33d28fd65aa91b0d998d5b4f0d701fd0dca12a5826aebf6a53304cf267e'],
  bRuntime: [1133, '2116cf1fe040a6be770e726a66f99f6d42e1303576c7d07e16be4dfb5f307dc4'],
  bPlan: [3295, 'fa04b1e9b636acd0177ed7d5ffe3b40eab955e40768f5b7f74682fd84864de6b'],
  bDerivation: [6340, '198d40daad35f0128038b1cc92c1d48b9f9527586f2f7efd1b583aa55d1e53ee'],
});
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function decodeEvidence(evidence) {
  assert.deepEqual(Object.keys(evidence).sort(), Object.keys(EVIDENCE).sort());
  return Object.fromEntries(Object.entries(EVIDENCE).map(([name, [size, sha]]) => {
    const raw = evidence[name]; assert.ok(Buffer.isBuffer(raw));
    assert.equal(raw.length, size); assert.equal(hash(raw), sha, name + ' evidence differs');
    return [name, JSON.parse(raw)];
  }));
}
function producer(run, job, commit, expected, branch, event) {
  neutral.producer(run, expected, '.github/workflows/unix-managed-payload.yml', branch);
  assert.equal(run.event, event);
  assert.equal(job.id, expected.jobId); assert.equal(job.run_id, expected.runId);
  assert.equal(job.run_attempt, expected.runAttempt); assert.equal(job.head_sha, expected.sourceCommit);
  assert.equal(job.head_branch, branch); assert.equal(job.name, 'payload (ubuntu-22.04)');
  assert.equal(job.status, 'completed'); assert.equal(job.conclusion, 'success');
  assert.equal(commit.sha, expected.sourceCommit); assert.equal(commit.tree.sha, expected.sourceTree);
}
function target(run, job, artifact, commit) {
  neutral.producer(run, B, '.github/workflows/private-linux-update-fixture-017.yml', 'validation/linux-private-update-fixture-017');
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(job.id, B.jobId); assert.equal(job.run_id, B.runId); assert.equal(job.run_attempt, B.runAttempt);
  assert.equal(job.name, 'assemble'); assert.equal(job.head_sha, B.sourceCommit);
  assert.equal(job.head_branch, 'validation/linux-private-update-fixture-017');
  assert.equal(job.status, 'completed'); assert.equal(job.conclusion, 'success');
  assert.equal(artifact.id, B.artifactId); assert.equal(artifact.name, `private-linux-update-fixture-017-${B.runId}-1`);
  assert.equal(artifact.expired, false); assert.equal(artifact.size_in_bytes, B.zipBytes);
  assert.equal(artifact.digest, `sha256:${B.zipSha256}`);
  assert.equal(artifact.workflow_run.id, B.runId); assert.equal(artifact.workflow_run.head_sha, B.sourceCommit);
  for (const key of ['repository_id', 'head_repository_id']) assert.equal(artifact.workflow_run[key], 1364807512);
  const [start, created, end] = [job.started_at, artifact.created_at, job.completed_at].map(Date.parse);
  assert.ok([start, created, end].every(Number.isFinite) && start <= created && created <= end);
  assert.equal(commit.sha, B.sourceCommit); assert.equal(commit.tree.sha, B.sourceTree);
}
function generation(module) {
  const files = Object.fromEntries(Object.entries(module.files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return hash(Buffer.from(JSON.stringify({ executable: module.executable, version: module.version, files })));
}
function assess(evidence, api) {
  const e = decodeEvidence(evidence), a = production.validate(e.aProfile);
  neutral.journalAFreshArtifactBinding(api.aRun, api.aJob, api.aArtifact, a.assembly);
  assert.equal(api.aCommit.sha, a.assembly.sourceCommit); assert.equal(api.aCommit.tree.sha, a.assembly.sourceTree);
  producer(api.aProducerRun, api.aProducerJob, api.aProducerCommit, A_PRODUCER, 'validation/journal-a-payload-016', 'workflow_dispatch');
  producer(api.donorRun, api.donorJob, api.donorCommit, DONOR, 'validation/unix-payload-016', 'push');
  target(api.bRun, api.bJob, api.bArtifact, api.bCommit);
  assert.equal(e.binding.status, 'UNBOUND_NOT_FOR_DISPATCH');
  assert.equal(e.binding.incomingProfileSha256, EVIDENCE.aProfile[1]);
  assert.deepEqual(e.binding.incomingAssembly, a.assembly);
  assert.equal(e.binding.assembly17.source, B.sourceCommit); assert.equal(e.binding.assembly17.tree, B.sourceTree);
  assert.equal(e.binding.assembly17.run, B.runId); assert.equal(e.binding.assembly17.job, B.jobId);
  assert.equal(e.binding.assembly17.artifact, B.artifactId);
  assert.deepEqual(e.binding.assembly17.zip, { size: B.zipBytes, sha256: B.zipSha256 });
  assert.equal(e.bAudit.artifact.zipSha256, B.zipSha256); assert.equal(e.bAudit.artifact.artifactId, B.artifactId);
  assert.equal(e.bAudit.all15ModulesMatchSignedInputs, true); assert.equal(e.bAudit.md5sumsVerified, true);
  assert.equal(e.bAudit.nativeAccepted, false); assert.equal(e.bAudit.releaseReady, false);
  assert.equal(e.bSignatures.allFiveInputSignaturesVerified, true);
  assert.equal(e.bSignatures.checks.length, 5); assert.ok(e.bSignatures.checks.every(check => check.verified === true));
  assert.equal(e.bSignatures.verifierSha256, '08af48e94021d4a201db5ca8dd66235e51e2763fcf90080eeea45df6bb1e10ca');
  assert.equal(e.bPlan.rootSource.sourceCommit, B.sourceCommit); assert.equal(e.bPlan.rootSource.sourceTree, B.sourceTree);
  assert.equal(e.bDerivation.rootSource.sourceCommit, B.sourceCommit); assert.equal(e.bDerivation.rootSource.sourceTree, B.sourceTree);
  assert.equal(e.bDerivation.original016.source.sourceCommit, DONOR.sourceCommit);
  assert.equal(e.bDerivation.original016.source.sourceTree, DONOR.sourceTree);
  assert.equal(e.bDerivation.original016.source.runId, DONOR.runId);
  assert.equal(e.bPlan.baseline016.assembly.sourceCommit, DONOR.sourceCommit);
  assert.equal(e.bPlan.baseline016.assembly.runId, 40897895423);
  const aModule = e.aManifest.modules.mcp, bModule = e.bRuntime.module;
  assert.equal(e.bRuntime.product, 'com.creatorworks.hub.mcp-runtime');
  assert.equal(e.bRuntime.hubVersion, '0.1.17'); assert.equal(e.bRuntime.platform, 'linux'); assert.equal(e.bRuntime.arch, 'x86_64');
  assert.equal(aModule.executable, bModule.executable); assert.equal(aModule.version, bModule.version);
  assert.equal(aModule.files['mcp/server/runtime/node'], bModule.files['mcp/server/runtime/node']);
  assert.notEqual(aModule.files['mcp/server/creator-works-mcp.mjs'], bModule.files['mcp/server/creator-works-mcp.mjs']);
  const aGeneration = generation(aModule), bGeneration = generation(bModule);
  assert.equal(aGeneration, 'ce273f1b3481aa82538abdace99b05cc9a8badc27be65a1df3dd34b7c4982f78');
  assert.equal(bGeneration, 'e93878d682900a6292aeeeca23d3fc4c3d280cdf1cd7bee2cc8c89802f539f7f');
  return { status: 'EVIDENCE_BOUND_NOT_FOR_DISPATCH', aGeneration, bGeneration,
    installerDelivery: null, sourceReceipt: null, signaturesVerifiedHere: false,
    nativeExecution: false, nativeAccepted: false, releaseReady: false, dispatchAuthorized: false };
}
module.exports = { B, DONOR, A_PRODUCER, EVIDENCE, generation, assess };
