// Source-contract simulations only: no real installers, TLS, keys, certificates or native acceptance.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const baseline = require('./self-update-baselines.cjs');
const pins = require('./prerelease-apps.json');
const source = fs.readFileSync(path.join(__dirname, 'native-self-update-smoke.cjs'), 'utf8');
const win = path.win32;

function traceSmoke({ labMode = true, fault = null, fixture = null } = {}) {
  const fails = name => Array.isArray(fault) ? fault.includes(name) : fault === name;
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
    LOCALAPPDATA: 'C:\\runner\\Local', APPDATA: 'C:\\runner\\Roaming',
    CREATOR_SELF_UPDATE_TARGET_VERSION: '0.1.13', CREATOR_SELF_UPDATE_INSTALLER_SHA256: 'c'.repeat(64),
    CREATOR_SELF_UPDATE_EXECUTABLE_SHA256: 'd'.repeat(64),
    ...(labMode ? { CREATOR_SELF_UPDATE_LAB_CONFIG: 'C:\\staged\\lab.json',
      CREATOR_SELF_UPDATE_LAB_BASELINE: 'C:\\staged\\Creator.Hub_0.1.12_x64-setup.exe' } : {}),
    ...(fixture ? { CREATOR_HOSTED_UPDATE_FIXTURE: 'fixture.json' } : {}) };
  const from = baseline.selectBaseline('0.1.13');
  const hub = win.join(env.LOCALAPPDATA, 'Creator Hub', 'creator-hub.exe');
  const apps = { setup: win.join(env.LOCALAPPDATA, 'Creator Project Setup', 'creator-project-setup.exe'),
    mcp: win.join(env.LOCALAPPDATA, 'Creator Works MCP', 'creator-works-mcp-launcher.exe') };
  const config = win.join(env.APPDATA, 'creator-works-mcp', 'launcher-config.json');
  const files = new Map(), events = [], children = [], records = [], closeCommands = [];
  const data = { oldInstaller: 'synthetic-public-12-installer', oldExe: 'synthetic-public-12-exe',
    newExe: 'synthetic-exact-13-exe', setupInstaller: 'synthetic-setup-installer', mcpInstaller: 'synthetic-mcp-installer',
    setupExe: 'synthetic-setup-exe', mcpExe: 'synthetic-mcp-exe' };
  const fakePins = new Map([[data.oldInstaller, from.installer], [data.oldExe, from.exe],
    [data.newExe, env.CREATOR_SELF_UPDATE_EXECUTABLE_SHA256], [data.setupInstaller, pins.setup.installerSha256],
    [data.mcpInstaller, pins.mcp.installerSha256], [data.setupExe, pins.setup.executableSha256], [data.mcpExe, pins.mcp.executableSha256]]);
  const put = (file, bytes) => files.set(file, Buffer.isBuffer(bytes) ? Buffer.from(bytes) : Buffer.from(String(bytes)));
  put(env.CREATOR_SELF_UPDATE_LAB_BASELINE || 'unused', data.oldInstaller);
  if (fixture) put('fixture.json', JSON.stringify(fixture));
  const companionInstallers = Object.fromEntries(['setup', 'mcp'].map(app => {
    const file = win.join('C:\\staged', pins[app].assetName);
    put(file, data[`${app}Installer`]);
    return [app, { path: file }];
  }));
  const lab = { targetVersion: '0.1.13', baseline: from,
    pins: { installer: 'c'.repeat(64), executable: 'd'.repeat(64) }, companionInstallers };
  let clock = 0, original, unrelated, upgraded = false, currentApp = null, preference = null, nextBackend = 1000, hubLaunches = 0;
  const currentPid = () => upgraded ? 202 : original?.pid || 101;
  function backend(app) {
    if (!records.some(r => r.ExecutablePath === apps[app])) records.push({ ProcessId: ++nextBackend,
      ParentProcessId: currentPid(), ExecutablePath: apps[app] });
  }
  const mockFs = {
    existsSync(file) { return files.has(file); }, mkdirSync() {},
    readFileSync(file) { assert.ok(files.has(file), `Unexpected mock read: ${file}`); return Buffer.from(files.get(file)); },
    writeFileSync(file, bytes, options) {
      if (options?.flag === 'wx') assert.ok(!files.has(file), `Mock exclusive write collision: ${file}`);
      put(file, bytes);
      if (file.endsWith('stop-unrelated-runtime')) { events.push('cooperative-runtime-stop'); if (!fails('runtime-hang')) unrelated.exitCode = 0; }
    },
  };
  const mockCrypto = { createHash() {
    let bytes;
    return { update(input) { bytes = Buffer.from(input); return this; },
      digest() { return fakePins.get(bytes.toString()) || crypto.createHash('sha256').update(bytes).digest('hex'); } };
  } };
  function nativeAction(args) {
    const action = args[args.indexOf('-Action') + 1], value = args[args.indexOf('-Value') + 1];
    if (action === 'close') { events.push('normal-owned-close'); if (!upgraded) original.exitCode = 0; return '{}'; }
    if (action !== 'button') return '{}';
    events.push(value);
    if (value === 'Not now') {
      if (fails('cancel-companion')) put(apps.mcp, 'changed-companion');
      if (fails('cancel-sentinel')) {
        const sentinel = [...files.keys()].find(file => file.endsWith('ci-self-update-sentinel.txt'));
        put(sentinel, 'changed-unmanaged-content');
      }
    }
    if (value === 'Update Hub') {
      original.exitCode = 0; upgraded = true; put(hub, data.newExe);
      records.length = 0;
      if (labMode) { backend('setup'); backend('mcp'); }
      if (fails('restart-companion')) put(apps.setup, 'changed-companion');
      if (fails('restart-storage')) preference = 'lost-storage';
      events.push('simulated-native-auto-restart');
    }
    if (value === 'Close view') {
      const index = records.findIndex(r => r.ExecutablePath === apps[currentApp]);
      assert.ok(index >= 0); records.splice(index, 1);
    }
    return '{}';
  }
  const childProcess = {
    spawn(file, args) {
      events.push(['spawn', file]);
      const child = { pid: 0, exitCode: null, unref() { events.push('unref-owned-child'); } };
      children.push(child);
      if (file === hub) { child.pid = 100 + ++hubLaunches; original = child; return child; }
      if (file === 'C:\\runtime\\node.exe') {
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); unrelated = child;
        setImmediate(() => child.stdout.emit('data', 'ready')); return child;
      }
      assert.deepEqual(Array.from(args), ['/S', '/NS']);
      for (const app of ['setup', 'mcp']) {
        if (win.basename(file) === pins[app].assetName) { put(apps[app], data[`${app}Exe`]); child.exitCode = 0; return child; }
      }
      assert.equal(files.get(file).toString(), data.oldInstaller);
      put(hub, data.oldExe); child.exitCode = 0; events.push('unmodified-12-install'); return child;
    },
    execFileSync(exe, args) {
      if (exe === 'curl.exe') {
        events.push(['curl', args.at(-1)]);
        assert.equal(labMode, false, 'Lab must not fetch baselines/companions through the five-route proxy');
        put(args[args.indexOf('--output') + 1], data.oldInstaller); return '';
      }
      if (exe === 'reg.exe') return 'DisplayVersion    REG_SZ    0.1.13';
      assert.equal(exe, 'powershell.exe');
      if (args.includes('-Command')) {
        const command = args[args.indexOf('-Command') + 1];
        if (!command.includes('CREATOR_OWNED_HUB_EXIT')) return JSON.stringify(records);
        closeCommands.push(command);
        events.push('normal-owned-close');
        if (fails('hub-close')) throw Error('Owned Hub close failed.');
        if (fails('hub-exit-hang')) throw Error('Owned Hub close timed out.');
        if (fails('hub-exit-nonzero')) throw Error('Owned Hub exit was nonzero.');
        if (!upgraded) original.exitCode = 0;
        events.push('owned-hub-exit-zero');
        return JSON.stringify({ pid: currentPid(), startTimeTicks: 'synthetic-unit-identity', exitCode: 0, normalCloseVerified: true });
      }
      const script = args[args.indexOf('-File') + 1];
      if (script.endsWith('native-window.ps1')) return nativeAction(args);
      if (script.endsWith('native-webview-policy.ps1')) {
        const action = args[args.indexOf('-Action') + 1]; events.push(action);
        if (action === 'Restore' && fails('policy-restore')) throw Error('Policy restore failed.');
        return '{}';
      }
      assert.ok(script.endsWith('native-startup-diagnostics.ps1'));
      return JSON.stringify({ listeners: [{ LocalAddress: '127.0.0.1' }],
        processes: [{ ProcessId: currentPid(), ExecutablePath: hub }] });
    },
  };
  const frame = { locator() { return { first() { return this; }, async waitFor() {}, async inputValue() { return 'Keep this draft when update is cancelled'; }, async fill() {} }; },
    async waitForFunction() {} };
  const page = {
    url() { return 'http://tauri.localhost'; }, setDefaultTimeout() {}, on() {}, async waitForFunction() {}, async screenshot() {},
    locator(selector) {
      return { async click() {
        const match = /data-view="(setup|mcp)"/.exec(selector);
        if (match) { currentApp = match[1]; backend(currentApp); }
      }, async check() {}, async fill() {}, async waitFor() {}, async screenshot() {},
      async isVisible() { return !['#usage-terms-dialog', '#hub-update-warning'].includes(selector); }, async isEnabled() { return true; },
      async innerText() { return selector === '.footer-version' ? upgraded ? '0.1.13' : '0.1.12' : 'Version 0.1.13'; },
      async elementHandle() { return { async contentFrame() { return frame; } }; } };
    },
    async evaluate(fn, value) {
      const code = String(fn);
      if (code.includes('app_inventory')) {
        events.push('public-companion-catalog');
        return { supported: true, apps: Object.keys(apps).map(app => ({ app, installed: true,
          trusted: !fails('untrusted-public-catalog'), installedVersion: pins[app].version, installedPath: apps[app] })) };
      }
      if (code.includes('hub_update_status')) return { currentVersion: '0.1.12', availableVersion: '0.1.13', installBlocked: null, warning: null };
      if (code.includes('localStorage.setItem')) { preference = value; return; }
      if (code.includes('localStorage.getItem')) return preference;
      if (code.includes('titleFits:')) return [{ titleFits: true, statusBelow: true, fits: true }];
      return {};
    },
  };
  const browser = { contexts() { return [{ pages() { return [page]; } }]; }, async close() {} };
  const labTarget = {
    selectLab(configPath, to, selectedFixture) {
      assert.equal(selectedFixture, null, 'Lab requires unmodified public baseline, not a version fixture');
      assert.equal(configPath, env.CREATOR_SELF_UPDATE_LAB_CONFIG);
      assert.equal(to.version, '0.1.13'); events.push('select-lab'); return lab;
    },
    discoveryScope() { events.push('lab-discovery'); return { previousStable: '0.1.12', labDiscovery: true, publicDiscovery: false, releaseReady: false }; },
    checkBaseline(selected, installer, executable) {
      assert.equal(selected, lab); assert.equal(files.get(installer).toString(), data.oldInstaller);
      assert.equal(files.get(executable).toString(), data.oldExe); events.push('exact-12-byte-check');
    },
  };
  const dependencies = { 'node:assert/strict': assert, 'node:fs': mockFs, 'node:path': win, 'node:crypto': mockCrypto,
    'node:child_process': childProcess, '@playwright/test': { chromium: { async connectOverCDP() { return browser; } } },
    './check-release-feed.cjs': { async checkLive() { events.push('public-discovery'); assert.equal(labMode, false); return { previousStable: '0.1.12' }; } },
    './verify-plugins-icon.cjs': { async verifyPluginsIcon() { return { syntheticUnitFixture: true }; } },
    './self-update-baselines.cjs': baseline, './self-update-lab-target.cjs': labTarget, './prerelease-apps.json': pins,
    '../package.json': { version: '0.1.13' } };
  put('src/icons/creator-plugins.png', 'synthetic-icon');
  const processMock = { env, execPath: 'C:\\runtime\\node.exe', exitCode: undefined };
  const completion = vm.runInNewContext(source, { Buffer, Date: class extends Date { static now() { clock += 100; return clock; } },
    process: processMock, console: { log() {} },
    setTimeout(callback, ms) { clock += ms; return setImmediate(callback); },
    require(name) { assert.ok(Object.hasOwn(dependencies, name), `Forbidden source-test import: ${name}`); return dependencies[name]; } },
  { timeout: 1000 });
  return { completion, events, files, closeCommands, process: processMock, from, report() {
    const entry = [...files].find(([file]) => file.endsWith('self-update-report.json'));
    assert.ok(entry, 'Mock driver must retain its report'); return JSON.parse(entry[1]);
  } };
}

test('lab trace retains unmodified old12, native cancel/approval, automatic restart and separate installed companions', async () => {
  const trace = traceSmoke(); await trace.completion;
  const report = trace.report();
  assert.equal(report.passed, true);
  assert.equal(report.sourceKind, 'unmodified-public-stable');
  assert.deepEqual(report.from, baseline.selectBaseline('0.1.13'));
  assert.equal(report.publicDiscovery, false); assert.equal(report.labDiscovery, true); assert.equal(report.releaseReady, false);
  assert.equal(report.discoveryKind, 'controlled-lab-not-public-discovery');
  assert.ok(trace.events.indexOf('exact-12-byte-check') > trace.events.indexOf('unmodified-12-install'));
  assert.ok(trace.events.indexOf('Not now') < trace.events.indexOf('Update Hub'));
  assert.equal(report.originalPid, 102); assert.equal(report.restartedPid, 202); assert.equal(report.originalExitCode, 0);
  assert.equal(report.publicCompanionCatalog.verifiedByUnmodifiedBaseline, true);
  assert.equal(report.publicCompanionCatalog.baselinePid, 101);
  assert.ok(report.companionPreservation['native-cancel']); assert.ok(report.companionPreservation['automatic-restart']);
  assert.equal(Object.keys(report.companionPreservation['automatic-restart'].installs).length, 2);
  assert.equal(trace.events.filter(e => Array.isArray(e) && e[0] === 'spawn' && e[1].endsWith('creator-hub.exe')).length, 2);
  assert.ok(!trace.events.includes('public-discovery'));
  assert.ok(trace.events.includes('Restore') && trace.events.includes('cooperative-runtime-stop'));
  assert.equal(report.cleanup.passed, true);
  assert.equal(report.hubShutdown.pid, report.restartedPid);
  assert.equal(report.hubShutdown.exitCode, 0);
  assert.equal(report.hubShutdown.normalCloseVerified, true);
  assert.ok(trace.events.indexOf('owned-hub-exit-zero') < trace.events.indexOf('Restore'));
  assert.ok(!JSON.stringify(report.checks).includes('signed public target'));
  assert.equal(report.managedRouteReconnectTested, undefined);
});

test('untrusted public companion catalog prevents the signed lab from reaching approval', async () => {
  const trace = traceSmoke({ fault: 'untrusted-public-catalog' }); await trace.completion;
  const report = trace.report();
  assert.equal(report.passed, false);
  assert.match(report.error, /authenticate each installed companion/);
  assert.ok(!trace.events.includes('Update Hub'));
});

test('non-lab public acceptance still uses checkLive and the unchanged public baseline download path', async () => {
  const trace = traceSmoke({ labMode: false }); await trace.completion;
  const report = trace.report();
  assert.equal(report.passed, true); assert.equal(report.publicDiscovery, true); assert.equal(report.labDiscovery, false);
  assert.ok(trace.events.includes('public-discovery'));
  assert.ok(trace.events.some(e => Array.isArray(e) && e[0] === 'curl' && e[1].endsWith('/v0.1.12/Creator.Hub_0.1.12_x64-setup.exe')));
});

for (const fault of ['cancel-companion', 'cancel-sentinel', 'restart-companion', 'restart-storage']) {
  test(`lab trace fails ${fault}, retains failure and never admits release/public discovery`, async () => {
    const trace = traceSmoke({ fault }); await trace.completion;
    const report = trace.report();
    assert.equal(report.passed, false); assert.equal(report.selfUpdateTested, false);
    assert.equal(report.publicDiscovery, false); assert.equal(report.releaseReady, false);
    assert.ok(report.error); assert.equal(trace.process.exitCode, 1);
    assert.ok(trace.events.includes('Restore') && trace.events.includes('normal-owned-close'));
    assert.ok(trace.events.includes('Not now'), 'Reach the native cancel gate before applying the requested fault');
    if (fault.startsWith('cancel-')) assert.ok(!trace.events.includes('Update Hub'));
    else assert.ok(trace.events.includes('Update Hub') && report.restartedPid === 202);
    if (fault.endsWith('companion')) assert.match(report.error, /Separate companion executable changed/);
  });
}

for (const fault of ['hub-close', 'hub-exit-hang', 'hub-exit-nonzero', 'policy-restore', 'runtime-hang']) {
  test(`completed functional update cannot pass failed cleanup: ${fault}`, async () => {
    const trace = traceSmoke({ fault }); await trace.completion;
    const report = trace.report();
    assert.equal(report.selfUpdateTested, true, 'Retain the completed functional update separately');
    assert.equal(report.hostedViewsUpdateTested, true);
    assert.equal(report.passed, false); assert.equal(report.cleanup.passed, false);
    assert.equal(report.releaseReady, false); assert.equal(trace.process.exitCode, 1);
    assert.ok(report.cleanup.errors.length);
    assert.equal(report.error, undefined, 'Cleanup must not manufacture/replace a primary error');
    assert.ok(trace.events.includes('Restore') && trace.events.includes('cooperative-runtime-stop'));
    if (fault.startsWith('hub-')) {
      assert.equal(report.hubShutdown, undefined);
      assert.equal(report.cleanup.errors[0].phase, 'hub-close');
      assert.equal(report.cleanup.disposableJobTeardownRequired, true);
    }
  });
}

test('cleanup failure retains the original storage failure and adds separate teardown evidence', async () => {
  const trace = traceSmoke({ fault: ['restart-storage', 'hub-close'] }); await trace.completion;
  const report = trace.report();
  assert.equal(report.passed, false); assert.equal(report.cleanup.passed, false);
  assert.match(report.error, /lost-storage/);
  assert.match(report.cleanup.errors[0].message, /Owned Hub close failed/);
  assert.equal(report.cleanup.errors[0].phase, 'hub-close');
  assert.equal(trace.process.exitCode, 1);
});

test('owned close command parses without executing any native action and holds its handle before close', async t => {
  const trace = traceSmoke(); await trace.completion;
  const command = trace.closeCommands[0];
  assert.ok(command.indexOf('[void]$owned.Handle') < command.indexOf('-Action close'));
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    "$tokens=$null; $errors=$null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(),[ref]$tokens,[ref]$errors); if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }"], {
    input: command, env: { ...process.env, GITHUB_ACTIONS: 'false' }, encoding: 'utf8', timeout: 10000, windowsHide: true,
  });
  if (result.error?.code === 'ENOENT') { t.skip('Existing PowerShell 7 parser unavailable; no provisioning'); return; }
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('lab and version-only fixture cannot combine or override immutable old12 pins', () => {
  assert.throws(() => traceSmoke({ fixture: { testOnly: true, fromVersion: '0.1.12', toVersion: '0.1.13',
    installerSha256: 'a'.repeat(64), executableSha256: 'b'.repeat(64) } }), /unmodified public baseline/);
  assert.equal(baseline.selectBaseline('0.1.13').exe, '34c6f05548f469ac23b4faee7aa8355d5cca083c444c4f7b0942426a9c76a7ac');
});

test('maintenance driver uses only classic separate-app routes and preserves native integrity/consent guards', () => {
  for (const statement of ['assert.equal(hash(installer), from.installer);', 'assert.equal(hash(hub), from.exe);',
    'checkBaseline(lab, installer, hub)', 'assert.equal(hash(sentinel), sentinelHash);',
    "preserveCompanions('native-cancel')", "preserveCompanions('automatic-restart')",
    'await retry(() => assert.equal(hash(hub), to.exe), 180);', 'Do not manually launch the replacement',
    "localStorage.getItem('creator-hub.ci-self-update')", "DisplayVersion\\s+REG_SZ", 'report.hubShutdown = closeOwnedHub()']) {
    assert.ok(source.includes(statement), `Missing original maintenance safeguard: ${statement}`);
  }
  assert.doesNotMatch(source, /native-managed-target|checkUpdatedBuiltIns|managedLocations|Enable managed routing|managedRouteReconnectTested|@modelcontextprotocol\/sdk/);
  assert.match(source, /ParentProcessId === ownedPid/);
  assert.match(source, /ExpectedExecutable/);
  assert.match(source, /if \(!fixture && !lab\) execFileSync\('curl.exe'/);
  assert.match(source, /if \(!lab\) execFileSync\('curl.exe'/);
  assert.match(source, /Synthetic disposable test acknowledged/);
  assert.match(source, /GetProcessById\(\$\{ownedPid\}\)/);
  assert.match(source, /\$owned\.MainModule\.FileName/);
  assert.match(source, /\$owned\.WaitForExit\(30000\)/);
  assert.match(source, /\$owned\.ExitCode -ne 0/);
  assert.match(source, /cleanupFailed\('hub-close', error\)/);
  assert.doesNotMatch(source, /taskkill|Stop-Process|\.Kill\(|\.kill\(/);
  assert.doesNotMatch(source, /rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|--ignore-certificate|signer.*sign/);
  const consumer = fs.readFileSync(path.join(__dirname, '../src-tauri/src/self_update.rs'), 'utf8');
  assert.match(consumer, /verify_signed|verify_signature|Signature::decode/);
  assert.match(consumer, /update\.install\(bytes\)/);
});

test('public signature fixture and lab workflow bind the exact installed maintenance payload, never raw or unified bytes', () => {
  const directory = path.join(__dirname, '../tests/fixtures/maintenance-signed-update');
  const hashes = {
    'creator-hub-windows-x86_64.json': '8e937241dc55a1871f1eff2a447c8797a1092e9209b8a9e760771772f43eb971',
    'creator-hub-windows-x86_64.json.minisig': '4badb69f01275b7616db9c0cf95826cafcc54ae63d69004a65d8b515bc5b8c2b',
    'latest.json': '017287c53c3616bc1b3477c7a3631362714818098f030a8cce8dd94e642c59fd',
  };
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/maintenance-signed-update-lab.yml'), 'utf8');
  for (const [name, expected] of Object.entries(hashes)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex'), expected);
    assert.ok(workflow.includes(expected));
  }
  const descriptor = JSON.parse(fs.readFileSync(path.join(directory, 'creator-hub-windows-x86_64.json'), 'utf8'));
  assert.equal(descriptor.appId, 'creator-hub');
  assert.equal(descriptor.version, '0.1.13');
  assert.equal(descriptor.installerProtocol, 1);
  assert.equal(descriptor.sha256, 'bbdc390ba49526c9bdd40efa373c7e7d292b68ebe7209fb31aa4c833bc2805cb');
  assert.equal(descriptor.executableSha256, '2b2c8f5014d121f7ef408caab6626d14dc73b9f716b321ec9c1177ebe5c4a3ca');
  assert.ok(workflow.includes(descriptor.executableSha256) && workflow.includes(descriptor.sha256));
  assert.match(workflow, /actions: read/);
  assert.doesNotMatch(workflow, /contents: write|secrets\.|SIGNING_KEY_PATH|signer sign|gh release|git tag/);
  assert.match(workflow, /hostedViewsUpdateTested -ne \$true/);
  assert.match(source, /warmPublicCompanionCatalog\(\)/);
  assert.doesNotMatch(source, /writeFileSync[^\n]*catalog/);
});
