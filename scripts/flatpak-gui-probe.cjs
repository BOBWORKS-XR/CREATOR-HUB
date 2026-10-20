// One immutable package consumer. No product build, signing, update or publication.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('./flatpak-package.cjs');
const sandbox = require('./flatpak-disposable.cjs');
const pins = require('./flatpak-gui-probe-pins.json');
const replacement = require('../packaging/flatpak/replacement-014-inputs.json').replacement;

function admission(env = process.env, platform = process.platform, arch = process.arch) {
  sandbox.admission({ ...env, CREATOR_FLATPAK_PACKAGE_TEST: '1' }, platform, arch);
  assert.equal(env.CREATOR_FLATPAK_GUI_PROBE, '1');
}

function validateRemote(run, artifact, page, commit) {
  for (const [key, expected] of Object.entries({ id: pins.runId, run_attempt: 1, head_sha: pins.sourceCommit,
    status: 'completed', conclusion: 'success', event: 'push', head_branch: 'validation/flatpak-package-014',
    path: '.github/workflows/flatpak-package-014.yml' })) assert.equal(run[key], expected, key);
  assert.equal(run.repository.id, 1364807512);
  for (const [key, expected] of Object.entries({ id: pins.artifactId, name: pins.artifactName, expired: false,
    size_in_bytes: pins.artifact.size, digest: `sha256:${pins.artifact.sha256}` })) assert.equal(artifact[key], expected, key);
  assert.equal(artifact.workflow_run.id, pins.runId); assert.equal(artifact.workflow_run.head_sha, pins.sourceCommit);
  for (const key of ['repository_id', 'head_repository_id']) assert.equal(artifact.workflow_run[key], 1364807512);
  assert.equal(page.total_count, 1); assert.equal(page.jobs.length, 1);
  const job = page.jobs[0];
  for (const [key, expected] of Object.entries({ id: pins.jobId, run_id: pins.runId, run_attempt: 1,
    name: 'package', status: 'completed', conclusion: 'success' })) assert.equal(job[key], expected, key);
  assert.equal(commit.sha, pins.sourceCommit); assert.equal(commit.tree.sha, pins.sourceTree);
}

function validateSource(files) {
  const config = JSON.parse(files['src-tauri/tauri.conf.json']);
  assert.equal(config.version, '0.1.14'); assert.equal(config.productName, 'Creator Hub');
  assert.equal(config.identifier, pkg.ID); assert.equal(config.app.windows[0].title, pins.title);
  const main = files['src-tauri/src/main.rs'], manager = files['src-tauri/src/manager.rs'];
  assert.ok(main.includes('tauri::WindowEvent::CloseRequested { api, .. }'));
  assert.ok(main.includes('if !window.state::<manager::Manager>().allow_close()'));
  assert.ok(main.includes('tauri::RunEvent::ExitRequested { api, .. }'));
  assert.match(manager, /pub fn allow_close\(&self\) -> bool\s*\{[\s\S]{0,300}\*closing = true;\s*true/);
  assert.ok(files['src/index.html'].includes(pins.terms));
  assert.ok(files['src/usage-terms.js'].includes('await window.CreatorHubNative.invoke(\'usage_terms_status\')'));
  assert.ok(files['src-tauri/src/builtin.rs'].includes('.resource_dir()'));
  return { productSource: replacement.pins.sourceCommit, normalCloseSourceAvailable: true,
    resourceScope: 'source-derived-path-read-in-normal-sandbox; not observed Hub archive consumption' };
}

async function download(github, context, env = process.env) {
  admission(env); assert.equal(`${context.repo.owner}/${context.repo.repo}`, 'BOBWORKS-XR/CREATOR-HUB');
  const repo = context.repo;
  const { data: run } = await github.rest.actions.getWorkflowRun({ ...repo, run_id: pins.runId });
  const { data: artifact } = await github.rest.actions.getArtifact({ ...repo, artifact_id: pins.artifactId });
  const { data: page } = await github.rest.actions.listJobsForWorkflowRunAttempt({ ...repo, run_id: pins.runId, attempt_number: 1, per_page: 10 });
  const { data: commit } = await github.rest.git.getCommit({ ...repo, commit_sha: pins.sourceCommit });
  validateRemote(run, artifact, page, commit);
  const { data: productCommit } = await github.rest.git.getCommit({ ...repo, commit_sha: replacement.pins.sourceCommit });
  assert.equal(productCommit.sha, replacement.pins.sourceCommit); assert.equal(productCommit.tree.sha, replacement.pins.sourceTree);
  const files = {};
  for (const file of ['src-tauri/tauri.conf.json', 'src-tauri/src/main.rs', 'src-tauri/src/manager.rs',
    'src-tauri/src/builtin.rs', 'src/index.html', 'src/usage-terms.js']) {
    const { data } = await github.rest.repos.getContent({ ...repo, path: file, ref: replacement.pins.sourceCommit });
    assert.equal(data.encoding, 'base64'); assert.ok(typeof data.content === 'string' && data.content.length <= 524288);
    const bytes = Buffer.from(data.content, 'base64'); assert.ok(bytes.length > 0 && bytes.length <= 262144);
    files[file] = bytes.toString('utf8');
  }
  const source = validateSource(files);
  const root = fs.realpathSync(env.RUNNER_TEMP);
  fs.writeFileSync(path.join(root, 'flatpak-gui-source.json'), JSON.stringify({ source, files,
    consumer: { runId: pins.runId, commit: commit.sha, tree: commit.tree.sha, artifactId: artifact.id, digest: artifact.digest },
    harnessCommit: env.GITHUB_SHA }), { flag: 'wx', mode: 0o600 });
  const { data } = await github.rest.actions.downloadArtifact({ ...repo, artifact_id: pins.artifactId, archive_format: 'zip' });
  assert.ok(Buffer.isBuffer(data) || data instanceof ArrayBuffer);
  const bytes = Buffer.from(data); assert.deepEqual(pkg.record(bytes), pins.artifact);
  fs.writeFileSync(path.join(root, 'flatpak-gui-input.zip'), bytes, { flag: 'wx', mode: 0o600 });
}

function verifyDeployment(root, location) {
  pkg.ordinary(root); sandbox.inside(location, path.join(root, 'installation'));
  const stage = JSON.parse(pkg.read(path.join(root, 'input', 'stage.json'), 65536));
  assert.deepEqual(stage.provenance, replacement.pins);
  sandbox.verifyFiles(path.join(location, 'files'), stage.files);
  sandbox.parseMetadata(pkg.read(path.join(root, 'metadata.txt'), 65536).toString());
  sandbox.parsePermissions(pkg.read(path.join(root, 'permissions.txt'), 65536).toString());
  const bytes = pkg.read(path.join(location, 'files/bin/creator-hub'), pkg.LIMIT, true);
  const descriptor = pkg.read(path.join(root, 'input/builtin-manifest.json'), 65536);
  assert.deepEqual(pkg.record(descriptor), replacement.pins.files['builtin-manifest.json']);
  pkg.validateDescriptor(JSON.parse(descriptor)); pkg.validateElf(bytes);
  assert.ok(bytes.includes(descriptor), 'Exact embedded descriptor required');
  return { sixFilesVerified: true, elfVerified: true, embeddedDescriptorVerified: true };
}

if (require.main === module) {
  try {
    assert.equal(process.argv[2], 'verify-deployment'); assert.equal(process.argv.length, 5);
    console.log(JSON.stringify(verifyDeployment(path.resolve(process.argv[3]), path.resolve(process.argv[4]))));
  } catch (error) { console.error(String(error.message).slice(0, 1000)); process.exitCode = 1; }
}
module.exports = { admission, validateRemote, validateSource, download, verifyDeployment, pins, replacement };
