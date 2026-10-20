'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { yaml } = require('../node_modules/playwright-core/lib/utilsBundle.js');
const source = fs.readFileSync(path.join(__dirname, '../.github/workflows/native-linux-unit-start-ack.yml'), 'utf8');
const parsed = yaml.parseDocument(source, { uniqueKeys: true });
assert.deepEqual(parsed.errors, []);
const workflow = parsed.toJSON();

test('registration push cannot execute the exact manual opted-in hosted probe', () => {
  assert.deepEqual(workflow.on.push, { branches: ['validation/native-linux-unit-start-ack'] });
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(Object.keys(workflow.jobs), ['probe']);
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), ['execute_probe']);
  assert.equal(inputs.execute_probe.default, false);
  assert.equal(inputs.execute_probe.type, 'boolean');
  assert.equal(inputs.execute_probe.required, true);
  const job = workflow.jobs.probe;
  const clauses = job.if.trim().split(/\s+&&\s+/).map(clause => {
    const match = /^(github\.[a-z_]+|inputs\.execute_probe) == (?:'([^']+)'|(true))$/.exec(clause.trim());
    assert.ok(match, clause);
    return { field: match[1].split('.'), expected: match[3] ? true : match[2] };
  });
  assert.equal(clauses.length, 6);
  const github = { repository: 'BOBWORKS-XR/CREATOR-HUB', repository_id: '1364807512', event_name: 'workflow_dispatch',
    ref: 'refs/heads/validation/native-linux-unit-start-ack',
    workflow_ref: 'BOBWORKS-XR/CREATOR-HUB/.github/workflows/native-linux-unit-start-ack.yml@refs/heads/validation/native-linux-unit-start-ack' };
  const admit = (github, inputs) => clauses.every(({ field: [root, key], expected }) => ({ github, inputs })[root]?.[key] === expected);
  assert.equal(admit(github, { execute_probe: true }), true);
  for (const key of Object.keys(github)) assert.equal(admit({ ...github, [key]: 'wrong' }, { execute_probe: true }), false);
  for (const execute_probe of [undefined, false, 'true']) assert.equal(admit(github, { execute_probe }), false);
  assert.equal(admit({ ...github, event_name: 'push' }, { execute_probe: true }), false);
  assert.equal(job['runs-on'], 'ubuntu-22.04');
  assert.equal(job['timeout-minutes'], 5);
  assert.equal(job.strategy, undefined);
  assert.equal(job.env.CREATOR_UNIT_ACK_EXECUTE, '${{ inputs.execute_probe }}');
});

test('declared dependencies and pure tests precede the isolated root copy/native probe', () => {
  const steps = workflow.jobs.probe.steps;
  assert.equal(steps.find(step => step.uses === 'actions/checkout@v6').with['persist-credentials'], false);
  assert.deepEqual(steps.find(step => step.uses === 'actions/setup-node@v6').with, { 'node-version': '24.17.0' });
  const python = steps.find(step => step.uses === 'actions/setup-python@v6');
  assert.equal(python.id, 'preflight_python');
  assert.deepEqual(python.with, { 'python-version': '3.11.17', 'update-environment': false });
  const npm = steps.findIndex(step => step.run?.startsWith('npm ci --ignore-scripts'));
  const pure = steps.findIndex(step => step.name?.startsWith('Pure contracts'));
  const native = steps.findIndex(step => step.name?.startsWith('One headless'));
  assert.ok(steps.indexOf(python) < npm && npm < pure && pure < native);
  assert.match(steps[pure].run, /^"\$PREFLIGHT_PYTHON" -I -S -B scripts\/native-linux-unit-start-ack.test.py$/m);
  assert.match(steps[pure].run, /^node --test scripts\/native-linux-unit-start-ack-workflow.test.cjs$/m);
  assert.equal(steps[pure]['continue-on-error'], undefined);
  assert.equal(steps[native]['continue-on-error'], undefined);
  assert.match(steps[native].run, /'\/usr\/bin\/sudo', '-n', '\/usr\/bin\/env', '-i'/);
  assert.match(steps[native].run, /for key in probe\.ENVIRONMENT/);
  assert.match(steps[native].run, /'\/usr\/bin\/python3', '-I', '-S', '-B', str\(source\), 'prepare'/);
  for (const step of steps.filter((_, index) => index !== pure)) {
    assert.doesNotMatch(step.run || '', /PREFLIGHT_PYTHON|preflight_python\.outputs/);
  }
  assert.doesNotMatch(source, /apt-get|cargo|build:unified|gh release|github-script|continue-on-error|actions: write|contents: write/);
});

test('inline scripts parse and receipt export has no product, home, wildcard or secret paths', () => {
  const steps = workflow.jobs.probe.steps;
  const runs = steps.filter(step => step.run).map(step => step.run);
  for (const command of runs) {
    assert.ok(!command.includes('${{'));
    cp.execFileSync(process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash', ['-n'],
      { input: command, encoding: 'utf8', timeout: 10000 });
  }
  const blocks = runs.flatMap(command => [...command.matchAll(/<<'PY'\n([\s\S]*?)\nPY(?:\n|$)/g)].map(m => m[1]));
  assert.equal(blocks.length, 1);
  cp.execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c',
    'import ast,json,sys\nfor source in json.load(sys.stdin): ast.parse(source, feature_version=(3,10))'],
  { input: JSON.stringify(blocks), encoding: 'utf8' });
  const upload = steps.find(step => step.uses === 'actions/upload-artifact@v4');
  assert.equal(upload.if, 'always()');
  assert.equal(upload.with.path, '/usr/lib/creator-unit-start-ack-${{ github.run_id }}-a1/report.json');
  assert.equal(upload.with.name, 'native-linux-unit-start-ack-${{ github.run_id }}-${{ github.run_attempt }}');
  assert.equal(upload.with['retention-days'], 7);
  assert.doesNotMatch(upload.with.path, /\*|\.deb|home|credential|auth\.json/);
});
