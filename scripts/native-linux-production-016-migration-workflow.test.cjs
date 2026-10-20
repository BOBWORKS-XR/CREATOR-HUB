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
  assert.deepEqual(Object.keys(workflow.jobs), ['migration']);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), ['profile', 'scenario', 'execute_migration']);
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
  assert.equal(job.strategy, undefined);
  assert.equal(job.env.CREATOR_MIGRATION_016_SCENARIO, '${{ inputs.scenario }}');
  assert.equal(job.env.CREATOR_MIGRATION_016_EXECUTE, '${{ inputs.execute_migration }}');
  assert.equal(job.steps.find(step => step.uses === 'actions/checkout@v6').with['persist-credentials'], false);
});

test('actual job guard skips registration pushes even with execution requested, and admits only the exact opted-in dispatch', () => {
  const job = workflow.jobs.migration;
  // Interpret only the guard's fixed conjunction/equality grammar, not JavaScript
  // or an approximation that could overlook an added OR/always() bypass.
  const clauses = job.if.trim().split(/\s+&&\s+/).map(clause => {
    const match = /^(github\.[a-z_]+|inputs\.execute_migration) == (?:'([^']+)'|(true))$/.exec(clause.trim());
    assert.ok(match, `Unsupported execution guard clause: ${clause}`);
    return { field: match[1].split('.'), expected: match[3] ? true : match[2] };
  });
  assert.equal(clauses.length, 6);
  const github = { repository: 'BOBWORKS-XR/CREATOR-HUB', repository_id: '1364807512',
    ref: 'refs/heads/validation/native-linux-production-016', event_name: 'workflow_dispatch',
    workflow_ref: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/native-linux-production-016-migration.yml@refs/heads/validation/native-linux-production-016' };
  const admitted = (context, inputs) => clauses.every(({ field: [root, key], expected }) =>
    ({ github: context, inputs })[root]?.[key] === expected);
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
});

test('pinned preflight Python precedes pure tests while native brokers retain the system interpreter', () => {
  const steps = workflow.jobs.migration.steps;
  const setups = steps.filter(step => step.uses === 'actions/setup-python@v6');
  assert.equal(setups.length, 1);
  assert.deepEqual(setups[0].with, { 'python-version': '3.11.17' });
  const setup = steps.indexOf(setups[0]);
  const pure = steps.findIndex(step => step.name?.startsWith('Pure execution'));
  const download = steps.findIndex(step => step.uses === 'actions/github-script@v8');
  const dependencies = steps.findIndex(step => step.run?.includes('sudo apt-get install'));
  const broker = steps.findIndex(step => step.name?.startsWith('Fixed root broker'));
  assert.ok(0 < setup && setup < pure && pure < download && download < dependencies && dependencies < broker);
  assert.match(steps[pure].run, /^python3 -B scripts\/native-linux-production-016-stage\.test\.py$/m);
  assert.match(steps[pure].run, /^python3 -B scripts\/native-linux-production-016-migration\.test\.py$/m);
  assert.match(steps[dependencies].run, /python3-gi python3-toml/);
  assert.match(steps[broker].run, /'PATH=\/usr\/bin:\/bin', 'LANG=C', 'LC_ALL=C',\s*'\/usr\/bin\/python3', '-B', str\(source\), 'broker'/);
  const controller = fs.readFileSync(path.join(__dirname, 'native-linux-production-016-migration.py'), 'utf8');
  assert.match(controller, /"\/usr\/bin\/python3", "-B", str\(BASE \/ "scripts" \/ Path\(__file__\)\.name\), "session"/);
  assert.match(controller, /import tomllib as toml\s+except ImportError:\s+import toml/);
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
  assert.doesNotMatch(source, /build:unified|cargo (?:build|run)|gh release|contents: write|actions: write|continue-on-error|flatpak install/);
});

test('inline scripts parse with the stdlib and artifact exports have an explicit bounded safe list', () => {
  const commands = workflow.jobs.migration.steps.filter(step => step.run).map(step => step.run);
  for (const command of commands) assert.ok(!command.includes('${{'), 'No workflow input interpolation into shell/Python source');
  const scripts = commands.flatMap(command => [...command.matchAll(/<<'PY'\n([\s\S]*?)\nPY(?:\n|$)/g)].map(match => match[1]));
  assert.equal(scripts.length, 3);
  cp.execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c',
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
