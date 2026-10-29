'use strict';
// Distinct production data admission. Never installs, executes or signs a payload.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const neutral = require('./native-linux-016-input.cjs');
const build = require('./build-unified.cjs');
const retirement = require('./linux-retirement-package.cjs');
const { verifyLinuxHub } = require('./unix-package-payload.cjs');
const COHORT = 'production-migration-016';
const REF = 'refs/heads/validation/native-linux-journal-production-016';
const PRIVATE = Object.freeze({ sourceCommit: '085131ba6f3050a795fd513139a34975658ba321', runId: 40538427509, runAttempt: 1 });
const JOURNAL_A_PRIVATE = Object.freeze({ sourceCommit: 'f9c6da1af4ea51fc0214fba058c3946c1cda255a', runId: 40893082867, runAttempt: 1 });
const JOURNAL_A_PRIVATE_TREE = 'c747ce8b9cd65169ba478162f9abb6c500be6186';
const FEATURES = Object.freeze(['integrated-features', 'experimental-flatpak-host',
  'linux-production-migration', 'experimental-linux-portable-update']);
const PINS = Object.freeze([...neutral.PINS, 'rawHub']);
const REPO = { owner: 'BOBWORKS-XR', repo: 'CREATOR-HUB' };
const FLAGS = Object.freeze({ nativeExecution: false, nativeGuiAccepted: false, migrationAccepted: false,
  authenticationAccepted: false, signedUpdateAccepted: false, automaticRestartAccepted: false,
  flatpakAccepted: false, releaseReady: false });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const JOURNAL_A_PROFILE_SHA = '08f2df3b8139f00f5bd5b84619218228c7878d62ae0e4ec180fdcaaec6b87fc3';
function journalAProfile() {
  const bytes = fs.readFileSync(path.join(__dirname, 'fixtures/journal-a-native-incoming.UNBOUND.json'));
  assert.equal(bytes.length, 1763); assert.equal(hash(bytes), JOURNAL_A_PROFILE_SHA);
  return JSON.parse(bytes);
}
function keys(value, expected) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'Unknown/missing production fields');
}
function sha(value, length = 64) { assert.ok(typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value)); }
function id(value) { assert.ok(Number.isSafeInteger(value) && value > 0); }
function validate(value) {
  keys(value, ['schemaVersion', 'cohort', 'mode', 'assembly', 'pins']);
  assert.equal(value.schemaVersion, 1); assert.equal(value.cohort, COHORT);
  assert.ok(['pages', 'migration-cancel'].includes(value.mode), 'Production approval/update/Flatpak execution is not implemented');
  keys(value.assembly, ['sourceCommit', 'sourceTree', 'runId', 'runAttempt', 'jobId', 'artifactId', 'zipBytes', 'zipSha256']);
  for (const field of ['sourceCommit', 'sourceTree']) sha(value.assembly[field], 40);
  sha(value.assembly.zipSha256);
  for (const field of ['runId', 'runAttempt', 'jobId', 'artifactId', 'zipBytes']) id(value.assembly[field]);
  assert.ok(value.assembly.zipBytes <= 300 * 1024 * 1024);
  keys(value.pins, PINS);
  for (const field of PINS) {
    const pin = value.pins[field]; keys(pin, ['size', 'sha256']); id(pin.size); sha(pin.sha256);
    assert.ok(pin.size <= 256 * 1024 * 1024);
  }
  assert.ok(value.pins.rawHub.size >= 64);
  if (privateFor(value.assembly) === JOURNAL_A_PRIVATE) assert.deepEqual(value, journalAProfile(), 'Fresh A profile differs');
  return value;
}
function admission(context, env) {
  assert.equal(`${context.repo.owner}/${context.repo.repo}`, 'BOBWORKS-XR/CREATOR-HUB');
  assert.equal(context.eventName, 'workflow_dispatch'); assert.equal(context.ref, REF); sha(context.sha, 40);
  for (const [key, expected] of Object.entries({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
    GITHUB_REPOSITORY_ID: '1364807512', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: REF, GITHUB_SHA: context.sha })) assert.equal(env[key], expected);
}
function privateFor(assembly) {
  const expected = neutral.JOURNAL_A_ASSEMBLY;
  const isCandidate = ['sourceCommit', 'runId', 'jobId', 'artifactId'].some(key => assembly[key] === expected[key]);
  if (!isCandidate) return PRIVATE;
  assert.deepEqual(assembly, expected, 'Fresh A assembly tuple is incomplete or mixed');
  return JOURNAL_A_PRIVATE;
}
async function sourceBinding(github, assembly) {
  const privateSource = privateFor(assembly);
  const { data } = await github.rest.git.getCommit({ ...REPO, commit_sha: assembly.sourceCommit });
  assert.equal(data.sha, assembly.sourceCommit); assert.equal(data.tree.sha, assembly.sourceTree);
  if (privateSource === JOURNAL_A_PRIVATE) {
    const { data: producerCommit } = await github.rest.git.getCommit({ ...REPO, commit_sha: privateSource.sourceCommit });
    assert.equal(producerCommit.sha, privateSource.sourceCommit); assert.equal(producerCommit.tree.sha, JOURNAL_A_PRIVATE_TREE);
  }
  const original = await neutral.treePaths(github, privateSource.sourceCommit);
  const current = await neutral.treePaths(github, assembly.sourceCommit);
  assert.deepEqual(current, original, 'Signed private payload source paths changed');
  return current;
}
function proofs(receipt, supplied) {
  const p = validate(supplied);
  const privateSource = privateFor(p.assembly);
  keys(receipt, ['schemaVersion', 'product', 'platform', 'arch', 'hubVersion', 'assemblyCommit', 'privateSource',
    'handoffSha256', 'compiledFeatures', 'portableHostBuild', 'productionMigration', 'mcpMode',
    'privateModulesRecompiled', 'privateModulesResigned', 'nativeGuiAccepted', 'releaseReady']);
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.product, 'com.creatorworks.hub.unix-signed-assembly');
  assert.equal(receipt.platform, 'linux'); assert.equal(receipt.arch, 'x86_64'); assert.equal(receipt.hubVersion, '0.1.16');
  assert.equal(receipt.assemblyCommit, p.assembly.sourceCommit); assert.equal(receipt.mcpMode, 'writable');
  for (const key of ['privateModulesRecompiled', 'privateModulesResigned', 'nativeGuiAccepted', 'releaseReady']) assert.equal(receipt[key], false);
  for (const key of ['sourceCommit', 'runId', 'runAttempt']) assert.equal(receipt.privateSource[key], privateSource[key]);
  if (privateSource === JOURNAL_A_PRIVATE) {
    assert.equal(receipt.privateSource.repository, 'BOBWORKS-XR/CREATOR-HUB');
    assert.equal(receipt.privateSource.repositoryId, 1364807512);
    assert.equal(receipt.privateSource.workflow, '.github/workflows/unix-managed-payload.yml');
    assert.equal(receipt.privateSource.event, 'workflow_dispatch');
    assert.equal(receipt.privateSource.buildCommit, privateSource.sourceCommit);
    assert.equal(receipt.privateSource.sourceTree, JOURNAL_A_PRIVATE_TREE);
  }
  sha(receipt.handoffSha256);
  assert.deepEqual(receipt.compiledFeatures, FEATURES, 'Exact explicit production feature tuple required');
  build.validateProductionBuildProof(receipt.productionMigration, p.assembly.sourceCommit, FEATURES);
  build.validatePortableBuildProof(receipt.portableHostBuild, p.assembly.sourceCommit, FEATURES, p.pins.rawHub, p.assembly.sourceTree);
  assert.equal(receipt.productionMigration.sourceTree, p.assembly.sourceTree);
  assert.deepEqual(receipt.productionMigration.rawHub, p.pins.rawHub);
  for (const [key, member] of [['helper', retirement.HELPER], ['policy', retirement.POLICY]]) {
    const record = receipt.productionMigration.staging.files[member];
    assert.equal(record.sha256, p.pins[key].sha256); assert.equal(record.size, p.pins[key].size);
  }
  assert.equal(hash(retirement.SERVICE_BYTES), p.pins.service.sha256);
  assert.equal(retirement.SERVICE_BYTES.length, p.pins.service.size);
  return { cohort: COHORT, sourceCommit: p.assembly.sourceCommit, sourceTree: p.assembly.sourceTree,
    compiledFeatures: [...FEATURES], rawHub: p.pins.rawHub, hub: p.pins.hub,
    productionContract: receipt.productionMigration.staging.productionContract, ...FLAGS };
}
function inspectBuffers(receipt, p, raw, packaged) {
  const result = proofs(receipt, p);
  for (const [bytes, pin] of [[raw, p.pins.rawHub], [packaged, p.pins.hub]]) {
    assert.ok(Buffer.isBuffer(bytes)); assert.equal(bytes.length, pin.size); assert.equal(hash(bytes), pin.sha256);
    assert.ok(bytes.length >= 64 && bytes.subarray(0, 7).equals(Buffer.from([127, 69, 76, 70, 2, 1, 1]))
      && bytes[18] === 0x3e && bytes[19] === 0, 'Native x86_64 ELF required');
  }
  verifyLinuxHub(raw, packaged, 'deb');
  return { ...result, rawToPackaged: 'exact-tauri-bundle-marker-deb' };
}
async function run({ github, context, profile, env = process.env, fetch_ = fetch }) {
  admission(context, env);
  assert.ok(typeof profile === 'string' && Buffer.byteLength(profile) <= 16384);
  const p = validate(JSON.parse(profile));
  const privateSource = privateFor(p.assembly);
  if (privateSource === JOURNAL_A_PRIVATE) assert.equal(hash(Buffer.from(profile)), JOURNAL_A_PROFILE_SHA, 'Fresh A profile bytes differ');
  const { data: privateRun } = await github.rest.actions.getWorkflowRun({ ...REPO, run_id: privateSource.runId });
  neutral.producer(privateRun, privateSource, '.github/workflows/unix-managed-payload.yml',
    privateSource === JOURNAL_A_PRIVATE ? 'validation/journal-a-payload-016' : 'validation/unix-payload-016');
  if (privateSource === JOURNAL_A_PRIVATE) assert.equal(privateRun.event, 'workflow_dispatch');
  const { data: assembly } = await github.rest.actions.getWorkflowRun({ ...REPO, run_id: p.assembly.runId });
  const { data: job } = await github.rest.actions.getJobForWorkflowRun({ ...REPO, job_id: p.assembly.jobId });
  const { data: artifact } = await github.rest.actions.getArtifact({ ...REPO, artifact_id: p.assembly.artifactId });
  if (privateSource === JOURNAL_A_PRIVATE) neutral.journalAFreshArtifactBinding(assembly, job, artifact, p.assembly);
  else neutral.artifactBinding(assembly, job, artifact, p.assembly);
  const paths = await sourceBinding(github, p.assembly);
  const { data } = await github.rest.actions.downloadArtifact({ ...REPO, artifact_id: p.assembly.artifactId, archive_format: 'zip' });
  assert.ok(Buffer.isBuffer(data) || data instanceof ArrayBuffer);
  const bytes = Buffer.from(data); assert.equal(bytes.length, p.assembly.zipBytes); assert.equal(hash(bytes), p.assembly.zipSha256);
  const output = path.join(fs.realpathSync(env.RUNNER_TEMP), 'native-linux-production-016-input');
  fs.mkdirSync(output, { mode: 0o700 });
  const write = (name, body) => fs.writeFileSync(path.join(output, name), body, { flag: 'wx', mode: 0o600 });
  write('assembly.zip', bytes);
  const legacy = [];
  for (const row of neutral.LEGACY) {
    const value = await neutral.publicDeb(github, row, fetch_);
    write(`${row.product}.deb`, value.bytes); legacy.push(value.receipt);
  }
  // Keep original text: the strict offline decoder rejects duplicate keys.
  write('profile.json', profile);
  write('api-binding.json', JSON.stringify({ schemaVersion: 1, cohort: COHORT, harnessSource: context.sha,
    assembly: p.assembly, privatePayload: privateSource, privateSourcePaths: paths, legacy, ...FLAGS }));
}
function readOwned(file, maximum) {
  assert.equal(fs.realpathSync(file), file);
  const before = fs.lstatSync(file);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.uid === process.getuid()
    && (before.mode & 0o7777) === 0o600 && before.size > 0 && before.size <= maximum);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const stamp = s => [s.dev, s.ino, s.size, s.mode, s.nlink, s.uid, s.gid, s.mtimeMs, s.ctimeMs];
  try {
    assert.deepEqual(stamp(fs.fstatSync(fd)), stamp(before));
    const buffer = Buffer.alloc(before.size + 1);
    let received = 0;
    while (received < buffer.length) {
      const count = fs.readSync(fd, buffer, received, buffer.length - received, null);
      if (count === 0) break;
      received += count;
    }
    assert.equal(received, before.size);
    const bytes = buffer.subarray(0, received);
    assert.deepEqual(stamp(fs.fstatSync(fd)), stamp(before));
    assert.deepEqual(stamp(fs.lstatSync(file)), stamp(before));
    return bytes;
  } finally { fs.closeSync(fd); }
}
function verifyStaged(env) {
  const context = { repo: REPO, eventName: env.GITHUB_EVENT_NAME, ref: env.GITHUB_REF, sha: env.GITHUB_SHA };
  admission(context, env);
  assert.equal(env.CREATOR_NATIVE_LINUX_PRODUCTION_016, '1');
  assert.equal(process.platform, 'linux'); assert.ok(process.getuid() > 0);
  for (const key of Object.keys(env)) assert.ok(!/^(LD_|DYLD_|WEBKIT_|TAURI_)/.test(key)
    && !['NODE_OPTIONS', 'PYTHONPATH', 'PYTHONHOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].includes(key));
  for (const key of ['APPIMAGE', 'APPDIR', 'FLATPAK_ID']) assert.ok(!env[key]);
  const temp = fs.realpathSync(env.RUNNER_TEMP); assert.equal(temp, env.RUNNER_TEMP);
  const input = path.join(temp, 'native-linux-production-016-input'), stage = path.join(temp, 'native-linux-production-016-stage');
  for (const directory of [input, stage]) {
    assert.equal(fs.realpathSync(directory), directory);
    const info = fs.lstatSync(directory); assert.ok(info.isDirectory() && info.uid === process.getuid() && (info.mode & 0o7777) === 0o700);
  }
  const p = validate(JSON.parse(readOwned(path.join(input, 'profile.json'), 16384)));
  const receiptBytes = readOwned(path.join(stage, 'assemblyReceipt.bin'), 262144);
  assert.equal(receiptBytes.length, p.pins.assemblyReceipt.size); assert.equal(hash(receiptBytes), p.pins.assemblyReceipt.sha256);
  return inspectBuffers(JSON.parse(receiptBytes), p,
    readOwned(path.join(stage, 'rawHub.bin'), p.pins.rawHub.size), readOwned(path.join(stage, 'hub.bin'), p.pins.hub.size));
}
module.exports = { COHORT, REF, PRIVATE, JOURNAL_A_PRIVATE, FEATURES, PINS, FLAGS, validate, admission, privateFor, sourceBinding, proofs, inspectBuffers, run };
if (require.main === module) {
  try {
    assert.deepEqual(process.argv.slice(2), ['--verify-staged']);
    process.stdout.write(JSON.stringify(verifyStaged(process.env)));
  } catch (error) { process.stderr.write(String(error.message).slice(0, 2048) + '\n'); process.exitCode = 1; }
}
