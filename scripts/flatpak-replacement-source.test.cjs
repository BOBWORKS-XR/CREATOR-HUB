const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pkg = require('./flatpak-package.cjs');
const runner = require('./flatpak-disposable.cjs');
const source = require('./flatpak-replacement-source.cjs');
const plan = JSON.parse(pkg.read(path.join(pkg.RECIPE, 'replacement-014-inputs.json'), 65536));
const repo = { owner: 'BOBWORKS-XR', repo: 'CREATOR-HUB' };
const encoded = value => ({ encoding: 'base64', content: Buffer.from(JSON.stringify(value)).toString('base64') });

function supportedPlan() {
  const [baseline, replacement] = require('./flatpak-mcp-stdio-run.cjs').plan();
  return { schemaVersion: 1, scope: plan.scope, ref: plan.ref, baseline, replacement };
}

test('historical writable plan stays readable but preflight refuses its missing raw router pin', () => {
  const before = JSON.stringify(plan);
  for (const name of ['baseline', 'replacement']) {
    pkg.validatePins(plan[name].pins);
    assert.equal(Object.hasOwn(plan[name].pins.files, pkg.ROUTER_INPUT), false);
  }
  assert.throws(() => source.validatePlan(plan), { code: 'ERR_FLATPAK_RAW_ROUTER_PIN_REQUIRED', input: 'baseline' });
  assert.equal(JSON.stringify(plan), before, 'Preflight must not repair historical pins');
});

test('preflight checks both inputs and preserves the existing four-input pair without authorizing it', () => {
  const supported = supportedPlan(), before = JSON.stringify(supported);
  assert.doesNotThrow(() => source.validatePlan(supported));
  assert.equal(JSON.stringify(supported), before);
  for (const name of ['baseline', 'replacement']) {
    const historical = structuredClone(supported); historical[name] = structuredClone(plan[name]);
    assert.throws(() => source.validatePlan(historical), { code: 'ERR_FLATPAK_RAW_ROUTER_PIN_REQUIRED', input: name });
  }
  for (const mutate of [p => { p.scope = 'foreign'; }, p => { p.ref = 'foreign'; },
    p => { p.replacement.pins.files[pkg.ROUTER_INPUT].size = 0; }]) {
    const changed = structuredClone(supported); mutate(changed);
    assert.throws(() => source.validatePlan(changed));
  }
});

test('download and staging preflight both inputs before API calls, runner-temp access or mutation', async t => {
  for (const input of ['baseline', 'replacement']) for (const entrypoint of ['downloadInputs', 'stageInputs']) {
    await t.test(`${entrypoint}: historical ${input}`, async t => {
      const candidate = supportedPlan(); candidate[input] = structuredClone(plan[input]);
      const bytes = Buffer.from(JSON.stringify(candidate)), calls = [], f = fixture();
      const admission = runner.admission;
      const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
        GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512',
        CREATOR_FLATPAK_PACKAGE_TEST: '1', RUNNER_TEMP: path.join(os.tmpdir(), 'unused-flatpak-preflight-fixture') };
      t.mock.method(runner, 'admission', value => { admission(value, 'linux', 'x64'); calls.push('admission'); });
      t.mock.method(pkg, 'read', (file, limit) => {
        assert.equal(file, path.join(pkg.RECIPE, 'replacement-014-inputs.json')); assert.equal(limit, 65536);
        calls.push('read-plan'); return bytes;
      });
      for (const method of ['realpathSync', 'writeFileSync', 'mkdirSync']) t.mock.method(fs, method, () => {
        calls.push(method); throw Error(`Unexpected ${method}`);
      });
      t.mock.method(pkg, 'prepare', () => { calls.push('prepare'); throw Error('Unexpected staging'); });
      const error = { code: 'ERR_FLATPAK_RAW_ROUTER_PIN_REQUIRED', input };
      if (entrypoint === 'downloadInputs') await assert.rejects(source.downloadInputs(f.github, { repo }, env), error);
      else assert.throws(() => source.stageInputs(env), error);
      assert.deepEqual(calls, ['admission', 'read-plan']);
      assert.deepEqual(f.calls, []);
    });
  }
});

test('read-only CLI preflight refuses the unchanged plan without native runner admission', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'flatpak-replacement-source.cjs'), '--preflight'],
    { env: {}, encoding: 'utf8', timeout: 10000, maxBuffer: 8192, windowsHide: true });
  assert.equal(result.error, undefined); assert.equal(result.status, 1); assert.equal(result.signal, null);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /ERR_FLATPAK_RAW_ROUTER_PIN_REQUIRED: baseline/);
});

function fixture(name = 'baseline', arrayBuffer = false) {
  const expected = structuredClone(plan[name]);
  // Synthetic transport bytes test Octokit's representation, never replace production pins.
  const bytes = Buffer.from('owned unit ZIP byte fixture');
  expected.artifactSize = bytes.length; expected.pins.inputArtifactSha256 = pkg.sha256(bytes);
  const data = {
    run: { id: expected.pins.runId, run_attempt: 1, status: 'completed', conclusion: 'success', head_sha: expected.pins.sourceCommit,
      repository: { id: 1364807512 }, path: '.github/workflows/unix-managed-assembly.yml', event: 'push', head_branch: 'validation/unix-assembly-014' },
    artifact: { id: expected.artifactId, name: expected.artifactName, expired: false, size_in_bytes: bytes.length,
      digest: `sha256:${pkg.sha256(bytes)}`, workflow_run: { id: expected.pins.runId, head_sha: expected.pins.sourceCommit,
        repository_id: 1364807512, head_repository_id: 1364807512 } },
    jobs: [{ id: expected.assemblyJobId, name: 'assembly (linux, ubuntu-22.04, fixture)', conclusion: 'success' }],
    commit: { sha: expected.pins.sourceCommit, tree: { sha: expected.pins.sourceTree } },
    package: encoded({ name: 'creator-hub', version: '0.1.14' }), tauri: encoded({ identifier: pkg.ID, version: '0.1.14' }),
    download: arrayBuffer ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes,
  };
  const calls = [];
  const respond = (name, value) => async args => { calls.push({ name, args }); return { data: value() }; };
  const github = { rest: {
    actions: { getWorkflowRun: respond('run', () => data.run), getArtifact: respond('artifact', () => data.artifact),
      listJobsForWorkflowRunAttempt: respond('jobs', () => ({ jobs: data.jobs, total_count: data.jobs.length })),
      downloadArtifact: respond('download', () => data.download) },
    git: { getCommit: respond('commit', () => data.commit) },
    repos: { getContent: async args => { calls.push({ name: args.path, args }); return { data: args.path === 'package.json' ? data.package : data.tauri }; } },
  } };
  return { expected, data, calls, github, bytes };
}

test('both reviewed sources bind run, job, tree and two version files before ZIP byte verification', async () => {
  for (const [name, arrayBuffer] of [['baseline', false], ['replacement', true]]) {
    const f = fixture(name, arrayBuffer), result = await source.verifyRemoteInput(f.github, repo, f.expected);
    assert.deepEqual(result.bytes, f.bytes);
    assert.deepEqual(result.binding.sourceVersions, { packageVersion: '0.1.14', tauriVersion: '0.1.14' });
    assert.equal(result.binding.sourceTree, f.expected.pins.sourceTree);
    assert.equal(result.binding.assemblyJobId, f.expected.assemblyJobId);
    assert.deepEqual(f.calls.map(call => call.name), ['run', 'artifact', 'jobs', 'commit', 'package.json', 'src-tauri/tauri.conf.json', 'download']);
    for (const call of f.calls.filter(call => call.name.endsWith('.json'))) assert.equal(call.args.ref, f.expected.pins.sourceCommit);
  }
});

test('failed/wrong run, artifact, lane, tree or source version refuses before download', async () => {
  for (const mutate of [d => { d.run.conclusion = 'failure'; }, d => { d.run.run_attempt = 2; }, d => { d.run.repository.id = 1; },
    d => { d.run.head_sha = 'a'.repeat(40); }, d => { d.run.path = 'foreign.yml'; }, d => { d.artifact.expired = true; },
    d => { d.artifact.workflow_run.head_repository_id = 1; }, d => { d.artifact.digest = `sha256:${'a'.repeat(64)}`; },
    d => { d.artifact.size_in_bytes++; }, d => { d.jobs[0].conclusion = 'failure'; }, d => { d.jobs[0].id++; },
    d => { d.jobs.push(d.jobs[0]); }, d => { d.jobs = Array(17).fill(d.jobs[0]); }, d => { d.commit.tree.sha = 'b'.repeat(40); },
    d => { d.package = encoded({ name: 'creator-hub', version: '0.1.13' }); },
    d => { d.tauri = encoded({ identifier: pkg.ID, version: '0.1.15' }); }]) {
    const f = fixture(); mutate(f.data);
    await assert.rejects(source.verifyRemoteInput(f.github, repo, f.expected));
    assert.equal(f.calls.some(call => call.name === 'download'), false);
  }
});

test('download refuses string/object responses and changed ZIP bytes or length', async () => {
  for (const bytes of ['not binary', { type: 'Buffer', data: [1, 2] }, Buffer.from('changed'), Buffer.alloc(27)]) {
    const f = fixture(); f.data.download = bytes;
    await assert.rejects(source.verifyRemoteInput(f.github, repo, f.expected));
  }
});

test('assembly receipt is independently source-bound, byte-pinned, real version 14 and writable', () => {
  for (const name of ['baseline', 'replacement']) {
    const expected = structuredClone(plan[name]);
    const body = { schemaVersion: 1, product: 'com.creatorworks.hub.unix-signed-assembly', platform: 'linux', arch: 'x86_64',
      hubVersion: '0.1.14', assemblyCommit: expected.pins.sourceCommit, mcpMode: 'writable', privateModulesRecompiled: false,
      privateModulesResigned: false, nativeGuiAccepted: false, releaseReady: false };
    const bytes = Buffer.from(JSON.stringify(body)); expected.assemblyReceipt = pkg.record(bytes);
    const binding = { sourceCommit: expected.pins.sourceCommit, sourceTree: expected.pins.sourceTree,
      runId: expected.pins.runId, runAttempt: 1, sourceVersions: { packageVersion: '0.1.14', tauriVersion: '0.1.14' } };
    assert.deepEqual(source.validateReceipt(bytes, binding, expected), body);
    assert.throws(() => source.validateReceipt(Buffer.concat([bytes, Buffer.from('\n')]), binding, expected), /receipt bytes differ/);
    assert.throws(() => source.validateReceipt(bytes, { ...binding, sourceTree: 'c'.repeat(40) }, expected));
    for (const mutate of [b => { b.hubVersion = '0.1.13'; }, b => { b.assemblyCommit = 'a'.repeat(40); },
      b => { b.mcpMode = 'read-only'; }, b => { b.nativeGuiAccepted = true; }, b => { b.privateModulesRecompiled = true; }]) {
      const changed = structuredClone(body); mutate(changed); const altered = Buffer.from(JSON.stringify(changed));
      assert.throws(() => source.validateReceipt(altered, binding, { ...expected, assemblyReceipt: pkg.record(altered) }));
    }
  }
});

test('workflow preserves both original ZIPs/receipts and uses older-to-current stages, not rebuilt targets', () => {
  const workflow = pkg.read(path.resolve(__dirname, '../.github/workflows/flatpak-package-014.yml'), 65536).toString();
  assert.ok(workflow.includes("downloadInputs(github,context)"));
  assert.ok(workflow.includes("for label in ['baseline','replacement']:"));
  assert.ok(workflow.includes("signed-unix-assembly.json':expected['assemblyReceipt']"));
  assert.ok(workflow.includes("e.file_size==pin['size']"));
  assert.ok(workflow.includes("hashlib.sha256(body).hexdigest()==pin['sha256']"));
  assert.ok(workflow.includes('node scripts/flatpak-replacement-source.cjs'));
  assert.ok(workflow.includes('"$temp/flatpak-baseline-stage" "$decoder" "$digest" "$temp/flatpak-replacement-stage"'));
  assert.ok(workflow.includes('flatpak-*-input.zip')); assert.ok(workflow.includes('flatpak-*-source/signed-unix-assembly.json'));
  assert.doesNotMatch(workflow, /build:unified|contents: write|--filesystem|--allow=devel|flatpak-spawn/);
  const implementation = pkg.read(path.join(__dirname, 'flatpak-replacement-source.cjs'), 65536).toString();
  assert.ok(implementation.includes('runner.admission(env)')); assert.ok(implementation.includes("flag: 'wx'"));
  assert.doesNotMatch(implementation, /spawn|execFile|execSync|auth\.json|GITHUB_TOKEN/);
});

test('workflow refuses an unstaggable plan before dependency setup, downloads or native tools', () => {
  const workflow = pkg.read(path.resolve(__dirname, '../.github/workflows/flatpak-package-014.yml'), 65536).toString();
  const preflight = workflow.indexOf('run: node scripts/flatpak-replacement-source.cjs --preflight');
  assert.ok(preflight > workflow.indexOf('uses: actions/checkout@'));
  for (const later of ['uses: actions/setup-node@', 'uses: dtolnay/rust-toolchain@', 'run: npm ci',
    'downloadInputs(github,context)', 'python3 -B - <<', 'cargo build', 'sudo apt-get', 'sudo flatpak']) {
    assert.ok(workflow.indexOf(later) > preflight, `${later} must follow plan preflight`);
  }
});
