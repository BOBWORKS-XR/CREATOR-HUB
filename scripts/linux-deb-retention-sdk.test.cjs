const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { admission, exercise, seedSettings, FALSE_GATES } = require('./linux-deb-retention-sdk.cjs');

const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512',
  GITHUB_REF: 'refs/heads/validation/linux-deb-retention-014', GITHUB_EVENT_NAME: 'push', CREATOR_LINUX_DEB_RETENTION: '1' };

test('no native operation admitted outside exact Linux disposable lane', () => {
  admission(env, 'linux', 'x64');
  for (const key of Object.keys(env)) {
    const changed = { ...env }; delete changed[key];
    assert.throws(() => admission(changed, 'linux', 'x64'));
  }
  assert.throws(() => admission(env, 'win32', 'x64'));
  assert.throws(() => admission(env, 'darwin', 'x64'));
  assert.throws(() => admission({ ...env, FLATPAK_ID: 'not-native' }, 'linux', 'x64'));
});

function fixture(failure) {
  const events = []; let upgraded = false;
  const deps = {
    async connect(alias, label) {
      events.push(`connect:${label}`);
      return {
        async check() {
          events.push(`check:${label}:${upgraded ? 'after' : 'before'}`);
          if (failure === label) throw Error('SDK check failed');
          return { pid: label === 'already-live' ? 101 : 102, startTime: '500', referenceSha256: 'unchanged' };
        },
        async close() { events.push(`close:${label}`); },
      };
    },
    async snapshot(phase) {
      events.push(`snapshot:${phase}`);
      return { files: { runtime: { bytes: 1, sha256: failure === 'hash' && upgraded ? 'changed' : 'same',
        md5: 'same', mode: 493, uid: 0, gid: 0, owner: 'creator-works-mcp' } } };
    },
    async upgrade() { events.push('dpkg-upgrade'); upgraded = true; return { dpkgUpgradeCompleted: true }; },
    verifySettings() { events.push('settings-check'); },
  };
  return { deps, events };
}

test('same live client surrounds exactly one upgrade; both original aliases reconnect on each side', async () => {
  const { deps, events } = fixture(), report = { ...FALSE_GATES };
  await exercise(deps, report);
  assert.equal(events.filter(e => e === 'dpkg-upgrade').length, 1);
  const transaction = events.indexOf('dpkg-upgrade');
  assert.ok(events.indexOf('check:already-live:before') < transaction);
  assert.ok(events.indexOf('check:already-live:after') > transaction);
  for (const alias of ['node', 'node.exe']) {
    assert.ok(events.indexOf(`connect:before-${alias}`) < transaction);
    assert.ok(events.indexOf(`connect:after-${alias}`) > transaction);
  }
  assert.equal(events.at(-1), 'close:already-live');
  assert.equal(report.runtimeRetentionAccepted, true);
  assert.equal(report.packageGuiRetirementAccepted, true);
  for (const key of Object.keys(FALSE_GATES)) assert.equal(report[key], false);
});

test('failed baseline blocks upgrade; failed reconnect/hash never earns acceptance and closes owned client', async () => {
  for (const failure of ['before-node.exe', 'after-node', 'hash']) {
    const { deps, events } = fixture(failure), report = { ...FALSE_GATES };
    await assert.rejects(exercise(deps, report));
    assert.notEqual(report.runtimeRetentionAccepted, true);
    assert.equal(events.at(-1), 'close:already-live');
    if (failure === 'before-node.exe') assert.ok(!events.includes('dpkg-upgrade'));
  }
});

test('settings sentinel verifier observes actual bytes and refuses changed data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-deb-retention-test-'));
  try {
    const settings = seedSettings(root);
    assert.deepEqual(settings.verify(), settings.baseline);
    fs.appendFileSync(path.join(settings.home, '.config/creator-works-mcp/launcher-config.json'), ' ');
    assert.throws(settings.verify);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('workflow is one push-only Ubuntu job with preflight first and no secret/write/release route', () => {
  const file = fs.readFileSync(path.join(__dirname, '../.github/workflows/linux-deb-retention-014.yml'), 'utf8');
  assert.match(file, /branches: \[validation\/linux-deb-retention-014\]/);
  assert.match(file, /runs-on: ubuntu-22\.04/);
  assert.match(file, /persist-credentials: false/);
  assert.match(file, /contents: read/);
  assert.ok(file.indexOf('linux-deb-retention-probe.test.py') < file.indexOf('npm ci'));
  assert.ok(file.indexOf('linux-deb-retention-sdk.test.cjs') < file.indexOf('apt-get'));
  assert.ok(file.indexOf('linux-deb-retention-sdk.test.cjs') < file.indexOf('actions/download-artifact'));
  assert.match(file, /artifact-ids: '11929999662'/);
  assert.match(file, /run-id: '38642404016'/);
  assert.doesNotMatch(file, /matrix:|macos-|windows-|workflow_dispatch:|secrets\.|contents: write|gh release/);
});
