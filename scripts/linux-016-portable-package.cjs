// Unsigned CI sidecar only. Never compiles Root, signs, installs or launches Hub.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { once } = require('node:events');
// Keep module import and preflight standard-library-only. Shared verifiers load after npm ci.
const REPO = 'BOBWORKS-XR/CREATOR-HUB', REPO_ID = 1364807512;
const WORKFLOW = '.github/workflows/linux-016-portable-package.yml';
const BRANCH = 'refs/heads/validation/linux-016-portable-package';
const ASSEMBLY_WORKFLOW = '.github/workflows/unix-managed-assembly.yml';
const ASSEMBLY_BRANCH = 'validation/linux-integrated-candidate-016';
const VERSION = '0.1.16', TARGET = 'x86_64-unknown-linux-gnu';
const FEATURES = ['integrated-features', 'experimental-flatpak-host', 'experimental-linux-migration', 'experimental-linux-portable-host'];
const HOST_PROFILE = 'creator-hub-portable-host.json';
const LIMITS = Object.freeze({ manifest: 2 * 1024 * 1024, archive: 256 * 1024 * 1024,
  file: 256 * 1024 * 1024, total: 512 * 1024 * 1024, entries: 8192, zip: 768 * 1024 * 1024 });
const INPUTS = ['creator-hub', 'modules.tar.gz', 'builtin-manifest.json', 'signed-unix-assembly.json', 'unix-package-integrity.json'];
const RECEIPTS = [...INPUTS.filter(n => n.endsWith('.json')), 'linux-byte-receipts.json', 'direct-features-candidate.json'];
function mainAllowed() {
  const finite = require('./flatpak-package.cjs');
  return [...INPUTS, 'builtin-manifest.pre-wrapper.json', 'builtin-manifest.preparation.json',
    `native-packages/Creator Hub_${VERSION}_amd64.deb`, ...[...finite.MEMBERS, ...finite.ROUTING].map(n => `modules/${n}`)];
}
const RECEIPT_ALLOWED = [...RECEIPTS, 'linux-retirement-candidate.json', 'linux-retirement-package-integrity.json'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const record = bytes => ({ size: bytes.length, sha256: hash(bytes) });
const flags = () => Object.fromEntries(['nativeLinuxAccepted', 'steamOSAccepted', 'directPagesAccepted',
  'migrationAccepted', 'retirementAccepted', 'flatpakAccepted', 'signedUpdateAccepted', 'portableUpdateAccepted',
  'restartAccepted', 'releaseReady'].map(n => [n, false]));
function keys(value, names) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Object required');
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), 'Contract fields differ');
}
function id(value) { assert.ok(Number.isSafeInteger(value) && value > 0, 'Positive safe API identity required'); }
function sha(value, n = 64) { assert.match(value, new RegExp(`^[a-f0-9]{${n}}$`)); }
function pin(value, limit = LIMITS.file) {
  keys(value, ['size', 'sha256']); sha(value.sha256);
  assert.ok(Number.isSafeInteger(value.size) && value.size > 0 && value.size <= limit, 'Pin exceeds bound');
}
function validatePins(p) {
  keys(p, ['schemaVersion', 'sourceCommit', 'sourceTree', 'runId', 'runAttempt', 'jobId', 'workflowId',
    'artifactId', 'artifact', 'receiptsArtifactId', 'receiptsArtifact', 'handoffSha256', 'files']);
  assert.equal(p.schemaVersion, 1); sha(p.sourceCommit, 40); sha(p.sourceTree, 40); sha(p.handoffSha256);
  for (const n of ['runId', 'runAttempt', 'jobId', 'workflowId', 'artifactId', 'receiptsArtifactId']) id(p[n]);
  assert.notEqual(p.artifactId, p.receiptsArtifactId);
  pin(p.artifact, LIMITS.zip); pin(p.receiptsArtifact, LIMITS.manifest);
  keys(p.files, [...INPUTS, 'linux-byte-receipts.json', 'direct-features-candidate.json']);
  for (const [name, value] of Object.entries(p.files)) pin(value, name.endsWith('.json') ? 128 * 1024 : LIMITS.file);
  pin(p.files['builtin-manifest.json'], 65536);
  return p;
}
function admission(env, platform = process.platform, arch = process.arch) {
  assert.equal(platform, 'linux'); assert.equal(arch, 'x64');
  for (const [n, v] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_ID: String(REPO_ID),
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: BRANCH, GITHUB_WORKFLOW_REF: `${REPO}/${WORKFLOW}@${BRANCH}` })) assert.equal(env[n], v, n);
  sha(env.GITHUB_SHA, 40);
  for (const n of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(env[n] || '', /^[1-9][0-9]*$/);
  assert.ok(!env.FLATPAK_ID && !env.DISPLAY && !env.WAYLAND_DISPLAY, 'Headless disposable host required');
  assert.ok(!Object.keys(env).some(n => /^(LD_|DYLD_|TAURI_|APPLE_|CREATOR_HUB_SIGNING_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|SSL_CERT_|CURL_CA_BUNDLE$|WEBKIT_|APPIMAGE$|APPDIR$|RUSTFLAGS$|CARGO_ENCODED_RUSTFLAGS$|PYTHON)/.test(n)
    || n.toLowerCase().endsWith('proxy')), 'Runtime, trust, compiler and signing overrides refused');
}
function preflight(env = process.env, platform = process.platform, arch = process.arch) {
  admission(env, platform, arch);
  assert.ok(typeof env.ASSEMBLY_PINS === 'string' && typeof env.PRIVATE_INPUT === 'string', 'Both independent JSON inputs required');
  assert.ok(Buffer.byteLength(env.ASSEMBLY_PINS) + Buffer.byteLength(env.PRIVATE_INPUT) <= 60000, 'Dispatch JSON exceeds bounded preflight input');
  const p = validatePins(JSON.parse(env.ASSEMBLY_PINS)), input = JSON.parse(env.PRIVATE_INPUT);
  keys(input, ['expected', 'prepared', 'artifactSize', 'jobId']);
  const e = input.expected; keys(e, ['target', 'version', 'sourceCommit', 'runId', 'runAttempt', 'artifactId', 'zipSha256']);
  assert.equal(e.target, 'linux'); assert.equal(e.version, VERSION); sha(e.sourceCommit, 40); sha(e.zipSha256);
  for (const n of ['runId', 'runAttempt', 'artifactId']) id(e[n]); id(input.jobId);
  pin({ size: input.artifactSize, sha256: e.zipSha256 }, LIMITS.zip);
  // Cheap structural admission only. The unchanged shared validator and original ZIP remain authoritative in fetch/package.
  const m = input.prepared;
  keys(m, ['schemaVersion', 'product', 'hubVersion', 'platform', 'arch', 'rustTarget', 'mcpMode', 'compiledFlags', 'source',
    'files', 'unsigned', 'privateKeyIncluded', 'nativeGuiTested', 'nativeConsentTested', 'releaseReady']);
  assert.equal(m.schemaVersion, 1); assert.equal(m.product, 'com.creatorworks.hub.unix-managed-preparation');
  assert.equal(m.hubVersion, VERSION); assert.equal(m.platform, 'linux'); assert.equal(m.arch, 'x86_64'); assert.equal(m.rustTarget, TARGET);
  assert.equal(m.mcpMode, 'writable'); assert.equal(m.unsigned, true);
  assert.deepEqual(m.compiledFlags, { internalModule: true, experimentalUnixHosting: true, hostWritable: true, readOnlyEvents: true });
  for (const n of ['privateKeyIncluded', 'nativeGuiTested', 'nativeConsentTested', 'releaseReady']) assert.equal(m[n], false);
  const s = m.source; keys(s, ['repository', 'repositoryId', 'workflow', 'event', 'sourceCommit', 'buildCommit', 'sourceTree', 'runId', 'runAttempt']);
  assert.equal(s.repository, REPO); assert.equal(s.repositoryId, REPO_ID); assert.equal(s.workflow, '.github/workflows/unix-managed-payload.yml');
  assert.ok(['push', 'workflow_dispatch'].includes(s.event)); assert.equal(s.sourceCommit, e.sourceCommit); assert.equal(s.buildCommit, e.sourceCommit);
  sha(s.sourceTree, 40); assert.equal(s.runId, e.runId); assert.equal(s.runAttempt, e.runAttempt);
  assert.ok(m.files && typeof m.files === 'object' && !Array.isArray(m.files));
  const files = Object.entries(m.files); assert.ok(files.length > 0 && files.length <= 32); let total = 0;
  for (const [name, f] of files) {
    assert.ok(relative(name)); keys(f, ['size', 'sha256', 'mode']); pin({ size: f.size, sha256: f.sha256 });
    assert.ok([0o644, 0o755].includes(f.mode)); total += f.size;
  }
  assert.ok(total <= LIMITS.total);
  return { pins: p, privateInput: input };
}
function read(file, limit = LIMITS.file) { return require('./flatpak-package.cjs').read(file, limit); }
function exact(file, expected) {
  const bytes = read(file, expected.size); assert.deepEqual(record(bytes), expected, `Input changed: ${path.basename(file)}`); return bytes;
}
function json(file, limit = 128 * 1024) { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read(file, limit))); }
function write(file, value) { fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o644 }); }
function inside(file, root) {
  const finite = require('./flatpak-package.cjs');
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file);
  finite.ordinary(path.dirname(file));
  const rel = path.relative(root, file);
  assert.ok(rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel), 'Fresh owned staging path required');
}
function verifyProducer(p, proof) {
  validatePins(p);
  const { run: r, job: j, workflow: w, commit: c } = proof;
  assert.equal(r.id, p.runId); assert.equal(r.run_attempt, p.runAttempt);
  assert.equal(r.status, 'completed'); assert.equal(r.conclusion, 'success'); assert.equal(r.event, 'workflow_dispatch');
  assert.equal(r.head_sha, p.sourceCommit); assert.equal(r.head_branch, ASSEMBLY_BRANCH);
  assert.equal(r.path, ASSEMBLY_WORKFLOW); assert.equal(r.workflow_id, p.workflowId);
  for (const repo of [r.repository, r.head_repository]) { assert.equal(repo.id, REPO_ID); assert.equal(repo.full_name, REPO); }
  assert.equal(w.id, p.workflowId); assert.equal(w.path, ASSEMBLY_WORKFLOW);
  assert.equal(c.sha, p.sourceCommit); assert.equal(c.tree.sha, p.sourceTree);
  assert.equal(j.id, p.jobId); assert.equal(j.run_id, p.runId); assert.equal(j.run_attempt, p.runAttempt);
  assert.equal(j.head_sha, p.sourceCommit); assert.equal(j.status, 'completed'); assert.equal(j.conclusion, 'success');
  // Matrix suffixes are truncated by GitHub. The pinned job ID and creation interval bind the producer.
  assert.match(j.name, /^assembly \(linux, ubuntu-22\.04,/);
  assert.ok(j.labels.includes('ubuntu-22.04'));
  for (const [item, artifactId, expected, name] of [
    [proof.artifact, p.artifactId, p.artifact, `signed-unix-hub-linux-${p.runId}-${p.runAttempt}`],
    [proof.receiptsArtifact, p.receiptsArtifactId, p.receiptsArtifact, `signed-linux-receipts-${p.runId}-${p.runAttempt}`],
  ]) {
    assert.equal(item.id, artifactId); assert.equal(item.name, name); assert.equal(item.expired, false);
    assert.equal(item.size_in_bytes, expected.size); assert.equal(item.digest, `sha256:${expected.sha256}`);
    for (const [n, v] of Object.entries({ id: p.runId, head_sha: p.sourceCommit, head_branch: ASSEMBLY_BRANCH,
      repository_id: REPO_ID, head_repository_id: REPO_ID })) assert.equal(item.workflow_run[n], v);
    const start = Date.parse(j.started_at), end = Date.parse(j.completed_at), created = Date.parse(item.created_at);
    assert.ok(Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(created) && start <= created && created <= end,
      'Artifact not created within the independently pinned assembly job');
  }
}
function collect(p, privateInput, request) {
  const original = require('./unix-payload-binding.cjs');
  validatePins(p); keys(privateInput, ['expected', 'prepared', 'artifactSize', 'jobId']);
  assert.equal(privateInput.expected.target, 'linux'); assert.equal(privateInput.expected.version, VERSION);
  const e = privateInput.expected;
  keys(e, ['target', 'version', 'sourceCommit', 'runId', 'runAttempt', 'artifactId', 'zipSha256']);
  for (const n of ['runId', 'runAttempt', 'artifactId']) id(e[n]);
  sha(e.sourceCommit, 40); sha(e.zipSha256);
  id(privateInput.jobId); pin({ size: privateInput.artifactSize, sha256: e.zipSha256 }, LIMITS.zip);
  original.validatePrepared(privateInput.prepared, original.TARGETS.linux, VERSION);
  const proof = { run: request(`actions/runs/${p.runId}`), job: request(`actions/jobs/${p.jobId}`),
    workflow: request(`actions/workflows/${p.workflowId}`), commit: request(`git/commits/${p.sourceCommit}`),
    artifact: request(`actions/artifacts/${p.artifactId}`), receiptsArtifact: request(`actions/artifacts/${p.receiptsArtifactId}`) };
  verifyProducer(p, proof);
  const jobs = request(`actions/runs/${e.runId}/attempts/${e.runAttempt}/jobs?per_page=100`);
  assert.ok(jobs.total_count === jobs.jobs.length && jobs.jobs.length <= 20, 'Incomplete original native-job listing');
  const privateProof = { ...privateInput, run: request(`actions/runs/${e.runId}`),
    artifact: request(`actions/artifacts/${e.artifactId}`), commit: request(`git/commits/${e.sourceCommit}`), jobs: jobs.jobs,
    job: request(`actions/jobs/${privateInput.jobId}`) };
  verifyPrivateProof(privateProof);
  return { pins: p, proof, privateProof };
}
function verifyPrivateProof(proof) {
  const original = require('./unix-payload-binding.cjs');
  original.validateBinding(proof); assert.equal(proof.expected.target, 'linux'); assert.equal(proof.expected.version, VERSION);
  id(proof.jobId); pin({ size: proof.artifactSize, sha256: proof.expected.zipSha256 }, LIMITS.zip);
  assert.equal(proof.artifactSize, proof.artifact.size_in_bytes);
  const listed = proof.jobs.filter(j => j.id === proof.jobId); assert.equal(listed.length, 1, 'Independently pinned original job required');
  for (const n of ['id', 'run_id', 'run_attempt', 'name', 'status', 'conclusion', 'head_sha']) assert.equal(proof.job[n], listed[0][n]);
  assert.equal(proof.job.head_sha, proof.expected.sourceCommit);
  assert.equal(proof.job.name, original.TARGETS.linux.job);
}

// ZIP names never become filesystem paths. Only fixed, independently pinned files are written.
const ZIP_STAGE = String.raw`
import hashlib,json,os,stat,sys,zipfile
from pathlib import Path
source,output=map(Path,sys.argv[1:]); config=json.load(sys.stdin)
pins=config['pins']; metadata=config.get('metadata',{}); allowed=set(config['allowed']); dirs=set()
assert not set(pins)&set(metadata)
for name in allowed:
    parts=name.split('/')
    dirs.update('/'.join(parts[:i]) for i in range(1,len(parts)))
with zipfile.ZipFile(source) as z:
    entries=z.infolist(); assert 0<len(entries)<=128 and sum(e.file_size for e in entries)<=768*1024*1024
    names=set(); folded=set()
    for e in entries:
        name=e.filename; clean=name.rstrip('/') if e.is_dir() else name
        assert clean and clean not in names and clean.lower() not in folded
        assert '\\' not in clean and ':' not in clean and not clean.startswith('/') and len(clean)<=240
        assert all(p not in ('','.','..') for p in clean.split('/'))
        mode=e.external_attr>>16; kind=stat.S_IFMT(mode)
        assert kind in (0,stat.S_IFDIR if e.is_dir() else stat.S_IFREG) and not mode&0o7000
        assert not e.flag_bits&1 and e.compress_type in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED)
        assert 0<=e.file_size<=256*1024*1024
        assert clean in (dirs if e.is_dir() else allowed)
        names.add(clean); folded.add(clean.lower())
    assert (set(pins)|set(metadata))<=names
    output.mkdir(mode=0o700)
    for name,pin in pins.items():
        assert '/' not in name and name in allowed
        e=z.getinfo(name); assert not e.is_dir() and e.file_size==pin['size']
        data=z.read(e); assert len(data)==pin['size'] and hashlib.sha256(data).hexdigest()==pin['sha256']
        with (output/name).open('xb') as f: f.write(data)
        os.chmod(output/name,0o755 if name=='creator-hub' else 0o644)
    for name,expected in metadata.items():
        assert name=='prepared-unix.json' and name in allowed
        e=z.getinfo(name); assert not e.is_dir() and 0<e.file_size<=128*1024
        data=z.read(e); parsed=json.loads(data)
        assert data.decode('utf-8').strip()==json.dumps(parsed,indent=2,ensure_ascii=False) and parsed==expected
        with (output/name).open('xb') as f: f.write(data)
        os.chmod(output/name,0o644)
`;
function stageZip(file, output, pins, allowed, run) {
  run('python3', ['-B', '-c', ZIP_STAGE, file, output], { input: JSON.stringify({ pins, allowed }) });
}
function validateReceipts(input, receipts, binding) {
  const finite = require('./flatpak-package.cjs'), archive = require('./module-archive.cjs');
  const { runtimeDescriptor } = require('./mcp-runtime-descriptor.cjs');
  const { pins: p, proof, privateProof } = binding; verifyProducer(p, proof); verifyPrivateProof(privateProof);
  const bytes = Object.fromEntries(INPUTS.map(n => [n, exact(path.join(input, n), p.files[n])]));
  for (const n of RECEIPTS) exact(path.join(receipts, n), p.files[n]);
  const compact = JSON.parse(exact(path.join(receipts, 'linux-byte-receipts.json'), p.files['linux-byte-receipts.json']));
  assert.equal(compact.schemaVersion, 1); assert.equal(compact.sourceCommit, p.sourceCommit);
  assert.equal(compact.runId, p.runId); assert.equal(compact.runAttempt, p.runAttempt); keys(compact.files, INPUTS);
  for (const n of INPUTS) assert.deepEqual(compact.files[n], { bytes: p.files[n].size, sha256: p.files[n].sha256 });
  for (const n of ['nativeGuiAccepted', 'migrationAccepted', 'signedUpdateAccepted', 'releaseReady']) assert.equal(compact[n], false);
  const a = JSON.parse(bytes['signed-unix-assembly.json']);
  assert.equal(a.schemaVersion, 1); assert.equal(a.product, 'com.creatorworks.hub.unix-signed-assembly');
  assert.equal(a.platform, 'linux'); assert.equal(a.arch, 'x86_64'); assert.equal(a.hubVersion, VERSION, 'Assembly receipt must truthfully identify 0.1.16');
  assert.equal(a.assemblyCommit, p.sourceCommit); assert.equal(a.handoffSha256, p.handoffSha256);
  assert.deepEqual(a.privateSource, privateProof.prepared.source);
  // No inference from a workflow name or direct-page scope can prove the exact Cargo features.
  assert.deepEqual(a.compiledFeatures, FEATURES, 'Parent assembly must attest the exact compiledFeatures; scope alone is insufficient');
  require('./build-unified.cjs').validatePortableBuildProof(a.portableHostBuild, p.sourceCommit, FEATURES, p.files['creator-hub'], p.sourceTree);
  for (const n of ['privateModulesRecompiled', 'privateModulesResigned', 'nativeGuiAccepted', 'releaseReady']) assert.equal(a[n], false);
  assert.equal(a.mcpMode, 'writable');
  const direct = JSON.parse(exact(path.join(receipts, 'direct-features-candidate.json'), p.files['direct-features-candidate.json']));
  assert.equal(direct.schemaVersion, 1); assert.equal(direct.scope, 'linux-direct-features-candidate');
  assert.equal(direct.activationRunsOutsideSandbox, true);
  for (const n of ['nativeGuiAccepted', 'migrationAccepted', 'signedUpdateAccepted', 'flatpakActivationAccepted', 'releaseReady']) assert.equal(direct[n], false);
  const m = JSON.parse(bytes['builtin-manifest.json']); finite.validateDescriptor(m); archive.validateBinding(m);
  assert.ok(m.managedRouting, 'Signed managed payload required');
  assert.deepEqual({ size: m.payloadArchive.size, sha256: m.payloadArchive.sha256 }, p.files['modules.tar.gz']);
  for (const [n, digest] of Object.entries(archive.rawFiles(m))) {
    const prepared = privateProof.prepared.files[n === 'routing/creator-hub-mcp-router' ? 'router-for-package' : `modules/${n}`];
    if (n.startsWith('routing/') && n !== 'routing/creator-hub-mcp-router') continue;
    assert.equal(prepared.sha256, digest, 'Original private artifact hash differs');
    assert.equal(prepared.size, m.payloadArchive.files[n].size); assert.equal(prepared.mode, m.payloadArchive.files[n].mode);
  }
  assert.deepEqual(record(Buffer.from(JSON.stringify(runtimeDescriptor(m, VERSION)))),
    (({ size, sha256 }) => ({ size, sha256 }))(privateProof.prepared.files['mcp-runtime.json']));
  const integrity = JSON.parse(bytes['unix-package-integrity.json']);
  assert.equal(integrity.schemaVersion, 1); assert.equal(integrity.platform, 'linux'); assert.equal(integrity.arch, 'x86_64');
  assert.equal(integrity.integrityPassed, true); assert.equal(integrity.experimental, true); assert.equal(integrity.mcpMode, 'writable');
  assert.equal(integrity.writableGuiAccepted, false); assert.equal(integrity.releaseReady, false);
  assert.equal(integrity.packages.length, 1); const deb = integrity.packages[0];
  assert.equal(deb.format, 'deb'); assert.equal(deb.path, `native-packages/Creator Hub_${VERSION}_amd64.deb`);
  sha(deb.sha256); assert.deepEqual(deb.files, archive.rawFiles(m));
  const hub = bytes['creator-hub']; finite.validateElf(hub); assert.ok(hub.includes(bytes['builtin-manifest.json']), 'Root descriptor is not build-bound');
  for (const witness of require('./build-unified.cjs').PORTABLE_ROOT_WITNESSES) {
    assert.ok(hub.includes(Buffer.from(witness)), 'Old Root without portable startup binding cannot receive a host profile');
  }
  const marker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK'), at = hub.indexOf(marker);
  assert.ok(at >= 0 && hub.indexOf(marker, at + 1) === -1, 'Exactly one raw UNK marker required');
  const debHub = Buffer.from(hub); debHub.write('DEB', at + marker.length - 3, 'ascii');
  assert.equal(hash(debHub), deb.hubSha256, 'Root does not bind the parent DEB integrity receipt');
  return { bytes, manifest: m, portableHostBuild: a.portableHostBuild };
}

function hostProfile(rawHub, packagedHub, proof, pins) {
  validatePins(pins);
  const builder = require('./build-unified.cjs');
  builder.validatePortableBuildProof(proof, pins.sourceCommit, FEATURES, record(rawHub), pins.sourceTree);
  for (const witness of builder.PORTABLE_ROOT_WITNESSES) {
    assert.ok(rawHub.includes(Buffer.from(witness)), 'Old Root cannot be relabelled with a portable profile');
  }
  require('./unix-package-payload.cjs').verifyLinuxHub(rawHub, packagedHub, 'appimage');
  return Buffer.from(JSON.stringify({ schemaVersion: 1, version: VERSION,
    activationInterface: 'com.creatorworks.hub.Host1', integratedFeatures: true,
    startupImageBinding: 1, executableSha256: hash(packagedHub) }, null, 2) + '\n');
}
function verifyHostProfileInventory(inv, bytes, executable) {
  validateInventory(inv);
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 4096);
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  assert.deepEqual(bytes, Buffer.from(JSON.stringify(value, null, 2) + '\n'), 'Canonical unambiguous host profile required');
  keys(value, ['schemaVersion', 'version', 'activationInterface', 'integratedFeatures', 'startupImageBinding', 'executableSha256']);
  assert.deepEqual(value, { schemaVersion: 1, version: VERSION, activationInterface: 'com.creatorworks.hub.Host1',
    integratedFeatures: true, startupImageBinding: 1, executableSha256: executable.sha256 });
  assert.deepEqual(inv.entries[HOST_PROFILE], { kind: 'file', ...record(bytes), mode: 0o644 }, 'Host profile must be bound into the complete AppDir inventory');
  assert.deepEqual(inv.entries['usr/bin/creator-hub'], { kind: 'file', ...executable, mode: 0o755 }, 'Profile executable differs from final inventory');
  assert.ok(inv.entries.AppRun?.kind === 'file' && inv.entries.AppRun.mode === 0o755 && inv.entries.AppRun.size > 0, 'Signed executable AppRun is required');
  return value;
}
function attachHostProfile(root, before, bytes, executable) {
  const finite = require('./flatpak-package.cjs'); finite.ordinary(root);
  assert.deepEqual(inventory(root), before, 'Transport changed before profile insertion');
  assert.equal(Object.hasOwn(before.entries, HOST_PROFILE), false, 'Existing host profile cannot be replaced');
  const file = path.join(root, HOST_PROFILE);
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o644 });
  fs.chmodSync(file, 0o644);
  assert.deepEqual(read(file, 4096), bytes);
  const after = inventory(root);
  assert.deepEqual(after, { entries: { ...before.entries, [HOST_PROFILE]: { kind: 'file', ...record(bytes), mode: 0o644 } },
    links: {}, unpackedSize: before.unpackedSize + bytes.length }, 'Only the exact new host profile may be added');
  verifyHostProfileInventory(after, bytes, executable);
  return after;
}

function relative(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 240 && name.split('/').length <= 32
    && /^[\x20-\x7e]+$/.test(name) && !/[\\:]/.test(name) && name.split('/').every(part => {
      const stem = part.split('.')[0].toUpperCase();
      return part && part.length <= 100 && !['.', '..'].includes(part) && !/[. ]$/.test(part)
        && !['CON', 'PRN', 'AUX', 'NUL'].includes(stem) && !/^(COM|LPT)[0-9]$/.test(stem);
    });
}
// Ubuntu's gir1.2-polkit-1.0 ships these two read-only metadata files. The GTK
// deployment plugin maps its typelib directory to AppDir/usr/lib/girepository-1.0.
// https://packages.ubuntu.com/jammy/amd64/gir1.2-polkit-1.0/filelist
const GTK_METADATA_PATHS = new Set(['usr/lib/girepository-1.0/Polkit-1.0.typelib',
  'usr/lib/girepository-1.0/PolkitAgent-1.0.typelib']);
const TYPELIB_MAGIC = Buffer.from('GOBJ\nMETADATA\r\n\x1a', 'binary');
// The retained GTK launcher sets GIO_EXTRA_MODULES to this fixed directory.
// https://docs.gtk.org/gio/struct.IOExtensionPoint.html
const GIO_DIRECTORY = 'usr/lib/x86_64-linux-gnu/gio/modules';
const GIO_TLS = `${GIO_DIRECTORY}/libgiognutls.so`;
const GIO_PATHS = new Set([GIO_DIRECTORY, GIO_TLS]);
function prohibited(name) {
  return /(?:^|\/)(?:modules|polkit-1|dbus-1|systemd|DEBIAN)(?:\/|$)/i.test(name) && !GIO_PATHS.has(name)
    || /creator-hub-deb-retirement-helper|com\.creatorworks\.hub\.Host\.service|com\.creatorworks\.hub\.retire|(?:^|\/)pkexec$|\.policy$/i.test(name)
    || /polkit/i.test(name) && !GTK_METADATA_PATHS.has(name);
}
function validateGioRuntime(name, entry, bytes) {
  if (!GIO_PATHS.has(name)) return;
  if (name === GIO_DIRECTORY) {
    assert.ok(entry.kind === 'directory' && entry.mode === 0o755, 'GIO module directory must be ordinary mode 0755');
    return;
  }
  assert.ok(entry.kind === 'file' && entry.mode === 0o644 && entry.size >= 64,
    'GIO TLS module must be a regular mode 0644 shared library');
  if (bytes !== undefined) {
    require('./flatpak-package.cjs').validateElf(bytes);
    assert.equal(bytes.readUInt16LE(16), 3, 'GIO TLS module must be an ELF shared object');
    assert.deepEqual(record(bytes), { size: entry.size, sha256: entry.sha256 }, 'GIO TLS module changed during inspection');
  }
}
function validateGtkMetadata(name, entry, bytes) {
  if (!GTK_METADATA_PATHS.has(name)) return;
  assert.ok(entry.kind === 'file' && entry.mode === 0o644 && entry.size >= TYPELIB_MAGIC.length,
    'GObject typelib exception requires regular non-executable mode 0644 data');
  if (bytes !== undefined) {
    assert.ok(Buffer.isBuffer(bytes) && bytes.length === entry.size && bytes.subarray(0, TYPELIB_MAGIC.length).equals(TYPELIB_MAGIC),
      'GObject typelib bytes required, not a renamed executable or policy');
    assert.deepEqual(record(bytes), { size: entry.size, sha256: entry.sha256 }, 'GObject typelib changed during inspection');
  }
}
function rejectedEntry(file, name, s, error) {
  const result = { path: name.slice(0, 512), pathTruncated: name.length > 512, reason: String(error.message).slice(0, 512) };
  if (!s) return result;
  result.stat = { kind: s.isSymbolicLink() ? 'symlink' : s.isFile() ? 'file' : s.isDirectory() ? 'directory' : 'special',
    mode: s.mode & 0o7777, size: s.size, nlink: s.nlink, uid: s.uid, gid: s.gid };
  // A bounded diagnostic prefix is not a content hash or permission to load the
  // rejected entry. Never follow a link or read through an unapproved hardlink.
  if (s.isFile() && !s.isSymbolicLink() && s.nlink === 1) {
    let fd;
    try {
      fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const same = actual => ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeMs', 'ctimeMs'].every(n => actual[n] === s[n]);
      assert.ok(same(fs.fstatSync(fd)), 'Rejected entry changed before diagnostic read');
      const prefix = Buffer.alloc(64), count = fs.readSync(fd, prefix, 0, prefix.length, 0), bytes = prefix.subarray(0, count);
      assert.ok(same(fs.fstatSync(fd)), 'Rejected entry changed during diagnostic read');
      result.prefix = { ...record(bytes), hex: bytes.toString('hex'), scope: 'first-at-most-64-bytes-only' };
    } catch (reason) { result.prefixError = String(reason.message).slice(0, 256); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  return result;
}
function retainAppImage(source, destination) {
  const expected = record(read(source, LIMITS.archive));
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  assert.deepEqual(record(read(destination, LIMITS.archive)), expected, 'Retained original AppImage bytes differ');
  return expected;
}
function fileRecord(file) {
  const s = fs.lstatSync(file);
  assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= LIMITS.file, 'Bounded single-link regular file required');
  // finite.read intentionally refuses empty files; ordinary AppDirs can contain empty data files.
  return { kind: 'file', ...(s.size ? record(read(file, LIMITS.file)) : { size: 0, sha256: hash(Buffer.alloc(0)) }), mode: s.mode & 0o7777 };
}
function internalTarget(root, file, seen = new Set()) {
  const finite = require('./flatpak-package.cjs');
  assert.ok(seen.size < 32 && !seen.has(file), 'Symlink cycle/depth refused'); seen.add(file);
  const link = fs.readlinkSync(file);
  assert.ok(link && !path.isAbsolute(link) && !/[\\:\x00-\x1f\x7f-\uffff]/.test(link), 'Only relative internal symlinks may be flattened');
  const next = path.resolve(path.dirname(file), link), rel = path.relative(root, next).split(path.sep).join('/');
  assert.ok(relative(rel) && !prohibited(rel), 'AppDir link escapes or aliases a prohibited path');
  // Never traverse a directory symlink, including an external detour that returns inside.
  finite.ordinary(path.dirname(next));
  return fs.lstatSync(next).isSymbolicLink() ? internalTarget(root, next, seen) : next;
}
function inventory(root, allowLinks = false) {
  const finite = require('./flatpak-package.cjs');
  assert.ok(finite.ordinary(root).isDirectory());
  const entries = {}, links = {}, folded = new Set(); let total = 0;
  function visit(directory, prefix = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const rel = prefix + name, file = path.join(directory, name); let s;
      try {
        s = fs.lstatSync(file);
        assert.ok(relative(rel) && !prohibited(rel) && !folded.has(rel.toLowerCase()), `Noncanonical/prohibited AppDir entry: ${rel}`);
        folded.add(rel.toLowerCase()); assert.ok(folded.size <= LIMITS.entries, `AppDir has at least ${folded.size} entries; bound ${LIMITS.entries}; coordinate with Parent`);
        assert.ok(!(s.mode & 0o7000) && (s.isSymbolicLink() || !(s.mode & 0o002)), 'Privileged/world-writable AppDir mode refused');
        if (GTK_METADATA_PATHS.has(rel)) assert.ok(s.isFile() && !s.isSymbolicLink(), 'GObject typelib exception cannot be a directory or link');
        if (GIO_PATHS.has(rel)) assert.ok(!s.isSymbolicLink(), 'GIO runtime exception cannot be a link');
        if (s.isSymbolicLink()) {
          assert.ok(allowLinks, 'Transport AppDir cannot contain links');
          const link = fs.readlinkSync(file), resolved = internalTarget(root, file);
          const target = path.relative(root, resolved).split(path.sep).join('/');
          // Directory links, loops, external targets and multi-link files are refused, never recursively followed.
          const r = fileRecord(resolved); assert.ok(!(r.mode & 0o7002), 'Unsafe symlink target mode');
          entries[rel] = r; links[rel] = { link, resolved: target, ...r };
        } else if (s.isDirectory()) {
          entries[rel] = { kind: 'directory', mode: s.mode & 0o7777 }; visit(file, `${rel}/`);
        } else entries[rel] = fileRecord(file);
        validateGtkMetadata(rel, entries[rel], GTK_METADATA_PATHS.has(rel) ? read(file) : undefined);
        validateGioRuntime(rel, entries[rel], rel === GIO_TLS ? read(file) : undefined);
        if (entries[rel].kind === 'file') total += entries[rel].size;
        assert.ok(total <= LIMITS.total, `Flattened AppDir has at least ${total} file bytes; bound ${LIMITS.total}; coordinate with Parent`);
        if (!allowLinks) assert.ok(entries[rel].mode === 0o755 || entries[rel].kind === 'file' && entries[rel].mode === 0o644, 'Noncanonical transport mode');
      } catch (error) {
        if (!error.inventoryEvidence) {
          error.inventoryEvidence = { complete: false, visitedEntries: folded.size, observedFileBytes: total,
            rejectedEntry: rejectedEntry(file, rel, s, error) };
          assert.ok(Buffer.byteLength(JSON.stringify(error.inventoryEvidence)) <= 8192, 'Rejected entry diagnostic exceeds bound');
        }
        throw error;
      }
    }
  }
  visit(root); return { entries, links, unpackedSize: total };
}
function flatten(root, destination) {
  const finite = require('./flatpak-package.cjs');
  const before = inventory(root, true); finite.ordinary(path.dirname(destination));
  fs.mkdirSync(destination, { mode: 0o755 }); fs.chmodSync(destination, 0o755);
  for (const [name, entry] of Object.entries(before.entries)) {
    const output = path.join(destination, name), mode = entry.kind === 'directory' || entry.mode & 0o111 ? 0o755 : 0o644;
    if (entry.kind === 'directory') fs.mkdirSync(output, { mode });
    else {
      const source = before.links[name] ? internalTarget(root, path.join(root, name)) : path.join(root, name);
      finite.ordinary(source); fs.copyFileSync(source, output, fs.constants.COPYFILE_EXCL);
    }
    fs.chmodSync(output, mode);
  }
  assert.deepEqual(inventory(root, true), before, 'Original AppDir changed while flattening');
  const after = inventory(destination);
  assert.deepEqual(Object.keys(after.entries), Object.keys(before.entries));
  for (const [n, e] of Object.entries(before.entries)) assert.deepEqual(after.entries[n], { ...e,
    mode: e.kind === 'directory' || e.mode & 0o111 ? 0o755 : 0o644 });
  return { original: before, flattened: after };
}
function dependencies(root, files, run, { includeHub = false } = {}) {
  const finite = require('./flatpak-package.cjs');
  const patterns = { webkit: /(?:^|\/)libwebkit2gtk-4\.1\.so(?:\.\d+)*$/,
    javascriptCore: /(?:^|\/)libjavascriptcoregtk-4\.1\.so(?:\.\d+)*$/,
    webProcess: /\/webkit2gtk-4\.1\/WebKitWebProcess$/, networkProcess: /\/webkit2gtk-4\.1\/WebKitNetworkProcess$/,
    injectedBundle: /\/webkit2gtk-4\.1\/injected-bundle\/libwebkit2gtkinjectedbundle\.so$/ };
  const result = { primary: {}, closure: {}, hostBaseline: [], unresolved: [] }, providers = new Map(), checked = new Map();
  // Explicit ABI prerequisites, not bundled-library or distribution compatibility claims.
  const baseline = new Set(['ld-linux-x86-64.so.2', 'libc.so.6', 'libdl.so.2', 'libm.so.6',
    'libpthread.so.0', 'librt.so.1', 'libresolv.so.2', 'libutil.so.1']);
  for (const [name, entry] of Object.entries(files)) if (entry.kind === 'file' && /\.so(?:\.\d+)*$/.test(name)) {
    const base = path.posix.basename(name); if (!providers.has(base)) providers.set(base, []); providers.get(base).push(name);
  }
  function inspect(name) {
    const entry = files[name]; assert.equal(entry.kind, 'file');
    if (checked.has(name)) return; checked.set(name, true);
    const bytes = read(path.join(root, name)); finite.validateElf(bytes); assert.deepEqual(record(bytes), { size: entry.size, sha256: entry.sha256 });
    const dynamic = String(run('/usr/bin/readelf', ['--dynamic', path.join(root, name)], { maxBuffer: 256 * 1024 }));
    const needed = [...dynamic.matchAll(/\(NEEDED\).*?\[([^\]]+)\]/g)].map(m => m[1]);
    assert.ok(needed.length > 0 && needed.length <= 128, `Missing/bounded dynamic dependency evidence: ${name}`);
    const item = { ...entry, dynamicSha256: hash(Buffer.from(dynamic)), needed, resolution: {} }; result.closure[name] = item;
    for (const library of needed) {
      assert.ok(relative(library) && !library.includes('/'), 'Path-bearing ELF dependency refused');
      const matches = providers.get(library) || [];
      if (matches.length) {
        assert.ok(matches.length <= 16 && new Set(matches.map(n => files[n].sha256)).size === 1, `Ambiguous bundled dependency: ${library}`);
        item.resolution[library] = { kind: 'bundled-static-provider', paths: matches };
        for (const next of matches) inspect(next);
      } else {
        if (baseline.has(library)) {
          item.resolution[library] = { kind: 'required-host-ABI-not-bundled' }; result.hostBaseline.push(library);
        } else {
          item.resolution[library] = { kind: 'missing' }; result.unresolved.push({ from: name, library });
        }
      }
    }
  }
  for (const [kind, pattern] of Object.entries(patterns)) {
    const matches = Object.keys(files).filter(n => pattern.test(n));
    assert.ok(matches.length > 0 && matches.length <= 8, `Missing/ambiguous packaged dependency: ${kind}`);
    result.primary[kind] = matches; for (const n of matches) inspect(n);
  }
  if (includeHub) {
    assert.ok(files['usr/bin/creator-hub']?.kind === 'file', 'Missing fixed Hub executable for dependency inspection');
    result.primary.hub = ['usr/bin/creator-hub']; inspect('usr/bin/creator-hub');
  }
  if (files[GIO_TLS]) {
    result.primary.gioTls = [GIO_TLS]; inspect(GIO_TLS);
  }
  result.hostBaseline = [...new Set(result.hostBaseline)].sort();
  result.scope = 'static ELF dependency closure only; loader search, ABI versions, dlopen/plugins and native execution unaccepted';
  if (result.unresolved.length) {
    const error = Error(`Missing packaged subprocess dependency: ${result.unresolved[0].from} -> ${result.unresolved[0].library}`);
    error.dependencyEvidence = result; throw error;
  }
  return result;
}
function primaryAbiRequirements(root, dependencyEvidence, run) {
  const result = { scope: 'primary Hub, WebKit and declared GIO TLS symbol-version requirements only; host ABI availability, transitive versions and native execution unaccepted', files: {} };
  const names = [...new Set(Object.values(dependencyEvidence.primary).flat())].sort();
  assert.ok(names.length > 0 && names.length <= 42, 'Bounded primary ABI inventory required');
  for (const name of names) {
    const text = String(run('/usr/bin/readelf', ['--version-info', path.join(root, name)], { maxBuffer: 4 * 1024 * 1024 }));
    assert.ok(Buffer.byteLength(text) <= 4 * 1024 * 1024, 'Primary ABI report exceeds bound');
    let needs = false; const required = new Set();
    for (const line of text.split(/\r?\n/)) {
      if (/^Version (?:needs|symbols|definition) section /.test(line)) needs = line.startsWith('Version needs section ');
      if (needs) for (const match of line.matchAll(/\bName:\s+([A-Za-z0-9_.]+)\s+Flags:/g)) required.add(match[1]);
    }
    assert.ok(required.size <= 256, 'Primary ABI requirement count exceeds bound');
    result.files[name] = { executableSha256: dependencyEvidence.closure[name].sha256,
      versionInfoSha256: hash(Buffer.from(text)), requiredSymbolVersions: [...required].sort() };
  }
  return result;
}
// Raw USTAR, not tarfile's PAX/GNU conveniences. Every parent directory is explicit.
function tarHeader(name, entry) {
  assert.ok(relative(name)); const h = Buffer.alloc(512); let tail = name, prefix = '';
  if (Buffer.byteLength(tail) > 100) {
    const splits = [...name.matchAll(/\//g)].map(m => m.index).filter(i => i <= 155 && name.length - i - 1 <= 100);
    assert.ok(splits.length, 'USTAR path cannot be represented'); const at = splits.at(-1);
    prefix = name.slice(0, at); tail = name.slice(at + 1);
  }
  h.write(tail, 0, 'ascii'); h.write(prefix, 345, 'ascii');
  function octal(offset, length, value) {
    const text = value.toString(8); assert.ok(text.length < length);
    h.write(text.padStart(length - 1, '0') + '\0', offset, 'ascii');
  }
  octal(100, 8, entry.mode); octal(108, 8, 0); octal(116, 8, 0);
  octal(124, 12, entry.kind === 'file' ? entry.size : 0); octal(136, 12, 0);
  h.fill(32, 148, 156); h[156] = entry.kind === 'file' ? 48 : 53;
  h.write('ustar\0', 257, 'ascii'); h.write('00', 263, 'ascii');
  const sum = h.reduce((a, b) => a + b, 0); h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}
async function packTar(root, destination, inv) {
  assert.deepEqual(inventory(root), inv);
  const fd = fs.openSync(destination, 'wx', 0o644), gzip = zlib.createGzip({ level: 9, mtime: 0 });
  let size = 0; const digest = crypto.createHash('sha256');
  const consume = (async () => {
    for await (const block of gzip) {
      size += block.length; assert.ok(size <= LIMITS.archive, 'AppDir archive exceeds Planck bound; coordinate with Parent');
      digest.update(block); fs.writeFileSync(fd, block);
    }
  })();
  // Attach a handler immediately so output failure cannot become an unhandled rejection.
  consume.catch(() => {});
  async function emit(bytes) {
    if (gzip.destroyed) throw gzip.errored || Error('Compression stream closed');
    if (!gzip.write(bytes)) await once(gzip, 'drain');
  }
  try {
    for (const [name, entry] of Object.entries(inv.entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      await emit(tarHeader(name, entry));
      if (entry.kind === 'file') {
        const file = path.join(root, name); assert.deepEqual(fileRecord(file), entry);
        const stream = fs.createReadStream(file, { highWaterMark: 65536 }); const d = crypto.createHash('sha256'); let count = 0;
        for await (const block of stream) { count += block.length; assert.ok(count <= entry.size); d.update(block); await emit(block); }
        assert.equal(count, entry.size); assert.equal(d.digest('hex'), entry.sha256);
        if (count % 512) await emit(Buffer.alloc(512 - count % 512));
      }
    }
    await emit(Buffer.alloc(1024)); gzip.end(); await consume;
    assert.deepEqual(inventory(root), inv);
    return { size, sha256: digest.digest('hex'), unpackedSize: inv.unpackedSize };
  } catch (e) { gzip.destroy(e); await consume.catch(() => {}); throw e; }
  finally { fs.closeSync(fd); }
}
function manifest(p, inv, binding) {
  validatePins(p); validateInventory(inv);
  keys(binding, ['size', 'sha256', 'unpackedSize']); pin({ size: binding.size, sha256: binding.sha256 }, LIMITS.archive);
  assert.equal(binding.unpackedSize, inv.unpackedSize);
  const entrypoint = inv.entries['usr/bin/creator-hub'];
  assert.ok(entrypoint?.kind === 'file' && entrypoint.mode === 0o755 && entrypoint.size >= 64, 'Fixed executable entrypoint required');
  const value = { schemaVersion: 1, appId: 'creator-hub', platform: 'linux', architecture: 'x86_64', version: VERSION,
    sourceCommit: p.sourceCommit, sourceTree: p.sourceTree, format: 'appdir-tar-gzip-v1', entrypoint: 'usr/bin/creator-hub',
    archive: binding, entries: inv.entries };
  assert.ok(Buffer.byteLength(JSON.stringify(value, null, 2) + '\n') <= LIMITS.manifest, 'Manifest exceeds Planck bound; coordinate with Parent');
  return value;
}
function validateInventory(inv) {
  keys(inv, ['entries', 'links', 'unpackedSize']); assert.deepEqual(inv.links, {});
  const entries = Object.entries(inv.entries), folded = new Set(); let total = 0;
  assert.ok(entries.length > 0 && entries.length <= LIMITS.entries, 'Inventory entry bound exceeded');
  for (const [name, entry] of entries) {
    assert.ok(relative(name) && !prohibited(name) && !folded.has(name.toLowerCase()), 'Noncanonical or prohibited inventory path'); folded.add(name.toLowerCase());
    const parent = path.posix.dirname(name);
    if (parent !== '.') assert.equal(inv.entries[parent]?.kind, 'directory', 'Every parent directory must be listed');
    if (entry.kind === 'directory') { keys(entry, ['kind', 'mode']); assert.equal(entry.mode, 0o755); }
    else {
      keys(entry, ['kind', 'size', 'sha256', 'mode']); assert.equal(entry.kind, 'file'); sha(entry.sha256);
      assert.ok(Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= LIMITS.file, 'Inventory file bound exceeded');
      assert.ok([0o644, 0o755].includes(entry.mode), 'Ordinary file mode required'); total += entry.size;
    }
    validateGtkMetadata(name, entry);
    validateGioRuntime(name, entry);
  }
  assert.ok(total <= LIMITS.total && total === inv.unpackedSize, 'Inventory total bound differs');
}
function overlay(payload) {
  const archive = require('./module-archive.cjs');
  return { version: VERSION, build: { beforeBundleCommand: null }, bundle: { active: true, targets: ['appimage'],
    createUpdaterArtifacts: false, externalBin: [], resources: { [payload]: archive.FILE },
    linux: { appimage: { files: {}, bundleMediaFramework: false } } } };
}
function bundleArgs(root, config) {
  return [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'bundle', '--ci', '--no-sign', '--bundles', 'appimage',
    '--target', TARGET, '--features', FEATURES.join(','), '--config', config];
}
function toolInventory(cache) {
  const finite = require('./flatpak-package.cjs');
  const names = ['AppRun-x86_64', 'linuxdeploy-x86_64.AppImage', 'linuxdeploy-plugin-gtk.sh',
    'linuxdeploy-plugin-gstreamer.sh', 'linuxdeploy-plugin-appimage.AppImage'];
  assert.ok(finite.ordinary(cache).isDirectory());
  assert.ok(fs.readdirSync(cache).every(n => names.includes(n)), 'Unreviewed Tauri tool cache entry');
  for (const n of names.slice(0, 4)) assert.ok(fs.existsSync(path.join(cache, n)), `Missing upstream packaging tool: ${n}`);
  return Object.fromEntries(names.filter(n => fs.existsSync(path.join(cache, n))).map(n => [n, record(read(path.join(cache, n), 128 * 1024 * 1024))]));
}
async function produce(root, inputRoot, output, decoder, env = process.env) {
  const finite = require('./flatpak-package.cjs'), archive = require('./module-archive.cjs'), unix = require('./unix-package-payload.cjs');
  admission(env); finite.ordinary(root); finite.ordinary(inputRoot);
  const temp = fs.realpathSync(env.RUNNER_TEMP); inside(inputRoot, temp); inside(output, temp); inside(decoder, temp);
  assert.equal(fs.existsSync(output), false, 'Fresh output required');
  const binding = json(path.join(inputRoot, 'input-binding.json'), 512 * 1024), p = binding.pins;
  verifyProducer(p, binding.proof); verifyPrivateProof(binding.privateProof);
  exact(path.join(inputRoot, 'assembly.zip'), p.artifact); exact(path.join(inputRoot, 'receipts.zip'), p.receiptsArtifact);
  exact(path.join(inputRoot, 'private-original.zip'), { size: binding.privateProof.artifactSize, sha256: binding.privateProof.expected.zipSha256 });
  const execute = (command, args, options = {}) => execFileSync(command, args, { cwd: root, encoding: 'utf8',
    timeout: 180000, maxBuffer: 1024 * 1024, windowsHide: true, ...options });
  const git = args => String(execute('git', args, { timeout: 30000 })).trim();
  assert.equal(git(['rev-parse', 'HEAD']), env.GITHUB_SHA);
  assert.equal(git(['status', '--porcelain=v1', '--untracked-files=normal']), '', 'Clean sidecar checkout required');
  assert.equal(git(['rev-parse', `${p.sourceCommit}^{tree}`]), p.sourceTree);
  git(['diff', '--exit-code', p.sourceCommit, 'HEAD', '--', 'package.json', 'package-lock.json', 'src-tauri/Cargo.toml',
    'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json', 'src-tauri/icons']);
  const config = json(path.join(root, 'src-tauri/tauri.conf.json')), npm = json(path.join(root, 'package.json'));
  assert.equal(config.version, VERSION); assert.equal(npm.version, VERSION); assert.equal(config.productName, 'Creator Hub');
  assert.equal(config.identifier, 'com.creatorworks.hub'); assert.equal(npm.devDependencies['@tauri-apps/cli'], '2.11.4');
  assert.ok(!config.build.beforeBundleCommand && !config.bundle.resources && !config.bundle.externalBin);
  for (const n of ['tauri.linux.conf.json', 'tauri.linux.conf.json5', 'Tauri.linux.toml']) assert.equal(fs.existsSync(path.join(root, 'src-tauri', n)), false, 'Unreviewed platform overlay');
  assert.equal(json(path.join(root, 'node_modules/@tauri-apps/cli/package.json')).version, '2.11.4');
  fs.mkdirSync(output, { mode: 0o700 });
  const child = { PATH: env.PATH, HOME: path.join(output, 'home'), XDG_CACHE_HOME: path.join(output, 'cache'),
    XDG_CONFIG_HOME: path.join(output, 'config'), XDG_DATA_HOME: path.join(output, 'data'), CARGO_HOME: path.join(output, 'cargo'),
    RUSTUP_HOME: env.RUSTUP_HOME || path.join(env.HOME, '.rustup'), CARGO_TARGET_DIR: path.join(output, 'target'),
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', CI: 'true', NO_STRIP: '1' };
  for (const n of ['HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CARGO_HOME']) fs.mkdirSync(child[n], { mode: 0o700 });
  const run = (command, args, options = {}) => execute(command, args, { env: child, ...options });
  const receipt = { schemaVersion: 1, scope: 'unsigned-linux-016-portable-packaging-only', producer: binding,
    packagingSource: env.GITHUB_SHA, rootRecompiled: false, privatePayloadChanged: false, payloadResigned: false,
    applicationLaunched: false, updateAcceptanceTested: false, hermetic: false, upstreamToolsPinned: false, ...flags() };
  try {
    const input = path.join(output, 'original-input'), receipts = path.join(output, 'original-receipts');
    stageZip(path.join(inputRoot, 'assembly.zip'), input, Object.fromEntries(INPUTS.map(n => [n, p.files[n]])), mainAllowed(), run);
    stageZip(path.join(inputRoot, 'receipts.zip'), receipts, Object.fromEntries(RECEIPTS.map(n => [n, p.files[n]])), RECEIPT_ALLOWED, run);
    run('python3', ['-B', '-c', ZIP_STAGE, path.join(inputRoot, 'private-original.zip'), path.join(output, 'original-private-metadata')],
      { input: JSON.stringify({ pins: {}, metadata: { 'prepared-unix.json': binding.privateProof.prepared },
        allowed: ['modules.tar.gz', 'prepared-unix.json', 'transfer-binding.json'] }) });
    const baseline = validateReceipts(input, receipts, binding), payload = path.join(input, archive.FILE);
    archive.verify(payload, baseline.manifest, decoder, (command, args, opts) => run(command, args, opts));
    const release = path.join(child.CARGO_TARGET_DIR, TARGET, 'release'); fs.mkdirSync(release, { recursive: true });
    const binary = path.join(release, 'creator-hub'); fs.writeFileSync(binary, baseline.bytes['creator-hub'], { flag: 'wx', mode: 0o755 });
    const overlayFile = path.join(output, 'portable-overlay.json'); write(overlayFile, overlay(payload));
    receipt.cliVersion = String(run(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), '--version'])).trim();
    assert.equal(receipt.cliVersion, 'tauri-cli 2.11.4');
    receipt.cliInputs = Object.fromEntries(['package-lock.json', 'node_modules/@tauri-apps/cli/tauri.js',
      'node_modules/@tauri-apps/cli-linux-x64-gnu/cli.linux-x64-gnu.node'].map(n => [n, record(read(path.join(root, n)))]));
    run(process.execPath, bundleArgs(root, overlayFile), { stdio: 'inherit', timeout: 900000 });
    // Preserve the exact unsigned image before any post-bundle audit can refuse.
    const bundles = path.join(release, 'bundle/appimage'), imageName = `Creator Hub_${VERSION}_amd64.AppImage`;
    assert.deepEqual(fs.readdirSync(bundles).filter(n => n.endsWith('.AppImage')), [imageName]);
    const image = path.join(output, imageName);
    receipt.appImage = retainAppImage(path.join(bundles, imageName), image);
    exact(binary, p.files['creator-hub']);
    receipt.upstreamPackagingTools = toolInventory(path.join(child.XDG_CACHE_HOME, 'tauri'));
    receipt.upstreamToolSource = 'https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy.rs';
    receipt.upstreamToolNote = 'Effective post-bundle cache hashes; Tauri 2.11.4 uses mutable upstream URLs and clears linuxdeploy bytes 8..10. Optional AppImage plugin absence means builtin fallback. No hermetic claim.';
    receipt.systemPackagingTools = Object.fromEntries(['/usr/bin/patchelf', '/usr/bin/readelf', '/usr/bin/file'].map(n => {
      const resolved = fs.realpathSync(n); return [n, { resolved, ...record(read(resolved)) }];
    }));
    // Inspect the AppDir Tauri just produced. No archive-controlled extraction and no AppImage execution.
    const appdir = path.join(bundles, 'Creator Hub.AppDir'), retained = path.join(output, 'Creator Hub.original.AppDir');
    const inv = inventory(appdir, true);
    fs.cpSync(appdir, retained, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    assert.deepEqual(inventory(retained, true), inv);
    const packaged = path.join(appdir, 'usr/bin/creator-hub'), bytes = read(packaged);
    unix.verifyLinuxHub(baseline.bytes['creator-hub'], bytes, 'appimage');
    assert.ok(bytes.includes(baseline.bytes['builtin-manifest.json']));
    exact(path.join(appdir, 'usr/lib/Creator Hub/modules.tar.gz'), p.files['modules.tar.gz']);
    archive.verify(path.join(appdir, 'usr/lib/Creator Hub/modules.tar.gz'), baseline.manifest, decoder, (command, args, opts) => run(command, args, opts));
    receipt.rootTransform = 'exactly one __TAURI_BUNDLE_TYPE_VAR_UNK -> APP marker; all other Root bytes identical';
    const transport = path.join(output, 'Creator Hub.AppDir'), transformation = flatten(appdir, transport);
    // Tauri copies custom usr/ files only. Keep the original AppImage unchanged;
    // bind this root-level record into the canonical transport instead.
    const profile = hostProfile(baseline.bytes['creator-hub'], bytes, baseline.portableHostBuild, p);
    const finalInventory = attachHostProfile(transport, transformation.flattened, profile, record(bytes));
    write(path.join(output, 'appdir-original-inventory.json'), transformation.original);
    write(path.join(output, 'appdir-flattened-inventory.json'), finalInventory);
    receipt.dependencies = dependencies(transport, finalInventory.entries, run, { includeHub: true });
    receipt.primaryAbi = primaryAbiRequirements(transport, receipt.dependencies, run);
    receipt.portableHostProfile = { path: HOST_PROFILE, ...record(profile), executable: record(bytes),
      rawExecutable: baseline.portableHostBuild.rawHub, compiledFeatures: FEATURES,
      scope: 'canonical-appdir-transport-only', appImageContainsProfile: false };
    finite.validateElf(read(path.join(transport, 'usr/bin/creator-hub')));
    const tar = path.join(output, 'creator-hub-linux-x86_64-0.1.16.appdir.tar.gz');
    verifyHostProfileInventory(inventory(transport), profile, record(bytes));
    const tarBinding = await packTar(transport, tar, finalInventory);
    const unsigned = manifest(p, finalInventory, tarBinding);
    write(path.join(output, 'portable-manifest.unsigned.json'), unsigned);
    receipt.archive = tarBinding; receipt.manifest = record(read(path.join(output, 'portable-manifest.unsigned.json'), LIMITS.manifest));
    receipt.measurements = { entries: Object.keys(unsigned.entries).length, unpackedFileBytes: tarBinding.unpackedSize,
      archiveBytes: tarBinding.size, manifestBytes: receipt.manifest.size,
      largestFileBytes: Math.max(...Object.values(unsigned.entries).filter(e => e.kind === 'file').map(e => e.size)),
      nodeProcessMaxRssKiB: process.resourceUsage().maxRSS,
      flattenedLinks: Object.keys(transformation.original.links).length, boundsProvisional: true, productionEnabled: false };
    receipt.flattenedLinks = transformation.original.links;
    validateReceipts(input, receipts, binding);
    exact(path.join(inputRoot, 'assembly.zip'), p.artifact); exact(path.join(inputRoot, 'receipts.zip'), p.receiptsArtifact);
    exact(path.join(inputRoot, 'private-original.zip'), { size: binding.privateProof.artifactSize, sha256: binding.privateProof.expected.zipSha256 });
    assert.deepEqual(inventory(retained, true), inv); assert.deepEqual(inventory(appdir, true), inv);
    assert.equal(git(['status', '--porcelain=v1', '--untracked-files=normal']), '', 'Packaging changed source');
    receipt.packagingCompleted = true; write(path.join(output, 'package-receipt.json'), receipt); return receipt;
  } catch (error) {
    receipt.packagingCompleted = false; receipt.error = String(error.message).slice(0, 2000);
    if (error.dependencyEvidence) receipt.dependencies = error.dependencyEvidence;
    if (error.inventoryEvidence) receipt.inventoryEvidence = error.inventoryEvidence;
    write(path.join(output, 'package-refusal.json'), receipt); throw error;
  }
}
function fetchInputs(output, env = process.env) {
  const { pins: p, privateInput } = preflight(env);
  inside(output, fs.realpathSync(env.RUNNER_TEMP)); assert.equal(fs.existsSync(output), false);
  const api = route => JSON.parse(execFileSync('gh', ['api', `repos/${REPO}/${route}`],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 }));
  const binding = collect(p, privateInput, api); fs.mkdirSync(output, { mode: 0o700 });
  for (const [artifactId, expected, name] of [[p.artifactId, p.artifact, 'assembly.zip'], [p.receiptsArtifactId, p.receiptsArtifact, 'receipts.zip']]) {
    const bytes = execFileSync('gh', ['api', `repos/${REPO}/actions/artifacts/${artifactId}/zip`],
      { timeout: 180000, maxBuffer: expected.size + 1 });
    assert.deepEqual(record(bytes), expected, 'Downloaded ZIP differs from independent size/SHA pin');
    fs.writeFileSync(path.join(output, name), bytes, { flag: 'wx', mode: 0o600 });
  }
  require('./download-unix-payload-zip.cjs').download({ binding: binding.privateProof, downloadedZipVerified: false, releaseReady: false }, path.join(output, 'private-original.zip'));
  assert.deepEqual(collect(p, privateInput, api), binding, 'API evidence changed during download');
  write(path.join(output, 'input-binding.json'), binding);
}
module.exports = { VERSION, TARGET, FEATURES, HOST_PROFILE, LIMITS, WORKFLOW, BRANCH, INPUTS, RECEIPTS, get MAIN_ALLOWED() { return mainAllowed(); }, RECEIPT_ALLOWED,
  record, flags, validatePins, admission, preflight, verifyProducer, verifyPrivateProof, collect, ZIP_STAGE, stageZip, validateReceipts,
  relative, prohibited, validateGtkMetadata, validateGioRuntime, retainAppImage, internalTarget, inventory, flatten, dependencies, primaryAbiRequirements, tarHeader, packTar, manifest, validateInventory, overlay, bundleArgs, toolInventory, produce, fetchInputs,
  hostProfile, verifyHostProfileInventory, attachHostProfile };
if (require.main === module) (async () => {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'preflight') { assert.equal(args.length, 0); preflight(); console.log(JSON.stringify({ preflightPassed: true, releaseReady: false })); }
  else if (mode === 'fetch') { assert.equal(args.length, 1); fetchInputs(...args); }
  else { assert.equal(mode, 'package'); assert.equal(args.length, 4); await produce(...args); }
})().catch(error => { console.error(String(error.message).slice(0, 2000)); process.exitCode = 1; });
