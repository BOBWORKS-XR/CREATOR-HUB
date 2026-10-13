const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { PIN, FALSE_GATES, ARCHIVE_SCRIPT, admission, parseArgs, validateSource, archiveSpec, verifyMounted, run } = require('./macos-dmg-repack.cjs');
const { moduleFiles } = require('./build-unified.cjs');
const worker = require('./macos-dmg.cjs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');

function binding() {
  const repository = { id: PIN.repositoryId, full_name: PIN.repository };
  return {
    run: { id: PIN.runId, head_sha: PIN.head, run_attempt: 1, path: PIN.workflow, workflow_id: PIN.workflowId,
      status: 'completed', conclusion: 'failure', event: 'pull_request', head_branch: 'feature/unified-creator-hub',
      repository, head_repository: repository, pull_requests: [{ number: 21, head: { sha: PIN.head, repo: { id: PIN.repositoryId } },
        base: { sha: PIN.base, repo: { id: PIN.repositoryId } } }] },
    job: { id: PIN.jobId, run_id: PIN.runId, run_attempt: 1, head_sha: PIN.head, name: 'candidate (macos-15-intel)',
      status: 'completed', conclusion: 'failure', labels: ['macos-15-intel'], runner_group_name: 'GitHub Actions',
      started_at: '2026-10-13T21:21:35Z', completed_at: '2026-10-13T21:47:59Z', steps: [
        { name: 'Build and inspect real included payloads (MCP deliberately read-only)', conclusion: 'failure' },
        { name: 'Retain the actual failed Mac DMG inputs without changing their signatures', conclusion: 'success' }] },
    artifact: { id: PIN.artifactId, expired: false, name: `unified-unix-candidate-macOS-X64-${PIN.merge}`,
      digest: `sha256:${PIN.zipSha256}`, size_in_bytes: PIN.zipBytes, created_at: '2026-10-13T21:47:46Z',
      workflow_run: { id: PIN.runId, head_sha: PIN.head, repository_id: PIN.repositoryId, head_repository_id: PIN.repositoryId } },
    head: { sha: PIN.head, tree: { sha: PIN.tree } },
    merge: { sha: PIN.merge, tree: { sha: PIN.tree }, parents: [{ sha: PIN.base }, { sha: PIN.head }] },
  };
}

function temporary(t) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'mac-repack-unit-')));
  t.after(() => { assert.equal(fs.realpathSync(root), root); assert.equal(path.dirname(root), parent);
    fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}

test('diagnostic failure is intentional, never successful package admission; merge label is not head', () => {
  const proof = validateSource(binding());
  assert.equal(proof.sourceConclusion, 'failure'); assert.notEqual(PIN.head, PIN.merge);
  for (const name of Object.keys(FALSE_GATES)) assert.equal(proof[name], false);
  const absentHistoricalPr = binding(); absentHistoricalPr.run.pull_requests = [];
  assert.equal(validateSource(absentHistoricalPr).sourcePrMetadataPresent, false);
});

test('exact repo, failed job, run/attempt, commits/parents/tree, artifact size/digest and lifetime all bind', () => {
  const mutations = [b => b.run.repository.id++, b => b.run.head_repository.full_name = 'other/repo',
    b => b.run.conclusion = 'success', b => b.run.head_sha = PIN.merge, b => b.run.run_attempt++,
    b => b.run.workflow_id++, b => b.run.path = '.github/workflows/ci.yml',
    b => b.job.id++, b => b.job.conclusion = 'success', b => b.job.run_id++, b => b.job.run_attempt++,
    b => b.job.steps[1].conclusion = 'failure', b => b.job.labels = ['self-hosted'],
    b => b.artifact.id++, b => b.artifact.name = `unified-unix-candidate-macOS-X64-${PIN.head}`,
    b => b.artifact.digest = 'sha256:' + 'a'.repeat(64), b => b.artifact.expired = true, b => b.artifact.size_in_bytes++,
    b => b.artifact.workflow_run.head_repository_id++, b => b.artifact.created_at = '2026-10-13T22:00:00Z',
    b => b.merge.parents.reverse(), b => b.merge.tree.sha = 'a'.repeat(40), b => b.head.tree.sha = 'a'.repeat(40),
    b => b.run.pull_requests[0].head.repo.id++];
  for (const mutate of mutations) { const b = structuredClone(binding()); mutate(b); assert.throws(() => validateSource(b)); }
});

test('native Intel dedicated push admission is mandatory before local filesystem/tool use', async () => {
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'macOS', RUNNER_ARCH: 'X64',
    CREATOR_MACOS_DMG_EXPERIMENT: '1', CREATOR_MACOS_DMG_REPACK: '1', GITHUB_REPOSITORY: PIN.repository,
    GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/validation/mac-dmg-repack-014' };
  admission(env, 'darwin', 'x64');
  for (const [name, value] of [['RUNNER_ENVIRONMENT', 'self-hosted'], ['GITHUB_REPOSITORY', 'other/repo'],
    ['GITHUB_EVENT_NAME', 'workflow_dispatch'], ['GITHUB_REF', 'refs/heads/main'], ['CREATOR_MACOS_DMG_REPACK', '']]) {
    assert.throws(() => admission({ ...env, [name]: value }, 'darwin', 'x64'));
  }
  assert.throws(() => admission(env, 'darwin', 'arm64')); assert.throws(() => admission(env, 'win32', 'x64'));
  await assert.rejects(run('must-not-inspect'), /Mac|Intel/);
  assert.equal(parseArgs(['--target', 'macos-intel', '--output', path.resolve('fixture-only')]), path.resolve('fixture-only'));
  for (const args of [['--target', 'macos-arm64', '--output', path.resolve('x')],
    ['--target', 'macos-intel', '--output', path.resolve('x'), '--run-id', String(PIN.runId)],
    ['--target', 'macos-intel', '--output', 'relative']]) assert.throws(() => parseArgs(args));
});

const MAKE_ARCHIVE = String.raw`
import sys,json,tarfile,zipfile,io,gzip,hashlib,os
root=sys.argv[1]; spec=json.loads(sys.argv[2]); fault=sys.argv[3]
raw=io.BytesIO()
with tarfile.open(fileobj=raw,mode='w',format=tarfile.USTAR_FORMAT) as t:
    for name,mode in spec['paths'].items():
        m=tarfile.TarInfo(name); m.mode=mode; m.mtime=1700000000; m.uid=501; m.gid=20
        isfile=name not in spec['directories']
        m.type=tarfile.REGTYPE if isfile else tarfile.DIRTYPE
        data=b'unit archive bytes' if isfile else b''; m.size=len(data)
        if fault=='escape' and name.endswith('Info.plist'): m.name='../outside'
        if fault=='link' and name.endswith('Info.plist'): m.type=tarfile.SYMTYPE; m.linkname='../../outside'; m.size=0; data=b''
        if fault=='hardlink' and name.endswith('Info.plist'): m.type=tarfile.LNKTYPE; m.linkname='Creator Hub.app/Contents/MacOS/creator-hub'; m.size=0; data=b''
        if fault=='special' and name.endswith('Info.plist'): m.type=tarfile.FIFOTYPE; m.size=0; data=b''
        if fault=='mode' and name.endswith('Info.plist'): m.mode=0o4755
        if fault=='pax' and name.endswith('Info.plist'): m.type=tarfile.XHDTYPE
        if fault=='file-as-directory' and name.endswith('Info.plist'): m.type=tarfile.DIRTYPE; m.size=0; data=b''
        if fault=='directory-as-file' and name=='Creator Hub.app/Contents': m.type=tarfile.REGTYPE; data=b'unreviewed file'; m.size=len(data)
        t.addfile(m,io.BytesIO(data))
        if fault=='duplicate' and name.endswith('Info.plist'): t.addfile(m,io.BytesIO(data))
uncompressed=raw.getvalue()
if fault=='trailing': uncompressed+=b'unreviewed trailing bytes'
archive=gzip.compress(uncompressed); manifest=b'{"unit":true}'
file=os.path.join(root,'unit.zip')
with zipfile.ZipFile(file,'w') as z:
    for name,data in [('builtin-manifest.json',manifest),('dmg-failure-inputs/bundle_dmg.sh',b'ignored; not executable'),('dmg-failure-inputs/signed-app-before-dmg.tar.gz',archive)]:
        i=zipfile.ZipInfo(name); i.external_attr=(0o100644<<16); z.writestr(i,data)
    if fault=='zipduplicate':
        i=zipfile.ZipInfo('builtin-manifest.json'); i.external_attr=(0o100644<<16); z.writestr(i,manifest)
b=open(file,'rb').read()
spec.update(zipBytes=len(b),zipSha256=hashlib.sha256(b).hexdigest(),tarBytes=len(archive),tarSha256=hashlib.sha256(archive).hexdigest(),rawTarBytes=len(uncompressed),manifestBytes=len(manifest),manifestSha256=hashlib.sha256(manifest).hexdigest())
print(json.dumps(spec))
`;

test('standard archive parser preflight accepts only reviewed regular/dir layout and writes only two members', t => {
  const root = temporary(t), python = process.platform === 'win32' ? 'python' : 'python3';
  const made = spawnSync(python, ['-c', MAKE_ARCHIVE, root, JSON.stringify(archiveSpec()), 'none'], { maxBuffer: 65536 });
  assert.equal(made.status, 0, String(made.stderr));
  const spec = JSON.parse(made.stdout), dest = path.join(root, 'input'); fs.mkdirSync(dest);
  const result = spawnSync(python, ['-c', ARCHIVE_SCRIPT, JSON.stringify(spec), path.join(root, 'unit.zip'), dest], { maxBuffer: 65536 });
  assert.equal(result.status, 0, String(result.stderr));
  const report = JSON.parse(result.stdout);
  assert.equal(report.members.length, 26); assert.equal(report.linkCount, 0);
  assert.deepEqual(fs.readdirSync(dest).sort(), ['builtin-manifest.json', 'signed-app-before-dmg.tar.gz']);
  assert.equal(fs.existsSync(path.join(root, 'Creator Hub.app')), false); // No local app unpack/native operation.
});

test('escape, duplicate paths, links, special modes/types, extensions and trailing TAR bytes refuse before writing', t => {
  const root = temporary(t), python = process.platform === 'win32' ? 'python' : 'python3';
  for (const fault of ['escape', 'link', 'hardlink', 'special', 'mode', 'pax', 'file-as-directory', 'directory-as-file', 'duplicate', 'trailing', 'zipduplicate']) {
    const made = spawnSync(python, ['-c', MAKE_ARCHIVE, root, JSON.stringify(archiveSpec()), fault], { maxBuffer: 65536 });
    assert.equal(made.status, 0, String(made.stderr));
    const spec = JSON.parse(made.stdout), dest = path.join(root, fault); fs.mkdirSync(dest);
    const result = spawnSync(python, ['-c', ARCHIVE_SCRIPT, JSON.stringify(spec), path.join(root, 'unit.zip'), dest], { maxBuffer: 65536 });
    assert.notEqual(result.status, 0, `${fault} must refuse`);
    assert.deepEqual(fs.readdirSync(dest), [], `${fault} wrote archive members before validation`);
  }
});

test('archive pin/size corruption refuses before any selected-member output', t => {
  const root = temporary(t), python = process.platform === 'win32' ? 'python' : 'python3';
  const made = spawnSync(python, ['-c', MAKE_ARCHIVE, root, JSON.stringify(archiveSpec()), 'none'], { maxBuffer: 65536 });
  assert.equal(made.status, 0, String(made.stderr));
  const good = JSON.parse(made.stdout);
  for (const field of ['zipBytes', 'zipSha256', 'tarSha256', 'manifestSha256', 'rawTarBytes']) {
    const spec = { ...good, [field]: field.endsWith('Bytes') ? good[field] - 1 : 'a'.repeat(64) };
    const dest = path.join(root, field); fs.mkdirSync(dest);
    const result = spawnSync(python, ['-c', ARCHIVE_SCRIPT, JSON.stringify(spec), path.join(root, 'unit.zip'), dest], { maxBuffer: 65536 });
    assert.notEqual(result.status, 0); assert.deepEqual(fs.readdirSync(dest), []);
  }
});

test('independent DMG payload checks reject resources, main Hub and original whole-tree drift', t => {
  const root = temporary(t), app = path.join(root, 'Creator Hub.app');
  const manifest = { schemaVersion: 1, platform: 'macos', arch: 'x86_64', modules: {} };
  for (const id of ['mcp', 'setup']) {
    const files = {};
    for (const name of moduleFiles(id, 'macos')) {
      const file = path.join(app, 'Contents/Resources/modules', name), bytes = Buffer.from(`unit:${name}`);
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { mode: 0o755 }); files[name] = sha(bytes);
    }
    manifest.modules[id] = { executable: moduleFiles(id, 'macos')[0], version: '1.0.0', files };
  }
  const descriptor = Buffer.from(JSON.stringify(manifest)), hub = path.join(app, 'Contents/MacOS/creator-hub');
  fs.mkdirSync(path.dirname(hub)); const bytes = Buffer.concat([Buffer.from('unit-Hub'), descriptor]); fs.writeFileSync(hub, bytes);
  const source = worker.appInventory(app);
  assert.equal(verifyMounted(source, app, manifest, descriptor, sha(bytes)).hubSha256, sha(bytes));
  assert.throws(() => verifyMounted(source, app, manifest, descriptor, 'a'.repeat(64)), /Hub/);
  fs.writeFileSync(path.join(app, 'unexpected'), 'not in original app');
  assert.throws(() => verifyMounted(source, app, manifest, descriptor, sha(bytes)), /whole signed app/);
});

test('workflow is one pinned Intel job on dedicated push, read-only, with no builder/signing/GUI/recovery', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/macos-dmg-repack.yml'), 'utf8');
  assert.match(workflow, /branches: \['validation\/mac-dmg-repack-014'\]/);
  assert.match(workflow, /paths: \['\.github\/workflows\/macos-dmg-repack\.yml'\]/);
  assert.match(workflow, /contents: read\s+actions: read/);
  assert.equal((workflow.match(/os: macos-15-intel/g) || []).length, 1);
  assert.doesNotMatch(workflow, /os: macos-latest|macos-arm64|workflow_dispatch|build:unified|cargo |--sign|--force|kill|osascript|security /);
  assert.match(workflow, /if: always\(\)/);
  const source = fs.readFileSync(path.join(__dirname, 'macos-dmg-repack.cjs'), 'utf8');
  assert.match(source, /unix\.extract\(/); assert.doesNotMatch(source, /-force|--force|\.kill\(|fs\.rm|unlinkSync|extractall\(/);
  assert.ok(!source.includes('timeout:')); // Native sync extract is bounded by job lifetime, never a hidden subprocess kill.
  assert.equal(PIN.tarBytes, 54843140); assert.equal(PIN.zipBytes, 54307809);
});
