'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pair = require('./journal-native-pair.cjs');

const names = { aProfile: 'a-profile', aManifest: 'a-manifest', binding: 'b-binding',
  bAudit: 'b-audit', bSignatures: 'b-signatures', bRuntime: 'b-runtime',
  bPlan: 'b-plan', bDerivation: 'b-derivation' };
const evidence = Object.fromEntries(Object.entries(names).map(([key, name]) =>
  [key, fs.readFileSync(path.join(__dirname, 'fixtures/journal-native-pair', name + '.json'))]));
const repo = { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' };
const start = '2026-10-29T10:00:00Z', created = '2026-10-29T10:01:00Z', end = '2026-10-29T10:02:00Z';
function run(p, workflow, branch, event) {
  return { id: p.runId, head_sha: p.sourceCommit, run_attempt: p.runAttempt, status: 'completed',
    conclusion: 'success', path: workflow, head_branch: branch, event, repository: { ...repo }, head_repository: { ...repo } };
}
function job(p, branch, name) {
  return { id: p.jobId, run_id: p.runId, run_attempt: p.runAttempt, head_sha: p.sourceCommit,
    head_branch: branch, name, status: 'completed', conclusion: 'success', started_at: start, completed_at: end };
}
function artifact(p, name) {
  return { id: p.artifactId, name, expired: false, size_in_bytes: p.zipBytes, digest: 'sha256:' + p.zipSha256,
    created_at: created, workflow_run: { id: p.runId, head_sha: p.sourceCommit, repository_id: repo.id, head_repository_id: repo.id } };
}
const commit = p => ({ sha: p.sourceCommit, tree: { sha: p.sourceTree } });
function metadata() {
  const a = JSON.parse(evidence.aProfile).assembly, b = pair.B, d = pair.DONOR, p = pair.A_PRODUCER;
  const ab = 'validation/journal-a-assembly-016', pb = 'validation/journal-a-payload-016';
  const db = 'validation/unix-payload-016', bb = 'validation/linux-private-update-fixture-017';
  const payload = '.github/workflows/unix-managed-payload.yml';
  return {
    aRun: run(a, '.github/workflows/unix-managed-assembly.yml', ab, 'workflow_dispatch'),
    aJob: job(a, ab, 'assembly (linux, ubuntu-22.04)'),
    aArtifact: artifact(a, `signed-unix-hub-linux-${a.runId}-${a.runAttempt}`), aCommit: commit(a),
    aProducerRun: run(p, payload, pb, 'workflow_dispatch'), aProducerJob: job(p, pb, 'payload (ubuntu-22.04)'), aProducerCommit: commit(p),
    donorRun: run(d, payload, db, 'push'), donorJob: job(d, db, 'payload (ubuntu-22.04)'), donorCommit: commit(d),
    bRun: run(b, '.github/workflows/private-linux-update-fixture-017.yml', bb, 'workflow_dispatch'),
    bJob: job(b, bb, 'assemble'), bArtifact: artifact(b, `private-linux-update-fixture-017-${b.runId}-1`), bCommit: commit(b),
  };
}
test('exact pair remains unbound for dispatch and native acceptance', () => {
  const result = pair.assess(evidence, metadata());
  assert.equal(result.status, 'EVIDENCE_BOUND_NOT_FOR_DISPATCH');
  assert.notEqual(result.aGeneration, result.bGeneration);
  for (const key of ['signaturesVerifiedHere', 'nativeExecution', 'nativeAccepted', 'releaseReady', 'dispatchAuthorized']) assert.equal(result[key], false);
  assert.equal(result.installerDelivery, null); assert.equal(result.sourceReceipt, null);
});
test('each retained evidence file is pinned byte-for-byte', () => {
  for (const key of Object.keys(evidence)) {
    const altered = { ...evidence, [key]: Buffer.concat([evidence[key], Buffer.from(' ')]) };
    assert.throws(() => pair.assess(altered, metadata()), undefined, key);
  }
  assert.throws(() => pair.assess({ ...evidence, extra: Buffer.alloc(0) }, metadata()));
});
test('reject mismatched routes, identities, job, artifacts and provenance', () => {
  const changes = [
    x => x.aRun.head_sha = pair.DONOR.sourceCommit,
    x => x.aRun.repository.id++, x => x.aJob.id++, x => x.aArtifact.digest = 'sha256:' + '0'.repeat(64),
    x => x.aCommit.tree.sha = pair.DONOR.sourceTree, x => x.aProducerRun.event = 'push',
    x => x.aProducerJob.id++, x => x.aProducerCommit.sha = pair.DONOR.sourceCommit,
    x => x.donorRun.head_sha = pair.A_PRODUCER.sourceCommit, x => x.donorRun.event = 'workflow_dispatch',
    x => x.donorJob.id++, x => x.donorCommit.tree.sha = pair.A_PRODUCER.sourceTree,
    x => x.bRun.head_branch = 'main', x => x.bRun.event = 'push', x => x.bRun.head_repository.id++,
    x => x.bJob.run_attempt++, x => x.bJob.conclusion = 'failure', x => x.bArtifact.id++,
    x => x.bArtifact.expired = true, x => x.bArtifact.digest = 'sha256:' + '0'.repeat(64),
    x => x.bArtifact.created_at = '2026-10-29T10:03:00Z', x => x.bCommit.tree.sha = pair.DONOR.sourceTree,
  ];
  for (const change of changes) { const api = metadata(); change(api); assert.throws(() => pair.assess(evidence, api)); }
});
