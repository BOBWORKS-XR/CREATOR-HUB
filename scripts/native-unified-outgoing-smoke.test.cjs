const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { BASELINE, TARGET } = require('./native-unified-outgoing-target.cjs');
const checks = require('./native-unified-outgoing-checks.cjs');
const clone = value => structuredClone(value);
const processRecord = (pid, parentPid, image) => ({ pid, parentPid, image: `C:\\owned\\${image}`, startTicks: String(638123456789000000n + BigInt(pid)), kernelIdentityVerified: true });
function before() {
  const saved = { present: true, size: 20, sha256: 'a'.repeat(64) };
  return { root: processRecord(100, 90, 'creator-hub.exe'), backends: {
    setup: processRecord(101, 100, 'creator-project-setup.exe'), mcp: processRecord(102, 100, 'creator-works-mcp-launcher.exe') },
    sdkRouter: processRecord(120, 90, 'creator-hub-mcp-router.exe'), sdkNode: processRecord(121, 120, 'node.exe'),
    unrelated: processRecord(130, 90, 'node.exe'), executableSha256: BASELINE.exe,
    stores: { mcp: { ...saved }, preferences: { ...saved }, setup: { present: false }, installedContent: { ...saved } },
    preferences: { 'preview-channel': false, 'auto-download': true, 'restore-hosted-views': true },
    activeRoute: { schemaVersion: 1, hubVersion: BASELINE.version, descriptorSha256: BASELINE.runtimeDescriptor, generation: 'f'.repeat(64) },
    forms: { setup: 'Setup draft', mcp: 'MCP draft' }, ticketExists: false, rootExit: { code: null, signal: null } };
}
function ticket(value) {
  return { schemaVersion: 1, fromVersion: '0.1.14', toVersion: '0.1.15', created: 1792000000,
    views: ['setup', 'mcp'].map(app => ({ app, path: value.backends[app].image, bundled: true })) };
}
function updated() {
  const initial = before(), after = clone(initial);
  after.root = processRecord(200, 190, 'creator-hub.exe');
  after.backends = { setup: processRecord(201, 200, 'creator-project-setup.exe'), mcp: processRecord(202, 200, 'creator-works-mcp-launcher.exe') };
  after.executableSha256 = TARGET.pins.executable; after.forms = null;
  after.activeRoute = { ...after.activeRoute, hubVersion: TARGET.version, descriptorSha256: TARGET.runtimeDescriptor };
  return { initial, after, evidence: { originalExit: { code: 0, signal: null }, manualTargetLaunches: 0,
    footerVersion: '0.1.15', registryVersion: '0.1.15', originalBackendsAbsent: true, observedTicket: ticket(initial), pendingRestore: [],
    restoreMessage: 'Your app views have reopened. Select an app from the menu.', restoredFrames: ['setup', 'mcp'],
    existingSdkRoundTrip: true, newRouterRoundTrips: 2, actualNativePermissions: true } };
}
test('synthetic receipt contracts never establish native/product/public/AI acceptance', () => {
  const report = checks.newReport();
  for (const flag of ['passed', 'outgoingHostedUpdateTested', 'publicDiscovery', 'liveAiAcceptance', 'editorAcceptance', 'productAcceptance', 'releaseReady']) assert.equal(report[flag], false);
});

test('fixed MCP target sequence creates settings from the false default, verifying true before false', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-unified-outgoing-smoke.cjs'), 'utf8');
  const opened = "await frames.mcp.locator('.advanced-section summary').click();";
  const start = source.indexOf(opened);
  const end = source.indexOf("await frames.mcp.locator('#mcpServerPath').fill(", start);
  assert.ok(start >= 0 && end > start, 'Fixed MCP preference sequence required');
  const sequence = source.slice(start + opened.length, end);
  async function exercise(save) {
    let checked = false, saved = null, pending = null;
    const events = [];
    const clickLabel = async () => {
      checked = !checked;
      events.push(`click:${checked}`);
      pending = { auto_start: checked };
    };
    const run = vm.runInNewContext(`(async () => { ${sequence} })()`, {
      assert, JSON, config: 'fixed-mcp-settings',
      frames: { mcp: { locator(selector) {
        if (selector === '#autoConfig') return { isChecked: async () => checked };
        assert.equal(selector, 'label[for="autoConfig"]');
        return { click: clickLabel };
      } } },
      bytes(file) { assert.equal(file, 'fixed-mcp-settings'); return saved; },
      async retry(read) {
        try { read(); } catch (error) {
          if (!pending || !save) throw error;
          saved = JSON.stringify(pending); pending = null;
          read();
        }
        events.push(`verified:${JSON.parse(saved).auto_start}`);
      },
    }, { timeout: 1000 });
    if (!save) {
      await assert.rejects(run);
      assert.deepEqual(events, ['click:true'], 'No second toggle before the first real save is verified');
      return;
    }
    await run;
    assert.deepEqual(events, ['click:true', 'verified:true', 'click:false', 'verified:false']);
    assert.deepEqual(JSON.parse(saved), { auto_start: false });
  }
  await exercise(true);
  await exercise(false);
});

test('fresh connection waits for asynchronously opened terms; restoration only verifies the native receipt', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-unified-outgoing-smoke.cjs'), 'utf8');
  const start = source.indexOf('    if (!restoring) {', source.indexOf('  const connect = async'));
  const end = source.indexOf('    if (restoring) await page.waitForFunction', start);
  assert.ok(start >= 0 && end > start);
  const sequence = source.slice(start, end);
  async function exercise(restoring, accepted, save = true) {
    let visible = false, checked = false;
    const events = [];
    const run = vm.runInNewContext(`(async () => { ${sequence} })()`, {
      assert, restoring,
      page: {
        locator(selector) {
          if (selector === '#usage-terms-dialog') return {
            async waitFor({ state }) {
              events.push(`wait:${state}`);
              if (state === 'visible') visible = true; // Native status resolution opens the initially hidden dialog later.
              else { assert.equal(accepted, true); visible = false; }
            },
          };
          if (selector === '#usage-terms-checkbox') return { async check() {
            assert.equal(visible, true); checked = true; events.push('check');
          } };
          assert.equal(selector, '#usage-terms-continue');
          return { async click() {
            assert.equal(visible && checked, true); events.push('accept-ui');
            accepted = save;
          } };
        },
        async evaluate(read) { assert.match(String(read), /invoke\('usage_terms_status'\)/); events.push('native-status'); return accepted; },
      },
      retry: read => read(),
    }, { timeout: 1000 });
    if (!accepted && (restoring || !save)) {
      await assert.rejects(run, /Native terms receipt must be saved and survive restart/);
      assert.equal(events.includes('wait:hidden'), false);
      if (restoring) assert.deepEqual(events, ['native-status'], 'Never accept terms on behalf of a restored app');
    } else await run;
    return events;
  }
  assert.deepEqual(await exercise(false, false), ['wait:visible', 'check', 'accept-ui', 'native-status', 'wait:hidden']);
  await exercise(false, false, false);
  assert.deepEqual(await exercise(true, true), ['native-status', 'wait:hidden']);
  await exercise(true, false);
});

test('fixed sequence operates B03-style hidden checkbox through its visible label and real change events',
  { timeout: 15000 }, async t => {
    const { chromium } = require('playwright');
    if (!fs.existsSync(chromium.executablePath())) return t.skip('Chromium unavailable; required by the native workflow before tests');
    const source = fs.readFileSync(path.join(__dirname, 'native-unified-outgoing-smoke.cjs'), 'utf8');
    const opened = "await frames.mcp.locator('.advanced-section summary').click();";
    const start = source.indexOf(opened);
    const end = source.indexOf("await frames.mcp.locator('#mcpServerPath').fill(", start);
    assert.ok(start >= 0 && end > start);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(3000);
      let saved = null, verified = 0;
      const writes = [];
      await page.exposeFunction('recordPreference', value => {
        assert.equal(typeof value, 'boolean');
        writes.push(value); saved = JSON.stringify({ auto_start: value });
      });
      await page.setContent(`<style>
        .toggle { display: inline-block; height: 24px; position: relative; width: 43px; }
        .toggle input { height: 0; opacity: 0; width: 0; }
        .toggle-slider { position: absolute; inset: 0; }
        </style><label for="autoConfig">Follow Active Project</label>
        <label class="toggle"><input type="checkbox" id="autoConfig"><span class="toggle-slider"></span></label>
        <script>
        window.savedCount = 0;
        document.querySelector('#autoConfig').addEventListener('change', async event => {
          await window.recordPreference(event.target.checked);
          window.savedCount++;
        });
        </script>`);
      assert.equal(await page.locator('#autoConfig').isVisible(), false);
      assert.equal(await page.locator('label[for="autoConfig"]').isVisible(), true);
      await assert.rejects(page.locator('#autoConfig').check({ timeout: 200 }), /Timeout/);
      assert.deepEqual(writes, []);
      await vm.runInNewContext(`(async () => { ${source.slice(start + opened.length, end)} })()`, {
        assert, JSON, frames: { mcp: page }, config: 'fixed-mcp-settings',
        bytes(file) { assert.equal(file, 'fixed-mcp-settings'); return saved; },
        async retry(read) {
          await page.waitForFunction(count => window.savedCount >= count, ++verified);
          read();
        },
      }, { timeout: 1000 });
      assert.deepEqual(writes, [true, false]);
      assert.equal(verified, 2);
      assert.deepEqual(JSON.parse(saved), { auto_start: false });
    } finally { await browser.close(); }
  });
test('cancel retains both drafts, kernel process starts, exact config/preferences/content and absence', () => {
  const initial = before(); checks.cancelPreserved(initial, clone(initial));
  for (const mutate of [value => value.backends.mcp.startTicks = '638000000000000000', value => value.backends.setup.parentPid = 99,
    value => value.root.pid = 99, value => value.sdkRouter.image = 'C:\\foreign\\creator-hub-mcp-router.exe',
    value => value.sdkNode.pid++, value => value.unrelated.startTicks = '638000000000000000',
    value => value.forms.setup = '', value => value.forms.mcp = 'lost', value => value.stores.mcp.sha256 = 'b'.repeat(64),
    value => value.stores.preferences.size++, value => value.stores.setup = { present: true, size: 20, sha256: 'a'.repeat(64) },
    value => value.preferences['restore-hosted-views'] = false, value => value.ticketExists = true,
    value => value.rootExit = { code: 0, signal: null }, value => value.executableSha256 = TARGET.pins.executable]) {
    const after = clone(initial); mutate(after); assert.throws(() => checks.cancelPreserved(initial, after));
  }
});
test('genuine distinct automatic15 restart with both restored views and retained SDK14/router/Node', () => {
  const value = updated(); checks.approvedUpdate(value.initial, value.after, value.evidence);
  for (const [field, replacement] of [['originalExit', { code: 1, signal: null }], ['originalExit', { code: 0, signal: 'SIGTERM' }],
    ['manualTargetLaunches', 1], ['footerVersion', '0.1.14'], ['registryVersion', '0.1.14'], ['originalBackendsAbsent', false],
    ['observedTicket', null], ['pendingRestore', ['mcp']], ['restoreMessage', 'Reopening...'], ['restoredFrames', ['mcp']],
    ['existingSdkRoundTrip', false], ['newRouterRoundTrips', 1], ['actualNativePermissions', false]]) {
    const sample = updated(); sample.evidence[field] = replacement;
    assert.throws(() => checks.approvedUpdate(sample.initial, sample.after, sample.evidence));
  }
  for (const mutate of [value => value.root.pid = 100, value => value.root.image = 'C:\\other\\creator-hub.exe',
    value => value.backends.mcp.pid = 102, value => value.backends.mcp.parentPid = 100,
    value => value.backends.setup.kernelIdentityVerified = false, value => value.sdkNode.startTicks = '638000000000000000',
    value => value.unrelated.pid = 131, value => value.stores.mcp.present = false, value => value.ticketExists = true,
    value => value.executableSha256 = BASELINE.exe, value => value.root.startTicks = '638000000000000000',
    value => value.activeRoute.descriptorSha256 = BASELINE.runtimeDescriptor, value => value.activeRoute.hubVersion = BASELINE.version]) {
    const sample = updated(); mutate(sample.after);
    assert.throws(() => checks.approvedUpdate(sample.initial, sample.after, sample.evidence));
  }
});
test('activation must move from the exact14 descriptor to signed15; unchanged private generation is allowed', () => {
  const initial = before(); checks.activeRoute(initial.activeRoute, BASELINE.version);
  for (const mutate of [value => value.schemaVersion = 2, value => value.descriptorSha256 = TARGET.runtimeDescriptor,
    value => value.generation = '../foreign', value => value.hubVersion = TARGET.version, value => value.extra = true]) {
    const value = clone(initial.activeRoute); mutate(value); assert.throws(() => checks.activeRoute(value, BASELINE.version));
  }
  const after = clone(initial); after.activeRoute.generation = 'e'.repeat(64);
  assert.throws(() => checks.cancelPreserved(initial, after));
});
test('observed native restore ticket cannot be empty, duplicate, foreign, legacy or wrong version', () => {
  const initial = before(); checks.restoreTicket(ticket(initial), initial);
  for (const mutate of [value => value.fromVersion = '0.1.12', value => value.toVersion = '0.1.14',
    value => value.schemaVersion = 2, value => value.created = -1, value => value.views = [],
    value => value.views[1] = clone(value.views[0]), value => value.views[0].path = 'C:\\foreign\\setup.exe',
    value => value.views[0].bundled = false, value => value.views[0].extra = true, value => value.extra = true]) {
    const value = ticket(initial); mutate(value); assert.throws(() => checks.restoreTicket(value, initial));
  }
});
test('missing or aliased process/store identity never proves preservation', () => {
  for (const mutate of [value => delete value.backends.setup, value => value.sdkRouter = value.backends.mcp,
    value => value.sdkNode.parentPid = value.root.pid, value => value.unrelated = value.sdkNode,
    value => value.stores = {}, value => value.stores.preferences = { present: false },
    value => value.root.startTicks = '', value => value.root.image = 'relative',
    value => value.backends.setup.image = 'C:\\owned\\renamed.exe']) {
    const value = before(); mutate(value); assert.throws(() => checks.snapshotShape(value));
  }
});
test('source fences: original native consent helper, readonly kernel recorder, no spoofed IPC/terms/tickets/manual15/process kills', () => {
  const source = fs.readFileSync(path.join(__dirname, 'native-unified-outgoing-smoke.cjs'), 'utf8');
  assert.ok(source.indexOf('assertAdmission();') < source.indexOf('target.selectLab('));
  assert.equal((source.match(/spawn\(hub,/g) || []).length, 1);
  assert.match(source, /native-window\.ps1/); assert.match(source, /CommandButton_\(1000\|1001\)/);
  assert.match(source, /checks\.sameProcess\(owner, record\(owner\.pid\)\)/);
  assert.match(source, /actualNativePermissions:/); assert.match(source, /await sdkRoundTrip\(sdkClient\)/);
  assert.match(source, /target\.readBounded\(ticket, 16 \* 1024\)/);
  assert.doesNotMatch(source, /localStorage\.setItem|sessionStorage\.setItem|window\.CreatorHubNative\s*=|window\.CreatorRuntime\s*=|\.kill\(|taskkill|Stop-Process|writeFileSync\(ticket/);
  const recorder = fs.readFileSync(path.join(__dirname, 'native-unified-outgoing-process.ps1'), 'utf8');
  assert.ok(recorder.indexOf('GITHUB_ACTIONS') < recorder.indexOf('Add-Type'));
  assert.match(recorder, /QueryFullProcessImageName/); assert.match(recorder, /SafeHandle/); assert.match(recorder, /StartTime/);
  assert.match(recorder, /entries.Count -gt 128/);
  assert.doesNotMatch(recorder, /CommandLine|Stop-Process|TerminateProcess|WriteProcessMemory|Start-Process/);
  const wrapper = fs.readFileSync(path.join(__dirname, 'native-unified-outgoing-lab.ps1'), 'utf8');
  assert.match(wrapper, /-Scenario 'unified-outgoing-14-15'/);
  assert.doesNotMatch(wrapper, /RootStore|\.Add\(|Certificate|proxyBootstrap|Resolve-LabBaseline/);
});
