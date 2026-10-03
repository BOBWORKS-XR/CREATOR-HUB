const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('native lifecycle driver refuses local execution before launching any app', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'smoke-native-lifecycle-ci.cjs')], {
    encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '', RUNNER_ENVIRONMENT: '', RUNNER_OS: '' }, timeout: 15000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /requires a disposable GitHub-hosted Windows runner/);
});
