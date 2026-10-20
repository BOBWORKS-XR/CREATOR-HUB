const { moduleFiles } = require('../build-unified.cjs');
const { TARGETS, REPOSITORY, REPOSITORY_ID, WORKFLOW } = require('../unix-payload-binding.cjs');
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

module.exports = { fixture, tree };
