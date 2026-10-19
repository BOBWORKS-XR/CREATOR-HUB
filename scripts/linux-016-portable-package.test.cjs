// Synthetic admission/transport fixtures only; no artifact or native GUI acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { yaml } = require('playwright-core/lib/utilsBundle');
const p = require('./linux-016-portable-package.cjs');
const finite = require('./flatpak-package.cjs');
const modules = require('./module-archive.cjs');
const unix = require('./unix-package-payload.cjs');
const original = require('./unix-payload-binding.cjs');
const { fixture: originalFixture } = require('./fixtures/unix-payload-binding.cjs');
const { runtimeDescriptor } = require('./mcp-runtime-descriptor.cjs');
const ROOT = path.resolve(__dirname, '..');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const BASH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2));
function runnerEnv() {
  return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: original.REPOSITORY, GITHUB_REPOSITORY_ID: String(original.REPOSITORY_ID),
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: p.BRANCH, GITHUB_WORKFLOW_REF: `${original.REPOSITORY}/${p.WORKFLOW}@${p.BRANCH}`,
    GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1' };
}
function temp(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub016-package-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function put(root, name, bytes, mode = 0o644) {
  const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes, { flag: 'wx', mode }); fs.chmodSync(file, mode); return file;
}
function elf() {
  const bytes = Buffer.alloc(64); bytes.set([127, 69, 76, 70, 2, 1, 1]); bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(62, 18); return bytes;
}
function identity() {
  const pins = { schemaVersion: 1, sourceCommit: 'd'.repeat(40), sourceTree: 'e'.repeat(40), runId: 9001, runAttempt: 2,
    jobId: 9002, workflowId: 9003, artifactId: 9004, artifact: { size: 1234, sha256: 'f'.repeat(64) },
    receiptsArtifactId: 9005, receiptsArtifact: { size: 4321, sha256: 'a'.repeat(64) }, handoffSha256: 'b'.repeat(64), files: {} };
  const repo = { id: original.REPOSITORY_ID, full_name: original.REPOSITORY };
  const proof = { run: { id: pins.runId, run_attempt: 2, status: 'completed', conclusion: 'success', event: 'workflow_dispatch',
    head_sha: pins.sourceCommit, head_branch: 'validation/linux-integrated-candidate-016',
    path: '.github/workflows/unix-managed-assembly.yml', workflow_id: pins.workflowId, repository: repo, head_repository: repo },
  job: { id: pins.jobId, run_id: pins.runId, run_attempt: 2, head_sha: pins.sourceCommit, status: 'completed', conclusion: 'success',
    name: 'assembly (linux, ubuntu-22.04, synthetic...)', labels: ['ubuntu-22.04'], started_at: '2026-10-19T10:00:00Z', completed_at: '2026-10-19T10:10:00Z' },
  workflow: { id: pins.workflowId, path: '.github/workflows/unix-managed-assembly.yml' },
  commit: { sha: pins.sourceCommit, tree: { sha: pins.sourceTree } } };
  for (const [field, id, name, pin] of [
    ['artifact', pins.artifactId, 'signed-unix-hub-linux-9001-2', pins.artifact],
    ['receiptsArtifact', pins.receiptsArtifactId, 'signed-linux-receipts-9001-2', pins.receiptsArtifact],
  ]) proof[field] = { id, name, expired: false, size_in_bytes: pin.size, digest: `sha256:${pin.sha256}`,
    created_at: '2026-10-19T10:09:00Z', workflow_run: { id: pins.runId, head_sha: pins.sourceCommit,
      head_branch: proof.run.head_branch, repository_id: repo.id, head_repository_id: repo.id } };
  for (const n of [...p.INPUTS, 'linux-byte-receipts.json', 'direct-features-candidate.json']) pins.files[n] = { size: 100, sha256: 'a'.repeat(64) };
  return { pins, proof };
}
function privateProof() {
  const f = originalFixture(); f.expected.version = f.prepared.hubVersion = p.VERSION;
  f.artifactSize = f.artifact.size_in_bytes; f.jobId = 303; f.jobs[0].id = f.jobId; f.jobs[0].head_sha = f.expected.sourceCommit; f.job = structuredClone(f.jobs[0]);
  f.run.head_branch = 'validation/unix-payload-016'; return f;
}
function candidate(t) {
  const binding = { ...identity(), privateProof: privateProof() }, { pins } = binding;
  const m = { schemaVersion: 1, platform: 'linux', arch: 'x86_64', modules: {
    mcp: { version: '2.7.7', executable: finite.MEMBERS[0], files: {} },
    setup: { version: '0.3.7', executable: finite.MEMBERS[9], files: {} } }, managedRouting: { protocol: 1, files: {} } };
  const raw = Object.fromEntries([...finite.MEMBERS, ...finite.ROUTING].map(n => [n, Buffer.from(`synthetic ${n}`)]));
  for (const [n, bytes] of Object.entries(raw)) {
    const files = n.startsWith('routing/') ? m.managedRouting.files : m.modules[n.startsWith('mcp/') ? 'mcp' : 'setup'].files;
    files[n] = p.record(bytes).sha256;
    const preparedName = n === 'routing/creator-hub-mcp-router' ? 'router-for-package' : `modules/${n}`;
    if (!n.startsWith('routing/') || n === 'routing/creator-hub-mcp-router') binding.privateProof.prepared.files[preparedName] = {
      ...p.record(bytes), mode: modules.modeFor(m, n) };
  }
  const payload = Buffer.from('Synthetic opaque archive; native verification is separately tested by the shared decoder');
  m.payloadArchive = { schemaVersion: 1, file: 'modules.tar.gz', ...p.record(payload),
    unpackedSize: Object.values(raw).reduce((sum, b) => sum + b.length, 0),
    files: Object.fromEntries(Object.entries(raw).map(([n, bytes]) => [n, { size: bytes.length, mode: modules.modeFor(m, n) }])) };
  binding.privateProof.prepared.files['mcp-runtime.json'] = { ...p.record(Buffer.from(JSON.stringify(runtimeDescriptor(m, p.VERSION)))), mode: 0o644 };
  const descriptor = jsonBytes(m), hub = Buffer.concat([elf(), descriptor,
    Buffer.from(require('./build-unified.cjs').PORTABLE_ROOT_WITNESSES.join('\n')), Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK')]);
  const debHub = Buffer.from(hub); debHub.write('DEB', hub.length - 3, 'ascii');
  const assembly = { schemaVersion: 1, product: 'com.creatorworks.hub.unix-signed-assembly', platform: 'linux', arch: 'x86_64',
    hubVersion: p.VERSION, assemblyCommit: pins.sourceCommit, privateSource: binding.privateProof.prepared.source,
    handoffSha256: pins.handoffSha256, mcpMode: 'writable', compiledFeatures: p.FEATURES,
    portableHostBuild: { schemaVersion: 1, version: p.VERSION, target: p.TARGET, sourceCommit: pins.sourceCommit,
      sourceTree: pins.sourceTree, compiledFeatures: p.FEATURES, startupImageBinding: 1, rawHub: p.record(hub) },
    privateModulesRecompiled: false, privateModulesResigned: false, nativeGuiAccepted: false, releaseReady: false };
  const integrity = { schemaVersion: 1, platform: 'linux', arch: 'x86_64', integrityPassed: true, experimental: true,
    mcpMode: 'writable', writableGuiAccepted: false, releaseReady: false, packages: [{ format: 'deb',
      path: 'native-packages/Creator Hub_0.1.16_amd64.deb', sha256: 'a'.repeat(64), hubSha256: p.record(debHub).sha256, files: modules.rawFiles(m) }] };
  const direct = { schemaVersion: 1, scope: 'linux-direct-features-candidate', activationRunsOutsideSandbox: true,
    nativeGuiAccepted: false, migrationAccepted: false, signedUpdateAccepted: false, flatpakActivationAccepted: false, releaseReady: false };
  const bytes = { 'creator-hub': hub, 'modules.tar.gz': payload, 'builtin-manifest.json': descriptor,
    'signed-unix-assembly.json': jsonBytes(assembly), 'unix-package-integrity.json': jsonBytes(integrity),
    'direct-features-candidate.json': jsonBytes(direct) };
  function refresh() {
    for (const n of Object.keys(bytes)) if (n !== 'linux-byte-receipts.json') pins.files[n] = p.record(bytes[n]);
    bytes['linux-byte-receipts.json'] = jsonBytes({ schemaVersion: 1, sourceCommit: pins.sourceCommit,
      runId: pins.runId, runAttempt: pins.runAttempt, files: Object.fromEntries(p.INPUTS.map(n => [n, { bytes: pins.files[n].size, sha256: pins.files[n].sha256 }])),
      nativeGuiAccepted: false, migrationAccepted: false, signedUpdateAccepted: false, releaseReady: false });
    pins.files['linux-byte-receipts.json'] = p.record(bytes['linux-byte-receipts.json']);
  }
  refresh(); const root = temp(t), input = path.join(root, 'input'), receipts = path.join(root, 'receipts');
  fs.mkdirSync(input); fs.mkdirSync(receipts);
  const save = () => {
    refresh(); for (const n of p.INPUTS) fs.writeFileSync(path.join(input, n), bytes[n]);
    for (const n of p.RECEIPTS) fs.writeFileSync(path.join(receipts, n), bytes[n]);
  };
  save(); return { binding, input, receipts, bytes, save };
}

test('independent assembly pins have no run/source/artifact defaults and all are required', () => {
  const { pins } = identity(); p.validatePins(pins);
  for (const n of Object.keys(pins)) { const bad = structuredClone(pins); delete bad[n]; assert.throws(() => p.validatePins(bad)); }
  for (const n of Object.keys(pins.files)) { const bad = structuredClone(pins); delete bad.files[n]; assert.throws(() => p.validatePins(bad)); }
  for (const value of [0, -1, 1.5, '123', Number.MAX_SAFE_INTEGER + 1]) {
    const bad = structuredClone(pins); bad.jobId = value; assert.throws(() => p.validatePins(bad));
  }
});
test('exact successful source/run/workflow/job and both artifact APIs must all agree', () => {
  const { pins, proof } = identity(); p.verifyProducer(pins, proof);
  for (const [section, field, value] of [
    ['run', 'id', 77], ['run', 'run_attempt', 1], ['run', 'status', 'in_progress'], ['run', 'conclusion', 'failure'],
    ['run', 'head_sha', '1'.repeat(40)], ['run', 'head_branch', 'validation/linux-integrated-candidate-014'],
    ['run', 'path', '.github/workflows/ci.yml'], ['run', 'event', 'pull_request'], ['run', 'workflow_id', 99],
    ['workflow', 'id', 99], ['workflow', 'path', '.github/workflows/ci.yml'],
    ['job', 'id', 99], ['job', 'run_attempt', 1], ['job', 'conclusion', 'failure'], ['job', 'head_sha', '1'.repeat(40)],
    ['job', 'name', 'assembly (macos-arm64, macos-latest)'], ['job', 'labels', ['self-hosted']],
  ]) { const bad = structuredClone(proof); bad[section][field] = value; assert.throws(() => p.verifyProducer(pins, bad), `${section}.${field}`); }
  for (const section of ['artifact', 'receiptsArtifact']) for (const [field, value] of [
    ['id', 1], ['name', 'signed-unix-hub-linux-9001-1'], ['size_in_bytes', 1], ['digest', `sha256:${'1'.repeat(64)}`],
    ['expired', true], ['created_at', '2026-10-19T10:20:00Z'],
  ]) { const bad = structuredClone(proof); bad[section][field] = value; assert.throws(() => p.verifyProducer(pins, bad)); }
  for (const change of [b => b.run.repository.id++, b => b.run.head_repository.full_name = 'foreign/repo',
    b => b.commit.tree.sha = '1'.repeat(40), b => b.artifact.workflow_run.id++, b => b.receiptsArtifact.workflow_run.head_repository_id++]) {
    const bad = structuredClone(proof); change(bad); assert.throws(() => p.verifyProducer(pins, bad));
  }
});
test('original payload binding is the shared verifier with fresh original artifact/job API reads', () => {
  const { pins, proof } = identity(), f = privateProof(), seen = [];
  const map = new Map([
    [`actions/runs/${pins.runId}`, proof.run], [`actions/jobs/${pins.jobId}`, proof.job],
    [`actions/workflows/${pins.workflowId}`, proof.workflow], [`git/commits/${pins.sourceCommit}`, proof.commit],
    [`actions/artifacts/${pins.artifactId}`, proof.artifact], [`actions/artifacts/${pins.receiptsArtifactId}`, proof.receiptsArtifact],
    [`actions/runs/${f.expected.runId}`, f.run], [`actions/artifacts/${f.expected.artifactId}`, f.artifact],
    [`git/commits/${f.expected.sourceCommit}`, f.commit],
    [`actions/jobs/${f.jobId}`, f.job],
    [`actions/runs/${f.expected.runId}/attempts/${f.expected.runAttempt}/jobs?per_page=100`, { total_count: 1, jobs: f.jobs }],
  ]);
  const request = route => { seen.push(route); assert.ok(map.has(route), route); return map.get(route); };
  const input = { expected: f.expected, prepared: f.prepared, artifactSize: f.artifactSize, jobId: f.jobId };
  const result = p.collect(pins, input, request);
  assert.equal(seen.length, 11); assert.deepEqual(result.privateProof.expected, f.expected);
  f.artifact.digest = `sha256:${'1'.repeat(64)}`;
  assert.throws(() => p.collect(pins, input, request));
});
test('admission permits only this manual headless Linux hosted workflow and excludes signing/injection', () => {
  const env = runnerEnv();
  p.admission(env, 'linux', 'x64');
  for (const n of ['TAURI_SIGNING_PRIVATE_KEY', 'CREATOR_HUB_SIGNING_KEY_PATH', 'LD_LIBRARY_PATH', 'NODE_OPTIONS',
    'PYTHONOPTIMIZE', 'HTTPS_PROXY', 'APPIMAGE', 'FLATPAK_ID', 'DISPLAY']) assert.throws(() => p.admission({ ...env, [n]: 'foreign' }, 'linux', 'x64'));
  assert.throws(() => p.admission(env, 'win32', 'x64')); assert.throws(() => p.admission(env, 'linux', 'arm64'));
  assert.throws(() => p.admission({ ...env, GITHUB_EVENT_NAME: 'push' }, 'linux', 'x64'));
});
test('preflight imports only native Node modules and validates before dependencies or subprocesses exist', () => {
  const { pins } = identity(), proof = privateProof();
  const input = { expected: proof.expected, prepared: proof.prepared, artifactSize: proof.artifactSize, jobId: proof.jobId };
  const env = { ...runnerEnv(), ASSEMBLY_PINS: JSON.stringify(pins), PRIVATE_INPUT: JSON.stringify(input) };
  const script = String.raw`
    const Module=require('node:module'),fs=require('node:fs'),cp=require('node:child_process');
    const load=Module._load,file=process.argv[1],seen=[];
    Module._load=function(request,...rest){
      if(request!==file&&!request.startsWith('node:')) throw Error('Preflight imported dependency: '+request);
      seen.push(request); return load.call(this,request,...rest);
    };
    for(const name of ['execFileSync','spawnSync','execSync']) cp[name]=()=>{throw Error('Preflight spawned a process');};
    const sidecar=require(file),env=JSON.parse(fs.readFileSync(0,'utf8'));
    sidecar.preflight(env,'linux','x64');
    process.stdout.write(JSON.stringify(seen));
  `;
  const loaded = JSON.parse(execFileSync(process.execPath, ['-e', script, path.join(__dirname, 'linux-016-portable-package.cjs')], { input: JSON.stringify(env), encoding: 'utf8' }));
  assert.ok(loaded.every(n => n.startsWith('node:') || n.endsWith('linux-016-portable-package.cjs')));
  assert.deepEqual(p.preflight(env, 'linux', 'x64').pins, pins);
  for (const mutate of [
    e => e.ASSEMBLY_PINS = 'not json', e => e.PRIVATE_INPUT = '[]', e => e.ASSEMBLY_PINS += ' '.repeat(60001),
    e => e.GITHUB_EVENT_NAME = 'push', e => e.GITHUB_REPOSITORY_ID = '1',
    e => e.ASSEMBLY_PINS = JSON.stringify({ ...pins, unexpected: true }),
    e => e.PRIVATE_INPUT = JSON.stringify({ ...input, expected: { ...input.expected, version: '0.1.14' } }),
    e => e.PRIVATE_INPUT = JSON.stringify({ ...input, prepared: { ...input.prepared, platform: 'macos' } }),
    e => e.PRIVATE_INPUT = JSON.stringify({ ...input, prepared: { ...input.prepared, source: { ...input.prepared.source, sourceTree: 'unknown' } } }),
    e => e.PRIVATE_INPUT = JSON.stringify({ ...input, prepared: { ...input.prepared, releaseReady: true } }),
  ]) { const bad = structuredClone(env); mutate(bad); assert.throws(() => p.preflight(bad, 'linux', 'x64')); }
});
test('synthetic successful16 receipts bind Root, opaque archive, original private files and DEB identity', t => {
  const f = candidate(t); assert.equal(p.validateReceipts(f.input, f.receipts, f.binding).manifest.platform, 'linux');
});
test('historical hardcoded14 receipt and missing feature attestation are explicit refusals, never relabelled', t => {
  const f = candidate(t), saved = f.bytes['signed-unix-assembly.json'];
  const a = JSON.parse(saved); a.hubVersion = '0.1.14'; f.bytes['signed-unix-assembly.json'] = jsonBytes(a); f.save();
  assert.throws(() => p.validateReceipts(f.input, f.receipts, f.binding), /truthfully identify/);
  a.hubVersion = p.VERSION; delete a.compiledFeatures; f.bytes['signed-unix-assembly.json'] = jsonBytes(a); f.save();
  assert.throws(() => p.validateReceipts(f.input, f.receipts, f.binding), /exact compiledFeatures/);
  a.compiledFeatures = ['integrated-features']; f.bytes['signed-unix-assembly.json'] = jsonBytes(a); f.save();
  assert.throws(() => p.validateReceipts(f.input, f.receipts, f.binding), /exact compiledFeatures/);
});
test('portable assembly requires byte-bound startup proof, not merely the older integrated feature list', t => {
  const f = candidate(t), original = JSON.parse(f.bytes['signed-unix-assembly.json']);
  for (const change of [
    a => delete a.portableHostBuild,
    a => a.compiledFeatures = p.FEATURES.slice(0, -1),
    a => a.portableHostBuild.rawHub.sha256 = 'f'.repeat(64),
    a => a.portableHostBuild.sourceTree = 'f'.repeat(40),
    a => a.portableHostBuild.startupImageBinding = 0,
  ]) {
    const a = structuredClone(original); change(a);
    f.bytes['signed-unix-assembly.json'] = jsonBytes(a); f.save();
    assert.throws(() => p.validateReceipts(f.input, f.receipts, f.binding));
  }
  f.bytes['creator-hub'] = Buffer.concat([elf(), f.bytes['builtin-manifest.json'], Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK')]);
  const relabelled = structuredClone(original); relabelled.portableHostBuild.rawHub = p.record(f.bytes['creator-hub']);
  f.bytes['signed-unix-assembly.json'] = jsonBytes(relabelled); f.save();
  assert.throws(() => p.validateReceipts(f.input, f.receipts, f.binding), /Old Root without portable startup binding/);
});
test('portable host profile binds only the actual APP image and exact complete inventory', t => {
  const f = candidate(t), raw = f.bytes['creator-hub'], proof = JSON.parse(f.bytes['signed-unix-assembly.json']).portableHostBuild;
  const packaged = Buffer.from(raw); packaged.write('APP', packaged.length - 3, 'ascii');
  const profile = p.hostProfile(raw, packaged, proof, f.binding.pins), parsed = JSON.parse(profile);
  assert.equal(parsed.executableSha256, p.record(packaged).sha256);
  assert.notEqual(parsed.executableSha256, proof.rawHub.sha256);
  const runner = elf();
  const inv = { entries: { usr: { kind: 'directory', mode: 0o755 }, 'usr/bin': { kind: 'directory', mode: 0o755 },
    'usr/bin/creator-hub': { kind: 'file', ...p.record(packaged), mode: 0o755 },
    AppRun: { kind: 'file', ...p.record(runner), mode: 0o755 },
    [p.HOST_PROFILE]: { kind: 'file', ...p.record(profile), mode: 0o644 } }, links: {},
  unpackedSize: packaged.length + runner.length + profile.length };
  assert.deepEqual(p.verifyHostProfileInventory(inv, profile, p.record(packaged)), parsed);
  for (const change of [b => delete b.entries[p.HOST_PROFILE], b => b.entries[p.HOST_PROFILE].sha256 = 'f'.repeat(64),
    b => b.entries[p.HOST_PROFILE].mode = 0o755, b => b.entries.AppRun.mode = 0o644,
    b => b.entries['usr/bin/creator-hub'].sha256 = proof.rawHub.sha256]) {
    const b = structuredClone(inv); change(b);
    assert.throws(() => p.verifyHostProfileInventory(b, profile, p.record(packaged)));
  }
  const changed = Buffer.from(packaged); changed[24] ^= 1;
  assert.throws(() => p.hostProfile(raw, changed, proof, f.binding.pins));
  assert.throws(() => p.hostProfile(raw, packaged, { ...proof, compiledFeatures: p.FEATURES.slice(0, -1) }, f.binding.pins));
  const consumer = fs.readFileSync(path.join(ROOT, 'native/linux-portable-deployment/src/host.rs'), 'utf8');
  assert.ok(consumer.includes(`HOST_PROFILE: &str = "${p.HOST_PROFILE}"`));
  for (const field of ['schemaVersion', 'version', 'activationInterface', 'integratedFeatures', 'startupImageBinding', 'executableSha256']) assert.ok(Object.hasOwn(parsed, field));
});
test('canonical AppDir profile is added once before inventory and TAR hashing without replacing existing files', async t => {
  if (process.platform === 'win32') return t.skip('Actual Unix modes belong to the Linux workflow');
  const f = candidate(t), raw = f.bytes['creator-hub'], packaged = Buffer.from(raw); packaged.write('APP', packaged.length - 3, 'ascii');
  const profile = p.hostProfile(raw, packaged, JSON.parse(f.bytes['signed-unix-assembly.json']).portableHostBuild, f.binding.pins);
  const root = temp(t), appdir = path.join(root, 'AppDir'); fs.mkdirSync(appdir);
  put(appdir, 'usr/bin/creator-hub', packaged, 0o755); put(appdir, 'AppRun', elf(), 0o755); put(appdir, 'usr/data', 'preserve');
  const before = p.inventory(appdir), after = p.attachHostProfile(appdir, before, profile, p.record(packaged));
  assert.equal(after.unpackedSize, before.unpackedSize + profile.length);
  assert.deepEqual(fs.readFileSync(path.join(appdir, p.HOST_PROFILE)), profile);
  assert.throws(() => p.attachHostProfile(appdir, after, Buffer.from('replacement'), p.record(packaged)), /cannot be replaced/);
  const file = path.join(root, 'profiled.tar.gz'), binding = await p.packTar(appdir, file, after);
  const manifest = p.manifest(f.binding.pins, after, binding);
  assert.deepEqual(manifest.entries[p.HOST_PROFILE], { kind: 'file', ...p.record(profile), mode: 0o644 });
  execFileSync(PYTHON, ['-B', '-c', VERIFY_TAR, file], { input: JSON.stringify(manifest) });
  assert.equal(fs.readFileSync(path.join(appdir, 'usr/data'), 'utf8'), 'preserve');
});
test('receipt tampering, original private artifact drift and byte-pin changes fail closed', t => {
  const f = candidate(t);
  for (const change of [
    b => b.privateProof.prepared.files['modules/mcp/server/runtime/node'].sha256 = '1'.repeat(64),
    b => b.privateProof.run.conclusion = 'failure', b => b.proof.artifact.size_in_bytes++, b => b.pins.files['creator-hub'].sha256 = '1'.repeat(64),
  ]) { const b = structuredClone(f.binding); change(b); assert.throws(() => p.validateReceipts(f.input, f.receipts, b)); }
  const a = JSON.parse(f.bytes['signed-unix-assembly.json']); a.privateModulesResigned = true;
  f.bytes['signed-unix-assembly.json'] = jsonBytes(a); f.save(); assert.throws(() => p.validateReceipts(f.input, f.receipts, f.binding));
});

const MAKE_ZIP = String.raw`
import base64,json,stat,sys,zipfile
with zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED) as z:
    for e in json.load(sys.stdin):
        info=zipfile.ZipInfo(e['name']); info.create_system=3; info.external_attr=e.get('mode',stat.S_IFREG|0o644)<<16
        z.writestr(info,base64.b64decode(e['bytes']))
`;
function zip(t, entries) {
  const root = temp(t), file = path.join(root, 'input.zip');
  execFileSync(PYTHON, ['-B', '-c', MAKE_ZIP, file], { input: JSON.stringify(entries.map(e => ({ ...e, bytes: Buffer.from(e.bytes || '').toString('base64') }))) });
  return { root, file };
}
const pythonRun = (_, args, options) => execFileSync(PYTHON, args, { encoding: 'utf8', ...options, stdio: ['pipe', 'pipe', 'pipe'] });
test('bounded ZIP stages only fixed pinned names; ignored original bytes are not extracted', t => {
  const z = zip(t, [{ name: 'creator-hub', bytes: 'root' }, { name: 'modules/mcp/server/LICENSE', bytes: 'ignored' }]);
  const output = path.join(z.root, 'stage'); p.stageZip(z.file, output, { 'creator-hub': p.record(Buffer.from('root')) }, p.MAIN_ALLOWED, pythonRun);
  assert.deepEqual(fs.readdirSync(output), ['creator-hub']); assert.equal(fs.readFileSync(path.join(output, 'creator-hub'), 'utf8'), 'root');
});
for (const [label, entry] of [
  ['traversal', { name: '../creator-hub' }], ['absolute', { name: '/creator-hub' }], ['backslash', { name: 'modules\\evil' }],
  ['extra', { name: 'new-secret-file' }], ['foreign platform', { name: 'native-packages/Creator Hub_0.1.16_arm64.deb' }],
  ['link', { name: 'modules/mcp/server/LICENSE', mode: 0o120777 }], ['privileged mode', { name: 'modules/mcp/server/LICENSE', mode: 0o104755 }],
  ['duplicate', { name: 'creator-hub' }], ['case alias', { name: 'CREATOR-HUB' }],
]) test(`ZIP rejects ${label} without extracting a payload`, t => {
  const z = zip(t, [{ name: 'creator-hub', bytes: 'root' }, { ...entry, bytes: 'bad' }]);
  const output = path.join(z.root, 'stage');
  assert.throws(() => p.stageZip(z.file, output, { 'creator-hub': p.record(Buffer.from('root')) }, p.MAIN_ALLOWED, pythonRun));
  assert.equal(fs.existsSync(output), false);
});
test('ZIP does not learn pins from its own headers or contents', t => {
  const z = zip(t, [{ name: 'creator-hub', bytes: 'bad' }]);
  assert.throws(() => p.stageZip(z.file, path.join(z.root, 'stage'), { 'creator-hub': p.record(Buffer.from('root')) }, p.MAIN_ALLOWED, pythonRun));
});
test('original-carrier preparation is fixed-path, canonical and equal to the independently supplied metadata', t => {
  const prepared = privateProof().prepared;
  const check = (bytes, expected = prepared) => {
    const z = zip(t, [{ name: 'prepared-unix.json', bytes }, { name: 'modules.tar.gz', bytes: 'not extracted' },
      { name: 'transfer-binding.json', bytes: 'not extracted' }]);
    const output = path.join(z.root, 'metadata');
    pythonRun('python3', ['-B', '-c', p.ZIP_STAGE, z.file, output], { input: JSON.stringify({ pins: {},
      metadata: { 'prepared-unix.json': expected }, allowed: ['prepared-unix.json', 'modules.tar.gz', 'transfer-binding.json'] }) });
    assert.deepEqual(fs.readdirSync(output), ['prepared-unix.json']);
  };
  check(jsonBytes(prepared));
  const wrong = structuredClone(prepared); wrong.source.sourceCommit = '9'.repeat(40);
  assert.throws(() => check(jsonBytes(prepared), wrong));
  assert.throws(() => check(JSON.stringify(prepared)));
});
test('the original artifact size and specific original native job are independently pinned too', () => {
  const proof = privateProof(); p.verifyPrivateProof(proof);
  for (const change of [b => b.artifactSize++, b => b.jobId++, b => b.job.run_attempt++,
    b => b.job.head_sha = '9'.repeat(40), b => delete b.jobId, b => delete b.artifactSize]) {
    const bad = structuredClone(proof); change(bad); assert.throws(() => p.verifyPrivateProof(bad));
  }
});

test('Planck path spelling and exact provisional bounds match the read-only consumer contract', () => {
  assert.deepEqual(p.LIMITS, { manifest: 2097152, archive: 268435456, file: 268435456, total: 536870912, entries: 8192, zip: 805306368 });
  for (const n of ['usr/bin/creator-hub', '.DirIcon', 'usr/lib/Creator Hub/modules.tar.gz', 'x'.repeat(100)]) assert.ok(p.relative(n));
  for (const n of ['', '/', '../evil', 'a//b', 'a/./b', 'a\\b', 'a:b', 'a\nb', 'a/CON.txt', 'nul', 'COM0.txt', 'LPT9',
    'a.', 'a ', 'a'.repeat(101), Array(33).fill('a').join('/'), 'a'.repeat(100) + '/' + 'b'.repeat(100) + '/' + 'c'.repeat(39), 'caf\u00e9']) assert.equal(p.relative(n), false, n);
  const consumer = fs.readFileSync(path.join(ROOT, 'native/linux-portable-deployment/src/lib.rs'), 'utf8');
  for (const [n, expression] of [['MAX_MANIFEST', '2 * 1024 * 1024'], ['MAX_ARCHIVE', '256 * 1024 * 1024'],
    ['MAX_TOTAL', '512 * 1024 * 1024'], ['MAX_ENTRIES', '8192']]) assert.ok(consumer.includes(`${n}:`) && consumer.includes(`= ${expression};`));
});
test('inventory rejects extras with special meaning, case aliases and hardlinks', t => {
  if (process.platform === 'win32') return t.skip('Actual Unix inventory modes and case-sensitive directory entries required');
  const root = temp(t), tree = path.join(root, 'AppDir'); fs.mkdirSync(tree);
  put(tree, 'a', 'a'); put(tree, 'A', 'a');
  assert.throws(() => p.inventory(tree), /Noncanonical/);
  fs.rmSync(path.join(tree, 'A'));
  fs.linkSync(path.join(tree, 'a'), path.join(tree, 'b')); assert.throws(() => p.inventory(tree), /single-link/);
  for (const n of ['usr/lib/Creator Hub/modules/x', 'usr/share/polkit-1/actions/x', 'usr/share/dbus-1/services/x',
    'usr/bin/creator-hub-deb-retirement-helper', 'usr/share/x.policy']) assert.ok(p.prohibited(n));
});
const TYPELIB = Buffer.from('GOBJ\nMETADATA\r\n\x1a', 'binary');
const POLKIT_TYPELIBS = ['usr/lib/girepository-1.0/Polkit-1.0.typelib', 'usr/lib/girepository-1.0/PolkitAgent-1.0.typelib'];
test('39331187141 typelib refusal distinguishes exact GTK metadata paths from privilege-bearing entries', () => {
  for (const name of POLKIT_TYPELIBS) assert.equal(p.prohibited(name), false, name);
  for (const name of ['usr/share/polkit-1', 'usr/share/polkit-1/actions/Polkit-1.0.typelib',
    'usr/share/dbus-1/services/x', 'usr/lib/systemd/x', 'usr/bin/pkexec', 'usr/libexec/polkit-agent-helper-1',
    'usr/bin/creator-hub-deb-retirement-helper', 'usr/share/x.policy', 'usr/lib/girepository-1.0/Polkit-1.0.typelib.policy',
    'usr/lib/girepository-1.0/polkit-1.0.typelib', 'usr/lib/girepository-1.0/PolkitUnknown-1.0.typelib',
    'usr/bin/Polkit-1.0.typelib', 'usr/lib/libpolkit-unreviewed.so.0']) assert.equal(p.prohibited(name), true, name);
});
test('typelib exception requires regular non-executable data, exact mode and GObject metadata magic', () => {
  const good = { kind: 'file', ...p.record(TYPELIB), mode: 0o644 };
  for (const name of POLKIT_TYPELIBS) p.validateGtkMetadata(name, good, TYPELIB);
  for (const changed of [{ ...good, kind: 'directory' }, { ...good, kind: 'symlink' }, { ...good, mode: 0o755 },
    { ...good, mode: 0o664 }, { ...good, mode: 0o4644 }, { ...good, size: 0 }])
    assert.throws(() => p.validateGtkMetadata(POLKIT_TYPELIBS[0], changed, TYPELIB));
  assert.throws(() => p.validateGtkMetadata(POLKIT_TYPELIBS[0], { ...good, ...p.record(elf()) }, elf()), /typelib/);
  assert.throws(() => p.validateGtkMetadata(POLKIT_TYPELIBS[0], good, Buffer.alloc(TYPELIB.length)), /typelib/);
  const entry = { usr: { kind: 'directory', mode: 0o755 }, 'usr/lib': { kind: 'directory', mode: 0o755 },
    'usr/lib/girepository-1.0': { kind: 'directory', mode: 0o755 }, [POLKIT_TYPELIBS[0]]: good };
  p.validateInventory({ entries: entry, links: {}, unpackedSize: TYPELIB.length });
  for (const mode of [0o755, 0o664, 0o4644]) {
    const changed = structuredClone(entry); changed[POLKIT_TYPELIBS[0]].mode = mode;
    assert.throws(() => p.validateInventory({ entries: changed, links: {}, unpackedSize: TYPELIB.length }));
  }
});
test('actual Unix inventory checks typelib bytes and rejects links or executables under the allowed metadata name', t => {
  if (process.platform === 'win32') return t.skip('Actual Unix mode/link checks run in the native Linux packaging preflight');
  const root = temp(t), file = put(root, POLKIT_TYPELIBS[0], TYPELIB);
  assert.equal(p.inventory(root, true).entries[POLKIT_TYPELIBS[0]].mode, 0o644);
  fs.chmodSync(file, 0o755); assert.throws(() => p.inventory(root, true), error => {
    assert.match(error.message, /typelib/);
    assert.equal(error.inventoryEvidence.rejectedEntry.path, POLKIT_TYPELIBS[0]); return true;
  });
  fs.chmodSync(file, 0o644); fs.writeFileSync(file, elf()); assert.throws(() => p.inventory(root, true), /typelib/);
  fs.unlinkSync(file); put(root, 'target', TYPELIB); fs.symlinkSync('../../target', file);
  assert.throws(() => p.inventory(root, true), /typelib/);
});
test('GIO exception permits only its exact TLS runtime namespace, not arbitrary modules or policies', () => {
  const directory = 'usr/lib/x86_64-linux-gnu/gio/modules', tls = `${directory}/libgiognutls.so`;
  for (const name of [directory, tls]) assert.equal(p.prohibited(name), false);
  for (const name of ['modules', 'usr/modules/other', `${directory}/other.so`, `${directory}/pkexec`,
    `${directory}/x.policy`, `${directory}/libgiognutls.so.policy`, `${directory.toUpperCase()}/libgiognutls.so`,
    'usr/lib/gio/modules/libgiognutls.so', `${directory}/modules/extra`]) assert.equal(p.prohibited(name), true, name);
  const bytes = elf(), file = { kind: 'file', mode: 0o644, ...p.record(bytes) };
  p.validateGioRuntime(directory, { kind: 'directory', mode: 0o755 });
  p.validateGioRuntime(tls, file, bytes);
  for (const entry of [{ ...file, mode: 0o755 }, { ...file, kind: 'directory' }, { ...file, kind: 'symlink' },
    { ...file, mode: 0o4644 }, { ...file, size: 0 }]) assert.throws(() => p.validateGioRuntime(tls, entry, bytes));
  assert.throws(() => p.validateGioRuntime(directory, { kind: 'file', mode: 0o755 }));
  for (const changed of [Buffer.alloc(64), Buffer.from(bytes)]) {
    if (changed.subarray(0, 4).equals(bytes.subarray(0, 4))) changed.writeUInt16LE(183, 18);
    assert.throws(() => p.validateGioRuntime(tls, { ...file, ...p.record(changed) }, changed));
  }
  const executable = Buffer.from(bytes); executable.writeUInt16LE(2, 16);
  assert.throws(() => p.validateGioRuntime(tls, { ...file, ...p.record(executable) }, executable), /shared object/);
});
test('actual Unix GIO inventory refuses links and records independently checked TLS ELF bytes', t => {
  if (process.platform === 'win32') return t.skip('Real Unix modes and links belong to native Linux');
  const root = temp(t), name = 'usr/lib/x86_64-linux-gnu/gio/modules/libgiognutls.so';
  const file = put(root, name, elf());
  assert.equal(p.inventory(root, true).entries[name].sha256, p.record(elf()).sha256);
  fs.chmodSync(file, 0o755); assert.throws(() => p.inventory(root, true), /GIO TLS/);
  fs.chmodSync(file, 0o644); fs.writeFileSync(file, 'not ELF'); assert.throws(() => p.inventory(root, true), /GIO TLS/);
  fs.unlinkSync(file); put(root, 'target', elf()); fs.symlinkSync('../../../../../target', file);
  assert.throws(() => p.inventory(root, true), /GIO runtime/);
});
test('first rejected entry keeps bounded path/stat/prefix evidence without changing the rejected file', t => {
  const root = temp(t), file = put(root, 'pkexec', Buffer.alloc(4096, 97));
  const before = fs.readFileSync(file), stat = fs.lstatSync(file);
  let error; try { p.inventory(root, true); } catch (value) { error = value; }
  assert.ok(error); const evidence = error.inventoryEvidence;
  assert.equal(evidence.complete, false); assert.equal(evidence.rejectedEntry.path, 'pkexec');
  assert.equal(evidence.rejectedEntry.stat.kind, 'file'); assert.equal(evidence.rejectedEntry.stat.mode, stat.mode & 0o7777);
  assert.equal(evidence.rejectedEntry.prefix.size, 64);
  assert.equal(evidence.rejectedEntry.prefix.sha256, p.record(before.subarray(0, 64)).sha256);
  assert.equal(evidence.rejectedEntry.prefix.hex, before.subarray(0, 64).toString('hex'));
  assert.ok(Buffer.byteLength(JSON.stringify(evidence)) <= 8192);
  assert.deepEqual(fs.readFileSync(file), before);
});
test('exact built AppImage is retained before inventory and is not overwritten or changed on refusal', t => {
  const root = temp(t), source = put(root, 'built.AppImage', Buffer.concat([elf(), Buffer.from('exact unchanged fixture')]));
  const output = path.join(root, 'Creator Hub_0.1.16_amd64.AppImage'), before = fs.readFileSync(source);
  assert.deepEqual(p.retainAppImage(source, output), p.record(before));
  assert.deepEqual(fs.readFileSync(source), before); assert.deepEqual(fs.readFileSync(output), before);
  assert.throws(() => p.retainAppImage(source, output)); assert.deepEqual(fs.readFileSync(output), before);
  const text = fs.readFileSync(path.join(__dirname, 'linux-016-portable-package.cjs'), 'utf8');
  assert.ok(text.indexOf('receipt.appImage = retainAppImage(') < text.indexOf('const inv = inventory(appdir, true)'));
  assert.ok(text.indexOf('receipt.appImage = retainAppImage(') < text.indexOf('receipt.upstreamPackagingTools ='));
  assert.match(text, /receipt\.inventoryEvidence = error\.inventoryEvidence/);
  const refusal = workflow().jobs.package.steps.find(step => step.if === 'failure()' && step.uses === 'actions/upload-artifact@v4');
  assert.equal(refusal.with['compression-level'], 0);
  assert.ok(refusal.with.path.includes('${{ runner.temp }}/linux-016-portable-output/Creator Hub_0.1.16_amd64.AppImage'));
});
test('flatten preserves originals, expands only internal file links and normalizes only the copy modes', t => {
  if (process.platform === 'win32') return t.skip('Unix symlink and mode evidence belongs to the Linux workflow');
  const root = temp(t), tree = path.join(root, 'AppDir'); fs.mkdirSync(tree, { mode: 0o755 });
  put(tree, 'usr/bin/creator-hub', elf(), 0o755); put(tree, 'usr/lib/a.so.1', 'library', 0o644);
  put(tree, 'AppRun', '#!/bin/sh\n', 0o770); fs.symlinkSync('a.so.1', path.join(tree, 'usr/lib/a.so'));
  fs.symlinkSync('usr/lib/a.so', path.join(tree, '.DirIcon'));
  const before = p.inventory(tree, true), out = path.join(root, 'flat'), result = p.flatten(tree, out);
  assert.deepEqual(p.inventory(tree, true), before); assert.equal(fs.lstatSync(path.join(tree, '.DirIcon')).isSymbolicLink(), true);
  assert.deepEqual(result.flattened.links, {}); assert.equal(result.flattened.entries.AppRun.mode, 0o755);
  assert.equal(fs.readFileSync(path.join(out, '.DirIcon'), 'utf8'), 'library'); assert.equal(Object.keys(result.original.links).length, 2);
});
test('external, absolute, cyclic, directory, detour links, special files and unsafe modes refuse', t => {
  if (process.platform === 'win32') return t.skip('Requires actual Unix filesystem modes and symlinks');
  const root = temp(t), tree = path.join(root, 'AppDir'); fs.mkdirSync(tree); put(root, 'outside', 'x'); put(tree, 'inside', 'x');
  for (const target of ['../outside', path.join(tree, 'inside'), 'bad', '.']) {
    fs.symlinkSync(target, path.join(tree, 'bad')); assert.throws(() => p.inventory(tree, true)); fs.unlinkSync(path.join(tree, 'bad'));
  }
  fs.mkdirSync(path.join(root, 'detour')); fs.symlinkSync(path.join(tree, 'inside'), path.join(root, 'detour/back'));
  fs.symlinkSync('../detour/back', path.join(tree, 'bad')); assert.throws(() => p.inventory(tree, true)); fs.unlinkSync(path.join(tree, 'bad'));
  fs.chmodSync(path.join(tree, 'inside'), 0o4755); assert.throws(() => p.inventory(tree, true)); fs.chmodSync(path.join(tree, 'inside'), 0o666);
  assert.throws(() => p.inventory(tree, true)); fs.unlinkSync(path.join(tree, 'inside'));
  execFileSync('mkfifo', [path.join(tree, 'pipe')]); assert.throws(() => p.inventory(tree, true));
});
test('filesystem inventory refuses a sparse file over the provisional per-file bound', t => {
  if (process.platform === 'win32') return t.skip('Unix sparse-file sizing contract');
  const root = temp(t); const fd = fs.openSync(path.join(root, 'oversize'), 'wx'); fs.ftruncateSync(fd, p.LIMITS.file + 1); fs.closeSync(fd);
  assert.throws(() => p.inventory(root), /Bounded/);
});
test('manifest inventory independently enforces every parent, mode, path, collision, count and total bound', () => {
  const valid = { entries: { usr: { kind: 'directory', mode: 0o755 }, 'usr/bin': { kind: 'directory', mode: 0o755 },
    'usr/bin/creator-hub': { kind: 'file', ...p.record(elf()), mode: 0o755 } }, links: {}, unpackedSize: 64 };
  p.validateInventory(valid);
  for (const change of [
    b => delete b.entries['usr/bin'], b => b.entries.usr.mode = 0o775,
    b => b.entries['usr/bin/creator-hub'].mode = 0o4755,
    b => b.entries['usr/bin/creator-hub'].size = p.LIMITS.file + 1,
    b => b.entries['usr/bin/creator-hub'].extra = true,
    b => b.entries['../extra'] = { kind: 'directory', mode: 0o755 },
    b => b.entries.USR = { kind: 'directory', mode: 0o755 },
    b => b.entries['usr/bin/creator-hub-deb-retirement-helper'] = { kind: 'file', ...p.record(elf()), mode: 0o755 },
    b => b.unpackedSize++, b => b.links.x = { link: 'x' },
  ]) { const b = structuredClone(valid); change(b); assert.throws(() => p.validateInventory(b)); }
  const tooMany = { entries: Object.fromEntries(Array.from({ length: p.LIMITS.entries + 1 }, (_, i) => [`f${i}`, { kind: 'directory', mode: 0o755 }])), links: {}, unpackedSize: 0 };
  assert.throws(() => p.validateInventory(tooMany), /entry bound/);
  const tooBig = structuredClone(valid); tooBig.entries.a = tooBig.entries.b = { kind: 'file', size: p.LIMITS.file, sha256: 'a'.repeat(64), mode: 0o644 };
  tooBig.unpackedSize = p.LIMITS.total + 64; assert.throws(() => p.validateInventory(tooBig), /total bound/);
});
const VERIFY_TAR = String.raw`
import hashlib,json,sys,zlib
from pathlib import Path
raw=Path(sys.argv[1]).read_bytes(); manifest=json.load(sys.stdin); binding=manifest['archive']
assert len(raw)==binding['size'] and hashlib.sha256(raw).hexdigest()==binding['sha256']
d=zlib.decompressobj(31); tar=d.decompress(raw); tar+=d.flush()
assert d.eof and not d.unused_data and not d.unconsumed_tail and len(tar)%512==0
at=0; found={}; total=0
def octal(b): return int(b.rstrip(b'\0 '),8)
while any(tar[at:at+512]):
    h=tar[at:at+512]; assert len(h)==512 and h[257:265]==b'ustar'+bytes([0])+b'00'
    assert not any(h[157:257]) and octal(h[108:116])==octal(h[116:124])==0
    assert octal(h[148:156])==sum(h[:148])+8*32+sum(h[156:])
    name=h[:100].split(b'\0')[0]; prefix=h[345:500].split(b'\0')[0]
    name=((prefix+b'/') if prefix else b'')+name; name=name.decode('ascii')
    assert name not in found and name in manifest['entries']; e=manifest['entries'][name]; found[name]=e
    size=octal(h[124:136]); assert octal(h[100:108])==e['mode']
    assert h[156:157]==(b'5' if e['kind']=='directory' else b'0')
    assert size==(0 if e['kind']=='directory' else e['size']); at+=512
    data=tar[at:at+size]; end=at+((size+511)//512)*512
    assert not any(tar[at+size:end])
    if e['kind']=='file': assert hashlib.sha256(data).hexdigest()==e['sha256']; total+=size
    at=end
assert len(tar)-at>=1024 and not any(tar[at:]) and found==manifest['entries'] and total==binding['unpackedSize']
`;
test('raw USTAR producer headers round-trip against an independent Python reader on every host', t => {
  const root = temp(t), entries = { usr: { kind: 'directory', mode: 0o755 }, 'usr/bin': { kind: 'directory', mode: 0o755 },
    'usr/bin/creator-hub': { kind: 'file', ...p.record(elf()), mode: 0o755 } };
  const longDir = `usr/${'a'.repeat(95)}`, longName = `${longDir}/${'b'.repeat(80)}`;
  entries[longDir] = { kind: 'directory', mode: 0o755 }; entries[longName] = { kind: 'file', ...p.record(Buffer.alloc(513, 7)), mode: 0o644 };
  const chunks = [];
  for (const [name, entry] of Object.entries(entries)) {
    chunks.push(p.tarHeader(name, entry));
    if (entry.kind === 'file') { const data = name === longName ? Buffer.alloc(513, 7) : elf(); chunks.push(data, Buffer.alloc((512 - data.length % 512) % 512)); }
  }
  chunks.push(Buffer.alloc(1024)); const bytes = zlib.gzipSync(Buffer.concat(chunks)), file = put(root, 'transport.gz', bytes);
  const value = p.manifest(identity().pins, { entries, links: {}, unpackedSize: 577 }, { ...p.record(bytes), unpackedSize: 577 });
  execFileSync(PYTHON, ['-B', '-c', VERIFY_TAR, file], { input: JSON.stringify(value) });
});
test('transport is single gzip + raw USTAR with exact types, modes, prefixes, padding and complete manifest', async t => {
  if (process.platform === 'win32') return t.skip('Canonical POSIX modes require the Linux workflow');
  const root = temp(t), tree = path.join(root, 'AppDir'); fs.mkdirSync(tree);
  put(tree, 'usr/bin/creator-hub', elf(), 0o755); put(tree, 'usr/lib/empty', Buffer.alloc(0));
  put(tree, `usr/share/${'a'.repeat(95)}/${'b'.repeat(80)}`, Buffer.alloc(513, 7));
  const inv = p.inventory(tree), tar = path.join(root, 'payload.gz'), binding = await p.packTar(tree, tar, inv);
  const manifest = p.manifest(identity().pins, inv, binding);
  assert.equal(manifest.format, 'appdir-tar-gzip-v1'); assert.equal(manifest.appId, 'creator-hub'); assert.equal(manifest.version, '0.1.16');
  assert.equal(binding.unpackedSize, 64 + 513); assert.deepEqual(Object.keys(manifest).sort(),
    ['schemaVersion', 'appId', 'platform', 'architecture', 'version', 'sourceCommit', 'sourceTree', 'format', 'entrypoint', 'archive', 'entries'].sort());
  execFileSync(PYTHON, ['-B', '-c', VERIFY_TAR, tar], { input: JSON.stringify(manifest) });
  const second = path.join(root, 'second.gz'); assert.deepEqual(await p.packTar(tree, second, inv), binding);
  assert.deepEqual(fs.readFileSync(second), fs.readFileSync(tar));
  fs.appendFileSync(tar, zlib.gzipSync(Buffer.from('trailing gzip')));
  const invalid = { ...manifest, archive: { ...p.record(fs.readFileSync(tar)), unpackedSize: binding.unpackedSize } };
  assert.throws(() => execFileSync(PYTHON, ['-B', '-c', VERIFY_TAR, tar], { input: JSON.stringify(invalid), stdio: 'pipe' }));
});
test('Root permits exactly the documented UNK -> APP marker and nothing else', () => {
  const raw = Buffer.concat([elf(), Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK')]), app = Buffer.from(raw); app.write('APP', app.length - 3, 'ascii');
  unix.verifyLinuxHub(raw, app, 'appimage'); app[20] ^= 1; assert.throws(() => unix.verifyLinuxHub(raw, app, 'appimage'));
});
test('actual packaged WebKit/JSC processes and injected library must be x64 ELF, not filenames alone', t => {
  const root = temp(t), names = ['usr/lib/libwebkit2gtk-4.1.so.0', 'usr/lib/libjavascriptcoregtk-4.1.so.0',
    'usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess', 'usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitNetworkProcess',
    'usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so'];
  const entries = Object.fromEntries(names.map(n => { put(root, n, elf()); return [n, { kind: 'file', ...p.record(elf()), mode: 0o644 }]; }));
  const run = (command, args) => { assert.equal(command, '/usr/bin/readelf'); assert.equal(args[0], '--dynamic'); return ' (NEEDED) Shared library: [libc.so.6]\n'; };
  const verified = p.dependencies(root, entries, run);
  assert.equal(Object.keys(verified.primary).length, 5); assert.equal(Object.keys(verified.closure).length, 5);
  assert.deepEqual(verified.hostBaseline, ['libc.so.6']);
  assert.throws(() => p.dependencies(root, Object.fromEntries(Object.entries(entries).slice(1)), run), /Missing/);
  assert.throws(() => p.dependencies(root, entries, () => ' (NEEDED) Shared library: [libmissing.so.9]\n'), /Missing packaged subprocess dependency/);
  const extra = 'usr/lib/libextra.so.1'; put(root, extra, elf()); entries[extra] = { kind: 'file', ...p.record(elf()), mode: 0o644 };
  const transitive = p.dependencies(root, entries, (cmd, args) => args[1].endsWith('libextra.so.1') ? run(cmd, args) : ' (NEEDED) Shared library: [libextra.so.1]\n');
  assert.ok(transitive.closure[extra]);
  fs.writeFileSync(path.join(root, names[0]), 'not ELF'); assert.throws(() => p.dependencies(root, entries, run), /ELF/);
});
test('new portable analysis includes Root dependencies and primary ABI needs, not available version definitions', t => {
  const root = temp(t), names = ['usr/bin/creator-hub', 'usr/lib/libwebkit2gtk-4.1.so.0', 'usr/lib/libjavascriptcoregtk-4.1.so.0',
    'usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess', 'usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitNetworkProcess',
    'usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so'];
  const entries = Object.fromEntries(names.map(n => { put(root, n, elf()); return [n, { kind: 'file', ...p.record(elf()), mode: 0o755 }]; }));
  const dynamic = (command, args) => { assert.equal(command, '/usr/bin/readelf'); assert.equal(args[0], '--dynamic'); return ' (NEEDED) Shared library: [libc.so.6]\n'; };
  const dependencies = p.dependencies(root, entries, dynamic, { includeHub: true });
  assert.deepEqual(dependencies.primary.hub, ['usr/bin/creator-hub']);
  assert.throws(() => p.dependencies(root, entries, (command, args) => args[1].endsWith('creator-hub')
    ? ' (NEEDED) Shared library: [libmissing-hub.so.1]\n' : dynamic(command, args), { includeHub: true }), /creator-hub -> libmissing-hub/);
  const versionText = "Version definition section '.gnu.version_d' contains 1 entry:\n  Name: GLIBCXX_3.4.99 Flags: none Version: 1\n"
    + "Version needs section '.gnu.version_r' contains 1 entry:\n  File: libc.so.6 Cnt: 1\n  Name: GLIBC_2.34 Flags: none Version: 2\n";
  const abi = p.primaryAbiRequirements(root, dependencies, (command, args, options) => {
    assert.equal(command, '/usr/bin/readelf'); assert.equal(args[0], '--version-info');
    assert.equal(options.maxBuffer, 4 * 1024 * 1024); return versionText;
  });
  assert.equal(Object.keys(abi.files).length, 6);
  for (const file of Object.values(abi.files)) {
    assert.deepEqual(file.requiredSymbolVersions, ['GLIBC_2.34']);
    assert.equal(file.executableSha256, p.record(elf()).sha256);
  }
  assert.match(abi.scope, /host ABI availability.*unaccepted/);
  const tls = 'usr/lib/x86_64-linux-gnu/gio/modules/libgiognutls.so';
  put(root, tls, elf()); entries[tls] = { kind: 'file', ...p.record(elf()), mode: 0o644 };
  const withGio = p.dependencies(root, entries, dynamic, { includeHub: true });
  assert.deepEqual(withGio.primary.gioTls, [tls]);
  assert.ok(withGio.closure[tls]);
  assert.throws(() => p.dependencies(root, entries, (command, args) => args[1].endsWith('libgiognutls.so')
    ? ' (NEEDED) Shared library: [libmissing-tls.so.1]\n' : dynamic(command, args), { includeHub: true }), /libgiognutls.so -> libmissing-tls/);
  const gioAbi = p.primaryAbiRequirements(root, withGio, () => versionText);
  assert.equal(Object.keys(gioAbi.files).length, 7);
  assert.deepEqual(gioAbi.files[tls].requiredSymbolVersions, ['GLIBC_2.34']);
});
test('bundler command is bundle-only, no-sign, same features and opaque module resource', () => {
  const args = p.bundleArgs(ROOT, '/owned/overlay.json'); assert.equal(args[1], 'bundle'); assert.ok(args.includes('--no-sign'));
  assert.equal(args[args.indexOf('--features') + 1], p.FEATURES.join(',')); assert.equal(args.includes('build'), false);
  const overlay = p.overlay('/owned/modules.tar.gz'); assert.equal(overlay.bundle.createUpdaterArtifacts, false);
  assert.deepEqual(overlay.bundle.targets, ['appimage']); assert.deepEqual(overlay.bundle.resources, { '/owned/modules.tar.gz': 'modules.tar.gz' });
  assert.deepEqual(overlay.bundle.externalBin, []); assert.equal(overlay.build.beforeBundleCommand, null);
  assert.ok(Object.values(p.flags()).every(value => value === false));
});
test('upstream tool inventory records effective bytes without inventing pins or accepting cache extras', t => {
  const root = temp(t), names = ['AppRun-x86_64', 'linuxdeploy-x86_64.AppImage', 'linuxdeploy-plugin-gtk.sh', 'linuxdeploy-plugin-gstreamer.sh'];
  for (const n of names) put(root, n, 'tool');
  assert.deepEqual(Object.keys(p.toolInventory(root)), names); put(root, 'unreviewed-tool', 'x'); assert.throws(() => p.toolInventory(root));
});
function workflow(source = fs.readFileSync(path.join(ROOT, p.WORKFLOW), 'utf8')) {
  return yaml.parse(source, { uniqueKeys: true });
}
test('workflow parsing retains typed scalars and rejects duplicate YAML keys', () => {
  const parsed = workflow();
  assert.equal(parsed.on.workflow_dispatch.inputs.assembly_pins.required, true);
  assert.equal(parsed.jobs.package['timeout-minutes'], 35);
  assert.equal(parsed.jobs.package.steps[0].with['persist-credentials'], false);
  assert.throws(() => workflow('jobs:\n  package: {}\n  package: {}\n'), /unique|same key/i);
});
// Bounded checker for this workflow profile, using GitHub's context-availability table:
// https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability
function expressionContexts(parsed) {
  const step = ['github', 'needs', 'strategy', 'matrix', 'job', 'runner', 'env', 'vars', 'secrets', 'steps', 'inputs'];
  function visit(value, location = '') {
    if (value && typeof value === 'object') { for (const [key, item] of Object.entries(value)) visit(item, `${location}/${key}`); return; }
    if (typeof value !== 'string') return;
    const expressions = [...value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map(m => m[1]);
    assert.ok(!value.replace(/\$\{\{[\s\S]*?\}\}/g, '').includes('${{'), 'Unterminated GitHub expression');
    if (location.endsWith('/if') && !expressions.length) expressions.push(value);
    for (const expression of expressions) {
      let allowed;
      if (/^\/jobs\/[^/]+\/steps\/\d+\/(env|with|run|name|working-directory|timeout-minutes)(?:\/|$)/.test(location)) allowed = step;
      else if (/^\/jobs\/[^/]+\/steps\/\d+\/if$/.test(location)) allowed = step.filter(n => n !== 'secrets');
      else if (/^\/jobs\/[^/]+\/env\//.test(location)) allowed = ['github', 'needs', 'strategy', 'matrix', 'vars', 'secrets', 'inputs'];
      else if (/^\/jobs\/[^/]+\/if$/.test(location)) allowed = ['github', 'needs', 'vars', 'inputs'];
      else if (/^\/jobs\/[^/]+\/(runs-on|name|timeout-minutes)$/.test(location)) allowed = ['github', 'needs', 'strategy', 'matrix', 'vars', 'inputs'];
      else if (/^\/env\//.test(location)) allowed = ['github', 'secrets', 'inputs', 'vars'];
      else assert.fail(`Expression location not admitted by this workflow profile: ${location}`);
      const stripped = expression.replace(/'(?:[^']|'')*'/g, "''");
      for (const m of stripped.matchAll(/(?<![.\w])([A-Za-z_]\w*)\s*(?=[.\[])/g)) assert.ok(allowed.includes(m[1]), `${m[1]} unavailable at ${location}`);
      for (const m of stripped.matchAll(/\b([A-Za-z_]\w*)\s*\(/g)) assert.ok(location.endsWith('/if') && ['always', 'cancelled', 'success', 'failure'].includes(m[1]), 'Unreviewed expression function');
      // This workflow uses the JS-compatible expression subset only. Compile, never evaluate.
      const source = expression.replace(/'((?:[^']|'')*)'/g, (_, s) => JSON.stringify(s.replace(/''/g, "'")));
      new (require('node:vm').Script)(`(${source})`);
    }
  }
  visit(parsed);
}
test('GitHub expression contexts permit runner only at supported locations, never job.env', () => {
  const parsed = workflow(); expressionContexts(parsed);
  const bad = structuredClone(parsed); bad.jobs.package.env = { BAD_PATH: '${{ runner.temp }}/not-available' };
  assert.throws(() => expressionContexts(bad), /runner unavailable/);
  const good = structuredClone(parsed); good.jobs.package.steps[0].env = { OWNED_PATH: '${{ runner.temp }}/available' }; expressionContexts(good);
});
test('JS, embedded Python and the real workflow YAML/Bash parse before dispatch; no publish/install/Mac jobs', () => {
  execFileSync(process.execPath, ['--check', path.join(__dirname, 'linux-016-portable-package.cjs')]);
  for (const source of [p.ZIP_STAGE, MAKE_ZIP, VERIFY_TAR]) execFileSync(PYTHON, ['-B', '-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: source });
  const parsed = workflow(); expressionContexts(parsed);
  assert.deepEqual(Object.keys(parsed.on), ['push', 'workflow_dispatch']);
  assert.deepEqual(parsed.on.push.branches, ['validation/linux-016-portable-package']);
  assert.match(parsed.jobs.package.if, /github\.event_name == 'workflow_dispatch'/);
  assert.deepEqual(parsed.permissions, { contents: 'read', actions: 'read' }); assert.deepEqual(Object.keys(parsed.jobs), ['package']);
  assert.equal(parsed.jobs.package['runs-on'], 'ubuntu-22.04');
  for (const v of Object.values(parsed.on.workflow_dispatch.inputs)) { assert.equal(v.required, true); assert.equal(v.type, 'string'); assert.equal(v.default, undefined); }
  for (const step of parsed.jobs.package.steps) if (step.run) {
    execFileSync(BASH, ['-n'], { input: step.run, stdio: ['pipe', 'pipe', 'pipe'] });
    assert.doesNotMatch(step.run, /gh\s+(?:workflow\s+run|release)|git\s+(?:push|commit)|dpkg\s+-i|flatpak\s+install|cargo\s+(?:run|test)|build:unified|tauri\s+build/);
  }
  const downloads = parsed.jobs.package.steps.filter(s => s.env?.GH_TOKEN);
  assert.equal(downloads.length, 1); assert.match(downloads[0].run, /\.cjs fetch/);
  const packageStep = parsed.jobs.package.steps.find(s => s.run?.includes('.cjs package'));
  assert.equal(packageStep.env, undefined);
  const steps = parsed.jobs.package.steps, at = pattern => steps.findIndex(s => pattern.test(s.run || s.uses || ''));
  const preflight = at(/\.cjs preflight/), fetch = at(/\.cjs fetch/), verifier = at(/cargo build/);
  assert.ok(preflight > at(/actions\/setup-node/));
  assert.ok(preflight < at(/apt-get/) && preflight < at(/npm ci/) && preflight < at(/rust-toolchain/));
  assert.ok(fetch > preflight && verifier > fetch && verifier < at(/\.cjs package/));
  assert.equal(steps[preflight].env.GH_TOKEN, undefined); assert.equal(parsed.jobs.package.env, undefined);
});
