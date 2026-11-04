require('./fixtures/windows-019-test-fixture.cjs').install();
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const driverFile = path.join(__dirname, 'native-windows-019-migration.cjs');
const driverModule = { exports: {} };
const driverSource = fs.readFileSync(driverFile, 'utf8') + '\nmodule.exports.__testRememberGuidePage = rememberGuidePage; module.exports.__testSeedMigrationFixture = seedMigrationFixture; module.exports.__testRunSignedIncomingParent = runSignedIncomingParent;';
vm.runInThisContext(Module.wrap(driverSource), { filename: driverFile })(driverModule.exports, Module.createRequire(driverFile), driverModule, driverFile, __dirname);
const migration = driverModule.exports;
function capture(pid, hub) {
  const root = { ProcessId: pid, ParentProcessId: process.pid, ExecutablePath: hub };
  return { imageSha256: migration.TARGET.exe, processes: [root],
    diagnostics: { processes: [root], listeners: [{ LocalAddress: '127.0.0.1', OwningProcess: pid }] } };
}
function bindSimulatedPage(live) {
  const page = live.page;
  const context = { browser: () => browser, pages: () => [page] };
  const browser = { contexts: () => [context] };
  page.context = () => context; page.url = () => 'http://tauri.localhost/'; live.browser = browser;
  migration.__testRememberGuidePage(live, live.image, browser, page);
}

test('phase sequencer passes the exact setup objects once and returns the guide result', async () => {
  const projectBefore = Object.freeze({ fixture: true });
  const connect = async () => {};
  const handoff = { projectBefore, connect };
  const calls = [];
  const result = await migration.runMigrationPhases(async () => { calls.push('setup'); return handoff; },
    async value => { calls.push('guide'); assert.equal(value, handoff); assert.equal(value.projectBefore, projectBefore);
      assert.equal(value.connect, connect); return 'complete'; });
  assert.equal(result, 'complete');
  assert.deepEqual(calls, ['setup', 'guide']);
});
test('phase failure is propagated without continuation or retry', async () => {
  const failure = Error('setup refused'); let guideCalls = 0, setupCalls = 0;
  await assert.rejects(migration.runMigrationPhases(async () => { setupCalls++; throw failure; },
    async () => { guideCalls++; }), error => error === failure);
  assert.equal(setupCalls, 1); assert.equal(guideCalls, 0);
  const guideError = Error('guide refused');
  await assert.rejects(migration.runMigrationPhases(async () => { setupCalls++; return {}; },
    async () => { guideCalls++; throw guideError; }), error => error === guideError);
  assert.equal(setupCalls, 2); assert.equal(guideCalls, 1);
});
test('existing driver installs and seeds only during setup; guide phase does neither', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-windows-019-migration.cjs'), 'utf8');
  const start = source.indexOf('    const setupInstall = async () => {');
  const end = source.indexOf('    live = { policy, open: launch, launch, close,', start);
  const guideStart = source.indexOf('async function runGuideRestart(');
  const guideEnd = source.indexOf('async function runMigrationPhases(', guideStart);
  assert.ok(start > 0 && end > start && guideStart > 0 && guideEnd > guideStart);
  const setup = source.slice(start, end), guide = source.slice(guideStart, guideEnd);
  assert.equal((setup.match(/installLegacyBaselines\(/g) || []).length, 1);
  assert.ok(setup.indexOf('installLegacyBaselines(') < setup.indexOf('seedMigrationFixture('));
  assert.ok(setup.indexOf('seedMigrationFixture(') < setup.indexOf('installMigrationTarget('));
  assert.equal((setup.match(/installMigrationTarget\(/g) || []).length, 1);
  assert.match(setup, /return \{ fixture: seeded\.fixture, projectBefore, connect \}/);
  assert.doesNotMatch(guide, /installBaseline\(|installMigrationTarget\(|execFileSync\(installer|fs\.writeFileSync\(|fs\.mkdirSync\(/);
  assert.match(guide, /await nativeDecision\(false\)/); assert.match(guide, /await nativeDecision\(true\)/);
  assert.match(guide, /await close\(\); await launch\(\)/);
});
test('real installer phase bodies preserve parameters, order and fail before another install', async () => {
  const baselines = ['hub', 'mcp', 'setup'].map(product => ({ product, version: '1', asset: `${product}.exe`, binary: 'app.exe', sha256: product }));
  const registrations = () => baselines.map(item => ({ name: item.product, version: item.version, hive: 'HKCU:' }));
  const input = { baselines: path.resolve('baselines') }, environment = { fixture: 'env' }, report = { checks: [] }, calls = [];
  migration.installLegacyBaselines({ baselines, input, environment, report, localAppData: path.resolve('local'), registrations,
    install(file, baseline, env, actualReport) { calls.push([file, baseline, env, actualReport]); }, read: file => Buffer.from(file), digest: () => 'digest' });
  assert.equal(calls.length, 3); assert.equal(calls[0][0], path.join(input.baselines, baselines[0].asset));
  assert.equal(calls[0][2], environment); assert.equal(calls[0][3], report); assert.equal(report.baselines.length, 3);
  const failure = Error('install failure'); let attempts = 0;
  assert.throws(() => migration.installLegacyBaselines({ baselines, input, environment, report, localAppData: path.resolve('local'), registrations,
    install() { attempts++; throw failure; } }), error => error === failure);
  assert.equal(attempts, 1);
  const events = [], entry = { command: 'old' }, manifest = { expected: true }, oldClient = {};
  const result = await migration.installMigrationTarget({ installer: 'r2.exe', environment, hub: path.resolve('hub/app.exe'),
    hubHash: () => migration.TARGET.exe, unchanged: () => events.push('unchanged'), retained: () => events.push('retained'),
    report, registrations, baselines, entry, connect: async value => { assert.equal(value, entry); events.push('connect'); return oldClient; },
    run(file, args, options) { assert.equal(file, 'r2.exe'); assert.deepEqual(args, ['/UPDATE', '/S', '/NS']);
      assert.equal(options.env, environment); events.push('install'); }, inspect: () => { events.push('inspect'); return manifest; } });
  assert.deepEqual(events, ['install', 'unchanged', 'retained', 'inspect', 'connect']);
  assert.equal(result.manifest, manifest); assert.equal(result.oldClient, oldClient);
  let connects = 0, installs = 0;
  await assert.rejects(migration.installMigrationTarget({ installer: 'r2.exe', environment, hub: path.resolve('hub/app.exe'),
    hubHash: () => 'bad', unchanged() {}, retained() {}, report, registrations, baselines, entry,
    connect: async () => { connects++; }, run: () => { installs++; }, inspect: () => manifest }));
  assert.equal(installs, 1); assert.equal(connects, 0);
});
test('actual legacy fixture seeding returns the same fixture and refuses existing targets', () => {
  const env = { USERPROFILE: path.resolve('synthetic/home'), APPDATA: path.resolve('synthetic/home/roaming'), LOCALAPPDATA: path.resolve('synthetic/home/local') };
  const create = () => { const f = migration.fixture(env, path.resolve('synthetic/output')); return { f, stores: [...f.stores, ...f.clients, ...f.untouched] }; };
  const files = new Map(), writes = [], runtime = Array.from({ length: 9 }, (_, i) => ({ name: `file-${i}`, parentPath: 'old-server', isFile: () => true }));
  const fsOps = { mkdirSync() {}, existsSync: file => files.has(file), readdirSync: () => runtime,
    writeFileSync(file, bytes, options) { assert.equal(options.flag, 'wx'); assert.equal(files.has(file), false); files.set(file, bytes); writes.push(file); } };
  const { f, stores } = create(), image = { projects: 'snapshot' };
  const seeded = migration.__testSeedMigrationFixture({ f, stores, fsOps, checkLinks() {}, read: () => Buffer.from('runtime'), digest: () => 'digest', image: () => image });
  assert.equal(seeded.fixture, f); assert.equal(seeded.projectBefore, image); assert.equal(seeded.retainedRuntime.length, 9); assert.equal(writes.length, 17);
  files.clear(); const next = create(), existing = next.stores[0].path; files.set(existing, Buffer.from('preserve'));
  assert.throws(() => migration.__testSeedMigrationFixture({ ...next, fsOps, checkLinks() {}, read: () => Buffer.from('runtime'), digest: () => 'digest', image: () => image }));
  assert.deepEqual(files.get(existing), Buffer.from('preserve'));
});
test('guide refuses a different fixture object before opening the live process', async () => {
  let opened = false;
  const f = { stores: [], clients: [], untouched: [] };
  const live = { policy() { opened = true; }, open: async () => { opened = true; } };
  await assert.rejects(migration.runGuideRestart({ fixture: {}, projectBefore: {}, connect: async () => {} }, { live, f }), /same synthetic fixture object/);
  assert.equal(opened, false);
});
test('incoming parent orders signed update, verified close and lab cleanup before guide', async () => {
  const source = fs.readFileSync(driverFile, 'utf8');
  assert.match(source, /process\.env\.INCOMING_EXPECTED_SOURCE, process\.env\.GITHUB_SHA/);
  await assert.rejects(migration.productionMigrationMain([]), /Native migration requires Windows|Refused runner context/);
  const env = { GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', ProgramFiles: path.resolve('program-files'),
    USERPROFILE: path.resolve('synthetic/home'), APPDATA: path.resolve('synthetic/home/roaming'), LOCALAPPDATA: path.resolve('synthetic/home/local') };
  const out = path.resolve('workspace/artifacts/native-suite-123'), projectBefore = { stable: true };
  const fixture = migration.fixture(env, out), stores = [...fixture.stores, ...fixture.clients, ...fixture.untouched];
  const fakeFs = { mkdirSync() {}, existsSync: () => false, writeFileSync() {}, readdirSync: () =>
    Array.from({ length: 9 }, (_, i) => ({ name: `file-${i}`, parentPath: 'old-server', isFile: () => true })) };
  migration.__testSeedMigrationFixture({ f: fixture, stores, fsOps: fakeFs, checkLinks() {}, read: () => Buffer.from('runtime'),
    digest: () => 'digest', image: () => projectBefore });
  const rows = require('./windows-019-owned-snapshot.cjs').fixturePlan(env, out);
  assert.equal(rows.length, 17); assert.equal([...fixture.stores, ...fixture.clients, ...fixture.untouched].length, 13);
  async function attempt(failure) {
    const events = []; const recordedMeta = [{ synthetic: true }];
    const owned = { admit(actual) { assert.equal(actual.CREATOR_PRODUCTION_019_MIGRATION, '1'); events.push('admit'); },
      bindFeed() { events.push('feed'); }, fixturePlan: () => rows, metadata: () => recordedMeta, signedUpdateRoot: value => `${value}001`,
      checkPreinstalledFixture() { events.push('preinstalled'); if (failure === 'fixture') throw Error('fixture'); },
      checkClosedSignedUpdate({ update, close, lifecycle }) { events.push('closed-and-cleaned');
        assert.equal(update.restartedClose, close); assert.equal(lifecycle.cleanupVerified, true);
        if (failure === 'cleanup' || failure === 'close') throw Error(failure); },
      checkFixtureBytes() { events.push('preserved'); if (failure === 'drift') throw Error('drift'); } };
    const overrides = { owned, checkLinks() {}, readFile(file) {
      if (file.endsWith('config.json')) return Buffer.from('{}');
      if (failure === 'receipt') throw Error('missing receipt');
      return Buffer.from(JSON.stringify({ restartedClose: { state: 'verified' } }));
    }, writeFile(file, bytes, options) { assert.equal(options.flag, 'wx');
      const isReceipt = path.basename(file) === 'incoming-preinstalled.json'; events.push(isReceipt ? 'receipt' : 'lifecycle');
      if (isReceipt && failure === 'existing') throw Error('existing'); },
    run(file, args, options) { events.push('signed-update'); assert.ok(path.isAbsolute(file));
      assert.equal(options.env.CREATOR_PRODUCTION_019_FIXTURE_ROOT, out);
      if (failure === 'timeout') throw Error('timeout');
      if (failure === 'missing-lifecycle') return '{"kind":"other"}\n';
      return JSON.stringify({ kind: 'lab-lifecycle-result', cleanupVerified: true }) + '\n'; } };
    let guideCalls = 0;
    const setup = async () => { const result = migration.__testRunSignedIncomingParent({ environment: env, out, fixture,
      baselineInstaller: path.resolve('baseline.exe'), projectBefore, projectImage: () => failure === 'project' ? {} : projectBefore }, overrides);
      assert.equal(result.processTransfer, false); return { fixture, projectBefore }; };
    const guide = async value => { guideCalls++; assert.equal(value.fixture, fixture); events.push('guide'); };
    if (failure) await assert.rejects(migration.runMigrationPhases(setup, guide));
    else await migration.runMigrationPhases(setup, guide);
    return { events, guideCalls };
  }
  const success = await attempt(); assert.equal(success.guideCalls, 1);
  assert.deepEqual(success.events, ['admit', 'feed', 'preinstalled', 'receipt', 'signed-update', 'lifecycle', 'closed-and-cleaned', 'preserved', 'guide']);
  for (const failure of ['fixture', 'existing', 'timeout', 'missing-lifecycle', 'receipt', 'close', 'cleanup', 'drift', 'project']) {
    const result = await attempt(failure); assert.equal(result.guideCalls, 0, failure);
  }
});
test('incoming guide requires prior terms dialog to remain hidden without clicking consent', async () => {
  const f = { stores: [], clients: [], untouched: [] }, selectors = [];
  const page = { locator(selector) { selectors.push(selector); return { waitFor: async options => {
    if (selector === '#usage-terms-dialog') assert.deepEqual(options, { state: 'hidden' }); }, click: async () => {}, check: async () => {} }; } };
  const live = { page, process: { pid: 42, exitCode: null }, image: 'hub', policy() {}, close: async () => {}, launch: async () => {},
    captureOwnership: () => capture(42, 'hub'), open: async () => bindSimulatedPage(live) };
  await assert.rejects(migration.runGuideRestart({ fixture: f }, { live, f, hub: 'hub', termsAlreadyAccepted: true,
    retry: async () => { throw Error('stop after terms'); } }), /stop after terms/);
  assert.ok(selectors.includes('#usage-terms-dialog'));
  assert.equal(selectors.includes('#usage-terms-checkbox'), false); assert.equal(selectors.includes('#usage-terms-continue'), false);
});
test('deferred guide reopens through the visible control exactly once', async () => {
  const f = { stores: [], clients: [], untouched: [] }, actions = [];
  const page = { locator(selector) { return { waitFor: async () => { actions.push(`wait:${selector}`);
    if (selector === '#convergence-move') throw Error('stop after reopen'); },
    click: async () => actions.push(`click:${selector}`) }; } };
  const live = { page, process: { pid: 42, exitCode: null }, image: 'hub', policy() {}, close: async () => {}, launch: async () => {},
    captureOwnership: () => capture(42, 'hub'), open: async () => bindSimulatedPage(live) };
  await assert.rejects(migration.runGuideRestart({ fixture: f }, { live, f, hub: 'hub', termsAlreadyAccepted: true,
    retry: async fn => fn(), readStatus: async () => ({ stage: 'review', required: true, backups: [] }) }), /stop after reopen/);
  assert.deepEqual(actions, ['wait:#usage-terms-dialog', 'wait:#convergence-reopen', 'click:#convergence-reopen', 'wait:#convergence-move']);
});
test('real guide uses live interface and actual failure cleanup without reinstall', async () => {
  const calls = []; let clicks = 0;
  const page = { locator(selector) { return { waitFor: async () => {}, check: async () => {}, click: async () => {
    if (selector === '#convergence-move' && ++clicks === 2) throw Error('approval click failed'); } }; }, waitForFunction: async () => {} };
  const live = { page, process: { pid: 123, exitCode: null }, image: 'unused', observer: null, policy: action => calls.push(`policy:${action}`),
    captureOwnership: () => { calls.push('verify'); return capture(123, 'unused'); },
    open: async () => { calls.push('open'); bindSimulatedPage(live); }, launch: async () => calls.push('launch'), close: async () => calls.push('close') };
  const report = { passed: true, checks: [] }, child = { exitCode: null, unref: () => calls.push('unref') };
  const context = { live, f: { stores: [], clients: [], untouched: [] }, retry: async fn => fn(), readStatus: async () => ({ streamlined: true, stage: 'review', required: true, backups: [] }),
    nativeDecision: async approve => calls.push(`decision:${approve}`), unchanged: () => calls.push('unchanged'), retained: () => calls.push('retained'),
    report, connectionDecision: async () => {}, verifyBackups() {}, read() {}, manifest: {}, oldClient: {}, registrations() {}, baselines: [], projectImage() {}, out: 'unused', hub: 'unused' };
  try {
    await assert.rejects(migration.runGuideRestart({ fixture: context.f, projectBefore: {}, connect: async () => {} }, context), /approval click failed/);
    assert.equal(report.cancelAccepted, true); assert.ok(live.observer);
    await migration.cleanupMigration({ observer: live.observer, child, report, policyState: 'unused', exists: () => true,
      policy: action => calls.push(`policy:${action}`), native: action => { calls.push(`native:${action}`); child.exitCode = 0; },
      retry: async fn => fn(), clear: timer => { clearInterval(timer); calls.push('clear'); }, browser: { close: async () => calls.push('browser-close') },
      oldClient: { close: async () => calls.push('sdk-close') } });
  } finally { if (live.observer) clearInterval(live.observer); }
  assert.deepEqual(calls, ['policy:Enable', 'open', 'verify', 'verify', 'decision:false', 'unchanged', 'retained', 'clear', 'sdk-close', 'native:close', 'browser-close', 'policy:Restore']);
  assert.equal(report.policyRestored, true);
});
test('guide refuses a missing process or different image before interacting with the page', async () => {
  const f = { stores: [], clients: [], untouched: [] };
  for (const process of [undefined, { pid: 0 }, { pid: 1.5 }]) {
    const live = { process, image: 'hub', policy() {}, open: async () => {}, launch: async () => {}, close: async () => {},
      get page() { throw Error('page was accessed'); } };
    await assert.rejects(migration.runGuideRestart({ fixture: f }, { live, f, hub: 'hub' }), /live owned Hub process/);
  }
  const live = { process: { pid: 42, exitCode: null }, image: 'other', policy() {}, open: async () => {}, launch: async () => {}, close: async () => {},
    get page() { throw Error('page was accessed'); } };
  await assert.rejects(migration.runGuideRestart({ fixture: f }, { live, f, hub: 'hub' }), /expected Hub image/);
});
test('guide refuses unowned debugger, wrong image bytes and foreign parent before UI', async () => {
  const f = { stores: [], clients: [], untouched: [] };
  for (const mutate of [value => { value.imageSha256 = 'wrong'; },
    value => { value.diagnostics.listeners[0].OwningProcess = 999; },
    value => { value.processes[0].ParentProcessId = 999; }]) {
    const live = { process: { pid: 42, exitCode: null }, image: 'hub', policy() {}, open: async () => {}, launch: async () => {}, close: async () => {},
      captureOwnership() { const value = capture(42, 'hub'); mutate(value); return value; },
      get page() { throw Error('page was accessed'); } };
    await assert.rejects(migration.runGuideRestart({ fixture: f }, { live, f, hub: 'hub' }));
  }
});
test('guide refuses a foreign page or browser even when process ownership matches', async () => {
  const f = { stores: [], clients: [], untouched: [] };
  for (const foreign of ['page', 'browser']) {
    let touched = false;
    const page = { locator() { touched = true; throw Error('UI was accessed'); } };
    const live = { page, process: { pid: 42, exitCode: null }, image: 'hub', policy() {},
      captureOwnership: () => capture(42, 'hub'), launch: async () => {}, close: async () => {},
      open: async () => { bindSimulatedPage(live); if (foreign === 'page') live.page = { locator() { touched = true; } };
        else live.browser = { contexts: () => [] }; } };
    await assert.rejects(migration.runGuideRestart({ fixture: f }, { live, f, hub: 'hub' }), /CDP binding|verified CDP connection/);
    assert.equal(touched, false);
  }
});
test('production binding follows owned fixed CDP connection and is rechecked after restart', () => {
  const source = fs.readFileSync(driverFile, 'utf8');
  const launch = source.slice(source.indexOf('  const launch = async () => {'), source.indexOf('  const close = async () => {'));
  const check = launch.indexOf('pins.assertOwnedDebugging(state, child.pid, hub)');
  const connect = launch.indexOf("chromium.connectOverCDP('http://127.0.0.1:9238')");
  const bind = launch.indexOf('rememberGuidePage(live, hub, browser, page)');
  const firstUi = launch.indexOf('page.waitForFunction(');
  assert.ok(check >= 0 && check < connect && connect < bind && bind < firstUi);
  const guide = source.slice(source.indexOf('async function runGuideRestart('), source.indexOf('async function runMigrationPhases('));
  const restart = guide.indexOf('await close(); await launch();');
  assert.ok(guide.indexOf('verifyGuidePage(live, hub)') < guide.indexOf('live.page.locator('));
  assert.ok(guide.indexOf('verifyGuidePage(live, hub)', restart) < guide.indexOf('live.page.waitForFunction(', restart));
});
test('successful real guide reconnects clients and verifies ownership again after restart', async () => {
  for (const failRestart of [false, 'image', 'foreign']) {
  const events = [], report = { passed: false, checks: [], nativeDecisions: [] }, projectBefore = { unchanged: true };
  const stores = ['current', 'earlier', 'roots'].map(name => ({ path: `store/${name}`, bytes: Buffer.from(`original-${name}`) }));
  const clients = ['codex', 'claude', 'desktop'].map(id => ({ id, path: `client/${id}`, bytes: Buffer.from(`original-${id}`) }));
  const f = { stores, clients, untouched: [], projectA: 'project-a', projectB: 'project-b', entry: { command: 'legacy' } };
  const manifest = { modules: { mcp: { files: { 'mcp/server/creator-works-mcp.mjs': 'server-hash' } } } };
  const active = { payload: 'active-payload' }; let changed = false;
  const page = { locator(selector) { const item = { waitFor: async () => {}, check: async () => {}, click: async () => events.push(`click:${selector}`),
    isVisible: async () => false, filter: () => item }; return item; }, waitForFunction: async () => events.push('page-wait'), screenshot: async () => {} };
  const live = { page, process: { pid: 123, exitCode: null }, image: 'hub', observer: null, policy: action => events.push(`policy:${action}`),
    open: async () => { events.push('open'); bindSimulatedPage(live); }, close: async () => events.push('close'),
    launch: async () => { events.push('restart'); live.process = { pid: 124, exitCode: null };
      if (failRestart !== 'image') bindSimulatedPage(live);
      if (failRestart === 'foreign') live.page = { waitForFunction() { throw Error('foreign UI accessed'); } }; },
    captureOwnership() { events.push(`verify:${live.process.pid}`); const value = capture(live.process.pid, 'hub');
      if (failRestart === 'image' && live.process.pid === 124) value.imageSha256 = 'wrong'; return value; } };
  const connect = async entry => { events.push(`connect:${entry.command}`); return { close: async () => {} }; };
  const read = file => { if (!changed) return [...stores, ...clients].find(item => item.path === file).bytes;
    if (file === stores[0].path) return Buffer.from('{"mcp_server_path":"server"}');
    if (file === clients[0].path) return Buffer.from('# Keep this comment\n');
    return Buffer.from('{}'); };
  const context = { live, f, retry: async fn => fn(), readStatus: async () => changed ? { stage: 'complete', required: false, legacyApps: [] } :
    { streamlined: true, stage: 'review', required: true, backups: [] },
    nativeDecision: async approve => { events.push(`decision:${approve}`); report.nativeDecisions.push({ approve }); if (approve) changed = true; },
    unchanged() {}, retained() {}, report, connectionDecision: async () => events.push('connection-review'), verifyBackups() {}, read, manifest,
    oldClient: { listTools: async () => ({ tools: [{}] }) }, registrations: () => [{ hive: 'HKCU:', name: 'Creator Hub', version: migration.TARGET.version }],
    baselines: [], projectImage: () => projectBefore, out: 'out', hub: 'hub', effects: {
      fs: { existsSync: () => false, realpathSync: () => 'same' }, hash: () => 'server-hash', regular: () => Buffer.from('server'),
      inspectActiveRoute: () => active, verifyMerged() {}, verifyClient: (fixture, item) => ({ command: item.id }),
      execFileSync: () => '{}', inspectInstalledResources() {}, localAppData: 'local',
      managedTarget: () => ({ managedLocations: () => ({ command: 'router' }), verifyMigratedTarget() {} }) } };
  try {
    const execution = migration.runGuideRestart({ fixture: f, projectBefore, connect }, context);
    if (failRestart) await assert.rejects(execution, failRestart === 'image' ? /exact R2/ : /no verified CDP binding/); else await execution;
  }
  finally { if (live.observer) clearInterval(live.observer); }
  if (failRestart) {
    assert.equal(report.passed, false);
    assert.ok(events.lastIndexOf('page-wait') < events.indexOf('restart'));
    assert.equal(events.filter(value => value.startsWith('connect:')).length, 4);
    continue;
  }
  assert.equal(report.passed, true); assert.equal(report.cancelAccepted, true); assert.equal(report.repeatStartupAccepted, true);
  assert.equal(events.filter(value => value.startsWith('connect:')).length, 8);
  assert.ok(events.indexOf('verify:123') < events.indexOf('click:#convergence-move'));
  assert.ok(events.indexOf('restart') < events.indexOf('verify:124'));
  assert.equal(events.filter(value => value === 'close').length, 2);
  assert.equal(events.filter(value => value === 'connection-review').length, 1);
  }
});
test('production workflow requires passing phase tests before migration', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/windows-019-production.yml'), 'utf8');
  const job = workflow.split('  incoming-migration:')[1];
  assert.ok(job.includes('needs: preflight'));
  assert.ok(workflow.includes('scripts/windows-019-migration-phase.test.cjs'));
  assert.ok(workflow.indexOf('scripts/windows-019-migration-phase.test.cjs') < workflow.indexOf('productionMigrationMain'));
});
test('cleanup retains failures and attempts all remaining cleanup steps', async () => {
  const calls = [], report = { passed: true }, child = { exitCode: null, unref: () => calls.push('unref') };
  await migration.cleanupMigration({ observer: 1, oldClient: { close: async () => { calls.push('sdk'); throw Error('sdk'); } }, child,
    browser: { close: async () => { calls.push('browser'); throw Error('browser'); } }, policyState: 'unused', exists: () => true,
    policy: () => { calls.push('policy'); throw Error('policy'); }, native: () => { calls.push('native'); throw Error('native'); },
    retry: async fn => fn(), report, clear: () => calls.push('clear') });
  assert.deepEqual(calls, ['clear', 'sdk', 'native', 'unref', 'browser', 'policy']);
  for (const name of ['sdkCleanupError', 'closeError', 'browserCloseError', 'policyError']) assert.equal(typeof report[name], 'string');
  assert.equal(report.passed, false);
});
test('no incoming continuation is exposed and original runner admission still refuses overrides', () => {
  assert.equal(migration.incomingMigrationContinuation, undefined);
  const env = { ...migration.CONTEXT, GITHUB_SHA: 'a'.repeat(40), EXPECTED_HARNESS_COMMIT: 'a'.repeat(40), CREATOR_PRODUCTION_019_MIGRATION: '1' };
  assert.throws(() => migration.admission(env, 'win32'), /No product fixture or behavior overrides/);
  assert.throws(() => migration.parseArgs([]), /Supply only absolute/);
});
