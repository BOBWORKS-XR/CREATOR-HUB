// Fresh API evidence binds unsigned build input; this grants no runtime authority.
const assert = require('node:assert/strict');
const { moduleFiles } = require('./build-unified.cjs');

const REPOSITORY = 'BOBWORKS-XR/CREATOR-HUB';
const REPOSITORY_ID = 1364807512;
const WORKFLOW = '.github/workflows/unix-managed-payload.yml';
const TARGETS = {
  linux: { platform: 'linux', arch: 'x86_64', os: 'Linux', runnerArch: 'X64', job: 'payload (ubuntu-22.04)' },
  'macos-arm64': { platform: 'macos', arch: 'aarch64', os: 'macOS', runnerArch: 'ARM64', job: 'payload (macos-latest)' },
  'macos-intel': { platform: 'macos', arch: 'x86_64', os: 'macOS', runnerArch: 'X64', job: 'payload (macos-15-intel)' },
};

function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), keys.split(' ').sort(), `${label} fields differ`);
}
function id(value) { assert.ok(Number.isSafeInteger(value) && value > 0, 'Positive safe API identity required'); }
function sha(value, length = 64) { assert.match(value, new RegExp(`^[a-f0-9]{${length}}$`)); }

function validatePrepared(p, target, version) {
  exactKeys(p, 'schemaVersion product hubVersion platform arch rustTarget mcpMode compiledFlags source files unsigned privateKeyIncluded nativeGuiTested nativeConsentTested releaseReady', 'Preparation');
  assert.equal(p.schemaVersion, 1);
  assert.equal(p.product, 'com.creatorworks.hub.unix-managed-preparation');
  assert.equal(p.hubVersion, version);
  assert.equal(p.platform, target.platform); assert.equal(p.arch, target.arch);
  assert.equal(p.rustTarget, `${target.arch}-${target.platform === 'macos' ? 'apple-darwin' : 'unknown-linux-gnu'}`);
  assert.equal(p.mcpMode, 'writable');
  assert.deepEqual(p.compiledFlags, { internalModule: true, experimentalUnixHosting: true, hostWritable: true, readOnlyEvents: true });
  assert.equal(p.unsigned, true); assert.equal(p.privateKeyIncluded, false);
  for (const field of ['nativeGuiTested', 'nativeConsentTested', 'releaseReady']) assert.equal(p[field], false);
  exactKeys(p.source, 'repository repositoryId workflow event sourceCommit buildCommit sourceTree runId runAttempt', 'Preparation source');
  const names = [...moduleFiles('mcp', target.platform), ...moduleFiles('setup', target.platform)].map(n => `modules/${n}`);
  names.push('builtin-manifest.json', 'mcp-runtime.json', 'router-for-package');
  exactKeys(p.files, names.join(' '), 'Preparation file map');
  const executables = ['modules/mcp/creator-works-mcp-launcher', 'modules/setup/creator-project-setup',
    'modules/mcp/server/runtime/node', 'router-for-package'];
  let total = 0;
  for (const [name, record] of Object.entries(p.files)) {
    exactKeys(record, 'sha256 size mode', 'Prepared member'); sha(record.sha256);
    assert.ok(Number.isSafeInteger(record.size) && record.size > 0 && record.size <= 256 * 1024 * 1024);
    assert.equal(record.mode, executables.includes(name) ? 0o755 : 0o644);
    total += record.size;
  }
  assert.ok(total <= 512 * 1024 * 1024, 'Preparation exceeds its transfer bound');
}

function validateExpected(e) {
  const journalA = e && Object.hasOwn(e, 'producerBranch');
  exactKeys(e, journalA ? 'target version sourceCommit sourceTree producerBranch runId runAttempt artifactId zipSha256'
    : 'target version sourceCommit runId runAttempt artifactId zipSha256', 'Independent pins');
  assert.ok(Object.hasOwn(TARGETS, e.target), 'Unknown target');
  const target = TARGETS[e.target];
  assert.ok(e.version === '0.1.14' || e.version === '0.1.16' && e.target === 'linux', 'Only finite reviewed validation targets are admitted');
  sha(e.sourceCommit, 40); sha(e.zipSha256);
  for (const value of [e.runId, e.runAttempt, e.artifactId]) id(value);
  if (journalA) {
    assert.equal(e.producerBranch, 'validation/journal-a-payload-016');
    assert.equal(e.version, '0.1.16'); assert.equal(e.target, 'linux'); sha(e.sourceTree, 40);
  }
  return { target, journalA };
}

function validateBinding({ expected: e, run: r, artifact: a, commit, jobs, prepared: p }) {
  const { target, journalA } = validateExpected(e);
  assert.equal(r.id, e.runId); assert.equal(r.head_sha, e.sourceCommit);
  assert.equal(r.run_attempt, e.runAttempt);
  assert.equal(r.status, 'completed'); assert.equal(r.conclusion, 'success');
  assert.equal(r.path, WORKFLOW);
  for (const repository of [r.repository, r.head_repository]) {
    assert.equal(repository.id, REPOSITORY_ID); assert.equal(repository.full_name, REPOSITORY);
  }
  if (journalA) {
    assert.equal(r.head_branch, e.producerBranch);
    assert.equal(r.event, 'workflow_dispatch', 'Journal A requires a manual producer run');
  } else if (e.version === '0.1.16') assert.equal(r.head_branch, 'validation/unix-payload-016');
  if (r.event === 'push') assert.equal(r.head_branch, e.version === '0.1.16' ? 'validation/unix-payload-016' : 'validation/unix-payload-014');
  else assert.equal(r.event, 'workflow_dispatch', 'PR merges are not supported by this producer');
  assert.equal(commit.sha, e.sourceCommit); sha(commit.tree.sha, 40);
  if (journalA) assert.equal(commit.tree.sha, e.sourceTree, 'Independent journal A source tree differs');
  assert.equal(a.id, e.artifactId); assert.equal(a.expired, false);
  assert.equal(a.name, `unsigned-unix-payload-${target.os}-${target.runnerArch}-${e.sourceCommit}`);
  assert.equal(a.digest, `sha256:${e.zipSha256}`);
  assert.ok(Number.isSafeInteger(a.size_in_bytes) && a.size_in_bytes > 0 && a.size_in_bytes <= 768 * 1024 * 1024);
  assert.equal(a.workflow_run.id, e.runId); assert.equal(a.workflow_run.head_sha, e.sourceCommit);
  assert.equal(a.workflow_run.repository_id, REPOSITORY_ID);
  assert.equal(a.workflow_run.head_repository_id, REPOSITORY_ID);
  const matches = jobs.filter(job => job.name === target.job);
  assert.equal(matches.length, 1, 'One exact native job/attempt required');
  const job = matches[0];
  assert.equal(job.run_id, e.runId); assert.equal(job.run_attempt, e.runAttempt);
  assert.equal(job.status, 'completed'); assert.equal(job.conclusion, 'success');
  const created = Date.parse(a.created_at), start = Date.parse(job.started_at), end = Date.parse(job.completed_at);
  assert.ok(Number.isFinite(created) && Number.isFinite(start) && Number.isFinite(end)
    && start <= created && created <= end, 'Artifact was not created within the selected native job');
  validatePrepared(p, target, e.version);
  assert.deepEqual(p.source, { repository: REPOSITORY, repositoryId: REPOSITORY_ID, workflow: WORKFLOW,
    event: r.event, sourceCommit: e.sourceCommit, buildCommit: e.sourceCommit, sourceTree: commit.tree.sha,
    runId: e.runId, runAttempt: e.runAttempt });
  return { ...e, ...target, sourceTree: commit.tree.sha, zipBytes: a.size_in_bytes,
    scope: 'unsigned-native-payload-provenance-only', nativeGuiTested: false, releaseReady: false };
}

module.exports = { TARGETS, REPOSITORY, REPOSITORY_ID, WORKFLOW, validatePrepared, validateExpected, validateBinding };
