'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const REPO = { owner: 'BOBWORKS-XR', repo: 'CREATOR-HUB' };
const REF = 'refs/heads/validation/native-linux-journal-production-016';
const WORKFLOW = '.github/workflows/native-linux-production-016-migration.yml';
const PROFILE_SHA = 'ef2b5a589d934bf48306ddfd53d133513f3ab4d22b9622672f76887cb7acb095';
const INCOMING_SHA = '08f2df3b8139f00f5bd5b84619218228c7878d62ae0e4ec180fdcaaec6b87fc3';
const FALSE = Object.freeze({ publicDiscovery: false, flatpakAccepted: false, steamDeckAccepted: false,
  liveAiAccepted: false, unityAccepted: false, releaseReady: false });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');

function profile(raw) {
  assert.ok(Buffer.isBuffer(raw) && raw.length === 11728);
  assert.equal(hash(raw), PROFILE_SHA, 'Only the reviewed actual A1/017 profile is admitted');
  return JSON.parse(raw);
}

function admission(context, env) {
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.GITHUB_REPOSITORY, 'BOBWORKS-XR/CREATOR-HUB');
  assert.equal(env.GITHUB_REPOSITORY_ID, '1364807512');
  assert.equal(env.GITHUB_REF, REF);
  assert.equal(env.GITHUB_EVENT_NAME, 'workflow_dispatch');
  assert.equal(env.GITHUB_WORKFLOW_REF, 'BOBWORKS-XR/CREATOR-HUB/' + WORKFLOW + '@' + REF);
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(env.RUNNER_OS, 'Linux');
  assert.equal(env.RUNNER_ARCH, 'X64');
  assert.equal(env.CREATOR_NATIVE_LINUX_PRODUCTION_016, '1');
  assert.equal(env.CREATOR_MIGRATION_016_EXECUTE, 'true');
  assert.equal(env.CREATOR_MIGRATION_016_SCENARIO, 'migration-approve');
  assert.equal(env.CREATOR_MIGRATED_UPDATE_EXECUTE, 'true');
  assert.equal(env.UPDATE_EXECUTE, 'true');
  assert.equal(env.UPDATE_SCENARIO, 'deb-approve');
  assert.equal(env.UPDATE_PROFILE_SHA256, PROFILE_SHA);
  assert.match(env.CREATOR_CHANGED_MCP_SOURCE_RECEIPT_SHA256 || '', /^[a-f0-9]{64}$/);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
  assert.equal(context.sha, env.GITHUB_SHA);
  assert.equal(String(context.runId), env.GITHUB_RUN_ID);
  assert.match(env.GITHUB_RUN_ID || '', /^[1-9][0-9]*$/);
  assert.match(env.GITHUB_RUN_ATTEMPT || '', /^[1-9][0-9]*$/);
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
    'PYTHONPATH', 'PYTHONHOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
    'CURL_CA_BUNDLE', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    assert.ok(!env[key], 'No loader, proxy or trust override: ' + key);
  }
}

function stamp(st) {
  return [st.dev, st.ino, st.mode, st.nlink, st.uid, st.gid, st.size, st.mtimeMs, st.ctimeMs];
}

function regular(file, limit, { empty = false, owned = false, publicArtifact = false } = {}) {
  assert.equal(typeof publicArtifact, 'boolean');
  if (publicArtifact) assert.equal(owned, true);
  assert.equal(fs.realpathSync(file), file);
  const before = fs.lstatSync(file);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1);
  assert.ok(before.size >= (empty ? 0 : 1) && before.size <= limit);
  if (owned) {
    assert.equal(before.uid, process.getuid());
    const mode = before.mode & 0o7777;
    assert.ok(mode === 0o600 || (publicArtifact && mode === 0o644), 'Exact private or public-artifact mode required');
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    assert.deepEqual(stamp(fs.fstatSync(fd)), stamp(before));
    const bytes = fs.readFileSync(fd);
    assert.equal(bytes.length, before.size);
    assert.deepEqual(stamp(fs.fstatSync(fd)), stamp(before));
    assert.deepEqual(stamp(fs.lstatSync(file)), stamp(before));
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function sourceReceipt(workspace, expectedSource) {
  assert.equal(fs.realpathSync(workspace), workspace);
  const git = args => execFileSync('git', args, { cwd: workspace, encoding: 'utf8',
    windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: 30000 });
  const source = git(['rev-parse', 'HEAD']).trim();
  assert.equal(source, expectedSource);
  const tree = git(['rev-parse', 'HEAD^{tree}']).trim();
  assert.match(source, /^[a-f0-9]{40}$/); assert.match(tree, /^[a-f0-9]{40}$/);
  const rows = git(['ls-tree', '-rz', '--full-tree', 'HEAD']).split('\0');
  assert.equal(rows.pop(), ''); assert.ok(rows.length > 0 && rows.length <= 10000);
  const files = {};
  for (const row of rows) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\0\r\n]+)$/.exec(row);
    assert.ok(match, 'Only finite regular Git blobs are execution sources');
    const relative = match[3];
    assert.ok(!relative.startsWith('/') && !relative.includes('\\') && !relative.includes(':')
      && relative.split('/').every(part => part && part !== '.' && part !== '..'));
    assert.ok(!Object.hasOwn(files, relative));
    const bytes = regular(path.join(workspace, relative), 32 * 1024 * 1024, { empty: true });
    const blob = crypto.createHash('sha1').update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex');
    assert.equal(blob, match[2], 'Checkout differs from its original Git blob: ' + relative);
    files[relative] = { size: bytes.length, sha256: hash(bytes) };
  }
  return { schemaVersion: 1, source, tree, files };
}

function producer(proof, expected) {
  const { run, job, artifact, commit } = proof;
  for (const [key, value] of Object.entries({ id: expected.run, run_attempt: expected.attempt,
    head_sha: expected.source, head_branch: expected.branch, path: expected.workflow,
    event: 'workflow_dispatch', status: 'completed', conclusion: 'success' })) assert.equal(run[key], value);
  for (const key of ['repository', 'head_repository']) {
    assert.equal(run[key].id, 1364807512); assert.equal(run[key].full_name, 'BOBWORKS-XR/CREATOR-HUB');
  }
  assert.equal(commit.sha, expected.source); assert.equal(commit.tree.sha, expected.tree);
  for (const [key, value] of Object.entries({ id: expected.job, run_id: expected.run,
    run_attempt: expected.attempt, head_sha: expected.source, status: 'completed', conclusion: 'success' })) assert.equal(job[key], value);
  assert.ok(job.labels.includes('ubuntu-22.04'));
  for (const [key, value] of Object.entries({ id: expected.artifact, name: expected.name,
    expired: false, size_in_bytes: expected.zip.size, digest: 'sha256:' + expected.zip.sha256 })) assert.equal(artifact[key], value);
  for (const [key, value] of Object.entries({ id: expected.run, head_sha: expected.source,
    head_branch: expected.branch })) assert.equal(artifact.workflow_run[key], value);
}

function harness(run, context, env) {
  for (const [key, value] of Object.entries({ id: context.runId, head_sha: context.sha,
    run_attempt: Number(env.GITHUB_RUN_ATTEMPT), head_branch: REF.slice('refs/heads/'.length),
    path: WORKFLOW, event: 'workflow_dispatch', conclusion: null })) assert.equal(run[key], value);
  assert.ok(['queued', 'in_progress'].includes(run.status));
  for (const key of ['repository', 'head_repository']) {
    assert.equal(run[key].id, 1364807512); assert.equal(run[key].full_name, 'BOBWORKS-XR/CREATOR-HUB');
  }
}

function delivery(release, asset, listing, expected) {
  assert.equal(release.id, 411494394); assert.equal(release.tag_name, 'v0.1.13-validation');
  assert.equal(release.draft, true);
  assert.ok(Array.isArray(listing) && listing.length < 100);
  assert.equal(listing.filter(a => a.id === expected.asset && a.name === expected.name).length, 1);
  for (const [key, value] of Object.entries({ id: expected.asset, name: expected.name,
    size: expected.zip.size, state: 'uploaded', digest: 'sha256:' + expected.zip.sha256 })) assert.equal(asset[key], value);
}

function deliveryAPI(raw, p, context, env) {
  assert.ok(Buffer.isBuffer(raw) && raw.length > 0 && raw.length <= 2 * 1024 * 1024);
  const value = JSON.parse(raw);
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.ok(canonical(value).equals(raw), 'Canonical unambiguous delivery API required');
  assert.deepEqual(Object.keys(value).sort(), ['schemaVersion', 'source', 'run', 'attempt', 'profileSha256',
    'release', 'asset', 'listing', 'dataOnly', ...Object.keys(FALSE)].sort());
  assert.equal(value.schemaVersion, 1); assert.equal(value.source, context.sha);
  assert.ok(Number.isSafeInteger(value.run) && value.run > 0); assert.equal(value.run, context.runId);
  assert.ok(Number.isSafeInteger(value.attempt) && value.attempt > 0); assert.equal(value.attempt, Number(env.GITHUB_RUN_ATTEMPT));
  assert.equal(value.profileSha256, PROFILE_SHA); assert.equal(value.dataOnly, true);
  for (const key of Object.keys(FALSE)) assert.equal(value[key], false);
  delivery(value.release, value.asset, value.listing, p.deliveries.signedDeb17);
  return value;
}

function deliveryArtifact(value, id, context, env) {
  assert.ok(Number.isSafeInteger(id) && id > 0);
  assert.equal(value.id, id); assert.equal(value.name, `changed-mcp-delivery-${context.runId}-${env.GITHUB_RUN_ATTEMPT}`);
  assert.equal(value.expired, false);
  assert.ok(Number.isSafeInteger(value.size_in_bytes) && value.size_in_bytes > 0 && value.size_in_bytes <= 768 * 1024 * 1024);
  assert.match(value.digest || '', /^sha256:[a-f0-9]{64}$/);
  for (const [key, expected] of Object.entries({ id: context.runId, head_sha: context.sha,
    head_branch: REF.slice('refs/heads/'.length), repository_id: 1364807512, head_repository_id: 1364807512 })) {
    assert.equal(value.workflow_run[key], expected);
  }
}

async function collectDelivery({ github, context, raw, env = process.env }) {
  admission(context, env);
  const p = profile(raw);
  const workspace = fs.realpathSync(env.GITHUB_WORKSPACE);
  const sourceRaw = canonical(sourceReceipt(workspace, context.sha));
  assert.equal(hash(sourceRaw), env.CREATOR_CHANGED_MCP_SOURCE_RECEIPT_SHA256, 'Independently reviewed source receipt required');
  const harnessRun = (await github.rest.actions.getWorkflowRun({ ...REPO, run_id: context.runId })).data;
  harness(harnessRun, context, env);
  const release = (await github.rest.repos.getRelease({ ...REPO, release_id: 411494394 })).data;
  const listing = (await github.rest.repos.listReleaseAssets({ ...REPO, release_id: 411494394, per_page: 100, page: 1 })).data;
  const expected = p.deliveries.signedDeb17;
  const asset = (await github.rest.repos.getReleaseAsset({ ...REPO, asset_id: expected.asset })).data;
  delivery(release, asset, listing, expected);
  const response = await github.rest.repos.getReleaseAsset({ ...REPO, asset_id: expected.asset,
    headers: { accept: 'application/octet-stream' } });
  assert.ok(Buffer.isBuffer(response.data) || response.data instanceof ArrayBuffer);
  const bytes = Buffer.from(response.data);
  assert.equal(bytes.length, expected.zip.size); assert.equal(hash(bytes), expected.zip.sha256);
  const apiRaw = canonical({ schemaVersion: 1, source: context.sha, run: context.runId,
    attempt: Number(env.GITHUB_RUN_ATTEMPT), profileSha256: PROFILE_SHA,
    release, asset, listing, dataOnly: true, ...FALSE });
  deliveryAPI(apiRaw, p, context, env);
  const output = path.join(fs.realpathSync(env.RUNNER_TEMP), 'native-linux-changed-mcp-delivery');
  fs.mkdirSync(output, { mode: 0o700 });
  fs.writeFileSync(path.join(output, 'signedDeb17.zip'), bytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(output, 'delivery-api.json'), apiRaw, { flag: 'wx', mode: 0o600 });
  return { schemaVersion: 1, profileSha256: PROFILE_SHA, dataOnly: true, ...FALSE };
}

async function run({ github, context, raw, env = process.env }) {
  admission(context, env);
  const p = profile(raw);
  const workspace = fs.realpathSync(env.GITHUB_WORKSPACE);
  const source = sourceReceipt(workspace, context.sha);
  const sourceRaw = canonical(source);
  assert.equal(hash(sourceRaw), env.CREATOR_CHANGED_MCP_SOURCE_RECEIPT_SHA256, 'Independently reviewed source receipt required');
  assert.match(env.CREATOR_CHANGED_MCP_DELIVERY_ARTIFACT || '', /^[1-9][0-9]*$/);
  const artifactId = Number(env.CREATOR_CHANGED_MCP_DELIVERY_ARTIFACT);
  assert.ok(Number.isSafeInteger(artifactId));
  const harnessRun = (await github.rest.actions.getWorkflowRun({ ...REPO, run_id: context.runId })).data;
  harness(harnessRun, context, env);
  const transfer = (await github.rest.actions.getArtifact({ ...REPO, artifact_id: artifactId })).data;
  deliveryArtifact(transfer, artifactId, context, env);
  const temp = fs.realpathSync(env.RUNNER_TEMP);
  const staged = path.join(temp, 'native-linux-changed-mcp-delivery');
  assert.equal(fs.realpathSync(staged), staged);
  const directory = fs.lstatSync(staged);
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink() && !(directory.mode & 0o022));
  assert.equal(directory.uid, process.getuid());
  assert.deepEqual(fs.readdirSync(staged).sort(), ['delivery-api.json', 'signedDeb17.zip']);
  const observed = deliveryAPI(regular(path.join(staged, 'delivery-api.json'), 2 * 1024 * 1024,
    { owned: true, publicArtifact: true }), p, context, env);
  const delivered = regular(path.join(staged, 'signedDeb17.zip'), p.deliveries.signedDeb17.zip.size,
    { owned: true, publicArtifact: true });
  assert.equal(delivered.length, p.deliveries.signedDeb17.zip.size);
  assert.equal(hash(delivered), p.deliveries.signedDeb17.zip.sha256);
  const incoming = path.join(temp, 'native-linux-production-016-input');
  assert.equal(hash(regular(path.join(incoming, 'profile.json'), 16384, { owned: true })), INCOMING_SHA);
  const original = regular(path.join(incoming, 'assembly.zip'), p.artifacts.assembly16.zip.size, { owned: true });
  assert.equal(original.length, p.artifacts.assembly16.zip.size);
  assert.equal(hash(original), p.artifacts.assembly16.zip.sha256);
  const proof = {};
  for (const role of ['assembly16', 'assembly17']) {
    const e = p.artifacts[role];
    proof[role] = {
      run: (await github.rest.actions.getWorkflowRun({ ...REPO, run_id: e.run })).data,
      job: (await github.rest.actions.getJobForWorkflowRun({ ...REPO, job_id: e.job })).data,
      artifact: (await github.rest.actions.getArtifact({ ...REPO, artifact_id: e.artifact })).data,
      commit: (await github.rest.git.getCommit({ ...REPO, commit_sha: e.source })).data,
    };
    producer(proof[role], e);
  }
  const output = path.join(temp, 'native-linux-migrated-update-input');
  fs.mkdirSync(output, { mode: 0o700 });
  const write = (name, bytes) => fs.writeFileSync(path.join(output, name), bytes, { flag: 'wx', mode: 0o600 });
  const expected = p.artifacts.assembly17;
  const response = await github.rest.actions.downloadArtifact({ ...REPO, artifact_id: expected.artifact, archive_format: 'zip' });
  assert.ok(Buffer.isBuffer(response.data) || response.data instanceof ArrayBuffer);
  const bytes = Buffer.from(response.data);
  assert.equal(bytes.length, expected.zip.size); assert.equal(hash(bytes), expected.zip.sha256);
  write('assembly17.zip', bytes); write('signedDeb17.zip', delivered);
  write('profile.json', raw); write('source-receipt.json', sourceRaw);
  const acquisition = { schemaVersion: 1, source: context.sha, run: context.runId,
    attempt: Number(env.GITHUB_RUN_ATTEMPT), profileSha256: PROFILE_SHA,
    sourceReceiptSha256: hash(sourceRaw), harnessRun, proof, release: observed.release, asset: observed.asset, dataOnly: true, ...FALSE };
  write('acquisition.json', canonical(acquisition));
  return { schemaVersion: 1, profileSha256: PROFILE_SHA, sourceReceiptSha256: hash(sourceRaw),
    originalAssembly16Reused: true, downloadedRoles: ['assembly17'], stagedDeliveryReused: true,
    deliveryArtifact: { id: transfer.id, name: transfer.name, size_in_bytes: transfer.size_in_bytes,
      digest: transfer.digest, workflow_run: transfer.workflow_run }, dataOnly: true, ...FALSE };
}

module.exports = { PROFILE_SHA, INCOMING_SHA, FALSE, hash, canonical, profile, admission,
  regular, sourceReceipt, producer, harness, delivery, deliveryAPI, deliveryArtifact, collectDelivery, run };
