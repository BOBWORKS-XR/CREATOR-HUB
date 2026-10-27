'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { yaml } = require(path.join(path.dirname(require.resolve('playwright-core/package.json')), 'lib/utilsBundle.js'));
const root = path.resolve(__dirname, '..');
const text = fs.readFileSync(path.join(root, '.github/workflows/linux-integrated-features.yml'), 'utf8');
const parsed = yaml.parseDocument(text, { uniqueKeys: true }); assert.deepEqual(parsed.errors, []);
const workflow = parsed.toJSON(), job = workflow.jobs['native-libraries'];
const pins = JSON.parse(fs.readFileSync(path.join(__dirname, 'linux-root-compiler-input.json')));
const branch = 'validation/linux-root-route-compiler-004';
const step = name => job.steps.find(s => s.name?.startsWith(name));
function contexts(value) {
  for (const v of Object.values(value || {})) assert.doesNotMatch(String(v), /\$\{\{[^}]*\b(?:runner|steps|job|env)\./, 'Unavailable job.env context');
}
test('job-level contexts reject the observed runner.temp failure, while step env accepts it', () => {
  contexts(job.env); assert.throws(() => contexts({ BAD: '${{ runner.temp }}/bad' }));
  assert.doesNotMatch(JSON.stringify({ ...job, steps: undefined }), /\$\{\{[^}]*\brunner\./);
  for (const name of ['Compile the in-process', 'Verify all 45', 'Test guards', 'Verify actual unchanged']) assert.match(step(name).env.CREATOR_HUB_INTEGRATED_MCP_PAYLOAD, /^\$\{\{ runner.temp \}\}\//);
});
test('same narrow route, read-only permissions, cache and no candidate build or signing', () => {
  assert.deepEqual(workflow.on, { workflow_dispatch: null, push: { branches: [branch] } });
  assert.ok(job.if.includes(`github.ref == 'refs/heads/${branch}'`));
  assert.doesNotMatch(job.if, /refs\/heads\/validation\/linux-integrated-features/);
  assert.doesNotMatch(job.if, /refs\/heads\/validation\/linux-root-route-compiler-01/);
  assert.doesNotMatch(job.if, /refs\/heads\/validation\/linux-root-route-compiler-02/);
  assert.doesNotMatch(job.if, /refs\/heads\/validation\/linux-root-route-compiler-003/);
  assert.equal(pins.ciDelta.length, 6);
  assert.ok(pins.ciDelta.includes('scripts/linux-portable-restart-ci.test.cjs'));
  assert.deepEqual(job.permissions, { contents: 'read', actions: 'read' });
  assert.equal(job['runs-on'], 'ubuntu-22.04'); assert.equal(job['timeout-minutes'], 30);
  assert.equal(job.steps[0].with['fetch-depth'], 2); assert.equal(job.steps[0].with['persist-credentials'], false);
  const node = job.steps.find(s => s.uses === 'actions/setup-node@v6');
  assert.equal(node.with['node-version'], '22.22.3'); assert.equal(node.with.cache, 'npm');
  assert.deepEqual(node.with['cache-dependency-path'].trim().split('\n'), ['package-lock.json', 'modules/mcp/package-lock.json']);
  assert.match(text, /npm --prefix modules\/mcp test/); assert.doesNotMatch(text, /release:launcher|cargo build|tauri build|contents: write|actions: write|upload-artifact|secrets\./);
  assert.equal(Object.keys(pins.sourcePins).length, 48); assert.equal(pins.expectedTests.length, 45);
  assert.equal(pins.compilerSource, 'ebdaf4f8a5e09f8e759279531c025038fe392593');
  assert.equal(pins.compilerTree, 'e278c48e964d8917bdb5d3d4b7006d632bfaf3e3');
  assert.deepEqual(pins.contextPins['src-tauri/src/self_update.rs'], { size: 38992, sha256: '02fc522b2895cd3f1c788157402275693785d860c52f103199470dc5ee8ed3df', normalizeLf: true });
  assert.deepEqual(pins.contextPins['scripts/root-mcp-update-handoff.test.cjs'], { size: 8902, sha256: 'b2c8298ae52f6f1d9241d9212ec3a84c303503409b436adfecd314dfaec4f716', normalizeLf: true });
});
test('default release resources stay absent through MCP tests, then stage before clippy', () => {
  const mcp = step('Prepare the real MCP'), resources = step('Stage exact compiler-only'), compile = step('Compile the in-process');
  assert.ok(job.steps.indexOf(mcp) < job.steps.indexOf(resources) && job.steps.indexOf(resources) < job.steps.indexOf(compile));
  const commands = mcp.run.trim().split('\n');
  assert.equal(commands.filter(s => s === 'python3 -I -S -B scripts/linux-root-compiler-input.py no-release').length, 2);
  assert.ok(commands.indexOf('npm ci --prefix modules/mcp') < commands.lastIndexOf('python3 -I -S -B scripts/linux-root-compiler-input.py no-release'));
  assert.ok(commands.lastIndexOf('python3 -I -S -B scripts/linux-root-compiler-input.py no-release') < commands.indexOf('npm --prefix modules/mcp test'));
  assert.equal(resources.run.trim(), 'python3 -I -S -B scripts/linux-root-compiler-input.py resources');
  assert.equal(resources.if, undefined); assert.equal(resources['continue-on-error'], undefined);
});
test('complete resource contract is finite and leaves initial four and acquisition unchanged', () => {
  const r = pins.tauriResources;
  assert.equal(Object.keys(pins.selected).length, 4); assert.equal(r.inputs.length, 6);
  assert.equal(Object.keys(r.producer).length, 8); assert.equal(Object.keys(r.map).length, 9);
  assert.equal(Object.keys(r.releaseFiles).length, 5); assert.equal(Object.keys(r.tracked).length, 4);
  assert.equal(Object.keys(r.icons).length, 5); assert.equal(Object.keys(r.frontend).length, 25);
  assert.equal(r.releaseFiles['runtime/node.exe'], 'runtime/node');
  assert.equal(job.steps.filter(s => s.uses === 'actions/github-script@v8').length, 1);
  assert.equal((step('Acquire one exact').with.script.match(/downloadArtifact\(/g) || []).length, 1);
});
function couldPush(on) {
  if (typeof on === 'string' || Array.isArray(on)) {
    const events = Array.isArray(on) ? on : [on];
    assert.ok(!events.includes('push') && !events.includes('workflow_run'), 'Unscoped push/follow-up route');
    return false;
  }
  if (!on) return false;
  assert.ok(!Object.hasOwn(on, 'workflow_run'), 'Unreviewed workflow_run fanout');
  if (!Object.hasOwn(on, 'push')) return false;
  const push = on.push;
  assert.ok(push && typeof push === 'object' && !Array.isArray(push), 'Unscoped push route');
  assert.ok(!Object.hasOwn(push, 'branches-ignore'), 'Unreviewed broad branch exclusion');
  if (push.tags && !Object.hasOwn(push, 'branches')) return false;
  assert.ok(Array.isArray(push.branches) && push.branches.length, 'Explicit branch allowlist required');
  return push.branches.some(pattern => {
    assert.equal(typeof pattern, 'string');
    if (pattern === 'workflow*') return branch.startsWith('workflow');
    assert.doesNotMatch(pattern, /[*?+!\[\]{}\\]/, 'Unreviewed branch glob; fail closed');
    return pattern === branch;
  });
}
test('all other workflow push routes exclude the new exact branch and have no workflow_run fanout', () => {
  const directory = path.join(root, '.github/workflows');
  const names = fs.readdirSync(directory).filter(n => /\.ya?ml$/.test(n) && n !== 'linux-integrated-features.yml');
  assert.ok(names.length > 0);
  for (const name of names) {
    const doc = yaml.parseDocument(fs.readFileSync(path.join(directory, name), 'utf8'), { uniqueKeys: true });
    assert.deepEqual(doc.errors, [], name);
    assert.equal(couldPush(doc.toJSON().on), false, `Push would fan out: ${name}`);
  }
});
test('fanout guard refuses broad, exclusion and unreviewed wildcard routes', () => {
  for (const on of ['push', ['push'], { push: null }, { push: {} }, { push: { 'branches-ignore': ['master'] } },
    { push: { branches: ['validation/**'] } }, { workflow_run: { workflows: ['*'] } }]) assert.throws(() => couldPush(on));
  assert.equal(couldPush({ push: { branches: [branch] } }), true);
  assert.equal(couldPush({ push: { branches: ['workflow*'] } }), false);
  assert.equal(couldPush({ push: { tags: ['v*'] } }), false);
});
test('complete existing strict compiler and test matrix is preserved', () => {
  const compile = step('Compile the in-process').run, run = step('Test guards').run;
  assert.equal((compile.match(/cargo clippy --locked/g) || []).length, 10);
  assert.equal((compile.match(/-- -D warnings/g) || []).length, 10);
  assert.equal((run.match(/cargo test --locked/g) || []).length, 9);
  assert.equal((step('Verify actual unchanged').run.match(/--exact --ignored --test-threads=1 --nocapture/g) || []).length, 2);
  assert.match(step('Verify all 45').run, /--bin creator-hub --features "\$features" -- --list/);
  assert.doesNotMatch(step('Verify all 45').run, /src-tauri-handoff-tests|--lib/);
  const commands = ['Compile the in-process', 'Test guards', 'Verify actual unchanged']
    .flatMap(name => step(name).run.split('\n').map(s => s.trim()).filter(s => /^cargo (?:clippy|test) --locked/.test(s)));
  assert.equal(commands.length, 21);
  assert.equal(require('node:crypto').createHash('sha256').update(JSON.stringify(commands)).digest('hex'), 'a2978e0d8534e9a633589312c734fecb059ba05cd1330b4838ac9c292fd8f33e');
});
const script = step('Acquire one exact').with.script;
async function mock(change = {}) {
  const calls = [], source = pins.source;
  const run = { id: 40580977821, run_attempt: 1, repository: { id: 1364807512 }, head_repository: { id: 1364807512 }, head_sha: source, head_branch: 'validation/unix-payload-016', status: 'completed', conclusion: 'success', event: 'push', workflow_id: 383680446, path: '.github/workflows/unix-managed-payload.yml', ...change.run };
  const item = { id: 12770466146, expired: false, name: 'unsigned-unix-payload-Linux-X64-' + source, size_in_bytes: 53949164, digest: 'sha256:' + pins.zip.sha256,
    workflow_run: { id: run.id, head_sha: source, repository_id: 1364807512, head_repository_id: 1364807512 }, ...change.artifact };
  const api = value => async () => ({ data: value });
  const github = { rest: { actions: { getWorkflowRun: api(run), getArtifact: api(item), downloadArtifact: async () => { calls.push('download'); return { data: 'synthetic' }; } }, git: { getCommit: api({ tree: { sha: change.tree || '479698017875ebd1b95a940efbf5089f6d2d543f' } }) } } };
  const fakeFs = { realpath: async () => '/owned', mkdir: async () => { calls.push('mkdir'); if (change.existing) throw Error('EEXIST'); }, open: async (_p, flags, mode) => {
    assert.equal(flags, 'wx'); assert.equal(mode, 0o600); calls.push('exclusive');
    return { writeFile: async () => calls.push('write'), sync: async () => calls.push('sync'), close: async () => calls.push('close') };
  } };
  const requireMock = n => n === 'node:fs/promises' ? fakeFs : n === 'node:crypto' ? { createHash: () => ({ update() { return this; }, digest: () => change.hash || pins.zip.sha256 }) } : require(n);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let error;
  try { await new AsyncFunction('require', 'github', 'context', 'process', 'Buffer', 'core', script)(requireMock, github,
    { repo: { owner: 'BOBWORKS-XR', repo: 'CREATOR-HUB' } }, { env: { RUNNER_TEMP: '/owned' } }, { from: () => ({ length: change.size || 53949164 }) }, { info: () => {} }); }
  catch (e) { error = e; }
  return { calls, error };
}
test('github-script makes one mocked GET download, verifies before exclusive write and fsync', async () => {
  const r = await mock(); assert.equal(r.error, undefined); assert.deepEqual(r.calls, ['mkdir', 'download', 'exclusive', 'write', 'sync', 'close']);
});
test('wrong run/source/API digest/tree or expired artifact refuses before download', async () => {
  for (const value of [{ run: { head_sha: 'old' } }, { run: { conclusion: 'failure' } }, { run: { run_attempt: 2 } }, { run: { workflow_id: 1 } },
    { artifact: { expired: true } }, { artifact: { digest: 'sha256:old' } }, { artifact: { workflow_run: { id: 1 } } }, { tree: 'old' }]) {
    const r = await mock(value); assert.ok(r.error); assert.equal(r.calls.includes('download'), false);
  }
});
test('raw ZIP size/hash mismatch never writes, existing exclusive directory never downloads', async () => {
  for (const value of [{ size: 1 }, { hash: 'old' }, { existing: true }]) {
    const r = await mock(value); assert.ok(r.error); assert.equal(r.calls.includes('write'), false);
    if (value.existing) assert.equal(r.calls.includes('download'), false);
  }
});
test('all workflow Bash parses without running compiler or native commands', () => {
  const cp = require('node:child_process');
  const bash = ['/usr/bin/bash', '/bin/bash', 'C:/Program Files/Git/bin/bash.exe'].find(p => fs.existsSync(p));
  assert.ok(bash);
  for (const s of job.steps.filter(s => s.run)) {
    const r = cp.spawnSync(bash, ['-n'], { input: s.run, encoding: 'utf8', timeout: 5000 });
    assert.equal(r.status, 0, r.stderr);
  }
});
