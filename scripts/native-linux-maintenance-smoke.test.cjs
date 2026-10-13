const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const smoke = require('./native-linux-maintenance-smoke.cjs');
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux' };

test('native Linux install harness refuses non-disposable or wrong architecture before file access', () => {
  for (const [environment, platform, arch] of [[{}, 'linux', 'x64'], [env, 'win32', 'x64'], [env, 'linux', 'arm64'],
    [{ ...env, RUNNER_ENVIRONMENT: 'self-hosted' }, 'linux', 'x64']]) {
    assert.throws(() => smoke.runner(environment, platform, arch), /disposable/i);
  }
  smoke.runner(env, 'linux', 'x64');
  const result = spawnSync(process.execPath, [require.resolve('./native-linux-maintenance-smoke.cjs'), 'deb', '/missing', '/missing-output'], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Disposable/);
});
test('only exact separately built AppImage/DEB candidates are admitted', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-linux-input-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, smoke.PINS.deb.name);
  fs.writeFileSync(file, 'wrong');
  assert.throws(() => smoke.candidate(file, 'deb'));
  assert.throws(() => smoke.candidate(file, 'rpm'), /Unsupported/);
  assert.equal(smoke.SOURCE, '6d47bd0790cfc5c3560495bbd92c37b3cd06df14');
  assert.ok(Object.isFrozen(smoke.PINS) && Object.values(smoke.PINS).every(Object.isFrozen));
});
test('native evidence cannot turn manual installer/GUI smoke into signed update acceptance', () => {
  const source = fs.readFileSync(require.resolve('./native-linux-maintenance-smoke.cjs'), 'utf8');
  assert.match(source, /releaseReady: false/);
  assert.match(source, /signedUpdateTested: false/);
  assert.match(source, /automaticRestartTested: false/);
  assert.match(source, /nativeCompanionManagementTested: false/);
  assert.doesNotMatch(source, /WEBKIT_DISABLE_SANDBOX|NODE_TLS_REJECT_UNAUTHORIZED|SIGKILL|pkill|killall|--no-sandbox/);
  assert.match(source, /wmctrl.*\['-ic'/);
});

test('manual AppImage upgrade replaces the installed file and preserves its exact before-image', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-manual-image-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = path.join(root, 'public-old'); const newer = path.join(root, 'candidate'); const installed = path.join(root, 'Hub.AppImage');
  fs.writeFileSync(old, 'old'); fs.writeFileSync(newer, 'new');
  smoke.manualImage(old, installed);
  assert.throws(() => smoke.manualImage(newer, installed));
  assert.throws(() => smoke.manualImage(newer, installed, 'a'.repeat(64)));
  smoke.manualImage(newer, installed, smoke.hash(old));
  assert.equal(fs.readFileSync(installed, 'utf8'), 'new');
  assert.equal(fs.readFileSync(`${installed}.before-update`, 'utf8'), 'old');
  assert.equal(fs.readFileSync(old, 'utf8'), 'old');
  assert.equal(fs.readFileSync(newer, 'utf8'), 'new');
});

test('crashed owned exits cannot be counted as normal close', async () => {
  await assert.rejects(smoke.closeOwned({ pid: 42, exitCode: 1 }, 'pin', () => '123', { seconds: 0.001 }), /crashed/);
  await smoke.closeOwned({ pid: 42, exitCode: 0 }, 'pin', () => { throw Error('No window needed after normal exit'); });
});

test('normal close checks owned executable and requests only its window', async () => {
  const child = { pid: 42, exitCode: null };
  const calls = [];
  await smoke.closeOwned(child, 'pin', () => '123', {
    hash: file => { calls.push(file); return 'pin'; },
    command: (exe, args) => { calls.push([exe, args]); child.exitCode = 0; },
    delay: async () => {},
  });
  assert.deepEqual(calls, ['/proc/42/exe', ['wmctrl', ['-ic', '0x7b']]]);
  child.exitCode = null;
  await assert.rejects(smoke.closeOwned(child, 'pin', () => '123', {
    hash: () => 'changed', command: () => assert.fail('No close authority'), seconds: 0.001,
  }), /identity changed/);
});

test('failed capture has normal owned cleanup and terms readiness is bounded', () => {
  const source = fs.readFileSync(require.resolve('./native-linux-maintenance-smoke.cjs'), 'utf8');
  assert.match(source, /finally \{[\s\S]*closeOwned\(child, expected, window\)/);
  assert.match(source, /snapshot = await retry\([\s\S]*if \(freshTerms\) assert\.match/);
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/linux-maintenance-validation.yml'), 'utf8');
  assert.match(workflow, /git diff --exit-code[^\n]*\bunity\b/);
});
