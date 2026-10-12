const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { baselines } = require('./native-installed-baseline.cjs');

test('installed candidate helper refuses local and self-hosted runners before filesystem access', () => {
  for (const env of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted', RUNNER_OS: 'Windows' }]) {
    const result = spawnSync(process.execPath, ['-e', "require('./scripts/native-installed-baseline.cjs').install('upgrade','missing','missing')"], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restricted to a disposable GitHub-hosted Windows runner/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  }
});
test('installed acceptance pins all three public installers and separates direct install from signed update', () => {
  assert.deepEqual(baselines.map(b => b.version), ['0.1.12', '2.7.7', '0.3.7']);
  for (const baseline of baselines) assert.match(baseline.sha256, /^[a-f0-9]{64}$/);
  const source = fs.readFileSync(path.join(__dirname, 'native-installed-baseline.cjs'), 'utf8');
  assert.match(source, /not signed in-app updater acceptance/);
  assert.ok(source.indexOf('seedBeforeInstall();') < source.indexOf("execFileSync(installer, ['/S']", source.indexOf('seedBeforeInstall();')));
});
