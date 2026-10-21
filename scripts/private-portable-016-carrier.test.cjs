'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const c = require('./private-portable-016-carrier.cjs');
const REVIEWED_ASSET = 'signed-private-portable016-carrier-39435741602.zip';
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
  assert.equal(c.ASSET, 'signed-private-portable016-carrier-39365532397.zip');
  assert.equal(c.REVIEWED_ASSET, REVIEWED_ASSET);
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
test('asset binding preserves the old name and admits only the distinct reviewed name with exact ID/digest pins', () => {
  const { input } = sample(), release = { id: c.RELEASE, tag_name: c.TAG, draft: true }, good = { id: input.assetId, name: c.ASSET, state: 'uploaded', size: input.zip.size, digest: `sha256:${input.zip.sha256}` };
  c.asset(input, release, [good]);
  c.asset(input, release, [{ ...good, name: REVIEWED_ASSET }]);
  for (const change of [{ name: 'renamed.zip' }, { name: 'signed-private-portable016-carrier-39352300183.zip' },
    { name: 'signed-private-portable016-carrier-39435741603.zip' }, { name: REVIEWED_ASSET + '.extra' },
    { name: REVIEWED_ASSET.toUpperCase() }, { name: '../' + REVIEWED_ASSET },
    { id: input.assetId + 1 }, { state: 'new' }, { size: 1 }, { digest: 'sha256:bad' }]) assert.throws(() => c.asset(input, release, [{ ...good, ...change }]));
  for (const name of [c.ASSET, REVIEWED_ASSET]) {
    for (const change of [{ id: input.assetId + 1 }, { size: input.zip.size + 1 }, { digest: 'sha256:' + 'f'.repeat(64) }]) {
      assert.throws(() => c.asset(input, release, [{ ...good, name, ...change }]));
    }
  }
  for (const change of [{ draft: false }, { id: 1 }, { tag_name: 'v0.1.16' }]) assert.throws(() => c.asset(input, { ...release, ...change }, [good]));
  assert.throws(() => c.asset(input, release, [good, good])); assert.throws(() => c.asset(input, release, Array(100).fill(good)));
});
async function gate(t, fault = '', assetName = c.ASSET) {
  const temp = owned(t), { input } = sample(), bytes = Buffer.from('Synthetic ZIP download');
  if (fault === 'unknown') input.policy = 'anything'; if (fault === 'size') input.zip.size = c.ZIP + 1;
  const env = { ...environment(), TRANSPORT_INPUT: JSON.stringify(input, null, 2), RUNNER_TEMP: temp };
  if (fault === 'duplicate') env.TRANSPORT_INPUT = env.TRANSPORT_INPUT.replace('{', '{"assetId":1234,');
  const context = { repo: { owner: 'BOBWORKS-XR', repo: 'CREATOR-HUB' }, eventName: 'workflow_dispatch', ref: c.BRANCH };
  if (fault === 'push') context.eventName = 'push';
  const release = { id: c.RELEASE, tag_name: c.TAG, draft: fault !== 'public' };
  const asset = { id: input.assetId, name: fault === 'name' ? 'wrong.zip' : fault === 'old-name' ? 'signed-private-portable016-carrier-39352300183.zip' : assetName,
    state: 'uploaded', size: input.zip.size, digest: `sha256:${input.zip.sha256}` };
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
  for (const name of [c.ASSET, REVIEWED_ASSET]) {
    const f = await gate(t, '', name); await f.execute(); assert.deepEqual(f.calls, ['release', 'list', 'download']);
    assert.deepEqual(fs.readdirSync(f.temp).sort(), ['private-portable016.zip', 'transport-input.json']);
    await assert.rejects(f.execute());
  }
  const body = workflow.jobs['stage-input'].steps[0].with.script;
  assert.doesNotMatch(body, /child_process|execFile|spawn|require\(['"]\.\/|zipfile|signingKey|signDetached|console\.|secrets\.|auth\.json/);
});

test('token-bearing name admission is the same closed two-name set and refuses aliases before download', async t => {
  for (const name of ['signed-private-portable016-carrier-39435741603.zip', REVIEWED_ASSET + '.extra',
    REVIEWED_ASSET.toUpperCase(), '../' + REVIEWED_ASSET]) {
    const f = await gate(t, '', name); await assert.rejects(f.execute());
    assert.equal(f.calls.includes('download'), false); assert.deepEqual(fs.readdirSync(f.temp), []);
  }
});
test('token-bearing gate refuses invalid independent input before API and wrong/private asset identity before download', async t => {
  for (const fault of ['unknown', 'size', 'duplicate', 'push', 'public', 'name', 'old-name', 'digest', 'bytes']) {
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
  for (const job of [workflow.jobs['stage-input'], workflow.jobs.stage]) {
    const guard = new Function('github', 'inputs', 'fromJSON', `return (${job.if});`), inputs = { transport_input: '{"schemaVersion":1}' };
    assert.equal(guard(good, inputs, JSON.parse), true); assert.equal(guard(good, { transport_input: '{"schemaVersion":2}' }, JSON.parse), false);
    for (const [key, value] of Object.entries({ repository: 'other/fork', repository_id: '1', event_name: 'push', ref: 'refs/heads/main' })) assert.equal(guard({ ...good, [key]: value }, inputs, JSON.parse), false);
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

function sampleV2() {
  const bytes = Buffer.from('Synthetic opaque metadata ZIP, schema tests only');
  const files = Object.fromEntries(c.FILES.map(name => [name, { size: 100, sha256: 'a'.repeat(64) }]));
  files['plan.json'].sha256 = c.V2_PLAN; files['fresh-api.json'].size = 102438;
  files[c.FILES[1]].size = 150000000; files[c.FILES[2]].size = 150000000; files[c.FILES[4]].size = 151816429;
  return { schemaVersion: 2, producer: structuredClone(c.V2_PRODUCER), metadataZip: c.record(bytes), metadataBase64: bytes.toString('base64'),
    files, planSha256: c.V2_PLAN, output: structuredClone(c.V2_OUTPUT), deliverToDraft: false };
}
function producerAPI() {
  const run = { id: c.V2_PRODUCER.runId, run_attempt: 1, workflow_id: c.V2_PRODUCER.workflowId, event: 'workflow_dispatch',
    head_branch: 'validation/linux-016-portable-production', head_sha: c.V2_PRODUCER.sourceCommit, status: 'completed', conclusion: 'success',
    repository: { id: 1364807512 }, head_repository: { id: 1364807512 } };
  const required = ['Test exact selector sources with default and experimental restart features',
    'Verify production DEB, build only source-bound selector and bundle supplied Root once',
    'Retain unsigned complete transport, ordinary image and exact-byte setup alias', 'Retain original refusal evidence without claiming acceptance'];
  return { repository: { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' },
    workflow: { id: c.V2_PRODUCER.workflowId, path: '.github/workflows/linux-016-portable-production.yml', state: 'active' }, run, attempt: structuredClone(run),
    job: { id: c.V2_PRODUCER.jobId, name: 'package', run_id: run.id, run_attempt: 1, head_sha: run.head_sha, status: 'completed', conclusion: 'success', labels: ['ubuntu-22.04'],
      steps: [...required, ...Array.from({ length: 13 }, (_, i) => `Step ${i}`)].map(name => ({ name, status: 'completed', conclusion: name === required[3] ? 'skipped' : 'success' })) },
    artifact: { id: c.V2_PRODUCER.artifactId, name: 'linux-016-production-portable-unsigned-39648084197-1', expired: false,
      size_in_bytes: c.V2_PRODUCER.zip.size, digest: `sha256:${c.V2_PRODUCER.zip.sha256}`,
      workflow_run: { id: run.id, head_sha: run.head_sha, head_branch: run.head_branch, repository_id: 1364807512 } },
    commit: { sha: run.head_sha, tree: { sha: c.V2_PRODUCER.sourceTree } } };
}
function v2Environment(root, input, job = 'fetch-v2') {
  return { ...environment(), RUNNER_TEMP: root, GITHUB_WORKSPACE: path.resolve(__dirname, '..'), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: job,
    TRANSPORT_INPUT: JSON.stringify(input, null, 2) };
}
function contextV2(env) { return { repo: { owner: 'BOBWORKS-XR', repo: 'CREATOR-HUB' }, ref: c.BRANCH, sha: env.GITHUB_SHA, eventName: 'workflow_dispatch', runId: 123 }; }
function inlineV2(job, env, github, context = contextV2(env)) {
  const script = workflow.jobs[job].steps.find(s => s.uses === 'actions/github-script@v8').with.script;
  const imported = name => {
    assert.equal(name, env.GITHUB_WORKSPACE + '/scripts/private-portable-016-carrier.cjs');
    return { ...c, admission: e => c.admission(e, 'linux', 'x64') };
  };
  return new AsyncFunction('require', 'process', 'context', 'github', script)(imported, { env }, context, github);
}
function fetchAPI(api, calls, download) {
  const method = (name, data) => async args => { calls.push(name); assert.equal(args.owner, 'BOBWORKS-XR'); assert.equal(args.repo, 'CREATOR-HUB'); assert.equal(args.request.timeout, 30000); return { data }; };
  return { rest: { repos: { get: method('repository', api.repository) }, git: { getCommit: method('commit', api.commit) }, actions: {
    getWorkflow: method('workflow', api.workflow), getWorkflowRun: method('run', api.run), getWorkflowRunAttempt: method('attempt', api.attempt),
    getJobForWorkflowRun: method('job', api.job), getArtifact: method('artifact', api.artifact),
    downloadArtifact: async args => { calls.push('download'); assert.equal(args.artifact_id, c.V2_PRODUCER.artifactId); assert.equal(args.archive_format, 'zip'); assert.equal(args.request.timeout, 600000); return { data: await download() }; },
  } } };
}
test('v1 validators, decoder, stage and inline fetch retain their reviewed source fingerprints', () => {
  const pins = { validate: 'c9a3b0e5ba94d81d56ba7e01e59ad55aa96119859326645a730df62e93cf5edc', parse: '87348f00cfafb1bfb50e11dd82d8f751ab45fe27e8f14117f7bfad079d32a15c',
    admission: 'af16e85b0cbd3761a9dff9d03844a642d4cd207b1247887b07d250801706640b', asset: 'f7be034b41fc12322da4c6ee77e515c2dbaad0a2d726d634e59315c39797a5cf',
    stage: '167beee8043b4541685a06a29a57532dff7df59c544f933f882af10b24d257db', STAGE_PYTHON: '7acc5d824fe8e64041b949e6596d16e387f76d7da9afcb092860382b813cd64b' };
  for (const [name, sha] of Object.entries(pins)) assert.equal(c.record(Buffer.from(String(c[name]).replace(/\r\n/g, '\n'))).sha256, sha, name);
  assert.equal(c.record(Buffer.from(workflow.jobs['stage-input'].steps[0].with.script)).sha256, '65a633fe36ff83a5370ecbb4eb724f3e92861efd86565930e3db4499513e899f');
});
test('v2 is a finite immutable reconstruction schema, not an arbitrary artifact or policy override', () => {
  const input = sampleV2(); c.parseV2(JSON.stringify(input, null, 2));
  for (const mutate of [v => v.producer.runAttempt++, v => v.producer.sourceCommit = 'f'.repeat(40), v => v.producer.artifactId++,
    v => v.producer.zip.sha256 = 'f'.repeat(64), v => v.output.name += '.other', v => v.output.zip.sha256 = 'b'.repeat(64),
    v => v.metadataBase64 += '\n', v => v.metadataZip.size++, v => v.files['plan.json'].sha256 = 'b'.repeat(64),
    v => v.files[c.FILES[1]].size++, v => v.files['fresh-api.json'].size++, v => v.deliverToDraft = 'true', v => v.allowUnknown = true,
    v => delete v.files[c.FILES[2]], v => v.files['../escape'] = v.files['plan.json']]) {
    const value = structuredClone(input); mutate(value); assert.throws(() => c.parseV2(JSON.stringify(value, null, 2)));
  }
  assert.throws(() => c.parseV2(JSON.stringify(input))); assert.throws(() => c.parseV2(JSON.stringify(input, null, 2).replace('{', '{"schemaVersion":2,')));
  assert.throws(() => c.parse(JSON.stringify(input, null, 2))); assert.throws(() => c.parseV2(JSON.stringify(sample().input, null, 2)));
});
test('v2 fresh producer admission refuses identity, attempts, steps, trees and artifacts independently', () => {
  c.validateProducerAPI(producerAPI());
  for (const mutate of [a => a.repository.id++, a => a.workflow.path = 'other', a => a.run.run_attempt++, a => a.attempt.head_sha = 'b'.repeat(40),
    a => a.run.status = 'queued', a => a.job.id++, a => a.job.conclusion = 'failure', a => a.job.steps[0].conclusion = 'skipped',
    a => a.job.steps[3].conclusion = 'success', a => a.job.steps.pop(), a => a.job.labels = ['windows-latest'],
    a => a.artifact.expired = true, a => a.artifact.workflow_run.id++, a => a.artifact.digest = 'sha256:bad', a => a.commit.tree.sha = 'b'.repeat(40)]) {
    const value = producerAPI(); mutate(value); assert.throws(() => c.validateProducerAPI(value));
  }
});
test('actual inline v2 fetch stops before ZIP download for wrong API/input/context and makes no retry on API error', async t => {
  for (const fault of ['producer', 'attempt', 'input', 'context', 'API', 'bytes', 'download']) {
    const root = owned(t), input = sampleV2(), api = producerAPI(), calls = [];
    if (fault === 'producer') api.artifact.workflow_run.head_sha = 'b'.repeat(40);
    if (fault === 'attempt') api.attempt.run_attempt = 2;
    if (fault === 'input') input.output.name += '.other';
    const env = v2Environment(root, input), context = contextV2(env); if (fault === 'context') context.sha = 'b'.repeat(40);
    const github = fetchAPI(api, calls, async () => { if (fault === 'download') throw Error('No retry'); return Buffer.from('wrong ZIP'); });
    if (fault === 'API') github.rest.actions.getWorkflow = async () => { calls.push('workflow'); throw Error('No retry'); };
    await assert.rejects(inlineV2('fetch-v2', env, github, context)); assert.deepEqual(fs.readdirSync(root), []);
    assert.equal(calls.filter(n => n === 'download').length, ['bytes', 'download'].includes(fault) ? 1 : 0);
    if (fault === 'API') assert.deepEqual(calls, ['repository', 'workflow']);
    if (['input', 'context'].includes(fault)) assert.deepEqual(calls, []);
  }
});
function reconstructionFixture(t, fault = '') {
  const root = owned(t), bodies = sample().bodies, output = path.join(root, 'rebuilt.zip');
  const script = c.RECONSTRUCT_PYTHON.slice(0, c.RECONSTRUCT_PYTHON.indexOf('def main():')) + String.raw`
import io
c=json.load(sys.stdin);fault=sys.argv[2];pins={n:{'size':len(base64.b64decode(b)),'sha256':hashlib.sha256(base64.b64decode(b)).hexdigest()} for n,b in c.items()}
streams=[]
for names in (SOURCE_FILES,SIX_FILES):
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w') as z:
        for i,n in enumerate(names):
            dest=METADATA[2] if n=='portable-manifest.unsigned.json' else n
            name='../escape' if fault=='traversal' and i==0 else n
            if fault=='case' and i==0:name=name.upper()
            item=zipfile.ZipInfo(name);item.create_system=3;item.external_attr=(stat.S_IFREG|0o600)<<16
            if fault=='link' and i==0:item.external_attr=(stat.S_IFLNK|0o777)<<16
            if fault=='fifo' and i==0:item.external_attr=(stat.S_IFIFO|0o600)<<16
            if fault=='setuid' and i==0:item.external_attr=(stat.S_IFREG|0o4600)<<16
            if fault=='compression' and i==0:item.compress_type=zipfile.ZIP_BZIP2
            body=base64.b64decode(c[dest]);body=(b'X'+body[1:]) if fault=='mixed' and i==0 else body
            z.writestr(item,body)
        if fault=='duplicate':z.writestr(names[0],b'duplicate')
        if fault=='extra':z.writestr('unexpected',b'extra')
    stream.seek(0);streams.append(stream)
with zipfile.ZipFile(streams[0]) as first,zipfile.ZipFile(streams[1]) as second:
    check_zip(first,SOURCE_FILES,{n:pins[METADATA[2] if n=='portable-manifest.unsigned.json' else n] for n in SOURCE_FILES})
    check_zip(second,SIX_FILES,pins)
    with open(sys.argv[1],'xb') as target:write_zip(target,first,second,pins)
with zipfile.ZipFile(sys.argv[1]) as result:
    need([e.filename for e in result.infolist()]==FILES,'Order differs')
    for e in result.infolist():
        need(e.date_time==(1980,1,1,0,0,0) and e.create_system==3 and e.external_attr==(stat.S_IFREG|0o600)<<16,'Headers differ')
        need(e.compress_type==0 and e.flag_bits==0 and e.extra==b'' and e.comment==b'' and e.create_version==20 and e.extract_version==20,'Headers differ')
print(json.dumps({'zip':{'size':os.stat(sys.argv[1]).st_size,'sha256':hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest()}}))
`;
  return { root, output, execute: () => spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-c', script, output, fault],
    { input: JSON.stringify(Object.fromEntries(Object.entries(bodies).map(([n, b]) => [n, b.toString('base64')]))), encoding: 'utf8', timeout: 15000, windowsHide: true }) };
}
test('actual decoder/writer functions produce fixed ZIP headers and refuse mixed/unsafe members', t => {
  const good = reconstructionFixture(t), result = good.execute(); assert.equal(result.status, 0, result.stderr);
  const pin = JSON.parse(result.stdout).zip; assert.deepEqual(c.record(c.pinnedBytes(good.output, pin)), pin);
  for (const fault of ['duplicate', 'extra', 'traversal', 'case', 'link', 'fifo', 'setuid', 'compression', 'mixed']) {
    const f = reconstructionFixture(t, fault), r = f.execute(); assert.notEqual(r.status, 0, fault); assert.equal(fs.existsSync(path.join(f.root, 'escape')), false);
  }
});
test('opaque final-byte reader refuses changed headers/hash, extra bytes and hardlinked data', t => {
  const f = reconstructionFixture(t), r = f.execute(); assert.equal(r.status, 0, r.stderr); const expected = JSON.parse(r.stdout).zip;
  const changed = fs.readFileSync(f.output); changed[10] ^= 1; fs.writeFileSync(f.output, changed); assert.throws(() => c.pinnedBytes(f.output, expected));
  changed[10] ^= 1; fs.writeFileSync(f.output, Buffer.concat([changed, Buffer.from([0])])); assert.throws(() => c.pinnedBytes(f.output, expected));
  fs.writeFileSync(f.output, changed); fs.linkSync(f.output, path.join(f.root, 'linked')); assert.throws(() => c.pinnedBytes(f.output, expected));
});
test('v2 routes by schema, uses read-only fetch/decode and a clean explicit delivery job with zero HTTP retries', () => {
  const good = { repository: 'BOBWORKS-XR/CREATOR-HUB', repository_id: '1364807512', event_name: 'workflow_dispatch', ref: c.BRANCH };
  for (const name of ['fetch-v2', 'reconstruct-v2', 'deliver-v2']) {
    const job = workflow.jobs[name], guard = new Function('github', 'inputs', 'fromJSON', `return (${job.if});`);
    for (const schemaVersion of [1, 2]) for (const deliverToDraft of [false, true])
      assert.equal(guard(good, { transport_input: JSON.stringify({ schemaVersion, deliverToDraft }) }, JSON.parse), schemaVersion === 2 && (name !== 'deliver-v2' || deliverToDraft));
    assert.equal(guard({ ...good, event_name: 'push' }, { transport_input: '{}' }, JSON.parse), false);
    assert.deepEqual(job.permissions, { contents: name === 'deliver-v2' ? 'write' : 'read', actions: 'read' }); assert.equal(job['runs-on'], 'ubuntu-22.04');
    const checkout = job.steps.find(s => s.uses === 'actions/checkout@v6'); assert.deepEqual(checkout.with, { ref: '${{ github.sha }}', 'persist-credentials': false });
    for (const step of job.steps) if (step.with?.script) {
      assert.equal(step.with.retries, 0); new AsyncFunction('require', 'process', 'context', 'github', step.with.script);
      assert.match(step.with.script, /GITHUB_WORKSPACE/); assert.doesNotMatch(step.with.script, /require\([^\n]*RUNNER_TEMP|eval\(|execFile|spawn/);
    }
  }
  assert.equal(workflow.jobs['reconstruct-v2'].needs, 'fetch-v2'); assert.equal(workflow.jobs['deliver-v2'].needs, 'reconstruct-v2');
  assert.doesNotMatch(c.deliverV2.toString(), /execFile|spawn|zipfile|reconstructV2|require\(|deleteRelease|updateRelease|createRelease/);
  assert.equal((c.deliverV2.toString().match(/uploadReleaseAsset\(/g) || []).length, 1);
  assert.doesNotMatch(c.fetchV2.toString(), /uploadRelease|deleteRelease|zipfile|execFile|spawn/);
});

// Optional full original-artifact replay. It performs local byte transport only; all GitHub methods remain mocks.
const packet = process.env.CREATOR_HUB_CARRIER_V2_PACKET, original = process.env.CREATOR_HUB_CARRIER_V2_ORIGINAL, carrier = process.env.CREATOR_HUB_CARRIER_V2_CARRIER;
const actualOptions = { skip: !packet || !original || !carrier };
test('actual inline fetch and full decoder reproduce the reviewed original 451921705-byte carrier; header mutant refuses', actualOptions, async t => {
  const root = owned(t), input = JSON.parse(fs.readFileSync(path.join(packet, 'transport-input.json'))), api = JSON.parse(fs.readFileSync(path.join(packet, 'local-api-fixture.json')));
  const calls = [], env = v2Environment(root, input), github = fetchAPI(api, calls, async () => fs.readFileSync(original));
  await inlineV2('fetch-v2', env, github); assert.equal(calls.filter(n => n === 'download').length, 1);
  const download = path.join(root, 'private-portable016-v2-download'), request = path.join(download, 'transport-input.json'), output = path.join(root, 'reconstructed'); fs.mkdirSync(output);
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const execute = (program, destination) => spawnSync(python, ['-B', '-c', program, download, request, destination, root, c.record(fs.readFileSync(request)).sha256],
    { encoding: 'utf8', timeout: 180000, maxBuffer: 32768, windowsHide: true });
  const result = execute(c.RECONSTRUCT_PYTHON, output); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { zip: input.output.zip, files: input.files });
  const rebuilt = path.join(output, c.V2_OUTPUT.name); assert.deepEqual(c.record(c.pinnedBytes(rebuilt, c.V2_OUTPUT.zip)), c.V2_OUTPUT.zip);
  const compare = spawnSync(python, ['-B', '-c', 'import sys\nwith open(sys.argv[1],"rb") as a,open(sys.argv[2],"rb") as b:\n while True:\n  x=a.read(65536);y=b.read(65536);assert x==y\n  if not x:break', rebuilt, carrier], { timeout: 60000, encoding: 'utf8', windowsHide: true });
  assert.equal(compare.status, 0, compare.stderr);
  const negative = path.join(root, 'header-mutant'); fs.mkdirSync(negative);
  const mutant = c.RECONSTRUCT_PYTHON.replace('ZipInfo(name,(1980,1,1,0,0,0))', 'ZipInfo(name,(1981,1,1,0,0,0))'); assert.notEqual(mutant, c.RECONSTRUCT_PYTHON);
  const refused = execute(mutant, negative); assert.notEqual(refused.status, 0); assert.match(refused.stderr, /Input hash differs/);
});
test('actual inline delivery hashes opaque bytes, preserves49 mocked assets and has one-shot refusal/unknown behavior', actualOptions, async t => {
  const root = owned(t), input = JSON.parse(fs.readFileSync(path.join(packet, 'transport-input.json'))); input.deliverToDraft = true;
  const env = v2Environment(root, input, 'deliver-v2'), directory = path.join(root, 'private-portable016-v2-delivery'); fs.mkdirSync(directory);
  fs.copyFileSync(carrier, path.join(directory, c.V2_OUTPUT.name));
  const prior = Array.from({ length: 49 }, (_, i) => ({ id: i + 1, name: `old-${i}`, size: 1, digest: 'sha256:' + 'a'.repeat(64), state: 'uploaded', updated_at: '2026-10-21T00:00:00Z' }));
  const asset = { id: 999, name: c.V2_OUTPUT.name, size: c.V2_OUTPUT.zip.size, digest: `sha256:${c.V2_OUTPUT.zip.sha256}`, state: 'uploaded', updated_at: '2026-10-21T18:00:00Z' };
  for (const fault of ['existing', 'public', 'disabled', 'wrong-job', 'retry-attempt', 'timeout', 'response', 'old-changed', 'success']) {
    const local = { ...env }, posts = []; let lists = 0; const evidence = path.join(root, 'private-portable016-v2-delivery-evidence');
    if (fs.existsSync(evidence)) fs.renameSync(evidence, path.join(root, `retained-${fault}-previous`));
    if (fault === 'disabled') local.TRANSPORT_INPUT = JSON.stringify({ ...input, deliverToDraft: false }, null, 2);
    if (fault === 'wrong-job') local.GITHUB_JOB = 'fetch-v2'; if (fault === 'retry-attempt') local.GITHUB_RUN_ATTEMPT = '2';
    const github = { rest: { repos: {
      getRelease: async args => { assert.equal(args.release_id, 411494394); return { data: { id: 411494394, tag_name: 'v0.1.13-validation', draft: fault !== 'public' } }; },
      listReleaseAssets: async () => { lists++; const values = structuredClone(prior); if (fault === 'existing') values.push({ ...asset, state: 'starter', digest: null });
        else if (lists > 1) { values.push(asset); if (fault === 'old-changed') values[0].digest = 'sha256:changed'; } return { data: values }; },
      uploadReleaseAsset: async args => { posts.push(args); assert.equal(args.name, c.V2_OUTPUT.name); assert.equal(args.release_id, 411494394);
        assert.equal(args.request.timeout, 900000); assert.deepEqual(c.record(args.data), c.V2_OUTPUT.zip);
        if (fault === 'timeout') throw Error('timeout without retry'); return { data: fault === 'response' ? { ...asset, digest: null } : asset }; },
    } } };
    if (fault === 'success') { await inlineV2('deliver-v2', local, github); assert.equal(JSON.parse(fs.readFileSync(path.join(evidence, 'receipt.json'))).priorAssetsUnchanged, true);
      await assert.rejects(inlineV2('deliver-v2', local, github)); }
    else await assert.rejects(inlineV2('deliver-v2', local, github));
    assert.equal(posts.length, ['timeout', 'response', 'old-changed', 'success'].includes(fault) ? 1 : 0, fault);
    if (fault === 'timeout') { const record = JSON.parse(fs.readFileSync(path.join(evidence, 'failure.json'))); assert.equal(record.retryPermitted, false); assert.equal(record.outcome, 'refused-or-unknown-after-single-POST'); }
  }
});
