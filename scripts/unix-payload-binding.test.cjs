const test = require('node:test');
const assert = require('node:assert/strict');
const { TARGETS, validateBinding } = require('./unix-payload-binding.cjs');
const { fixture, tree } = require('./fixtures/unix-payload-binding.cjs');
const digest = 'c'.repeat(64);

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

test('0.1.16 payload admission is Linux-only and tied to its new exact producer branch', () => {
  const current = (target = 'linux') => {
    const f = fixture(target);
    f.expected.version = f.prepared.hubVersion = '0.1.16';
    f.run.head_branch = 'validation/unix-payload-016';
    return f;
  };
  for (const event of ['push', 'workflow_dispatch']) {
    const f = current(); f.run.event = f.prepared.source.event = event;
    assert.equal(validateBinding(f).version, '0.1.16');
    f.run.head_branch = 'validation/unix-payload-014';
    assert.throws(() => validateBinding(f));
  }
  for (const target of ['macos-intel', 'macos-arm64']) assert.throws(() => validateBinding(current(target)));
  for (const version of ['0.1.15', '0.1.17', '0.1.16+unreviewed']) {
    const f = current(); f.expected.version = f.prepared.hubVersion = version;
    assert.throws(() => validateBinding(f));
  }
});
