'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { yaml } = require('playwright-core/lib/utilsBundle');
const root = path.resolve(__dirname, '..');

for (const name of ['linux-portable-deployment.yml', 'linux-integrated-features.yml']) {
  test(`${name} tests the native restart feature without enabling packaging or publishing`, () => {
    const source = fs.readFileSync(path.join(root, '.github/workflows', name), 'utf8');
    const workflow = yaml.parse(source, { uniqueKeys: true });
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    const commands = [];
    const jobs = name === 'linux-portable-deployment.yml'
      ? [workflow.jobs.primitives] : Object.values(workflow.jobs);
    for (const job of jobs) {
      assert.equal(job['runs-on'], 'ubuntu-22.04');
      assert.match(job.if, /github.repository_id == '1364807512'/);
      assert.match(job.if, /refs\/heads\/validation\//);
      for (const step of job.steps) {
        if (!step.run) continue;
        const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/usr/bin/bash';
        const parsed = spawnSync(bash, ['-n'], { input: step.run, encoding: 'utf8', timeout: 5000, windowsHide: true, shell: false });
        assert.equal(parsed.status, 0, parsed.stderr || parsed.error?.message);
        commands.push(...step.run.split('\n'));
      }
    }
    for (const command of ['clippy', 'test']) {
      const prefix = `cargo ${command} --locked --manifest-path native/linux-portable-deployment/Cargo.toml `;
      const matching = commands.filter(line => line.startsWith(prefix));
      assert.ok(matching.some(line => !line.includes('--features')), 'Keep default-off coverage');
      assert.ok(matching.some(line => line.includes('--features experimental-restart --')), 'Run actual Linux protocol tests');
      if (name === 'linux-integrated-features.yml') {
        const rootPrefix = `cargo ${command} --locked --manifest-path src-tauri/Cargo.toml `;
        const rootCommands = commands.filter(line => line.startsWith(rootPrefix));
        assert.ok(rootCommands.some(line => line.includes('experimental-linux-portable-host --')));
        assert.ok(rootCommands.some(line => line.includes('experimental-linux-portable-update --')));
      }
    }
    const explicitPermissionTests = name === 'linux-integrated-features.yml'
      ? ['umask_002', 'default_acl'].map(suffix => `cargo test --locked --manifest-path src-tauri/Cargo.toml --features integrated-features,experimental-flatpak-host,linux-production-migration,experimental-linux-portable-update projects::tests::live_linux_helper_preparation_${suffix} -- --exact --ignored --test-threads=1 --nocapture`)
      : [];
    assert.deepEqual(commands.filter(line => line.includes('--ignored')), explicitPermissionTests);
    assert.doesNotMatch(commands.join('\n'), /tauri build|gh release|publish-hub|signer sign|flatpak install|dpkg --install|macos/);
  });
}

test('Linux integration validates structured workflow contracts early and keeps compilation cache on failure', () => {
  const workflow = yaml.parse(fs.readFileSync(path.join(root, '.github/workflows/linux-integrated-features.yml'), 'utf8'));
  const steps = workflow.jobs['native-libraries'].steps;
  assert.equal(steps.find(step => step.uses === 'Swatinem/rust-cache@v2').with['cache-on-failure'], true);
  const preflight = steps.findIndex(step => step.run?.includes('scripts/linux-portable-signed-controls.test.cjs'));
  assert.ok(preflight >= 0);
  const regression = steps.findIndex(step => step.run?.includes('node --test scripts/linux-portable-restart-ci.test.cjs'));
  assert.ok(regression >= 0 && regression < preflight);
  const compile = steps.findIndex(step => step.run?.includes('cargo clippy'));
  assert.ok(preflight < compile);
});

test('Linux integration runs MCP server tests before bundling and native compilation', () => {
  const workflow = yaml.parse(fs.readFileSync(path.join(root, '.github/workflows/linux-integrated-features.yml'), 'utf8'));
  const steps = workflow.jobs['native-libraries'].steps;
  const commands = steps.flatMap(step => String(step.run || '').split(/\r?\n/).map(line => line.trim()));
  const install = commands.indexOf('npm ci --prefix modules/mcp');
  const test = commands.indexOf('npm --prefix modules/mcp test');
  const bundle = commands.indexOf('npm --prefix modules/mcp run release:launcher');
  const compile = commands.findIndex(command => command.startsWith('cargo clippy'));
  assert.ok(install >= 0 && test > install, 'Run the actual MCP suite after installing its locked dependencies');
  assert.ok(bundle > test && compile > bundle, 'Fail MCP tests before bundling or native compilation');
  const step = steps.find(step => String(step.run || '').split(/\r?\n/).includes('npm --prefix modules/mcp test'));
  assert.match(step.run, /^set -euo pipefail\n/);
  assert.equal(step['continue-on-error'], undefined);
  assert.equal(step.if, undefined);
});

test('Linux integration pins isolated preflight Python without changing native Python or caches', () => {
  const source = fs.readFileSync(path.join(root, '.github/workflows/linux-integrated-features.yml'), 'utf8');
  const parsed = yaml.parseDocument(source, { uniqueKeys: true });
  assert.deepEqual(parsed.errors, []);
  const workflow = parsed.toJSON();
  assert.deepEqual(Object.keys(workflow.jobs), ['native-libraries']);
  const job = workflow.jobs['native-libraries'];
  assert.equal(job['runs-on'], 'ubuntu-22.04');
  const steps = job.steps;
  const setups = steps.filter(step => step.uses === 'actions/setup-python@v6');
  assert.equal(setups.length, 1);
  assert.equal(setups[0].id, 'preflight_python');
  assert.deepEqual(setups[0].with, { 'python-version': '3.11.17', 'update-environment': false });
  assert.equal(setups[0].if, undefined);
  assert.equal(setups[0]['continue-on-error'], undefined);
  const pure = steps.find(step => step.name === 'Pure updater context and menu preflight');
  assert.ok(pure, 'The actual shared update and migrated-HOME suites must be an early blocking step');
  assert.deepEqual(pure.env, { PREFLIGHT_PYTHON: '${{ steps.preflight_python.outputs.python-path }}' });
  assert.equal(pure['timeout-minutes'], 5);
  assert.equal(pure.if, undefined);
  assert.equal(pure['continue-on-error'], undefined);
  assert.deepEqual(pure.run.split('\n').filter(Boolean), [
    'set -euo pipefail',
    '"$PREFLIGHT_PYTHON" -I -S -B -c \'import sys; assert sys.version_info[:3] == (3, 11, 17)\'',
    'node --test scripts/linux-portable-restart-ci.test.cjs',
    '"$PREFLIGHT_PYTHON" -I -S -B scripts/native-linux-production-016-update.test.py',
    '"$PREFLIGHT_PYTHON" -I -S -B scripts/native-linux-migrated-update.test.py',
  ]);
  for (const env of [workflow.env, job.env, ...steps.filter(step => step !== pure).map(step => step.env)]) {
    assert.equal(Object.hasOwn(env || {}, 'PREFLIGHT_PYTHON'), false);
  }
  assert.doesNotMatch(source, /GITHUB_ENV|GITHUB_PATH|\bunset\b/);
  assert.deepEqual(steps.find(step => step.uses === 'Swatinem/rust-cache@v2').with, {
    workspaces: 'src-tauri\nmodules/mcp/launcher/src-tauri\nmodules/project-setup/src-tauri\nnative/linux-portable-deployment\n',
    key: 'linux-integrated-features', 'cache-on-failure': true,
  });
});

test('Linux integration blocks on pure preflight before Rust, apt and module dependencies', () => {
  const workflow = yaml.parse(fs.readFileSync(path.join(root, '.github/workflows/linux-integrated-features.yml'), 'utf8'), { uniqueKeys: true });
  const steps = workflow.jobs['native-libraries'].steps;
  const node = steps.findIndex(step => step.uses === 'actions/setup-node@v6');
  const python = steps.findIndex(step => step.uses === 'actions/setup-python@v6');
  const dependencySteps = steps.filter(step => step.run?.split('\n').includes('npm ci --ignore-scripts'));
  assert.equal(dependencySteps.length, 1, 'Root test dependencies are installed once, without lifecycle hooks');
  assert.deepEqual(dependencySteps[0].run.split('\n').filter(Boolean), ['set -euo pipefail', 'npm ci --ignore-scripts']);
  const dependencies = steps.indexOf(dependencySteps[0]);
  const pure = steps.findIndex(step => step.name === 'Pure updater context and menu preflight');
  assert.ok(0 <= node && node < python && python < dependencies && dependencies < pure);
  const expensive = steps.flatMap((step, index) => step.uses?.startsWith('dtolnay/rust-toolchain@')
    || step.uses === 'Swatinem/rust-cache@v2' || /apt-get|\bcargo\s|\brustc\s|npm ci --prefix|npm --prefix/.test(step.run || '') ? [index] : []);
  assert.ok(expensive.length > 0);
  for (const index of expensive) assert.ok(pure < index, steps[index].name || steps[index].uses);
  assert.equal(steps.filter(step => step.run?.includes('node --test scripts/linux-portable-restart-ci.test.cjs')).length, 1);
});

test('Linux integration updater preflight parses the actual controller and test source bytes', () => {
  const files = ['native-linux-production-016-update.py', 'native-linux-production-016-update.test.py',
    'native-linux-migrated-update.py', 'native-linux-migrated-update.test.py'];
  const input = files.map(name => ({ name, bytes: fs.readFileSync(path.join(root, 'scripts', name)).toString('hex') }));
  const parsed = spawnSync(process.platform === 'win32' ? 'python' : '/usr/bin/python3', [
    '-I', '-S', '-B', '-c',
    'import ast,json,sys\nfor source in json.load(sys.stdin): ast.parse(bytes.fromhex(source["bytes"]), filename=source["name"], feature_version=(3,10))',
  ], { input: JSON.stringify(input), encoding: 'utf8', timeout: 10000, windowsHide: true, shell: false });
  assert.equal(parsed.status, 0, parsed.stderr || parsed.error?.message);
});
