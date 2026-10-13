const test = require('node:test');
const assert = require('node:assert/strict');
const { moduleFiles } = require('./build-unified.cjs');
const { TARGETS, REPOSITORY, REPOSITORY_ID, WORKFLOW, validateBinding } = require('./unix-payload-binding.cjs');
const sha = 'a'.repeat(40), tree = 'b'.repeat(40), digest = 'c'.repeat(64);

function fixture(target = 'linux') {
  const t = TARGETS[target];
  const repo = { id: REPOSITORY_ID, full_name: REPOSITORY };
  const files = {};
  const executables = ['modules/mcp/creator-works-mcp-launcher', 'modules/setup/creator-project-setup',
    'modules/mcp/server/runtime/node', 'router-for-package'];
  for (const name of [...moduleFiles('mcp', t.platform), ...moduleFiles('setup', t.platform)].map(n => `modules/${n}`)
    .concat(['builtin-manifest.json', 'mcp-runtime.json', 'router-for-package'])) {
    files[name] = { sha256: digest, size: 100, mode: executables.includes(name) ? 0o755 : 0o644 };
  }
  return {
    expected: { target, version: '0.1.14', sourceCommit: sha, runId: 101, runAttempt: 1, artifactId: 202, zipSha256: digest },
    run: { id: 101, head_sha: sha, run_attempt: 1, status: 'completed', conclusion: 'success', path: WORKFLOW,
      repository: repo, head_repository: repo, event: 'push', head_branch: 'validation/unix-payload-014' },
    artifact: { id: 202, expired: false, name: `unsigned-unix-payload-${t.os}-${t.runnerArch}-${sha}`,
      digest: `sha256:${digest}`, size_in_bytes: 1000, created_at: '2026-10-13T20:01:00Z',
      workflow_run: { id: 101, head_sha: sha, repository_id: REPOSITORY_ID, head_repository_id: REPOSITORY_ID } },
    commit: { sha, tree: { sha: tree } },
    jobs: [{ name: t.job, run_id: 101, run_attempt: 1, status: 'completed', conclusion: 'success',
      started_at: '2026-10-13T20:00:00Z', completed_at: '2026-10-13T20:02:00Z' }],
    prepared: { schemaVersion: 1, product: 'com.creatorworks.hub.unix-managed-preparation', hubVersion: '0.1.14',
      platform: t.platform, arch: t.arch, rustTarget: `${t.arch}-${t.platform === 'macos' ? 'apple-darwin' : 'unknown-linux-gnu'}`,
      mcpMode: 'writable', compiledFlags: { internalModule: true, experimentalUnixHosting: true, hostWritable: true, readOnlyEvents: true },
      source: { repository: REPOSITORY, repositoryId: REPOSITORY_ID, workflow: WORKFLOW, event: 'push',
        sourceCommit: sha, buildCommit: sha, sourceTree: tree, runId: 101, runAttempt: 1 },
      files, unsigned: true, privateKeyIncluded: false, nativeGuiTested: false, nativeConsentTested: false, releaseReady: false },
  };
}

for (const target of Object.keys(TARGETS)) test(`exact ${target} job/source/attempt/artifact binding is not acceptance`, () => {
  const result = validateBinding(fixture(target));
  assert.equal(result.releaseReady, false); assert.equal(result.nativeGuiTested, false);
});

const refusals = {
  foreignRepo: f => { f.run.head_repository = { id: 1, full_name: 'other/repo' }; },
  wrongSource: f => { f.run.head_sha = 'd'.repeat(40); },
  wrongWorkflow: f => { f.run.path = '.github/workflows/ci.yml'; },
  wrongBranch: f => { f.run.head_branch = 'feature/unified-creator-hub'; },
  prMerge: f => { f.run.event = 'pull_request'; },
  failure: f => { f.run.conclusion = 'failure'; },
  expired: f => { f.artifact.expired = true; },
  wrongDigest: f => { f.artifact.digest = `sha256:${'d'.repeat(64)}`; },
  wrongArtifactRun: f => { f.artifact.workflow_run.id = 2; },
  oldAttemptArtifact: f => { f.artifact.created_at = '2026-10-13T19:59:00Z'; },
  unknownArtifactTime: f => { delete f.artifact.created_at; },
  duplicateNativeJob: f => { f.jobs.push({ ...f.jobs[0] }); },
  jobFailed: f => { f.jobs[0].conclusion = 'failure'; },
  wrongAttempt: f => { f.jobs[0].run_attempt = 2; },
  wrongTree: f => { f.prepared.source.sourceTree = 'e'.repeat(40); },
  readonly: f => { f.prepared.mcpMode = 'read-only'; },
  wrongArch: f => { f.prepared.arch = 'aarch64'; },
  oldVersion: f => { f.expected.version = f.prepared.hubVersion = '0.1.13'; },
  unknownFile: f => { f.prepared.files['modules/unknown.exe'] = { sha256: digest, size: 100, mode: 0o755 }; },
  missingSetup: f => { delete f.prepared.files['modules/setup/creator-project-setup']; },
  wrongMode: f => { f.prepared.files['modules/mcp/server/runtime/node'].mode = 0o644; },
  unsafeSize: f => { f.prepared.files['router-for-package'].size = Number.MAX_SAFE_INTEGER; },
  readinessPromotion: f => { f.prepared.releaseReady = true; },
  keyIncluded: f => { f.prepared.privateKeyIncluded = true; },
  extraSourceField: f => { f.prepared.source.parentImpersonated = true; },
};
for (const [name, mutate] of Object.entries(refusals)) test(`unsigned binding refuses ${name}`, () => {
  const f = fixture(); mutate(f); assert.throws(() => validateBinding(f));
});

test('an exact successful dispatch is accepted without inventing PR merge ancestry', () => {
  const f = fixture('macos-intel'); f.run.event = f.prepared.source.event = 'workflow_dispatch';
  f.run.head_branch = 'feature/unified-creator-hub';
  assert.equal(validateBinding(f).sourceTree, tree);
});
