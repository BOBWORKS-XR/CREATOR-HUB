const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('real suite install test refuses local and self-hosted machines before reading pins or paths', () => {
  for (const env of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted', RUNNER_OS: 'Windows' }]) {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'native-suite-smoke.cjs')], {
      encoding: 'utf8', windowsHide: true, timeout: 10000,
      env: { ...process.env, ...env },
    });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /restricted to a disposable GitHub-hosted Windows runner/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  }
});

test('test browser policy refuses local and self-hosted machines before accessing files or registry', { skip: process.platform !== 'win32' }, () => {
  for (const env of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted', RUNNER_OS: 'Windows' }]) {
    for (const action of ['Enable', 'Restore']) {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-File', path.join(__dirname, 'native-webview-policy.ps1'), '-Action', action, '-StateFile', 'not-an-owned-receipt.json'], {
        encoding: 'utf8', windowsHide: true, timeout: 10000,
        env: { ...process.env, ...env },
      });
      assert.ifError(result.error);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /restricted to a disposable GitHub-hosted Windows runner/);
      assert.doesNotMatch(result.stderr, /Cannot find path|UnauthorizedAccess|Invalid test policy receipt/);
    }
  }
});
