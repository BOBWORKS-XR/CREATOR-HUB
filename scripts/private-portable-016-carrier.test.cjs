'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const c = require('./private-portable-016-carrier.cjs');
const { yaml } = require('../node_modules/playwright-core/lib/utilsBundle.js');
const workflowSource = fs.readFileSync(path.join(__dirname, '..', c.WORKFLOW), 'utf8');
const document = yaml.parseDocument(workflowSource, { uniqueKeys: true }); assert.deepEqual(document.errors, []);
const workflow = document.toJSON(), AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function owned(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'portable016-carrier-unit-')));
  t.after(() => { assert.equal(fs.realpathSync(root), root); assert.ok(path.basename(root).startsWith('portable016-carrier-unit-')); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
// Opaque synthetic bytes, deliberately not valid signatures, metadata, TARs or executable packages.
function sample() {
  const bodies = Object.fromEntries(c.FILES.map(name => [name, Buffer.from(`Synthetic opaque transport fixture: ${name}`)]));
  return { bodies, input: { schemaVersion: 1, assetId: 1234, zip: c.record(Buffer.from('Synthetic ZIP download')),
    files: Object.fromEntries(Object.entries(bodies).map(([name, bytes]) => [name, c.record(bytes)])), planSha256: c.record(bodies['plan.json']).sha256 } };
}
function environment() { return { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: c.BRANCH,
  GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${c.WORKFLOW}@${c.BRANCH}`, GITHUB_SHA: 'a'.repeat(40) }; }
test('helper import is standard-library-only, has no signing/qualification or subprocess side effects', () => {
  const program = `const M=require('node:module'),load=M._load,entry=${JSON.stringify(require.resolve('./private-portable-016-carrier.cjs'))};M._load=function(n,...a){if(n!==entry&&!n.startsWith('node:'))throw Error('Nonstandard import');return load.call(this,n,...a)};const c=require(entry);if(Object.values(c.flags()).some(Boolean))throw Error('Acceptance claim');`;
  const result = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8', windowsHide: true, timeout: 10000 }); assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(c.stage.toString(), /signingKey|signDetached|\.activate\(|dpkg|apt-get|cargo|--appimage-extract/);
});
test('finite constants match existing thirteen-file and four-metadata transport contracts and size bounds', () => {
  const existing = require('./private-linux-portable-fixture-017.cjs'), base = require('./linux-016-portable-package.cjs');
  assert.deepEqual(c.FILES, existing.LEGACY_NAMES); assert.equal(c.METADATA.length, 4); assert.ok(c.METADATA.every(name => c.FILES.includes(name)));
  assert.equal(c.ZIP, base.LIMITS.zip); assert.equal(c.FILE, base.LIMITS.file); assert.equal(c.META, 2 * 1024 * 1024); assert.equal(c.SIGNED_META, 128 * 1024);
  for (const name of c.METADATA) assert.equal(c.limit(name), name.endsWith('.minisig') ? 4096 : c.SIGNED_META);
});
test('independent JSON admits only exact13 pins and refuses unknown policy, absent pins, unsafe sizes and duplicate keys', () => {
  const { input } = sample(); c.validate(input); c.parse(JSON.stringify(input, null, 2));
  for (const mutate of [v => { v.assetId = true; }, v => { v.zip.size = c.ZIP + 1; }, v => { v.files['plan.json'].size = c.SIGNED_META + 1; },
    v => { v.files[c.METADATA[1]].size = 4097; }, v => { delete v.files['fresh-api.json']; }, v => { v.files['../escape'] = v.files['plan.json']; },
    v => { v.zip.sha256 = 'BAD'; }, v => { v.planSha256 = 'b'.repeat(64); }, v => { v.releaseReady = false; }, v => { v.allowUnknown = true; }]) {
    const value = structuredClone(input); mutate(value); assert.throws(() => c.validate(value));
  }
  assert.throws(() => c.parse(JSON.stringify(input))); assert.throws(() => c.parse(JSON.stringify(input, null, 2).replace('{', '{"assetId":1234,')));
});
test('manual hosted admission refuses pushes, other branches/platforms, wrong repository and interpreter injection', () => {
  c.admission(environment(), 'linux', 'x64');
  for (const [name, value] of Object.entries({ GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', RUNNER_ENVIRONMENT: 'self-hosted',
    GITHUB_REPOSITORY_ID: '2', GITHUB_WORKFLOW_REF: 'other', PYTHONPATH: '', NODE_OPTIONS: '', LD_PRELOAD: '' })) assert.throws(() => c.admission({ ...environment(), [name]: value }, 'linux', 'x64'));
  assert.throws(() => c.admission(environment(), 'darwin', 'x64')); assert.throws(() => c.admission(environment(), 'linux', 'arm64'));
  assert.throws(() => c.stage('/never/read', '/never/write', {}));
});
test('asset binding admits only fixed private draft/name, uploaded exact byte identity and bounded complete asset list', () => {
  const { input } = sample(), release = { id: c.RELEASE, tag_name: c.TAG, draft: true }, good = { id: input.assetId, name: c.ASSET, state: 'uploaded', size: input.zip.size, digest: `sha256:${input.zip.sha256}` };
  c.asset(input, release, [good]);
  for (const change of [{ name: 'renamed.zip' }, { state: 'new' }, { size: 1 }, { digest: 'sha256:bad' }]) assert.throws(() => c.asset(input, release, [{ ...good, ...change }]));
  for (const change of [{ draft: false }, { id: 1 }, { tag_name: 'v0.1.16' }]) assert.throws(() => c.asset(input, { ...release, ...change }, [good]));
  assert.throws(() => c.asset(input, release, [good, good])); assert.throws(() => c.asset(input, release, Array(100).fill(good)));
});
async function gate(t, fault = '') {
  const temp = owned(t), { input } = sample(), bytes = Buffer.from('Synthetic ZIP download');
  if (fault === 'unknown') input.policy = 'anything'; if (fault === 'size') input.zip.size = c.ZIP + 1;
  const env = { ...environment(), TRANSPORT_INPUT: JSON.stringify(input, null, 2), RUNNER_TEMP: temp };
  if (fault === 'duplicate') env.TRANSPORT_INPUT = env.TRANSPORT_INPUT.replace('{', '{"assetId":1234,');
  const context = { repo: { owner: 'BOBWORKS-XR', repo: 'CREATOR-HUB' }, eventName: 'workflow_dispatch', ref: c.BRANCH };
  if (fault === 'push') context.eventName = 'push';
  const release = { id: c.RELEASE, tag_name: c.TAG, draft: fault !== 'public' };
  const asset = { id: input.assetId, name: fault === 'name' ? 'wrong.zip' : c.ASSET, state: 'uploaded', size: input.zip.size, digest: `sha256:${input.zip.sha256}` };
  if (fault === 'digest') asset.digest = 'sha256:bad';
  const calls = [], github = { rest: { repos: {
    getRelease: async args => { calls.push('release'); assert.equal(args.release_id, c.RELEASE); return { data: release }; },
    listReleaseAssets: async args => { calls.push('list'); assert.equal(args.release_id, c.RELEASE); assert.equal(args.per_page, 100); assert.equal(args.page, 1); return { data: [asset] }; },
    getReleaseAsset: async args => { calls.push('download'); assert.equal(args.asset_id, input.assetId); return { data: fault === 'bytes' ? Buffer.from('changed') : bytes }; },
  } } };
  const script = workflow.jobs['stage-input'].steps[0].with.script;
  return { temp, calls, execute: () => new AsyncFunction('require', 'process', 'context', 'github', script)(require, { env }, context, github) };
}
test('token-bearing gate reads only fixed release APIs, compares bytes before writing and never decodes a candidate', async t => {
  const f = await gate(t); await f.execute(); assert.deepEqual(f.calls, ['release', 'list', 'download']);
  assert.deepEqual(fs.readdirSync(f.temp).sort(), ['private-portable016.zip', 'transport-input.json']);
  const body = workflow.jobs['stage-input'].steps[0].with.script;
  assert.doesNotMatch(body, /child_process|execFile|spawn|require\(['"]\.\/|zipfile|signingKey|signDetached|console\.|secrets\.|auth\.json/);
  await assert.rejects(f.execute());
});
test('token-bearing gate refuses invalid independent input before API and wrong/private asset identity before download', async t => {
  for (const fault of ['unknown', 'size', 'duplicate', 'push', 'public', 'name', 'digest', 'bytes']) {
    const f = await gate(t, fault); await assert.rejects(f.execute()); assert.deepEqual(fs.readdirSync(f.temp), []);
    if (['unknown', 'size', 'duplicate', 'push'].includes(fault)) assert.deepEqual(f.calls, []);
    else if (fault !== 'bytes') assert.equal(f.calls.includes('download'), false);
  }
});
function stageFixture(t, fault = '') {
  const root = owned(t), { bodies, input } = sample(), source = path.join(root, 'input.zip'), request = path.join(root, 'request.json'), output = path.join(root, 'output');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const make = spawnSync(python, ['-B', '-c', `import base64,json,stat,sys,zipfile
c=json.load(sys.stdin);fault=sys.argv[2]
with zipfile.ZipFile(sys.argv[1],'x',compression=zipfile.ZIP_STORED) as z:
 for i,(n,b) in enumerate(c.items()):
  item=zipfile.ZipInfo(n);item.create_system=3;item.external_attr=(stat.S_IFREG|0o600)<<16
  if i==0 and fault=='link': item.external_attr=(stat.S_IFLNK|0o777)<<16
  if i==0 and fault=='fifo': item.external_attr=(stat.S_IFIFO|0o600)<<16
  if i==0 and fault=='setuid': item.external_attr=(stat.S_IFREG|0o4600)<<16
  z.writestr(item,base64.b64decode(b))
 if fault=='duplicate': z.writestr(next(iter(c)),b'duplicate')
 if fault=='traversal': z.writestr('../escape',b'forbidden')
`, source, fault], { input: JSON.stringify(Object.fromEntries(Object.entries(bodies).map(([name, bytes]) => [name, bytes.toString('base64')]))), encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(make.status, 0, make.stderr); input.zip = c.record(fs.readFileSync(source));
  if (fault === 'zip-hash') input.zip.sha256 = 'f'.repeat(64);
  if (fault === 'file-hash') input.files['fresh-api.json'].sha256 = 'f'.repeat(64);
  fs.writeFileSync(request, JSON.stringify(input, null, 2)); fs.mkdirSync(output);
  if (fault === 'hardlink') fs.linkSync(source, path.join(root, 'archive-hardlink'));
  if (fault === 'existing') fs.writeFileSync(path.join(output, 'keep'), 'keep');
  return { root, bodies, input, output, execute: () => spawnSync(python, ['-B', '-c', c.STAGE_PYTHON, source, request, output, root], { encoding: 'utf8', timeout: 10000, windowsHide: true }) };
}
test('standard-library Python streams exact13 opaque bytes and separate4 metadata copies without interpreting or executing them', t => {
  const f = stageFixture(t), result = f.execute(); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { files: f.input.files, metadata: Object.fromEntries(c.METADATA.map(name => [name, f.input.files[name]])), zip: f.input.zip });
  assert.deepEqual(fs.readdirSync(path.join(f.output, 'all')).sort(), [...c.FILES].sort()); assert.deepEqual(fs.readdirSync(path.join(f.output, 'metadata')).sort(), [...c.METADATA].sort());
  for (const [name, bytes] of Object.entries(f.bodies)) { assert.ok(fs.readFileSync(path.join(f.output, 'all', name)).equals(bytes)); assert.equal(fs.lstatSync(path.join(f.output, 'all', name)).nlink, 1); }
  for (const name of c.METADATA) assert.ok(fs.readFileSync(path.join(f.output, 'metadata', name)).equals(f.bodies[name]));
  assert.notEqual(f.execute().status, 0); assert.ok(Object.values(c.flags()).every(v => v === false));
});
test('Python refuses duplicate, escaped, linked, special, changed and pre-existing data without overwriting anything', t => {
  for (const fault of ['duplicate', 'traversal', 'link', 'fifo', 'setuid', 'zip-hash', 'file-hash', 'hardlink', 'existing']) {
    const f = stageFixture(t, fault), result = f.execute(); assert.notEqual(result.status, 0, fault);
    assert.equal(fs.existsSync(path.join(f.root, 'escape')), false); if (fault === 'existing') assert.equal(fs.readFileSync(path.join(f.output, 'keep'), 'utf8'), 'keep');
  }
});
test('workflow registration pushes skip both jobs; write-token isolation, exact artifact roles and all script syntax are preserved', () => {
  assert.deepEqual(workflow.on.push.branches, [c.BRANCH.slice('refs/heads/'.length)]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ['transport_input']); assert.equal(workflow.on.workflow_dispatch.inputs.transport_input.required, true);
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' }); assert.deepEqual(workflow.jobs['stage-input'].permissions, { contents: 'write' });
  assert.equal(workflow.jobs['stage-input'].steps.length, 2); assert.ok(workflow.jobs['stage-input'].steps.every(step => !step.run));
  assert.equal(workflow.jobs.stage.needs, 'stage-input'); assert.deepEqual(workflow.jobs.stage.permissions, { contents: 'read', actions: 'read' });
  const good = { repository: 'BOBWORKS-XR/CREATOR-HUB', repository_id: '1364807512', event_name: 'workflow_dispatch', ref: c.BRANCH };
  for (const job of Object.values(workflow.jobs)) {
    const guard = new Function('github', `return (${job.if});`); assert.equal(guard(good), true);
    for (const [key, value] of Object.entries({ repository: 'other/fork', repository_id: '1', event_name: 'push', ref: 'refs/heads/main' })) assert.equal(guard({ ...good, [key]: value }), false);
    assert.equal(job['runs-on'], 'ubuntu-22.04');
    for (const step of job.steps) {
      if (step.with?.script) new AsyncFunction('require', 'process', 'context', 'github', step.with.script);
      if (step.run) { const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash'; const parsed = spawnSync(shell, ['-n'], { input: step.run, encoding: 'utf8', timeout: 10000, windowsHide: true }); assert.equal(parsed.status, 0, parsed.stderr); }
    }
  }
  const outputs = workflow.jobs.stage.steps.filter(step => step.uses === 'actions/upload-artifact@v4'); assert.equal(outputs.length, 3);
  assert.deepEqual(outputs[0].with.path.trim().split('\n').map(line => path.posix.basename(line)).sort(), [...c.FILES].sort());
  assert.deepEqual(outputs[1].with.path.trim().split('\n').map(line => path.posix.basename(line)).sort(), [...c.METADATA].sort());
  assert.equal(outputs[2].if, 'always()'); assert.doesNotMatch(outputs[2].with.path, /\/all\/|\/metadata\//);
  assert.doesNotMatch(workflowSource, /continue-on-error|apt-get|cargo |npm |signingKey|signDetached|createRelease|updateRelease|uploadReleaseAsset|secrets\./);
  assert.equal(workflow.jobs.stage.steps.find(step => step.uses === 'actions/setup-node@v6').with['node-version'], '24.17.0');
});
