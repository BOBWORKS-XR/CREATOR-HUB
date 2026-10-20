// Synthetic unit fixtures only. No candidate, compiler, library or installer execution.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { yaml } = require('playwright-core/lib/utilsBundle');
const base = require('./linux-016-portable-package.cjs');
const p = require('./linux-016-portable-production.cjs');
const retirement = require('./linux-retirement-package.cjs');
const finite = require('./flatpak-package.cjs');
const modules = require('./module-archive.cjs');
const { fixture: privateFixture } = require('./fixtures/unix-payload-binding.cjs');
const { runtimeDescriptor } = require('./mcp-runtime-descriptor.cjs');
const ROOT = path.resolve(__dirname, '..');
const PYTHON = process.platform === 'win32' ? 'python' : 'python3';
const BASH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const bytes = value => Buffer.from(JSON.stringify(value, null, 2));
function temp(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hub016-production-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
function put(root, name, body, mode = 0o644) {
  const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { flag: 'wx', mode }); fs.chmodSync(file, mode); return file;
}
function elf() {
  const out = Buffer.alloc(64); out.set([127, 69, 76, 70, 2, 1, 1]); out.writeUInt16LE(3, 16); out.writeUInt16LE(62, 18); return out;
}
function environment() {
  return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_REF: p.BRANCH, GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${p.WORKFLOW}@${p.BRANCH}`,
    GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1' };
}
function candidate(t) {
  const root = temp(t), input = path.join(root, 'input'), receipts = path.join(root, 'receipts'); fs.mkdirSync(input); fs.mkdirSync(receipts);
  const f = privateFixture(); f.expected.version = f.prepared.hubVersion = p.VERSION;
  f.artifactSize = f.artifact.size_in_bytes; f.jobId = 303; f.jobs[0].id = f.jobId;
  f.jobs[0].head_sha = f.expected.sourceCommit; f.job = structuredClone(f.jobs[0]); f.run.head_branch = 'validation/unix-payload-016';
  const pins = { schemaVersion: 2, profile: p.PROFILE, sourceCommit: 'd'.repeat(40), sourceTree: 'e'.repeat(40),
    runId: 9001, runAttempt: 2, jobId: 9002, workflowId: 9003, artifactId: 9004, receiptsArtifactId: 9005,
    artifact: { size: 1234, sha256: 'f'.repeat(64) }, receiptsArtifact: { size: 4321, sha256: 'a'.repeat(64) },
    handoffSha256: 'b'.repeat(64), files: {} };
  const repo = { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' };
  const proof = { run: { id: 9001, run_attempt: 2, status: 'completed', conclusion: 'success', event: 'workflow_dispatch',
    head_sha: pins.sourceCommit, head_branch: 'validation/linux-integrated-candidate-016', path: '.github/workflows/unix-managed-assembly.yml',
    workflow_id: 9003, repository: repo, head_repository: repo },
    job: { id: 9002, run_id: 9001, run_attempt: 2, head_sha: pins.sourceCommit, status: 'completed', conclusion: 'success',
      name: 'assembly (linux, ubuntu-22.04, synthetic...)', labels: ['ubuntu-22.04'], started_at: '2026-10-19T10:00:00Z', completed_at: '2026-10-19T10:10:00Z' },
    workflow: { id: 9003, path: '.github/workflows/unix-managed-assembly.yml' }, commit: { sha: pins.sourceCommit, tree: { sha: pins.sourceTree } } };
  for (const [field, id, name, pin] of [['artifact', 9004, 'signed-unix-hub-linux-9001-2', pins.artifact],
    ['receiptsArtifact', 9005, 'signed-linux-receipts-9001-2', pins.receiptsArtifact]]) proof[field] = { id, name,
    expired: false, size_in_bytes: pin.size, digest: `sha256:${pin.sha256}`, created_at: '2026-10-19T10:09:00Z',
    workflow_run: { id: 9001, head_sha: pins.sourceCommit, head_branch: proof.run.head_branch, repository_id: repo.id, head_repository_id: repo.id } };
  const manifest = { schemaVersion: 1, platform: 'linux', arch: 'x86_64', modules: {
    mcp: { version: '2.7.7', executable: finite.MEMBERS[0], files: {} }, setup: { version: '0.3.7', executable: finite.MEMBERS[9], files: {} } },
    managedRouting: { protocol: 1, files: {} } };
  const raw = Object.fromEntries([...finite.MEMBERS, ...finite.ROUTING].map(n => [n, Buffer.from(`synthetic ${n}`)]));
  for (const [n, body] of Object.entries(raw)) {
    const files = n.startsWith('routing/') ? manifest.managedRouting.files : manifest.modules[n.startsWith('mcp/') ? 'mcp' : 'setup'].files;
    files[n] = base.record(body).sha256;
    if (!n.startsWith('routing/') || n === 'routing/creator-hub-mcp-router') f.prepared.files[n.startsWith('routing/') ? 'router-for-package' : `modules/${n}`] = {
      ...base.record(body), mode: modules.modeFor(manifest, n) };
  }
  const archive = Buffer.from('synthetic opaque archive');
  manifest.payloadArchive = { schemaVersion: 1, file: 'modules.tar.gz', ...base.record(archive),
    unpackedSize: Object.values(raw).reduce((n, b) => n + b.length, 0),
    files: Object.fromEntries(Object.entries(raw).map(([n, b]) => [n, { size: b.length, mode: modules.modeFor(manifest, n) }])) };
  f.prepared.files['mcp-runtime.json'] = { ...base.record(Buffer.from(JSON.stringify(runtimeDescriptor(manifest, p.VERSION)))), mode: 0o644 };
  const descriptor = bytes(manifest), hub = Buffer.concat([elf(), descriptor,
    Buffer.from(require('./build-unified.cjs').PORTABLE_ROOT_WITNESSES.join('\n')), Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK')]);
  const debHub = Buffer.from(hub); debHub.write('DEB', hub.length - 3, 'ascii');
  const helper = { ...base.record(Buffer.from('synthetic helper')), mode: 0o755, uid: 0, gid: 0 };
  const policy = { ...base.record(Buffer.from('synthetic policy')), mode: 0o644, uid: 0, gid: 0 };
  const staging = { schemaVersion: 2, acceptanceOnly: true, sourceCommit: pins.sourceCommit, platform: 'linux', arch: 'x86_64',
    rootFeature: retirement.PRODUCTION_ROOT_FEATURE, helperFeature: retirement.PRODUCTION_HELPER_FEATURE,
    files: { [retirement.HELPER]: helper, [retirement.POLICY]: policy }, profile: retirement.PRODUCTION_PROFILE,
    productionContract: retirement.PRODUCTION_CONTRACT, ...retirement.FLAGS };
  const production = { schemaVersion: 1, profile: retirement.PRODUCTION_PROFILE, sourceCommit: pins.sourceCommit, sourceTree: pins.sourceTree,
    compiledFeatures: [...p.FEATURES], rawHub: base.record(hub), staging };
  const assembly = { schemaVersion: 1, product: 'com.creatorworks.hub.unix-signed-assembly', platform: 'linux', arch: 'x86_64', hubVersion: p.VERSION,
    assemblyCommit: pins.sourceCommit, privateSource: f.prepared.source, handoffSha256: pins.handoffSha256, compiledFeatures: [...p.FEATURES],
    portableHostBuild: { schemaVersion: 1, version: p.VERSION, target: p.TARGET, sourceCommit: pins.sourceCommit, sourceTree: pins.sourceTree,
      compiledFeatures: [...p.FEATURES], startupImageBinding: 1, rawHub: base.record(hub) }, productionMigration: production, mcpMode: 'writable',
    privateModulesRecompiled: false, privateModulesResigned: false, nativeGuiAccepted: false, releaseReady: false };
  const deb = Buffer.from('synthetic opaque DEB; never executed');
  const integrity = { schemaVersion: 1, platform: 'linux', arch: 'x86_64', integrityPassed: true, experimental: true, mcpMode: 'writable',
    writableGuiAccepted: false, releaseReady: false, packages: [{ format: 'deb', path: p.DEB_MEMBER, sha256: base.record(deb).sha256,
      hubSha256: base.record(debHub).sha256, files: modules.rawFiles(manifest) }] };
  const service = { ...base.record(retirement.SERVICE_BYTES), mode: 0o644, uid: 0, gid: 0 };
  const packageIntegrity = { schemaVersion: 2, acceptanceOnly: true, archiveIntegrityPassed: true,
    package: { path: p.DEB_MEMBER, ...base.record(deb) }, files: { ...staging.files, [retirement.SERVICE]: service }, systemInstallationTested: false,
    profile: retirement.PRODUCTION_PROFILE, productionContract: retirement.PRODUCTION_CONTRACT, sourceCommit: pins.sourceCommit,
    rootFeature: retirement.PRODUCTION_ROOT_FEATURE, helperFeature: retirement.PRODUCTION_HELPER_FEATURE, ...retirement.FLAGS };
  const bodies = { 'creator-hub': hub, 'modules.tar.gz': archive, 'builtin-manifest.json': descriptor, [p.DEB_MEMBER]: deb,
    'signed-unix-assembly.json': bytes(assembly), 'unix-package-integrity.json': bytes(integrity), 'linux-retirement-candidate.json': bytes(staging),
    'linux-retirement-package-integrity.json': bytes(packageIntegrity), 'direct-features-candidate.json': bytes({ schemaVersion: 1,
      scope: 'linux-direct-features-candidate', activationRunsOutsideSandbox: true, nativeGuiAccepted: false, migrationAccepted: false,
      signedUpdateAccepted: false, flatpakActivationAccepted: false, releaseReady: false }) };
  function save() {
    for (const [n, b] of Object.entries(bodies)) if (n !== 'linux-byte-receipts.json') pins.files[n] = base.record(b);
    bodies['linux-byte-receipts.json'] = bytes({ schemaVersion: 1, sourceCommit: pins.sourceCommit, runId: pins.runId, runAttempt: pins.runAttempt,
      files: Object.fromEntries(base.INPUTS.map(n => [n, { bytes: pins.files[n].size, sha256: pins.files[n].sha256 }])),
      nativeGuiAccepted: false, migrationAccepted: false, signedUpdateAccepted: false, releaseReady: false });
    pins.files['linux-byte-receipts.json'] = base.record(bodies['linux-byte-receipts.json']);
    for (const n of p.INPUTS) fs.writeFileSync(path.join(input, n === p.DEB_MEMBER ? 'production-root.deb' : n), bodies[n]);
    for (const n of p.RECEIPTS) fs.writeFileSync(path.join(receipts, n), bodies[n]);
  }
  save(); return { root, input, receipts, pins, assembly, production, packageIntegrity, bodies, save, binding: { pins, proof, privateProof: f } };
}
test('production identity is closed over, disjoint from prototype and has no policy or environment fallback', t => {
  const c = candidate(t), env = environment(); p.validatePins(c.pins); p.admission(env, 'linux', 'x64');
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.FEATURES));
  assert.deepEqual(p.FEATURES, ['integrated-features', 'experimental-flatpak-host', 'linux-production-migration', 'experimental-linux-portable-update']);
  assert.throws(() => base.production016({ features: p.FEATURES }));
  assert.throws(() => base.validatePins(c.pins)); assert.throws(() => base.validatePins(c.pins, p));
  assert.throws(() => base.admission(env, 'linux', 'x64')); assert.throws(() => p.admission({ ...env, GITHUB_REF: base.BRANCH }, 'linux', 'x64'));
  assert.throws(() => p.admission({ ...env, GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${base.WORKFLOW}@${base.BRANCH}` }, 'linux', 'x64'));
  for (const [name, value] of [['GITHUB_EVENT_NAME', 'push'], ['RUNNER_ENVIRONMENT', 'self-hosted'], ['LD_PRELOAD', 'foreign'], ['CREATOR_HUB_SIGNING_KEY_PATH', 'foreign']]) {
    assert.throws(() => p.admission({ ...env, [name]: value }, 'linux', 'x64'));
  }
  const privateInput = (({ expected, prepared, artifactSize, jobId }) => ({ expected, prepared, artifactSize, jobId }))(c.binding.privateProof);
  assert.equal(p.preflight({ ...env, ASSEMBLY_PINS: JSON.stringify(c.pins), PRIVATE_INPUT: JSON.stringify(privateInput), PROFILE: 'prototype' }, 'linux', 'x64').pins.profile, p.PROFILE);
  for (const name of Object.keys(c.pins)) { const bad = structuredClone(c.pins); delete bad[name]; assert.throws(() => p.validatePins(bad)); }
  for (const name of Object.keys(c.pins.files)) { const bad = structuredClone(c.pins); delete bad.files[name]; assert.throws(() => p.validatePins(bad)); }
  const args = p.bundleArgs(ROOT, '/owned/overlay.json'); assert.equal(args[args.indexOf('--features') + 1], p.FEATURES.join(','));
  assert.equal(args.includes('build'), false); assert.deepEqual(base.FEATURES, ['integrated-features', 'experimental-flatpak-host', 'experimental-linux-migration', 'experimental-linux-portable-host']);
});
test('production preflight needs only Node standard modules and makes no subprocess or filesystem reads', t => {
  const c = candidate(t), privateInput = (({ expected, prepared, artifactSize, jobId }) => ({ expected, prepared, artifactSize, jobId }))(c.binding.privateProof);
  const script = String.raw`
const fs=require('node:fs'),Module=require('node:module'),assert=require('node:assert/strict');
const input=JSON.parse(fs.readFileSync(0,'utf8')),load=Module._load;
Module._load=function(name,parent,...rest) {
  assert.ok(name.startsWith('node:') || name===input.entry || name==='./linux-016-portable-package.cjs','Nonstandard preflight dependency');
  return load.call(this,name,parent,...rest);
};
require('node:child_process').execFileSync=()=>assert.fail('Preflight subprocess');
const producer=require(input.entry); fs.readFileSync=()=>assert.fail('Preflight filesystem read');
producer.preflight(input.env,'linux','x64');
`;
  execFileSync(process.execPath, ['-e', script], { input: JSON.stringify({ entry: path.join(__dirname, 'linux-016-portable-production.cjs'),
    env: { ...environment(), ASSEMBLY_PINS: JSON.stringify(c.pins), PRIVATE_INPUT: JSON.stringify(privateInput) } }) });
});
test('both exact production Root proofs, original private bytes and staged production receipts bind before packaging', t => {
  const c = candidate(t), verified = p.validateReceipts(c.input, c.receipts, c.binding);
  assert.deepEqual(verified.productionMigration, c.production); assert.deepEqual(verified.bytes['creator-hub'], c.bodies['creator-hub']);
  for (const change of [a => delete a.productionMigration, a => a.compiledFeatures = [...base.FEATURES],
    a => a.productionMigration.sourceTree = '0'.repeat(40), a => a.productionMigration.rawHub.sha256 = '0'.repeat(64),
    a => a.portableHostBuild.rawHub.sha256 = '0'.repeat(64), a => a.productionMigration.staging.profile = 'integrated-candidate']) {
    const bad = structuredClone(c.assembly); change(bad); c.bodies['signed-unix-assembly.json'] = bytes(bad); c.save();
    assert.throws(() => p.validateReceipts(c.input, c.receipts, c.binding));
  }
});
test('actual production DEB verifier uses fixed trusted modules and exact package/root/helper/policy/service bytes', t => {
  const c = candidate(t), baseline = p.validateReceipts(c.input, c.receipts, c.binding); let called = 0;
  const run = (command, args, options) => {
    called++; assert.equal(command, 'python3'); assert.deepEqual(args.slice(0, 3), ['-B', '-c', p.PRODUCTION_DEB_CHECK]);
    assert.equal(args[3], c.root); assert.equal(args[4], path.join(c.input, 'production-root.deb')); assert.equal(options.maxBuffer, 65536);
    const config = JSON.parse(options.input); assert.equal(Buffer.from(config.manifest, 'base64').compare(c.bodies['builtin-manifest.json']), 0);
    const packageFiles = Object.fromEntries([['usr/bin/creator-hub', { ...baseline.debHub, mode: 0o755 }],
      ['usr/lib/Creator Hub/modules.tar.gz', { ...c.pins.files['modules.tar.gz'], mode: 0o644 }],
      ...Object.entries(c.packageIntegrity.files).map(([n, f]) => [n.slice(1), { size: f.size, sha256: f.sha256, mode: f.mode }])]);
    return JSON.stringify({ profile: retirement.PRODUCTION_PROFILE, files: c.packageIntegrity.files, packageFiles });
  };
  assert.equal(p.productionDeb(c.root, c.input, c.receipts, c.pins, baseline, run).nativeExecution, false); assert.equal(called, 1);
  assert.throws(() => p.productionDeb(c.root, c.input, c.receipts, c.pins, baseline, () => '{}'), /Actual production DEB/);
  c.packageIntegrity.profile = 'integrated-candidate'; fs.writeFileSync(path.join(c.receipts, 'linux-retirement-package-integrity.json'), bytes(c.packageIntegrity));
  assert.throws(() => p.productionDeb(c.root, c.input, c.receipts, c.pins, baseline, () => assert.fail('Invalid receipt reached native verifier')));
});
test('embedded production DEB inspection actually validates synthetic control, policy, service, Root and package archives', t => {
  const c = candidate(t), hub = Buffer.from(c.bodies['creator-hub']); hub.write('DEB', hub.length - 3, 'ascii');
  const files = { 'usr/bin/creator-hub': { body: hub, mode: 0o755 },
    'usr/lib/Creator Hub/modules.tar.gz': { body: c.bodies['modules.tar.gz'], mode: 0o644 },
    [retirement.HELPER.slice(1)]: { body: elf(), mode: 0o755 },
    [retirement.POLICY.slice(1)]: { body: fs.readFileSync(path.join(ROOT, 'packaging/linux', retirement.PRODUCTION_POLICY_SOURCE)), mode: 0o644 },
    [retirement.SERVICE.slice(1)]: { body: retirement.SERVICE_BYTES, mode: 0o644 } };
  const config = { manifest: c.bodies['builtin-manifest.json'].toString('base64'), pins: Object.fromEntries([
    ['hub', 'usr/bin/creator-hub'], ['modulesArchive', 'usr/lib/Creator Hub/modules.tar.gz'], ['helper', retirement.HELPER.slice(1)],
    ['policy', retirement.POLICY.slice(1)], ['service', retirement.SERVICE.slice(1)]].map(([key, name]) => [key, base.record(files[name].body)])) };
  const inspect = String.raw`
import base64,io,json,subprocess,sys,tarfile,types
c=json.load(sys.stdin)
files={n:{**v,'body':base64.b64decode(v['body'])} for n,v in c['files'].items()}
control=b'Package: creator-hub\nVersion: 0.1.16\nArchitecture: amd64\nDescription: Creator Hub\n Manage projects, connect AI tools to Unity and set up Creator SDK projects.\nDepends: policykit-1, libwebkit2gtk-4.1-0, libgtk-3-0\n'
def archive(entries,parents=False):
    out=io.BytesIO()
    with tarfile.open(fileobj=out,mode='w',format=tarfile.USTAR_FORMAT) as z:
        if parents:
            dirs=set()
            for n in entries:
                p=n.split('/')
                dirs.update('/'.join(p[:i]) for i in range(1,len(p)))
            for n in sorted(dirs):
                row=tarfile.TarInfo(n); row.type=tarfile.DIRTYPE; row.mode=0o755; z.addfile(row)
        for n,v in entries.items():
            row=tarfile.TarInfo(n); row.mode=v['mode']; row.size=len(v['body']); row.type=tarfile.SYMTYPE if v.get('link') else tarfile.REGTYPE
            if v.get('link'): row.linkname='foreign'; row.size=0
            z.addfile(row,io.BytesIO(v['body']) if row.isfile() else None)
    return out.getvalue()
if c['case']=='bad-policy': files['usr/share/polkit-1/actions/com.creatorworks.hub.deb-retirement.policy']['body']=files['usr/share/polkit-1/actions/com.creatorworks.hub.deb-retirement.policy']['body'].replace(b'auth_admin',b'yes')
if c['case']=='bad-service': files['usr/share/dbus-1/services/com.creatorworks.hub.Host.service']['body']+=b'foreign'
if c['case']=='bad-root': files['usr/bin/creator-hub']['body']=b'not ELF'
if c['case']=='bad-helper': files['usr/libexec/creator-hub-deb-retirement-helper']['mode']=0o777
if c['case']=='link': files['usr/libexec/creator-hub-deb-retirement-helper']['link']=True
if c['case']=='extra': files['usr/libexec/foreign']={'body':b'foreign','mode':0o755}
controls={'control':{'body':control,'mode':0o644},'md5sums':{'body':b'','mode':0o644}}
if c['case']=='script': controls['postinst']={'body':b'not executable in this test','mode':0o755}
data=archive(files,True); ctrl=archive(controls); calls=[]
def query(args,**kwargs):
    assert args[0]=='/usr/bin/dpkg-deb' and args[1] in ('--ctrl-tarfile','--fsys-tarfile')
    calls.append(args[1]); raw=ctrl if args[1]=='--ctrl-tarfile' else data
    if c['case']=='query-failed': raise subprocess.CalledProcessError(2,args)
    if 'stdout' in kwargs: kwargs['stdout'].write(raw); return types.SimpleNamespace(returncode=0,stderr=b'')
    return types.SimpleNamespace(returncode=0,stderr=b'',stdout=raw)
subprocess.run=query
sys.argv=['inspection',c['root'],'synthetic.deb']; sys.stdin=io.StringIO(json.dumps(c['config']))
exec(compile(c['check'],'<production-deb-check>','exec'),{})
assert calls==['--ctrl-tarfile','--fsys-tarfile','--fsys-tarfile']
`;
  const data = { files: Object.fromEntries(Object.entries(files).map(([n, v]) => [n, { ...v, body: v.body.toString('base64') }])),
    config, root: ROOT, check: p.PRODUCTION_DEB_CHECK, case: 'valid' };
  const actual = JSON.parse(execFileSync(PYTHON, ['-B', '-c', inspect], { input: JSON.stringify(data), encoding: 'utf8' }));
  assert.equal(actual.profile, retirement.PRODUCTION_PROFILE);
  assert.deepEqual(actual.packageFiles['usr/bin/creator-hub'], { ...base.record(hub), mode: 0o755 });
  assert.deepEqual(actual.files[retirement.SERVICE], { ...base.record(retirement.SERVICE_BYTES), mode: 0o644, uid: 0, gid: 0 });
  for (const failure of ['bad-policy', 'bad-service', 'bad-root', 'bad-helper', 'link', 'extra', 'script', 'query-failed']) {
    assert.throws(() => execFileSync(PYTHON, ['-B', '-c', inspect], { input: JSON.stringify({ ...data, case: failure }), stdio: 'pipe' }), failure);
  }
});
test('production ZIP maps only the fixed DEB member to a safe basename, without relaxing prototype archive rules', t => {
  const root = temp(t), zip = path.join(root, 'input.zip'), staged = path.join(root, 'staged'), data = Buffer.from('synthetic deb');
  execFileSync(PYTHON, ['-B', '-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"w"); z.writestr(sys.argv[2],sys.stdin.buffer.read()); z.close()', zip, p.DEB_MEMBER], { input: data });
  const run = (command, args, options) => { assert.equal(command, 'python3'); return execFileSync(PYTHON, args, options); };
  p.stageZip(zip, staged, { [p.DEB_MEMBER]: base.record(data) }, base.MAIN_ALLOWED, run);
  assert.deepEqual(fs.readFileSync(path.join(staged, 'production-root.deb')), data);
  assert.throws(() => base.stageZip(zip, path.join(root, 'old'), { [p.DEB_MEMBER]: base.record(data) }, base.MAIN_ALLOWED,
    (cmd, args, opts) => execFileSync(PYTHON, args, { ...opts, stdio: 'pipe' })));
});
function selectorFixture(t) {
  const c = candidate(t), source = path.join(c.root, 'checkout'), output = path.join(c.root, 'output'); fs.mkdirSync(source); fs.mkdirSync(output);
  const files = { 'native/linux-portable-deployment/Cargo.toml': Buffer.from('synthetic Cargo source'),
    'native/linux-portable-deployment/Cargo.lock': Buffer.from('synthetic locked dependencies'),
    'native/linux-portable-deployment/src/bin/creator-hub-portable-selector.rs': Buffer.from('synthetic selector source'),
    'src-tauri/src/catalog-key.pub': fs.readFileSync(path.join(ROOT, 'src-tauri/src/catalog-key.pub')) };
  const blobs = new Map();
  for (const [n, body] of Object.entries(files)) { put(source, n, body); blobs.set(crypto.createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex'), { name: n, bytes: body }); }
  const tools = Object.fromEntries(['rustc', 'cargo'].map(n => [n, put(c.root, `tools/${n}`, Buffer.from(`synthetic ${n}`), 0o755)]));
  const calls = [];
  const run = (command, args) => {
    calls.push({ command, args });
    if (command === 'git' && args[0] === 'ls-tree') return [...blobs].map(([oid, b]) => `100644 blob ${oid}\t${b.name}\0`).join('');
    if (command === 'git' && args[0] === 'cat-file') return blobs.get(args[2]).bytes;
    if (command === 'rustc') return 'rustc 1.99.0 (synthetic)\nhost: x86_64-unknown-linux-gnu\n';
    if (command === 'cargo') return 'cargo 1.99.0 (synthetic)\n';
    if (command === 'rustup') return tools[args.at(-1)];
    if (command === tools.cargo && args[0] === 'metadata') return JSON.stringify({ packages: [{ name: 'creator-hub-linux-portable-deployment', version: '0.1.0',
      features: { default: [], 'experimental-restart': [] }, dependencies: [], targets: [{ name: 'creator-hub-portable-selector', kind: ['bin'] }] }] });
    if (command === tools.cargo && args[0] === 'build') {
      const target = args[args.indexOf('--target-dir') + 1]; put(target, `${p.TARGET}/release/creator-hub-portable-selector`, elf(), 0o755); return '';
    }
    assert.fail(`Unexpected tool action: ${command} ${args.join(' ')}`);
  };
  return { ...c, source, output, files, blobs, tools, calls, run };
}
test('selector build is a separate locked restart-enabled owned tool with source/public-key/compiler byte binding', t => {
  const c = selectorFixture(t), result = p.buildSelector(c.source, c.output, c.pins, c.run);
  assert.deepEqual(result.proof.executable, base.record(elf())); assert.deepEqual(result.proof.features, ['experimental-restart']);
  assert.deepEqual(result.proof.publicKeySource, base.record(c.files['src-tauri/src/catalog-key.pub']));
  assert.equal(result.proof.sourceCommit, c.pins.sourceCommit); assert.equal(result.proof.sourceTree, c.pins.sourceTree);
  assert.equal(result.proof.rootRecompiled, false); assert.equal(result.proof.privateModulesRecompiled, false); assert.equal(result.proof.releaseReady, false);
  const builds = c.calls.filter(x => x.args[0] === 'build'); assert.equal(builds.length, 1);
  assert.ok(builds[0].args.includes('--locked') && builds[0].args.includes('--no-default-features'));
  assert.equal(builds[0].args[builds[0].args.indexOf('--bin') + 1], 'creator-hub-portable-selector');
  assert.equal(builds[0].args[builds[0].args.indexOf('--features') + 1], 'experimental-restart');
});
test('selector source drift, compiler mismatch and foreign Cargo path dependencies refuse before accepted output', t => {
  const c = selectorFixture(t); fs.writeFileSync(path.join(c.source, 'src-tauri/src/catalog-key.pub'), 'changed public source');
  assert.throws(() => p.buildSelector(c.source, c.output, c.pins, c.run), /differs from assembly/);
  assert.equal(c.calls.some(x => x.args[0] === 'build'), false);
  const d = selectorFixture(t);
  assert.throws(() => p.buildSelector(d.source, d.output, d.pins, (cmd, args, opts) => cmd === 'rustc' ? 'rustc 1.98.0 (other)' : d.run(cmd, args, opts)));
  const e = selectorFixture(t);
  assert.throws(() => p.buildSelector(e.source, e.output, e.pins, (cmd, args, opts) => cmd === e.tools.cargo && args[0] === 'metadata'
    ? JSON.stringify({ packages: [{ name: 'creator-hub-linux-portable-deployment', version: '0.1.0', features: { default: [], 'experimental-restart': [] },
      dependencies: [{ path: '/foreign/root' }], targets: [] }] }) : e.run(cmd, args, opts)), /path dependencies/);
});
test('selector source inventory refuses nonregular, foreign, incomplete and incorrectly hashed Git blobs', t => {
  for (const changed of ['symlink', 'foreign', 'missing-key', 'blob']) {
    const c = selectorFixture(t);
    assert.throws(() => p.buildSelector(c.source, c.output, c.pins, (command, args, options) => {
      const result = c.run(command, args, options);
      if (command === 'git' && args[0] === 'ls-tree') {
        if (changed === 'symlink') return result.replace('100644 blob', '120000 blob');
        if (changed === 'foreign') return result.replace('native/linux-portable-deployment/Cargo.toml', 'src-tauri/Cargo.toml');
        if (changed === 'missing-key') return result.split('\0').filter(row => !row.includes('catalog-key.pub')).join('\0');
      }
      if (changed === 'blob' && command === 'git' && args[0] === 'cat-file') return Buffer.from('wrong Git object');
      return result;
    }));
    assert.equal(c.calls.some(x => x.args[0] === 'build'), false);
  }
});
test('selector refuses failed compilation and post-build drift in source, public key, mirror or bound tools', t => {
  for (const changed of ['source', 'key', 'mirror', 'compiler', 'cargo', 'failed-build']) {
    const c = selectorFixture(t);
    assert.throws(() => p.buildSelector(c.source, c.output, c.pins, (command, args, options) => {
      if (command !== c.tools.cargo || args[0] !== 'build') return c.run(command, args, options);
      if (changed === 'failed-build') throw new Error('Synthetic compiler refusal');
      const result = c.run(command, args, options);
      const destination = changed === 'source' ? path.join(c.source, 'native/linux-portable-deployment/Cargo.toml')
        : changed === 'key' ? path.join(c.source, 'src-tauri/src/catalog-key.pub')
          : changed === 'mirror' ? path.join(c.output, 'selector-source/native/linux-portable-deployment/Cargo.lock')
            : c.tools[changed === 'compiler' ? 'rustc' : 'cargo'];
      fs.appendFileSync(destination, 'changed during synthetic build'); return result;
    }), changed === 'failed-build' ? /Synthetic compiler refusal/ : /Bounded|Input changed/);
  }
});
test('selector becomes its own exact signed-inventory entry before complete TAR hashing, never inferred from Root', async t => {
  if (process.platform === 'win32') return t.skip('Canonical Unix modes and native inventory run in the Linux preflight');
  const c = candidate(t), tree = path.join(c.root, 'tree'); fs.mkdirSync(tree, { mode: 0o755 });
  const raw = c.bodies['creator-hub'], app = Buffer.from(raw); app.write('APP', app.length - 3, 'ascii');
  put(tree, 'usr/bin/creator-hub', app, 0o755); put(tree, 'AppRun', '#!/bin/sh\nexec "$APPDIR/usr/bin/creator-hub" "$@"\n', 0o755);
  const profile = p.hostProfile(raw, app, c.assembly.portableHostBuild, c.pins);
  const before = base.attachHostProfile(tree, base.inventory(tree), profile, base.record(app));
  const selector = { file: put(c.root, 'selector', elf(), 0o755), proof: { executable: base.record(elf()) } };
  const after = p.attachSelector(tree, before, selector);
  assert.deepEqual(after.entries[p.SELECTOR_ENTRYPOINT], { kind: 'file', ...base.record(elf()), mode: 0o755 });
  const tar = path.join(c.root, 'complete.gz'), archive = await base.packTar(tree, tar, after), manifest = p.manifest(c.pins, after, archive);
  assert.deepEqual(manifest.entries[p.SELECTOR_ENTRYPOINT], after.entries[p.SELECTOR_ENTRYPOINT]);
  execFileSync(PYTHON, ['-B', '-c', 'import json,sys,tarfile,hashlib; p=json.load(sys.stdin); z=tarfile.open(sys.argv[1],"r:gz"); r=z.getmember(p["name"]); b=z.extractfile(r).read(); assert r.mode==493 and r.isfile() and hashlib.sha256(b).hexdigest()==p["sha256"]', tar],
    { input: JSON.stringify({ name: p.SELECTOR_ENTRYPOINT, sha256: selector.proof.executable.sha256 }) });
  assert.throws(() => p.attachSelector(tree, after, selector), /cannot be adopted/);
});
test('Native Support alias is a fresh ordinary byte-identical copy with source identity retained', t => {
  const root = temp(t), image = put(root, `Creator Hub_${p.VERSION}_amd64.AppImage`, Buffer.concat([elf(), Buffer.from('synthetic image')]), 0o755);
  const target = path.join(root, `Creator.Hub.Native.Support_${p.VERSION}_amd64.AppImage`), before = p.imageSnapshot(image);
  const proof = p.nativeSupportAlias(image, target); assert.deepEqual(fs.readFileSync(target), fs.readFileSync(image));
  assert.deepEqual(p.imageSnapshot(image), before); assert.equal(proof.identicalBytes, true); assert.equal(proof.sourceIdentityRechecked, true);
  assert.equal(proof.releaseReady, false); assert.equal(proof.nativeExecution, false);
  fs.writeFileSync(target, 'foreign existing alias'); assert.throws(() => p.nativeSupportAlias(image, target));
  assert.equal(fs.readFileSync(target, 'utf8'), 'foreign existing alias'); assert.deepEqual(p.imageSnapshot(image), before);
  assert.throws(() => p.nativeSupportAlias(image, path.join(root, 'other.AppImage')));
});
test('alias refuses source replacement after copy even when replacement bytes are identical', t => {
  const root = temp(t), name = `Creator Hub_${p.VERSION}_amd64.AppImage`, image = put(root, name, elf());
  const alias = path.join(root, `Creator.Hub.Native.Support_${p.VERSION}_amd64.AppImage`), original = fs.copyFileSync;
  const replacement = put(root, 'replacement', elf());
  t.mock.method(fs, 'copyFileSync', (...args) => { original(...args); fs.renameSync(image, path.join(root, 'original-kept')); fs.renameSync(replacement, image); });
  assert.throws(() => p.nativeSupportAlias(image, alias), /identity\/bytes changed/);
  assert.deepEqual(fs.readFileSync(path.join(root, 'original-kept')), elf());
});
test('bounded image snapshot refuses a named replacement during reading and closes its owned descriptor', t => {
  const root = temp(t), image = put(root, `Creator Hub_${p.VERSION}_amd64.AppImage`, elf());
  const replacement = put(root, 'replacement', elf()), original = fs.readSync, close = fs.closeSync; let swapped = false, closed = false;
  t.mock.method(fs, 'readSync', (...args) => {
    const count = original(...args);
    if (!swapped) { swapped = true; fs.renameSync(image, path.join(root, 'original-kept')); fs.renameSync(replacement, image); }
    return count;
  });
  t.mock.method(fs, 'closeSync', (...args) => { closed = true; return close(...args); });
  assert.throws(() => p.imageSnapshot(image), /Named image changed/); assert.ok(swapped && closed);
  assert.deepEqual(fs.readFileSync(path.join(root, 'original-kept')), elf());
});
test('real Unix alias refuses linked inputs and foreign dangling targets without following or overwriting', t => {
  if (process.platform === 'win32') return t.skip('Actual Unix links belong to native Linux preflight');
  const root = temp(t), image = put(root, `Creator Hub_${p.VERSION}_amd64.AppImage`, elf()), alias = path.join(root, `Creator.Hub.Native.Support_${p.VERSION}_amd64.AppImage`);
  fs.symlinkSync('missing', alias); assert.throws(() => p.nativeSupportAlias(image, alias)); assert.equal(fs.readlinkSync(alias), 'missing');
  fs.unlinkSync(alias); fs.linkSync(image, path.join(root, 'hardlink')); assert.throws(() => p.nativeSupportAlias(image, alias));
});
test('production workflow and embedded inspection scripts parse, remain manual/read-only, and never build Root or private modules', () => {
  for (const file of ['linux-016-portable-production.cjs', 'linux-016-portable-production.test.cjs', 'linux-016-portable-package.cjs']) {
    execFileSync(process.execPath, ['--check', path.join(__dirname, file)]);
  }
  for (const source of [base.ZIP_STAGE, p.PRODUCTION_DEB_CHECK]) execFileSync(PYTHON, ['-B', '-c', 'import ast,sys; ast.parse(sys.stdin.read())'], { input: source });
  const parsed = yaml.parse(fs.readFileSync(path.join(ROOT, p.WORKFLOW), 'utf8'), { uniqueKeys: true });
  execFileSync(PYTHON, ['-B', '-c', 'import sys,yaml; p=yaml.safe_load(sys.stdin.read()); assert set(p["jobs"])=={"package"}'],
    { input: fs.readFileSync(path.join(ROOT, p.WORKFLOW), 'utf8') });
  assert.deepEqual(Object.keys(parsed.on), ['push', 'workflow_dispatch']);
  assert.deepEqual(parsed.on.push, { branches: ['validation/linux-016-portable-production'] });
  assert.deepEqual(Object.keys(parsed.jobs), ['package']);
  assert.ok(parsed.jobs.package.if.includes("github.event_name == 'workflow_dispatch'"));
  assert.deepEqual(parsed.permissions, { contents: 'read', actions: 'read' }); assert.equal(parsed.jobs.package['runs-on'], 'ubuntu-22.04');
  assert.ok(parsed.jobs.package.if.includes(p.BRANCH)); assert.equal(parsed.jobs.package.env, undefined); assert.equal(parsed.env, undefined);
  assert.doesNotMatch(parsed.jobs.package.if, /\brunner\./, 'runner context is unavailable in job-level if/env');
  assert.equal(parsed.jobs.package.steps[0].with['persist-credentials'], false);
  for (const input of Object.values(parsed.on.workflow_dispatch.inputs)) { assert.equal(input.required, true); assert.equal(input.type, 'string'); assert.equal(input.default, undefined); }
  for (const step of parsed.jobs.package.steps) {
    if (step.run) {
      execFileSync(BASH, ['--noprofile', '--norc', '-n'], { input: step.run });
      assert.doesNotMatch(step.run, /cargo (?:run|install)|--manifest-path src-tauri|--manifest-path modules\/|gh (?:workflow run|release)|minisign|--appimage-extract/);
    }
    if (step.uses?.startsWith('actions/upload-artifact')) { assert.equal(step.with['compression-level'], 0); assert.doesNotMatch(step.with.path, /original\.AppDir|selector-source/); }
  }
  const downloads = parsed.jobs.package.steps.filter(step => step.env?.GH_TOKEN);
  assert.equal(downloads.length, 1); assert.match(downloads[0].run, /\.cjs fetch/);
  assert.equal(parsed.jobs.package.steps.find(step => step.run?.includes('.cjs package')).env, undefined);
  const source = fs.readFileSync(path.join(__dirname, 'linux-016-portable-package.cjs'), 'utf8');
  const deb = source.indexOf('receipt.productionDeb = productionDeb('), selector = source.indexOf('selector = buildSelector('), bundle = source.indexOf('run(process.execPath, bundleArgs(');
  assert.ok(deb > 0 && selector > deb && bundle > selector);
  assert.ok(source.indexOf('finalInventory = attachSelector(') < source.indexOf('const tarBinding = await packTar('));
  assert.match(p.PRODUCTION_DEB_CHECK, /'production-migration-016'/); assert.match(p.PRODUCTION_DEB_CHECK, /inspect_deb/);
});
