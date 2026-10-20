'use strict';
// API provenance and bounded download only. No package execution or installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const REPO = { owner: 'BOBWORKS-XR', repo: 'CREATOR-HUB' };
const REPOSITORY_ID = 1364807512;
const REF = 'refs/heads/validation/native-linux-016';
const PRIVATE = { sourceCommit: '52e3a537c9d323c81ab259cb82b44bbe0828b414', runId: 39326776585, runAttempt: 1 };
const PRIVATE_PATHS = ['modules/mcp', 'modules/project-setup', 'native/mcp-router', 'native/host_parent_macos.rs',
  'native/plugins_retirement.rs', 'native/convergence-server-unix.rs', 'src-tauri/src/module_archive.rs', 'src-tauri/src/catalog-key.pub'];
const PINS = ['deb', 'hub', 'manifest', 'modulesArchive', 'assemblyReceipt', 'packageIntegrity', 'helper', 'policy', 'service'];
const LEGACY = [
  { product: 'mcp', repo: 'CREATOR-WORKS-UNITY-MCP', tag: 'v2.7.7', name: 'Creator.Works.MCP_2.7.7_amd64.deb',
    size: 96666824, sha256: 'db47aed5f5acd4e00e8e0782361444de228c4181eeea4970f90116f1f16cf10b' },
  { product: 'setup', repo: 'CREATOR-PROJECT-SETUP', tag: 'v0.3.7', name: 'Creator.Project.Setup_0.3.7_amd64.deb',
    size: 5966970, sha256: 'be18f23450146e71a2960e2110474f6e0409a9521a3ced308b7fd6a6d584c63d' },
];
const hash = raw => crypto.createHash('sha256').update(raw).digest('hex');
function keys(value, names) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), 'Unknown or missing profile fields');
}
function id(n) { assert.ok(Number.isSafeInteger(n) && n > 0); }
function sha(s, size = 64) { assert.ok(typeof s === 'string' && new RegExp(`^[a-f0-9]{${size}}$`).test(s)); }
function validate(p) {
  keys(p, ['schemaVersion', 'mode', 'assembly', 'pins']);
  assert.equal(p.schemaVersion, 1);
  assert.ok(['pages', 'migration-cancel'].includes(p.mode), 'Approval migration is unfinished and is not admitted');
  keys(p.assembly, ['sourceCommit', 'runId', 'runAttempt', 'jobId', 'artifactId', 'zipBytes', 'zipSha256']);
  sha(p.assembly.sourceCommit, 40); sha(p.assembly.zipSha256);
  for (const k of ['runId', 'runAttempt', 'jobId', 'artifactId', 'zipBytes']) id(p.assembly[k]);
  assert.ok(p.assembly.zipBytes <= 300 * 1024 * 1024);
  keys(p.pins, PINS);
  for (const k of PINS) {
    keys(p.pins[k], ['size', 'sha256']); id(p.pins[k].size); sha(p.pins[k].sha256);
    assert.ok(p.pins[k].size <= 256 * 1024 * 1024);
  }
  return p;
}
function admission(context, env) {
  assert.equal(`${context.repo.owner}/${context.repo.repo}`, 'BOBWORKS-XR/CREATOR-HUB');
  assert.equal(env.GITHUB_REPOSITORY_ID, String(REPOSITORY_ID));
  assert.equal(context.eventName, 'workflow_dispatch'); assert.equal(context.ref, REF);
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted'); assert.equal(env.RUNNER_OS, 'Linux'); assert.equal(env.RUNNER_ARCH, 'X64');
}
function producer(run, expected, workflow, branch) {
  assert.equal(run.id, expected.runId); assert.equal(run.head_sha, expected.sourceCommit);
  assert.equal(run.run_attempt, expected.runAttempt); assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
  assert.equal(run.path, workflow); assert.equal(run.head_branch, branch);
  assert.ok(['push', 'workflow_dispatch'].includes(run.event));
  for (const r of [run.repository, run.head_repository]) {
    assert.equal(r.id, REPOSITORY_ID); assert.equal(r.full_name, 'BOBWORKS-XR/CREATOR-HUB');
  }
}
function artifactBinding(run, job, artifact, p) {
  producer(run, p, '.github/workflows/unix-managed-assembly.yml', 'validation/linux-integrated-candidate-016');
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(job.id, p.jobId); assert.equal(job.run_id, p.runId); assert.equal(job.run_attempt, p.runAttempt);
  assert.equal(job.status, 'completed'); assert.equal(job.conclusion, 'success'); assert.ok(job.name.startsWith('assembly (linux,'));
  assert.equal(artifact.id, p.artifactId); assert.equal(artifact.expired, false);
  assert.equal(artifact.name, `signed-unix-hub-linux-${p.runId}-${p.runAttempt}`);
  assert.equal(artifact.size_in_bytes, p.zipBytes); assert.equal(artifact.digest, `sha256:${p.zipSha256}`);
  assert.equal(artifact.workflow_run.id, p.runId); assert.equal(artifact.workflow_run.head_sha, p.sourceCommit);
  for (const k of ['repository_id', 'head_repository_id']) assert.equal(artifact.workflow_run[k], REPOSITORY_ID);
  const [start, created, end] = [job.started_at, artifact.created_at, job.completed_at].map(Date.parse);
  assert.ok([start, created, end].every(Number.isFinite) && start <= created && created <= end, 'Artifact not created in selected job');
}
async function treePaths(github, commit) {
  const { data: c } = await github.rest.git.getCommit({ ...REPO, commit_sha: commit });
  assert.equal(c.sha, commit);
  const cache = new Map();
  async function tree(sha_) {
    if (!cache.has(sha_)) {
      const { data } = await github.rest.git.getTree({ ...REPO, tree_sha: sha_ });
      assert.equal(data.truncated, false); assert.ok(data.tree.length <= 4096); cache.set(sha_, data.tree);
    }
    return cache.get(sha_);
  }
  const out = {};
  for (const name of PRIVATE_PATHS) {
    let next = c.tree.sha, member;
    const parts = name.split('/');
    for (let i = 0; i < parts.length; i++) {
      const rows = (await tree(next)).filter(r => r.path === parts[i]); assert.equal(rows.length, 1);
      member = rows[0]; sha(member.sha, 40);
      assert.equal(member.type, i === parts.length - 1 && !['modules/mcp', 'modules/project-setup', 'native/mcp-router'].includes(name) ? 'blob' : 'tree');
      next = member.sha;
    }
    out[name] = member.sha;
  }
  return out;
}
async function publicDeb(github, row, fetch_) {
  const repo = { owner: REPO.owner, repo: row.repo };
  const { data: release } = await github.rest.repos.getReleaseByTag({ ...repo, tag: row.tag });
  assert.equal(release.tag_name, row.tag); assert.equal(release.draft, false); assert.equal(release.prerelease, false);
  const rows = release.assets.filter(a => a.name === row.name); assert.equal(rows.length, 1);
  const a = rows[0]; assert.equal(a.state, 'uploaded'); assert.equal(a.size, row.size); assert.equal(a.digest, `sha256:${row.sha256}`);
  const url = `https://github.com/${repo.owner}/${repo.repo}/releases/download/${row.tag}/${row.name}`;
  assert.equal(a.browser_download_url, url);
  const response = await fetch_(url, { signal: AbortSignal.timeout(120000), redirect: 'follow' });
  assert.equal(response.status, 200);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; assert.ok(size <= row.size); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks); assert.equal(bytes.length, row.size); assert.equal(hash(bytes), row.sha256);
  return { bytes, receipt: { assetId: a.id, releaseId: release.id, ...row } };
}
async function run({ github, context, profile, env = process.env, fetch_ = fetch }) {
  admission(context, env);
  assert.ok(typeof profile === 'string' && Buffer.byteLength(profile) <= 16384, 'Profile text bound');
  const p = validate(JSON.parse(profile));
  const { data: privateRun } = await github.rest.actions.getWorkflowRun({ ...REPO, run_id: PRIVATE.runId });
  producer(privateRun, PRIVATE, '.github/workflows/unix-managed-payload.yml', 'validation/unix-payload-016');
  const { data: run_ } = await github.rest.actions.getWorkflowRun({ ...REPO, run_id: p.assembly.runId });
  const { data: job } = await github.rest.actions.getJobForWorkflowRun({ ...REPO, job_id: p.assembly.jobId });
  const { data: artifact } = await github.rest.actions.getArtifact({ ...REPO, artifact_id: p.assembly.artifactId });
  artifactBinding(run_, job, artifact, p.assembly);
  const originalTree = await treePaths(github, PRIVATE.sourceCommit);
  const assemblyTree = await treePaths(github, p.assembly.sourceCommit);
  assert.deepEqual(assemblyTree, originalTree, 'PRIVATE_SOURCE_PATHS drifted after payload production');
  const { data: zip } = await github.rest.actions.downloadArtifact({ ...REPO, artifact_id: p.assembly.artifactId, archive_format: 'zip' });
  assert.ok(Buffer.isBuffer(zip) || zip instanceof ArrayBuffer);
  const bytes = Buffer.from(zip); assert.equal(bytes.length, p.assembly.zipBytes); assert.equal(hash(bytes), p.assembly.zipSha256);
  const temp = fs.realpathSync(env.RUNNER_TEMP); const output = path.join(temp, 'native-linux-016-input');
  fs.mkdirSync(output, { mode: 0o700 });
  const write = (name, data) => fs.writeFileSync(path.join(output, name), data, { flag: 'wx', mode: 0o600 });
  write('assembly.zip', bytes);
  const legacy = [];
  for (const row of LEGACY) { const value = await publicDeb(github, row, fetch_); write(`${row.product}.deb`, value.bytes); legacy.push(value.receipt); }
  // Preserve the supplied text so the strict Python decoder also rejects
  // duplicate JSON keys before any package installation or native execution.
  write('profile.json', profile);
  write('api-binding.json', JSON.stringify({ schemaVersion: 1, harnessSource: context.sha, assembly: p.assembly,
    privatePayload: PRIVATE, privateSourcePaths: assemblyTree, legacy, releaseReady: false }));
}
module.exports = { validate, admission, producer, artifactBinding, treePaths, publicDeb, run, PRIVATE, PRIVATE_PATHS, LEGACY, PINS, REF };
