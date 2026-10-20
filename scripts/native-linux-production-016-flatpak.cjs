'use strict';
// Data admission/collection only. No candidate, runtime, installer or signing execution.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const producer = require('./flatpak-native-production-016.cjs');

const PROFILE = 'production-flatpak-host-016';
const BRANCH = 'refs/heads/validation/native-linux-production-016-flatpak';
const WORKFLOW = '.github/workflows/native-linux-production-016-flatpak.yml';
const FEATURES = Object.freeze(['integrated-features', 'experimental-flatpak-host',
  'linux-production-migration', 'experimental-linux-portable-update']);
const FIXED = Object.freeze({ runId: 39348943839, runAttempt: 1, artifactId: 12231574692,
  harnessSource: 'ef2b79956f59a4b40daf0026123160c3c6405fb2', harnessTree: '58a74ab8bcefe94db5a183fac6959b8261b9370e',
  sourceCommit: 'c13cb9ef3b9116ea5ffb1f6cf8250becf5fd49e7', sourceTree: '10623f5cdc379028ff91cbdfdbb103615969856d',
  zip: Object.freeze({ size: 820465, sha256: '7139c913164d6901c6de689d07f4ac764e6d82b29d2d5c033b06f405144fa668' }),
  commit: 'fd8aa52965d4ce2e4a4a0c8d58d901bf20b2d3b059916799502ea24891c2bb90',
  files: Object.freeze({
    [producer.BUNDLE]: Object.freeze({ size: 199408, sha256: '30904def15d0e3d5333af2d1bb2af9e6fcab8569578a4f6cc9595de08a34bf24' }),
    [producer.COMMAND]: Object.freeze({ size: 597640, sha256: '89a3c15e88eaa5189417bca7e59fab7a177e805847b2ccc6c8db90e24716b908' }),
    'production-flatpak-receipt.json': Object.freeze({ size: 22935, sha256: 'b6d89999c199740af2b6b8bc151191e29c781ddfb74127a2c8656b564190ca6c' }),
  }),
});
const FALSE_GATES = Object.freeze(Object.fromEntries(['candidateExecuted', 'flatpakInstalled', 'disclosureCancelAccepted',
  'missingHostAccepted', 'portalCaptureAccepted', 'setupCancelAccepted', 'bootstrapAccepted', 'typedResumeAccepted',
  'coldActivationAccepted', 'warmActivationAccepted', 'settingsPreserved', 'signedUpdateAccepted', 'restartAccepted',
  'migrationAccepted', 'authenticationAccepted', 'mcpAccepted', 'setupAccepted', 'nativeGuiAccepted',
  'steamDeckAccepted', 'publicDiscoveryAccepted', 'publisherSignatureAccepted', 'releaseReady'].map(k => [k, false])));
const SIGNED_FILES = Object.freeze(['creator-hub-linux-x86_64-portable.json', 'creator-hub-linux-x86_64-portable.json.minisig',
  'creator-hub-linux-x86_64-0.1.16.portable-manifest.json', 'creator-hub-linux-x86_64-0.1.16.portable-manifest.json.minisig']);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pin = bytes => ({ size: bytes.length, sha256: hash(bytes) });
function keys(value, names) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), 'Unknown or missing controller fields');
}
function sha(value, length = 64) { assert.ok(typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value)); }
function id(value) { assert.ok(Number.isSafeInteger(value) && value > 0); }
function filePin(value, maximum = 256 * 1024 * 1024) {
  keys(value, ['size', 'sha256']); id(value.size); assert.ok(value.size <= maximum); sha(value.sha256);
}
function bound(bytes, expected) {
  assert.ok(Buffer.isBuffer(bytes)); assert.deepEqual(pin(bytes), expected, 'Independent input byte pin differs'); return bytes;
}
function admission(env, platform, arch, uid) {
  assert.equal(platform, 'linux'); assert.equal(arch, 'x64'); assert.ok(Number.isSafeInteger(uid) && uid > 0);
  for (const [key, expected] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: producer.REPO, GITHUB_REPOSITORY_ID: String(producer.REPO_ID),
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: BRANCH, GITHUB_WORKFLOW_REF: `${producer.REPO}/${WORKFLOW}@${BRANCH}` })) {
    assert.equal(env[key], expected, key);
  }
  sha(env.GITHUB_SHA, 40);
  for (const name of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(env[name] || '', /^[1-9][0-9]*$/);
  assert.ok(!env.DISPLAY && !env.WAYLAND_DISPLAY && !env.FLATPAK_ID, 'Initial admission must be headless and outside Flatpak');
  for (const name of Object.keys(env)) assert.ok(!/^(LD_|DYLD_|TAURI_|WEBKIT_|APPIMAGE$|APPDIR$|PYTHON|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|SSL_CERT_|CURL_CA_BUNDLE$|RUSTFLAGS$|CARGO_ENCODED_RUSTFLAGS$|BASH_ENV$|ENV$|CREATOR_HUB_SIGNING_)/.test(name)
    && !name.toLowerCase().endsWith('proxy'), 'Inherited runtime, trust or signing override refused');
}
function validateProfile(value) {
  keys(value, ['schemaVersion', 'profile', 'mode', 'portable']);
  assert.equal(value.schemaVersion, 1); assert.equal(value.profile, PROFILE);
  assert.equal(value.mode, 'bootstrap-activation', 'Private017 update contract is not admitted');
  const p = value.portable;
  keys(p, ['sourceCommit', 'sourceTree', 'packagingCommit', 'packagingTree', 'runId', 'runAttempt', 'jobId',
    'artifactId', 'zip', 'files']);
  for (const name of ['sourceCommit', 'sourceTree', 'packagingCommit', 'packagingTree']) sha(p[name], 40);
  for (const name of ['runId', 'runAttempt', 'jobId', 'artifactId']) id(p[name]); filePin(p.zip, 768 * 1024 * 1024);
  keys(p.files, ['package-receipt.json', 'Creator Hub_0.1.16_amd64.AppImage',
    'Creator.Hub.Native.Support_0.1.16_amd64.AppImage', 'portable-manifest.unsigned.json',
    'creator-hub-linux-x86_64-0.1.16.appdir.tar.gz', 'appdir-original-inventory.json', 'appdir-flattened-inventory.json']);
  for (const [name, entry] of Object.entries(p.files)) filePin(entry, name.endsWith('.json') ? 2 * 1024 * 1024 : 256 * 1024 * 1024);
  assert.deepEqual(p.files['Creator Hub_0.1.16_amd64.AppImage'], p.files['Creator.Hub.Native.Support_0.1.16_amd64.AppImage'],
    'Native Support must be the actual same-byte alias, not another executable');
  return value;
}
function api(proof, expected) {
  keys(proof, ['run', 'job', 'artifact', 'commit']);
  const { run, job, artifact, commit } = proof;
  assert.equal(run.id, expected.runId); assert.equal(run.run_attempt, expected.runAttempt);
  assert.equal(run.head_sha, expected.harnessSource); assert.equal(run.head_branch, expected.branch);
  assert.equal(run.path, expected.workflow); assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
  for (const repo of [run.repository, run.head_repository]) {
    assert.equal(repo.id, producer.REPO_ID); assert.equal(repo.full_name, producer.REPO);
  }
  assert.equal(commit.sha, expected.harnessSource); assert.equal(commit.tree.sha, expected.harnessTree);
  id(job.id); assert.equal(job.run_id, run.id); assert.equal(job.run_attempt, run.run_attempt);
  assert.equal(job.head_sha, run.head_sha); assert.equal(job.name, 'package');
  assert.equal(job.status, 'completed'); assert.equal(job.conclusion, 'success');
  assert.ok(Array.isArray(job.labels) && job.labels.includes('ubuntu-22.04'));
  if (expected.jobId !== undefined) assert.equal(job.id, expected.jobId);
  assert.equal(artifact.id, expected.artifactId); assert.equal(artifact.name, expected.artifactName);
  assert.equal(artifact.expired, false); assert.equal(artifact.size_in_bytes, expected.zip.size);
  assert.equal(artifact.digest, `sha256:${expected.zip.sha256}`);
  for (const [name, value] of Object.entries({ id: run.id, head_sha: run.head_sha, head_branch: run.head_branch,
    repository_id: producer.REPO_ID, head_repository_id: producer.REPO_ID })) assert.equal(artifact.workflow_run[name], value);
  const start = Date.parse(job.started_at), finish = Date.parse(job.completed_at), created = Date.parse(artifact.created_at);
  assert.ok(Number.isFinite(start) && Number.isFinite(finish) && Number.isFinite(created) && start <= created && created <= finish,
    'Artifact is not bound to the successful native producer job interval');
  return { runId: run.id, runAttempt: run.run_attempt, jobId: job.id, artifactId: artifact.id,
    sourceCommit: run.head_sha, sourceTree: commit.tree.sha, zip: expected.zip };
}
function flatpakAPI(proof) {
  return api(proof, { ...FIXED, branch: producer.BRANCH.slice('refs/heads/'.length), workflow: producer.WORKFLOW,
    artifactName: `linux-016-production-flatpak-${FIXED.runId}-${FIXED.runAttempt}` });
}
function portableAPI(proof, value) {
  const p = validateProfile(value).portable;
  return api(proof, { ...p, harnessSource: p.packagingCommit, harnessTree: p.packagingTree,
    branch: 'validation/linux-016-portable-production', workflow: '.github/workflows/linux-016-portable-production.yml',
    artifactName: `linux-016-production-portable-unsigned-${p.runId}-${p.runAttempt}` });
}
function flatpakFiles(bytes, sources) {
  keys(bytes, Object.keys(FIXED.files));
  for (const [name, expected] of Object.entries(FIXED.files)) bound(bytes[name], expected);
  const receipt = JSON.parse(bytes['production-flatpak-receipt.json']);
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.profile, producer.PROFILE);
  assert.equal(receipt.version, producer.VERSION); assert.equal(receipt.appId, producer.ID);
  assert.equal(receipt.architecture, 'x86_64'); assert.equal(receipt.ref, producer.REF);
  assert.equal(receipt.packagingCompleted, true); assert.equal(receipt.bundleInspectionPassed, true);
  assert.equal(receipt.distribution, 'manual-single-file-bundle');
  assert.equal(receipt.nativeHostModel, 'separately-approved-outside-sandbox');
  assert.equal(receipt.nativeHostUpdates, 'separate-signed-native-updater'); assert.equal(receipt.runtimeProvisioned, false);
  for (const name of Object.keys(producer.FLAGS)) assert.equal(receipt[name], false);
  const binding = receipt.source, input = producer.validate(binding.input);
  assert.equal(binding.schemaVersion, 1); assert.equal(binding.profile, producer.PROFILE);
  assert.equal(binding.harnessSource, FIXED.harnessSource); assert.equal(binding.runId, String(FIXED.runId));
  assert.equal(binding.runAttempt, String(FIXED.runAttempt));
  for (const name of Object.keys(producer.FLAGS)) assert.equal(binding[name], false);
  assert.equal(input.sourceCommit, FIXED.sourceCommit); assert.equal(input.sourceTree, FIXED.sourceTree);
  assert.deepEqual(binding.api, { repositoryId: producer.REPO_ID, sourceCommit: FIXED.sourceCommit, sourceTree: FIXED.sourceTree });
  keys(sources, producer.SOURCES);
  for (const name of producer.SOURCES) bound(sources[name], input.files[name]); producer.validateSource(sources);
  const build = receipt.build;
  assert.equal(build.toolchain, producer.TOOLCHAIN); assert.equal(build.target, producer.TARGET);
  assert.equal(build.onlyLauncherCompiled, true); assert.deepEqual(build.files, input.files);
  assert.deepEqual(build.publicKey, input.files[producer.KEY]); assert.deepEqual(build.launcher, FIXED.files[producer.COMMAND]);
  // These are recorded Linux arguments, not paths interpreted by this reader's OS.
  assert.deepEqual(build.arguments, ['build', '--release', '--locked', '--no-default-features', '--manifest-path',
    '/home/runner/work/_temp/flatpak-native-production-016/source/native/flatpak-native-activation/Cargo.toml',
    '--bin', producer.COMMAND, '--target', producer.TARGET, '--target-dir',
    '/home/runner/work/_temp/flatpak-native-production-016/target']);
  assert.deepEqual(receipt.bundle, { name: producer.BUNDLE, ...FIXED.files[producer.BUNDLE] });
  const expected = producer.expectedInventory(producer.payload(bytes[producer.COMMAND], sources));
  assert.deepEqual(receipt.inspection, { commit: FIXED.commit, bundle: FIXED.files[producer.BUNDLE], inventory: expected,
    runtime: producer.RUNTIME, sdk: producer.SDK, declaredPermissions: [...producer.PERMISSIONS] });
  return { source: input, commit: FIXED.commit, files: FIXED.files, inventory: expected, ...FALSE_GATES };
}
function signedInput(value) {
  keys(value, ['schemaVersion', 'artifactId', 'runId', 'sourceCommit', 'zip', 'files']);
  assert.equal(value.schemaVersion, 1); id(value.artifactId); id(value.runId); sha(value.sourceCommit, 40);
  filePin(value.zip, 8 * 1024 * 1024); keys(value.files, SIGNED_FILES);
  for (const [name, entry] of Object.entries(value.files)) filePin(entry, name.endsWith('.minisig') ? 4096 : 2 * 1024 * 1024);
  return value;
}
function preflight(env = process.env) {
  admission(env, process.platform, process.arch, process.getuid?.());
  for (const name of ['CONTROLLER_PROFILE', 'SIGNED_INPUT']) assert.ok(typeof env[name] === 'string' && Buffer.byteLength(env[name]) <= 16384);
  return { profile: validateProfile(JSON.parse(env.CONTROLLER_PROFILE)), signed: signedInput(JSON.parse(env.SIGNED_INPUT)) };
}
function carrier(proof, input) {
  const { artifact, run, commit } = proof;
  assert.equal(run.id, input.runId); assert.equal(run.head_sha, input.sourceCommit);
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
  assert.equal(commit.sha, input.sourceCommit); sha(commit.tree.sha, 40);
  for (const repo of [run.repository, run.head_repository]) {
    assert.equal(repo.id, producer.REPO_ID); assert.equal(repo.full_name, producer.REPO);
  }
  assert.equal(artifact.id, input.artifactId); assert.equal(artifact.expired, false);
  assert.equal(artifact.size_in_bytes, input.zip.size); assert.equal(artifact.digest, `sha256:${input.zip.sha256}`);
  assert.equal(artifact.workflow_run.id, run.id); assert.equal(artifact.workflow_run.head_sha, run.head_sha);
  for (const key of ['repository_id', 'head_repository_id']) assert.equal(artifact.workflow_run[key], producer.REPO_ID);
}
async function collect(github, context, env = process.env) {
  const request = preflight(env), repo = { owner: 'BOBWORKS-XR', repo: 'CREATOR-HUB' };
  assert.equal(context.sha, env.GITHUB_SHA); assert.equal(context.ref, BRANCH); assert.equal(context.eventName, 'workflow_dispatch');
  assert.equal(`${context.repo.owner}/${context.repo.repo}`, producer.REPO);
  const get = async (name, args) => (await github.rest[name[0]][name[1]]({ ...repo, ...args })).data;
  const proof = async (runId, artifactId, sourceCommit, jobId) => {
    const run = await get(['actions', 'getWorkflowRun'], { run_id: runId });
    const artifact = await get(['actions', 'getArtifact'], { artifact_id: artifactId });
    const commit = await get(['git', 'getCommit'], { commit_sha: sourceCommit });
    let job;
    if (jobId !== undefined) job = await get(['actions', 'getJobForWorkflowRun'], { job_id: jobId });
    else {
      const listing = await get(['actions', 'listJobsForWorkflowRunAttempt'], { run_id: runId, attempt_number: 1, per_page: 100 });
      assert.ok(listing.total_count === listing.jobs.length && listing.jobs.length <= 8);
      const jobs = listing.jobs.filter(row => row.name === 'package' && row.conclusion === 'success');
      assert.equal(jobs.length, 1); job = jobs[0];
    }
    return { run, artifact, commit, job };
  };
  const flatpak = await proof(FIXED.runId, FIXED.artifactId, FIXED.harnessSource);
  flatpakAPI(flatpak);
  const p = request.profile.portable, portable = await proof(p.runId, p.artifactId, p.packagingCommit, p.jobId);
  portableAPI(portable, request.profile);
  const hostCommit = await get(['git', 'getCommit'], { commit_sha: p.sourceCommit });
  assert.equal(hostCommit.sha, p.sourceCommit); assert.equal(hostCommit.tree.sha, p.sourceTree);
  const source = await get(['git', 'getCommit'], { commit_sha: FIXED.sourceCommit });
  assert.equal(source.sha, FIXED.sourceCommit); assert.equal(source.tree.sha, FIXED.sourceTree);
  const signed = { run: await get(['actions', 'getWorkflowRun'], { run_id: request.signed.runId }),
    artifact: await get(['actions', 'getArtifact'], { artifact_id: request.signed.artifactId }),
    commit: await get(['git', 'getCommit'], { commit_sha: request.signed.sourceCommit }) };
  carrier(signed, request.signed); // Carrier provenance only; never signature authority.
  const temp = fs.realpathSync(env.RUNNER_TEMP); assert.equal(temp, env.RUNNER_TEMP);
  const work = path.join(temp, 'native-linux-production-016-flatpak'); fs.mkdirSync(work, { mode: 0o700 });
  const write = (name, value) => fs.writeFileSync(path.join(work, name), value, { flag: 'wx', mode: 0o600 });
  for (const [name, artifactId, expected] of [['flatpak.zip', FIXED.artifactId, FIXED.zip],
    ['portable.zip', p.artifactId, p.zip], ['signed.zip', request.signed.artifactId, request.signed.zip]]) {
    const raw = await get(['actions', 'downloadArtifact'], { artifact_id: artifactId, archive_format: 'zip' });
    assert.ok(Buffer.isBuffer(raw) || raw instanceof ArrayBuffer); const bytes = Buffer.from(raw); bound(bytes, expected); write(name, bytes);
  }
  write('profile.json', env.CONTROLLER_PROFILE); write('signed-input.json', env.SIGNED_INPUT);
  write('api-binding.json', JSON.stringify({ schemaVersion: 1, profile: PROFILE, harnessSource: context.sha,
    flatpak: flatpakAPI(flatpak), portable: portableAPI(portable, request.profile), signedCarrier: request.signed,
    source: { commit: source.sha, tree: source.tree.sha }, ...FALSE_GATES }));
}
function portableFiles(bytes, value) {
  const p = validateProfile(value).portable, packageTools = require('./linux-016-portable-package.cjs');
  const production = packageTools.production016();
  keys(bytes, Object.keys(p.files));
  for (const [name, expected] of Object.entries(p.files)) bound(bytes[name], expected);
  const receipt = JSON.parse(bytes['package-receipt.json']), manifest = JSON.parse(bytes['portable-manifest.unsigned.json']);
  assert.equal(receipt.schemaVersion, 2); assert.equal(receipt.scope, 'unsigned-linux-016-production-portable-packaging-only');
  assert.equal(receipt.packagingSource, p.packagingCommit); assert.equal(receipt.packagingCompleted, true);
  for (const name of ['rootRecompiled', 'privatePayloadChanged', 'payloadResigned', 'applicationLaunched', 'updateAcceptanceTested',
    ...Object.keys(packageTools.flags())]) assert.equal(receipt[name], false);
  const binding = receipt.producer; production.validatePins(binding.pins); production.verifyProducer(binding.pins, binding.proof);
  packageTools.verifyPrivateProof(binding.privateProof);
  assert.equal(binding.pins.sourceCommit, p.sourceCommit); assert.equal(binding.pins.sourceTree, p.sourceTree);
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.appId, 'creator-hub'); assert.equal(manifest.platform, 'linux');
  assert.equal(manifest.architecture, 'x86_64'); assert.equal(manifest.version, '0.1.16');
  assert.equal(manifest.sourceCommit, p.sourceCommit); assert.equal(manifest.sourceTree, p.sourceTree);
  assert.equal(manifest.format, 'appdir-tar-gzip-v1'); assert.equal(manifest.entrypoint, 'usr/bin/creator-hub');
  const inventory = JSON.parse(bytes['appdir-flattened-inventory.json']); packageTools.validateInventory(inventory);
  assert.deepEqual(manifest.entries, inventory.entries); assert.equal(manifest.archive.unpackedSize, inventory.unpackedSize);
  assert.deepEqual({ size: manifest.archive.size, sha256: manifest.archive.sha256 }, p.files['creator-hub-linux-x86_64-0.1.16.appdir.tar.gz']);
  assert.deepEqual(receipt.archive, manifest.archive); assert.deepEqual(receipt.manifest, p.files['portable-manifest.unsigned.json']);
  const alias = receipt.nativeSupportAlias;
  assert.equal(alias.ordinaryName, 'Creator Hub_0.1.16_amd64.AppImage');
  assert.equal(alias.nativeSupportName, 'Creator.Hub.Native.Support_0.1.16_amd64.AppImage');
  assert.deepEqual({ size: alias.size, sha256: alias.sha256 }, p.files[alias.ordinaryName]);
  assert.equal(alias.identicalBytes, true); assert.equal(alias.sourceIdentityRechecked, true);
  assert.equal(alias.nativeExecution, false); assert.equal(alias.releaseReady, false);
  assert.deepEqual(receipt.appImage, p.files[alias.ordinaryName]);
  const host = receipt.portableHostProfile, selector = receipt.selectorBuild;
  assert.deepEqual(host.compiledFeatures, FEATURES); assert.equal(host.appImageContainsProfile, false);
  assert.deepEqual(host.rawExecutable, binding.pins.files['creator-hub']);
  for (const [name, expected] of [['usr/bin/creator-hub', host.executable],
    ['usr/libexec/creator-hub-portable-selector', selector.executable]]) {
    const entry = manifest.entries[name]; assert.equal(entry.kind, 'file'); assert.equal(entry.mode, 0o755);
    assert.deepEqual({ size: entry.size, sha256: entry.sha256 }, expected);
  }
  assert.equal(selector.sourceCommit, p.sourceCommit); assert.equal(selector.sourceTree, p.sourceTree);
  assert.equal(selector.target, producer.TARGET); assert.deepEqual(selector.features, ['experimental-restart']);
  assert.equal(selector.toolchain, '1.99.0-x86_64-unknown-linux-gnu');
  assert.deepEqual(selector.publicKeySource, { size: 119, sha256: '23b3eee2d1c8cb7d705120953cda67ff94a722a207d5be1679c250be8ca90308' });
  for (const name of ['rootRecompiled', 'privateModulesRecompiled', 'nativeExecution', 'releaseReady']) assert.equal(selector[name], false);
  assert.equal(receipt.productionDeb.profile, 'production-migration-016'); assert.equal(receipt.productionDeb.nativeExecution, false);
  assert.equal(receipt.productionDeb.releaseReady, false);
  return { manifest, generation: hash(bytes['portable-manifest.unsigned.json']), root: host.executable,
    selector: selector.executable, sourceCommit: p.sourceCommit, sourceTree: p.sourceTree, ...FALSE_GATES };
}
function staged(env = process.env) {
  const request = preflight(env), temp = fs.realpathSync(env.RUNNER_TEMP);
  const work = path.join(temp, 'native-linux-production-016-flatpak');
  assert.deepEqual(JSON.parse(producer.read(path.join(work, 'profile.json'), 16384)), request.profile);
  assert.deepEqual(JSON.parse(producer.read(path.join(work, 'signed-input.json'), 16384)), request.signed);
  const binding = JSON.parse(producer.read(path.join(work, 'api-binding.json'), 32768));
  keys(binding, ['schemaVersion', 'profile', 'harnessSource', 'flatpak', 'portable', 'signedCarrier', 'source', ...Object.keys(FALSE_GATES)]);
  assert.equal(binding.schemaVersion, 1); assert.equal(binding.profile, PROFILE); assert.equal(binding.harnessSource, env.GITHUB_SHA);
  assert.deepEqual(binding.signedCarrier, request.signed);
  assert.deepEqual(binding.source, { commit: FIXED.sourceCommit, tree: FIXED.sourceTree });
  for (const key of Object.keys(FALSE_GATES)) assert.equal(binding[key], false);
  for (const [actual, expected] of [[binding.flatpak, { runId: FIXED.runId, runAttempt: FIXED.runAttempt, artifactId: FIXED.artifactId,
    sourceCommit: FIXED.harnessSource, sourceTree: FIXED.harnessTree, zip: FIXED.zip }],
    [binding.portable, { runId: request.profile.portable.runId, runAttempt: request.profile.portable.runAttempt,
      jobId: request.profile.portable.jobId, artifactId: request.profile.portable.artifactId,
      sourceCommit: request.profile.portable.packagingCommit, sourceTree: request.profile.portable.packagingTree, zip: request.profile.portable.zip }]]) {
    id(actual.jobId);
    assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, actual[key]])), expected);
  }
  const readSet = (directory, pins) => Object.fromEntries(Object.keys(pins).map(name =>
    [name, producer.read(path.join(work, 'stage', directory, name), pins[name].size)]));
  const files = readSet('flatpak', FIXED.files), receipt = JSON.parse(files['production-flatpak-receipt.json']);
  const sources = readSet('source', receipt.source.input.files);
  const flatpak = flatpakFiles(files, sources), portable = portableFiles(readSet('portable', request.profile.portable.files), request.profile);
  const signed = readSet('signed', request.signed.files);
  for (const [name, expected] of Object.entries(request.signed.files)) bound(signed[name], expected);
  const manifestName = 'creator-hub-linux-x86_64-0.1.16.portable-manifest.json';
  assert.deepEqual(signed[manifestName], producer.read(path.join(work, 'stage/portable/portable-manifest.unsigned.json'), 2 * 1024 * 1024),
    'Signed manifest body differs from the actual portable producer body');
  const d = JSON.parse(signed[SIGNED_FILES[0]]);
  keys(d, ['schemaVersion', 'appId', 'version', 'platform', 'architecture', 'packageType', 'manifest', 'archive',
    'executableSha256', 'restartProtocol', 'minHubVersion']);
  for (const [name, value] of Object.entries({ schemaVersion: 1, appId: 'creator-hub', version: '0.1.16', platform: 'linux',
    architecture: 'x86_64', packageType: 'portable-appdir', executableSha256: portable.root.sha256, restartProtocol: 1 })) assert.equal(d[name], value);
  assert.equal(d.minHubVersion, '0.1.16');
  for (const [asset, name, expected] of [[d.manifest, manifestName, request.signed.files[manifestName]],
    [d.archive, 'creator-hub-linux-x86_64-0.1.16.appdir.tar.gz', request.profile.portable.files['creator-hub-linux-x86_64-0.1.16.appdir.tar.gz']]]) {
    assert.deepEqual(asset, { assetName: name, byteLength: expected.size, sha256: expected.sha256 });
  }
  return { schemaVersion: 1, profile: PROFILE, flatpak, portable, signed: request.signed,
    signaturesVerified: false, runtimeEnabled: false, ...FALSE_GATES };
}
function runtimeUnavailable() {
  throw Error('Runtime controller is not enabled: signed production portable admission, isolated transport and native GUI ownership must be reviewed first. No candidate has been executed.');
}

module.exports = { PROFILE, BRANCH, WORKFLOW, FEATURES, FIXED, FALSE_GATES, SIGNED_FILES, hash, pin, keys, filePin, bound,
  admission, validateProfile, api, flatpakAPI, portableAPI, flatpakFiles, signedInput, preflight, carrier, collect,
  portableFiles, staged, runtimeUnavailable };
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === 'preflight') { preflight(); console.log(JSON.stringify({ profile: PROFILE, ...FALSE_GATES })); }
    else if (args.length === 1 && args[0] === 'verify-staged') console.log(JSON.stringify(staged()));
    else runtimeUnavailable();
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
