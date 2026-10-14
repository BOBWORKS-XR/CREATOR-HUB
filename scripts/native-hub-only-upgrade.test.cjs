const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const h = require('./native-hub-only-upgrade.cjs');
test('hub-only contract refuses all missing/foreign context before inspection', () => {
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REF: 'refs/heads/validation/convergence-014', CREATOR_HUB_ONLY_UPGRADE_TEST: '1' };
  h.admission(env, 'win32');
  for (const key of Object.keys(env)) assert.throws(() => h.admission({ ...env, [key]: 'foreign' }, 'win32'));
  assert.throws(() => h.admission(env, 'linux'));
  const result = spawnSync(process.execPath, [path.join(__dirname, 'native-hub-only-upgrade.cjs'), 'do-not-inspect'],
    { env: { ...process.env, GITHUB_ACTIONS: 'false' }, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
});
test('only exact B04 artifacts pass and scope never supplies migration/update acceptance', () => {
  h.artifact(h.INSTALLER, h.EXECUTABLE);
  assert.throws(() => h.artifact('a'.repeat(64), h.EXECUTABLE));
  assert.throws(() => h.artifact(h.INSTALLER, 'b'.repeat(64)));
  const source = fs.readFileSync(path.join(__dirname, 'native-hub-only-upgrade.cjs'), 'utf8');
  for (const flag of ['migrationAccepted', 'signedInAppUpdateAccepted', 'nativeGuiAccepted', 'liveAiAppAccepted', 'releaseReady']) assert.ok(source.includes(`${flag}: false`));
  assert.ok(source.indexOf('admission(); requireDisposable();') < source.indexOf('candidate = path.resolve'));
  assert.ok(source.includes("['/UPDATE', '/S', '/NS']"));
  assert.doesNotMatch(source, /\.kill\(|taskkill|Stop-Process|auth\.json|signer.*sign/);
});
