const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { yaml } = require('../node_modules/playwright-core/lib/utilsBundle.js');

test('production inspection has one manually guarded Linux job and read-only API permissions', () => {
  const source = fs.readFileSync(path.join(__dirname, '../.github/workflows/native-linux-production-016.yml'), 'utf8');
  const parsed = yaml.parseDocument(source, { uniqueKeys: true });
  assert.deepEqual(parsed.errors, []);
  const workflow = parsed.toJSON();
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read' });
  assert.deepEqual(workflow.on.push.branches, ['validation/native-linux-production-016']);
  assert.deepEqual(Object.keys(workflow.jobs), ['inspect']);
  const job = workflow.jobs.inspect;
  assert.equal(job['runs-on'], 'ubuntu-22.04');
  assert.equal(job['timeout-minutes'], 10);
  for (const condition of ["github.repository == 'BOBWORKS-XR/CREATOR-HUB'", "github.repository_id == '1364807512'",
    "github.ref == 'refs/heads/validation/native-linux-production-016'", "github.event_name == 'workflow_dispatch'"]) {
    assert.ok(job.if.includes(condition));
  }
  assert.deepEqual(job.env, { CREATOR_NATIVE_LINUX_PRODUCTION_016: '1' });
  const checkout = job.steps.find(step => step.uses === 'actions/checkout@v6');
  assert.equal(checkout.with['persist-credentials'], false);
  const commands = job.steps.filter(step => step.run).map(step => step.run).join('\n');
  assert.ok(commands.indexOf('npm ci --ignore-scripts') < commands.indexOf('node --test'));
  assert.match(commands, /python3 -B scripts\/native-linux-production-016-stage.test.py/);
  assert.match(commands, /python3 -B scripts\/native-linux-production-016-stage.py/);
  assert.doesNotMatch(source, /sudo|apt-get|dpkg --install|flatpak install|build:unified|gh release|contents: write|continue-on-error/);
  const download = job.steps.findIndex(step => step.uses === 'actions/github-script@v8');
  assert.ok(download > job.steps.findIndex(step => step.run?.includes('node --test')));
  assert.equal(job.steps[download].env.PROFILE, '${{ inputs.profile }}');
  assert.match(job.steps[download].with.script, /native-linux-production-016-input.cjs/);
  const retain = job.steps.find(step => step.uses === 'actions/upload-artifact@v4');
  assert.equal(retain.if, 'always()');
  assert.doesNotMatch(retain.with.path, /assembly.zip|\.bin|\.deb|\*|credential|auth\.json/);
});
