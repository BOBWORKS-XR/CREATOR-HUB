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
  assert.equal(events.at(-2), 'close:already-live');
  assert.equal(events.at(-1), 'settings-check');
  assert.equal(report.settingsSentinelsPreserved, true);
  assert.equal(report.runtimeRetentionAccepted, true);
  assert.equal(report.packageGuiRetirementAccepted, true);
  for (const key of Object.keys(FALSE_GATES)) assert.equal(report[key], false);
});

test('failed baseline blocks upgrade; failed reconnect/hash never earns acceptance and closes owned client', async () => {
  for (const failure of ['before-node.exe', 'after-node', 'hash']) {
    const { deps, events } = fixture(failure), report = { ...FALSE_GATES };
    await assert.rejects(exercise(deps, report));
    assert.notEqual(report.runtimeRetentionAccepted, true);
    assert.equal(events.at(-2), 'close:already-live');
    assert.equal(events.at(-1), 'settings-check');
    if (failure === 'before-node.exe') assert.ok(!events.includes('dpkg-upgrade'));
  }
});

test('connect, upgrade, close and final preservation failures never earn retention acceptance', async () => {
  for (const phase of ['connect', 'upgrade', 'close', 'settings']) {
    const { deps, events } = fixture();
    const original = new Error(`${phase} failed`);
    if (phase === 'connect') deps.connect = async () => { throw original; };
    if (phase === 'upgrade') deps.upgrade = async () => { events.push('refused-upgrade'); throw original; };
    if (phase === 'close') {
      const connect = deps.connect;
      deps.connect = async (...args) => {
        const client = await connect(...args);
        if (args[1] === 'already-live') client.close = async () => { events.push('close:already-live'); throw original; };
        return client;
      };
    }
    let checks = 0;
    deps.verifySettings = () => {
      events.push('settings-check');
      if (phase === 'settings' && ++checks === 3) throw original;
      return { sentinel: 'same' };
    };
    const report = { ...FALSE_GATES };
    await assert.rejects(exercise(deps, report), error => error === original);
    assert.notEqual(report.runtimeRetentionAccepted, true);
    assert.notEqual(report.packageGuiRetirementAccepted, true);
    assert.equal(report.settingsSentinelsPreserved, phase !== 'settings');
    assert.equal(events.at(-1), 'settings-check');
    assert.ok(events.filter(event => event === 'dpkg-upgrade').length <= 1);
    assert.ok(events.filter(event => event === 'refused-upgrade').length <= 1);
    for (const key of Object.keys(FALSE_GATES)) assert.equal(report[key], false);
  }
});

test('upgrade refusal is retained when owned close and settings checks also fail', async () => {
  const { deps } = fixture();
  const original = new Error('Original upgrade refusal');
  const connect = deps.connect;
  deps.connect = async (...args) => {
    const client = await connect(...args);
    if (args[1] === 'already-live') client.close = async () => { throw new Error('Secondary close failure'); };
    return client;
  };
  let attempted = false;
  deps.upgrade = async () => { attempted = true; throw original; };
  deps.verifySettings = () => { if (attempted) throw new Error('Secondary settings failure'); };
  const report = { ...FALSE_GATES };
  await assert.rejects(exercise(deps, report), error => error === original);
  assert.match(report.closeError, /Secondary close failure/);
  assert.match(report.settingsError, /Secondary settings failure/);
  assert.equal(report.settingsSentinelsPreserved, false);
  assert.notEqual(report.runtimeRetentionAccepted, true);
  assert.notEqual(report.packageGuiRetirementAccepted, true);
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

test('settings fixture covers the source-defined Setup store, MCP recovery store and selected project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-deb-stores-test-'));
  try {
    const settings = seedSettings(root);
    const stores = fs.readFileSync(path.join(__dirname, '../native/convergence-store.rs'), 'utf8');
    for (const relative of ['CreatorProjectSetup/editor-roots.json', 'creator-works-mcp/hosted-operation-outcomes.json']) {
      assert.ok(stores.includes(relative), relative);
      const base = relative.startsWith('CreatorProjectSetup/') ? settings.data : settings.config;
      assert.ok(fs.existsSync(path.join(base, relative)), relative);
    }
    const current = JSON.parse(fs.readFileSync(path.join(settings.config, 'creator-works-mcp/launcher-config.json')));
    assert.equal(typeof current.auto_start, 'boolean');
    assert.equal(current.mcp_server_path, '/usr/lib/Creator Works MCP/server/creator-works-mcp.mjs');
    assert.equal(current.channels.length, 1);
    assert.equal(current.channels[0].id, current.active_channel_id);
    assert.equal(current.channels[0].unity_project_path, path.join(settings.home, 'project'));
    assert.deepEqual(settings.verify(), settings.baseline);
    fs.appendFileSync(path.join(settings.data, 'CreatorProjectSetup/editor-roots.json'), ' ');
    assert.throws(settings.verify);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('settings fixture preserves the actual Hub local-data preferences store and unknown fields', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-deb-hub-prefs-test-'));
  try {
    const settings = seedSettings(root);
    const prefsSource = fs.readFileSync(path.join(__dirname, '../src-tauri/src/preferences.rs'), 'utf8');
    const managerSource = fs.readFileSync(path.join(__dirname, '../src-tauri/src/manager.rs'), 'utf8');
    assert.ok(/manager::child_dir\("preferences"\)\?\.join\("hub-preferences\.json"\)/.test(prefsSource), 'Source-defined preference child/filename');
    assert.ok(/fn root\(\)[^{]*\{[^}]*dirs::data_local_dir\(\)[^}]*\.join\("CreatorHub"\)/.test(managerSource), 'Native Hub local-data root');
    assert.ok(/fn child_dir\([^\n]*\)[^{]*\{[^}]*root\(\)\?\.join\(name\)/.test(managerSource), 'Native child directory joins the Hub root');
    const relative = '.local/share/CreatorHub/preferences/hub-preferences.json';
    assert.ok(Object.hasOwn(settings.baseline, relative), relative);
    assert.equal(Object.keys(settings.baseline).length, 11);
    assert.ok(Object.hasOwn(settings.baseline, '.config/creator-hub/preferences.json'), 'Keep the old extra sentinel too');
    const target = path.join(settings.data, 'CreatorHub/preferences/hub-preferences.json');
    const bytes = fs.readFileSync(target);
    const prefs = JSON.parse(bytes);
    assert.deepEqual(prefs, { schemaVersion: 1, preview: true, autoDownload: false, restoreHostedViews: true,
      unknownRetentionField: { keep: 'hub-real-store-retain-exact' } });
    // The unknown-field variant represents a future/unsupported record that Hub
    // refuses. This retirement-only test checks byte preservation, not valid GUI
    // preference acceptance, despite the other fields matching today's schema.
    assert.match(prefsSource, /rename_all = "camelCase", deny_unknown_fields/);
    assert.deepEqual(settings.verify(), settings.baseline);
    fs.writeFileSync(target, JSON.stringify({ ...prefs, unknownRetentionField: { keep: 'changed' } }));
    assert.throws(settings.verify);
  } finally { fs.rmSync(root, { recursive: true }); }
});

test('settings verifier rejects replacement with identical bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linux-deb-replaced-test-'));
  try {
    const settings = seedSettings(root);
    const target = path.join(settings.home, '.config/creator-works-mcp/launcher-config.json');
    const bytes = fs.readFileSync(target);
    fs.renameSync(target, target + '.original');
    fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
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
