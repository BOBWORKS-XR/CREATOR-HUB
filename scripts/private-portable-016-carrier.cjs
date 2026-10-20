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
  assert.equal(found.name, ASSET); assert.equal(found.state, 'uploaded'); assert.equal(found.size, v.zip.size); assert.equal(found.digest, `sha256:${v.zip.sha256}`); return found;
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
module.exports = { BRANCH, WORKFLOW, ASSET, RELEASE, TAG, META, SIGNED_META, FILE, ZIP, FILES, METADATA, flags, record, limit, validate, parse, admission, asset, STAGE_PYTHON, stage };
if (require.main === module) Promise.resolve().then(() => { const args = process.argv.slice(2); assert.equal(args.length, 3); assert.equal(args[0], 'stage'); return stage(args[1], args[2]); })
  .then(() => console.log(JSON.stringify({ transportCompleted: true, ...flags() })))
  .catch(error => { console.error(String(error.message).slice(0, 1500)); process.exitCode = 1; });
