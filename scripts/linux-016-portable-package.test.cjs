// Admission/transport fixtures only; no native GUI acceptance. Upstream AppRun data is never executed.
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
function dynamicTable(needed = [], versionNeedCount = 0) {
  const count = needed.length + 1 + (versionNeedCount ? 2 : 0);
  return `Dynamic section at offset 0x1000 contains ${count} ${count === 1 ? 'entry' : 'entries'}:\n`
    + '  Tag                Type        Name/Value\n'
    + needed.map(name => `  0x0000000000000001 (NEEDED) Shared library: [${name}]\n`).join('')
    + (versionNeedCount ? '  0x000000006ffffffe (VERNEED) 0x2000\n'
      + `  0x000000006fffffff (VERNEEDNUM) ${versionNeedCount}\n` : '')
    + '  0x0000000000000000 (NULL) 0x0\n';
}
function versionTable(requirements) {
  const entries = Object.entries(requirements); let index = 2;
  if (!entries.length) return 'No version information found in this file.\n';
  return `Version needs section '.gnu.version_r' contains ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}:\n`
    + ' Addr: 0x2000 Offset: 0x2000 Link: 4 (.dynstr)\n'
    + entries.map(([name, versions]) => `  000000: Version: 1 File: ${name} Cnt: ${versions.length}\n`
      + versions.map(tag => `  0x0010: Name: ${tag} Flags: none Version: ${index++}\n`).join('')).join('');
}
function dependencyFiles(t, extra = []) {
  const root = temp(t), names = ['usr/bin/creator-hub', 'usr/lib/libwebkit2gtk-4.1.so.0', 'usr/lib/libjavascriptcoregtk-4.1.so.0',
    'usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess', 'usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitNetworkProcess',
    'usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so', ...extra];
  const entries = Object.fromEntries(names.map(n => { put(root, n, elf()); return [n, { kind: 'file', ...p.record(elf()), mode: 0o755 }]; }));
  return { root, entries };
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
// Exact upstream ELF, losslessly compressed; no verifier seam or runtime pin override.
const APPRUN_BYTES = zlib.inflateRawSync(Buffer.from([
  '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',
  'TdIoSggAiYWKouky253IdoWG7bvIVqawGc5KUuIvH0vSrrmJYiJSu3YqOanucw/NLiQd8NAF+9cq9o+TWrfvcQ/N/lceYIyM4Heb4yeuc8f/5h58',
  '/VRrW/PRUfwG0H30EH4x6T56FL9XTLz5sSR91E3OkwfwCyB3Lf6POg6QK44do1HLUwhIJ7uHD3d3u9i5Hs8bTxL+298jSfyU+9B717gPnTO6uWfc',
  'J85H8xUNWVSDXn6gNl6BX0+Nwwu3xBZJkp7hb64A4DYcJv7o+d++S2ffxS7KB486Euc/wt77TM2oe8eZaOmvLHJgO0wAyjVR7rdH8dSNV+woX7+2',
  'Pi7Vr2mOn6lvb46/UN/WMlRRPRmg3T1Uienqlulv1PzZfegLIxpJfPEhjul3oxOZDy3xt1riZxrjUr1U+Ip78DDnnvd27C1U//UNrHsdHlZ9/vAw',
  'c1e5Zbh0XDouHf+PHFzSt9wALq8vcmM01A9VsUi4Cp9zBKoivZ6wr2o+QeQ8VPWHQ11VEV+gu8q3yQcVkaqKCDRt8nXVYj4WCUMTPrSY71wYigW8',
  'zmAo6uzyOv3BaMhZEbFC67o294rl7hXLmmpl9ipoaRRbmhtW1a9aJ7bWt7kpC8l2NC4WG+vb6sXG5lWrobVpVUtLcwMsXt3U1ta8fPFqcfVCd9My',
  'Ugor28TWlvbFzcu1ShpXLG9bu6q5ralhXVvTwhWNTbU1qe55urp8kYgzuWJWxrc85GSRcXb7A76IszsUC3qtqXrwSY7T6w/7uqKh8GZSWzwoH4Yo',
  'FvV0BnyEmSj5qrPPc6PPGYmFfc5ory/sc/ojTo8TnwI5yQMXf7DHebM/2uu8gkT4CtS4tn7V8ubli+c7GzVeObv9voDX2RXy+pwVFRVdqIiEPhYO',
  '+4LRwGZnJNbfHwpHfV72bEDR0xzc6An4vU7vRfRZATCsrM06/cGq+TQf0RI9nj5fhFAMZcX6ZmaqAv5ORRrz/plz59An/T3BWFLRprlzxDmz0hfO',
  'nKGl5swiFNOdQW9Gnao+RRdouiVzXR4R/ZtJ6pW5ILnPJrPKeuRerFPiCwdmJ1VWQdj4TNfrk5X0BPydlTNc1VWRrl5fnyciSycPDG3Yb4rOquoP',
  'xHr8wcjFmiATW0roMjDOnJGpZM6sjMpvis7+cr6lZ0vjW1pG4lvaEuJbUonSDkpAV69b3da0LCWuPfjk1tPnCxOh9PxijVidVqayxlVN5Ni8gYnT',
  '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',
  '999EMvDvzIDfa0j/3pcfG9K/9+WJDHqez4A/AenfQ+M2pH9/zN8N6d8f84Eh/ftjzmawazOmx50Z8BkZ8EUZ8F8a0r+3Zr0x/Xtr1IVhXeFoJBrr',
  '7nZ1gdcX9vX4I1FfWIz2iV2BUBCf9YrekNgTCHV6AqI3GgpHRE9sE3SF+voDvqjP67pq5ow56ZnI+19ETzjs2Sz6gtHwZugOe/p8ojfW17cZRFFD',
  'kTe8JLGK4qJV9cuaxKbljaL88FzDgO+B8UZCYq8n6A34QGxct7x+WfPCZDb2jpnFy9vFJjdV525cBaLYtmwhU7y4ZUVDfYu4YtGi1U1tYlt9Q0uT',
  'mPIOG3lVR12d9j0z+Gg/GdGvg9CV0vfgkKfHyUXy+o9kjCzP0LHRR+UpwrjAROec/KiarnjQu6l7gY/OMFmLkYzJD5f1ajRv8ulO55nu9T50tUsy',
  'D1sLo6Iz/9F7gPrSOKgsNdF7oL4tiDzfllemJDPRZ+LJIC6E0IWUPH1PiT1ZTKNH8WF4MgauyOa+qKcTXJFoWE57Wc4fjPrC/eAKhqI+V08w5pIX',
  'BPi9FKpvaK6MenqAlPV6Ir3g8m4ORjb3yWk0LJds9IUjuPpGS4hhcIV9AQ8y0lx/IIom/VFwRXGJiov0cFc4RLqny9dLx2WvN6xSsoQ8sGQJlvdu',
  'Dnr6/F3g6glFyT/ZgKysMxIBV1eorw8XYbi8vs5Yj+gJe4I9vggj/cHukFLU2Rn2bWQUWahA86SSFA51sSzV9H/iKKXXcuz6Q30PpEzrr3A5HT1F',
  '964m9b2HMl2u4zfp6Dk6eXaflqCA/tyql8f9u85IUojJs/s5M91gxEtxtn+JWSe/nO5VwuTZfV8/lR+mqUDrzuTZviJr6INZZc8vdn9INyhZoguY',
  'Pn7X0b1ImDy7j1xCDbXo/Dfo0hvp3iaMZvebe6g829lC7z87bqExZfLsvvSYTl4fP1b/7VS+gdLs/vUcZWT7ufD0fU96+btAfVcnOZT3gsqJ/o5M',
  '3/5xnTy7H3ZS+QFdwPN06bd18uy6Zh99Kdb91vTy7PieTp5dJzfSgaPfiUTv/z7d+FPfbyonO3VP1/Xtt18nr74/VKYX6Pj19h/TybP7+mNUvkQX',
  'P739UbpXAtvPR3mfqCs9v1mX/gd9XxmTZ/dtzi8p/zKNPZNX3tdK5dl7WgWdHGvH/6L1Z/Lse4dzVV/O/t918sp9Hh04x/+B/Ps6eXbfcZzK69tL',
  'P398THUxeXa9+8fq5Hrq7bPjU6pTvwMOk1+XwT5LjVyqT3hU1sip/q5dz1uQQb6Pyrsdybied2IG+V/SF+2W6TZj1PN+NYP8iUVyepZPxvW8c7n0',
  '8TtGJ+5JGeRZujCD/TfpV9nHdTc9et7lGeQfpye+63W4njdp7tEcJfRGs4N2GNx0c1aa+duiex8jO/r7aKor1NvPzyB/sl9O1/+D8+f/Ag==',
].join(''), 'base64'), { maxOutputLength: 31552 });
test('39339847288 exact upstream AppRun 0770 is source-only and the complete canonical record requires 0755', () => {
  assert.deepEqual(p.record(APPRUN_BYTES), p.APPRUN_PIN);
  const source = { kind: 'file', ...p.record(APPRUN_BYTES), mode: 0o770 }, canonical = { ...source, mode: 0o755 };
  p.validateAppRunWrapped(p.APPRUN_WRAPPED, source, APPRUN_BYTES, true);
  p.validateAppRunWrapped(p.APPRUN_WRAPPED, canonical, APPRUN_BYTES);
  assert.equal(p.transportMode(p.APPRUN_WRAPPED, source), 0o755);
  for (const name of ['AppRun', 'apprun.wrapped', 'usr/bin/AppRun.wrapped', 'AppRun.wrapped/child'])
    assert.throws(() => p.validateAppRunWrapped(name, source, APPRUN_BYTES, true));
  for (const mode of [0o644, 0o750, 0o755, 0o775, 0o777, 0o4770, 0o1770])
    assert.throws(() => p.validateAppRunWrapped(p.APPRUN_WRAPPED, { ...source, mode }, APPRUN_BYTES, true));
  for (const kind of ['directory', 'symlink', 'fifo'])
    assert.throws(() => p.validateAppRunWrapped(p.APPRUN_WRAPPED, { ...source, kind }, APPRUN_BYTES, true));
  for (const changed of [{ ...source, size: source.size - 1 }, { ...source, sha256: '0'.repeat(64) }])
    assert.throws(() => p.validateAppRunWrapped(p.APPRUN_WRAPPED, changed, APPRUN_BYTES, true));
  for (const change of [b => b[0] = 0, b => b[4] = 1, b => b[5] = 2, b => b.writeUInt16LE(183, 18),
    b => b.writeUInt16LE(1, 16), b => b[b.length - 1] ^= 1]) {
    const bad = Buffer.from(APPRUN_BYTES); change(bad);
    assert.throws(() => p.validateAppRunWrapped(p.APPRUN_WRAPPED, source, bad, true));
  }
  assert.throws(() => p.validateAppRunWrapped(p.APPRUN_WRAPPED, source, APPRUN_BYTES.subarray(0, -1), true));
  const inventory = { entries: { [p.APPRUN_WRAPPED]: canonical }, links: {}, unpackedSize: APPRUN_BYTES.length };
  p.validateInventory(inventory);
  for (const mode of [0o644, 0o750, 0o770, 0o775, 0o777, 0o4755]) {
    const changed = structuredClone(inventory); changed.entries[p.APPRUN_WRAPPED].mode = mode;
    assert.throws(() => p.validateInventory(changed));
  }
  const changed = structuredClone(inventory); changed.entries[p.APPRUN_WRAPPED].sha256 = '0'.repeat(64);
  assert.throws(() => p.validateInventory(changed));
});
test('AppRun receipt binds the actually cached tool hash to fixed Tauri 2.11.4 permission/copy sources', () => {
  const tool = p.record(APPRUN_BYTES), binding = p.appRunToolBinding({ [p.APPRUN_TOOL]: tool });
  assert.deepEqual(binding.tool, { name: 'AppRun-x86_64', size: 31552,
    sha256: 'f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f' });
  assert.equal(binding.path, 'AppRun.wrapped');
  const base = 'https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/linux/appimage/';
  assert.equal(binding.sources.permissions, base + 'mod.rs'); assert.equal(binding.sources.copy, base + 'linuxdeploy.rs');
  assert.equal(binding.sources.download, 'https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64');
  for (const changed of [{}, { [p.APPRUN_TOOL]: { ...tool, size: tool.size + 1 } },
    { [p.APPRUN_TOOL]: { ...tool, sha256: '0'.repeat(64) } }, { 'apprun-x86_64': tool }])
    assert.throws(() => p.appRunToolBinding(changed));
  const text = fs.readFileSync(path.join(__dirname, 'linux-016-portable-package.cjs'), 'utf8');
  assert.ok(text.indexOf('receipt.appRunWrapper = appRunToolBinding') < text.indexOf('const inv = inventory(appdir, true)'));
  assert.match(text, /receipt\.appRunWrapper\.original = inv\.entries\[APPRUN_WRAPPED\]/);
  assert.match(text, /receipt\.appRunWrapper\.transport = transformation\.flattened\.entries\[APPRUN_WRAPPED\]/);
});
test('actual Unix exact AppRun 0770 round-trips to 0755 TAR without source byte/mode/inode changes', async t => {
  if (process.platform === 'win32') return t.skip('Requires actual Unix 0770 source and 0755 copied modes');
  const root = temp(t), tree = path.join(root, 'original'), output = path.join(root, 'transport'); fs.mkdirSync(tree);
  const file = put(tree, p.APPRUN_WRAPPED, APPRUN_BYTES, 0o770), stat = fs.lstatSync(file);
  const before = p.inventory(tree, true);
  assert.equal(before.entries[p.APPRUN_WRAPPED].mode, 0o770); assert.throws(() => p.inventory(tree), /writable/);
  const result = p.flatten(tree, output);
  assert.deepEqual(p.inventory(tree, true), before); assert.deepEqual(fs.readFileSync(file), APPRUN_BYTES);
  for (const field of ['mode', 'dev', 'ino', 'size', 'nlink', 'mtimeMs', 'ctimeMs']) assert.equal(fs.lstatSync(file)[field], stat[field]);
  const canonical = result.flattened.entries[p.APPRUN_WRAPPED];
  assert.deepEqual(canonical, { kind: 'file', ...p.APPRUN_PIN, mode: 0o755 });
  assert.deepEqual(fs.readFileSync(path.join(output, p.APPRUN_WRAPPED)), APPRUN_BYTES);
  const tar = path.join(root, 'wrapped.tar.gz'), archive = await p.packTar(output, tar, result.flattened);
  execFileSync(PYTHON, ['-B', '-c', VERIFY_TAR, tar], { input: JSON.stringify({ archive, entries: result.flattened.entries }) });
  fs.chmodSync(file, 0o755); assert.throws(() => p.inventory(tree, true), /AppRun.wrapped type\/mode/);
  fs.chmodSync(file, 0o770); fs.renameSync(file, path.join(tree, 'OtherRun.wrapped'));
  assert.throws(() => p.inventory(tree, true), /writable/);
});
test('actual Unix AppRun exception refuses links, hardlinks, specials, wrong data and all other writable runtimes', t => {
  if (process.platform === 'win32') return t.skip('Requires real Unix links, FIFO and permission bits');
  const root = temp(t), tree = path.join(root, 'AppDir'); fs.mkdirSync(tree);
  const file = path.join(tree, p.APPRUN_WRAPPED), target = put(root, 'tool', APPRUN_BYTES, 0o770);
  fs.symlinkSync('../tool', file); assert.throws(() => p.inventory(tree, true), /single-link regular/); fs.unlinkSync(file);
  fs.linkSync(target, file); assert.throws(() => p.inventory(tree, true), /single-link regular/); fs.unlinkSync(file);
  fs.mkdirSync(file); assert.throws(() => p.inventory(tree, true), /single-link regular/); fs.rmdirSync(file);
  execFileSync('mkfifo', [file]); assert.throws(() => p.inventory(tree, true), /single-link regular/); fs.unlinkSync(file);
  const bad = Buffer.from(APPRUN_BYTES); bad[bad.length - 1] ^= 1; put(tree, p.APPRUN_WRAPPED, bad, 0o770);
  assert.throws(() => p.inventory(tree, true), /AppRun.wrapped bytes differ/); fs.unlinkSync(file);
  put(tree, p.APPRUN_WRAPPED, APPRUN_BYTES, 0o770);
  for (const mode of [0o775, 0o777, 0o4770]) { fs.chmodSync(file, mode); assert.throws(() => p.inventory(tree, true)); }
  fs.chmodSync(file, 0o770);
  const runtime = put(tree, 'usr/bin/OtherRun', APPRUN_BYTES, 0o770);
  assert.throws(() => p.inventory(tree, true), /writable/); fs.unlinkSync(runtime);
  fs.symlinkSync(p.APPRUN_WRAPPED, path.join(tree, 'alias'));
  assert.throws(() => p.inventory(tree, true), /Unsafe symlink target mode/);
});
const COPYRIGHT_NAME = 'usr/share/doc/libbz2-1.0/copyright';
const SCHEMA_NAME = `${p.SCHEMA_DIRECTORY}/org.gnome.desktop.a11y.interface.gschema.xml`;
// Exact, small data fixtures from retained image 39335641660; no executable fixture.
const COPYRIGHT = Buffer.from([
  'Rm9ybWF0OiBodHRwczovL3d3dy5kZWJpYW4ub3JnL2RvYy9wYWNrYWdpbmctbWFudWFscy9jb3B5cmlnaHQtZm9ybWF0LzEuMC8KVXBzdHJlYW0t',
  'TmFtZTogYnppcDIKU291cmNlOiBodHRwOi8vd3d3LmJ6aXAub3JnLwoKRmlsZXM6ICoKQ29weXJpZ2h0OiAxOTk2LTIwMTAgSnVsaWFuIFIgU2V3',
  'YXJkIDxqc2V3YXJkQGJ6aXAub3JnPgpMaWNlbnNlOiBCU0QtdmFyaWFudAogUmVkaXN0cmlidXRpb24gYW5kIHVzZSBpbiBzb3VyY2UgYW5kIGJp',
  'bmFyeSBmb3Jtcywgd2l0aCBvciB3aXRob3V0CiBtb2RpZmljYXRpb24sIGFyZSBwZXJtaXR0ZWQgcHJvdmlkZWQgdGhhdCB0aGUgZm9sbG93aW5n',
  'IGNvbmRpdGlvbnMKIGFyZSBtZXQ6CiAuCiAxLiBSZWRpc3RyaWJ1dGlvbnMgb2Ygc291cmNlIGNvZGUgbXVzdCByZXRhaW4gdGhlIGFib3ZlIGNv',
  'cHlyaWdodAogICAgbm90aWNlLCB0aGlzIGxpc3Qgb2YgY29uZGl0aW9ucyBhbmQgdGhlIGZvbGxvd2luZyBkaXNjbGFpbWVyLgogLgogMi4gVGhl',
  'IG9yaWdpbiBvZiB0aGlzIHNvZnR3YXJlIG11c3Qgbm90IGJlIG1pc3JlcHJlc2VudGVkOyB5b3UgbXVzdAogICAgbm90IGNsYWltIHRoYXQgeW91',
  'IHdyb3RlIHRoZSBvcmlnaW5hbCBzb2Z0d2FyZS4gIElmIHlvdSB1c2UgdGhpcwogICAgc29mdHdhcmUgaW4gYSBwcm9kdWN0LCBhbiBhY2tub3ds',
  'ZWRnbWVudCBpbiB0aGUgcHJvZHVjdAogICAgZG9jdW1lbnRhdGlvbiB3b3VsZCBiZSBhcHByZWNpYXRlZCBidXQgaXMgbm90IHJlcXVpcmVkLgog',
  'LgogMy4gQWx0ZXJlZCBzb3VyY2UgdmVyc2lvbnMgbXVzdCBiZSBwbGFpbmx5IG1hcmtlZCBhcyBzdWNoLCBhbmQgbXVzdAogICAgbm90IGJlIG1p',
  'c3JlcHJlc2VudGVkIGFzIGJlaW5nIHRoZSBvcmlnaW5hbCBzb2Z0d2FyZS4KIC4KIDQuIFRoZSBuYW1lIG9mIHRoZSBhdXRob3IgbWF5IG5vdCBi',
  'ZSB1c2VkIHRvIGVuZG9yc2Ugb3IgcHJvbW90ZQogICAgcHJvZHVjdHMgZGVyaXZlZCBmcm9tIHRoaXMgc29mdHdhcmUgd2l0aG91dCBzcGVjaWZp',
  'YyBwcmlvciB3cml0dGVuCiAgICBwZXJtaXNzaW9uLgogLgogVEhJUyBTT0ZUV0FSRSBJUyBQUk9WSURFRCBCWSBUSEUgQVVUSE9SIGBgQVMgSVMn',
  'JyBBTkQgQU5ZIEVYUFJFU1MKIE9SIElNUExJRUQgV0FSUkFOVElFUywgSU5DTFVESU5HLCBCVVQgTk9UIExJTUlURUQgVE8sIFRIRSBJTVBMSUVE',
  'CiBXQVJSQU5USUVTIE9GIE1FUkNIQU5UQUJJTElUWSBBTkQgRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UKIEFSRSBESVNDTEFJTUVE',
  'LiAgSU4gTk8gRVZFTlQgU0hBTEwgVEhFIEFVVEhPUiBCRSBMSUFCTEUgRk9SIEFOWQogRElSRUNULCBJTkRJUkVDVCwgSU5DSURFTlRBTCwgU1BF',
  'Q0lBTCwgRVhFTVBMQVJZLCBPUiBDT05TRVFVRU5USUFMCiBEQU1BR0VTIChJTkNMVURJTkcsIEJVVCBOT1QgTElNSVRFRCBUTywgUFJPQ1VSRU1F',
  'TlQgT0YgU1VCU1RJVFVURQogR09PRFMgT1IgU0VSVklDRVM7IExPU1MgT0YgVVNFLCBEQVRBLCBPUiBQUk9GSVRTOyBPUiBCVVNJTkVTUwogSU5U',
  'RVJSVVBUSU9OKSBIT1dFVkVSIENBVVNFRCBBTkQgT04gQU5ZIFRIRU9SWSBPRiBMSUFCSUxJVFksCiBXSEVUSEVSIElOIENPTlRSQUNULCBTVFJJ',
  'Q1QgTElBQklMSVRZLCBPUiBUT1JUIChJTkNMVURJTkcKIE5FR0xJR0VOQ0UgT1IgT1RIRVJXSVNFKSBBUklTSU5HIElOIEFOWSBXQVkgT1VUIE9G',
  'IFRIRSBVU0UgT0YgVEhJUwogU09GVFdBUkUsIEVWRU4gSUYgQURWSVNFRCBPRiBUSEUgUE9TU0lCSUxJVFkgT0YgU1VDSCBEQU1BR0UuCgpGaWxl',
  'czogZGViaWFuLyoKQ29weXJpZ2h0OiAyMDE4IE5pY29sYXMgQm91bGVuZ3VleiA8bmljb2xhcy5ib3VsZW5ndWV6QGZyZWUuZnI+CgkgICAyMDEy',
  'LTIwMTUgU2FudGlhZ28gUnVhbm8gUmluY8OzbiA8c2FudGlhZ29AZGViaWFuLm9yZz4KICAgICAgICAgICAyMDE0ICAgICAgQ2Fub25pY2FsIEx0',
  'ZC4KICAgICAgICAgICAyMDA0LTIwMTEgQW5pYmFsIE1vbnNhbHZlIFNhbGF6YXIgPGFuaWJhbEBkZWJpYW4ub3JnPgogICAgICAgICAgIDE5OTkt',
  'MjAwMiBQaGlsaXBwZSBUcm9pbiA8cGhpbEBmaWZpLm9yZz4KICAgICAgICAgICAxOTk3LTE5OTkgQW50aG9ueSBGb2sgPGZva2FAZGViaWFuLm9y',
  'Zz4KTGljZW5zZTogR1BMLTIKIFRoZSBmdWxsIHRleHQgb2YgdGhlIEdOVSBHZW5lcmFsIFB1YmxpYyBMaWNlbnNlIHZlcnNpb24gMgogY2FuIGJl',
  'IGZvdW5kIGluIC91c3Ivc2hhcmUvY29tbW9uLWxpY2Vuc2VzL0dQTC0yLgo=',
].join(''), 'base64');
const SCHEMA_XML = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<schemalist gettext-domain="gsettings-desktop-schemas">
  <schema id="org.gnome.desktop.a11y.interface" path="/org/gnome/desktop/a11y/interface/">
    <key name="high-contrast" type="b">
      <default>false</default>
      <summary>High contrast</summary>
      <description>
        Whether to use the high contrast style.
      </description>
    </key>
  </schema>
</schemalist>
`);
function gvdb() {
  const b = Buffer.alloc(69);
  b.writeUInt32LE(1918981703, 0); b.writeUInt32LE(1953390953, 4);
  b.writeUInt32LE(24, 16); b.writeUInt32LE(60, 20); b.writeUInt32LE(1, 28);
  b.writeUInt32LE(0xffffffff, 40); b.writeUInt32LE(60, 44); b.writeUInt16LE(1, 48); b[50] = 118;
  b.writeUInt32LE(64, 52); b.writeUInt32LE(69, 56); b[60] = 107;
  b.set(Buffer.from([104, 105, 0, 0, 115]), 64); return b;
}
test('finite metadata paths/pins do not grant a writable-data exception to aliases, extras or runtime', () => {
  assert.equal(Object.keys(p.METADATA_PINS).length, 54);
  assert.deepEqual(p.record(COPYRIGHT), p.METADATA_PINS[COPYRIGHT_NAME]);
  assert.deepEqual(p.record(SCHEMA_XML), p.METADATA_PINS[SCHEMA_NAME]);
  assert.equal(p.metadataRole(COPYRIGHT_NAME), 'copyright'); assert.equal(p.metadataRole(SCHEMA_NAME), 'schema-data');
  for (const n of ['usr/bin/creator-hub', 'usr/lib/a.so']) assert.equal(p.metadataRole(n), null);
  for (const n of [`${p.SCHEMA_DIRECTORY}/unknown.gschema.xml`, `${p.SCHEMA_DIRECTORY}/sub/gschemas.compiled`,
    'usr/share/doc/unreviewed/copyright', SCHEMA_NAME.toUpperCase(), COPYRIGHT_NAME.toUpperCase(), p.SCHEMA_DIRECTORY.toUpperCase()]) assert.throws(() => p.metadataRole(n));
  assert.equal(p.transportMode(COPYRIGHT_NAME, { kind: 'file', mode: 0o777 }), 0o644);
  assert.equal(p.transportMode(p.COMPILED_SCHEMA, { kind: 'file', mode: 0o666 }), 0o644);
  assert.equal(p.transportMode(p.SCHEMA_DIRECTORY, { kind: 'directory', mode: 0o777 }), 0o755);
});
test('only exact inspected data/type/source modes can normalize and canonical mode remains 0644', () => {
  for (const [name, bytes] of [[COPYRIGHT_NAME, COPYRIGHT], [SCHEMA_NAME, SCHEMA_XML]]) {
    const entry = { kind: 'file', ...p.record(bytes), mode: 0o777 };
    p.validateMetadata(name, entry, bytes, true);
    p.validateMetadata(name, { ...entry, mode: 0o644 }, bytes);
    for (const mode of [0o777, 0o666, 0o664, 0o755, 0o4644]) assert.throws(() => p.validateMetadata(name, { ...entry, mode }, bytes));
    for (const mode of [0o666, 0o755, 0o4777, 0o1777]) assert.throws(() => p.validateMetadata(name, { ...entry, mode }, bytes, true));
    for (const kind of ['directory', 'symlink', 'fifo']) assert.throws(() => p.validateMetadata(name, { ...entry, kind }, bytes, true));
    for (const bad of [elf(), Buffer.alloc(p.DATA_LIMIT + 1), Buffer.from('Copyright: not the inspected notice\n')])
      assert.throws(() => p.validateMetadata(name, { ...entry, ...p.record(bad) }, bad, true));
    const changed = Buffer.from(bytes); changed[changed.length - 2] ^= 1;
    assert.throws(() => p.validateMetadata(name, entry, changed, true));
  }
  p.validateMetadata(p.COMPILED_SCHEMA, { kind: 'file', ...p.METADATA_PINS[p.COMPILED_SCHEMA], mode: 0o666 }, undefined, true);
  assert.throws(() => p.validateMetadata(p.COMPILED_SCHEMA, { kind: 'file', ...p.METADATA_PINS[p.COMPILED_SCHEMA], mode: 0o777 }, undefined, true));
  p.validateMetadata(p.SCHEMA_DIRECTORY, { kind: 'directory', mode: 0o777 }, undefined, true);
  assert.throws(() => p.validateMetadata(p.SCHEMA_DIRECTORY, { kind: 'directory', mode: 0o777 }));
});
test('metadata classification rejects renamed binaries, invalid UTF8, entities and malformed XML/DTD/overrides', () => {
  for (const [name, bytes] of [[COPYRIGHT_NAME, elf()], [SCHEMA_NAME, Buffer.from([255])], [SCHEMA_NAME, Buffer.from('<schemalist>')],
    [SCHEMA_NAME, Buffer.from('<!DOCTYPE schemalist SYSTEM "file:///etc/passwd"><schemalist></schemalist>')],
    [`${p.SCHEMA_DIRECTORY}/gschema.dtd`, Buffer.from('<!ENTITY external SYSTEM "file:///etc/passwd">')],
    [`${p.SCHEMA_DIRECTORY}/10_gsettings-desktop-schemas.gschema.override`, Buffer.from('#!/bin/sh\n')]])
    assert.throws(() => p.validateMetadataFormat(name, bytes));
  p.validateMetadataFormat(SCHEMA_NAME, SCHEMA_XML);
  p.validateMetadataFormat(SCHEMA_NAME, Buffer.concat([SCHEMA_XML, Buffer.from('<!-- generated data ends here -->\n')]));
});
test('GVDB checks the real header, tables, parents, lists and aligned in-file variant ranges', () => {
  assert.deepEqual(p.gvdbVariants(gvdb()), [[64, 69]]);
  for (const change of [b => b[0] ^= 1, b => b.writeUInt32LE(1, 8), b => b.writeUInt32LE(1, 12),
    b => b.writeUInt32LE(25, 16), b => b.writeUInt32LE(9999, 20), b => b.writeUInt32LE(9999, 28),
    b => b.writeUInt32LE(2, 32), b => b.writeUInt32LE(0, 40), b => b.writeUInt32LE(100, 44),
    b => b[50] = 33, b => b[51] = 1, b => b.writeUInt32LE(65, 52), b => b.writeUInt32LE(100, 56),
    b => { b[50] = 72; b.writeUInt32LE(24, 52); b.writeUInt32LE(60, 56); },
    b => { b[50] = 76; b.writeUInt32LE(68, 56); b.writeUInt32LE(999, 64); }]) {
    const b = gvdb(); change(b); assert.throws(() => p.gvdbVariants(b));
  }
  for (const b of [Buffer.alloc(0), Buffer.alloc(23), Buffer.alloc(p.DATA_LIMIT + 1)]) assert.throws(() => p.gvdbVariants(b));
});
test('compiled schemas use existing GLib untrusted normal-form validation with bounded stdin, not settings access', () => {
  let calls = 0;
  assert.deepEqual(p.validateCompiledSchema(gvdb(), (command, args, options) => {
    calls++; assert.equal(command, 'python3'); assert.deepEqual(args, ['-B', '-c', p.GVDB_VARIANTS]);
    assert.equal(options.timeout, 30000); assert.equal(options.maxBuffer, 4096);
    const input = JSON.parse(options.input); assert.deepEqual(Buffer.from(input.bytes, 'base64'), gvdb());
    assert.deepEqual(input.variants, [[64, 69]]); return '{"normalVariants":1}';
  }), { normalVariants: 1 });
  assert.equal(calls, 1);
  assert.throws(() => p.validateCompiledSchema(gvdb(), () => '{"normalVariants":0}'));
  assert.throws(() => p.validateCompiledSchema(gvdb(), () => { throw Error('GLib unavailable'); }), /GLib unavailable/);
  execFileSync(PYTHON, ['-B', '-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: p.GVDB_VARIANTS });
  assert.match(p.GVDB_VARIANTS, /end-start,False,None,None/);
  assert.doesNotMatch(p.GVDB_VARIANTS, /GSettings|g_settings|open\(|write\(/);
});
test('actual Linux GLib accepts normal variants and rejects malformed serialized string data', t => {
  if (process.platform !== 'linux') return t.skip('System libglib GVariant parser requires actual Linux');
  assert.deepEqual(p.validateCompiledSchema(gvdb(), pythonRun), { normalVariants: 1 });
  const bad = gvdb(); bad[64] = 255;
  assert.throws(() => p.validateCompiledSchema(bad, pythonRun));
});
test('retained original refuses an existing foreign target, nested destination or unreviewed inventory before writes', t => {
  const root = temp(t), source = path.join(root, 'source'), existing = path.join(root, 'foreign');
  fs.mkdirSync(source); fs.mkdirSync(existing);
  const sentinel = put(existing, 'keep', 'foreign destination must remain unchanged'), stamp = fs.lstatSync(sentinel);
  const expected = p.inventory(source, true);
  assert.throws(() => p.retainOriginalAppDir(source, existing, expected), /already exists/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'foreign destination must remain unchanged');
  for (const field of ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs']) assert.equal(fs.lstatSync(sentinel)[field], stamp[field]);
  const nested = path.join(source, 'retained');
  assert.throws(() => p.retainOriginalAppDir(source, nested, expected), /outside the source/);
  assert.equal(fs.existsSync(nested), false);
  const fresh = path.join(root, 'fresh'), forged = structuredClone(expected);
  forged.entries['../foreign'] = { kind: 'directory', mode: 0o777 };
  assert.throws(() => p.retainOriginalAppDir(source, fresh, forged), /changed before retention/);
  assert.equal(fs.existsSync(fresh), false); assert.deepEqual(fs.readdirSync(source), []);
  assert.deepEqual(p.retainOriginalAppDir(source, fresh, expected), expected);
  assert.deepEqual(p.inventory(fresh, true), expected); assert.deepEqual(p.inventory(source, true), expected);
  assert.throws(() => p.retainOriginalAppDir(source, fresh, expected), /already exists/);
  const text = fs.readFileSync(path.join(__dirname, 'linux-016-portable-package.cjs'), 'utf8');
  assert.ok(text.indexOf('retainOriginalAppDir(appdir, retained, inv)') < text.indexOf('transformation = flatten(appdir, transport)'));
  assert.match(text, /retainOriginalAppDir\(appdir, retained, inv\);\s*assert\.deepEqual\(inventory\(retained, true\), inv\)/);
});
test('actual Unix retained copy preserves reviewed schema directory 0777 and exact source inventory before flatten', t => {
  if (process.platform === 'win32') return t.skip('Original/retained POSIX directory-mode preservation requires Unix');
  const root = temp(t), source = path.join(root, 'source'), retained = path.join(root, 'retained'); fs.mkdirSync(source);
  put(source, COPYRIGHT_NAME, COPYRIGHT, 0o777); put(source, SCHEMA_NAME, SCHEMA_XML, 0o777);
  put(source, p.APPRUN_WRAPPED, APPRUN_BYTES, 0o770); put(source, 'usr/lib/data', 'same ordinary data', 0o644);
  fs.chmodSync(path.join(source, p.SCHEMA_DIRECTORY), 0o777);
  fs.symlinkSync('usr/lib/data', path.join(source, '.DirIcon'));
  const expected = p.inventory(source, true);
  const stamps = new Map(['', ...Object.keys(expected.entries)].map(name => [name, fs.lstatSync(path.join(source, name))]));
  assert.deepEqual(p.retainOriginalAppDir(source, retained, expected), expected);
  assert.deepEqual(p.inventory(source, true), expected); assert.deepEqual(p.inventory(retained, true), expected);
  assert.equal(fs.lstatSync(path.join(retained, p.SCHEMA_DIRECTORY)).mode & 0o7777, 0o777);
  assert.equal(fs.lstatSync(path.join(retained, COPYRIGHT_NAME)).mode & 0o7777, 0o777);
  assert.equal(fs.lstatSync(path.join(retained, p.APPRUN_WRAPPED)).mode & 0o7777, 0o770);
  assert.equal(fs.readlinkSync(path.join(retained, '.DirIcon')), 'usr/lib/data');
  for (const [name, before] of stamps) for (const field of ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeMs', 'ctimeMs'])
    assert.equal(fs.lstatSync(path.join(source, name))[field], before[field], `Source changed: ${name} ${field}`);
  const normalized = p.flatten(source, path.join(root, 'transport')).flattened;
  assert.equal(normalized.entries[p.SCHEMA_DIRECTORY].mode, 0o755);
  assert.equal(normalized.entries[SCHEMA_NAME].mode, 0o644);
  assert.equal(normalized.entries[p.APPRUN_WRAPPED].mode, 0o755);
  assert.deepEqual(p.inventory(source, true), expected); assert.deepEqual(p.inventory(retained, true), expected);
  assert.throws(() => p.retainOriginalAppDir(source, retained, expected), /already exists/);
  const redirected = path.join(root, 'redirected'); fs.symlinkSync('missing', redirected);
  assert.throws(() => p.retainOriginalAppDir(source, redirected, expected), /already exists/);
  assert.equal(fs.readlinkSync(redirected), 'missing'); assert.equal(fs.existsSync(path.join(root, 'missing')), false);
});
test('actual Unix normalization preserves original data/modes/inodes and hashes while canonical TAR is strict', async t => {
  if (process.platform === 'win32') return t.skip('Real source 0777, copied 0644 and schema directory modes require Unix');
  const root = temp(t), tree = path.join(root, 'source'), out = path.join(root, 'transport'); fs.mkdirSync(tree);
  put(tree, COPYRIGHT_NAME, COPYRIGHT, 0o777); put(tree, SCHEMA_NAME, SCHEMA_XML, 0o777);
  fs.chmodSync(path.join(tree, p.SCHEMA_DIRECTORY), 0o777);
  const before = p.inventory(tree, true), evidence = p.metadataEvidence(tree);
  assert.throws(() => p.inventory(tree), /writable/);
  const copied = p.flatten(tree, out);
  assert.deepEqual(p.inventory(tree, true), before); assert.deepEqual(p.metadataEvidence(tree), evidence);
  for (const [name, bytes] of [[COPYRIGHT_NAME, COPYRIGHT], [SCHEMA_NAME, SCHEMA_XML]]) {
    assert.equal(before.entries[name].mode, 0o777); assert.equal(copied.flattened.entries[name].mode, 0o644);
    assert.deepEqual(fs.readFileSync(path.join(out, name)), bytes);
    assert.deepEqual(p.record(bytes), { size: copied.flattened.entries[name].size, sha256: copied.flattened.entries[name].sha256 });
  }
  assert.equal(fs.statSync(path.join(tree, p.SCHEMA_DIRECTORY)).mode & 0o777, 0o777);
  assert.equal(fs.statSync(path.join(out, p.SCHEMA_DIRECTORY)).mode & 0o777, 0o755);
  p.validateInventory(copied.flattened);
  const tar = path.join(root, 'data.tar.gz'), binding = await p.packTar(out, tar, copied.flattened);
  execFileSync(PYTHON, ['-B', '-c', VERIFY_TAR, tar], { input: JSON.stringify({ archive: binding, entries: copied.flattened.entries }) });
  fs.chmodSync(path.join(out, COPYRIGHT_NAME), 0o777); assert.throws(() => p.inventory(out), /writable/);
});
test('actual Unix metadata aliases, hardlinks, special files, privilege bits and writable runtime refuse', t => {
  if (process.platform === 'win32') return t.skip('Requires real Unix symlinks, FIFO and mode semantics');
  const root = temp(t), file = put(root, SCHEMA_NAME, SCHEMA_XML, 0o777);
  fs.chmodSync(file, 0o4777); assert.throws(() => p.inventory(root, true), /Privileged/); fs.unlinkSync(file);
  put(root, 'target', SCHEMA_XML); fs.symlinkSync('../../../target', file);
  assert.throws(() => p.inventory(root, true), /aliases/); fs.unlinkSync(file);
  fs.linkSync(path.join(root, 'target'), file); assert.throws(() => p.inventory(root, true), /single-link/); fs.unlinkSync(file);
  execFileSync('mkfifo', [file]); assert.throws(() => p.inventory(root, true), /single-link/); fs.unlinkSync(file);
  put(root, SCHEMA_NAME, SCHEMA_XML, 0o777);
  fs.symlinkSync(SCHEMA_NAME, path.join(root, 'alias')); assert.throws(() => p.inventory(root, true), /aliased/); fs.unlinkSync(path.join(root, 'alias'));
  const runtime = put(root, 'usr/lib/runtime.so', elf());
  for (const mode of [0o666, 0o664, 0o777, 0o775]) { fs.chmodSync(runtime, mode); assert.throws(() => p.inventory(root, true), /writable/); }
  fs.chmodSync(runtime, 0o644);
  put(root, 'usr/share/doc/unreviewed/copyright', COPYRIGHT, 0o777); assert.throws(() => p.inventory(root, true), /Unreviewed copyright/);
});
test('metadata evidence is bounded fixed-path stats/hash only and rejects oversize/redirected probes before reading', t => {
  const root = temp(t), file = put(root, SCHEMA_NAME, SCHEMA_XML), original = fs.readFileSync(file);
  assert.throws(() => p.metadataRead(file, { ...fs.lstatSync(file), nlink: 2 }), /changed before opening/);
  const evidence = p.metadataEvidence(root);
  assert.deepEqual(Object.keys(evidence), p.METADATA_PROBES); assert.ok(Buffer.byteLength(JSON.stringify(evidence)) <= 8192);
  assert.equal(evidence[SCHEMA_NAME].sha256, p.record(SCHEMA_XML).sha256);
  assert.equal(evidence[SCHEMA_NAME].ino, fs.statSync(file).ino); assert.equal(evidence[SCHEMA_NAME].mode, fs.statSync(file).mode & 0o7777);
  assert.doesNotMatch(JSON.stringify(evidence), /<schema|High contrast/); assert.deepEqual(fs.readFileSync(file), original);
  fs.truncateSync(file, p.DATA_LIMIT + 1); assert.throws(() => p.metadataRead(file), /Bounded/);
  assert.match(p.metadataEvidence(root)[SCHEMA_NAME].refused, /Bounded/);
  const source = fs.readFileSync(path.join(__dirname, 'linux-016-portable-package.cjs'), 'utf8');
  assert.match(source, /packagingProcessUmask: process\.umask\(\)/);
  assert.match(source, /compiledSchemaModeCause: 'unknown;/);
  assert.ok(source.indexOf('hostBeforeBundle: metadataEvidence') < source.indexOf('run(process.execPath, bundleArgs('));
  assert.ok(source.indexOf('compiledSchemaFormat = validateCompiledSchema') < source.indexOf('transformation = flatten('));
  assert.ok(source.indexOf('originalAfterCopy: metadataEvidence') < source.indexOf('const tarBinding = await packTar('));
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
  assert.match(text, /if \(error\.inventoryEvidence\) console\.error\(JSON\.stringify\(error\.inventoryEvidence\)\)/);
  const refusal = workflow().jobs.package.steps.find(step => step.if === 'failure()' && step.uses === 'actions/upload-artifact@v4');
  assert.equal(refusal.with['compression-level'], 0);
  assert.ok(refusal.with.path.includes('${{ runner.temp }}/linux-016-portable-output/Creator Hub_0.1.16_amd64.AppImage'));
});
test('flatten preserves originals, expands only internal file links and normalizes only the copy modes', t => {
  if (process.platform === 'win32') return t.skip('Unix symlink and mode evidence belongs to the Linux workflow');
  const root = temp(t), tree = path.join(root, 'AppDir'); fs.mkdirSync(tree, { mode: 0o755 });
  put(tree, 'usr/bin/creator-hub', elf(), 0o755); put(tree, 'usr/lib/a.so.1', 'library', 0o644);
  put(tree, 'AppRun', '#!/bin/sh\n', 0o750); fs.symlinkSync('a.so.1', path.join(tree, 'usr/lib/a.so'));
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
test('the hash-bound ICU readelf table has a valid dynamic section with no DT_NEEDED', () => {
  // ICU 70 data DSO from retained run 39341933523, inspected without execution.
  const text = `Dynamic section at offset 0x1c1d268 contains 18 entries:
  Tag                Type        Name/Value
  0x000000000000001d (RUNPATH)   Library runpath: [$ORIGIN]
  0x000000000000000e (SONAME)    Library soname: [libicudata.so.70]
  0x0000000000000010 (SYMBOLIC)  0x0
  0x000000000000000c (INIT)      0x1000
  0x000000000000000d (FINI)      0x11a4
  0x000000006ffffef5 (GNU_HASH)  0x2b8
  0x0000000000000005 (STRTAB)    0x1c1e3c8
  0x0000000000000006 (SYMTAB)    0x2e0
  0x000000000000000a (STRSZ)     122 (bytes)
  0x000000000000000b (SYMENT)    24 (bytes)
  0x0000000000000003 (PLTGOT)    0x1c1cfc8
  0x0000000000000007 (RELA)      0x3e8
  0x0000000000000008 (RELASZ)    120 (bytes)
  0x0000000000000009 (RELAENT)   24 (bytes)
  0x000000000000001e (FLAGS)     SYMBOLIC BIND_NOW
  0x000000006ffffffb (FLAGS_1)   NOW
  0x000000006ffffff9 (RELACOUNT) 1
  0x0000000000000000 (NULL)      0x0
`;
  assert.deepEqual(p.dynamicDependencies(text), []);
  assert.deepEqual(p.dynamicDependencies(dynamicTable()), []);
  assert.deepEqual(p.dynamicDependencies(text.replaceAll('\n', '\r\n')), []);
});
test('dynamic dependency parsing preserves order and the full 128-entry bound', () => {
  const needed = Array.from({ length: 128 }, (_, i) => `libfixture${i}.so.1`);
  assert.deepEqual(p.dynamicDependencies(dynamicTable(needed)), needed);
  assert.throws(() => p.dynamicDependencies(dynamicTable([...needed, 'liboverflow.so.1'])), /count exceeds bound/);
});
test('empty, absent or unbounded dynamic output cannot stand in for an empty dependency set', () => {
  for (const text of ['', ' \r\n', 'There is no dynamic section in this file.\n',
    'Dynamic section at offset 0x1000 contains 0 entries:\n  Tag Type Name/Value\n',
    ' (NEEDED) Shared library: [libc.so.6]\n',
    `readelf: failed to read section\n${dynamicTable()}`, dynamicTable() + dynamicTable()]) {
    assert.throws(() => p.dynamicDependencies(text), /dynamic section/);
  }
  assert.throws(() => p.dynamicDependencies(' '.repeat(256 * 1024 + 1)), /Bounded/);
});
test('truncated and malformed dynamic tables refuse instead of silently returning no dependencies', () => {
  const valid = dynamicTable(['libc.so.6']);
  for (const text of [
    valid.replace('contains 2', 'contains 3'),
    valid.replace('  Tag                Type        Name/Value\n', ''),
    valid.replace('0x0000000000000000 (NULL) 0x0', '0x0000000000000002 (PLTRELSZ) 0 (bytes)'),
    valid.replace('(NEEDED) Shared library: [libc.so.6]', '(NEEDED) invalid library'),
    valid.replace('(NEEDED)', '(NULL)'), valid.replace('(NULL)', '(NEEDED)'),
    valid.replace('0x0000000000000001', '0x0000000000000002'),
    valid.replace('0x0000000000000000', 'not-a-tag'),
    dynamicTable().replace('contains 1 entry:', 'contains 2 entries:') + '  0x0000000000000002 (PLTRELSZ) 0 (bytes)\n',
  ]) assert.throws(() => p.dynamicDependencies(text));
});
test('actual packaged WebKit/JSC processes and injected library must be x64 ELF, not filenames alone', t => {
  const root = temp(t), names = ['usr/lib/libwebkit2gtk-4.1.so.0', 'usr/lib/libjavascriptcoregtk-4.1.so.0',
    'usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess', 'usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitNetworkProcess',
    'usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so'];
  const entries = Object.fromEntries(names.map(n => { put(root, n, elf()); return [n, { kind: 'file', ...p.record(elf()), mode: 0o644 }]; }));
  const run = (command, args) => { assert.equal(command, '/usr/bin/readelf'); assert.equal(args[0], '--dynamic'); return dynamicTable(['libc.so.6']); };
  const verified = p.dependencies(root, entries, run);
  assert.equal(Object.keys(verified.primary).length, 5); assert.equal(Object.keys(verified.closure).length, 5);
  assert.deepEqual(verified.hostBaseline, ['libc.so.6']);
  assert.throws(() => p.dependencies(root, Object.fromEntries(Object.entries(entries).slice(1)), run), /Missing/);
  assert.throws(() => p.dependencies(root, entries, () => dynamicTable(['libmissing.so.9'])), /Missing packaged subprocess dependency/);
  assert.throws(() => p.dependencies(root, entries, () => dynamicTable(['../libforeign.so.1'])), /Path-bearing/);
  const extra = 'usr/lib/libextra.so.1'; put(root, extra, elf()); entries[extra] = { kind: 'file', ...p.record(elf()), mode: 0o644 };
  const transitive = p.dependencies(root, entries, (cmd, args) => args[1].endsWith('libextra.so.1') ? run(cmd, args) : dynamicTable(['libextra.so.1']));
  assert.ok(transitive.closure[extra]);
  const data = 'usr/lib/libicudata.so.70'; put(root, data, elf()); entries[data] = { kind: 'file', ...p.record(elf()), mode: 0o644 };
  const emptyLeaf = p.dependencies(root, entries, (cmd, args) => args[1].endsWith('libicudata.so.70') ? dynamicTable() : dynamicTable(['libicudata.so.70']));
  assert.deepEqual(emptyLeaf.closure[data].needed, []); assert.deepEqual(emptyLeaf.closure[data].resolution, {});
  assert.equal(emptyLeaf.closure[data].sha256, entries[data].sha256);
  assert.equal(emptyLeaf.closure[data].dynamicSha256, p.record(Buffer.from(dynamicTable())).sha256);
  for (const output of ['', 'There is no dynamic section in this file.\n', dynamicTable().replace('(NULL)', '(BROKEN)')]) {
    assert.throws(() => p.dependencies(root, entries, () => output));
  }
  const commandError = Object.assign(Error('readelf exited unsuccessfully'), { status: 1, stdout: dynamicTable() }); let calls = 0;
  assert.throws(() => p.dependencies(root, entries, () => { calls++; throw commandError; }), error => error === commandError);
  assert.equal(calls, 1, 'Failed inspection must not be retried or adopt partial stdout');
  const changed = Buffer.from(elf()); changed[30] = 1; fs.writeFileSync(path.join(root, names[0]), changed);
  assert.throws(() => p.dependencies(root, entries, () => assert.fail('Changed bytes reached readelf')));
  fs.writeFileSync(path.join(root, names[0]), 'not ELF'); assert.throws(() => p.dependencies(root, entries, run), /ELF/);
});
test('new portable analysis includes Root and whole-closure ABI needs, not available version definitions', t => {
  const root = temp(t), names = ['usr/bin/creator-hub', 'usr/lib/libwebkit2gtk-4.1.so.0', 'usr/lib/libjavascriptcoregtk-4.1.so.0',
    'usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess', 'usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitNetworkProcess',
    'usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/injected-bundle/libwebkit2gtkinjectedbundle.so'];
  const entries = Object.fromEntries(names.map(n => { put(root, n, elf()); return [n, { kind: 'file', ...p.record(elf()), mode: 0o755 }]; }));
  const dynamic = (command, args) => { assert.equal(command, '/usr/bin/readelf'); assert.equal(args[0], '--dynamic'); return dynamicTable(['libc.so.6'], 1); };
  const dependencies = p.dependencies(root, entries, dynamic, { includeHub: true });
  assert.deepEqual(dependencies.primary.hub, ['usr/bin/creator-hub']);
  assert.throws(() => p.dependencies(root, entries, (command, args) => args[1].endsWith('creator-hub')
    ? dynamicTable(['libmissing-hub.so.1']) : dynamic(command, args), { includeHub: true }), /creator-hub -> libmissing-hub/);
  const versionText = "Version definition section '.gnu.version_d' contains 1 entry:\n  Name: GLIBCXX_3.4.99 Flags: none Version: 1\n"
    + versionTable({ 'libc.so.6': ['GLIBC_2.34'] });
  const abi = p.closureAbiRequirements(root, dependencies, (command, args, options) => {
    assert.equal(command, '/usr/bin/readelf'); assert.equal(args[0], '--version-info');
    assert.equal(options.maxBuffer, 4 * 1024 * 1024); return versionText;
  });
  assert.equal(Object.keys(abi.files).length, 6);
  for (const file of Object.values(abi.files)) {
    assert.deepEqual(file.requirementsByProvider, { 'libc.so.6': { required: ['GLIBC_2.34'], weak: [] } });
    assert.equal(file.executableSha256, p.record(elf()).sha256);
  }
  assert.match(abi.scope, /host ABI availability.*unaccepted/);
  const tls = 'usr/lib/x86_64-linux-gnu/gio/modules/libgiognutls.so';
  put(root, tls, elf()); entries[tls] = { kind: 'file', ...p.record(elf()), mode: 0o644 };
  const withGio = p.dependencies(root, entries, dynamic, { includeHub: true });
  assert.deepEqual(withGio.primary.gioTls, [tls]);
  assert.ok(withGio.closure[tls]);
  assert.throws(() => p.dependencies(root, entries, (command, args) => args[1].endsWith('libgiognutls.so')
    ? dynamicTable(['libmissing-tls.so.1']) : dynamic(command, args), { includeHub: true }), /libgiognutls.so -> libmissing-tls/);
  const gioAbi = p.closureAbiRequirements(root, withGio, () => versionText);
  assert.equal(Object.keys(gioAbi.files).length, 7);
  assert.deepEqual(gioAbi.files[tls].requirementsByProvider['libc.so.6'].required, ['GLIBC_2.34']);
  assert.deepEqual(gioAbi.providers['libc.so.6'].requiredSymbolVersions, ['GLIBC_2.34']);
  for (const field of ['targetAbiVerified', 'undefinedSymbolsVerified', 'nativeExecutionVerified', 'releaseReady']) assert.equal(gioAbi[field], false);
});
test('host exclusions carry byte-pinned offline upstream source and the exact recorded packaging tool, not target acceptance', () => {
  const source = zlib.inflateRawSync(Buffer.from('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', 'base64'), { maxOutputLength: 11454 });
  assert.deepEqual(p.record(source), { size: p.HOST_EXCLUSIONS.source.size, sha256: p.HOST_EXCLUSIONS.source.sha256 });
  assert.equal(p.HOST_EXCLUSIONS.source.sha256, '154aab55b8185116806488fe6ce14701de875d2e00dc11716613bf3c2e126265');
  assert.match(p.HOST_EXCLUSIONS.source.url, /199fc9f768b35ad6166109299e5cf3832adeb5d5\/excludelist$/);
  const names = new Set(source.toString('utf8').split(/\r?\n/).map(line => line.replace(/#.*/, '').trim()).filter(Boolean));
  for (const name of p.HOST_EXCLUSIONS.sonames) assert.ok(names.has(name), `Missing exact upstream exclusion: ${name}`);
  const tools = { 'linuxdeploy-x86_64.AppImage': { ...p.HOST_EXCLUSIONS.tool } };
  assert.equal(p.hostBaselineEvidence(tools), p.HOST_EXCLUSIONS);
  assert.match(p.HOST_EXCLUSIONS.scope, /compiled list is not attested/); assert.match(p.HOST_EXCLUSIONS.scope, /No target ABI or runtime acceptance/);
  for (const value of [p.HOST_BASELINE, p.HOST_EXCLUSIONS, p.HOST_EXCLUSIONS.source, p.HOST_EXCLUSIONS.tool, p.HOST_EXCLUSIONS.sonames]) assert.ok(Object.isFrozen(value));
  assert.throws(() => p.hostBaselineEvidence({}), /Unreviewed/);
  tools['linuxdeploy-x86_64.AppImage'].sha256 = '0'.repeat(64); assert.throws(() => p.hostBaselineEvidence(tools), /Unreviewed/);
});
test('the exact additional host SONAMEs classify prerequisites only and unknown or conflicting providers still refuse', t => {
  const { root, entries } = dependencyFiles(t), needed = [...p.HOST_EXCLUSIONS.sonames];
  const evidence = p.dependencies(root, entries, () => dynamicTable(needed), { includeHub: true });
  assert.deepEqual(evidence.hostBaseline, [...needed].sort());
  for (const item of Object.values(evidence.closure)) for (const name of needed) {
    assert.deepEqual(item.resolution[name], { kind: 'required-host-ABI-not-bundled' });
  }
  assert.equal(p.HOST_EXCLUSIONS.sonames.length, 18); assert.equal(new Set(p.HOST_BASELINE).size, 26);
  assert.equal(evidence.hostBaselineSource, p.HOST_EXCLUSIONS); assert.match(evidence.scope, /native execution unaccepted/);
  for (const name of ['libstdc++.so.7', 'libgcc_other.so.1', '/usr/lib/libz.so.1', '../libz.so.1', 'libz.so.1/other']) {
    assert.throws(() => p.dependencies(root, entries, () => dynamicTable([name])));
  }
  const a = 'usr/lib/libz.so.1', b = 'usr/lib/other/libz.so.1';
  put(root, a, elf()); entries[a] = { kind: 'file', ...p.record(elf()), mode: 0o644 };
  const changed = Buffer.from(elf()); changed[30] = 1; put(root, b, changed); entries[b] = { kind: 'file', ...p.record(changed), mode: 0o644 };
  assert.throws(() => p.dependencies(root, entries, () => dynamicTable(['libz.so.1'])), /Ambiguous bundled dependency/);
  fs.writeFileSync(path.join(root, b), elf()); entries[b] = { ...entries[a] };
  const aliases = p.dependencies(root, entries, (cmd, args) => [a, b].some(n => args[1].endsWith(n.split('/').join(path.sep))) ? dynamicTable() : dynamicTable(['libz.so.1']));
  assert.deepEqual(aliases.closure['usr/lib/libwebkit2gtk-4.1.so.0'].resolution['libz.so.1'].paths, [a, b]);
  assert.equal(aliases.hostBaseline.includes('libz.so.1'), false, 'Bundled exact-byte aliases are not mislabeled host providers');
});
test('whole-closure versions preserve lower transitive tags by exact provider and do not invent unversioned ABI acceptance', t => {
  const extra = 'usr/lib/libfixture-transitive.so.1', empty = 'usr/lib/libicudata.so.70';
  const { root, entries } = dependencyFiles(t, [extra, empty]);
  const evidence = p.dependencies(root, entries, (cmd, args) => args[1].endsWith('libfixture-transitive.so.1')
    ? dynamicTable(['libgcc_s.so.1', 'libgpg-error.so.0', 'libz.so.1', 'libharfbuzz.so.0', 'libicudata.so.70'], 3)
    : args[1].endsWith('libicudata.so.70') ? dynamicTable() : dynamicTable(['libfixture-transitive.so.1', 'libgcc_s.so.1'], 1), { includeHub: true });
  const transitive = versionTable({ 'libgcc_s.so.1': ['GCC_3.3.1'], 'libgpg-error.so.0': ['GPG_ERROR_1.0'], 'libz.so.1': ['ZLIB_1.2.9'] });
  const abi = p.closureAbiRequirements(root, evidence, (cmd, args) => args[1].endsWith('libfixture-transitive.so.1')
    ? transitive : args[1].endsWith('libicudata.so.70') ? '' : versionTable({ 'libgcc_s.so.1': ['GCC_7.0.0'] }));
  assert.equal(Object.keys(abi.files).length, 8);
  assert.deepEqual(abi.providers['libgcc_s.so.1'].requiredSymbolVersions, ['GCC_3.3.1', 'GCC_7.0.0']);
  assert.deepEqual(abi.providers['libgpg-error.so.0'].requiredSymbolVersions, ['GPG_ERROR_1.0']);
  assert.deepEqual(abi.providers['libz.so.1'].requiredSymbolVersions, ['ZLIB_1.2.9']);
  assert.deepEqual(abi.files[extra].unversionedDependencies, ['libharfbuzz.so.0', 'libicudata.so.70']);
  assert.deepEqual(abi.files[empty].requirementsByProvider, {});
  assert.deepEqual(abi.providers['libharfbuzz.so.0'].requiredSymbolVersions, []);
  assert.equal(abi.targetAbiVerified, false); assert.equal(abi.undefinedSymbolsVerified, false);
});
test('version requirement parsing binds exact provider/count/index and refuses malformed or truncated evidence', () => {
  const info = p.dynamicTableEvidence(dynamicTable(['libgcc_s.so.1'], 1)), valid = versionTable({ 'libgcc_s.so.1': ['GCC_3.0', 'GCC_7.0.0'] });
  assert.deepEqual(p.versionRequirements(valid, info), { 'libgcc_s.so.1': { required: ['GCC_3.0', 'GCC_7.0.0'], weak: [] } });
  assert.deepEqual(p.versionRequirements(valid.replace('Name: GCC_3.0 Flags: none', 'Name: GCC_3.0 Flags: WEAK'), info),
    { 'libgcc_s.so.1': { required: ['GCC_7.0.0'], weak: ['GCC_3.0'] } });
  for (const text of ['', 'No version information found in this file.\n', valid + valid,
    valid.replace('contains 1 entry:', 'contains 2 entries:'), valid.replace('Cnt: 2', 'Cnt: 3'),
    valid.replace('File: libgcc_s.so.1', 'File: libunknown.so.1'), valid.replace('File: libgcc_s.so.1', 'File: ../libgcc_s.so.1'),
    valid.replace('Addr:', 'Missing:'), valid.replace('Name: GCC_7.0.0', 'INVALID: GCC_7.0.0'),
    valid.replace('Version: 3', 'Version: 2'), valid.replace('GCC_7.0.0', 'GCC_3.0'),
    valid.replace('Flags: none', 'Flags: UNKNOWN'), valid.replace('Version: 3', 'Version: 32768'),
    valid.replace(/.*Name: GCC_7.0.0.*\n/, ''), 'x\n' + valid]) assert.throws(() => p.versionRequirements(text, info));
  assert.throws(() => p.versionRequirements('x'.repeat(4 * 1024 * 1024 + 1), info), /Bounded/);
  const two = p.dynamicTableEvidence(dynamicTable(['libgcc_s.so.1', 'libz.so.1'], 2));
  assert.throws(() => p.versionRequirements(versionTable({ 'libgcc_s.so.1': ['GCC_3.0'], 'libz.so.1': ['ZLIB_1.2.0'] })
    .replace('File: libz.so.1', 'File: libgcc_s.so.1'), two), /Duplicate version provider/);
  assert.throws(() => p.versionRequirements(versionTable({ 'libgcc_s.so.1': Array.from({ length: 257 }, (_, i) => `GCC_FIXTURE_${i}`) }), info), /count exceeds bound/);
  const noVersion = p.dynamicTableEvidence(dynamicTable());
  assert.deepEqual(p.versionRequirements('', noVersion), {});
  assert.deepEqual(p.versionRequirements('No version information found in this file.\n', noVersion), {});
  assert.throws(() => p.versionRequirements('readelf failed', noVersion));
  assert.throws(() => p.versionRequirements("Version definition section '.gnu.version_d' contains 1 entry:\n Name: AVAILABLE_ONLY\n", noVersion), /lack declared/);
  for (const text of [dynamicTable([], 1).replace(' (VERNEED)', ' (BROKEN)'),
    dynamicTable([], 1).replace('VERNEEDNUM) 1', 'VERNEEDNUM) 0'),
    dynamicTable([], 1).replace(' (VERNEED)', ' (VERNEEDNUM)')]) assert.throws(() => p.dynamicTableEvidence(text));
});
test('whole-closure ABI refuses failed inspectors and changes to the hash-bound ELF', t => {
  const { root, entries } = dependencyFiles(t);
  const evidence = p.dependencies(root, entries, () => dynamicTable(['libc.so.6'], 1), { includeHub: true });
  const failed = Object.assign(Error('inspector failed'), { status: 1, stdout: versionTable({ 'libc.so.6': ['GLIBC_2.34'] }) }); let calls = 0;
  assert.throws(() => p.closureAbiRequirements(root, evidence, () => { calls++; throw failed; }), error => error === failed); assert.equal(calls, 1);
  assert.throws(() => p.closureAbiRequirements(root, evidence, () => ''), /Missing declared/);
  assert.throws(() => p.closureAbiRequirements(root, evidence, (cmd, args) => {
    fs.writeFileSync(args[1], 'changed during inspection'); return versionTable({ 'libc.so.6': ['GLIBC_2.34'] });
  }));
});
test('packaging wires pinned source provenance and whole-closure analysis before unsigned TAR creation', () => {
  const source = fs.readFileSync(path.join(__dirname, 'linux-016-portable-package.cjs'), 'utf8');
  const provenance = source.indexOf('receipt.hostBaselineSource = hostBaselineEvidence(receipt.upstreamPackagingTools)');
  const dependencies = source.indexOf('receipt.dependencies = dependencies(transport, finalInventory.entries, run, { includeHub: true,');
  const abi = source.indexOf('receipt.closureAbi = closureAbiRequirements(transport, receipt.dependencies, run)');
  const tar = source.indexOf('const tarBinding = await packTar(transport, tar, finalInventory)');
  assert.ok(provenance > 0 && dependencies > provenance && abi > dependencies && tar > abi);
  assert.equal(source.includes('receipt.primaryAbi ='), false);
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
