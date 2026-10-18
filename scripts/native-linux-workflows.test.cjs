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
        for (const block of step.run.matchAll(/^(?:\/usr\/bin\/)?python3 -B - <<'PY'\n([\s\S]*?)^PY\s*$/gm)) {
          const parsed = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
            ['-B', '-c', 'import ast,sys; ast.parse(sys.stdin.read())'],
            { input: block[1], encoding: 'utf8', windowsHide: true, timeout: 5000, shell: false });
          assert.equal(parsed.status, 0, `${step.name} Python: ${parsed.stderr || parsed.error?.message}`);
        }
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
test('39106292475 runner-only polkit hardening is fixed, guarded and never relaxes app ownership checks', () => {
  const body = fs.readFileSync(path.join(__dirname, '../.github/workflows/native-linux-components-014.yml'), 'utf8');
  const job = yaml.parse(body).jobs.components;
  const step = job.steps.find(s => s.name?.startsWith('Secure the hosted-runner'));
  assert.equal(step.if, "github.ref == 'refs/heads/validation/linux-current-components-014'");
  assert.match(step.run, /mode in \(0o755, 0o777\)/);
  assert.match(step.run, /\['\/usr\/bin\/sudo', '-n', '\/usr\/bin\/chmod', '0755', str\(target\)\]/);
  assert.match(step.run, /after.st_ino/);
  assert.match(step.run, /applicationRepair': False/);
  assert.match(step.run, /'\/usr\/share', '\/usr\/share\/polkit-1', '\/usr\/share\/polkit-1\/actions'/);
  assert.match(step.run, /recursiveChange': False/);
  assert.doesNotMatch(step.run, /auth_admin|allow_active|chmod.*777|pkexec|polkit.addRule|rm -/);
  const root = fs.readFileSync(path.join(__dirname, 'native-linux-root-probe.py'), 'utf8');
  assert.match(root, /info.st_uid == info.st_gid == 0 and not info.st_mode & 0o7022/);
});
test('Linux helper fixture source changes trigger focused native checks before packaging', () => {
  const workflow = yaml.parse(fs.readFileSync(path.join(__dirname,
    '../.github/workflows/linux-deb-helper-fixtures-014.yml'), 'utf8'), { uniqueKeys: true });
  assert.deepEqual(workflow.on.push.branches, ['validation/linux-deb-helper-fixtures-014']);
  for (const file of ['native/linux-deb-retirement/**', 'scripts/linux-deb-helper-fixtures-probe.py',
    'scripts/linux-deb-helper-fixtures.test.py', 'scripts/linux-deb-helper-native-check.sh', 'scripts/linux-deb-helper.test.cjs']) {
    assert.ok(workflow.on.push.paths.includes(file), file);
  }
  const job = workflow.jobs['helper-fixtures'];
  assert.equal(job['runs-on'], 'ubuntu-22.04');
  const body = job.steps.find(step => step.run).run;
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/usr/bin/bash';
  const parsed = spawnSync(bash, ['-n'], { input: body, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(parsed.status, 0, parsed.stderr || parsed.error?.message);
  assert.match(body, /python3 -B scripts\/linux-deb-helper-fixtures-probe\.py/);
});
