const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../src/convergence.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const report = (changes = {}) => ({ enabled: true, required: true, stage: 'review', settings: ['creator-works-mcp/launcher-config.json'],
  legacyApps: [{ name: 'Creator Works MCP', path: 'C:\\Disposable\\MCP\\launcher.exe' }], backups: [], message: 'Review the existing installation.', ...changes });

function fixture(handler = () => report(), capability = true) {
  class Element {
    constructor() { this.listeners = new Map(); this.children = []; this.hidden = false; this.disabled = false; this.inert = false;
      this.open = false; this.textContent = ''; this.attributes = {}; this.isConnected = true; this.shown = 0; this.closed = 0; }
    set innerHTML(_) { assert.fail('Native strings must never enter HTML'); }
    addEventListener(type, listener) { const set = this.listeners.get(type) || new Set(); set.add(listener); this.listeners.set(type, set); }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    dispatch(type) { const event = { prevented: false, preventDefault() { this.prevented = true; } };
      for (const listener of [...(this.listeners.get(type) || [])]) listener(event); return event; }
    replaceChildren(...children) { this.children = children; }
    setAttribute(key, value) { this.attributes[key] = value; }
    showModal() { this.open = true; this.shown++; }
    close() { this.open = false; this.closed++; }
    focus() { document.activeElement = this; }
  }
  const elements = Object.fromEntries(['dialog', 'title', 'summary', 'details', 'error', 'prepare', 'connections', 'later'].map(id => [id, new Element()]));
  const main = new Element(), alreadyLocked = new Element(), focus = new Element(); alreadyLocked.inert = true;
  const calls = []; let lookups = 0;
  const document = { body: { children: [main, elements.dialog, alreadyLocked] }, activeElement: focus,
    querySelector(selector) { lookups++; return elements[selector.replace('#convergence-', '')] || null; },
    createElement(name) { assert.equal(name, 'li'); return new Element(); } };
  const native = { invoke(command, ...args) {
    assert.ok(['convergence_status', 'prepare_convergence', 'migrate_convergence_connections'].includes(command), 'No cleanup, client paths or generic commands');
    assert.deepEqual(args, [], 'No renderer paths, reports or client selections are native arguments');
    calls.push(command); return handler(command);
  } };
  if (capability !== undefined) native.convergencePersistence = capability;
  const window = { CreatorHubNative: native };
  vm.runInNewContext(source, { window, document });
  return { window, native, document, elements, main, alreadyLocked, focus, calls, lookups: () => lookups,
    click: id => elements[id].dispatch('click') };
}

test('loading the controller performs no reads, mutations or modal work', () => {
  const f = fixture(); assert.deepEqual(f.calls, []); assert.equal(f.lookups(), 0); assert.equal(f.elements.dialog.shown, 0);
});
test('missing/false/unknown capability never inspects DOM or invokes native commands', async () => {
  for (const value of [undefined, false, 1, 'true']) {
    const f = fixture(() => { assert.fail('Native capability absent'); }, value);
    if (value === undefined) delete f.native.convergencePersistence;
    await f.window.CreatorConvergence.run(); assert.deepEqual(f.calls, []); assert.equal(f.lookups(), 0);
  }
  const f = fixture(); delete f.window.CreatorHubNative;
  await f.window.CreatorConvergence.run(); assert.deepEqual(f.calls, []);
});
test('no required migration or disabled native support resolves without opening a guide', async () => {
  for (const status of [report({ required: false, settings: [], legacyApps: [] }), report({ enabled: false, required: false })]) {
    const f = fixture(() => status); await f.window.CreatorConvergence.run();
    assert.deepEqual(f.calls, ['convergence_status']); assert.equal(f.lookups(), 0); assert.equal(f.main.inert, false);
  }
});
test('initial status is awaited and concurrent runs share one read and one promise', async () => {
  const wait = deferred(), f = fixture(() => wait.promise);
  const a = f.window.CreatorConvergence.run(), b = f.window.CreatorConvergence.run();
  assert.equal(a, b); assert.deepEqual(f.calls, ['convergence_status']); assert.equal(f.elements.dialog.shown, 0);
  wait.resolve(report()); await tick(); assert.equal(f.elements.dialog.shown, 1);
  f.click('later'); await a;
});
test('required guide with no legacy binaries still honors native store review', async () => {
  const f = fixture(() => report({ legacyApps: [] })); const done = f.window.CreatorConvergence.run(); await tick();
  assert.equal(f.elements.dialog.open, true); assert.equal(f.elements.prepare.disabled, false);
  assert.equal(f.elements.details.children.length, 1); f.click('later'); await done;
  assert.deepEqual(f.calls, ['convergence_status']);
});
test('Later and Escape cannot fabricate a native decision; inert state and focus are preserved', async () => {
  const f = fixture(); const done = f.window.CreatorConvergence.run(); await tick();
  assert.equal(f.main.inert, true); assert.equal(f.alreadyLocked.inert, true);
  assert.equal(f.elements.dialog.dispatch('cancel').prevented, true); assert.equal(f.elements.dialog.open, true);
  assert.equal(f.click('later').prevented, true); await done;
  assert.deepEqual(f.calls, ['convergence_status']); assert.equal(f.main.inert, false); assert.equal(f.alreadyLocked.inert, true);
  assert.equal(f.document.activeElement, f.focus); assert.equal(f.elements.dialog.closed, 1);
  f.click('prepare'); f.click('connections'); f.click('later'); assert.deepEqual(f.calls, ['convergence_status']);
});
test('only explicit buttons advance two native phases and reviewed connections never imply cleanup', async () => {
  const f = fixture(command => command === 'prepare_convergence' ? report({ stage: 'backed-up', backups: ['exact.bak'] })
    : command === 'migrate_convergence_connections' ? report({ stage: 'connections-reviewed', message: 'Native connections reviewed.' }) : report());
  let settled = false; const done = f.window.CreatorConvergence.run().then(() => { settled = true; }); await tick();
  assert.equal(f.elements.prepare.textContent, 'Back up and continue'); assert.equal(f.elements.connections.hidden, true);
  f.click('connections'); assert.deepEqual(f.calls, ['convergence_status']);
  f.click('prepare'); await tick(); assert.equal(f.elements.prepare.hidden, true); assert.equal(f.elements.connections.hidden, false);
  f.click('prepare'); f.click('connections'); await tick();
  assert.deepEqual(f.calls, ['convergence_status', 'prepare_convergence', 'migrate_convergence_connections']);
  assert.equal(f.elements.connections.textContent, 'Move existing connections'); assert.equal(settled, false);
  assert.match(f.elements.summary.textContent, /remain installed/); assert.match(f.elements.summary.textContent, /pending/);
  assert.doesNotMatch(f.elements.title.textContent + f.elements.summary.textContent, /finished|ready|completed/i);
  assert.equal(f.elements.prepare.hidden, true); assert.equal(f.elements.connections.hidden, true); assert.equal(f.elements.dialog.open, true);
  f.click('later'); await done;
});
for (const phase of ['prepare_convergence', 'migrate_convergence_connections']) test(`${phase} in-flight clicks cannot duplicate or dismiss native work`, async () => {
  const wait = deferred(); const f = fixture(command => command === 'convergence_status'
    ? report({ stage: phase === 'prepare_convergence' ? 'review' : 'backed-up' }) : wait.promise);
  let settled = false; const done = f.window.CreatorConvergence.run().then(() => { settled = true; }); await tick();
  const button = phase === 'prepare_convergence' ? 'prepare' : 'connections';
  f.click(button); f.click(button); f.click('later'); f.click(button);
  assert.deepEqual(f.calls, ['convergence_status', phase]); assert.equal(settled, false);
  assert.equal(f.elements.prepare.disabled, true); assert.equal(f.elements.connections.disabled, true); assert.equal(f.elements.later.disabled, true);
  assert.equal(f.elements.dialog.attributes['aria-busy'], 'true');
  wait.resolve(report({ stage: phase === 'prepare_convergence' ? 'backed-up' : 'connections-reviewed' })); await tick();
  assert.equal(f.elements.later.disabled, false); f.click('later'); await done;
});
for (const stage of ['review', 'backed-up']) test(`native cancellation at ${stage} stays retryable without next-phase calls`, async () => {
  const f = fixture(() => report({ stage, message: 'Cancelled. Existing files were kept.' }));
  const done = f.window.CreatorConvergence.run(); await tick(); f.click(stage === 'review' ? 'prepare' : 'connections'); await tick();
  assert.equal(f.elements.dialog.open, true); assert.equal(f.elements.error.hidden, true);
  assert.match(f.elements.summary.textContent, /Cancelled/);
  assert.deepEqual(f.calls, ['convergence_status', stage === 'review' ? 'prepare_convergence' : 'migrate_convergence_connections']);
  f.click('later'); await done;
});
for (const stage of ['review', 'backed-up']) test(`native ${stage} failure remains modal and can retry only explicitly`, async () => {
  let attempts = 0;
  const f = fixture(command => command === 'convergence_status' ? report({ stage })
    : ++attempts === 1 ? Promise.reject(Error('Snapshot changed; original kept.')) : report({ stage: stage === 'review' ? 'backed-up' : 'connections-reviewed' }));
  let settled = false; const done = f.window.CreatorConvergence.run().then(() => { settled = true; }); await tick();
  const button = stage === 'review' ? 'prepare' : 'connections'; f.click(button); await tick();
  assert.equal(f.elements.dialog.open, true); assert.equal(settled, false); assert.equal(f.elements.error.hidden, false);
  assert.match(f.elements.error.textContent, /Snapshot changed/); assert.equal(f.elements[button].disabled, false);
  f.click(button); await tick(); assert.equal(attempts, 2); assert.equal(f.elements.error.hidden, true);
  f.click('later'); await done;
});
test('status read failure remains modal with mutations disabled and Later available', async () => {
  const f = fixture(() => Promise.reject(Error('Store is unreadable'))); const done = f.window.CreatorConvergence.run(); await tick();
  assert.equal(f.elements.dialog.open, true); assert.equal(f.elements.error.hidden, false);
  assert.equal(f.elements.prepare.disabled, true); assert.equal(f.elements.connections.disabled, true); assert.equal(f.elements.later.disabled, false);
  f.click('prepare'); f.click('connections'); assert.deepEqual(f.calls, ['convergence_status']); f.click('later'); await done;
});
test('unknown, malformed and oversized initial reports cannot enable mutations', async () => {
  for (const status of [report({ stage: 'finished' }), report({ required: 'true' }), report({ settings: null }),
    report({ backups: [null] }), report({ legacyApps: [{ name: 'MCP', path: {} }] }), report({ message: 'x'.repeat(8193) })]) {
    const f = fixture(() => status), done = f.window.CreatorConvergence.run(); await tick();
    assert.equal(f.elements.dialog.open, true); assert.equal(f.elements.prepare.disabled, true); assert.equal(f.elements.error.hidden, false);
    f.click('prepare'); assert.deepEqual(f.calls, ['convergence_status']); f.click('later'); await done;
  }
});
test('unexpected native phase transition is refused without enabling another action', async () => {
  const f = fixture(command => command === 'convergence_status' ? report() : report({ stage: 'connections-reviewed' }));
  const done = f.window.CreatorConvergence.run(); await tick(); f.click('prepare'); await tick();
  assert.equal(f.elements.error.hidden, false); assert.equal(f.elements.connections.hidden, true);
  assert.match(f.elements.error.textContent, /phase changed/); f.click('later'); await done;
});
test('native strings stay text, and reviewed-with-required-false still does not auto-finish', async () => {
  const f = fixture(command => command === 'convergence_status' ? report({ stage: 'backed-up', settings: ['<script>never HTML</script>'] })
    : report({ stage: 'connections-reviewed', required: false, message: 'Finished' }));
  let settled = false; const done = f.window.CreatorConvergence.run().then(() => { settled = true; }); await tick();
  assert.equal(f.elements.details.children[0].textContent, 'Settings: <script>never HTML</script>');
  f.click('connections'); await tick(); assert.equal(settled, false); assert.equal(f.elements.dialog.open, true);
  assert.doesNotMatch(f.elements.summary.textContent, /Finished/); f.click('later'); await done;
});
test('reopening the guide refreshes native state and installs no duplicate listeners', async () => {
  const f = fixture();
  for (let attempt = 0; attempt < 2; attempt++) {
    const done = f.window.CreatorConvergence.run(); await tick(); f.click('later'); await done;
    assert.equal(f.elements.prepare.listeners.get('click').size, 0);
  }
  assert.deepEqual(f.calls, ['convergence_status', 'convergence_status']); assert.equal(f.elements.dialog.shown, 2);
});
test('reviewed state with no legacy apps does not invent an installed app or cleanup completion', async () => {
  const f = fixture(() => report({ stage: 'connections-reviewed', legacyApps: [] }));
  const done = f.window.CreatorConvergence.run(); await tick();
  assert.doesNotMatch(f.elements.summary.textContent, /remain installed|finished|ready|completed/i);
  assert.match(f.elements.summary.textContent, /pending/); assert.equal(f.elements.dialog.open, true);
  assert.deepEqual(f.calls, ['convergence_status']); f.click('later'); await done;
});
test('native capability replacement while the guide is open refuses mutation', async () => {
  const f = fixture(), done = f.window.CreatorConvergence.run(); await tick();
  f.window.CreatorHubNative = { convergencePersistence: false, invoke() { assert.fail('Unexpected replacement invocation'); } };
  f.click('prepare'); await tick(); assert.deepEqual(f.calls, ['convergence_status']); assert.equal(f.elements.error.hidden, false);
  f.click('later'); await done;
});
test('missing modal nodes reject without mutations; unavailable modal restores inert state', async () => {
  const f = fixture(); delete f.elements.details;
  await assert.rejects(f.window.CreatorConvergence.run(), /guide is unavailable/); assert.deepEqual(f.calls, ['convergence_status']);
  const other = fixture(); other.elements.dialog.showModal = () => { throw Error('Modal unavailable'); };
  await assert.rejects(other.window.CreatorConvergence.run(), /Modal unavailable/);
  assert.equal(other.main.inert, false); assert.equal(other.alreadyLocked.inert, true); assert.equal(other.elements.prepare.listeners.get('click').size, 0);
});
