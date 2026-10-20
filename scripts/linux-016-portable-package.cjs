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
const DEB_MEMBER = `native-packages/Creator Hub_${VERSION}_amd64.deb`;
const PROTOTYPE = Object.freeze({ production: false, workflow: WORKFLOW, branch: BRANCH,
  features: Object.freeze([...FEATURES]), inputs: Object.freeze([...INPUTS]), receipts: Object.freeze([...RECEIPTS]),
  pinFiles: Object.freeze([...INPUTS, 'linux-byte-receipts.json', 'direct-features-candidate.json']) });
const PRODUCTION = Object.freeze({ production: true, id: 'production-portable-016',
  workflow: '.github/workflows/linux-016-portable-production.yml', branch: 'refs/heads/validation/linux-016-portable-production',
  features: Object.freeze(['integrated-features', 'experimental-flatpak-host', 'linux-production-migration', 'experimental-linux-portable-update']),
  inputs: Object.freeze([...INPUTS, DEB_MEMBER]),
  receipts: Object.freeze([...RECEIPTS, 'linux-retirement-candidate.json', 'linux-retirement-package-integrity.json']),
  pinFiles: Object.freeze([...INPUTS, 'linux-byte-receipts.json', 'direct-features-candidate.json', DEB_MEMBER,
    'linux-retirement-candidate.json', 'linux-retirement-package-integrity.json']) });
function fixedProfile(value) {
  assert.ok(value === PROTOTYPE || value === PRODUCTION, 'Caller-selected packaging policy refused'); return value;
}
const HOST_EXCLUSIONS = Object.freeze({
  source: Object.freeze({
    url: 'https://raw.githubusercontent.com/AppImageCommunity/pkg2appimage/199fc9f768b35ad6166109299e5cf3832adeb5d5/excludelist',
    size: 11454, sha256: '154aab55b8185116806488fe6ce14701de875d2e00dc11716613bf3c2e126265',
  }),
  generator: 'https://raw.githubusercontent.com/linuxdeploy/linuxdeploy/659c9db374666be3f29432316a859221eac28e53/src/core/generate-excludelist.sh',
  toolRelease: 'https://github.com/tauri-apps/binary-releases/releases/tag/linuxdeploy',
  tool: Object.freeze({ size: 13264064, sha256: '20eebde3c18ae2e44279bd624fc72482503aece216d5d77f10932235342f71c1' }),
  sonames: Object.freeze(['libEGL.so.1', 'libGL.so.1', 'libX11-xcb.so.1', 'libX11.so.6', 'libcom_err.so.2',
    'libdrm.so.2', 'libexpat.so.1', 'libfontconfig.so.1', 'libfreetype.so.6', 'libfribidi.so.0', 'libgbm.so.1',
    'libgcc_s.so.1', 'libgmp.so.10', 'libgpg-error.so.0', 'libharfbuzz.so.0', 'libstdc++.so.6', 'libxcb.so.1', 'libz.so.1']),
  scope: 'Pinned historical source explains these exclusions; the generator fetched a mutable list, so the compiled list is not attested. Tool hash is after Tauri clears bytes 8..10. No target ABI or runtime acceptance.',
});
const HOST_BASELINE = Object.freeze(['ld-linux-x86-64.so.2', 'libc.so.6', 'libdl.so.2', 'libm.so.6',
  'libpthread.so.0', 'librt.so.1', 'libresolv.so.2', 'libutil.so.1', ...HOST_EXCLUSIONS.sonames]);
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
function validatePins(p, profile = PROTOTYPE) {
  fixedProfile(profile);
  keys(p, ['schemaVersion', 'sourceCommit', 'sourceTree', 'runId', 'runAttempt', 'jobId', 'workflowId',
    'artifactId', 'artifact', 'receiptsArtifactId', 'receiptsArtifact', 'handoffSha256', 'files', ...(profile.production ? ['profile'] : [])]);
  assert.equal(p.schemaVersion, profile.production ? 2 : 1);
  if (profile.production) assert.equal(p.profile, profile.id);
  sha(p.sourceCommit, 40); sha(p.sourceTree, 40); sha(p.handoffSha256);
  for (const n of ['runId', 'runAttempt', 'jobId', 'workflowId', 'artifactId', 'receiptsArtifactId']) id(p[n]);
  assert.notEqual(p.artifactId, p.receiptsArtifactId);
  pin(p.artifact, LIMITS.zip); pin(p.receiptsArtifact, LIMITS.manifest);
  keys(p.files, profile.pinFiles);
  for (const [name, value] of Object.entries(p.files)) pin(value, name.endsWith('.json') ? 128 * 1024 : LIMITS.file);
  pin(p.files['builtin-manifest.json'], 65536);
  return p;
}
function admission(env, platform = process.platform, arch = process.arch, profile = PROTOTYPE) {
  fixedProfile(profile);
  assert.equal(platform, 'linux'); assert.equal(arch, 'x64');
  for (const [n, v] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_ID: String(REPO_ID),
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: profile.branch, GITHUB_WORKFLOW_REF: `${REPO}/${profile.workflow}@${profile.branch}` })) assert.equal(env[n], v, n);
  sha(env.GITHUB_SHA, 40);
  for (const n of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(env[n] || '', /^[1-9][0-9]*$/);
  assert.ok(!env.FLATPAK_ID && !env.DISPLAY && !env.WAYLAND_DISPLAY, 'Headless disposable host required');
  assert.ok(!Object.keys(env).some(n => /^(LD_|DYLD_|TAURI_|APPLE_|CREATOR_HUB_SIGNING_|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|SSL_CERT_|CURL_CA_BUNDLE$|WEBKIT_|APPIMAGE$|APPDIR$|RUSTFLAGS$|CARGO_ENCODED_RUSTFLAGS$|PYTHON)/.test(n)
    || n.toLowerCase().endsWith('proxy')), 'Runtime, trust, compiler and signing overrides refused');
}
function preflight(env = process.env, platform = process.platform, arch = process.arch, profile = PROTOTYPE) {
  admission(env, platform, arch, profile);
  assert.ok(typeof env.ASSEMBLY_PINS === 'string' && typeof env.PRIVATE_INPUT === 'string', 'Both independent JSON inputs required');
  assert.ok(Buffer.byteLength(env.ASSEMBLY_PINS) + Buffer.byteLength(env.PRIVATE_INPUT) <= 60000, 'Dispatch JSON exceeds bounded preflight input');
  const p = validatePins(JSON.parse(env.ASSEMBLY_PINS), profile), input = JSON.parse(env.PRIVATE_INPUT);
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
function verifyProducer(p, proof, profile = PROTOTYPE) {
  validatePins(p, profile);
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
function collect(p, privateInput, request, profile = PROTOTYPE) {
  const original = require('./unix-payload-binding.cjs');
  validatePins(p, profile); keys(privateInput, ['expected', 'prepared', 'artifactSize', 'jobId']);
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
  verifyProducer(p, proof, profile);
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
pins=config['pins']; metadata=config.get('metadata',{}); allowed=set(config['allowed']); dirs=set(); outputs=config.get('outputs',{})
assert not set(pins)&set(metadata)
assert set(outputs)<=set(pins) and len(set(outputs.get(n,n) for n in pins))==len(pins)
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
        target=outputs.get(name,name)
        assert name in allowed and target and target not in ('.','..') and not any(c in target for c in '/\\:')
        e=z.getinfo(name); assert not e.is_dir() and e.file_size==pin['size']
        data=z.read(e); assert len(data)==pin['size'] and hashlib.sha256(data).hexdigest()==pin['sha256']
        with (output/target).open('xb') as f: f.write(data)
        os.chmod(output/target,0o755 if name=='creator-hub' else 0o644)
    for name,expected in metadata.items():
        assert name=='prepared-unix.json' and name in allowed
        e=z.getinfo(name); assert not e.is_dir() and 0<e.file_size<=128*1024
        data=z.read(e); parsed=json.loads(data)
        assert data.decode('utf-8').strip()==json.dumps(parsed,indent=2,ensure_ascii=False) and parsed==expected
        with (output/name).open('xb') as f: f.write(data)
        os.chmod(output/name,0o644)
`;
function stageZip(file, output, pins, allowed, run, profile = PROTOTYPE) {
  fixedProfile(profile);
  run('python3', ['-B', '-c', ZIP_STAGE, file, output], { input: JSON.stringify({ pins, allowed,
    ...(profile.production && Object.hasOwn(pins, DEB_MEMBER) ? { outputs: { [DEB_MEMBER]: 'production-root.deb' } } : {}) }) });
}
function validateReceipts(input, receipts, binding, profile = PROTOTYPE) {
  const finite = require('./flatpak-package.cjs'), archive = require('./module-archive.cjs');
  const { runtimeDescriptor } = require('./mcp-runtime-descriptor.cjs');
  const { pins: p, proof, privateProof } = binding; verifyProducer(p, proof, profile); verifyPrivateProof(privateProof);
  const bytes = Object.fromEntries(INPUTS.map(n => [n, exact(path.join(input, n), p.files[n])]));
  for (const n of profile.receipts) exact(path.join(receipts, n), p.files[n]);
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
  assert.deepEqual(a.compiledFeatures, profile.features, 'Parent assembly must attest the exact compiledFeatures; scope alone is insufficient');
  const build = require('./build-unified.cjs');
  build.validatePortableBuildProof(a.portableHostBuild, p.sourceCommit, profile.features, p.files['creator-hub'], p.sourceTree);
  if (profile.production) {
    build.validateProductionBuildProof(a.productionMigration, p.sourceCommit, profile.features);
    assert.equal(a.productionMigration.sourceTree, p.sourceTree);
    assert.deepEqual(a.productionMigration.rawHub, p.files['creator-hub']);
    const staging = json(path.join(receipts, 'linux-retirement-candidate.json'));
    require('./linux-retirement-package.cjs').validateProductionReceipt(staging, p.sourceCommit);
    assert.deepEqual(a.productionMigration.staging, staging);
  } else assert.equal(Object.hasOwn(a, 'productionMigration'), false, 'Production proof cannot relabel prototype assembly');
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
  if (profile.production) assert.equal(deb.sha256, p.files[DEB_MEMBER].sha256);
  return { bytes, manifest: m, portableHostBuild: a.portableHostBuild,
    ...(profile.production ? { productionMigration: a.productionMigration, debHub: record(debHub) } : {}) };
}

function hostProfile(rawHub, packagedHub, proof, pins, profile = PROTOTYPE) {
  validatePins(pins, profile);
  const builder = require('./build-unified.cjs');
  builder.validatePortableBuildProof(proof, pins.sourceCommit, profile.features, record(rawHub), pins.sourceTree);
  for (const witness of builder.PORTABLE_ROOT_WITNESSES) {
    assert.ok(rawHub.includes(Buffer.from(witness)), 'Old Root cannot be relabelled with a portable profile');
  }
  require('./unix-package-payload.cjs').verifyLinuxHub(rawHub, packagedHub, 'appimage');
  return Buffer.from(JSON.stringify({ schemaVersion: 1, version: VERSION,
    activationInterface: 'com.creatorworks.hub.Host1', integratedFeatures: true,
    startupImageBinding: 1, executableSha256: hash(packagedHub) }, null, 2) + '\n');
}
const PRODUCTION_DEB_CHECK = String.raw`
import base64,importlib.util,json,sys
from pathlib import Path
sys.dont_write_bytecode=True
root,deb=map(Path,sys.argv[1:]); c=json.load(sys.stdin)
def load(name):
    spec=importlib.util.spec_from_file_location(name.replace('-','_'),root/'scripts'/(name+'.py'))
    m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
s=load('native-linux-016-stage'); v=load('linux-retirement-package-verify')
checked=v.verify(str(deb),c['pins']['helper']['sha256'],c['pins']['policy']['sha256'],'0.1.16','production-migration-016')
manifest=base64.b64decode(c['manifest'],validate=True)
records=s.inspect_deb(s.deb_records(deb),{'pins':c['pins']},manifest,s.parse(manifest))
print(json.dumps({'profile':checked['profile'],'files':checked['files'],
                  'packageFiles':{name:records[name] for name in s.DEB_MEMBERS.values()}}))
`;
function productionDeb(root, input, receipts, pins, baseline, run) {
  validatePins(pins, PRODUCTION);
  const retirement = require('./linux-retirement-package.cjs'), staging = baseline.productionMigration.staging;
  const file = path.join(input, 'production-root.deb'), packagePin = pins.files[DEB_MEMBER];
  exact(file, packagePin);
  const service = { ...record(retirement.SERVICE_BYTES), mode: 0o644, uid: 0, gid: 0 };
  const files = { ...staging.files, [retirement.SERVICE]: service };
  const receipt = json(path.join(receipts, 'linux-retirement-package-integrity.json'));
  keys(receipt, ['schemaVersion', 'acceptanceOnly', 'archiveIntegrityPassed', 'package', 'files', 'systemInstallationTested',
    'profile', 'productionContract', 'sourceCommit', 'rootFeature', 'helperFeature', ...Object.keys(retirement.FLAGS)]);
  assert.equal(receipt.schemaVersion, 2); assert.equal(receipt.acceptanceOnly, true); assert.equal(receipt.archiveIntegrityPassed, true);
  assert.equal(receipt.systemInstallationTested, false); assert.equal(receipt.profile, retirement.PRODUCTION_PROFILE);
  assert.equal(receipt.sourceCommit, pins.sourceCommit); assert.equal(receipt.rootFeature, retirement.PRODUCTION_ROOT_FEATURE);
  assert.equal(receipt.helperFeature, retirement.PRODUCTION_HELPER_FEATURE); assert.deepEqual(receipt.productionContract, retirement.PRODUCTION_CONTRACT);
  for (const name of Object.keys(retirement.FLAGS)) assert.equal(receipt[name], false);
  assert.deepEqual(receipt.package, { path: DEB_MEMBER, ...packagePin }); assert.deepEqual(receipt.files, files);
  const config = { manifest: baseline.bytes['builtin-manifest.json'].toString('base64'), pins: {
    hub: baseline.debHub, modulesArchive: pins.files['modules.tar.gz'], helper: staging.files[retirement.HELPER],
    policy: staging.files[retirement.POLICY], service } };
  const expected = Object.fromEntries([
    ['usr/bin/creator-hub', { ...baseline.debHub, mode: 0o755 }],
    ['usr/lib/Creator Hub/modules.tar.gz', { ...pins.files['modules.tar.gz'], mode: 0o644 }],
    ...Object.entries(files).map(([name, entry]) => [name.slice(1), { size: entry.size, sha256: entry.sha256, mode: entry.mode }]),
  ]);
  const verified = JSON.parse(String(run('python3', ['-B', '-c', PRODUCTION_DEB_CHECK, root, file],
    { input: JSON.stringify(config), maxBuffer: 65536 })));
  assert.deepEqual(verified, { profile: retirement.PRODUCTION_PROFILE, files, packageFiles: expected }, 'Actual production DEB bytes differ');
  exact(file, packagePin);
  return { ...verified, package: packagePin, nativeExecution: false, releaseReady: false };
}
const SELECTOR_ENTRYPOINT = 'usr/libexec/creator-hub-portable-selector';
const SELECTOR_TOOLCHAIN = '1.99.0-x86_64-unknown-linux-gnu';
const SELECTOR_SOURCES = Object.freeze(['native/linux-portable-deployment', 'src-tauri/src/catalog-key.pub']);
function selectorBuildArguments(root, target) {
  return ['build', '--release', '--locked', '--no-default-features', '--manifest-path',
    path.join(root, 'native/linux-portable-deployment/Cargo.toml'), '--bin', 'creator-hub-portable-selector',
    '--features', 'experimental-restart', '--target', TARGET, '--target-dir', target];
}
function buildSelector(root, output, pins, run) {
  validatePins(pins, PRODUCTION);
  const source = path.join(output, 'selector-source'), target = path.join(output, 'selector-target');
  assert.equal(fs.existsSync(source), false); assert.equal(fs.existsSync(target), false);
  const listing = String(run('git', ['ls-tree', '-rz', '--full-tree', pins.sourceCommit, '--', ...SELECTOR_SOURCES], { maxBuffer: 65536 }));
  const rows = listing.split('\0').filter(Boolean); assert.ok(rows.length > 0 && rows.length <= 256);
  const sources = {}; let total = 0;
  fs.mkdirSync(source, { mode: 0o700 });
  for (const row of rows) {
    const match = /^100(?:644|755) blob ([a-f0-9]{40})\t(.+)$/.exec(row); assert.ok(match, 'Nonregular selector Cargo source refused');
    const name = match[2]; assert.ok(relative(name) && !name.split('/').includes('.cargo')
      && (name.startsWith('native/linux-portable-deployment/') || name === SELECTOR_SOURCES[1]) && !Object.hasOwn(sources, name));
    const bytes = Buffer.from(run('git', ['cat-file', 'blob', match[1]], { encoding: null, maxBuffer: 2 * 1024 * 1024 }));
    assert.equal(crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), match[1]);
    const current = read(path.join(root, name), 2 * 1024 * 1024); assert.deepEqual(record(current), record(bytes), 'Selector source differs from assembly source tree');
    total += bytes.length; assert.ok(total <= 16 * 1024 * 1024, 'Selector Cargo source exceeds bound'); sources[name] = record(bytes);
    const destination = path.join(source, name); fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o755 });
    fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o644 });
  }
  for (const name of ['native/linux-portable-deployment/Cargo.toml', 'native/linux-portable-deployment/Cargo.lock',
    'native/linux-portable-deployment/src/bin/creator-hub-portable-selector.rs', SELECTOR_SOURCES[1]]) assert.ok(sources[name], `Missing selector source: ${name}`);
  for (let directory = source;; directory = path.dirname(directory)) {
    for (const name of ['config', 'config.toml']) assert.equal(fs.existsSync(path.join(directory, '.cargo', name)), false, 'Inherited Cargo configuration refused');
    if (path.dirname(directory) === directory) break;
  }
  const options = { cwd: source, timeout: 900000 };
  const compiler = String(run('rustc', ['--version', '--verbose'], options));
  assert.match(compiler, /^rustc 1\.99\.0 /); assert.match(compiler, /^host: x86_64-unknown-linux-gnu$/m);
  const cargo = String(run('cargo', ['--version'], options)); assert.match(cargo, /^cargo 1\.99\.0 /);
  const toolFiles = Object.fromEntries(['rustc', 'cargo'].map(name => {
    const file = String(run('rustup', ['which', '--toolchain', SELECTOR_TOOLCHAIN, name], options)).trim();
    assert.ok(path.isAbsolute(file)); return [name, { path: file, ...record(read(file)) }];
  }));
  const args = selectorBuildArguments(source, target);
  const metadata = JSON.parse(String(run(toolFiles.cargo.path, ['metadata', '--locked', '--no-deps', '--format-version', '1',
    '--manifest-path', path.join(source, 'native/linux-portable-deployment/Cargo.toml')], options)));
  assert.equal(metadata.packages.length, 1); const pkg = metadata.packages[0];
  assert.equal(pkg.name, 'creator-hub-linux-portable-deployment'); assert.equal(pkg.version, '0.1.0');
  assert.deepEqual(pkg.features.default, []); assert.deepEqual(pkg.features['experimental-restart'], []);
  assert.ok(pkg.dependencies.every(d => !d.path), 'Selector build cannot compile Root or private path dependencies');
  assert.equal(pkg.targets.filter(t => t.name === 'creator-hub-portable-selector' && t.kind.includes('bin')).length, 1);
  run(toolFiles.cargo.path, args, options);
  const compiled = path.join(target, TARGET, 'release/creator-hub-portable-selector'), finite = require('./flatpak-package.cjs');
  const identity = () => {
    const stat = fs.lstatSync(compiled, { bigint: true });
    return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs];
  };
  const before = identity();
  // Cargo may hardlink its owned output to target/deps; transport inputs remain single-link only.
  const capture = () => {
    assert.deepEqual(identity(), before, 'Cargo selector output identity changed');
    const bytes = finite.read(compiled, 32 * 1024 * 1024, true);
    assert.deepEqual(identity(), before, 'Cargo selector output identity changed'); return bytes;
  };
  const bytes = capture(); finite.validateElf(bytes);
  const file = path.join(output, 'selector-output/creator-hub-portable-selector');
  fs.mkdirSync(path.dirname(file), { mode: 0o700 });
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o755 }); fs.chmodSync(file, 0o755);
  const copied = read(file, 32 * 1024 * 1024), executable = record(copied); finite.validateElf(copied);
  assert.deepEqual(executable, record(bytes), 'Fresh selector copy bytes differ');
  for (const [name, expected] of Object.entries(sources)) {
    exact(path.join(root, name), expected); exact(path.join(source, name), expected);
  }
  for (const item of Object.values(toolFiles)) exact(item.path, { size: item.size, sha256: item.sha256 });
  assert.deepEqual(record(capture()), executable, 'Cargo selector output bytes changed');
  return { file, proof: { schemaVersion: 1, sourceCommit: pins.sourceCommit, sourceTree: pins.sourceTree, sources,
    publicKeySource: sources[SELECTOR_SOURCES[1]], target: TARGET, features: ['experimental-restart'],
    toolchain: SELECTOR_TOOLCHAIN, compiler, cargo, toolFiles, arguments: args, executable,
    rootRecompiled: false, privateModulesRecompiled: false, nativeExecution: false, releaseReady: false } };
}
function attachSelector(root, before, selector) {
  assert.deepEqual(inventory(root), before, 'Transport changed before selector staging');
  const expected = selector.proof.executable, bytes = exact(selector.file, expected);
  assert.ok(bytes.length <= 32 * 1024 * 1024); require('./flatpak-package.cjs').validateElf(bytes);
  const directory = 'usr/libexec', file = path.join(root, SELECTOR_ENTRYPOINT);
  assert.equal(Object.hasOwn(before.entries, SELECTOR_ENTRYPOINT), false, 'Existing selector cannot be adopted');
  if (!before.entries[directory]) fs.mkdirSync(path.join(root, directory), { mode: 0o755 });
  else assert.deepEqual(before.entries[directory], { kind: 'directory', mode: 0o755 });
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o755 }); fs.chmodSync(file, 0o755);
  exact(selector.file, expected);
  const after = inventory(root), entries = { ...before.entries, [directory]: { kind: 'directory', mode: 0o755 },
    [SELECTOR_ENTRYPOINT]: { kind: 'file', ...expected, mode: 0o755 } };
  assert.deepEqual(after, { entries: Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)),
    links: {}, unpackedSize: before.unpackedSize + expected.size }); return after;
}
function imageSnapshot(file) {
  require('./flatpak-package.cjs').ordinary(file);
  const before = fs.lstatSync(file, { bigint: true });
  assert.ok(before.isFile() && before.nlink === 1n && before.size > 0n && before.size <= BigInt(LIMITS.archive));
  const binding = s => [s.dev, s.ino, s.mode, s.nlink, s.size, s.mtimeNs, s.birthtimeNs];
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    const held = fs.fstatSync(fd, { bigint: true }); assert.deepEqual(binding(held), binding(before), 'Image changed during open');
    const digest = crypto.createHash('sha256'), block = Buffer.alloc(1024 * 1024); let size = 0, count;
    while ((count = fs.readSync(fd, block)) !== 0) { size += count; assert.ok(BigInt(size) <= held.size); digest.update(block.subarray(0, count)); }
    assert.equal(BigInt(size), held.size); assert.deepEqual(binding(fs.fstatSync(fd, { bigint: true })), binding(held));
    require('./flatpak-package.cjs').ordinary(file);
    const after = fs.lstatSync(file, { bigint: true }); assert.deepEqual(binding(after), binding(before), 'Named image changed during read');
    return { identity: [...binding(after), after.ctimeNs], pin: { size, sha256: digest.digest('hex') } };
  } finally { fs.closeSync(fd); }
}
function nativeSupportAlias(source, destination) {
  assert.equal(path.basename(source), `Creator Hub_${VERSION}_amd64.AppImage`);
  assert.equal(path.basename(destination), `Creator.Hub.Native.Support_${VERSION}_amd64.AppImage`);
  require('./flatpak-package.cjs').ordinary(path.dirname(destination));
  const before = imageSnapshot(source);
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
  const copy = imageSnapshot(destination), after = imageSnapshot(source);
  assert.deepEqual(after, before, 'Original image identity/bytes changed during alias copy');
  assert.deepEqual(copy.pin, before.pin, 'Native Support alias differs from ordinary image');
  return { ordinaryName: path.basename(source), nativeSupportName: path.basename(destination), ...before.pin,
    identicalBytes: true, sourceIdentityRechecked: true, role: 'restricted-setup-screen-intent-only', nativeExecution: false, releaseReady: false };
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
const APPRUN_WRAPPED = 'AppRun.wrapped';
const APPRUN_TOOL = 'AppRun-x86_64';
const APPRUN_PIN = Object.freeze({ size: 31552, sha256: 'f30140a43a0a59e46db21bdefdf749b9e9f2c6946e92afabbacf98b8ae73fb4f' });
const APPRUN_SOURCES = Object.freeze({
  permissions: 'https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/linux/appimage/mod.rs',
  copy: 'https://raw.githubusercontent.com/tauri-apps/tauri/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy.rs',
  download: 'https://github.com/tauri-apps/binary-releases/releases/download/apprun-old/AppRun-x86_64',
});
function validateAppRunWrapped(name, entry, bytes, source = false) {
  assert.equal(name, APPRUN_WRAPPED, 'Only the exact upstream AppRun.wrapped path is admitted');
  assert.ok(entry?.kind === 'file' && entry.mode === (source ? 0o770 : 0o755), 'Upstream AppRun.wrapped type/mode differs');
  assert.deepEqual({ size: entry.size, sha256: entry.sha256 }, APPRUN_PIN, 'Upstream AppRun.wrapped bytes differ');
  if (bytes !== undefined) {
    assert.ok(Buffer.isBuffer(bytes) && bytes.length === APPRUN_PIN.size, 'Bounded upstream AppRun.wrapped bytes required');
    require('./flatpak-package.cjs').validateElf(bytes);
    assert.deepEqual(record(bytes), APPRUN_PIN, 'Upstream AppRun.wrapped changed during inspection');
  }
}
function appRunToolBinding(tools) {
  assert.deepEqual(tools[APPRUN_TOOL], APPRUN_PIN, 'Cached upstream AppRun tool differs from the reviewed wrapper');
  return { path: APPRUN_WRAPPED, sources: APPRUN_SOURCES, tool: { name: APPRUN_TOOL, ...tools[APPRUN_TOOL] },
    scope: 'original-mode-0770-to-copied-transport-0755-only' };
}
const SCHEMA_DIRECTORY = 'usr/share/glib-2.0/schemas';
const COMPILED_SCHEMA = `${SCHEMA_DIRECTORY}/gschemas.compiled`;
const DATA_LIMIT = 128 * 1024;
// Finite data bytes inspected in retained AppImage 39335641660, SHA256
// abbc25bf439bce656a38a445fa349da93d62a25e754cc82d5967fda9f1f47cf5.
// No new package/schema name or changed upstream data is silently admitted.
const METADATA_PINS = Object.freeze(Object.fromEntries([
  ['usr/share/doc/libbz2-1.0/copyright', 2228, '832ed535ff3c3d025a8d2348eb1b697b89addcf2eaadbc17650262040b9145e2'],
  ['usr/share/doc/libcap2/copyright', 4631, 'a906104348c333a96d63c3573e6eb9c2cc3b410d045f3ad512dcafa4b3e4cff3'],
  ['usr/share/doc/libdbus-1-3/copyright', 19464, '151007a06fd9409b5fd1d743ce5749a1bbd94def4caee0e2bedf33318058a1a9'],
  ['usr/share/doc/libgdk-pixbuf-2.0-0/copyright', 5480, '4509ce25586e99da55525a8e27f1410bb7c3cb4647b9e1f586545110adc23a3c'],
  ['usr/share/doc/libgdk-pixbuf-2.0-dev/copyright', 5480, '4509ce25586e99da55525a8e27f1410bb7c3cb4647b9e1f586545110adc23a3c'],
  ['usr/share/doc/libglib2.0-0/copyright', 4119, '607a2dbcf41b82733bc93345da5470995a7f80515774fbabc4689158fae956c2'],
  ['usr/share/doc/libglib2.0-dev/copyright', 4119, '607a2dbcf41b82733bc93345da5470995a7f80515774fbabc4689158fae956c2'],
  ['usr/share/doc/libkeyutils1/copyright', 2104, '6ab5c541723d8211cab7ebc1643d53aa51c4863c1c838e4625d797ece9472ee8'],
  ['usr/share/doc/liblzma5/copyright', 15465, 'a2dc8fac0f496e1c58aff67018cf0c6b88336316afa5642f9335b71642e28aa8'],
  ['usr/share/doc/libpango-1.0-0/copyright', 53108, 'c0aef71da2cfce299d16c584cdde7c862c10996ee97f919dc91631bd9e7d0bc5'],
  ['usr/share/doc/libpango1.0-dev/copyright', 53108, 'c0aef71da2cfce299d16c584cdde7c862c10996ee97f919dc91631bd9e7d0bc5'],
  ['usr/share/doc/libpangocairo-1.0-0/copyright', 53108, 'c0aef71da2cfce299d16c584cdde7c862c10996ee97f919dc91631bd9e7d0bc5'],
  ['usr/share/doc/libpangoft2-1.0-0/copyright', 53108, 'c0aef71da2cfce299d16c584cdde7c862c10996ee97f919dc91631bd9e7d0bc5'],
  ['usr/share/doc/libpcre3/copyright', 2765, 'ac9276490d2fa167442ae1aae33926514ad10c8886baa40046c5e367fccc5938'],
  ['usr/share/doc/librsvg2-2/copyright', 40400, '1d46e8e95ca3cbc91ed729b342e8ea80981e2ae649ccd1bd880b8d2877f4a293'],
  ['usr/share/doc/librsvg2-dev/copyright', 40400, '1d46e8e95ca3cbc91ed729b342e8ea80981e2ae649ccd1bd880b8d2877f4a293'],
  ['usr/share/doc/libselinux1/copyright', 3131, '641806738b0c6a3d03168c2649e6b94205198bb66cd557e6bae3a20b71c9bb0b'],
  [`${SCHEMA_DIRECTORY}/10_gsettings-desktop-schemas.gschema.override`, 342, '7aec3161e0146744b3bfd09b5f78180aa90002703935b5b3e938b2f9ac3c2dbb'],
  [`${SCHEMA_DIRECTORY}/gschema.dtd`, 2916, '1a6f092697940a50adbd88891cc04f9aa506e35d11734906e779beeda713452e'],
  [COMPILED_SCHEMA, 38626, '0681c221db5357f13deb99687f4091a2ebcff056b6d878b944846a85ecd7e935'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.a11y.applications.gschema.xml`, 845, '6e67c6d900b0e698681454948dc6a11904edc1059af69d83ae8ff1c69abfe4ca'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.a11y.gschema.xml`, 828, 'f471028deedc07708638c7ea056ed1c6eb6632b987905321085288e836f337a8'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.a11y.interface.gschema.xml`, 422, '500f8f2deda68673d0148e96c670a5073fcdd9653af9bd68eafd483a2d042d51'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.a11y.keyboard.gschema.xml`, 4897, '429b25000a947e1b03724546e88b0f3dd6d3bac42addaec36d6cf81062c89cbb'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.a11y.magnifier.gschema.xml`, 9380, '0316beb1020bf0e1594c1578d4ee17044d8d4f04a58e788631b054503f07e0a0'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.a11y.mouse.gschema.xml`, 2907, '2409903ede1c85e899ff6576bc9711b9016704ee0434c22287d34d7e8c888c36'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.app-folders.gschema.xml`, 1841, 'f6a6be999af5d5ed29079432182af7708adefc0a2c7beeb7418254487ee4b772'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.background.gschema.xml`, 2612, '13f2de7840224b1c165bbdaa199dfe711f87de1d2bc8df9b1d73c64f96999ed1'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.calendar.gschema.xml`, 427, 'd153ebb1fbf3b72396be332c3402366420819c94248a4b96c4df77bb1a49ec3e'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.datetime.gschema.xml`, 439, 'db8f91d8966e24570844f4f0e52b6d5e4d0212cb398c71509f5f3cab6b39d292'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.default-applications.gschema.xml`, 3092, 'ba0b55abfbf2a6d300d3a222e4005fd4e965629ed7787ab8e08f1b7f65c4083d'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.enums.xml`, 6564, 'c33bef4f89b67716e5137a5d386008cb26ba347fe9a2f8a361c9f982ed37be3c'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.input-sources.gschema.xml`, 2549, 'b280a6620302845fec19a590fb8526dc5cc153d4f418dc363b9fad74a51316c0'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.interface.gschema.xml`, 12476, '3504b4e2f01a374ce17aef6cfcecc08f8ed2228783dc432dad3b0cf5b5470291'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.lockdown.gschema.xml`, 3454, '7d977d0932a4062ce5ddfce7cb8548092cc52fc7cb1d3b2825ae4599ca69e07c'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.media-handling.gschema.xml`, 2605, 'f4e22d9e928314d423702444e2393e0243dd54f52eed3c3f59dbe0c0db50c1d5'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.notifications.gschema.xml`, 2838, 'b7e983b5fa4cedccba7e6494c89de0997274986cdc69377a51589d97ac07acb4'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.peripherals.gschema.xml`, 13636, 'a75b066c4c77c097e4225db277b3aac28aeb8ce639b29d4edd96bbef1ae8da69'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.privacy.gschema.xml`, 4907, '304f26f2030d538f0e7ab1a8bae486e2b5e5879bc55c618e8931dc822284abd5'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.screensaver.gschema.xml`, 6191, 'd6b5f96c421da95378d3424a379fa9d507f98e6daca18eac4dfc8b16fb59bcdf'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.search-providers.gschema.xml`, 1907, '9efd368948d891c550bef426430a4c60cda5632a2859fd7da5c4595edd89c81d'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.session.gschema.xml`, 668, '462b3b4fe456aecd72a584e533566a0beccfeb9e7b6184f8bc410c4147a3ef7a'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.sound.gschema.xml`, 1055, 'ff7dcae2b2b3d6109bf4d75511f0ce1538e39b0593bfcd33f35f12653c62be92'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.thumbnail-cache.gschema.xml`, 600, '20246fc5002a989287eb7e5e351cfd79245df63d0978b879882ff3d534b8f9fb'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.thumbnailers.gschema.xml`, 866, '899bfc15c310051674714addc541824556a1e6d65b32cb715cba18662dc6ea02'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.wm.keybindings.gschema.xml`, 13631, '58036d83de3758f5080c80c8f4b4c13faf8d011da6d21bb7d5766d70a7d515ed'],
  [`${SCHEMA_DIRECTORY}/org.gnome.desktop.wm.preferences.gschema.xml`, 12908, '197e14e54d24a7d407ef8376e4267a40aaa3e83c1411ba956b6e27756eeb100e'],
  [`${SCHEMA_DIRECTORY}/org.gnome.system.locale.gschema.xml`, 448, '5b1e65629a77dcd201f4d86932ad62c0c41ec61fb117f151966d13e69411e2dc'],
  [`${SCHEMA_DIRECTORY}/org.gnome.system.location.gschema.xml`, 1159, '3fe90ebe8c851340249a1febe741b777c65b49a823201ead02f341be861060ed'],
  [`${SCHEMA_DIRECTORY}/org.gnome.system.proxy.gschema.xml`, 6347, 'ccf9767c5a47f23743c0a2c5e61622e5a06d1dfbcdc2642c10c6021e4d34997b'],
  [`${SCHEMA_DIRECTORY}/org.gtk.Settings.ColorChooser.gschema.xml`, 931, 'e476913ef61e6719ff56c2e4c5b8b276af3020bfb0d007263c2a241835730882'],
  [`${SCHEMA_DIRECTORY}/org.gtk.Settings.Debug.gschema.xml`, 833, 'de0685fdc2f6e890e32445a79aa938e5566b8dd406dd71d6c6a66c69e3f941e3'],
  [`${SCHEMA_DIRECTORY}/org.gtk.Settings.EmojiChooser.gschema.xml`, 623, '22aba28a5a78745d87eeded88f1b86f7ddea24b1b90771151ef494c660a1b591'],
  [`${SCHEMA_DIRECTORY}/org.gtk.Settings.FileChooser.gschema.xml`, 6212, 'c7089f41d22b3854c05fe4996ff271949b40148a40b9c6f0ae0349792dc94b77'],
].map(([name, size, sha256]) => [name, Object.freeze({ size, sha256 })])));
function metadataRole(name) {
  if (name === SCHEMA_DIRECTORY) return 'schema-directory';
  if (Object.hasOwn(METADATA_PINS, name)) return name.startsWith('usr/share/doc/') ? 'copyright' : 'schema-data';
  assert.ok(name.toLowerCase() !== SCHEMA_DIRECTORY && !Object.keys(METADATA_PINS).some(n => n.toLowerCase() === name.toLowerCase()), 'Metadata case alias refused');
  assert.ok(!/^usr\/share\/doc\/[^/]+\/copyright$/i.test(name), 'Unreviewed copyright data path');
  assert.ok(!name.toLowerCase().startsWith(`${SCHEMA_DIRECTORY}/`.toLowerCase()), 'Unreviewed schema data path');
  return null;
}
// GVDB v0, not a guessed GVariant magic prefix. Pointer/table layout comes from:
// https://github.com/GNOME/gvdb/blob/c6f2359cc1d00f16e0a0e2527fa0bc1882b8b5ab/gvdb/gvdb-format.h
// and gvdb-reader.c. Inner variants are additionally checked by GLib below.
function gvdbVariants(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length >= 24 && bytes.length <= DATA_LIMIT, 'Bounded GVDB data required');
  assert.equal(bytes.readUInt32LE(0), 1918981703, 'GVDB signature differs');
  assert.equal(bytes.readUInt32LE(4), 1953390953, 'GVDB signature differs');
  assert.equal(bytes.readUInt32LE(8), 0, 'Only GVDB version zero is reviewed');
  assert.equal(bytes.readUInt32LE(12), 0, 'Unreviewed GVDB options');
  const variants = [], tables = new Set(); let items = 0;
  function pointer(at, alignment) {
    const start = bytes.readUInt32LE(at), end = bytes.readUInt32LE(at + 4);
    assert.ok(start >= 24 && start <= end && end <= bytes.length && start % alignment === 0, 'Invalid GVDB pointer');
    return [start, end];
  }
  function table(at, depth) {
    const [start, end] = pointer(at, 4), identity = `${start}:${end}`;
    assert.ok(depth <= 32 && !tables.has(identity) && end - start >= 8, 'Cyclic/invalid GVDB table'); tables.add(identity);
    const bloom = bytes.readUInt32LE(start) & 0x7ffffff, buckets = bytes.readUInt32LE(start + 4);
    const bucketAt = start + 8 + bloom * 4, itemAt = bucketAt + buckets * 4;
    assert.ok(buckets > 0 && itemAt <= end && (end - itemAt) % 24 === 0, 'Invalid GVDB hash table');
    const count = (end - itemAt) / 24; items += count;
    assert.ok(count > 0 && items <= LIMITS.entries, 'GVDB item bound exceeded');
    let prior = 0;
    for (let i = 0; i < buckets; i++) {
      const bucket = bytes.readUInt32LE(bucketAt + i * 4);
      assert.ok(bucket >= prior && bucket <= count, 'Invalid GVDB bucket'); prior = bucket;
    }
    const parents = [];
    for (let i = 0; i < count; i++) {
      const item = itemAt + i * 24, parent = bytes.readUInt32LE(item + 4);
      const key = bytes.readUInt32LE(item + 8), size = bytes.readUInt16LE(item + 12), type = bytes[item + 14];
      assert.ok(parent === 0xffffffff || parent < count && parent !== i, 'Invalid GVDB parent'); parents.push(parent);
      assert.ok(key >= 24 && key + size <= bytes.length && bytes[item + 15] === 0, 'Invalid GVDB key');
      if (type === 72) table(item + 16, depth + 1); // H: nested table
      else {
        assert.ok(type === 76 || type === 118, 'Unreviewed GVDB item type'); // L or v
        const [a, b] = pointer(item + 16, type === 118 ? 8 : 4);
        if (type === 118) { assert.ok(b > a, 'Empty GVDB variant'); variants.push([a, b]); }
        else {
          assert.equal((b - a) % 4, 0, 'Invalid GVDB child list');
          for (let child = a; child < b; child += 4) assert.ok(bytes.readUInt32LE(child) < count, 'Invalid GVDB child index');
        }
      }
    }
    for (let i = 0; i < count; i++) {
      const seen = new Set(); let parent = i;
      while (parent !== 0xffffffff) {
        assert.ok(!seen.has(parent) && seen.size <= 32, 'Cyclic/deep GVDB parent'); seen.add(parent); parent = parents[parent];
      }
    }
  }
  table(16, 0); assert.ok(variants.length > 0, 'Compiled schema has no variants'); return variants;
}
const GVDB_VARIANTS = String.raw`
import base64,ctypes,json,sys
p=json.load(sys.stdin); data=base64.b64decode(p['bytes'],validate=True)
assert 24 <= len(data) <= 131072 and 0 < len(p['variants']) <= 8192
g=ctypes.CDLL('libglib-2.0.so.0')
g.g_variant_type_new.argtypes=[ctypes.c_char_p]; g.g_variant_type_new.restype=ctypes.c_void_p
g.g_variant_type_free.argtypes=[ctypes.c_void_p]
g.g_variant_new_from_data.argtypes=[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_size_t,ctypes.c_int,ctypes.c_void_p,ctypes.c_void_p]
g.g_variant_new_from_data.restype=ctypes.c_void_p
g.g_variant_ref_sink.argtypes=[ctypes.c_void_p]; g.g_variant_ref_sink.restype=ctypes.c_void_p
g.g_variant_is_normal_form.argtypes=[ctypes.c_void_p]; g.g_variant_is_normal_form.restype=ctypes.c_int
g.g_variant_unref.argtypes=[ctypes.c_void_p]
kind=g.g_variant_type_new(b'v'); assert kind
try:
    for start,end in p['variants']:
        assert 24 <= start < end <= len(data) and start%8 == 0
        held=ctypes.create_string_buffer(data[start:end])
        v=g.g_variant_new_from_data(kind,held,end-start,False,None,None); assert v
        g.g_variant_ref_sink(v)
        try: assert g.g_variant_is_normal_form(v), 'Non-normal GVariant data'
        finally: g.g_variant_unref(v)
finally: g.g_variant_type_free(kind)
print(json.dumps({'normalVariants':len(p['variants'])}))
`;
function validateCompiledSchema(bytes, run) {
  const variants = gvdbVariants(bytes);
  const result = JSON.parse(String(run('python3', ['-B', '-c', GVDB_VARIANTS], {
    input: JSON.stringify({ bytes: bytes.toString('base64'), variants }), timeout: 30000, maxBuffer: 4096 })));
  assert.deepEqual(result, { normalVariants: variants.length }); return result;
}
function validateMetadataFormat(name, bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= DATA_LIMIT, 'Bounded metadata data required');
  if (name === COMPILED_SCHEMA) { gvdbVariants(bytes); return; }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text), 'Non-text metadata refused');
  if (name.startsWith('usr/share/doc/')) assert.match(text, /copyright/i, 'Copyright notice required');
  else if (name.endsWith('.xml')) {
    const withoutComments = text.replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!/<!DOCTYPE|<!ENTITY/i.test(text) && /<schemalist(?:\s|>)/.test(withoutComments)
      && /<\/schemalist>\s*$/.test(withoutComments), 'Schema XML data required');
  } else if (name.endsWith('.dtd')) assert.ok(text.startsWith('<!ELEMENT schemalist ') && !/SYSTEM|PUBLIC|<!ENTITY/.test(text), 'Fixed local schema DTD required');
  else assert.ok(name.endsWith('.gschema.override') && /^\[org\.gnome\./.test(text), 'Fixed schema override data required');
}
function validateMetadata(name, entry, bytes, source = false) {
  const role = metadataRole(name); if (!role) return;
  if (role === 'schema-directory') {
    assert.ok(entry.kind === 'directory' && (entry.mode === 0o755 || source && entry.mode === 0o777), 'Schema directory mode/type refused'); return;
  }
  const mode = name === COMPILED_SCHEMA ? 0o666 : 0o777;
  assert.ok(entry.kind === 'file' && (entry.mode === 0o644 || source && entry.mode === mode), 'Metadata mode/type refused');
  assert.deepEqual({ size: entry.size, sha256: entry.sha256 }, METADATA_PINS[name], 'Metadata bytes differ from inspected source');
  if (bytes !== undefined) {
    validateMetadataFormat(name, bytes);
    assert.deepEqual(record(bytes), METADATA_PINS[name], 'Metadata changed during inspection');
  }
}
const sameMetadataStat = (a, b) => ['dev', 'ino', 'mode', 'size', 'nlink', 'uid', 'gid', 'mtimeMs', 'ctimeMs'].every(n => a[n] === b[n]);
function metadataRead(file, expected) {
  const finite = require('./flatpak-package.cjs'), before = finite.ordinary(file);
  assert.ok(before.isFile() && before.nlink === 1 && before.size > 0 && before.size <= DATA_LIMIT, 'Bounded single-link metadata file required');
  if (expected) assert.ok(sameMetadataStat(before, expected), 'Metadata changed before opening');
  const same = actual => sameMetadataStat(actual, before);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    assert.ok(same(fs.fstatSync(fd)), 'Metadata changed before read');
    const bytes = Buffer.alloc(before.size + 1); let length = 0, count;
    while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    assert.ok(length === before.size && same(fs.fstatSync(fd)) && same(finite.ordinary(file)), 'Metadata changed during read');
    return bytes.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
const METADATA_PROBES = Object.freeze(['usr/share/doc/libbz2-1.0/copyright', SCHEMA_DIRECTORY,
  `${SCHEMA_DIRECTORY}/10_gsettings-desktop-schemas.gschema.override`, `${SCHEMA_DIRECTORY}/gschema.dtd`,
  `${SCHEMA_DIRECTORY}/org.gnome.desktop.a11y.interface.gschema.xml`, COMPILED_SCHEMA]);
function metadataEvidence(root) {
  const finite = require('./flatpak-package.cjs');
  const result = Object.fromEntries(METADATA_PROBES.map(name => {
    try {
      const file = path.join(root, name), s = finite.ordinary(file);
      const entry = { kind: s.isFile() ? 'file' : s.isDirectory() ? 'directory' : 'special', mode: s.mode & 0o7777,
        size: s.size, dev: s.dev, ino: s.ino, nlink: s.nlink, uid: s.uid, gid: s.gid };
      if (s.isFile()) Object.assign(entry, record(metadataRead(file, s)));
      else assert.ok(s.isDirectory(), 'Special metadata probe refused');
      const after = finite.ordinary(file);
      assert.ok(sameMetadataStat(s, after), 'Metadata probe changed');
      return [name, entry];
    } catch (error) { return [name, { refused: String(error.message).slice(0, 256) }]; }
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192, 'Metadata probe evidence exceeds bound'); return result;
}
function transportMode(name, entry) {
  return entry.kind === 'directory' ? 0o755 : metadataRole(name) ? 0o644 : entry.mode & 0o111 ? 0o755 : 0o644;
}
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
        const role = metadataRole(rel), wrapped = rel === APPRUN_WRAPPED;
        // Tauri 2.11.4 sets its downloaded AppRun to 0770 before copying it.
        // Only these exact single-link executable bytes may retain that source mode.
        assert.ok(!(s.mode & 0o7000) && (s.isSymbolicLink() || !(s.mode & 0o022)
          || allowLinks && (role || wrapped && (s.mode & 0o7777) === 0o770)), 'Privileged/group/world-writable AppDir mode refused');
        if (wrapped) assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size === APPRUN_PIN.size,
          'Upstream AppRun.wrapped must be a bounded single-link regular file');
        if (role) assert.ok(!s.isSymbolicLink(), 'Metadata aliases refused');
        if (GTK_METADATA_PATHS.has(rel)) assert.ok(s.isFile() && !s.isSymbolicLink(), 'GObject typelib exception cannot be a directory or link');
        if (GIO_PATHS.has(rel)) assert.ok(!s.isSymbolicLink(), 'GIO runtime exception cannot be a link');
        if (wrapped) {
          const bytes = metadataRead(file, s);
          entries[rel] = { kind: 'file', ...record(bytes), mode: s.mode & 0o7777 };
          validateAppRunWrapped(rel, entries[rel], bytes, allowLinks);
        } else if (s.isSymbolicLink()) {
          assert.ok(allowLinks, 'Transport AppDir cannot contain links');
          const link = fs.readlinkSync(file), resolved = internalTarget(root, file);
          const target = path.relative(root, resolved).split(path.sep).join('/');
          // Directory links, loops, external targets and multi-link files are refused, never recursively followed.
          assert.ok(!metadataRole(target), 'Metadata cannot be aliased by a runtime link');
          const r = fileRecord(resolved); assert.ok(!(r.mode & 0o7022), 'Unsafe symlink target mode');
          entries[rel] = r; links[rel] = { link, resolved: target, ...r };
        } else if (s.isDirectory()) {
          entries[rel] = { kind: 'directory', mode: s.mode & 0o7777 };
          if (role) validateMetadata(rel, entries[rel], undefined, allowLinks);
          visit(file, `${rel}/`);
        } else if (role) {
          const bytes = metadataRead(file, s);
          entries[rel] = { kind: 'file', ...record(bytes), mode: s.mode & 0o7777 };
          validateMetadata(rel, entries[rel], bytes, allowLinks);
        } else entries[rel] = fileRecord(file);
        if (role) validateMetadata(rel, entries[rel], undefined, allowLinks);
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
function retainOriginalAppDir(root, destination, expected) {
  const finite = require('./flatpak-package.cjs');
  assert.ok(finite.ordinary(root).isDirectory()); finite.ordinary(path.dirname(destination));
  assert.ok(path.isAbsolute(destination) && path.resolve(destination) === destination, 'Ordinary retained destination required');
  const outside = path.relative(root, destination);
  assert.ok(outside === '..' || outside.startsWith(`..${path.sep}`) || path.isAbsolute(outside), 'Retained destination must be outside the source AppDir');
  try { fs.lstatSync(destination); assert.fail('Retained destination already exists; nothing was adopted'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert.deepEqual(inventory(root, true), expected, 'Original AppDir changed before retention');
  // Create every destination directory ourselves. cpSync otherwise maps the
  // reviewed 0777 schema directory to 0755; restore only these owned copies.
  fs.mkdirSync(destination, { mode: 0o755 });
  const owned = new Map([[destination, fs.lstatSync(destination)]]);
  const same = (actual, before) => actual.isDirectory() && actual.dev === before.dev && actual.ino === before.ino;
  const requireOwned = target => {
    assert.ok(owned.has(target) && same(finite.ordinary(target), owned.get(target)), 'Retained directory ownership changed');
  };
  const directories = Object.entries(expected.entries).filter(([, entry]) => entry.kind === 'directory');
  for (const [name] of directories) {
    const target = path.join(destination, name); requireOwned(destination); requireOwned(path.dirname(target));
    fs.mkdirSync(target, { mode: 0o755 }); owned.set(target, fs.lstatSync(target));
  }
  fs.cpSync(root, destination, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false,
    filter: (source, target) => {
      requireOwned(destination);
      const name = path.relative(root, source).split(path.sep).join('/');
      assert.ok(!name || relative(name) && Object.hasOwn(expected.entries, name), 'Unreviewed original-copy entry');
      assert.equal(target, name ? path.join(destination, name) : destination, 'Original-copy destination escaped');
      if (!name || expected.entries[name].kind === 'directory') requireOwned(target);
      requireOwned(name ? path.dirname(target) : destination); return true;
    } });
  for (const target of owned.keys()) requireOwned(target);
  const copied = inventory(destination, true);
  assert.deepEqual(copied, { ...expected, entries: Object.fromEntries(Object.entries(expected.entries).map(([name, entry]) =>
    [name, entry.kind === 'directory' ? { ...entry, mode: copied.entries[name]?.mode } : entry])) },
  'Retained bytes, files, links or paths differ before directory-mode preservation');
  for (const [name, entry] of directories) {
    const target = path.join(destination, name); requireOwned(destination); requireOwned(target);
    const fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0));
    try {
      assert.ok(same(fs.fstatSync(fd), owned.get(target)), 'Retained directory changed before chmod');
      fs.fchmodSync(fd, entry.mode); requireOwned(target);
    } finally { fs.closeSync(fd); }
  }
  requireOwned(destination);
  assert.deepEqual(inventory(root, true), expected, 'Original AppDir changed while retaining its copy');
  const retained = inventory(destination, true);
  assert.deepEqual(retained, expected, 'Retained original AppDir inventory differs'); return retained;
}
function flatten(root, destination) {
  const finite = require('./flatpak-package.cjs');
  const before = inventory(root, true); finite.ordinary(path.dirname(destination));
  fs.mkdirSync(destination, { mode: 0o755 }); fs.chmodSync(destination, 0o755);
  for (const [name, entry] of Object.entries(before.entries)) {
    const output = path.join(destination, name), mode = transportMode(name, entry);
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
  for (const [n, e] of Object.entries(before.entries)) assert.deepEqual(after.entries[n], { ...e, mode: transportMode(n, e) });
  return { original: before, flattened: after };
}
function dynamicTableEvidence(text) {
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 256 * 1024, 'Bounded dynamic table output required');
  const headers = [...text.matchAll(/^Dynamic section at offset 0x[0-9a-fA-F]+ contains ([1-9][0-9]*) entr(?:y|ies):\r?$/gm)];
  assert.ok(headers.length === 1 && text.slice(0, headers[0].index).trim() === '', 'Positive unambiguous dynamic section required');
  const count = Number(headers[0][1]); assert.ok(Number.isSafeInteger(count), 'Invalid dynamic table count');
  const lines = text.slice(headers[0].index + headers[0][0].length).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  assert.match(lines.shift() || '', /^Tag\s+Type\s+Name\/Value$/, 'Dynamic table columns missing');
  assert.equal(lines.length, count, 'Truncated or malformed dynamic table');
  const needed = [], versionTags = new Set(); let versionNeedCount = 0;
  const versionTypes = new Map([[0x6ffffff0n, 'VERSYM'], [0x6ffffffcn, 'VERDEF'], [0x6ffffffdn, 'VERDEFNUM'],
    [0x6ffffffen, 'VERNEED'], [0x6fffffffn, 'VERNEEDNUM']]);
  for (const [index, line] of lines.entries()) {
    const row = /^0x([0-9a-fA-F]{1,16})\s+\(([^()\r\n]+)\)(?:\s+(.+))?$/.exec(line);
    assert.ok(row, 'Malformed dynamic table row');
    const tag = BigInt(`0x${row[1]}`), type = row[2].trim();
    assert.equal(tag === 24n, type === 'BIND_NOW', 'Inconsistent dynamic BIND_NOW tag');
    // DT_BIND_NOW ignores d_un; GNU readelf prints no value for this exact tag.
    // https://gabi.xinuos.com/elf/08-dynamic.html#dynamic-section
    assert.ok(row[3] || tag === 24n, 'Malformed dynamic table row');
    assert.equal(tag === 0n, type === 'NULL', 'Inconsistent dynamic NULL tag');
    assert.equal(tag === 1n, type === 'NEEDED', 'Inconsistent dynamic NEEDED tag');
    if (versionTypes.has(tag)) {
      assert.equal(type, versionTypes.get(tag), 'Inconsistent dynamic version tag');
      assert.ok(!versionTags.has(type), 'Duplicate dynamic version tag'); versionTags.add(type);
      if (type === 'VERNEEDNUM') {
        assert.match(row[3], /^[1-9][0-9]*$/, 'Invalid VERNEEDNUM'); versionNeedCount = Number(row[3]);
        assert.ok(Number.isSafeInteger(versionNeedCount) && versionNeedCount <= 128, 'VERNEEDNUM exceeds bound');
      }
    } else assert.ok(![...versionTypes.values()].includes(type), 'Inconsistent dynamic version tag');
    if (tag === 0n) assert.equal(index, count - 1, 'Dynamic NULL must terminate the table');
    if (tag === 1n) {
      const library = /^Shared library:\s*\[([^\]\r\n]+)\]$/.exec(row[3]);
      assert.ok(library, 'Malformed dynamic NEEDED entry'); needed.push(library[1]);
    }
    if (index === count - 1) assert.equal(tag, 0n, 'Dynamic table terminator missing');
  }
  // DT_NEEDED is optional, not evidence that the dynamic table itself is absent.
  // https://gabi.xinuos.com/elf/08-dynamic.html#dynamic-section
  assert.ok(needed.length <= 128, 'Dynamic dependency count exceeds bound');
  assert.equal(versionTags.has('VERNEED'), versionTags.has('VERNEEDNUM'), 'Incomplete dynamic version-needs metadata');
  return { needed, versionNeedCount, versionInfoPresent: versionTags.size > 0 };
}
function dynamicDependencies(text) { return dynamicTableEvidence(text).needed; }
function hostBaselineEvidence(tools) {
  assert.deepEqual(tools['linuxdeploy-x86_64.AppImage'], HOST_EXCLUSIONS.tool, 'Unreviewed linuxdeploy exclusion provenance');
  return HOST_EXCLUSIONS;
}
function dependencies(root, files, run, { includeHub = false, includeSelector = false } = {}) {
  const finite = require('./flatpak-package.cjs');
  const patterns = { webkit: /(?:^|\/)libwebkit2gtk-4\.1\.so(?:\.\d+)*$/,
    javascriptCore: /(?:^|\/)libjavascriptcoregtk-4\.1\.so(?:\.\d+)*$/,
    webProcess: /\/webkit2gtk-4\.1\/WebKitWebProcess$/, networkProcess: /\/webkit2gtk-4\.1\/WebKitNetworkProcess$/,
    injectedBundle: /\/webkit2gtk-4\.1\/injected-bundle\/libwebkit2gtkinjectedbundle\.so$/ };
  const result = { primary: {}, closure: {}, hostBaseline: [], unresolved: [] }, providers = new Map(), checked = new Map();
  // Explicit ABI prerequisites, not bundled-library or distribution compatibility claims.
  const baseline = new Set(HOST_BASELINE);
  for (const [name, entry] of Object.entries(files)) if (entry.kind === 'file' && /\.so(?:\.\d+)*$/.test(name)) {
    const base = path.posix.basename(name); if (!providers.has(base)) providers.set(base, []); providers.get(base).push(name);
  }
  function inspect(name) {
    const entry = files[name]; assert.equal(entry.kind, 'file');
    if (checked.has(name)) return; checked.set(name, true);
    const bytes = read(path.join(root, name)); finite.validateElf(bytes); assert.deepEqual(record(bytes), { size: entry.size, sha256: entry.sha256 });
    const dynamic = String(run('/usr/bin/readelf', ['--dynamic', path.join(root, name)], { maxBuffer: 256 * 1024 }));
    const dynamicInfo = dynamicTableEvidence(dynamic), { needed } = dynamicInfo;
    const item = { ...entry, dynamicSha256: hash(Buffer.from(dynamic)), ...dynamicInfo, resolution: {} }; result.closure[name] = item;
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
  if (includeSelector) {
    assert.ok(files[SELECTOR_ENTRYPOINT]?.kind === 'file', 'Missing separately inventoried selector');
    result.primary.selector = [SELECTOR_ENTRYPOINT]; inspect(SELECTOR_ENTRYPOINT);
  }
  if (files[GIO_TLS]) {
    result.primary.gioTls = [GIO_TLS]; inspect(GIO_TLS);
  }
  result.hostBaseline = [...new Set(result.hostBaseline)].sort();
  result.hostBaselineSource = HOST_EXCLUSIONS;
  result.scope = 'static ELF dependency closure only; loader search, ABI versions, dlopen/plugins and native execution unaccepted';
  if (result.unresolved.length) {
    const error = Error(`Missing packaged subprocess dependency: ${result.unresolved[0].from} -> ${result.unresolved[0].library}`);
    error.dependencyEvidence = result; throw error;
  }
  return result;
}
function versionRequirements(text, dynamicInfo) {
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 4 * 1024 * 1024, 'Bounded version report required');
  // LLVM emits empty stdout for an unversioned ELF; GNU emits the fixed sentence.
  // Neither can erase version metadata positively observed in its dynamic table.
  if (!text.trim() || text.trim() === 'No version information found in this file.') {
    assert.equal(dynamicInfo.versionInfoPresent, false, 'Missing declared version information');
    assert.equal(dynamicInfo.versionNeedCount, 0); return {};
  }
  const headers = [...text.matchAll(/^Version (symbols|definition|needs) section '[^'\r\n]+' contains ([1-9][0-9]*) entr(?:y|ies):\r?$/gm)];
  assert.ok(headers.length > 0 && headers.length <= 3 && !text.slice(0, headers[0].index).trim(), 'Malformed version section header');
  assert.equal(dynamicInfo.versionInfoPresent, true, 'Version sections lack declared dynamic metadata');
  assert.equal(new Set(headers.map(h => h[1])).size, headers.length, 'Duplicate version section');
  const result = new Map(), indexes = new Set(); let needSections = 0, total = 0;
  for (const [i, header] of headers.entries()) {
    const body = text.slice(header.index + header[0].length, headers[i + 1]?.index ?? text.length);
    assert.ok(body.trim(), 'Truncated version section');
    if (header[1] !== 'needs') continue;
    needSections++; const count = Number(header[2]);
    assert.equal(count, dynamicInfo.versionNeedCount, 'Version-needs count differs from dynamic table');
    const lines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    assert.match(lines.shift() || '', /^Addr:\s+(?:0x)?[0-9a-fA-F]+\s+Offset:\s+(?:0x)?[0-9a-fA-F]+\s+Link:\s+\d+\s+\([^)]+\)$/, 'Version-needs location missing');
    let current, remaining = 0;
    for (const line of lines) {
      const file = /^(?:0x)?[0-9a-fA-F]+:\s+Version:\s+1\s+File:\s+(\S+)\s+Cnt:\s+([1-9][0-9]*)$/.exec(line);
      if (file) {
        assert.equal(remaining, 0, 'Truncated provider version requirements');
        assert.ok(relative(file[1]) && !file[1].includes('/') && dynamicInfo.needed.includes(file[1]), 'Version provider is not an exact DT_NEEDED dependency');
        assert.ok(!result.has(file[1]), 'Duplicate version provider');
        remaining = Number(file[2]); assert.ok(Number.isSafeInteger(remaining) && remaining <= 256, 'Provider version count exceeds bound');
        current = { required: [], weak: [] }; result.set(file[1], current); continue;
      }
      const name = /^(?:0x)?[0-9a-fA-F]+:\s+Name:\s+([A-Za-z0-9_.]+)\s+Flags:\s+(none|WEAK)\s+Version:\s+([0-9]+)$/.exec(line);
      assert.ok(name && current && remaining > 0, 'Malformed or orphan version requirement');
      const index = Number(name[3]); assert.ok(index >= 2 && index <= 32767 && !indexes.has(index), 'Duplicate/invalid version index'); indexes.add(index);
      assert.ok(!current.required.includes(name[1]) && !current.weak.includes(name[1]), 'Duplicate provider version tag');
      current[name[2] === 'WEAK' ? 'weak' : 'required'].push(name[1]); remaining--; total++;
      assert.ok(total <= 256, 'ELF version requirement count exceeds bound');
    }
    assert.equal(remaining, 0, 'Truncated provider version requirements');
    assert.equal(result.size, count, 'Truncated provider version inventory');
  }
  assert.equal(needSections, dynamicInfo.versionNeedCount ? 1 : 0, 'Declared version-needs section missing');
  return Object.fromEntries([...result].map(([name, value]) => [name, { required: value.required.sort(), weak: value.weak.sort() }]));
}
function closureAbiRequirements(root, dependencyEvidence, run) {
  const result = { scope: 'whole inspected static dependency closure GNU symbol-version requirements by provider; host ABI availability, undefined symbols, loader search, dlopen/plugins and native execution unaccepted',
    targetAbiVerified: false, undefinedSymbolsVerified: false, nativeExecutionVerified: false, releaseReady: false, files: {}, providers: {} };
  const names = Object.keys(dependencyEvidence.closure).sort(), providers = new Map(); let outputBytes = 0;
  assert.ok(names.length > 0 && names.length <= LIMITS.entries, 'Bounded closure ABI inventory required');
  for (const name of names) {
    const entry = dependencyEvidence.closure[name], file = path.join(root, name), pin = { size: entry.size, sha256: entry.sha256 };
    exact(file, pin);
    const text = String(run('/usr/bin/readelf', ['--version-info', file], { maxBuffer: 4 * 1024 * 1024 }));
    exact(file, pin); outputBytes += Buffer.byteLength(text);
    assert.ok(outputBytes <= 16 * 1024 * 1024, 'Closure version reports exceed total bound');
    const requirements = versionRequirements(text, entry);
    result.files[name] = { executableSha256: entry.sha256, versionInfoSha256: hash(Buffer.from(text)), requirementsByProvider: requirements,
      unversionedDependencies: entry.needed.filter(n => !Object.hasOwn(requirements, n)) };
    for (const library of entry.needed) {
      const resolution = entry.resolution[library];
      assert.ok(resolution && ['required-host-ABI-not-bundled', 'bundled-static-provider'].includes(resolution.kind), 'Unclassified version provider');
      if (!providers.has(library)) providers.set(library, { ...resolution, required: new Set(), weak: new Set(), consumers: new Set() });
      const provider = providers.get(library); assert.equal(provider.kind, resolution.kind);
      provider.consumers.add(name);
      for (const tag of requirements[library]?.required || []) provider.required.add(tag);
      for (const tag of requirements[library]?.weak || []) provider.weak.add(tag);
    }
  }
  result.providers = Object.fromEntries([...providers].sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => [name, {
    kind: item.kind, ...(item.paths ? { paths: item.paths } : {}), requiredSymbolVersions: [...item.required].sort(),
    weakSymbolVersions: [...item.weak].sort(), consumers: [...item.consumers].sort() }]));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= LIMITS.manifest, 'Closure ABI evidence exceeds bound');
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
function manifest(p, inv, binding, profile = PROTOTYPE) {
  validatePins(p, profile); validateInventory(inv);
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
    validateMetadata(name, entry);
    if (name === APPRUN_WRAPPED) validateAppRunWrapped(name, entry);
  }
  assert.ok(total <= LIMITS.total && total === inv.unpackedSize, 'Inventory total bound differs');
}
function overlay(payload) {
  const archive = require('./module-archive.cjs');
  return { version: VERSION, build: { beforeBundleCommand: null }, bundle: { active: true, targets: ['appimage'],
    createUpdaterArtifacts: false, externalBin: [], resources: { [payload]: archive.FILE },
    linux: { appimage: { files: {}, bundleMediaFramework: false } } } };
}
function bundleArgs(root, config, profile = PROTOTYPE) {
  fixedProfile(profile);
  return [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'bundle', '--ci', '--no-sign', '--bundles', 'appimage',
    '--target', TARGET, '--features', profile.features.join(','), '--config', config];
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
async function produce(root, inputRoot, output, decoder, env = process.env, profile = PROTOTYPE) {
  const finite = require('./flatpak-package.cjs'), archive = require('./module-archive.cjs'), unix = require('./unix-package-payload.cjs');
  admission(env, process.platform, process.arch, profile); finite.ordinary(root); finite.ordinary(inputRoot);
  const temp = fs.realpathSync(env.RUNNER_TEMP); inside(inputRoot, temp); inside(output, temp); inside(decoder, temp);
  assert.equal(fs.existsSync(output), false, 'Fresh output required');
  const binding = json(path.join(inputRoot, 'input-binding.json'), 512 * 1024), p = binding.pins;
  verifyProducer(p, binding.proof, profile); verifyPrivateProof(binding.privateProof);
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
  if (profile.production) child.RUSTUP_TOOLCHAIN = SELECTOR_TOOLCHAIN;
  for (const n of ['HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CARGO_HOME']) fs.mkdirSync(child[n], { mode: 0o700 });
  const run = (command, args, options = {}) => execute(command, args, { env: child, ...options });
  const receipt = { schemaVersion: profile.production ? 2 : 1, scope: profile.production ? 'unsigned-linux-016-production-portable-packaging-only' : 'unsigned-linux-016-portable-packaging-only', producer: binding,
    packagingSource: env.GITHUB_SHA, rootRecompiled: false, privatePayloadChanged: false, payloadResigned: false,
    applicationLaunched: false, updateAcceptanceTested: false, hermetic: false, upstreamToolsPinned: false,
    metadataNormalization: { scope: 'copied-transport-only', packagingProcessUmask: process.umask(),
      sourceModesChanged: false, sourceBytesChanged: false, compiledSchemaModeCause: 'unknown; generated 0666 alone does not prove an umask cause',
      inspectedAppImage: { size: 143112696, sha256: 'abbc25bf439bce656a38a445fa349da93d62a25e754cc82d5967fda9f1f47cf5' },
      hostBeforeBundle: metadataEvidence(path.parse(root).root) }, ...flags() };
  try {
    const input = path.join(output, 'original-input'), receipts = path.join(output, 'original-receipts');
    stageZip(path.join(inputRoot, 'assembly.zip'), input, Object.fromEntries(profile.inputs.map(n => [n, p.files[n]])), mainAllowed(), run, profile);
    stageZip(path.join(inputRoot, 'receipts.zip'), receipts, Object.fromEntries(profile.receipts.map(n => [n, p.files[n]])), RECEIPT_ALLOWED, run, profile);
    run('python3', ['-B', '-c', ZIP_STAGE, path.join(inputRoot, 'private-original.zip'), path.join(output, 'original-private-metadata')],
      { input: JSON.stringify({ pins: {}, metadata: { 'prepared-unix.json': binding.privateProof.prepared },
        allowed: ['modules.tar.gz', 'prepared-unix.json', 'transfer-binding.json'] }) });
    const baseline = validateReceipts(input, receipts, binding, profile), payload = path.join(input, archive.FILE);
    archive.verify(payload, baseline.manifest, decoder, (command, args, opts) => run(command, args, opts));
    let selector;
    if (profile.production) {
      receipt.productionDeb = productionDeb(root, input, receipts, p, baseline, run);
      selector = buildSelector(root, output, p, run); receipt.selectorBuild = selector.proof;
    }
    const release = path.join(child.CARGO_TARGET_DIR, TARGET, 'release'); fs.mkdirSync(release, { recursive: true });
    const binary = path.join(release, 'creator-hub'); fs.writeFileSync(binary, baseline.bytes['creator-hub'], { flag: 'wx', mode: 0o755 });
    const overlayFile = path.join(output, 'portable-overlay.json'); write(overlayFile, overlay(payload));
    receipt.cliVersion = String(run(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), '--version'])).trim();
    assert.equal(receipt.cliVersion, 'tauri-cli 2.11.4');
    receipt.cliInputs = Object.fromEntries(['package-lock.json', 'node_modules/@tauri-apps/cli/tauri.js',
      'node_modules/@tauri-apps/cli-linux-x64-gnu/cli.linux-x64-gnu.node'].map(n => [n, record(read(path.join(root, n)))]));
    run(process.execPath, bundleArgs(root, overlayFile, profile), { stdio: 'inherit', timeout: 900000 });
    // Preserve the exact unsigned image before any post-bundle audit can refuse.
    const bundles = path.join(release, 'bundle/appimage'), imageName = `Creator Hub_${VERSION}_amd64.AppImage`;
    assert.deepEqual(fs.readdirSync(bundles).filter(n => n.endsWith('.AppImage')), [imageName]);
    const image = path.join(output, imageName);
    receipt.appImage = retainAppImage(path.join(bundles, imageName), image);
    if (profile.production) receipt.nativeSupportAlias = nativeSupportAlias(image, path.join(output, `Creator.Hub.Native.Support_${VERSION}_amd64.AppImage`));
    exact(binary, p.files['creator-hub']);
    receipt.upstreamPackagingTools = toolInventory(path.join(child.XDG_CACHE_HOME, 'tauri'));
    receipt.hostBaselineSource = hostBaselineEvidence(receipt.upstreamPackagingTools);
    receipt.appRunWrapper = appRunToolBinding(receipt.upstreamPackagingTools);
    receipt.upstreamToolSource = 'https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy.rs';
    receipt.upstreamToolNote = 'Effective post-bundle cache hashes; Tauri 2.11.4 uses mutable upstream URLs and clears linuxdeploy bytes 8..10. Optional AppImage plugin absence means builtin fallback. No hermetic claim.';
    receipt.systemPackagingTools = Object.fromEntries(['/usr/bin/patchelf', '/usr/bin/readelf', '/usr/bin/file'].map(n => {
      const resolved = fs.realpathSync(n); return [n, { resolved, ...record(read(resolved)) }];
    }));
    // Inspect the AppDir Tauri just produced. No archive-controlled extraction and no AppImage execution.
    const appdir = path.join(bundles, 'Creator Hub.AppDir'), retained = path.join(output, 'Creator Hub.original.AppDir');
    receipt.metadataNormalization.hostAfterBundle = metadataEvidence(path.parse(root).root);
    receipt.metadataNormalization.originalBeforeCopy = metadataEvidence(appdir);
    const inv = inventory(appdir, true);
    validateAppRunWrapped(APPRUN_WRAPPED, inv.entries[APPRUN_WRAPPED], undefined, true);
    receipt.appRunWrapper.original = inv.entries[APPRUN_WRAPPED];
    for (const name of [SCHEMA_DIRECTORY, ...Object.keys(METADATA_PINS)]) assert.ok(Object.hasOwn(inv.entries, name), `Missing inspected metadata: ${name}`);
    receipt.metadataNormalization.compiledSchemaFormat = validateCompiledSchema(metadataRead(path.join(appdir, COMPILED_SCHEMA)), run);
    retainOriginalAppDir(appdir, retained, inv);
    assert.deepEqual(inventory(retained, true), inv);
    const packaged = path.join(appdir, 'usr/bin/creator-hub'), bytes = read(packaged);
    unix.verifyLinuxHub(baseline.bytes['creator-hub'], bytes, 'appimage');
    assert.ok(bytes.includes(baseline.bytes['builtin-manifest.json']));
    exact(path.join(appdir, 'usr/lib/Creator Hub/modules.tar.gz'), p.files['modules.tar.gz']);
    archive.verify(path.join(appdir, 'usr/lib/Creator Hub/modules.tar.gz'), baseline.manifest, decoder, (command, args, opts) => run(command, args, opts));
    receipt.rootTransform = 'exactly one __TAURI_BUNDLE_TYPE_VAR_UNK -> APP marker; all other Root bytes identical';
    const transport = path.join(output, 'Creator Hub.AppDir'), transformation = flatten(appdir, transport);
    validateAppRunWrapped(APPRUN_WRAPPED, transformation.flattened.entries[APPRUN_WRAPPED]);
    receipt.appRunWrapper.transport = transformation.flattened.entries[APPRUN_WRAPPED];
    Object.assign(receipt.metadataNormalization, { originalAfterCopy: metadataEvidence(appdir), retainedOriginal: metadataEvidence(retained),
      transport: metadataEvidence(transport), copiedData: Object.fromEntries(Object.keys(METADATA_PINS).map(name => [name, {
        ...METADATA_PINS[name], originalMode: inv.entries[name].mode, transportMode: transformation.flattened.entries[name].mode }])) });
    assert.deepEqual(receipt.metadataNormalization.originalAfterCopy, receipt.metadataNormalization.originalBeforeCopy, 'Metadata source changed during normalization');
    assert.ok(Buffer.byteLength(JSON.stringify(receipt.metadataNormalization)) <= 64 * 1024, 'Metadata receipt exceeds bound');
    // Tauri copies custom usr/ files only. Keep the original AppImage unchanged;
    // bind this root-level record into the canonical transport instead.
    const hostProfileBytes = hostProfile(baseline.bytes['creator-hub'], bytes, baseline.portableHostBuild, p, profile);
    let finalInventory = attachHostProfile(transport, transformation.flattened, hostProfileBytes, record(bytes));
    if (profile.production) finalInventory = attachSelector(transport, finalInventory, selector);
    write(path.join(output, 'appdir-original-inventory.json'), transformation.original);
    write(path.join(output, 'appdir-flattened-inventory.json'), finalInventory);
    receipt.dependencies = dependencies(transport, finalInventory.entries, run, { includeHub: true, ...(profile.production ? { includeSelector: true } : {}) });
    receipt.closureAbi = closureAbiRequirements(transport, receipt.dependencies, run);
    receipt.portableHostProfile = { path: HOST_PROFILE, ...record(hostProfileBytes), executable: record(bytes),
      rawExecutable: baseline.portableHostBuild.rawHub, compiledFeatures: profile.features,
      scope: 'canonical-appdir-transport-only', appImageContainsProfile: false };
    finite.validateElf(read(path.join(transport, 'usr/bin/creator-hub')));
    const tar = path.join(output, 'creator-hub-linux-x86_64-0.1.16.appdir.tar.gz');
    verifyHostProfileInventory(inventory(transport), hostProfileBytes, record(bytes));
    const tarBinding = await packTar(transport, tar, finalInventory);
    const unsigned = manifest(p, finalInventory, tarBinding, profile);
    write(path.join(output, 'portable-manifest.unsigned.json'), unsigned);
    receipt.archive = tarBinding; receipt.manifest = record(read(path.join(output, 'portable-manifest.unsigned.json'), LIMITS.manifest));
    receipt.measurements = { entries: Object.keys(unsigned.entries).length, unpackedFileBytes: tarBinding.unpackedSize,
      archiveBytes: tarBinding.size, manifestBytes: receipt.manifest.size,
      largestFileBytes: Math.max(...Object.values(unsigned.entries).filter(e => e.kind === 'file').map(e => e.size)),
      nodeProcessMaxRssKiB: process.resourceUsage().maxRSS,
      flattenedLinks: Object.keys(transformation.original.links).length, boundsProvisional: true, productionEnabled: false };
    receipt.flattenedLinks = transformation.original.links;
    validateReceipts(input, receipts, binding, profile);
    if (profile.production) {
      exact(path.join(input, 'production-root.deb'), p.files[DEB_MEMBER]); exact(selector.file, selector.proof.executable);
      assert.deepEqual(imageSnapshot(image).pin, receipt.appImage);
      assert.deepEqual(imageSnapshot(path.join(output, receipt.nativeSupportAlias.nativeSupportName)).pin, receipt.appImage);
    }
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
function fetchInputs(output, env = process.env, profile = PROTOTYPE) {
  const { pins: p, privateInput } = preflight(env, process.platform, process.arch, profile);
  inside(output, fs.realpathSync(env.RUNNER_TEMP)); assert.equal(fs.existsSync(output), false);
  const api = route => JSON.parse(execFileSync('gh', ['api', `repos/${REPO}/${route}`],
    { encoding: 'utf8', timeout: 30000, maxBuffer: 2 * 1024 * 1024 }));
  const binding = collect(p, privateInput, api, profile); fs.mkdirSync(output, { mode: 0o700 });
  for (const [artifactId, expected, name] of [[p.artifactId, p.artifact, 'assembly.zip'], [p.receiptsArtifactId, p.receiptsArtifact, 'receipts.zip']]) {
    const bytes = execFileSync('gh', ['api', `repos/${REPO}/actions/artifacts/${artifactId}/zip`],
      { timeout: 180000, maxBuffer: expected.size + 1 });
    assert.deepEqual(record(bytes), expected, 'Downloaded ZIP differs from independent size/SHA pin');
    fs.writeFileSync(path.join(output, name), bytes, { flag: 'wx', mode: 0o600 });
  }
  require('./download-unix-payload-zip.cjs').download({ binding: binding.privateProof, downloadedZipVerified: false, releaseReady: false }, path.join(output, 'private-original.zip'));
  assert.deepEqual(collect(p, privateInput, api, profile), binding, 'API evidence changed during download');
  write(path.join(output, 'input-binding.json'), binding);
}
function production016() {
  assert.equal(arguments.length, 0, 'Production packaging profile has no caller policy');
  return Object.freeze({ VERSION, TARGET, WORKFLOW: PRODUCTION.workflow, BRANCH: PRODUCTION.branch,
    FEATURES: PRODUCTION.features, INPUTS: PRODUCTION.inputs, RECEIPTS: PRODUCTION.receipts,
    PROFILE: PRODUCTION.id, DEB_MEMBER, SELECTOR_ENTRYPOINT, SELECTOR_TOOLCHAIN, PRODUCTION_DEB_CHECK,
    validatePins: pins => validatePins(pins, PRODUCTION),
    admission: (env, platform = process.platform, arch = process.arch) => admission(env, platform, arch, PRODUCTION),
    preflight: (env = process.env, platform = process.platform, arch = process.arch) => preflight(env, platform, arch, PRODUCTION),
    verifyProducer: (pins, proof) => verifyProducer(pins, proof, PRODUCTION),
    collect: (pins, input, request) => collect(pins, input, request, PRODUCTION),
    stageZip: (file, output, pins, allowed, run) => stageZip(file, output, pins, allowed, run, PRODUCTION),
    validateReceipts: (input, receipts, binding) => validateReceipts(input, receipts, binding, PRODUCTION),
    hostProfile: (raw, packaged, proof, pins) => hostProfile(raw, packaged, proof, pins, PRODUCTION),
    bundleArgs: (root, config) => bundleArgs(root, config, PRODUCTION),
    manifest: (pins, inventory, archive) => manifest(pins, inventory, archive, PRODUCTION),
    fetchInputs: (output, env = process.env) => fetchInputs(output, env, PRODUCTION),
    produce: (root, input, output, decoder, env = process.env) => produce(root, input, output, decoder, env, PRODUCTION),
    productionDeb, selectorBuildArguments, buildSelector, attachSelector, imageSnapshot, nativeSupportAlias });
}
module.exports = { VERSION, TARGET, FEATURES, HOST_PROFILE, LIMITS, WORKFLOW, BRANCH, INPUTS, RECEIPTS, get MAIN_ALLOWED() { return mainAllowed(); }, RECEIPT_ALLOWED,
  record, flags, validatePins, admission, preflight, verifyProducer, verifyPrivateProof, collect, ZIP_STAGE, stageZip, validateReceipts,
  relative, prohibited, validateGtkMetadata, validateGioRuntime, retainAppImage, internalTarget, inventory, retainOriginalAppDir, flatten, dynamicDependencies, dynamicTableEvidence, HOST_BASELINE, HOST_EXCLUSIONS, hostBaselineEvidence, dependencies, versionRequirements, closureAbiRequirements, tarHeader, packTar, manifest, validateInventory, overlay, bundleArgs, toolInventory, produce, fetchInputs,
  hostProfile, verifyHostProfileInventory, attachHostProfile, SCHEMA_DIRECTORY, COMPILED_SCHEMA, METADATA_PINS, METADATA_PROBES, DATA_LIMIT,
  metadataRole, gvdbVariants, GVDB_VARIANTS, validateCompiledSchema, validateMetadataFormat, validateMetadata, metadataRead, metadataEvidence, transportMode,
  APPRUN_WRAPPED, APPRUN_TOOL, APPRUN_PIN, APPRUN_SOURCES, validateAppRunWrapped, appRunToolBinding, production016 };
if (require.main === module) (async () => {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'preflight') { assert.equal(args.length, 0); preflight(); console.log(JSON.stringify({ preflightPassed: true, releaseReady: false })); }
  else if (mode === 'fetch') { assert.equal(args.length, 1); fetchInputs(...args); }
  else { assert.equal(mode, 'package'); assert.equal(args.length, 4); await produce(...args); }
})().catch(error => {
  console.error(String(error.message).slice(0, 2000));
  if (error.inventoryEvidence) console.error(JSON.stringify(error.inventoryEvidence));
  process.exitCode = 1;
});
