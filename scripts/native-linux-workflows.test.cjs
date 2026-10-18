// Parse before dispatch; never execute workflow bodies or contact GitHub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { yaml } = require('playwright-core/lib/utilsBundle');
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const workflows = ['native-linux-components-014.yml', 'linux-installed-candidate-014.yml',
  'linux-outer-update-fixture-014.yml', 'flatpak-installed-host-launch-014.yml'];
for (const name of workflows) test(`Linux preflight: ${name} YAML, Bash and embedded JS syntax`, () => {
  const body = fs.readFileSync(path.join(__dirname, '../.github/workflows', name), 'utf8');
  const workflow = yaml.parse(body, { uniqueKeys: true });
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/usr/bin/bash';
  assert.ok(fs.existsSync(bash));
  let shellCount = 0, jsCount = 0;
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job['runs-on'], 'ubuntu-22.04');
    for (const step of job.steps) {
      if (step.run) {
        const result = spawnSync(bash, ['-n'], { input: step.run, encoding: 'utf8', windowsHide: true,
          timeout: 5000, maxBuffer: 16384, shell: false });
        assert.equal(result.status, 0, `${step.name}: ${result.stderr || result.error?.message}`);
        shellCount++;
      }
      if (step.with?.script) {
        new AsyncFunction('github', 'context', step.with.script);
        jsCount++;
      }
    }
  }
  assert.ok(shellCount >= 3, 'Every native workflow must actually have its run bodies parsed');
  if (name !== 'flatpak-installed-host-launch-014.yml') assert.ok(jsCount >= 1);
});
