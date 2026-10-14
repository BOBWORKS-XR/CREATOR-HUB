const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'native-builtin-smoke.cjs'), 'utf8');
const start = source.indexOf('async function deferStartupConvergence(');
const end = source.indexOf('\n(async () => {', start);
assert.ok(start > 0 && end > start, 'The bounded startup helper must precede the native runner');
const helper = source.slice(start, end);
const retrySource = source.slice(source.indexOf('async function retry('), source.indexOf('function registrations()'));
const deferStartupConvergence = vm.runInThisContext(`(assert, delay) => { ${retrySource}\n${helper}\nreturn deferStartupConvergence; }`)(assert, async () => {});
const review = changes => ({ enabled: true, required: true, stage: 'review', backups: [],
  settings: ['conflicting retained current/legacy settings; custom server'],
  legacyApps: [{ name: 'Creator Works MCP', path: 'C:/fixture/launcher.exe' }], ...changes });

function fixture({ supported = true, reports = [review(), review()], open = true, preserve = () => {} } = {}) {
  const calls = [], clicks = [], waits = [], preserved = [];
  const window = { CreatorHubNative: { convergencePersistence: supported, async invoke(command) {
    assert.equal(command, 'convergence_status', 'The component startup can only read convergence status');
    calls.push(command);
    const result = reports[calls.length - 1];
    if (result instanceof Error) throw result;
    if (result?.rejection) throw result.rejection;
    return result;
  } } };
  const page = {
    async evaluate(callback) {
      const result = await vm.runInNewContext(`(${callback})()`, { window });
      return result === undefined ? undefined : JSON.parse(JSON.stringify(result));
    },
    locator(selector) {
      assert.ok(['#convergence-dialog', '#convergence-later'].includes(selector), 'No prepare/migrate/retire control may be used');
      return {
        async waitFor({ state }) {
          assert.equal(selector, '#convergence-dialog');
          assert.equal(open, state === 'visible');
          waits.push(state);
        },
        async isVisible() { assert.equal(selector, '#convergence-dialog'); return open; },
        async click() {
          assert.equal(selector, '#convergence-later'); assert.equal(open, true);
          clicks.push(selector); open = false;
        },
      };
    },
  };
  return { page, calls, clicks, waits, preserved, verify(phase) { preserved.push(phase); preserve(phase); } };
}

test('required first-launch guide chooses Later once and leaves conflicting/custom settings for component checks', async () => {
  const f = fixture();
  const result = await deferStartupConvergence(f.page, f.verify);
  assert.equal(result.status, 'deferred'); assert.equal(result.migrationSkipped, true); assert.equal(result.releaseReady, false);
  assert.deepEqual(f.calls, ['convergence_status', 'convergence_status']);
  assert.deepEqual(f.clicks, ['#convergence-later']); assert.deepEqual(f.waits, ['visible', 'hidden']);
  assert.deepEqual(f.preserved, ['Before Convergence Later', 'After Convergence Later']);
});

test('fresh profile without a required guide never clicks a migration control', async () => {
  const f = fixture({ reports: [review({ required: false }), review({ required: false })], open: false });
  const result = await deferStartupConvergence(f.page, f.verify);
  assert.equal(result.status, 'not-required'); assert.equal(result.migrationSkipped, true); assert.equal(result.releaseReady, false);
  assert.deepEqual(f.clicks, []); assert.deepEqual(f.waits, []);
  assert.deepEqual(f.preserved, ['After Convergence Later']);
});

test('older candidate without the protocol does no convergence read or DOM work', async () => {
  const f = fixture({ supported: false });
  f.page.locator = () => assert.fail('Old candidates have no convergence modal contract');
  const result = await deferStartupConvergence(f.page, f.verify);
  assert.equal(result.status, 'unsupported'); assert.equal(result.migrationSkipped, true); assert.equal(result.releaseReady, false);
  assert.deepEqual(f.calls, []); assert.deepEqual(f.preserved, ['Startup without Convergence protocol']);
});

test('inspection refusal remains an explicit deferral, never a migration success', async () => {
  const f = fixture({ reports: [Error('Retained legacy settings require inspection'), Error('Retained legacy settings require inspection')] });
  const result = await deferStartupConvergence(f.page, f.verify);
  assert.equal(result.status, 'deferred'); assert.equal(result.releaseReady, false);
  assert.deepEqual(f.clicks, ['#convergence-later']); assert.equal(f.calls.length, 2);
});

test('startup lease contention retries only the exact busy response without repeating the Later click', async () => {
  const f = fixture({ reports: [{ rejection: 'Another Hub operation is already running.' }, review(), review()] });
  const result = await deferStartupConvergence(f.page, f.verify);
  assert.equal(result.status, 'deferred'); assert.equal(f.calls.length, 3);
  assert.deepEqual(f.clicks, ['#convergence-later']);
});

test('missing native report is not treated as an unrequired guide', async () => {
  const f = fixture({ reports: [undefined] });
  await assert.rejects(deferStartupConvergence(f.page, f.verify), /report or an inspection error/);
  assert.deepEqual(f.clicks, []);
});

for (const changes of [{ stage: 'backed-up' }, { stage: 'complete' }, { backups: ['invented.bak'] }, { required: 'true' }, { enabled: false }]) {
  test(`unexpected initial guide state refuses before clicking: ${JSON.stringify(changes)}`, async () => {
    const f = fixture({ reports: [review(changes)] });
    await assert.rejects(deferStartupConvergence(f.page, f.verify));
    assert.deepEqual(f.clicks, []); assert.equal(f.calls.length, 1);
  });
}

test('changed native stage after Later fails instead of reporting skipped migration', async () => {
  const f = fixture({ reports: [review(), review({ stage: 'backed-up' })] });
  await assert.rejects(deferStartupConvergence(f.page, f.verify), /Later must not prepare, migrate or retire/);
  assert.deepEqual(f.clicks, ['#convergence-later']);
});

test('before-image failure prevents dismissal; after-image failure prevents component success', async () => {
  for (const phase of ['Before Convergence Later', 'After Convergence Later']) {
    const f = fixture({ preserve: actual => { if (actual === phase) throw Error('Fixture preservation mismatch'); } });
    await assert.rejects(deferStartupConvergence(f.page, f.verify), /Fixture preservation mismatch/);
    assert.equal(f.clicks.length, phase.startsWith('Before') ? 0 : 1);
  }
});

test('startup source defers after terms and before inventory/navigation without injecting guide decisions', () => {
  const terms = source.indexOf("await page.locator('#usage-terms-dialog').waitFor({ state: 'hidden' })");
  const defer = source.indexOf('report.convergence = await deferStartupConvergence(page, verifyStartupPreserved)');
  const inventory = source.indexOf('const inventory = await retry');
  const navigation = source.indexOf("await page.locator('#hub-pages");
  assert.ok(terms > 0 && terms < defer && defer < inventory && inventory < navigation);
  assert.doesNotMatch(helper, /invoke\(['"](?:prepare_convergence|migrate_convergence_connections|retire_convergence_apps|refresh_convergence)/);
  assert.doesNotMatch(helper, /locator\(['"]#convergence-(?:prepare|connections|retire|refresh)|\.dispatchEvent|localStorage|__TAURI__|showModal|\.close\(/);
  assert.match(helper, /convergencePersistence === true/);
  assert.match(source, /scope: 'component-built-in-smoke-not-guide-acceptance', releaseReady: false/);
  assert.match(source, /Convergence .*migration skipped; retained settings, clients and registrations unchanged \(component checks only\)/);
  assert.match(source, /console\.log\(`Native component smoke/);
});

test('source keeps settings/client/registration checks and absent prepare/retire artifacts around startup', () => {
  const begin = source.indexOf('const registrationBefore = registrationSnapshot()');
  const end = source.indexOf("webviewPolicy('Enable')", begin);
  const preservation = source.slice(begin, end);
  assert.match(preservation, /assert\.deepEqual\(settingsBytes\(\), oldConfig/);
  assert.match(preservation, /verifyRetainedStores\(phase\)/);
  assert.match(preservation, /for \(const client of legacyClients\).*client\.content/);
  assert.match(preservation, /assert\.deepEqual\(registrationSnapshot\(\), registrationBefore/);
  assert.match(preservation, /for \(const file of convergenceOutputs\).*fs\.existsSync\(file\), false/);
  for (const artifact of ['review-v1.json', 'legacy-retirement', '.creator-hub-settings-backups', '.creator-hub-product-settings', 'hosted-operation-outcomes.json', 'managedLocations(process.env.LOCALAPPDATA).active']) {
    assert.ok(preservation.includes(artifact), artifact);
  }
  assert.match(preservation, /verifyStartupPreserved\('Before Hub startup'\)/);
  const snapshot = source.slice(source.indexOf('function registrationSnapshot()'), source.indexOf('async function backendFor('));
  assert.match(snapshot, /GetValueKind/); assert.match(snapshot, /DoNotExpandEnvironmentNames/);
  assert.match(snapshot, /\$ErrorActionPreference='Stop'/);
  assert.match(snapshot, /timeout: 15000, maxBuffer: 65536/);
  assert.doesNotMatch(snapshot, /Set-Item|Remove-Item|reg(?:\.exe)?\s+(?:add|delete)/i);
  assert.match(source, /mcp_server_path: 'C:\/old-install\/banter-mcp\.mjs'/);
  assert.match(source, /legacySetting.*current settings win/);
  assert.match(source, /native\(pid, executable, 'button', 'Keep existing'\)/);
  assert.match(source, /restricted to a disposable GitHub-hosted Windows runner/);
});

test('registration snapshot only captures bounded known-key values/types without inspecting real registry', () => {
  const snapshotSource = source.slice(source.indexOf('function registrationSnapshot()'), source.indexOf('async function backendFor('));
  const expected = [{ hive: 'HKCU:', name: 'Creator Works MCP', values: [{ name: 'DisplayVersion', kind: 'String', value: '2.7.7' }] }];
  let calls = 0;
  const capture = vm.runInThisContext(`execFileSync => { ${snapshotSource}\nreturn registrationSnapshot; }`)((command, args, options) => {
    calls++;
    assert.equal(command, 'powershell.exe'); assert.deepEqual(args.slice(0, 2), ['-NoProfile', '-Command']);
    assert.match(args[2], /CurrentVersion\\Uninstall/); assert.match(args[2], /GetValueKind/);
    assert.equal(options.timeout, 15000); assert.equal(options.maxBuffer, 65536);
    return JSON.stringify(expected);
  });
  assert.deepEqual(capture(), expected); assert.equal(calls, 1);
});
