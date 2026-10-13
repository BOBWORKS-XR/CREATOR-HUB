const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { selectLab, discoveryScope } = require('./self-update-lab-target.cjs');
const runner = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
  HTTPS_PROXY: 'http://127.0.0.1:34567' };

test('lab target refuses local execution before reading any configuration', () => {
  assert.throws(() => selectLab('missing', {}, null, {}), /disposable GitHub-hosted/);
  const result = spawnSync(process.execPath, [require.resolve('./native-self-update-smoke.cjs')], {
    encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false', CREATOR_SELF_UPDATE_LAB_CONFIG: 'missing' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restricted to a disposable/);
  assert.doesNotMatch(result.stderr, /ENOENT|configuration path/);
});

test('lab target rejects version fixtures, relative inputs and non-owned proxy routes', () => {
  assert.throws(() => selectLab('missing', {}, {}, runner), /unmodified public baseline/);
  assert.throws(() => selectLab('missing', {}, null, runner), /absolute/);
  for (const HTTPS_PROXY of ['http://remote:34567', 'https://127.0.0.1:34567',
    'http://127.0.0.1', 'http://user:password@127.0.0.1:34567', 'http://127.0.0.1:34567/path',
    'http://127.0.0.1:34567?alias=1', 'http://127.0.0.1:34567#alias']) {
    assert.throws(() => selectLab(path.resolve('missing'), {}, null, { ...runner, HTTPS_PROXY }), /owned loopback/);
  }
});

test('lab discovery report cannot represent public publication or native baseline acceptance', () => {
  const scope = discoveryScope({ targetVersion: '0.1.13', baseline: { version: '0.1.12' }, pins: {} });
  assert.equal(scope.publicDiscovery, false);
  assert.equal(scope.labDiscovery, true);
  assert.equal(scope.releaseReady, false);
  assert.equal(scope.previousStable, '0.1.12');
  assert.equal(scope.kind, 'prepublication-signed-lab-update');
});

test('native lab driver retains exact old-app hashes, native cancel, signatures, restart and public feed path', () => {
  const source = fs.readFileSync(require.resolve('./native-self-update-smoke.cjs'), 'utf8');
  assert.match(source, /checkBaseline\(lab, installer, hub\)/);
  assert.match(source, /: await checkLive\(to.version\)/);
  assert.match(source, /assertPreviousStable\(report.feed.previousStable, from\)/);
  assert.match(source, /'button', 'Not now'/);
  assert.match(source, /'button', 'Update Hub'/);
  assert.match(source, /assert.equal\(hash\(hub\), to.exe\)/);
  assert.match(source, /Do not manually launch the replacement/);
  assert.doesNotMatch(source, /danger_accept_invalid|rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|--ignore-certificate/);
});
