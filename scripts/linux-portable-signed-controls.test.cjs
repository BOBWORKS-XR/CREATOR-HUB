'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { yaml } = require('../node_modules/playwright-core/lib/utilsBundle.js');
const c = require('./linux-portable-signed-controls.cjs');
const workflowFile = path.join(c.ROOT, c.WORKFLOW);
const document = yaml.parseDocument(fs.readFileSync(workflowFile, 'utf8'), { uniqueKeys: true });
assert.deepEqual(document.errors, []);
const workflow = document.toJSON();
const downloadScript = workflow.jobs['signed-inputs'].steps[0].with.script;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const download = new AsyncFunction('github', 'context', 'require', 'process', downloadScript);
const python = process.env.TEST_PYTHON || (process.platform === 'win32' ? 'python' : '/usr/bin/python3');
const retainedProfile = process.env.SIGNED_CONTROLS_TEST_PROFILE || path.join(c.ROOT, c.PROFILE_NAME);
// Default broad source suites need not possess private inputs. The manual worker
// supplies this explicit file; a missing/malformed explicit file is a hard failure.
const original = process.env.SIGNED_CONTROLS_TEST_PROFILE || fs.existsSync(retainedProfile) ? fs.readFileSync(retainedProfile) : null;
if (original) c.profile(original);
const p = original && c.profile(original);
const env = extra => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_REF: c.REF, GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${c.WORKFLOW}@${c.REF}`,
  GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', SIGNED_CONTROLS_EXECUTE: 'true', ...extra });
function asset(role) {
  const e = p.deliveries[role];
  return { id: e.asset, name: e.name, size: e.zip.size, digest: `sha256:${e.zip.sha256}`, state: 'uploaded',
    url: `https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases/assets/${e.asset}` };
}
function transport() {
  return { schemaVersion: 1, harnessSource: 'a'.repeat(40), run: 123, attempt: 1, profile: c.PROFILE,
    release: { id: 411494394, tag_name: 'v0.1.13-validation', draft: true },
    assets: Object.fromEntries(c.ROLES.map(role => [role, asset(role)])), dataOnly: true, releaseReady: false };
}
const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
function mockTransfer({ extraEnv = {}, release = {}, mutateAsset = () => {}, body = original, bytes } = {}) {
  const calls = [], writes = [], boundary = new Error('test stops before original ZIP download');
  const values = env({ RUNNER_TEMP: os.tmpdir(), SIGNED_PROFILE: body?.toString('utf8'), ...extraEnv });
  const github = { rest: { repos: {
    async getRelease(args) { calls.push(['release', args]); return { data: { id: 411494394, tag_name: 'v0.1.13-validation', draft: true, ...release } }; },
    async getReleaseAsset(args) {
      calls.push([args.headers ? 'bytes' : 'asset', args]);
      if (args.headers) { if (bytes === undefined) throw boundary; return { data: bytes }; }
      const role = c.ROLES.find(role => c.ASSETS[role] === args.asset_id);
      assert.ok(role); const row = asset(role); mutateAsset(row, role); return { data: row };
    },
  } } };
  const mockedFs = { realpathSync: value => value,
    mkdirSync: (...args) => writes.push(['mkdir', ...args]), writeFileSync: (...args) => writes.push(['write', ...args]) };
  const requireMock = name => name === 'node:fs' ? mockedFs : require(name);
  return { calls, writes, boundary,
    run: () => download(github, { repo: { owner: 'BOBWORKS-XR', repo: 'CREATOR-HUB' }, sha: values.GITHUB_SHA, runId: 123 }, requireMock, { env: values }) };
}

test('push and ordinary manual lane retain their original commands and permissions', () => {
  assert.deepEqual(workflow.on.push, { branches: ['validation/linux-portable-deployment'], paths: ['native/linux-portable-deployment/**', c.WORKFLOW] });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.on.workflow_dispatch.inputs.run_signed_controls.default, false);
  assert.equal(workflow.on.workflow_dispatch.inputs.signed_profile.default, '');
  const job = workflow.jobs.primitives;
  assert.equal(job['timeout-minutes'], 10); assert.equal(job['runs-on'], 'ubuntu-22.04');
  assert.deepEqual(job.steps, [
    { uses: 'actions/checkout@v6', with: { 'persist-credentials': false } },
    { uses: 'dtolnay/rust-toolchain@1.99.0', with: { components: 'clippy,rustfmt' } },
    { name: 'Verify formatting and reject warnings in this isolated crate only', env: { CARGO_TARGET_DIR: '${{ runner.temp }}/linux-portable-deployment-target' },
      run: 'set -euo pipefail\ncargo fmt --manifest-path native/linux-portable-deployment/Cargo.toml --check\ncargo clippy --locked --manifest-path native/linux-portable-deployment/Cargo.toml --all-targets -- -D warnings\ncargo clippy --locked --manifest-path native/linux-portable-deployment/Cargo.toml --all-targets --features experimental-restart -- -D warnings\n' },
    { name: 'Test signed inventory, native filesystem guards and transaction recovery', env: { CARGO_TARGET_DIR: '${{ runner.temp }}/linux-portable-deployment-target' },
      run: 'set -euo pipefail\ncargo test --locked --manifest-path native/linux-portable-deployment/Cargo.toml -- --test-threads=1\ncargo test --locked --manifest-path native/linux-portable-deployment/Cargo.toml --features experimental-restart -- --test-threads=1\n' },
  ]);
});

test('manual controls are distinct, branch/repository bound, default off, and never authorize push', () => {
  const base = { repository: 'BOBWORKS-XR/CREATOR-HUB', repository_id: '1364807512', ref: c.REF,
    event_name: 'workflow_dispatch', workflow_ref: `BOBWORKS-XR/CREATOR-HUB/${c.WORKFLOW}@${c.REF}` };
  const gate = (name, github, enabled) => new Function('github', 'inputs', `return (${workflow.jobs[name].if});`)(github, { run_signed_controls: enabled });
  assert.equal(gate('primitives', base, false), true); assert.equal(gate('primitives', base, true), false);
  for (const enabled of [false, true]) assert.equal(gate('primitives', { ...base, event_name: 'push' }, enabled), true);
  for (const name of ['signed-inputs', 'signed-controls']) {
    assert.equal(gate(name, base, true), true); assert.equal(gate(name, base, false), false);
    for (const key of Object.keys(base)) assert.equal(gate(name, { ...base, [key]: 'foreign' }, true), false, `${name}:${key}`);
  }
});

test('private token has no checkout/execution and the worker has only read permissions', () => {
  const source = workflow.jobs['signed-inputs'], worker = workflow.jobs['signed-controls'];
  assert.deepEqual(source.permissions, { contents: 'write' }); assert.equal(source.steps.length, 2);
  assert.ok(source.steps.every(step => !step.run && !step.uses.startsWith('actions/checkout')));
  assert.deepEqual(worker.permissions, { contents: 'read', actions: 'read' });
  assert.equal(worker.needs, 'signed-inputs');
  assert.equal(worker.steps.find(s => s.uses === 'actions/checkout@v6').with.ref, '${{ github.sha }}');
  assert.equal(worker.steps.find(s => s.uses === 'actions/checkout@v6').with['persist-credentials'], false);
  assert.equal(worker.steps.find(s => s.uses === 'actions/download-artifact@v4').with['artifact-ids'], '${{ needs.signed-inputs.outputs.artifact }}');
  const commands = worker.steps.filter(s => s.run).map(s => s.run).join('\n');
  assert.ok(commands.indexOf('node --test') < commands.indexOf('linux-portable-signed-controls.cjs stage'));
  assert.match(commands, /cargo fetch --locked/); assert.match(commands, /cargo test --release --offline --locked/);
  assert.match(commands, /--exact signed_input_filesystem_controls --ignored --nocapture --test-threads=1/);
  assert.doesNotMatch(commands, /sudo|apt-get|dpkg|flatpak|tauri build|cargo build|systemctl|gh release|broker|native_session/);
  const evidence = worker.steps.find(s => s.uses === 'actions/upload-artifact@v4');
  assert.equal(evidence.if, 'always()'); assert.doesNotMatch(evidence.with.path, /\*|\.tar|\.zip|\.AppImage|\/data\/|\/carriers\//);
  assert.match(evidence.with.path, /result\/04-stale.json/); assert.match(evidence.with.path, /stage-receipt.json/);
});

test('all Bash, embedded JS and staging Python parse without execution', () => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/usr/bin/bash';
  for (const job of Object.values(workflow.jobs)) for (const step of job.steps) {
    if (step.run) execFileSync(bash, ['-n'], { input: step.run, timeout: 5000, windowsHide: true });
    if (step.with?.script) new AsyncFunction('github', 'context', step.with.script);
  }
  execFileSync(python, ['-I', '-S', '-B', '-c', 'import ast,sys;ast.parse(sys.stdin.read(),feature_version=(3,10))'], { input: c.STAGE_PYTHON, timeout: 5000, windowsHide: true });
  assert.match(c.STAGE_PYTHON, /m.stage_zip\(/); assert.doesNotMatch(c.STAGE_PYTHON, /m\.(?:broker|stage|native_session|main)\(/);
});

test('each worker admission field and runtime injection fails closed', () => {
  c.admission(env(), 'linux', 'x64');
  for (const key of Object.keys(env())) assert.throws(() => c.admission(env({ [key]: 'foreign' }), 'linux', 'x64'), key);
  for (const key of ['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'PYTHONPATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES']) {
    assert.throws(() => c.admission(env({ [key]: 'injected' }), 'linux', 'x64'), key);
  }
  for (const value of ['0', '-1', '01', '1.0', '9007199254740992']) for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) {
    assert.throws(() => c.admission(env({ [key]: value }), 'linux', 'x64'));
  }
  assert.throws(() => c.admission(env(), 'win32', 'x64')); assert.throws(() => c.admission(env(), 'linux', 'arm64'));
});

test('private downloader refuses every wrong admission before API or filesystem use', async () => {
  for (const key of Object.keys(env())) {
    const mock = mockTransfer({ extraEnv: { [key]: 'foreign' } });
    await assert.rejects(mock.run); assert.deepEqual(mock.calls, [], key); assert.deepEqual(mock.writes, []);
  }
  const mock = mockTransfer({ body: Buffer.from('{}') });
  await assert.rejects(mock.run); assert.deepEqual(mock.calls, []); assert.deepEqual(mock.writes, []);
});

test('actual frozen fixture and production public key remain source bound', () => {
  const files = c.sourceBinding();
  assert.deepEqual(files[c.FIXTURE], c.FIXTURE_PIN); assert.equal(Object.keys(files).length, c.SOURCES.length);
});

test('actual runner ancestry uses native UID/type/mode rules without group assumptions or chmod', () => {
  assert.doesNotMatch(c.STAGE_PYTHON, /chmod|chown|setfacl/);
  const script = String.raw`
import ast,json,stat,sys
from types import SimpleNamespace
tree=ast.parse(sys.stdin.read());node=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='native_ancestry')
def require(value,message):
    if not value:raise ValueError(message)
ns={'os':SimpleNamespace(getuid=lambda:1001,geteuid=lambda:1001),'sys':SimpleNamespace(platform='linux'),
    'stat':stat,'json':json,'m':SimpleNamespace(require=require)}
exec(compile(ast.Module(body=[node],type_ignores=[]),'actual-native-ancestry','exec'),ns)
class P:
    parents=()
    def __init__(self,uid,mode,gid=999):self.info=SimpleNamespace(st_uid=uid,st_gid=gid,st_mode=mode)
    def lstat(self):return self.info
    def __str__(self):return '/actual/runner/path'
for uid,mode in [(1001,0o40700),(1001,0o40755),(0,0o40755),(0,0o41777)]:
    rows=ns['native_ancestry'](P(uid,mode));assert rows[0]['gid']==999 and rows[0]['mode']==mode&0o7777
for uid,mode in [(1001,0o40775),(7,0o40700),(0,0o40777),(1001,0o41777),(0,0o120777),(1001,0o100700)]:
    try:ns['native_ancestry'](P(uid,mode))
    except ValueError as error:assert 'Native fixture ancestry refused' in str(error)
    else:raise AssertionError('unsafe ancestry admitted')
for uid,euid in [(0,0),(1001,0)]:
    ns['os']=SimpleNamespace(getuid=lambda:uid,geteuid=lambda:euid)
    try:ns['native_ancestry'](P(1001,0o40700))
    except ValueError:pass
    else:raise AssertionError('privileged fixture admitted')
ns['os']=SimpleNamespace(getuid=lambda:1001,geteuid=lambda:1001)
class Denied(P):
    def lstat(self):raise PermissionError('retained refusal')
try:ns['native_ancestry'](Denied(1001,0o40700))
except PermissionError:pass
else:raise AssertionError('permission refusal swallowed')
`;
  execFileSync(python, ['-I', '-S', '-B', '-c', script], { input: c.STAGE_PYTHON, timeout: 5000, windowsHide: true });
});

test('exact profile admits; same-size tamper and old ff cohort refuse before API', { skip: !original }, async () => {
  assert.equal(c.profile(original).baseline.source, '4d9e073465928b9e00719d5ba594343281cd1280');
  const changed = Buffer.from(original); changed[changed.indexOf('4d9e073465928b9e00719d5ba594343281cd1280')] = 102;
  assert.equal(changed.length, original.length); assert.throws(() => c.profile(changed));
  for (const body of [Buffer.concat([original, Buffer.from('\n')]), changed]) {
    const mock = mockTransfer({ body }); await assert.rejects(mock.run); assert.deepEqual(mock.calls, []); assert.deepEqual(mock.writes, []);
  }
});

test('both fixed API identities validate before first opaque download, with zero API writes', { skip: !original }, async () => {
  const mock = mockTransfer(); await assert.rejects(mock.run, error => error === mock.boundary);
  assert.deepEqual(mock.calls.map(c => c[0]), ['release', 'asset', 'asset', 'bytes']);
  assert.deepEqual(mock.calls.filter(c => c[0] === 'asset').map(c => c[1].asset_id), [659622698, 658277802]);
  assert.equal(mock.writes.filter(w => w[0] === 'write').length, 1);
  assert.equal(mock.writes[1][3].flag, 'wx');
});

test('wrong release and each asset field (including private017) refuse before bytes/copies', { skip: !original }, async () => {
  for (const release of [{ id: 1 }, { draft: false }, { tag_name: 'v0.1.17' }]) {
    const mock = mockTransfer({ release }); await assert.rejects(mock.run); assert.equal(mock.calls.length, 1); assert.deepEqual(mock.writes, []);
  }
  for (const role of c.ROLES) for (const field of ['id', 'name', 'size', 'digest', 'state', 'url']) {
    const mock = mockTransfer({ mutateAsset: (a, r) => { if (r === role) a[field] = 'foreign'; } });
    await assert.rejects(mock.run); assert.ok(mock.calls.every(c => c[0] !== 'bytes')); assert.deepEqual(mock.writes, []);
  }
});

test('wrong transfer body type or truncated original ZIP never writes a ZIP or completion receipt', { skip: !original }, async () => {
  for (const bytes of [{ unsafe: true }, 'not original bytes', Buffer.from('truncated'), new ArrayBuffer(1)]) {
    const mock = mockTransfer({ bytes }); await assert.rejects(mock.run);
    const files = mock.writes.filter(w => w[0] === 'write').map(w => path.basename(w[1]));
    assert.deepEqual(files, ['profile.json']);
  }
});

test('transport requires this source/run/attempt, exact roles, private origin and false qualification', { skip: !original }, () => {
  c.transport(encode(transport()), p, env());
  for (const field of Object.keys(transport())) {
    const value = transport(); value[field] = 'foreign'; assert.throws(() => c.transport(encode(value), p, env()), field);
  }
  for (const role of c.ROLES) for (const field of Object.keys(asset(role))) {
    const value = transport(); value.assets[role][field] = 'foreign'; assert.throws(() => c.transport(encode(value), p, env()));
  }
  const extra = transport(); extra.accepted = true; assert.throws(() => c.transport(encode(extra), p, env()));
  assert.throws(() => c.transport(Buffer.from(JSON.stringify(transport())), p, env()));
  const duplicate = encode(transport()).toString().replace('"schemaVersion": 1,', '"schemaVersion": 1, "schemaVersion": 1,');
  assert.throws(() => c.transport(Buffer.from(duplicate), p, env()));
});

test('staging planning is read-only; existing/symlink output and extras/escape/reforged transport refuse', { skip: !original }, () => {
  const scope = fs.mkdtempSync(path.join(os.tmpdir(), 'signed-controls-test-'));
  try {
    const folder = path.join(scope, 'download'), output = path.join(scope, 'staged'); fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, 'profile.json'), original); fs.writeFileSync(path.join(folder, 'transport.json'), encode(transport()));
    for (const role of c.ROLES) fs.writeFileSync(path.join(folder, role + '.zip'), 'not a production archive');
    const values = env({ RUNNER_TEMP: scope });
    const plan = c.prepare(folder, output, values, 'linux', 'x64'); assert.equal(plan.harnessSource, values.GITHUB_SHA); assert.equal(fs.existsSync(output), false);
    fs.mkdirSync(output); fs.writeFileSync(path.join(output, 'sentinel'), 'keep');
    assert.throws(() => c.prepare(folder, output, values, 'linux', 'x64')); assert.equal(fs.readFileSync(path.join(output, 'sentinel'), 'utf8'), 'keep');
    const link = path.join(scope, 'linked'); fs.symlinkSync(output, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => c.prepare(folder, link, values, 'linux', 'x64'));
    assert.throws(() => c.prepare(folder, path.join(scope, '..', 'escaped'), values, 'linux', 'x64'));
    fs.writeFileSync(path.join(folder, 'extra'), 'foreign'); assert.throws(() => c.prepare(folder, path.join(scope, 'fresh'), values, 'linux', 'x64')); fs.unlinkSync(path.join(folder, 'extra'));
    const wrong = transport(); wrong.attempt = 2; fs.writeFileSync(path.join(folder, 'transport.json'), encode(wrong));
    assert.throws(() => c.prepare(folder, path.join(scope, 'fresh'), values, 'linux', 'x64'));
    fs.writeFileSync(path.join(folder, 'transport.json'), encode(transport()));
    assert.throws(() => execFileSync(python, ['-I', '-S', '-B', '-c', c.STAGE_PYTHON], { input: JSON.stringify(plan), timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
    assert.equal(fs.existsSync(path.join(output, 'carriers')), false, 'Existing target must refuse before extraction');
    const refused = c.prepare(folder, path.join(scope, 'refused'), values, 'linux', 'x64');
    assert.throws(() => execFileSync(python, ['-I', '-S', '-B', '-c', c.STAGE_PYTHON], { input: JSON.stringify(refused), timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }));
    assert.equal(fs.existsSync(path.join(refused.output, 'carriers/signedPortable16')), false, 'Unsigned ZIP must refuse before extraction');
  } finally { fs.rmSync(scope, { recursive: true, force: true }); }
});
