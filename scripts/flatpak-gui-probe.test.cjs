const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const probe = require('./flatpak-gui-probe.cjs');
const p = probe.pins;
function fixture() {
  return [{ id: p.runId, run_attempt: 1, head_sha: p.sourceCommit, status: 'completed', conclusion: 'success',
    event: 'push', head_branch: 'validation/flatpak-package-014', path: '.github/workflows/flatpak-package-014.yml', repository: { id: 1364807512 } },
  { id: p.artifactId, name: p.artifactName, expired: false, size_in_bytes: p.artifact.size, digest: `sha256:${p.artifact.sha256}`,
    workflow_run: { id: p.runId, head_sha: p.sourceCommit, repository_id: 1364807512, head_repository_id: 1364807512 } },
  { total_count: 1, jobs: [{ id: p.jobId, run_id: p.runId, run_attempt: 1, name: 'package', status: 'completed', conclusion: 'success' }] },
  { sha: p.sourceCommit, tree: { sha: p.sourceTree } }];
}
test('exact original run/job/source/artifact binding', () => probe.validateRemote(...fixture()));
for (const [name, mutate] of Object.entries({
  run: f => f[0].id++, failed: f => f[0].conclusion = 'failure', attempt: f => f[0].run_attempt++,
  branch: f => f[0].head_branch = 'feature/unified-creator-hub', source: f => f[0].head_sha = '0'.repeat(40),
  repo: f => f[0].repository.id++, workflow: f => f[0].path = 'other.yml',
  artifact: f => f[1].id++, expired: f => f[1].expired = true, digest: f => f[1].digest = 'sha256:' + '0'.repeat(64),
  size: f => f[1].size_in_bytes++, foreignArtifact: f => f[1].workflow_run.head_repository_id++,
  job: f => f[2].jobs[0].id++, truncated: f => f[2].total_count++, tree: f => f[3].tree.sha = '0'.repeat(40),
})) test('refuses ' + name, () => { const f = fixture(); mutate(f); assert.throws(() => probe.validateRemote(...f)); });

test('source-contract fixtures require native close, resource lookup and terms', () => {
  const files = {
    'src-tauri/tauri.conf.json': JSON.stringify({ version: '0.1.14', productName: 'Creator Hub', identifier: 'com.creatorworks.hub', app: { windows: [{ title: p.title }] } }),
    'src-tauri/src/main.rs': 'tauri::WindowEvent::CloseRequested { api, .. } if !window.state::<manager::Manager>().allow_close() tauri::RunEvent::ExitRequested { api, .. }',
    'src-tauri/src/manager.rs': 'pub fn allow_close(&self) -> bool { *closing = true; true }',
    'src-tauri/src/builtin.rs': '.resource_dir()', 'src/index.html': p.terms,
    'src/usage-terms.js': "await window.CreatorHubNative.invoke('usage_terms_status')",
  };
  assert.equal(probe.validateSource(files).normalCloseSourceAvailable, true);
  assert.throws(() => probe.validateSource({ ...files, 'src-tauri/src/main.rs': '' }));
});

test('workflow only targets new validation branch and runs tests before download/launch', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/flatpak-gui-probe-014.yml'), 'utf8');
  assert.ok(workflow.includes('branches: [validation/flatpak-gui-014]'));
  assert.ok(workflow.indexOf('node --test') < workflow.indexOf('.download(github'));
  assert.ok(workflow.indexOf('flatpak-gui-probe.test.py') < workflow.indexOf('.download(github'));
  assert.ok(!/macos|windows-latest|secrets\.|contents: write|actions: write/i.test(workflow));
  assert.ok(!/WEBKIT_DISABLE_SANDBOX|--no-sandbox|--share=network|--filesystem=|--socket=session-bus|flatpak kill|pkill/.test(workflow));
});
