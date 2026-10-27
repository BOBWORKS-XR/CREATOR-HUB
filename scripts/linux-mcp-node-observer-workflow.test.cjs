'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { yaml } = require(path.join(path.dirname(require.resolve('playwright-core/package.json')), 'lib/utilsBundle.js'));
const root = path.resolve(__dirname, '..');
const workflowFile = '.github/workflows/linux-mcp-node-observer-01.yml';
const source = fs.readFileSync(path.join(root, workflowFile), 'utf8');
const document = yaml.parseDocument(source, { uniqueKeys: true });
assert.deepEqual(document.errors, []);
const workflow = document.toJSON(), job = workflow.jobs.observer, steps = job.steps;
const branch = 'validation/linux-mcp-node-observer-01';
const python = process.env.PREFLIGHT_PYTHON || 'python3';
const cleanEnv = { PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const step = prefix => steps.find(value => value.name?.startsWith(prefix));
const inlinePython = command => [...command.matchAll(/<<'PY'[^\n]*\n([\s\S]*?)^PY\s*$/gm)].map(match => match[1]);

test('one exact push branch, read permissions and one Ubuntu job only', () => {
  assert.deepEqual(workflow.on, { push: { branches: [branch] } });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), ['observer']);
  assert.equal(job['runs-on'], 'ubuntu-22.04'); assert.equal(job['timeout-minutes'], 15);
  assert.equal(job.strategy, undefined); assert.equal(job.permissions, undefined);
  for (const guard of ["github.repository == 'BOBWORKS-XR/CREATOR-HUB'", "github.repository_id == '1364807512'",
    `github.ref == 'refs/heads/${branch}'`, "github.event_name == 'push'",
    `github.workflow_ref == 'BOBWORKS-XR/CREATOR-HUB/${workflowFile}@refs/heads/${branch}'`]) assert.ok(job.if.includes(guard));
  assert.equal(steps[0].with['persist-credentials'], false); assert.equal(steps[0].with['fetch-depth'], 2);
});

test('this branch does not trigger other inspected push routes or workflow_run hooks', () => {
  for (const name of fs.readdirSync(path.join(root, '.github/workflows')).filter(name => /\.ya?ml$/.test(name))) {
    if (name === path.basename(workflowFile)) continue;
    const value = yaml.parse(fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8'));
    const on = value.on || {};
    assert.notEqual(on, 'push', name); assert.notEqual(on, 'workflow_run', name);
    assert.ok(!Array.isArray(on) || (!on.includes('push') && !on.includes('workflow_run')), name);
    assert.equal(on.workflow_run, undefined, name);
    if (!Object.hasOwn(on, 'push')) continue;
    const route = on.push;
    assert.ok(route && typeof route === 'object', name);
    if (route.tags && !route.branches) continue;
    assert.ok(Array.isArray(route.branches), `Unreviewed broad branch filter: ${name}`);
    for (const pattern of route.branches) {
      if (pattern === 'workflow*') assert.equal(branch.startsWith('workflow'), false);
      else { assert.doesNotMatch(pattern, /[*?![\]{}]/, name); assert.notEqual(pattern, branch, name); }
    }
  }
  const ci = yaml.parse(fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'));
  assert.deepEqual(ci.on.push.branches, ['ui-preview', 'master', 'workflow*']);
});

test('source guard pins exact parent/tree, three approved postimages and fixed loader source before tools', () => {
  const binding = step('Bind exact9737'), text = binding.run;
  assert.ok(steps.indexOf(binding) < steps.findIndex(value => value.uses === 'actions/setup-node@v6'));
  assert.match(text, /9737d409b78c53d2bb5e95542452ce4e36565a3d/);
  assert.match(text, /328de64be38d0b2279d3c615ebcb4770ea505c58/);
  assert.match(text, /rev-list.*--parents/); assert.match(text, /diff-tree.*--name-status/);
  const pins = {
    'native/mcp-router/tests/unix-execution.cjs': [17624, '52b3b27adc692b33533af47cedec44805ca1e9a585f7a56fc6aec20735e10be8'],
    'native/mcp-router/tests/linux-node-observer.py': [12415, '7f0dcc3d7b8588dfcf01f652f5a3911a4427de077a56afe928955e13a81395a5'],
    'native/mcp-router/tests/linux-node-observer.test.py': [12632, '02ff1f6051c05338f00b6ece302a40fdfae347686e0b7150116ccd501b41ba05'],
    'native/mcp-router/src/unix_exec.rs': [10594, 'a8e714620c90ac852eaa0b583ecf11ca33ec7dcd3ab5ed176b3bc266cada4872'],
    'native/mcp-router/src/unix_exec_linux.rs': [5948, 'ca4552a4db13d5580cdf282da929faec4d08975710decbbe0ad555b1361940a7'],
  };
  for (const [file, [size, sha]] of Object.entries(pins)) {
    const raw = fs.readFileSync(path.join(root, file)); assert.equal(raw.length, size, file); assert.equal(hash(raw), sha, file);
    assert.ok(text.includes(file) && text.includes(sha), file);
  }
});

test('exact Node bytes, locked dependencies and fifteen pure tests precede fixture tooling', () => {
  const node = steps.find(value => value.uses === 'actions/setup-node@v6');
  assert.equal(String(node.with['node-version']), '24.17.0');
  const pin = step('Check exact existing Node'), pure = step('Fifteen pure'), preflight = step('Pure workflow');
  const install = steps.findIndex(value => value.run === 'npm ci --ignore-scripts --no-audit --no-fund');
  assert.ok(steps.indexOf(pin) < install && install < steps.indexOf(preflight) && steps.indexOf(preflight) < steps.indexOf(pure));
  assert.match(pin.run, /62d66443847de1f527f74afe715900b12884ace52136dc9cd8e91e61acc2f527/);
  assert.match(pure.run, /python3 -I -S -B native\/mcp-router\/tests\/linux-node-observer\.test\.py/);
  assert.equal((fs.readFileSync(path.join(root, 'native/mcp-router/tests/linux-node-observer.test.py'), 'utf8').match(/^    def test_/gm) || []).length, 15);
  assert.ok(steps.indexOf(pure) < steps.findIndex(value => value.uses === 'dtolnay/rust-toolchain@1.99.0'));
  assert.ok(steps.every(value => value['continue-on-error'] === undefined));
});

test('cache remains outside fresh result directory and actual Unix invocation occurs exactly once', () => {
  assert.deepEqual(job.env, { RESULT_DIR: '${{ runner.temp }}/linux-mcp-node-observer-01',
    CARGO_TARGET_DIR: '${{ github.workspace }}/native/mcp-router/target' });
  const create = step('Create exclusive'), cache = steps.find(value => value.uses === 'Swatinem/rust-cache@v2');
  assert.equal(create.id, 'result'); assert.match(create.run, /test ! -e "\$RESULT_DIR"/);
  assert.equal(cache.with.workspaces, 'native/mcp-router -> target');
  assert.ok(steps.indexOf(create) < steps.indexOf(cache));
  assert.doesNotMatch(JSON.stringify(cache), /RESULT_DIR|runner.temp|linux-mcp-node-observer-01/);
  const native = step('One existing synthetic');
  assert.equal((native.run.match(/"\$NODE" native\/mcp-router\/tests\/unix-execution\.cjs "\$NODE"/g) || []).length, 1);
  assert.equal((source.match(/"\$NODE" native\/mcp-router\/tests\/unix-execution\.cjs "\$NODE"/g) || []).length, 1);
  assert.match(native.run, /test ! -e artifacts\/unix-native-results/);
  assert.match(native.run, /test ! -e modules\/mcp\/release\/creator-works-mcp\.mjs/);
  assert.match(native.run, /cargo --version.*= 1\.99\.0/);
  assert.match(native.run, /rustc --version.*= 1\.99\.0/);
  assert.match(fs.readFileSync(path.join(root, 'native/mcp-router/tests/unix-execution.cjs'), 'utf8'),
    /execFileSync\('cargo', \['build', '--release', '--locked', '--manifest-path', 'native\/mcp-router\/Cargo\.toml', '--examples'\]/);
  assert.doesNotMatch(source, /\bsudo\b|apt-get|bundle:server|build:unified|workflow_dispatch|actions: write|contents: write|GITHUB_ENV|GITHUB_PATH/);
});

test('upload is a closed nine-file list, gated on current exclusive result creation', () => {
  const upload = steps.find(value => value.uses === 'actions/upload-artifact@v4');
  assert.equal(upload.if, "always() && steps.result.outcome == 'success'");
  assert.equal(step('Copy only the single').if, upload.if);
  assert.deepEqual(upload.with.path.trim().split('\n'), [
    'preflight.stdout', 'preflight.stderr', 'workflow.stdout', 'workflow.stderr', 'pure.stdout', 'pure.stderr',
    'original.stdout', 'original.stderr', 'native-result.json',
  ].map(name => '${{ env.RESULT_DIR }}/' + name));
  assert.doesNotMatch(upload.with.path, /[*]|temporaryPayloads|empty-profile|target|TEST-PUBLIC|config/);
});

test('all Bash parses and both inline Python scripts parse as Python3.10 without execution', () => {
  const bash = ['/usr/bin/bash', '/bin/bash', 'C:/Program Files/Git/bin/bash.exe'].find(file => fs.existsSync(file));
  assert.ok(bash, 'Bash syntax checker is required');
  const pythonSources = [];
  for (const value of steps.filter(value => value.run)) {
    const result = cp.spawnSync(bash, ['-n'], { input: value.run, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
    assert.equal(result.status, 0, result.stderr);
    pythonSources.push(...inlinePython(value.run));
  }
  assert.equal(pythonSources.length, 2);
  const parsed = cp.spawnSync(python, ['-I', '-S', '-B', '-c',
    'import ast,json,sys; [ast.parse(source,feature_version=(3,10)) for source in json.load(sys.stdin)]'],
    { env: cleanEnv, input: JSON.stringify(pythonSources), encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  assert.equal(parsed.status, 0, parsed.stderr);
});

const ownedFixtures = new Set();
function collectFixture(mutator, extra = false) {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'observer-evidence-unit-'));
  ownedFixtures.add(directory);
  const workspace = path.join(directory, 'workspace'), result = path.join(directory, 'result');
  const input = path.join(workspace, 'artifacts/unix-native-results');
  fs.mkdirSync(input, { recursive: true }); fs.mkdirSync(result);
  const original = { platform: 'linux', arch: 'x86_64', passed: false, writableGuiAccepted: false, releaseReady: false, error: 'synthetic-original-failure' };
  mutator?.(original);
  const raw = Buffer.from(JSON.stringify(original));
  fs.writeFileSync(path.join(input, 'linux-x86_64-00000000-0000-0000-0000-000000000000.json'), raw);
  if (extra) fs.writeFileSync(path.join(input, 'foreign.json'), '{}');
  const secretDir = path.join(workspace, 'temporaryPayloads'); fs.mkdirSync(secretDir);
  fs.writeFileSync(path.join(secretDir, 'TEST-PUBLIC-KEY.txt'), 'SYNTHETIC-NOT-UPLOADABLE');
  const code = inlinePython(step('Copy only the single').run)[0];
  const execute = () => cp.spawnSync(python, ['-I', '-S', '-B', '-c', code], {
    env: { ...cleanEnv, RESULT_DIR: result, GITHUB_WORKSPACE: workspace }, encoding: 'utf8', timeout: 10000, maxBuffer: 65536,
  });
  return { directory, temporaryRoot, result, raw, execute };
}

function disposeFixture(fixture) {
  assert.equal(fs.realpathSync(fixture.directory), path.resolve(fixture.directory));
  assert.equal(path.dirname(fixture.directory), fixture.temporaryRoot);
  assert.ok(path.basename(fixture.directory).startsWith('observer-evidence-unit-'));
  assert.ok(ownedFixtures.delete(fixture.directory));
  fs.rmSync(fixture.directory, { recursive: true, force: true });
}

test('collector retains original failed JSON bytes only, excludes key directory and refuses overwrite', () => {
  const f = collectFixture();
  try {
    const first = f.execute(); assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(fs.readdirSync(f.result), ['native-result.json']);
    assert.deepEqual(fs.readFileSync(path.join(f.result, 'native-result.json')), f.raw);
    assert.notEqual(f.execute().status, 0);
    assert.deepEqual(fs.readFileSync(path.join(f.result, 'native-result.json')), f.raw);
  } finally { disposeFixture(f); }
});

test('collector refuses ambiguous originals, scope promotion and missing actual observer evidence', () => {
  for (const [mutate, extra] of [[null, true], [v => { v.releaseReady = true; }],
    [v => { v.writableGuiAccepted = true; }], [v => { v.platform = 'macos'; }], [v => { v.passed = true; }],
    [v => { v.passed = true; v.processObserver = { passed: true, syntheticFixtureOnly: true, qualified: false,
      nativeAdmissionAccepted: true, liveMcpProtocolAccepted: false, payloadSwapAccepted: false, releaseReady: false }; }]]) {
    const f = collectFixture(mutate, extra);
    try { assert.notEqual(f.execute().status, 0); assert.deepEqual(fs.readdirSync(f.result), []); }
    finally { disposeFixture(f); }
  }
});
