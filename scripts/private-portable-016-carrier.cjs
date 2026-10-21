'use strict';
// Byte transport only. Signed metadata and packages stay opaque; nothing is executed or qualified.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const BRANCH = 'refs/heads/validation/private-portable-016-carrier';
const WORKFLOW = '.github/workflows/private-portable-016-carrier.yml';
const ASSET = 'signed-private-portable016-carrier-39365532397.zip';
const REVIEWED_ASSET = 'signed-private-portable016-carrier-39435741602.zip';
const RELEASE = 411494394, TAG = 'v0.1.13-validation';
const META = 2 * 1024 * 1024, SIGNED_META = 128 * 1024, FILE = 256 * 1024 * 1024, ZIP = 768 * 1024 * 1024;
const FILES = Object.freeze(['package-receipt.json', 'Creator Hub_0.1.16_amd64.AppImage',
  'Creator.Hub.Native.Support_0.1.16_amd64.AppImage', 'creator-hub-linux-x86_64-0.1.16.portable-manifest.json',
  'creator-hub-linux-x86_64-0.1.16.appdir.tar.gz', 'appdir-original-inventory.json', 'appdir-flattened-inventory.json',
  'plan.json', 'fresh-api.json', 'creator-hub-linux-x86_64-portable.json',
  'creator-hub-linux-x86_64-0.1.16.portable-manifest.json.minisig', 'creator-hub-linux-x86_64-portable.json.minisig',
  'private-qualification-receipt.json']);
const METADATA = Object.freeze(['creator-hub-linux-x86_64-portable.json', 'creator-hub-linux-x86_64-portable.json.minisig',
  'creator-hub-linux-x86_64-0.1.16.portable-manifest.json', 'creator-hub-linux-x86_64-0.1.16.portable-manifest.json.minisig']);
const flags = () => ({ signatureVerified: false, runtimeValidated: false, candidateExecuted: false, nativeGuiAccepted: false,
  migrationAccepted: false, signedUpdateAccepted: false, restartAccepted: false, publicationPerformed: false, releaseReady: false });
const record = bytes => ({ size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
function keys(v, names) { assert.ok(v && typeof v === 'object' && !Array.isArray(v)); assert.deepEqual(Object.keys(v).sort(), [...names].sort()); }
function sha(v) { assert.ok(typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)); }
function limit(name) { return name.endsWith('.minisig') ? 4096 : name === 'plan.json' || METADATA.includes(name) ? SIGNED_META : name.endsWith('.json') ? META : FILE; }
function pin(v, bound) { keys(v, ['size', 'sha256']); assert.ok(Number.isSafeInteger(v.size) && v.size > 0 && v.size <= bound); sha(v.sha256); }
function validate(v) {
  keys(v, ['schemaVersion', 'assetId', 'zip', 'files', 'planSha256']); assert.equal(v.schemaVersion, 1);
  assert.ok(Number.isSafeInteger(v.assetId) && v.assetId > 0); pin(v.zip, ZIP); keys(v.files, FILES);
  for (const name of FILES) pin(v.files[name], limit(name));
  assert.ok(FILES.reduce((sum, name) => sum + v.files[name].size, 0) <= ZIP);
  sha(v.planSha256); assert.equal(v.planSha256, v.files['plan.json'].sha256); return v;
}
function parse(text) { assert.ok(typeof text === 'string' && Buffer.byteLength(text) > 0 && Buffer.byteLength(text) <= 32768); const v = validate(JSON.parse(text)); assert.equal(text, JSON.stringify(v, null, 2), 'Canonical independent JSON required'); return v; }
function admission(env, platform = process.platform, arch = process.arch) {
  assert.equal(platform, 'linux'); assert.equal(arch, 'x64');
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: BRANCH,
    GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${WORKFLOW}@${BRANCH}` })) assert.equal(env[key], value, key);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
  assert.ok(!Object.keys(env).some(name => /^(NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|PYTHON|LD_|DYLD_)/.test(name)), 'Runtime injection refused');
}
function asset(v, release, assets) {
  validate(v); assert.equal(release.id, RELEASE); assert.equal(release.tag_name, TAG); assert.equal(release.draft, true);
  assert.ok(Array.isArray(assets) && assets.length < 100);
  const selected = assets.filter(item => item.id === v.assetId); assert.equal(selected.length, 1); const found = selected[0];
  assert.ok(found.name === ASSET || found.name === REVIEWED_ASSET); assert.equal(found.state, 'uploaded'); assert.equal(found.size, v.zip.size); assert.equal(found.digest, `sha256:${v.zip.sha256}`); return found;
}
const STAGE_PYTHON = String.raw`
import hashlib,json,os,stat,sys,zipfile
from pathlib import Path
FILES=${JSON.stringify(FILES)}
METADATA=${JSON.stringify(METADATA)}
LIMITS=${JSON.stringify(Object.fromEntries(FILES.map(name => [name, limit(name)])))}
ZIP_LIMIT=${ZIP}
def need(v,m):
    if not v: raise ValueError(m)
def canonical(p):
    need(p.is_absolute() and str(p)==os.path.normpath(p),'Canonical path required')
    for part in (p,*p.parents):
        try: need(not stat.S_ISLNK(part.lstat().st_mode),'Redirected path refused')
        except FileNotFoundError: pass
def identity(s): return s.st_dev,s.st_ino,s.st_size,s.st_mode,s.st_nlink,s.st_mtime_ns,s.st_ctime_ns
def pairs(rows):
    out={}
    for k,v in rows: need(k not in out,'Duplicate input key');out[k]=v
    return out
def main():
    source,request,output,scope=map(Path,sys.argv[1:])
    for p in (source,request,output,scope): canonical(p)
    need(all(p!=scope and p.is_relative_to(scope) for p in (source,request,output)),'Owned temporary scope required')
    need(output.is_dir() and not any(output.iterdir()) and source!=request,'Fresh owned output required')
    rs=request.lstat();need(stat.S_ISREG(rs.st_mode) and rs.st_nlink==1 and 0<rs.st_size<=32768,'Bounded request required')
    raw=request.read_bytes();v=json.loads(raw,object_pairs_hook=pairs)
    need(identity(rs)==identity(request.lstat()),'Request changed')
    need(set(v)=={'schemaVersion','assetId','zip','files','planSha256'} and type(v['schemaVersion']) is int and v['schemaVersion']==1 and type(v['assetId']) is int and v['assetId']>0,'Exact request required')
    need(set(v['files'])==set(FILES) and v['planSha256']==v['files']['plan.json']['sha256'],'Exact thirteen pins required')
    for name,pin in [('',v['zip']),*v['files'].items()]:
        need(set(pin)=={'size','sha256'} and type(pin['size']) is int and 0<pin['size']<=(LIMITS[name] if name else ZIP_LIMIT),'Pin size exceeds bound')
        need(type(pin['sha256']) is str and len(pin['sha256'])==64 and all(c in '0123456789abcdef' for c in pin['sha256']),'Exact hash required')
    need(sum(p['size'] for p in v['files'].values())<=ZIP_LIMIT,'Expanded pins exceed bound')
    named=source.lstat();need(stat.S_ISREG(named.st_mode) and named.st_nlink==1 and named.st_size==v['zip']['size'],'Exact regular ZIP required')
    fd=os.open(source,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0))
    with os.fdopen(fd,'rb') as stream:
        before=os.fstat(stream.fileno());need(identity(before)[:-1]==identity(named)[:-1],'ZIP replaced')
        digest=hashlib.sha256();count=0
        for chunk in iter(lambda:stream.read(65536),b''):
            count+=len(chunk);need(count<=v['zip']['size'],'ZIP grew');digest.update(chunk)
        need(count==v['zip']['size'] and digest.hexdigest()==v['zip']['sha256'],'ZIP hash differs');stream.seek(0)
        with zipfile.ZipFile(stream) as archive:
            entries=archive.infolist();need(len(entries)==len(FILES) and {e.filename for e in entries}==set(FILES),'Exact flat thirteen-file ZIP required')
            for e in entries:
                mode=e.external_attr>>16
                need(not e.is_dir() and stat.S_IFMT(mode) in (0,stat.S_IFREG) and not mode&0o7000 and not e.flag_bits&1 and e.compress_type in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED),'Special or encrypted member refused')
                need(e.file_size==v['files'][e.filename]['size'] and 0<e.file_size<=LIMITS[e.filename],'Member size differs')
            full=output/'all';metadata=output/'metadata';full.mkdir(mode=0o700);metadata.mkdir(mode=0o700)
            for name in FILES:
                pin=v['files'][name];digest=hashlib.sha256();count=0;target=full/name
                with archive.open(name) as member,target.open('xb') as destination:
                    for chunk in iter(lambda:member.read(65536),b''):
                        count+=len(chunk);need(count<=pin['size'],'Inflated member exceeds bound');digest.update(chunk);destination.write(chunk)
                need(count==pin['size'] and digest.hexdigest()==pin['sha256'],'Member hash differs');target.chmod(0o600)
                need(target.lstat().st_nlink==1,'Fresh single-link output required')
                if name in METADATA:
                    with target.open('rb') as member,(metadata/name).open('xb') as destination:
                        data=member.read(LIMITS[name]+1);need(len(data)==pin['size'] and hashlib.sha256(data).hexdigest()==pin['sha256'],'Metadata copy differs');destination.write(data)
                    (metadata/name).chmod(0o600);need((metadata/name).lstat().st_nlink==1,'Fresh metadata copy required')
        canonical(source);canonical(request)
        need(identity(before)==identity(os.fstat(stream.fileno())) and identity(named)==identity(source.lstat()),'ZIP changed')
        need(identity(rs)==identity(request.lstat()) and raw==request.read_bytes(),'Request changed')
    print(json.dumps({'files':v['files'],'metadata':{n:v['files'][n] for n in METADATA},'zip':v['zip']}))
try: main()
except Exception as error: print(str(error)[:1500],file=sys.stderr);sys.exit(2)
`;
function canonical(file) { assert.ok(path.isAbsolute(file) && path.resolve(file) === file); for (let p = file;; p = path.dirname(p)) { try { assert.equal(fs.lstatSync(p).isSymbolicLink(), false); } catch (e) { if (e.code !== 'ENOENT') throw e; } if (p === path.dirname(p)) break; } }
function inside(file, parent) { canonical(file); canonical(parent); const v = path.relative(parent, file); assert.ok(v && !path.isAbsolute(v) && v !== '..' && !v.startsWith(`..${path.sep}`)); }
function stage(download, output, env = process.env) {
  admission(env); const scope = fs.realpathSync(env.RUNNER_TEMP); inside(download, scope); inside(output, scope);
  assert.equal(fs.existsSync(output), false); assert.deepEqual(fs.readdirSync(download).sort(), ['private-portable016.zip', 'transport-input.json']);
  const request = path.join(download, 'transport-input.json'), zip = path.join(download, 'private-portable016.zip');
  canonical(request); const info = fs.lstatSync(request); assert.ok(info.isFile() && info.nlink === 1 && info.size > 0 && info.size <= 32768);
  const bytes = fs.readFileSync(request), v = parse(bytes.toString('utf8')); assert.equal(bytes.length, info.size); assert.equal(fs.statSync(request).mtimeMs, info.mtimeMs);
  fs.mkdirSync(output, { mode: 0o700 });
  try {
    const result = JSON.parse(execFileSync('/usr/bin/python3', ['-B', '-c', STAGE_PYTHON, zip, request, output, scope], { encoding: 'utf8', timeout: 180000, maxBuffer: 32768, windowsHide: true }));
    assert.deepEqual(result, { files: v.files, metadata: Object.fromEntries(METADATA.map(name => [name, v.files[name]])), zip: v.zip });
    const receipt = { schemaVersion: 1, scope: 'opaque-private-portable016-byte-transport-only', transportCompleted: true, sourceCommit: env.GITHUB_SHA,
      releaseId: RELEASE, assetId: v.assetId, request: record(bytes), ...result, ...flags() };
    fs.writeFileSync(path.join(output, 'transport-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); return receipt;
  } catch (error) { fs.writeFileSync(path.join(output, 'transport-refusal.json'), `${JSON.stringify({ transportCompleted: false, error: String(error.message).slice(0, 1500), ...flags() }, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); throw error; }
}
const SOURCE_FILES = Object.freeze(FILES.slice(0, 7).map(name => name === METADATA[2] ? 'portable-manifest.unsigned.json' : name));
const SIX_FILES = Object.freeze(FILES.slice(7));
const V2_PRODUCER = Object.freeze({ sourceCommit: 'f65cbefb93a26ea7006bd618175e78c09f058097', sourceTree: '6caed6b4611fad3f0a4e0745be4cfc919b86dcf6',
  runId: 39648084197, runAttempt: 1, jobId: 119388869495, workflowId: 390008906, artifactId: 12368463164,
  zip: Object.freeze({ size: 451817971, sha256: 'ce15a2a774c4b3d60d178ca97ffeb4a6dde29d1853c6abc69fb0a464db813a91' }) });
const V2_OUTPUT = Object.freeze({ name: 'signed-private-portable016-carrier-39648084197.zip',
  zip: Object.freeze({ size: 451921705, sha256: '8d980253a3b7206a2604a9efc8687dade9283cfd218e37bb65306259f413ea20' }) });
const V2_PLAN = '9b844bb72dd36c2268f087609019116aaa02b41f140471cfba23a1726f27fd3d';
const PRODUCER_BRANCH = 'validation/linux-016-portable-production', PRODUCER_WORKFLOW = '.github/workflows/linux-016-portable-production.yml';
const PRODUCER_ARTIFACT = 'linux-016-production-portable-unsigned-39648084197-1';
function validateV2(v) {
  keys(v, ['schemaVersion', 'producer', 'metadataZip', 'metadataBase64', 'files', 'planSha256', 'output', 'deliverToDraft']); assert.equal(v.schemaVersion, 2);
  assert.equal(typeof v.deliverToDraft, 'boolean');
  assert.deepEqual(v.producer, V2_PRODUCER); assert.deepEqual(v.output, V2_OUTPUT); assert.equal(v.planSha256, V2_PLAN);
  keys(v.files, FILES); for (const name of FILES) pin(v.files[name], limit(name));
  assert.equal(v.files['plan.json'].sha256, V2_PLAN); assert.equal(FILES.reduce((n, name) => n + v.files[name].size, 0), 451919767);
  assert.equal(SIX_FILES.reduce((n, name) => n + v.files[name].size, 0), 102938);
  pin(v.metadataZip, 18000); assert.ok(typeof v.metadataBase64 === 'string' && v.metadataBase64.length <= 24000);
  const bytes = Buffer.from(v.metadataBase64, 'base64'); assert.equal(bytes.toString('base64'), v.metadataBase64);
  assert.deepEqual(record(bytes), v.metadataZip); return v;
}
function parseV2(text) {
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) > 0 && Buffer.byteLength(text) <= 32768);
  const v = validateV2(JSON.parse(text)); assert.equal(text, JSON.stringify(v, null, 2)); return v;
}
function validateProducerAPI(api) {
  keys(api, ['repository', 'workflow', 'run', 'attempt', 'job', 'artifact', 'commit']);
  assert.equal(api.repository.id, 1364807512); assert.equal(api.repository.full_name, 'BOBWORKS-XR/CREATOR-HUB');
  assert.equal(api.workflow.id, V2_PRODUCER.workflowId); assert.equal(api.workflow.path, PRODUCER_WORKFLOW); assert.equal(api.workflow.state, 'active');
  for (const run of [api.run, api.attempt]) {
    for (const [key, value] of Object.entries({ id: V2_PRODUCER.runId, run_attempt: 1, workflow_id: V2_PRODUCER.workflowId,
      event: 'workflow_dispatch', head_branch: PRODUCER_BRANCH, head_sha: V2_PRODUCER.sourceCommit, status: 'completed', conclusion: 'success' })) assert.equal(run[key], value, key);
    assert.equal(run.repository.id, 1364807512); assert.equal(run.head_repository.id, 1364807512);
  }
  for (const [key, value] of Object.entries({ id: V2_PRODUCER.jobId, run_id: V2_PRODUCER.runId, run_attempt: 1,
    head_sha: V2_PRODUCER.sourceCommit, status: 'completed', conclusion: 'success' })) assert.equal(api.job[key], value, key);
  assert.ok(Array.isArray(api.job.labels) && api.job.labels.includes('ubuntu-22.04'));
  assert.equal(api.job.name, 'package'); assert.ok(Array.isArray(api.job.steps) && api.job.steps.length === 17);
  assert.equal(new Set(api.job.steps.map(s => s.name)).size, 17);
  assert.ok(api.job.steps.every(s => s.status === 'completed' && s.conclusion ===
    (s.name === 'Retain original refusal evidence without claiming acceptance' ? 'skipped' : 'success')));
  for (const name of ['Test exact selector sources with default and experimental restart features',
    'Verify production DEB, build only source-bound selector and bundle supplied Root once',
    'Retain unsigned complete transport, ordinary image and exact-byte setup alias', 'Retain original refusal evidence without claiming acceptance'])
    assert.equal(api.job.steps.filter(s => s.name === name).length, 1);
  const a = api.artifact;
  assert.equal(a.id, V2_PRODUCER.artifactId); assert.equal(a.name, PRODUCER_ARTIFACT); assert.equal(a.expired, false);
  assert.equal(a.size_in_bytes, V2_PRODUCER.zip.size); assert.equal(a.digest, `sha256:${V2_PRODUCER.zip.sha256}`);
  assert.equal(a.workflow_run.id, V2_PRODUCER.runId); assert.equal(a.workflow_run.head_sha, V2_PRODUCER.sourceCommit);
  assert.equal(a.workflow_run.head_branch, PRODUCER_BRANCH); assert.equal(a.workflow_run.repository_id, 1364807512);
  assert.equal(api.commit.sha, V2_PRODUCER.sourceCommit); assert.equal(api.commit.tree.sha, V2_PRODUCER.sourceTree); return api;
}
function v2Context(context, env) {
  assert.equal(context.repo.owner, 'BOBWORKS-XR'); assert.equal(context.repo.repo, 'CREATOR-HUB');
  assert.equal(context.eventName, 'workflow_dispatch'); assert.equal(context.ref, BRANCH); assert.equal(context.sha, env.GITHUB_SHA);
  assert.equal(String(context.runId), env.GITHUB_RUN_ID); assert.match(env.GITHUB_RUN_ID || '', /^[1-9][0-9]*$/); assert.equal(env.GITHUB_RUN_ATTEMPT, '1');
}
async function fetchV2(github, context, env) {
  v2Context(context, env); const text = env.TRANSPORT_INPUT, v = parseV2(text), args = context.repo;
  const get = async (method, more) => (await method({ ...args, ...more, request: { timeout: 30000 } })).data;
  const api = {
    repository: await get(github.rest.repos.get, {}),
    workflow: await get(github.rest.actions.getWorkflow, { workflow_id: V2_PRODUCER.workflowId }),
    run: await get(github.rest.actions.getWorkflowRun, { run_id: V2_PRODUCER.runId }),
    attempt: await get(github.rest.actions.getWorkflowRunAttempt, { run_id: V2_PRODUCER.runId, attempt_number: 1 }),
    job: await get(github.rest.actions.getJobForWorkflowRun, { job_id: V2_PRODUCER.jobId }),
    artifact: await get(github.rest.actions.getArtifact, { artifact_id: V2_PRODUCER.artifactId }),
    commit: await get(github.rest.git.getCommit, { commit_sha: V2_PRODUCER.sourceCommit }),
  };
  validateProducerAPI(api); const evidence = Buffer.from(JSON.stringify(api, null, 2)); assert.ok(evidence.length <= 262144);
  const { data } = await github.rest.actions.downloadArtifact({ ...args, artifact_id: V2_PRODUCER.artifactId, archive_format: 'zip', request: { timeout: 600000 } });
  assert.ok(Buffer.isBuffer(data) || data instanceof ArrayBuffer); const bytes = Buffer.from(data); assert.deepEqual(record(bytes), v.producer.zip);
  const output = path.join(fs.realpathSync(env.RUNNER_TEMP), 'private-portable016-v2-download'); canonical(output); fs.mkdirSync(output, { mode: 0o700 });
  for (const [name, body] of Object.entries({ 'original.zip': bytes, 'metadata.zip': Buffer.from(v.metadataBase64, 'base64'), 'transport-input.json': text, 'source-api.json': evidence }))
    fs.writeFileSync(path.join(output, name), body, { flag: 'wx', mode: 0o600 });
}
// Reuse the v1 path, identity and duplicate-key guards; the decoder never imports or executes member bytes.
const RECONSTRUCT_PYTHON = STAGE_PYTHON.slice(0, STAGE_PYTHON.indexOf('def main():')) + String.raw`
import base64,contextlib
SOURCE_FILES=${JSON.stringify(SOURCE_FILES)}
SIX_FILES=${JSON.stringify(SIX_FILES)}
PRODUCER=${JSON.stringify(V2_PRODUCER)}
OUTPUT=${JSON.stringify(V2_OUTPUT)}
PLAN=${JSON.stringify(V2_PLAN)}

@contextlib.contextmanager
def held(p,pin):
    canonical(p);named=p.lstat()
    need(stat.S_ISREG(named.st_mode) and named.st_nlink==1 and named.st_size==pin['size'],'Exact ordinary input required')
    fd=os.open(p,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0)|getattr(os,'O_NONBLOCK',0))
    with os.fdopen(fd,'rb') as f:
        before=os.fstat(f.fileno());need(identity(before)[:-1]==identity(named)[:-1],'Input replaced')
        # Windows named/held ctime can describe different timestamps; both remain independently held below.
        if os.name!='nt': need(before.st_ctime_ns==named.st_ctime_ns,'Input ctime changed')
        digest=hashlib.sha256();count=0
        for chunk in iter(lambda:f.read(65536),b''):
            count+=len(chunk);need(count<=pin['size'],'Input grew');digest.update(chunk)
        need(count==pin['size'] and digest.hexdigest()==pin['sha256'],'Input hash differs');f.seek(0)
        yield f
        canonical(p);need(identity(before)==identity(os.fstat(f.fileno())) and identity(named)==identity(p.lstat()),'Input changed')

def check_zip(archive,names,pins):
    entries=archive.infolist()
    need(len(entries)==len(names) and {e.filename for e in entries}==set(names),'Exact ordinary flat member set required')
    for e in entries:
        mode=e.external_attr>>16
        need(not e.is_dir() and stat.S_IFMT(mode) in (0,stat.S_IFREG) and not mode&0o7000 and not e.flag_bits&1 and e.compress_type in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED),'Special or encrypted member refused')
        need(e.file_size==pins[e.filename]['size'],'Member size differs')

def write_zip(destination,original,metadata,pins):
    with zipfile.ZipFile(destination,'w',compression=zipfile.ZIP_STORED,allowZip64=False) as archive:
        for name in FILES:
            old='portable-manifest.unsigned.json' if name==METADATA[2] else name
            source=original if old in SOURCE_FILES else metadata
            item=zipfile.ZipInfo(name,(1980,1,1,0,0,0));item.create_system=3;item.external_attr=(stat.S_IFREG|0o600)<<16
            item.file_size=pins[name]['size'];digest=hashlib.sha256();count=0
            with source.open(old) as member,archive.open(item,'w') as target:
                for chunk in iter(lambda:member.read(65536),b''):
                    count+=len(chunk);need(count<=pins[name]['size'],'Expanded member exceeds pin');digest.update(chunk);target.write(chunk)
            need(count==pins[name]['size'] and digest.hexdigest()==pins[name]['sha256'],'Member hash differs')

def main():
    download,request,output,scope=map(Path,sys.argv[1:5]);request_sha=sys.argv[5]
    for p in (download,request,output,scope): canonical(p)
    need(all(p!=scope and p.is_relative_to(scope) for p in (download,request,output)),'Owned temporary scope required')
    need(output.is_dir() and not any(output.iterdir()),'Fresh owned output required')
    rs=request.lstat();need(stat.S_ISREG(rs.st_mode) and rs.st_nlink==1 and 0<rs.st_size<=32768,'Bounded ordinary request required')
    raw=request.read_bytes();need(hashlib.sha256(raw).hexdigest()==request_sha,'Request differs from admitted bytes')
    v=json.loads(raw,object_pairs_hook=pairs)
    need(set(v)=={'schemaVersion','producer','metadataZip','metadataBase64','files','planSha256','output','deliverToDraft'} and type(v['schemaVersion']) is int and v['schemaVersion']==2 and type(v['deliverToDraft']) is bool,'Exact v2 request required')
    need(v['producer']==PRODUCER and v['output']==OUTPUT and v['planSha256']==PLAN,'Immutable reconstruction pins differ')
    need(set(v['files'])==set(FILES) and v['files']['plan.json']['sha256']==PLAN,'Exact file pins required')
    for name,pin in v['files'].items():
        need(set(pin)=={'size','sha256'} and type(pin['size']) is int and 0<pin['size']<=LIMITS[name],'Bounded member pin required')
        need(type(pin['sha256']) is str and len(pin['sha256'])==64 and all(c in '0123456789abcdef' for c in pin['sha256']),'Exact member hash required')
    need(sum(p['size'] for p in v['files'].values())==451919767 and sum(v['files'][n]['size'] for n in SIX_FILES)==102938,'Exact expanded sizes required')
    meta=base64.b64decode(v['metadataBase64'],validate=True)
    need(0<len(meta)<=18000 and v['metadataZip']=={'size':len(meta),'sha256':hashlib.sha256(meta).hexdigest()},'Metadata ZIP differs')
    source_pins={n:v['files'][METADATA[2] if n=='portable-manifest.unsigned.json' else n] for n in SOURCE_FILES}
    with held(download/'original.zip',PRODUCER['zip']) as first,held(download/'metadata.zip',v['metadataZip']) as second:
        with zipfile.ZipFile(first) as original,zipfile.ZipFile(second) as metadata:
            check_zip(original,SOURCE_FILES,source_pins);check_zip(metadata,SIX_FILES,v['files'])
            target=output/OUTPUT['name'];fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
            with os.fdopen(fd,'wb') as destination:
                write_zip(destination,original,metadata,v['files']);destination.flush();os.fsync(destination.fileno())
        with held(target,OUTPUT['zip']): pass
    need(identity(rs)==identity(request.lstat()) and raw==request.read_bytes(),'Request changed')
    print(json.dumps({'zip':OUTPUT['zip'],'files':v['files']}))
try: main()
except Exception as error: print(str(error)[:1500],file=sys.stderr);sys.exit(2)
`;
function readBounded(file, maximum) {
  canonical(file); const info = fs.lstatSync(file); assert.ok(info.isFile() && info.nlink === 1 && info.size > 0 && info.size <= maximum);
  const bytes = fs.readFileSync(file); assert.equal(bytes.length, info.size); assert.equal(fs.statSync(file).mtimeMs, info.mtimeMs); return bytes;
}
function reconstructV2(download, output, env = process.env) {
  admission(env); const scope = fs.realpathSync(env.RUNNER_TEMP); inside(download, scope); inside(output, scope);
  assert.equal(fs.existsSync(output), false); assert.deepEqual(fs.readdirSync(download).sort(), ['metadata.zip', 'original.zip', 'source-api.json', 'transport-input.json']);
  const request = path.join(download, 'transport-input.json'), bytes = readBounded(request, 32768), v = parseV2(bytes.toString('utf8'));
  const evidence = readBounded(path.join(download, 'source-api.json'), 262144); validateProducerAPI(JSON.parse(evidence));
  fs.mkdirSync(output, { mode: 0o700 });
  try {
    const result = JSON.parse(execFileSync('/usr/bin/python3', ['-B', '-c', RECONSTRUCT_PYTHON, download, request, output, scope, record(bytes).sha256],
      { encoding: 'utf8', timeout: 180000, maxBuffer: 32768, windowsHide: true }));
    assert.deepEqual(result, { zip: v.output.zip, files: v.files });
    const receipt = { schemaVersion: 2, scope: 'byte-identical-private-carrier-reconstruction-only', transportCompleted: true, sourceCommit: env.GITHUB_SHA,
      request: record(bytes), producer: v.producer, sourceApi: record(evidence), output: v.output, files: v.files, ...flags() };
    fs.writeFileSync(path.join(output, 'transport-receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 }); return receipt;
  } catch (error) {
    fs.writeFileSync(path.join(output, 'transport-refusal.json'), JSON.stringify({ transportCompleted: false, error: String(error.message).slice(0, 1500), ...flags() }), { flag: 'wx', mode: 0o600 }); throw error;
  }
}
function pinnedBytes(file, expected) {
  canonical(file); const before = fs.lstatSync(file); assert.ok(before.isFile() && before.nlink === 1 && before.size === expected.size);
  const identity = s => [s.dev, s.ino, s.size, s.mode, s.nlink, s.mtimeMs, s.ctimeMs];
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    assert.deepEqual(identity(fs.fstatSync(fd)), identity(before)); const bytes = Buffer.alloc(expected.size); let offset = 0;
    while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, Math.min(65536, bytes.length - offset), null); assert.ok(n > 0); offset += n; }
    assert.equal(fs.readSync(fd, Buffer.alloc(1), 0, 1, null), 0); assert.deepEqual(record(bytes), expected);
    assert.deepEqual(identity(fs.fstatSync(fd)), identity(before)); canonical(file); assert.deepEqual(identity(fs.lstatSync(file)), identity(before)); return bytes;
  } finally { fs.closeSync(fd); }
}
function priorAssets(assets) {
  assert.ok(Array.isArray(assets) && assets.length < 100); assert.equal(new Set(assets.map(a => a.id)).size, assets.length);
  return assets.map(a => Object.fromEntries(['id', 'name', 'size', 'digest', 'state', 'updated_at'].map(k => [k, a[k]]))).sort((a, b) => a.id - b.id);
}
async function deliverV2(github, context, env) {
  v2Context(context, env); assert.equal(env.GITHUB_JOB, 'deliver-v2'); const v = parseV2(env.TRANSPORT_INPUT); assert.equal(v.deliverToDraft, true);
  const scope = fs.realpathSync(env.RUNNER_TEMP);
  const directory = path.join(scope, 'private-portable016-v2-delivery'), file = path.join(directory, V2_OUTPUT.name); inside(file, scope);
  assert.deepEqual(fs.readdirSync(directory), [V2_OUTPUT.name]); const bytes = pinnedBytes(file, V2_OUTPUT.zip);
  const repo = context.repo, options = { ...repo, release_id: RELEASE, request: { timeout: 30000 } };
  const release = async () => {
    const { data: r } = await github.rest.repos.getRelease(options); assert.equal(r.id, RELEASE); assert.equal(r.tag_name, TAG); assert.equal(r.draft, true); return r;
  };
  await release(); const list = async () => (await github.rest.repos.listReleaseAssets({ ...options, per_page: 100, page: 1 })).data;
  const before = priorAssets(await list()); assert.equal(before.length, 49); assert.ok(before.every(a => a.name !== V2_OUTPUT.name), 'Target already exists; no overwrite or cleanup');
  const evidence = path.join(scope, 'private-portable016-v2-delivery-evidence'); canonical(evidence); fs.mkdirSync(evidence, { mode: 0o700 });
  const save = (name, value) => fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  save('intent.json', { runId: context.runId, runAttempt: 1, sourceCommit: env.GITHUB_SHA, request: record(Buffer.from(env.TRANSPORT_INPUT)), releaseId: RELEASE, output: V2_OUTPUT, priorAssets: before });
  try {
    const { data: a } = await github.rest.repos.uploadReleaseAsset({ ...repo, release_id: RELEASE, name: V2_OUTPUT.name, data: bytes,
      headers: { 'content-type': 'application/zip', 'content-length': String(bytes.length) }, request: { timeout: 900000 } });
    save('response.json', priorAssets([a])[0]); assert.ok(Number.isSafeInteger(a.id) && a.id > 0);
    assert.equal(a.name, V2_OUTPUT.name); assert.equal(a.state, 'uploaded'); assert.equal(a.size, V2_OUTPUT.zip.size); assert.equal(a.digest, `sha256:${V2_OUTPUT.zip.sha256}`);
    await release(); const after = priorAssets(await list()); save('assets-after.json', after);
    assert.deepEqual(after.filter(item => item.id !== a.id), before); assert.deepEqual(after.filter(item => item.id === a.id), priorAssets([a]));
    save('receipt.json', { draftUploadCompleted: true, releaseId: RELEASE, asset: priorAssets([a])[0], priorAssetsUnchanged: true, ...flags() });
  } catch (error) {
    save('failure.json', { outcome: 'refused-or-unknown-after-single-POST', retryPermitted: false, errorType: String(error.name).slice(0, 80), ...flags() }); throw error;
  }
}
module.exports = { BRANCH, WORKFLOW, ASSET, REVIEWED_ASSET, RELEASE, TAG, META, SIGNED_META, FILE, ZIP, FILES, METADATA, flags, record, limit, validate, parse, admission, asset, STAGE_PYTHON, stage,
  SOURCE_FILES, SIX_FILES, V2_PRODUCER, V2_OUTPUT, V2_PLAN, validateV2, parseV2, validateProducerAPI, fetchV2, RECONSTRUCT_PYTHON, reconstructV2, pinnedBytes, priorAssets, deliverV2 };
if (require.main === module) Promise.resolve().then(() => { const args = process.argv.slice(2); assert.equal(args.length, 3);
  if (args[0] === 'reconstruct-v2') return reconstructV2(args[1], args[2]); assert.equal(args[0], 'stage'); return stage(args[1], args[2]); })
  .then(() => console.log(JSON.stringify({ transportCompleted: true, ...flags() })))
  .catch(error => { console.error(String(error.message).slice(0, 1500)); process.exitCode = 1; });
