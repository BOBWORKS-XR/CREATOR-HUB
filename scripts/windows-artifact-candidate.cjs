'use strict';
// CI Root-only assembly from independently reviewed, already-signed managed payloads.
// No signer, release API writes, local installation or frozen-receipt overrides.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { readBounded } = require('./read-bounded-input.cjs');

const REPO = 'BOBWORKS-XR/CREATOR-HUB';
const REF = 'refs/heads/validation/windows-local-016-20261027';
const WORKFLOW = '.github/workflows/windows-artifact-candidate.yml';
const VERSION = '0.1.16';
const ASSET = `Creator.Hub_${VERSION}_x64-setup.exe`;
const META = 2 * 1024 * 1024, BINARY = 512 * 1024 * 1024;
const SOURCE_PATHS = ['src', 'src-tauri', 'modules', 'native', 'scripts', 'package.json',
  'package-lock.json', 'rust-toolchain.toml', '.cargo', '.npmrc', '.gitattributes'];
const CANDIDATE_FILES = [ASSET, 'creator-hub.exe', 'raw-creator-hub.exe', 'builtin-manifest.json', 'source-manifest.json'];
// Windows payload assembly reads these helpers; acceptance tests are not build inputs.
const PAYLOAD_BUILD_FILES = ['scripts/build-unified.cjs', 'scripts/managed-router-package.cjs',
  'scripts/mcp-runtime-descriptor.cjs', 'scripts/unix-managed-payload.cjs', 'scripts/unix-package-payload.cjs',
  'scripts/linux-retirement-package.cjs', 'package.json', 'package-lock.json', 'rust-toolchain.toml',
  'src-tauri/tauri.conf.json', '.npmrc', '.gitattributes'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value) + '\n');
const read = (file, limit = META) => readBounded(path.resolve(file), limit);
const json = file => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read(file)));
const write = (file, value) => fs.writeFileSync(file, jsonBytes(value), { flag: 'wx' });
const digest = value => assert.match(value || '', /^[a-f0-9]{64}$/, 'Exact SHA256 required');
const commit = value => assert.match(value || '', /^[a-f0-9]{40}$/, 'Exact source commit required');
const id = value => assert.match(value || '', /^[1-9][0-9]{0,19}$/, 'Positive decimal identity required');
function keys(value, expected) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'Unexpected contract fields');
}
function assertRunner(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32', 'Windows only');
  for (const [name, expected] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Windows', GITHUB_REPOSITORY: REPO, GITHUB_REF: REF, GITHUB_EVENT_NAME: 'workflow_dispatch' })) {
    assert.equal(env[name], expected, 'Explicit disposable Windows artifact lane required');
  }
}
function cleanEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/TOKEN|SECRET|PASSWORD|PRIVATE_KEY|SIGNING|CREDENTIAL|AUTHORIZATION|PROXY|^NODE_OPTIONS$|^NODE_TLS_|^NODE_EXTRA_CA_CERTS$|^SSL_CERT_|^CURL_CA_BUNDLE$|^REQUESTS_CA_BUNDLE$|^CREATOR_|^CARGO_TARGET_DIR$|^RUSTFLAGS$|^RUSTC_WRAPPER$|^RUSTC_WORKSPACE_WRAPPER$|^CARGO_.*RUSTFLAGS$|^TAURI_/i.test(name)));
}
function sourcePath(name) {
  assert.ok(typeof name === 'string' && !/[\\:]/.test(name) && !name.startsWith('/') &&
    !name.split('/').some(part => ['', '.', '..'].includes(part)), 'Unsafe source path');
  return SOURCE_PATHS.some(prefix => name === prefix || name.startsWith(prefix + '/')) &&
    !/(^|\/)(node_modules|target|\.git|__pycache__|release)(\/|$)/.test(name) &&
    !/\/gen\/schemas\//.test(name) && !/^scripts\/windows-artifact-/.test(name);
}
function snapshot(root, execute = execFileSync) {
  const names = String(execute('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...SOURCE_PATHS],
    { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: META })).split('\0').filter(Boolean);
  const files = [...new Set(names)].filter(sourcePath).filter(name => fs.existsSync(path.join(root, name))).sort()
    .map(name => ({ path: name, sha256: hash(read(path.join(root, name), BINARY)) }));
  assert.ok(files.length > 0 && files.length < 10000, 'Source inventory bound');
  return { schemaVersion: 1, files };
}
function validateSnapshot(value) {
  keys(value, ['schemaVersion', 'files']); assert.equal(value.schemaVersion, 1);
  assert.ok(Array.isArray(value.files) && value.files.length > 0 && value.files.length < 10000);
  let previous = '';
  for (const file of value.files) {
    keys(file, ['path', 'sha256']); assert.ok(sourcePath(file.path)); digest(file.sha256);
    assert.ok(file.path > previous, 'Source paths must be sorted and unique'); previous = file.path;
  }
  return value;
}
function payloadSourcePath(name) {
  if (PAYLOAD_BUILD_FILES.includes(name) || name.startsWith('.cargo/')) return true;
  if (!/^(modules\/(mcp|project-setup)\/|native\/mcp-router\/)/.test(name)) return false;
  if (/(^|\/)(test|tests|docs|dist)(\/|$)|\.(test|spec)\.|_tests\.rs$/.test(name)) return false;
  if (/\/scripts\//.test(name)) return name === 'modules/mcp/scripts/stage-node-runtime.mjs';
  return !/\.(md|yml|yaml)$/.test(name) || /\/(LICENSE|THIRD_PARTY_NOTICES\.md)$/.test(name);
}
function payloadSourceHash(source) {
  validateSnapshot(source);
  const files = source.files.filter(file => payloadSourcePath(file.path));
  assert.ok(files.length > 0); return hash(jsonBytes(files));
}
function buildPaths(root, out) {
  return { target: path.join(root, 'src-tauri/target'), artifact: path.join(out, 'artifact') };
}
function assertSource(root, expectedCommit, expectedHash) {
  commit(expectedCommit); digest(expectedHash);
  const actual = String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true })).trim();
  assert.equal(actual, expectedCommit, 'Product checkout changed');
  const source = snapshot(root); assert.equal(hash(jsonBytes(source)), expectedHash, 'Frozen product manifest differs');
  return source;
}
function identity(value) {
  keys(value, ['runId', 'artifactId', 'archiveSha256', 'receiptSha256', 'producerCommit', 'producerWorkflow']);
  id(value.runId); id(value.artifactId); digest(value.archiveSha256); digest(value.receiptSha256); commit(value.producerCommit);
  assert.match(value.producerWorkflow, /^\.github\/workflows\/[a-z0-9-]+\.yml$/);
  return value;
}
function boundIdentity(value) {
  keys(value, ['runId', 'artifactId', 'archiveSha256', 'receiptSha256', 'producerCommit', 'producerWorkflow', 'runAttempt']);
  const { runAttempt, ...input } = value; identity(input);
  assert.ok(Number.isSafeInteger(runAttempt) && runAttempt > 0); return value;
}
function bindArtifact(input, artifact, run, kind) {
  identity(input); assert.ok(['payload', 'candidate'].includes(kind));
  assert.equal(String(artifact.id), input.artifactId); assert.equal(String(artifact.workflow_run.id), input.runId);
  assert.equal(artifact.expired, false); assert.ok(artifact.size_in_bytes > 0 && artifact.size_in_bytes <= BINARY);
  assert.equal(artifact.digest, `sha256:${input.archiveSha256}`);
  assert.equal(artifact.name, `creator-hub-windows-${kind === 'payload' ? 'signed-payload' : 'ci-candidate'}`);
  assert.equal(String(run.id), input.runId); assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
  assert.equal(run.repository.full_name, REPO); assert.equal(run.head_repository.full_name, REPO);
  assert.equal(run.head_sha, input.producerCommit); assert.equal(run.path, input.producerWorkflow);
  assert.equal(artifact.workflow_run.head_sha, run.head_sha);
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
  if (kind === 'candidate') assert.equal(run.path, WORKFLOW, 'Candidate must come from this producer');
  return { ...input, runAttempt: run.run_attempt };
}
function inventory(directory) {
  const files = [];
  function walk(folder, prefix = '', depth = 0) {
    assert.ok(depth < 12); assert.equal(fs.lstatSync(folder).isSymbolicLink(), false, 'Linked artifact refused');
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      const name = prefix + item.name, file = path.join(folder, item.name);
      assert.equal(fs.lstatSync(file).isSymbolicLink(), false, 'Linked artifact refused');
      if (item.isDirectory()) walk(file, name + '/', depth + 1);
      else { assert.ok(item.isFile()); files.push(name); assert.ok(files.length <= 64, 'Artifact file bound'); }
    }
  }
  walk(directory); return files.sort();
}
function verifyPayload(root, directory, binding, source) {
  boundIdentity(binding);
  assert.equal(hash(read(path.join(directory, 'payload-source.json'))), binding.receiptSha256);
  const proof = json(path.join(directory, 'payload-source.json'));
  keys(proof, ['schemaVersion', 'kind', 'payloadSourceSha256', 'manifestSha256', 'runtimeSha256']);
  assert.equal(proof.schemaVersion, 1); assert.equal(proof.kind, 'reviewed-windows-managed-payload');
  assert.equal(proof.payloadSourceSha256, payloadSourceHash(source), 'Payload was built from different module/tooling inputs');
  assert.equal(hash(read(path.join(directory, 'builtin-manifest.json'))), proof.manifestSha256);
  assert.equal(hash(read(path.join(directory, 'mcp-runtime.json'))), proof.runtimeSha256);
  const manifest = json(path.join(directory, 'builtin-manifest.json'));
  keys(manifest, ['schemaVersion', 'platform', 'arch', 'modules', 'managedRouting']);
  assert.equal(manifest.platform, 'windows'); assert.equal(manifest.arch, 'x86_64');
  require('./build-unified.cjs').verifyStage(path.join(directory, 'modules'), manifest);
  const files = Object.assign({}, manifest.modules.mcp.files, manifest.modules.setup.files, manifest.managedRouting.files);
  assert.deepEqual(inventory(directory), ['builtin-manifest.json', 'mcp-runtime.json', 'payload-source.json',
    ...Object.keys(files).map(name => `modules/${name}`)].sort());
  for (const [name, expected] of Object.entries(files)) assert.equal(hash(read(path.join(directory, 'modules', name), BINARY)), expected);
  assert.deepEqual(read(path.join(directory, 'mcp-runtime.json')), read(path.join(directory, 'modules/routing/runtime.json')));
  assert.deepEqual(json(path.join(directory, 'mcp-runtime.json')),
    require('./mcp-runtime-descriptor.cjs').runtimeDescriptor(manifest, VERSION));
  return manifest; // Cryptographic verification is mandatory in produce(), not inferred from hashes.
}
function record(file, max = BINARY) { const bytes = read(file, max); return { bytes: bytes.length, sha256: hash(bytes) }; }
function verifyCandidate(directory, receiptPin, expectedSource, binding) {
  keys(expectedSource, ['commit', 'manifestSha256']); commit(expectedSource.commit); digest(expectedSource.manifestSha256);
  digest(receiptPin); assert.equal(hash(read(path.join(directory, 'candidate.json'))), receiptPin);
  const receipt = json(path.join(directory, 'candidate.json'));
  keys(receipt, ['schemaVersion', 'kind', 'version', 'source', 'producer', 'payload', 'files', 'managedSignaturesVerified',
    'localCandidateEquivalent', 'installed', 'signedUpdateAccepted', 'releaseReady']);
  assert.equal(receipt.schemaVersion, 1); assert.equal(receipt.kind, 'ci-windows-direct16-candidate');
  assert.equal(receipt.version, VERSION); assert.equal(receipt.managedSignaturesVerified, true);
  for (const key of ['localCandidateEquivalent', 'installed', 'signedUpdateAccepted', 'releaseReady']) assert.equal(receipt[key], false);
  assert.deepEqual(receipt.source, expectedSource);
  boundIdentity(receipt.payload);
  assert.deepEqual(receipt.producer, { commit: binding.producerCommit, runId: binding.runId, runAttempt: binding.runAttempt });
  keys(receipt.files, CANDIDATE_FILES);
  assert.deepEqual(inventory(directory), [...CANDIDATE_FILES, 'candidate.json'].sort());
  for (const name of CANDIDATE_FILES) assert.deepEqual(record(path.join(directory, name)), receipt.files[name]);
  const source = validateSnapshot(json(path.join(directory, 'source-manifest.json')));
  assert.equal(hash(jsonBytes(source)), expectedSource.manifestSha256);
  const raw = read(path.join(directory, 'raw-creator-hub.exe'), BINARY);
  assert.ok(raw.includes(read(path.join(directory, 'builtin-manifest.json'))), 'Root must embed the exact built-in manifest');
  require('./installer-payload.cjs').verifyBundleMarker(raw,
    read(path.join(directory, 'creator-hub.exe'), BINARY));
  return receipt;
}
function produce(root, payload, out, binding, env = process.env) {
  assertRunner(env); commit(env.SOURCE_COMMIT); digest(env.SOURCE_MANIFEST_SHA256);
  commit(env.GITHUB_SHA); id(env.GITHUB_RUN_ID); id(env.GITHUB_RUN_ATTEMPT);
  for (const directory of [root, payload, out]) assert.ok(path.isAbsolute(directory));
  for (const input of [root, payload]) {
    const relative = path.relative(input, out);
    assert.ok(relative.startsWith('..' + path.sep) || path.isAbsolute(relative), 'Output must be outside input trees');
    const reverse = path.relative(out, input);
    assert.ok(reverse.startsWith('..' + path.sep) || path.isAbsolute(reverse), 'Output must not contain inputs');
  }
  const source = assertSource(root, env.SOURCE_COMMIT, env.SOURCE_MANIFEST_SHA256);
  const manifest = verifyPayload(root, payload, binding, source);
  assert.equal(JSON.parse(read(path.join(root, 'package.json'))).version, VERSION);
  assert.equal(JSON.parse(read(path.join(root, 'src-tauri/tauri.conf.json'))).version, VERSION);
  assert.equal(fs.existsSync(out), false, 'Immutable output already exists'); fs.mkdirSync(out);
  const { target, artifact } = buildPaths(root, out); fs.mkdirSync(artifact);
  const resources = {};
  for (const name of inventory(path.join(payload, 'modules'))) resources[path.join(payload, 'modules', name)] = `modules/${name}`;
  const overlay = path.join(out, 'tauri-ci.json'); write(overlay, { bundle: { resources } });
  const buildEnv = { ...require('./build-unified.cjs').integrationEnvironment(cleanEnvironment(env), payload, true),
    CREATOR_BUILTIN_MANIFEST: path.join(payload, 'builtin-manifest.json'), CREATOR_MCP_HOST_WRITABLE: '1',
    CREATOR_MCP_HOST_READONLY_EVENTS: '1', CARGO_TARGET_DIR: target };
  const run = (command, args, timeout = 1800000) => execFileSync(command, args,
    { cwd: root, env: buildEnv, windowsHide: true, timeout, stdio: 'inherit' });
  run('cargo', ['build', '--release', '--locked', '--manifest-path', 'src-tauri/Cargo.toml',
    '--example', 'verify-package-input', '--example', 'verify-managed-runtime']);
  for (const name of ['router', 'runtime']) run(path.join(target, 'release/examples/verify-package-input.exe'),
    [path.join(payload, `modules/routing/${name}.json`), path.join(payload, `modules/routing/${name}.minisig`)], 30000);
  run(path.join(target, 'release/examples/verify-managed-runtime.exe'), [payload, VERSION], 30000);
  assertSource(root, env.SOURCE_COMMIT, env.SOURCE_MANIFEST_SHA256);
  run(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--features',
    'integrated-features', '--bundles', 'nsis', '--config', overlay, '--', '--locked']);
  const copy = (from, name) => fs.copyFileSync(from, path.join(artifact, name), fs.constants.COPYFILE_EXCL);
  copy(path.join(target, 'release/creator-hub.exe'), 'raw-creator-hub.exe');
  const productVersion = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '[Diagnostics.FileVersionInfo]::GetVersionInfo($env.CREATOR_CANDIDATE_IMAGE).ProductVersion'],
  { env: { ...cleanEnvironment(env), CREATOR_CANDIDATE_IMAGE: path.join(artifact, 'raw-creator-hub.exe') },
    encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim();
  assert.equal(productVersion, VERSION, 'Compiled image version differs');
  copy(path.join(target, `release/bundle/nsis/Creator Hub_${VERSION}_x64-setup.exe`), ASSET);
  const extracted = require('./installer-payload.cjs').extract(path.join(artifact, ASSET), path.join(out, 'extracted'),
    path.join(artifact, 'raw-creator-hub.exe'), manifest);
  copy(extracted, 'creator-hub.exe'); copy(path.join(payload, 'builtin-manifest.json'), 'builtin-manifest.json');
  write(path.join(artifact, 'source-manifest.json'), source);
  assertSource(root, env.SOURCE_COMMIT, env.SOURCE_MANIFEST_SHA256); verifyPayload(root, payload, binding, source);
  const receipt = { schemaVersion: 1, kind: 'ci-windows-direct16-candidate', version: VERSION,
    source: { commit: env.SOURCE_COMMIT, manifestSha256: env.SOURCE_MANIFEST_SHA256 },
    producer: { commit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: Number(env.GITHUB_RUN_ATTEMPT) },
    payload: binding, files: Object.fromEntries(CANDIDATE_FILES.map(name => [name, record(path.join(artifact, name))])),
    managedSignaturesVerified: true, localCandidateEquivalent: false, installed: false, signedUpdateAccepted: false, releaseReady: false };
  write(path.join(artifact, 'candidate.json'), receipt);
  verifyCandidate(artifact, hash(read(path.join(artifact, 'candidate.json'))), receipt.source,
    { producerCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: Number(env.GITHUB_RUN_ATTEMPT) });
  console.log(JSON.stringify({ artifact, candidateReceiptSha256: hash(read(path.join(artifact, 'candidate.json'))), source: receipt.source,
    installer: receipt.files[ASSET], executable: receipt.files['creator-hub.exe'], releaseReady: false }));
}
function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'snapshot') {
    assert.equal(args.length, 1); const source = snapshot(path.resolve(args[0]));
    console.log(JSON.stringify({ manifestSha256: hash(jsonBytes(source)), payloadSourceSha256: payloadSourceHash(source), files: source.files.length })); return;
  }
  assertRunner();
  const input = identity(JSON.parse(process.env.INPUT_IDENTITY || '{}'));
  if (mode === 'bind') {
    assert.equal(args.length, 2);
    const api = endpoint => JSON.parse(execFileSync('gh', ['api', '--method', 'GET', `repos/${REPO}/${endpoint}`],
      { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: META }));
    const bound = bindArtifact(input, api(`actions/artifacts/${input.artifactId}`), api(`actions/runs/${input.runId}`), args[0]);
    write(path.resolve(args[1]), bound);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `artifact_id=${input.artifactId}\nrun_id=${input.runId}\n`); return;
  }
  assert.equal(mode, 'produce'); assert.equal(args.length, 4);
  produce(...args.slice(0, 3).map(value => path.resolve(value)), json(args[3]));
}
module.exports = { REPO, REF, WORKFLOW, VERSION, ASSET, CANDIDATE_FILES, SOURCE_PATHS, hash, jsonBytes, read, json, write,
  assertRunner, cleanEnvironment, sourcePath, snapshot, validateSnapshot, payloadSourcePath, payloadSourceHash, buildPaths, assertSource, identity,
  boundIdentity, bindArtifact, inventory, verifyPayload, record, verifyCandidate, produce };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
