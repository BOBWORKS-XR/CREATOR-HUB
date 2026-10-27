'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { yaml } = require('../node_modules/playwright-core/lib/utilsBundle.js');
const file = path.join(__dirname, '../.github/workflows/native-linux-production-016-migration.yml');
const source = fs.readFileSync(file, 'utf8');
const parsed = yaml.parseDocument(source, { uniqueKeys: true });
assert.deepEqual(parsed.errors, []);
const workflow = parsed.toJSON();

test('exact validation-branch push registers the workflow but execution remains manual and opted in', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push, { branches: ['validation/native-linux-production-016'] });
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), ['continuation_preflight', 'continuation_input', 'migration']);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), ['profile', 'scenario', 'execute_migration', 'continue_after_migration', 'outgoing_profile', 'outgoing_profile_sha256']);
  assert.equal(inputs.continue_after_migration.type, 'boolean');
  assert.equal(inputs.continue_after_migration.default, false);
  assert.equal(inputs.outgoing_profile.required, false);
  assert.equal(inputs.outgoing_profile_sha256.required, false);
  assert.equal(inputs.execute_migration.type, 'boolean');
  assert.equal(inputs.execute_migration.default, false);
  assert.equal(inputs.scenario.type, 'choice');
  assert.deepEqual(inputs.scenario.options, ['migration-guide-cancel', 'migration-first-system-cancel', 'migration-second-system-cancel', 'migration-approve']);
  const job = workflow.jobs.migration;
  for (const condition of ["github.repository == 'BOBWORKS-XR/CREATOR-HUB'", "github.repository_id == '1364807512'",
    "github.ref == 'refs/heads/validation/native-linux-production-016'", "github.event_name == 'workflow_dispatch'",
    "github.workflow_ref == 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/native-linux-production-016-migration.yml@refs/heads/validation/native-linux-production-016'",
    'inputs.execute_migration == true']) assert.ok(job.if.includes(condition), condition);
  assert.equal(job['runs-on'], 'ubuntu-22.04');
  assert.equal(job['timeout-minutes'], '${{ inputs.continue_after_migration == true && 44 || 25 }}');
  assert.equal(job.strategy, undefined);
  assert.equal(job.env.CREATOR_MIGRATION_016_SCENARIO, '${{ inputs.scenario }}');
  assert.equal(job.env.CREATOR_MIGRATION_016_EXECUTE, '${{ inputs.execute_migration }}');
  assert.equal(job.steps.find(step => step.uses === 'actions/checkout@v6').with['persist-credentials'], false);
});

test('actual job guard skips registration pushes even with execution requested, and admits only the exact opted-in dispatch', () => {
  const job = workflow.jobs.migration;
  // Interpret only the guard's fixed conjunction/equality grammar, not JavaScript
  // or an approximation that could overlook an added OR/always() bypass.
  const optional = "(inputs.continue_after_migration != true || (inputs.scenario == 'migration-approve' && needs.continuation_input.result == 'success'))";
  const normalized = job.if.trim().replace(/\s+/g, ' ');
  assert.ok(normalized.startsWith('always() && !cancelled() && '));
  assert.ok(normalized.endsWith(' && ' + optional));
  const original = normalized.slice('always() && !cancelled() && '.length, -(' && ' + optional).length);
  const clauses = original.split(/\s+&&\s+/).map(clause => {
    const match = /^(github\.[a-z_]+|inputs\.execute_migration) == (?:'([^']+)'|(true))$/.exec(clause.trim());
    assert.ok(match, `Unsupported execution guard clause: ${clause}`);
    return { field: match[1].split('.'), expected: match[3] ? true : match[2] };
  });
  assert.equal(clauses.length, 6);
  const github = { repository: 'BOBWORKS-XR/CREATOR-HUB', repository_id: '1364807512',
    ref: 'refs/heads/validation/native-linux-production-016', event_name: 'workflow_dispatch',
    workflow_ref: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/native-linux-production-016-migration.yml@refs/heads/validation/native-linux-production-016' };
  const admitted = (context, inputs, result = 'skipped', cancelled = false) => !cancelled &&
    clauses.every(({ field: [root, key], expected }) => ({ github: context, inputs })[root]?.[key] === expected) &&
    (inputs.continue_after_migration !== true || (inputs.scenario === 'migration-approve' && result === 'success'));
  assert.equal(admitted(github, { execute_migration: true }), true);
  for (const inputs of [{}, { execute_migration: false }, { execute_migration: true }, { execute_migration: 'true' }]) {
    assert.equal(admitted({ ...github, event_name: 'push' }, inputs), false, 'Registration push must skip the entire migration job');
  }
  for (const inputs of [{}, { execute_migration: false }, { execute_migration: 'true' }]) {
    assert.equal(admitted(github, inputs), false);
  }
  for (const key of Object.keys(github)) {
    assert.equal(admitted({ ...github, [key]: 'not-the-admitted-context' }, { execute_migration: true }), false, key);
  }
  for (const result of ['skipped', 'failure', 'cancelled']) {
    assert.equal(admitted(github, { execute_migration: true }, result), true, 'Unchanged opt-out lane survives optional skipped jobs');
    assert.equal(admitted(github, { execute_migration: true, continue_after_migration: true, scenario: 'migration-approve' }, result), false);
  }
  assert.equal(admitted(github, { execute_migration: true, continue_after_migration: true, scenario: 'migration-approve' }, 'success'), true);
  assert.equal(admitted(github, { execute_migration: true, continue_after_migration: true, scenario: 'migration-guide-cancel' }, 'success'), false);
  assert.equal(admitted(github, { execute_migration: true }, 'success', true), false);
});

test('pinned preflight Python precedes pure tests while native brokers retain the system interpreter', () => {
  const steps = workflow.jobs.migration.steps;
  const setups = steps.filter(step => step.uses === 'actions/setup-python@v6');
  assert.equal(setups.length, 1);
  assert.equal(setups[0].id, 'preflight_python');
  assert.deepEqual(setups[0].with, { 'python-version': '3.11.17', 'update-environment': false });
  const setup = steps.indexOf(setups[0]);
  const pure = steps.findIndex(step => step.name?.startsWith('Pure execution'));
  const download = steps.findIndex(step => step.uses === 'actions/github-script@v8');
  const dependencies = steps.findIndex(step => step.run?.includes('sudo apt-get install'));
  const broker = steps.findIndex(step => step.name?.startsWith('Fixed root broker'));
  assert.ok(0 < setup && setup < pure && pure < download && download < dependencies && dependencies < broker);
  assert.deepEqual(steps[pure].env, { PREFLIGHT_PYTHON: '${{ steps.preflight_python.outputs.python-path }}' });
  assert.match(steps[pure].run, /^"\$PREFLIGHT_PYTHON" -I -c 'import sys, tomllib; assert sys.version_info\[:3\] == \(3, 11, 17\)'$/m);
  assert.match(steps[pure].run, /^"\$PREFLIGHT_PYTHON" -B scripts\/native-linux-production-016-stage\.test\.py$/m);
  assert.match(steps[pure].run, /^"\$PREFLIGHT_PYTHON" -B scripts\/native-linux-production-016-migration\.test\.py$/m);
  assert.match(steps[pure].run, /^"\$PREFLIGHT_PYTHON" -I -S -B scripts\/native-linux-migrated-update\.test\.py$/m);
  assert.match(steps[pure].run, /^node --test scripts\/linux-update-lab-feed\.test\.cjs$/m);
  for (const env of [workflow.env, workflow.jobs.migration.env, ...steps.map(step => step.env)]) {
    for (const key of Object.keys(env || {})) assert.doesNotMatch(key, /^(?:LD_|DYLD_|PYTHONPATH$|PYTHONHOME$)/);
  }
  assert.equal(Object.hasOwn(workflow.jobs.migration.env, 'PREFLIGHT_PYTHON'), false);
  for (const step of steps.filter((_, index) => index !== pure)) {
    assert.equal(Object.hasOwn(step.env || {}, 'PREFLIGHT_PYTHON'), false);
    assert.doesNotMatch(step.run || '', /PREFLIGHT_PYTHON|preflight_python\.outputs/);
  }
  const nodeBinding = steps.filter(step => step.run?.includes('GITHUB_ENV'));
  assert.equal(nodeBinding.length, 1);
  assert.equal(nodeBinding[0].if, 'inputs.continue_after_migration == true');
  assert.equal(nodeBinding[0].run.trim(), `printf 'CONTROLLER_NODE=%s\\n' "$(realpath "$(command -v node)")" >> "$GITHUB_ENV"`);
  for (const step of steps.filter(step => step !== nodeBinding[0])) assert.doesNotMatch(step.run || '', /GITHUB_ENV|GITHUB_PATH/);
  assert.doesNotMatch(source, /\bunset\b|GITHUB_PATH/);
  assert.match(steps[dependencies].run, /python3-gi python3-toml/);
  assert.match(steps[broker].run, /'PATH=\/usr\/bin:\/bin', 'LANG=C', 'LC_ALL=C',\s*'\/usr\/bin\/python3', '-B', str\(source\), 'broker'/);
  const controller = fs.readFileSync(path.join(__dirname, 'native-linux-production-016-migration.py'), 'utf8');
  assert.match(controller, /"\/usr\/bin\/python3", "-B", str\(BASE \/ "scripts" \/ Path\(__file__\)\.name\), "session"/);
  assert.match(controller, /import tomllib as toml\s+except ImportError:\s+import toml/);
});

test('actual reused polkit and transitive helper suites are mandatory before downloads or apt', () => {
  const steps = workflow.jobs.migration.steps;
  const pure = steps.findIndex(step => step.name?.startsWith('Pure execution'));
  const download = steps.findIndex(step => step.uses === 'actions/github-script@v8');
  const apt = steps.findIndex(step => step.run?.includes('sudo apt-get'));
  assert.ok(0 <= pure && pure < download && download < apt);
  assert.equal(steps[pure]['continue-on-error'], undefined);
  for (const name of ['native-linux-polkit-probe', 'native-linux-root-probe', 'native-unix-window']) {
    const command = `"$PREFLIGHT_PYTHON" -B scripts/${name}.test.py`;
    assert.equal(steps[pure].run.split('\n').filter(line => line === command).length, 1, command);
    assert.equal(steps.filter(step => (step.run || '').includes(command)).length, 1, command);
  }
  assert.doesNotMatch(steps[pure].run, /\|\||set \+e|continue-on-error/);
  const suite = fs.readFileSync(path.join(__dirname, 'native-linux-polkit-probe.test.py'), 'utf8');
  assert.match(suite, /^b = p\.base\(\)$/m);
});

test('real exact-target fixture is mandatory after GUI dependencies and gates SDK, tooling and broker', () => {
  const steps = workflow.jobs.migration.steps;
  const apt = steps.findIndex(step => step.run?.includes('sudo apt-get install'));
  const fixtures = steps.filter(step => step.run?.includes('--native-exact-target'));
  assert.equal(fixtures.length, 1);
  const fixture = fixtures[0], index = steps.indexOf(fixture);
  assert.ok(apt < index);
  for (const next of [steps.findIndex(step => step.run?.includes('npm ci --prefix modules/mcp')),
    steps.findIndex(step => step.uses?.startsWith('dtolnay/rust-toolchain@')),
    steps.findIndex(step => step.name?.startsWith('Build pinned WebDriver')),
    steps.findIndex(step => step.name?.startsWith('Fixed root broker'))]) assert.ok(index < next);
  assert.equal(fixture.if, undefined);
  assert.equal(fixture['continue-on-error'], undefined);
  assert.equal(fixture['timeout-minutes'], 2);
  assert.deepEqual(fixture.env, { CREATOR_NATIVE_EXACT_TARGET_FIXTURE: '1' });
  assert.match(fixture.run, /^set -o noclobber$/m);
  assert.match(fixture.run, /^\/usr\/bin\/timeout --signal=TERM --kill-after=5s 40s \/usr\/bin\/python3 -B scripts\/native-linux-polkit-probe\.test\.py --native-exact-target > "\$RUNNER_TEMP\/native-exact-target-observer\.json"$/m);
  assert.match(fixture.run, /-le 16384/);
  assert.doesNotMatch(fixture.run, /\|\||set \+e|sudo|broker|pkexec|\.deb/);
  const upload = steps.find(step => step.uses === 'actions/upload-artifact@v4');
  assert.equal(upload.with.path.split('\n').filter(line => line === '${{ runner.temp }}/native-exact-target-observer.json').length, 1);
});

test('unchanged production API/offline gate precedes any candidate execution or privilege', () => {
  const steps = workflow.jobs.migration.steps;
  const index = needle => steps.findIndex(step => step.run?.includes(needle));
  const download = steps.findIndex(step => step.uses === 'actions/github-script@v8');
  assert.ok(index('npm ci --ignore-scripts') < index('migration.test.py'));
  assert.ok(index('migration.test.py') < download);
  assert.match(steps[download].with.script, /native-linux-production-016-input.cjs/);
  assert.equal(steps[download].env.PROFILE, '${{ inputs.profile }}');
  const stage = steps.findIndex(step => step.run === 'python3 -B scripts/native-linux-production-016-stage.py');
  const request = steps.findIndex(step => step.run === 'python3 -B scripts/native-linux-production-016-migration.py');
  assert.ok(download < stage && stage < request && request < index('sudo apt-get'));
  assert.ok(index('sudo apt-get') < index("str(source), 'broker'"));
  assert.match(source, /npm ci --prefix modules\/mcp --ignore-scripts/);
  assert.match(source, /cargo install tauri-driver --version 2\.1\.0 --locked/);
  assert.doesNotMatch(source, /build:unified|cargo (?:build|run)|gh release|actions: write|continue-on-error|flatpak install/);
  assert.deepEqual(workflow.jobs.continuation_input.permissions, { contents: 'write', actions: 'read' });
  for (const [name, job] of Object.entries(workflow.jobs).filter(([name]) => name !== 'continuation_input')) {
    assert.notEqual((job.permissions || workflow.permissions).contents, 'write', name);
  }
});

test('inline Python and Bash parse and artifact exports have an explicit bounded safe list', () => {
  const commands = Object.values(workflow.jobs).flatMap(job => job.steps.filter(step => step.run).map(step => step.run));
  for (const command of commands) assert.ok(!command.includes('${{'), 'No workflow input interpolation into shell/Python source');
  for (const command of commands) cp.execFileSync(process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
    ['-n'], { input: command, encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  const scripts = commands.flatMap(command => [...command.matchAll(/<<'PY'\n([\s\S]*?)\nPY(?:\n|$)/g)].map(match => match[1]));
  assert.equal(scripts.length, 8);
  cp.execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-S', '-B', '-c',
    'import ast,json,sys\nfor source in json.load(sys.stdin): ast.parse(source, feature_version=(3,10))'],
  { input: JSON.stringify(scripts), encoding: 'utf8' });
  const exporter = workflow.jobs.migration.steps.find(step => step.name?.startsWith('Export only'));
  assert.equal(exporter.if, 'always()');
  assert.match(exporter.run, /range\(1, 49\)/);
  assert.match(exporter.run, /info\.st_nlink == 1/);
  assert.match(exporter.run, /os\.O_NOFOLLOW \| os\.O_NONBLOCK/);
  assert.match(exporter.run, /stamp\(file\.lstat\(\)\) == stamp\(info\)/);
  assert.match(exporter.run, /home\.png/);
  assert.match(exporter.run, /262144/);
  assert.doesNotMatch(exporter.run, /read_text|rglob|glob\(|assembly\.zip|\.deb|auth\.json|secret|password/);
  const upload = workflow.jobs.migration.steps.find(step => step.uses === 'actions/upload-artifact@v4');
  assert.equal(upload.if, 'always()');
  assert.doesNotMatch(upload.with.path, /\.bin|\.deb|assembly\.zip|credential|auth\.json/);
});

test('optional continuation retains the one migration broker and prepares before migration then adopts after success', () => {
  const job = workflow.jobs.migration, steps = job.steps;
  assert.equal(job.needs, 'continuation_input');
  const prepare = steps.findIndex(step => step.name?.startsWith('Prepare sealed'));
  const migration = steps.findIndex(step => step.name?.startsWith('Fixed root broker'));
  const adopt = steps.findIndex(step => step.name?.startsWith('Adopt only'));
  const exportContinuation = steps.findIndex(step => step.name?.startsWith('Export bounded continuation'));
  const exportMigration = steps.findIndex(step => step.name?.startsWith('Export only'));
  assert.ok(prepare > 0 && prepare < migration && migration < adopt && adopt < exportContinuation && exportContinuation < exportMigration);
  assert.equal(steps[prepare].if, 'inputs.continue_after_migration == true');
  assert.equal(steps[adopt].if, 'success() && inputs.continue_after_migration == true');
  assert.equal(steps[migration].if, undefined);
  assert.equal(steps.filter(step => step.name?.startsWith('Fixed root broker')).length, 1);
  for (const [index, mode] of [[prepare, 'prepare'], [adopt, 'broker']]) {
    assert.match(steps[index].run, /native-linux-migrated-update\.py/);
    assert.match(steps[index].run, /m\.admission\(os\.environ\)/);
    assert.match(steps[index].run, /m\.U\.ENVIRONMENT \+ m\.EXTRA_ENV/);
    assert.ok(steps[index].run.includes(`str(source), '${mode}'`));
    assert.doesNotMatch(steps[index].run, /fixtures\(|seed|dpkg|apt-get|useradd|reinstall|retry/);
    assert.equal(steps[index]['continue-on-error'], undefined);
  }
  const download = steps.find(step => step.uses === 'actions/download-artifact@v5');
  assert.equal(download.if, 'inputs.continue_after_migration == true');
  assert.equal(download.with['artifact-ids'], '${{ needs.continuation_input.outputs.artifact }}');
  assert.equal(download.with.path, '${{ runner.temp }}/native-linux-migrated-update-input');
  assert.equal(download.with['run-id'], undefined, 'Only the current workflow artifact may be consumed');
  assert.ok(steps.indexOf(download) < prepare);
  assert.equal(steps[exportContinuation].if, 'always() && inputs.continue_after_migration == true');
  assert.match(steps[exportContinuation].run, /native-linux-migrated-update\.py/);
  assert.match(steps[exportContinuation].run, /m\.admission\(os\.environ\)/);
  assert.match(steps[exportContinuation].run, /m\.U\.ENVIRONMENT \+ m\.EXTRA_ENV/);
  assert.match(steps[exportContinuation].run, /str\(source\), 'export'/);
  assert.match(steps[exportContinuation].run, /'\/usr\/bin\/sudo', '-n', '\/usr\/bin\/env', '-i'/);
  assert.ok(steps.find(step => step.uses === 'actions/upload-artifact@v4').with.path.includes('native-linux-migrated-update-evidence'));
});

test('outgoing data route has its own pure preflight and no native privilege or checked-out code', () => {
  const preflight = workflow.jobs.continuation_preflight, data = workflow.jobs.continuation_input;
  for (const job of [preflight, data]) {
    for (const condition of ["inputs.scenario == 'migration-approve'", 'inputs.execute_migration == true', 'inputs.continue_after_migration == true',
      "github.ref == 'refs/heads/validation/native-linux-production-016'", "github.event_name == 'workflow_dispatch'"]) assert.ok(job.if.includes(condition));
  }
  assert.equal(data.needs, 'continuation_preflight');
  const pure = preflight.steps.find(step => step.name?.startsWith('Pure continuation'));
  assert.equal(pure['continue-on-error'], undefined);
  for (const command of [
    '"$PREFLIGHT_PYTHON" -I -S -B scripts/native-linux-production-016-update.test.py',
    '"$PREFLIGHT_PYTHON" -I -S -B scripts/native-linux-migrated-update.test.py',
    'node --test scripts/linux-update-lab-feed.test.cjs',
    'node --test scripts/native-linux-production-016-migration-workflow.test.cjs',
  ]) assert.ok(pure.run.split('\n').includes(command), command);
  const refusal = preflight.steps.find(step => step.name?.startsWith('Refuse unbound'));
  assert.ok(refusal.run.indexOf('m.require_bound_continuation()') < refusal.run.indexOf('m.profile('));
  assert.match(refusal.run, /m\.MIGRATION_PROFILE_SHA/);
  assert.match(refusal.run, /OUTGOING_PROFILE_SHA256.*m\.PROFILE_SHA/);
  assert.ok(!data.steps.some(step => /checkout|setup-|sudo|python|npm|extract|execFile/.test(step.uses || step.run || '')));
  const stage = data.steps.find(step => step.uses === 'actions/github-script@v8');
  assert.equal(stage.with.retries, 0);
  assert.match(stage.with.script, /BOUND_PROFILE_SHA256 = '02aeb5653fcd0dde0576907b7f480b895ea8c3e509cf2954ad2944ee8ef78fcb'/);
  assert.match(stage.with.script, /dce183ec0a0f23210d83b064c04ecc8b6af999fe/);
  assert.match(stage.with.script, /6d881eade5b3178913012d3a6c6632bd41b0e849/);
  assert.doesNotMatch(stage.with.script, /39352480021|658078066/);
  const upload = data.steps.find(step => step.id === 'upload');
  assert.equal(upload.with['if-no-files-found'], 'error');
  assert.equal(upload.with['retention-days'], 1);
  assert.equal(upload.with['compression-level'], 0);
});

test('continuation builds only the existing shared verifier as the admitted caller before sealing intent', () => {
  const steps = workflow.jobs.migration.steps;
  const tool = steps.findIndex(s => s.name?.startsWith('Build only the shared locked offline verifier'));
  const rust = steps.findIndex(s => s.uses?.startsWith('dtolnay/rust-toolchain@'));
  const prepare = steps.findIndex(s => s.name?.startsWith('Prepare sealed'));
  assert.ok(rust >= 0 && rust < tool && tool < prepare);
  assert.equal(steps[tool].if, 'inputs.continue_after_migration == true');
  assert.match(steps[tool].run, /m\.admission\(os\.environ\)/);
  assert.match(steps[tool].run, /m\.U\.build_offline_verifier\(os\.environ\)/);
  assert.ok(steps[tool].run.indexOf('m.admission(') < steps[tool].run.indexOf('m.U.build_offline_verifier('));
  assert.doesNotMatch(steps[tool].run, /sudo|\.main\(|\.U\.admission|flatpak.*admission|GITHUB_REF.*=/);
  const upload = steps.find(s => s.uses === 'actions/upload-artifact@v4');
  assert.ok(upload.with.path.includes('native-linux-production-016-verifier/receipt.json'));
});

test('outer CI continuation allowance covers exact540/900/180/30 bounds without extending product limits', () => {
  const expression = workflow.jobs.migration['timeout-minutes'];
  assert.equal(expression, '${{ inputs.continue_after_migration == true && 44 || 25 }}');
  const budget = enabled => enabled === true ? 44 : 25;
  assert.equal(budget(false), 25); assert.equal(budget(undefined), 25);
  assert.equal(budget(true), Math.ceil((25 * 60 + 900 + 180 + 30) / 60));
  assert.equal(540 + 900 + 180 + 30, 27.5 * 60);
  assert.ok(budget(true) * 60 > 540 + 900 + 180 + 30 + 2 * 60);
  const controller = fs.readFileSync(path.join(__dirname, 'native-linux-migrated-update.py'), 'utf8');
  assert.match(controller, /deadline = .*time\.monotonic\(\) \+ 900/);
  assert.match(controller, /capture_output=True, timeout=30/);
  const migration = fs.readFileSync(path.join(__dirname, 'native-linux-production-016-migration.py'), 'utf8');
  assert.match(migration, /index, deadline = 1, time\.monotonic\(\) \+ 540/);
  const verifier = fs.readFileSync(path.join(__dirname, 'native-linux-production-016-flatpak.py'), 'utf8');
  assert.match(verifier, /timeout=180, cwd=source/);
});

const stageScript = workflow.jobs.continuation_input.steps.find(step => step.uses === 'actions/github-script@v8').with.script;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('qualified1ab driver and full diagnostic suite are the exact reviewed blobs with29 phase captures', () => {
  for (const [name, size, digest] of [
    ['native-linux-production-016-update.py', 285021, 'cbf7bce843f5fc884265f802fa427cd2896aedb6ddf309286e5c2ebaca5d8ccd'],
    ['native-linux-production-016-update.test.py', 533946, 'cd652cca90f42cefcb71f5841054124dcca96ce9ef49fd110b54b29f5acc2d08'],
  ]) {
    const raw = fs.readFileSync(path.join(__dirname, name));
    assert.equal(raw.length, size, name); assert.equal(hash(raw), digest, name);
  }
  const driver = fs.readFileSync(path.join(__dirname, 'native-linux-production-016-update.py'), 'utf8');
  const phases = /SESSION_PHASES = \(([\s\S]*?)\n\)/.exec(driver);
  assert.ok(phases); assert.equal([...phases[1].matchAll(/"[a-z-]+"/g)].length, 29);
  assert.match(driver, /range\(len\(SESSION_PHASES\)\)/);
});

const profileRaw = fs.readFileSync(path.join(__dirname, 'fixtures/native-linux-migrated-update-profile.json'));
const profileHash = '02aeb5653fcd0dde0576907b7f480b895ea8c3e509cf2954ad2944ee8ef78fcb';
assert.equal(hash(profileRaw), profileHash, 'Verbatim approved profile fixture, no test hash substitution');

function acquisitionFixture(mutate = () => {}) {
  const profile = JSON.parse(profileRaw), bodies = {};
  const proof = {};
  for (const [role, e] of Object.entries(profile.artifacts)) {
    const repo = { id: 1364807512, full_name: 'BOBWORKS-XR/CREATOR-HUB' };
    proof[role] = {
      run: { id: e.run, run_attempt: 1, head_sha: e.source, head_branch: e.branch, path: e.workflow, event: 'workflow_dispatch',
        status: 'completed', conclusion: 'success', repository: repo, head_repository: repo },
      job: { id: e.job, run_id: e.run, run_attempt: 1, head_sha: e.source, status: 'completed', conclusion: 'success', labels: ['ubuntu-22.04'] },
      artifact: { id: e.artifact, name: e.name, expired: false, size_in_bytes: e.zip.size, digest: 'sha256:' + e.zip.sha256,
        workflow_run: { id: e.run, head_sha: e.source, head_branch: e.branch } },
      commit: { sha: e.source, tree: { sha: e.tree } }
    };
  }
  const e = profile.deliveries.signedDeb17;
  const asset = { id: e.asset, name: e.name, size: e.zip.size, state: 'uploaded', digest: 'sha256:' + e.zip.sha256 };
  const release = { id: 411494394, tag_name: 'v0.1.13-validation', draft: true };
  const listing = [asset], env = { INPUT_PROFILE: profileRaw.toString(), INPUT_PROFILE_SHA256: profileHash,
    RUNNER_TEMP: '/unit/temp', GITHUB_RUN_ATTEMPT: '1' };
  mutate({ profile, proof, asset, release, bodies, listing, env });
  const writes = [], calls = [];
  const get = (label, fn) => async params => { calls.push(label); return { data: fn(params) }; };
  const lookup = (key, id) => proof[Object.keys(profile.artifacts).find(role => profile.artifacts[role][key] === id)];
  const github = { rest: { actions: {
    getWorkflowRun: get('run', p => lookup('run', p.run_id).run), getJobForWorkflowRun: get('job', p => lookup('job', p.job_id).job),
    getArtifact: get('artifact', p => lookup('artifact', p.artifact_id).artifact),
    downloadArtifact: get('download', p => bodies[Object.keys(profile.artifacts).find(role => profile.artifacts[role].artifact === p.artifact_id)] || Buffer.alloc(0))
  }, git: { getCommit: get('commit', p => Object.values(proof).find(v => v.commit.sha === p.commit_sha)?.commit || {}) }, repos: {
    getRelease: get('release', () => release), listReleaseAssets: get('listing', () => listing),
    getReleaseAsset: get('asset', p => p.headers ? bodies.signedDeb17 : asset)
  } } };
  const fakeFs = { mkdirSync: () => calls.push('mkdir'), writeFileSync: (file, bytes, options) => writes.push({ file, bytes: Buffer.from(bytes), options }) };
  return { writes, calls, run: () => new AsyncFunction('require', 'process', 'github', 'context', 'Buffer', stageScript)(
    name => name === 'node:fs' ? fakeFs : require(name),
    { env },
    github, { sha: 'f'.repeat(40), runId: 99 }, Buffer) };
}

test('closed profile refuses old mixed malformed or caller-rehashed inputs before any API or filesystem access', async () => {
  for (const change of [
    x => { x.env.INPUT_PROFILE_SHA256 = '808f83a6cdc14a2d49000a2c9cd340397a748e166dfdb29720fe4af07ff91e66'; },
    x => { x.env.INPUT_PROFILE_SHA256 = ''; },
    x => { x.env.INPUT_PROFILE = '{}'; x.env.INPUT_PROFILE_SHA256 = hash(Buffer.from('{}')); },
    x => { const p = JSON.parse(x.env.INPUT_PROFILE); p.baseline.run = 40403377032; x.env.INPUT_PROFILE = JSON.stringify(p); },
    x => { x.env.INPUT_PROFILE += '\n'; }
  ]) {
    const f = acquisitionFixture(change); await assert.rejects(f.run());
    assert.deepEqual(f.calls, []); assert.deepEqual(f.writes, []);
  }
});

test('actual fixed profile and mocked API refusals precede all three original ZIP downloads', async () => {
  for (const mutate of [
    x => { x.proof.assembly16.run.conclusion = 'failure'; },
    x => { x.proof.assembly17.run.run_attempt = 2; },
    x => { x.proof.assembly16.run.repository = { id: 1 }; },
    x => { x.proof.assembly17.job.head_sha = '0'.repeat(40); },
    x => { x.proof.assembly17.commit.tree.sha = '0'.repeat(40); },
    x => { x.proof.assembly16.artifact.expired = true; },
    x => { x.proof.assembly17.artifact.workflow_run.id = 999; },
    x => { x.proof.assembly17.artifact.digest = 'sha256:' + '0'.repeat(64); },
    x => { x.release.draft = false; },
    x => { x.asset.digest = 'sha256:' + '0'.repeat(64); },
    x => { x.asset.id = 658078066; },
    x => { x.listing.push({ ...x.asset }); }
  ]) {
    const fixture = acquisitionFixture(mutate); await assert.rejects(fixture.run());
    assert.ok(!fixture.calls.includes('download'));
    assert.deepEqual(fixture.writes, []);
  }
});

test('all exact metadata can reach only the original byte gate, never accept empty bytes', async () => {
  const f = acquisitionFixture(); await assert.rejects(f.run());
  assert.equal(f.calls.filter(x => x === 'run').length, 2);
  assert.equal(f.calls.filter(x => x === 'download').length, 1);
  assert.deepEqual(f.writes, []);
  assert.match(stageScript, /flag:'wx',mode:0o600/);
  assert.match(stageScript, /\['assembly16','assembly17','signedDeb17'\]/);
});
