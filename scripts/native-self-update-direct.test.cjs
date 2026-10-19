const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const direct = require('./native-self-update-direct.cjs');

const root = path.resolve(__dirname, '..');
const smoke = fs.readFileSync(path.join(__dirname, 'native-self-update-smoke.cjs'), 'utf8');
const protocol = () => ({ version: '0.1.16', protocol: 1, integrated: true,
  services: { integrated: true, features: ['setup', 'mcp'] } });
const mcp = () => ({ runtime: { ready: true, bundled: true }, managedRouting: false, clients: [{ id: 'codex' }], project: null });
const setup = () => ({ platform: 'windows', editors: [], blockers: [],
  recipe: { editorVersion: '6000.0.65f1', creatorSdkVersion: 'fixture-sdk', urpVersion: 'fixture-urp' } });

function temporary(t) {
  const parent = fs.realpathSync(os.tmpdir()), directory = fs.realpathSync(fs.mkdtempSync(path.join(parent, 'hub-direct-smoke-')));
  t.after(() => { assert.equal(path.dirname(fs.realpathSync(directory)), parent); fs.rmSync(directory, { recursive: true, force: true }); });
  return directory;
}

class Page extends EventEmitter {
  constructor() {
    super(); this.current = 'projects'; this.frameCount = 1; this.pageCount = 1; this.embedded = 0; this.plugins = 0; this.text = 'Creator tools';
    this.resources = []; this.calls = []; this.actions = []; this.values = new Map(); this.guide = true;
    this.state = protocol(); this.mcp = mcp(); this.setup = setup(); this.ready = true; this.enabled = true; this.errorVisible = false;
    this.restored = 'Your Hub page has been restored.'; this.pending = []; this.review = { status: 'unchanged', count: 0 };
  }
  async invoke(command, args) {
    this.calls.push({ command, args });
    if (command === 'feature_status') return this.state.services;
    if (command === 'pending_hosted_restore') return this.pending;
    assert.equal(command, 'feature_call');
    if (args.command === 'probe_environment') { assert.equal(args.feature, 'setup'); assert.deepEqual(args.args, {}); return this.setup; }
    assert.equal(args.feature, 'mcp');
    if (args.command === 'get_onboarding_status') { assert.deepEqual(args.args, { unityProjectPath: null }); return this.mcp; }
    if (args.command === 'begin_ui_operation') return 7;
    if (args.command === 'finish_ui_operation') { assert.deepEqual(args.args, { id: 7 }); return null; }
    assert.equal(args.command, 'review_existing_client_connections');
    assert.deepEqual(args.args, { clients: ['codex'] });
    if (this.reviewError) throw Error('Native review failed');
    this.mcp.managedRouting = true;
    return this.review;
  }
  async evaluate(fn, arg) {
    const document = {
      querySelectorAll: selector => new Array(selector === 'iframe,object,embed' ? this.embedded : this.plugins),
      querySelector: selector => {
        if (selector === '#hosted-restore-message') return { textContent: this.restored };
        if (['#suite-menu', '#context-help-dialog'].includes(selector)) return { textContent: this.text };
        assert.match(selector, /^#feature-(setup|mcp)$/);
        return { hidden: selector !== `#feature-${this.current}`, getAttribute: () => 'false',
          querySelector: () => ({ textContent: this.ready ? 'Ready' : 'Needs attention' }) };
      },
    };
    const value = await vm.runInNewContext(`(${fn.toString()})(argument)`, { argument: arg, document,
      performance: { getEntriesByType: () => this.resources.map(name => ({ name })) },
      window: { __CREATOR_HUB_FEATURE_PROTOCOL__: this.state.protocol, CreatorHubNative: {
        version: this.state.version, integratedFeatures: this.state.integrated,
        invoke: (command, args) => this.invoke(command, args && JSON.parse(JSON.stringify(args))),
      } },
    });
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
  async waitForFunction(fn, arg) { assert.equal(await this.evaluate(fn, arg), true, 'UI never reached its required state'); }
  frames() { return new Array(this.frameCount); }
  context() { return { pages: () => new Array(this.pageCount) }; }
  locator(selector) {
    return {
      isEnabled: async () => this.enabled,
      isVisible: async () => {
        if (selector.includes('[data-field="error"]')) return this.errorVisible;
        if (selector.includes('[data-field="guide-dialog"]')) return this.guide;
        if (selector === '#view-native-features') return ['mcp', 'setup'].includes(this.current);
        if (selector === `#feature-${this.current}`) return true;
        return ['#view-projects', '#unified-home-updater .hub-update'].includes(selector) && this.current === 'projects';
      },
      click: async () => {
        this.actions.push(selector);
        if (selector === '#suite-menu [data-view="hub"]') this.current = 'projects';
        else if (selector.endsWith('[data-field="guide-start"]')) this.guide = false;
        else assert.equal(selector, '#suite-trigger', 'Private GUI/frame/Plugins control reached');
      },
      fill: async value => this.values.set(selector, value), inputValue: async () => this.values.get(selector),
    };
  }
}

test('direct mode is exactly 0.1.16 and source-bound, never inferred from a missing legacy selector', () => {
  assert.equal(direct.directTarget('0.1.16', '0.1.16'), true);
  for (const version of ['0.1.12', '0.1.14', '0.1.15', '0.1.16-rc.1', '0.1.17']) assert.equal(direct.directTarget(version, version), false);
  for (const source of ['0.1.14', '0.1.15', undefined]) assert.throws(() => direct.directTarget('0.1.16', source), /checked-out product/);
  direct.assertProtocol(protocol());
  for (const mutate of [s => s.version = '0.1.14', s => s.protocol = 0, s => delete s.protocol, s => s.integrated = false,
    s => s.services.integrated = false, s => s.services.features.pop(), s => s.services.features.push('plugins')]) {
    const state = protocol(); mutate(state); assert.throws(() => direct.assertProtocol(state));
  }
});

test('direct pages require real finite service calls, enabled/error-free controls and a retained navigation draft', async () => {
  const page = new Page(), visited = [], shots = [];
  const services = await direct.checkPages({ page, requests: [], processes: () => [],
    showApp: async feature => { visited.push(feature); page.current = feature; }, screenshot: async feature => shots.push(feature) });
  assert.deepEqual(visited, ['setup', 'mcp', 'setup', 'mcp', 'setup']);
  assert.deepEqual(shots, ['setup', 'mcp']);
  assert.deepEqual(services, { setup: setup(), mcp: mcp() });
  assert.deepEqual(page.calls.map(call => [call.command, call.args?.command]),
    [['feature_status', undefined], ['feature_call', 'probe_environment'], ['feature_call', 'get_onboarding_status']]);
  assert.ok(page.actions.includes('#feature-mcp [data-field="guide-start"]'));
  assert.ok(!page.actions.some(action => /guide-skip|hosted|plugins/.test(action)));
  await direct.checkHome(page);
});

test('direct readiness cannot hide a private GUI, frame, service error, disabled controls or unfinished initialization', async () => {
  for (const mutate of [p => p.embedded = 1, p => p.frameCount = 2, p => p.pageCount = 2, p => p.plugins = 1, p => p.errorVisible = true,
    p => p.ready = false, p => p.enabled = false, p => p.setup.platform = 'linux', p => p.mcp.runtime.ready = false, p => p.mcp.runtime.bundled = false]) {
    const page = new Page(); mutate(page);
    await assert.rejects(direct.checkPages({ page, requests: [], processes: () => [],
      showApp: async feature => { page.current = feature; }, screenshot: async () => {} }));
  }
  const page = new Page();
  await assert.rejects(direct.checkPages({ page, requests: [], processes: () => [{ ProcessId: 24, ParentProcessId: 12 }],
    showApp: async feature => { page.current = feature; }, screenshot: async () => {} }), /private module GUI/);
});

test('Plugins and catalogue checks cover historical startup resources as well as requests after attachment', async () => {
  for (const url of ['http://tauri.localhost/community.js', 'http://tauri.localhost/community.css?x=1',
    'http://tauri.localhost/icons/creator-plugins.png', 'https://raw.githubusercontent.com/SideQuestVR/Creator-Community/main/catalogue.json',
    'http://tauri.localhost/community_catalogue']) {
    const page = new Page(), requests = direct.watchRequests(page);
    page.emit('request', { url: () => 'https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases?per_page=10' });
    assert.deepEqual(requests, []);
    page.resources.push(url);
    await assert.rejects(direct.checkCleanDocument(page, requests), /must not be requested/);
    page.resources = [];
    page.emit('request', { url: () => url });
    await assert.rejects(direct.checkCleanDocument(page, requests), /must not be requested/);
  }
  const page = new Page(); page.text = 'Creator Plugins';
  await assert.rejects(direct.checkCleanDocument(page, []), /Creator Plugins/);
});

test('restoration consumes the native ticket and selects a direct tool, not Apps or old frames', async () => {
  const page = new Page(); page.current = 'mcp'; await direct.checkRestored(page);
  page.pending = ['setup']; await assert.rejects(direct.checkRestored(page));
  page.pending = []; page.current = 'projects'; await assert.rejects(direct.checkRestored(page));
  page.current = 'setup'; page.restored = 'Your app views have reopened.'; await assert.rejects(direct.checkRestored(page));
});

test('managed reconnect preparation retains native approval, finite workflow and an empty non-mutating client review', async t => {
  const directory = temporary(t), active = path.join(directory, 'active.json'), clientConfig = path.join(directory, 'absent-config.toml');
  const page = new Page(); let approvals = 0;
  const approve = async () => { approvals++; fs.writeFileSync(active, 'native fixture activation'); };
  assert.equal((await direct.prepareManagedRoute(page, { active, clientConfig, approve })).managedRouting, true);
  assert.equal(approvals, 1); assert.equal(fs.existsSync(clientConfig), false);
  assert.deepEqual(page.calls.map(call => call.args.command), ['begin_ui_operation', 'review_existing_client_connections', 'finish_ui_operation', 'get_onboarding_status']);
  await direct.prepareManagedRoute(page, { active, clientConfig, approve });
  assert.equal(approvals, 1, 'Already active route must not wait for a nonexistent approval dialog');
  fs.writeFileSync(clientConfig, 'must not be inspected or migrated');
  const before = page.calls.length;
  await assert.rejects(direct.prepareManagedRoute(page, { active, clientConfig, approve }), /requires absent Codex settings/);
  assert.equal(page.calls.length, before);
});

test('failed, cancelled or mutating native route review cannot certify reconnect preparation', async t => {
  const directory = temporary(t), active = path.join(directory, 'active.json'), clientConfig = path.join(directory, 'absent-config.toml');
  fs.writeFileSync(active, 'native fixture activation');
  for (const review of [{ status: 'cancelled', count: 0 }, { status: 'migrated', count: 1 }]) {
    const page = new Page(); page.review = review;
    await assert.rejects(direct.prepareManagedRoute(page, { active, clientConfig }), /No client migration/);
    assert.ok(page.calls.some(call => call.args.command === 'finish_ui_operation'));
  }
  const page = new Page(); page.reviewError = true;
  await assert.rejects(direct.prepareManagedRoute(page, { active, clientConfig }), /Native review failed/);
  assert.equal(page.calls.at(-1).args.command, 'finish_ui_operation');
  const missing = path.join(directory, 'missing-active.json');
  await assert.rejects(direct.prepareManagedRoute(new Page(), { active: missing, clientConfig, approve: async () => {} }), /Native signed route activation/);
  const unbound = new Page(), invoke = unbound.invoke.bind(unbound);
  unbound.invoke = async (command, args) => {
    const result = await invoke(command, args);
    return args?.command === 'get_onboarding_status' ? { ...result, managedRouting: false } : result;
  };
  await assert.rejects(direct.prepareManagedRoute(unbound, { active, clientConfig }), /bind the approved managed route/);
});

test('settings proof hashes only the three product stores and detects changed, removed and newly created images', t => {
  const directory = temporary(t), roaming = path.join(directory, 'roaming'), local = path.join(directory, 'local');
  const before = direct.settingsSnapshot(roaming, local);
  assert.ok(before.every(row => row.sha256 === null));
  const config = path.join(roaming, 'creator-works-mcp/launcher-config.json');
  fs.mkdirSync(path.dirname(config), { recursive: true }); fs.writeFileSync(config, '{"unknown":"kept"}\r\n');
  const saved = direct.settingsSnapshot(roaming, local); assert.notDeepEqual(saved, before);
  assert.deepEqual(direct.settingsSnapshot(roaming, local), saved);
  fs.appendFileSync(config, ' '); assert.notDeepEqual(direct.settingsSnapshot(roaming, local), saved);
  fs.rmSync(config); assert.deepEqual(direct.settingsSnapshot(roaming, local), before);
});

test('current direct selectors and native services match the checked-out 0.1.16 product, without retired catalogue commands', () => {
  assert.equal(require('../package.json').version, direct.VERSION);
  const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');
  assert.match(app, /current = 'projects'/); assert.match(app, /check: check && !directFeatures/);
  assert.match(fs.readFileSync(path.join(root, 'src/native.js'), 'utf8'), /integratedFeatures: window\.__CREATOR_HUB_FEATURE_PROTOCOL__ === 1/);
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  assert.doesNotMatch(html, /data-view="plugins"|id="view-plugins"|community\.(?:js|css)|creator-plugins\.png/);
  for (const file of ['app.js', 'native.js', 'feature-pages.js', 'features/mcp.js', 'features/setup.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'src', file), 'utf8'), /community_catalogue|download_community_package|Creator-Community/);
  }
  const services = fs.readFileSync(path.join(root, 'src-tauri/src/features.rs'), 'utf8');
  assert.match(services, /"integrated": cfg!\(feature = "integrated-features"\)/);
  assert.match(services, /vec!\["setup", "mcp"\]/);
  assert.match(smoke, /if \(directTarget && !lab\) await checkUpdatedBuiltIns\(\)/);
  assert.match(smoke, /if \(fixture && !directTarget\)/);
  for (const contract of ['assertPreviousStable(report.feed.previousStable, from)', "native(child.pid, 'button', 'Not now')",
    "native(child.pid, 'button', 'Update Hub')", 'assert.equal(hash(hub), to.exe)', 'Do not manually launch the replacement',
    'assert.equal(hash(configPath), configHash)', 'assert.equal(unrelatedRuntime.exitCode, null)', 'assert.equal(hash(sentinel), sentinelHash)']) assert.ok(smoke.includes(contract));
});

test('actual target function keeps SDK reconnect for 16 and never enters hosted approvals/frames/stop controls', async () => {
  const start = smoke.indexOf('async function checkUpdatedBuiltIns() {'), end = smoke.indexOf('\nasync function installCompanions()', start);
  assert.ok(start >= 0 && end > start);
  const events = [], report = { checks: [] };
  class Client {
    async connect() { events.push('sdk-connect'); }
    async listTools() { return { tools: [{ name: 'get_mcp_reference' }] }; }
    async callTool(request) { assert.equal(request.name, 'get_mcp_reference'); return { content: [{ text: '{"success":true}' }] }; }
    async close() { events.push('sdk-close'); }
  }
  const sdk = name => name.endsWith('/stdio.js') ? { StdioClientTransport: class {} } : { Client };
  const forbidden = () => { throw Error('Legacy GUI/frame control reached by direct 16'); };
  const check = vm.runInNewContext(`processes = () => [];\n(${smoke.slice(start, end)})`, {
    assert, path, process: { env: { LOCALAPPDATA: path.resolve('fixture-local'), USERPROFILE: path.resolve('fixture-home') } },
    directTarget: true, report, page: { evaluate: async () => ({ supported: true, apps: [{ builtIn: true, trusted: true }, { builtIn: true, trusted: true }] }) },
    direct: { checkPages: async () => { events.push('direct-pages'); return {}; },
      prepareManagedRoute: async () => { events.push('native-route'); return { ...mcp(), managedRouting: true }; },
      checkCleanDocument: async () => events.push('clean-document') },
    directRequests: [], processes: () => [], managedLocations: () => ({ active: 'fixture-active', command: 'fixture-router' }),
    showApp: forbidden, readyFrame: forbidden, native: forbidden, powershell: forbidden, frames: {}, ownedPid: 123,
    out: '.', retry: fn => fn(), require: name => { assert.equal(name, 'node:module'); return { createRequire: () => sdk }; },
  });
  await check();
  assert.deepEqual(events, ['direct-pages', 'native-route', 'sdk-connect', 'sdk-close', 'sdk-connect', 'sdk-close', 'clean-document']);
  assert.equal(report.directHubUpdateTested, true); assert.equal(report.managedRouteReconnectTested, true);
  assert.equal(report.directServices.mcp.managedRouting, true);
});

test('historical hosted target function still requires both private approvals, frames, SDK reconnect and owned closure', async () => {
  const start = smoke.indexOf('async function checkUpdatedBuiltIns() {'), end = smoke.indexOf('\nasync function installCompanions()', start);
  const events = [], report = { checks: [] }, backends = {}, frames = {}, apps = {};
  const running = new Set(['setup', 'mcp']); let selected;
  for (const app of running) frames[app] = { locator: selector => ({ click: async () => events.push(`${app}:${selector}`) }) };
  class Client {
    async connect() { events.push('sdk-connect'); }
    async listTools() { return { tools: [{ name: 'get_mcp_reference' }] }; }
    async callTool() { return { content: [{ text: '{"success":true}' }] }; }
    async close() { events.push('sdk-close'); }
  }
  const sdk = name => name.endsWith('/stdio.js') ? { StdioClientTransport: class {} } : { Client };
  const check = vm.runInNewContext(`(${smoke.slice(start, end)})`, {
    assert, path, process: { env: { LOCALAPPDATA: path.resolve('fixture-local') } }, directTarget: false,
    direct: new Proxy({}, { get: () => { throw Error('Historical hosted target entered direct helper'); } }), report, apps, backends, frames,
    page: {
      evaluate: async () => ({ supported: true, apps: [{ builtIn: true, trusted: true }, { builtIn: true, trusted: true }] }),
      locator: selector => ({ click: async () => { assert.equal(selector, '#hosted-stop'); running.delete(selected); events.push(`${selected}:stop`); } }),
    },
    ownedPid: 123, showApp: async app => { selected = app; }, readyFrame: async app => events.push(`${app}:frame`),
    processes: () => [...running].map(app => ({ ParentProcessId: 123, ProcessId: app === 'setup' ? 201 : 202,
      ExecutablePath: path.resolve(app === 'setup' ? 'creator-project-setup.exe' : 'creator-works-mcp-launcher.exe') })),
    native: async (pid, action, value) => { assert.equal(pid, 123); assert.equal(action, 'button'); events.push(value); },
    powershell: async (script, args) => {
      assert.equal(script, 'scripts/native-window.ps1');
      assert.equal(args[0], '-TargetPid'); assert.equal(args[1], selected === 'setup' ? '201' : '202');
      events.push(`${selected}:${args.at(-1)}`);
    },
    retry: fn => fn(), managedLocations: () => ({ command: 'fixture-router' }),
    require: name => { assert.equal(name, 'node:module'); return { createRequire: () => sdk }; },
  });
  await check();
  assert.deepEqual(events, ['setup:Open in Hub', 'setup:frame', 'Enable managed routing', 'mcp:Enable MCP controls',
    'mcp:frame', 'mcp:#connection-guide-close', 'sdk-connect', 'sdk-close', 'sdk-connect', 'sdk-close',
    'setup:stop', 'Close view', 'mcp:stop', 'Close view']);
  assert.equal(report.managedRouteReconnectTested, true);
  assert.equal(report.directHubUpdateTested, undefined);
  assert.equal(running.size, 0);
});
