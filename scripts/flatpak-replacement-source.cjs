// Reviewed public assembly bindings only; no app execution or signing authority.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const pkg = require('./flatpak-package.cjs');
const runner = require('./flatpak-disposable.cjs');
const REPOSITORY_ID = 1364807512;

function validatePlan(plan) {
  assert.equal(plan.scope, 'same-version-flatpak-package-replacement-only'); assert.equal(plan.ref, pkg.REF);
  for (const name of ['baseline', 'replacement']) {
    const pins = plan[name].pins;
    pkg.validatePins(pins);
    if (pins.mcpMode === 'writable' && !Object.hasOwn(pins.files, pkg.ROUTER_INPUT)) {
      throw Object.assign(Error(`${name} writable plan lacks an independently reviewed raw router pin; historical pins and results remain unchanged. No download or staging is allowed.`),
        { code: 'ERR_FLATPAK_RAW_ROUTER_PIN_REQUIRED', input: name });
    }
  }
}

function preflight() {
  const bytes = pkg.read(path.join(pkg.RECIPE, 'replacement-014-inputs.json'), 65536);
  const plan = JSON.parse(bytes);
  validatePlan(plan);
  return { bytes, plan };
}

function validateRun(run, expected) {
  assert.equal(run.id, expected.pins.runId); assert.equal(run.run_attempt, expected.pins.runAttempt);
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
  assert.equal(run.head_sha, expected.pins.sourceCommit); assert.equal(run.repository.id, REPOSITORY_ID);
  assert.equal(run.path, '.github/workflows/unix-managed-assembly.yml');
  assert.equal(run.event, 'push'); assert.equal(run.head_branch, 'validation/unix-assembly-014');
}

function validateArtifact(artifact, expected) {
  assert.equal(artifact.id, expected.artifactId); assert.equal(artifact.name, expected.artifactName);
  assert.equal(artifact.expired, false); assert.equal(artifact.size_in_bytes, expected.artifactSize);
  assert.equal(artifact.digest, `sha256:${expected.pins.inputArtifactSha256}`);
  assert.equal(artifact.workflow_run.id, expected.pins.runId);
  assert.equal(artifact.workflow_run.head_sha, expected.pins.sourceCommit);
  assert.equal(artifact.workflow_run.repository_id, REPOSITORY_ID);
  assert.equal(artifact.workflow_run.head_repository_id, REPOSITORY_ID);
}

function sourceJson(file) {
  assert.equal(file.encoding, 'base64'); assert.ok(typeof file.content === 'string' && file.content.length <= 131072);
  const bytes = Buffer.from(file.content, 'base64'); assert.ok(bytes.length > 0 && bytes.length <= 65536);
  return JSON.parse(bytes.toString('utf8'));
}

function validateSource(commit, packageFile, tauriFile, expected) {
  assert.equal(commit.sha, expected.pins.sourceCommit); assert.equal(commit.tree.sha, expected.pins.sourceTree);
  const packageJson = sourceJson(packageFile), tauriJson = sourceJson(tauriFile);
  assert.equal(packageJson.version, expected.pins.version); assert.equal(tauriJson.version, expected.pins.version);
  assert.equal(packageJson.name, 'creator-hub'); assert.equal(tauriJson.identifier, pkg.ID);
  return { packageVersion: packageJson.version, tauriVersion: tauriJson.version };
}

function validateReceipt(bytes, binding, expected) {
  assert.deepEqual(pkg.record(bytes), expected.assemblyReceipt, 'Original assembly receipt bytes differ');
  assert.equal(binding.sourceCommit, expected.pins.sourceCommit); assert.equal(binding.sourceTree, expected.pins.sourceTree);
  assert.equal(binding.runId, expected.pins.runId); assert.equal(binding.runAttempt, expected.pins.runAttempt);
  assert.equal(binding.sourceVersions.packageVersion, '0.1.14'); assert.equal(binding.sourceVersions.tauriVersion, '0.1.14');
  const receipt = JSON.parse(bytes.toString('utf8'));
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.product, 'com.creatorworks.hub.unix-signed-assembly');
  assert.equal(receipt.assemblyCommit, binding.sourceCommit); assert.equal(receipt.hubVersion, expected.pins.version);
  assert.equal(receipt.platform, 'linux'); assert.equal(receipt.arch, 'x86_64'); assert.equal(receipt.mcpMode, 'writable');
  assert.equal(receipt.privateModulesRecompiled, false); assert.equal(receipt.privateModulesResigned, false);
  assert.equal(receipt.nativeGuiAccepted, false); assert.equal(receipt.releaseReady, false);
  return receipt;
}

async function verifyRemoteInput(github, repo, expected) {
  pkg.validatePins(expected.pins);
  const { data: run } = await github.rest.actions.getWorkflowRun({ ...repo, run_id: expected.pins.runId });
  validateRun(run, expected);
  const { data: artifact } = await github.rest.actions.getArtifact({ ...repo, artifact_id: expected.artifactId });
  validateArtifact(artifact, expected);
  const { data: jobPage } = await github.rest.actions.listJobsForWorkflowRunAttempt(
    { ...repo, run_id: run.id, attempt_number: expected.pins.runAttempt, per_page: 100 });
  const jobs = jobPage.jobs;
  assert.ok(Array.isArray(jobs) && jobs.length <= 16 && jobPage.total_count === jobs.length, 'Bounded complete assembly job list required');
  const lanes = jobs.filter(job => job.name.startsWith('assembly (linux,'));
  assert.equal(lanes.length, 1); assert.equal(lanes[0].id, expected.assemblyJobId); assert.equal(lanes[0].conclusion, 'success');
  const { data: commit } = await github.rest.git.getCommit({ ...repo, commit_sha: run.head_sha });
  const { data: packageFile } = await github.rest.repos.getContent({ ...repo, path: 'package.json', ref: run.head_sha });
  const { data: tauriFile } = await github.rest.repos.getContent({ ...repo, path: 'src-tauri/tauri.conf.json', ref: run.head_sha });
  const sourceVersions = validateSource(commit, packageFile, tauriFile, expected);
  const { data } = await github.rest.actions.downloadArtifact({ ...repo, artifact_id: artifact.id, archive_format: 'zip' });
  assert.ok(Buffer.isBuffer(data) || data instanceof ArrayBuffer, 'Native Octokit ZIP bytes required');
  const bytes = Buffer.from(data);
  assert.deepEqual(pkg.record(bytes), { size: expected.artifactSize, sha256: expected.pins.inputArtifactSha256 });
  return { bytes, binding: { runId: run.id, runAttempt: run.run_attempt, sourceCommit: run.head_sha,
    sourceTree: commit.tree.sha, sourceVersions, assemblyJobId: lanes[0].id, artifact } };
}

async function downloadInputs(github, context, env = process.env) {
  runner.admission(env);
  assert.equal(`${context.repo.owner}/${context.repo.repo}`, 'BOBWORKS-XR/CREATOR-HUB');
  const { plan } = preflight();
  const root = fs.realpathSync(env.RUNNER_TEMP); assert.ok(pkg.ordinary(root).isDirectory());
  for (const name of ['baseline', 'replacement']) {
    const { bytes, binding } = await verifyRemoteInput(github, context.repo, plan[name]);
    fs.writeFileSync(path.join(root, `flatpak-${name}-input.zip`), bytes, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(root, `flatpak-${name}-binding.json`), `${JSON.stringify(binding, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
}

function stageInputs(env = process.env) {
  runner.admission(env);
  const { bytes: planBytes, plan } = preflight();
  const root = fs.realpathSync(env.RUNNER_TEMP); assert.ok(pkg.ordinary(root).isDirectory());
  for (const name of ['baseline', 'replacement']) {
    const expected = plan[name], source = path.join(root, `flatpak-${name}-source`);
    const binding = JSON.parse(pkg.read(path.join(root, `flatpak-${name}-binding.json`), 65536));
    validateArtifact(binding.artifact, expected);
    assert.equal(binding.assemblyJobId, expected.assemblyJobId);
    const bytes = pkg.read(path.join(source, 'signed-unix-assembly.json'), 65536);
    validateReceipt(bytes, binding, expected);
    const stage = path.join(root, `flatpak-${name}-stage`);
    pkg.prepare(source, expected.pins, stage);
    // Preserve the original receipt beside the stage without changing payload inventory.
    fs.writeFileSync(path.join(stage, 'signed-unix-assembly.json'), bytes, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(root, `flatpak-${name}-pins.json`), `${JSON.stringify(expected.pins, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  }
  fs.writeFileSync(path.join(root, 'flatpak-replacement-plan.json'), planBytes, { flag: 'wx', mode: 0o600 });
}

if (require.main === module) {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--preflight') preflight();
    else { assert.equal(process.argv.length, 2); stageInputs(); }
  } catch (error) { console.error(`${error.code ? `${error.code}: ` : ''}${String(error.message)}`.slice(0, 1000)); process.exitCode = 1; }
}

module.exports = { validatePlan, preflight, validateRun, validateArtifact, validateSource, validateReceipt, verifyRemoteInput, downloadInputs, stageInputs };
