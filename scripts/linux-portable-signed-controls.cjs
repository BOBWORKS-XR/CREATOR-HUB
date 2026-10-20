'use strict';
// Fixed test-input staging only. Never starts Root, a selector or a GUI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const finite = require('./flatpak-package.cjs');
const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = '.github/workflows/linux-portable-deployment.yml';
const REF = 'refs/heads/validation/linux-portable-deployment';
const PROFILE = Object.freeze({ size: 20258, sha256: '1412daac05451789cbd99a400fa9fbd0a67f4c44f888844c0855112103b70325' });
const FIXTURE = 'native/linux-portable-deployment/tests/production_signed_controls.rs';
const FIXTURE_PIN = Object.freeze({ size: 24000, sha256: '735b1a6aa5a73b1a1f6ad889c37facf97b1038c00d53b94d7a60f2e9aa45d887' });
const PROFILE_NAME = 'artifacts/release-016-updater-20261019/reviewed016-update-portable-39435741602-profile.candidate.json';
const ROLES = Object.freeze(['signedPortable16', 'signedPortable17']);
const ASSETS = Object.freeze({ signedPortable16: 659622698, signedPortable17: 658277802 });
const SOURCES = Object.freeze([WORKFLOW, 'scripts/linux-portable-signed-controls.cjs',
  'scripts/native-linux-production-016-update.py', 'scripts/flatpak-package.cjs', 'scripts/module-archive.cjs', FIXTURE,
  'native/linux-portable-deployment/Cargo.toml', 'native/linux-portable-deployment/Cargo.lock',
  ...['lib', 'archive', 'filesystem', 'store', 'host', 'registration', 'bootstrap', 'restart', 'restart_linux']
    .map(name => `native/linux-portable-deployment/src/${name}.rs`), 'src-tauri/src/catalog-key.pub']);
const record = bytes => ({ size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
function keys(value, expected) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), 'Unknown or missing fields');
}
function admission(env, platform = process.platform, arch = process.arch) {
  assert.equal(platform, 'linux'); assert.equal(arch, 'x64');
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
    GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: REF,
    GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${WORKFLOW}@${REF}`, SIGNED_CONTROLS_EXECUTE: 'true' })) {
    assert.equal(env[key], value, key);
  }
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) {
    assert.match(env[key] || '', /^[1-9][0-9]*$/);
    assert.ok(Number.isSafeInteger(Number(env[key])));
  }
  assert.ok(!Object.keys(env).some(key => /^(NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|PYTHON|LD_|DYLD_)/.test(key)), 'Runtime injection refused');
}
function profile(raw) {
  assert.deepEqual(record(raw), PROFILE, 'Exact reviewed 4d9 profile required');
  return JSON.parse(raw.toString('utf8'));
}
function asset(value, expected, role) {
  keys(value, ['id', 'name', 'size', 'digest', 'state', 'url']);
  assert.equal(value.id, ASSETS[role]); assert.equal(expected.asset, ASSETS[role]);
  assert.equal(value.name, expected.name); assert.equal(value.size, expected.zip.size);
  assert.equal(value.digest, `sha256:${expected.zip.sha256}`); assert.equal(value.state, 'uploaded');
  assert.equal(value.url, `https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases/assets/${ASSETS[role]}`);
}
function transport(raw, p, env) {
  const value = JSON.parse(raw.toString('utf8'));
  assert.equal(raw.toString('utf8'), JSON.stringify(value, null, 2) + '\n', 'Canonical transport receipt required');
  keys(value, ['schemaVersion', 'harnessSource', 'run', 'attempt', 'profile', 'release', 'assets', 'dataOnly', 'releaseReady']);
  assert.equal(value.schemaVersion, 1); assert.equal(value.harnessSource, env.GITHUB_SHA);
  assert.equal(value.run, Number(env.GITHUB_RUN_ID)); assert.equal(value.attempt, Number(env.GITHUB_RUN_ATTEMPT));
  assert.deepEqual(value.profile, PROFILE); assert.equal(value.dataOnly, true); assert.equal(value.releaseReady, false);
  assert.deepEqual(value.release, { id: 411494394, tag_name: 'v0.1.13-validation', draft: true });
  keys(value.assets, ROLES);
  for (const role of ROLES) asset(value.assets[role], p.deliveries[role], role);
  return value;
}
function inside(file, scope) {
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file);
  const relative = path.relative(scope, file);
  assert.ok(relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  for (let part = file;; part = path.dirname(part)) {
    try { assert.equal(fs.lstatSync(part).isSymbolicLink(), false, 'Redirected staging path refused'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (part === path.dirname(part)) break;
  }
}
function sourceBinding() {
  assert.deepEqual(record(finite.read(path.join(ROOT, FIXTURE), 128 * 1024)), FIXTURE_PIN, 'Frozen fixture changed');
  const key = finite.read(path.join(ROOT, 'src-tauri/src/catalog-key.pub'), 4096).toString('utf8').replace(/\r\n/g, '\n');
  assert.equal(record(Buffer.from(key)).sha256, '23b3eee2d1c8cb7d705120953cda67ff94a722a207d5be1679c250be8ca90308');
  return Object.fromEntries(SOURCES.map(name => [name, record(finite.read(path.join(ROOT, name), 2 * 1024 * 1024))]));
}
function prepare(download, output, env = process.env, platform = process.platform, arch = process.arch) {
  admission(env, platform, arch);
  const scope = fs.realpathSync(env.RUNNER_TEMP);
  inside(download, scope); inside(output, scope);
  assert.equal(fs.existsSync(output), false, 'Existing output is not adopted');
  assert.deepEqual(fs.readdirSync(download).sort(), ['profile.json', 'signedPortable16.zip', 'signedPortable17.zip', 'transport.json']);
  const raw = finite.read(path.join(download, 'profile.json'), PROFILE.size), p = profile(raw);
  const proof = finite.read(path.join(download, 'transport.json'), 65536);
  transport(proof, p, env);
  return { download, output, repository: ROOT, profile: PROFILE, transport: record(proof), sourceFiles: sourceBinding(),
    harnessSource: env.GITHUB_SHA, run: Number(env.GITHUB_RUN_ID), attempt: Number(env.GITHUB_RUN_ATTEMPT) };
}
const STAGE_PYTHON = String.raw`
import importlib.util,json,os,stat,sys
from pathlib import Path
plan=json.loads(sys.stdin.buffer.read(65537));assert len(json.dumps(plan))<65536
repo=Path(plan['repository']);source=repo/'scripts/native-linux-production-016-update.py'
spec=importlib.util.spec_from_file_location('signed_controls_archive',source)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
download,output=Path(plan['download']),Path(plan['output'])
def native_ancestry(target):
    if sys.platform!='linux': return None
    m.require(os.getuid()>0 and os.getuid()==os.geteuid(),'Unprivileged same-user fixture required')
    rows=[]
    for part in (target,*target.parents):
        try: info=part.lstat()
        except FileNotFoundError: continue
        directory=stat.S_ISDIR(info.st_mode);temporary=directory and info.st_uid==0 and bool(info.st_mode&0o1000)
        row=dict(path=str(part),uid=info.st_uid,gid=info.st_gid,mode=info.st_mode&0o7777,directory=directory)
        m.require(directory and not stat.S_ISLNK(info.st_mode) and info.st_uid in (0,os.geteuid())
                  and (info.st_mode&0o022==0 or temporary),'Native fixture ancestry refused: '+json.dumps(row,sort_keys=True))
        rows.append(row)
    return rows
raw=m.bound(download/'profile.json',plan['profile'],65536);p=m.parse(raw)
m.bound(download/'transport.json',plan['transport'],65536)
for name,pin in plan['sourceFiles'].items():m.bound(repo/name,pin,2*1024**2)
assert not output.exists();before_ancestry=native_ancestry(output.parent);output.mkdir(mode=0o700)
inputs=output/'input';carriers=output/'carriers'
for target in [inputs,carriers,inputs/'artifacts',inputs/'artifacts/release-016-updater-20261019',
               inputs/'artifacts/signed-reviewed016-portable-39435741602',inputs/'artifacts/signed-private-portable017-39358518825']:
    target.mkdir(mode=0o700)
files={}
for role,version,directory in [('signedPortable16','0.1.16','signed-reviewed016-portable-39435741602'),
                              ('signedPortable17','0.1.17','signed-private-portable017-39358518825')]:
    expected=p['deliveries'][role];staged=carriers/role
    m.stage_zip(download/(role+'.zip'),expected,staged)
    for suffix in ['portable-manifest.json','portable-manifest.json.minisig','appdir.tar.gz']:
        name='creator-hub-linux-x86_64-'+version+'.'+suffix
        target=inputs/'artifacts'/directory/name;pin=expected['files'][name]
        m.write(target,m.bound(staged/name,pin));m.bound(target,pin)
        files[str(target.relative_to(inputs))]=pin
name='${PROFILE_NAME}'
m.write(inputs/name,raw);m.bound(inputs/name,plan['profile'],65536);files[name]=plan['profile']
for name,pin in plan['sourceFiles'].items():m.bound(repo/name,pin,2*1024**2)
m.bound(download/'transport.json',plan['transport'],65536)
receipt=dict(plan,schemaVersion=1,scope='signed-4d9-016-private017-test-input-staging-only',files=files,
             nativeAncestry=dict(checked=sys.platform=='linux',beforeOutput=before_ancestry,input=native_ancestry(inputs),resultParent=native_ancestry(output)),
             signatureVerified=False,rootExecuted=False,selectorExecuted=False,nativeGuiAccepted=False,releaseReady=False)
m.write(output/'stage-receipt.json',(json.dumps(receipt,sort_keys=True,indent=2)+'\n').encode())
print(json.dumps({'stagedFiles':len(files),'releaseReady':False}))
`;
function stage(download, output, env = process.env) {
  const plan = prepare(download, output, env);
  const result = JSON.parse(execFileSync('/usr/bin/python3', ['-I', '-S', '-B', '-c', STAGE_PYTHON], {
    input: JSON.stringify(plan), encoding: 'utf8', timeout: 180000, maxBuffer: 65536, windowsHide: true,
  }));
  assert.deepEqual(result, { stagedFiles: 7, releaseReady: false });
  for (const [name, pin] of Object.entries(plan.sourceFiles)) assert.deepEqual(record(finite.read(path.join(ROOT, name), 2 * 1024 * 1024)), pin);
  return result;
}
module.exports = { ROOT, WORKFLOW, REF, PROFILE, PROFILE_NAME, FIXTURE, FIXTURE_PIN, ROLES, ASSETS, SOURCES,
  record, admission, profile, asset, transport, inside, sourceBinding, prepare, STAGE_PYTHON, stage };
if (require.main === module) {
  try {
    assert.equal(process.argv.length, 5); assert.equal(process.argv[2], 'stage');
    console.log(JSON.stringify(stage(process.argv[3], process.argv[4])));
  } catch (error) { console.error(String(error.message).slice(0, 1500)); process.exitCode = 1; }
}
