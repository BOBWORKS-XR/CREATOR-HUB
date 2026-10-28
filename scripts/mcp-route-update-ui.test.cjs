'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'src/mcp-route-update.js'), 'utf8');
function model() { const window = {}; vm.runInNewContext(script, { window }); return window.CreatorMcpRouteUpdate.create(); }
const prior = overrides => ({ schemaVersion: 1, outcome: 'legacy-review-required', route: 'verified-prior', targetVersion: '0.1.17',
  intentSha256: null, targetExecutableSha256: null, handoffPath: null, expectedGeneration: 'b'.repeat(64), activeGeneration: 'a'.repeat(64),
  reason: 'Legacy sender did not provide a handoff.', recovery: 'explicit-client-apply', ...overrides });
const unknown = overrides => prior({ outcome: 'review-required', route: 'unknown', activeGeneration: null, recovery: 'read-only-recheck', ...overrides });
const target = outcome => prior({ route: 'verified-target', outcome, activeGeneration: 'b'.repeat(64), reason: null, recovery: 'none' });

test('absence is quiet before any relevant route failure', () => {
  const state = model(); state.observe(undefined); state.failed('Offline metadata'); assert.equal(state.view().visible, false);
});
test('verified legacy prior exposes navigation and selected-client guidance, not an Apply mutation', () => {
  const state = model(); state.observe(prior());
  assert.equal(state.view().visible, true); assert.equal(state.view().canReview, true);
  assert.match(state.view().advice, /Apply to one existing AI client/);
  assert.equal(state.view().title, 'MCP update needs review');
  assert.match(state.view().message, /previous MCP tools/);
  assert.equal(typeof state.apply, 'undefined');
});
test('verified failed prior exposes existing explicit client review', () => {
  const state = model(); state.observe(prior({ outcome: 'review-required', intentSha256: 'c'.repeat(64) }));
  assert.equal(state.view().canReview, true);
});
test('not-attempted verified prior is read-only, not consent to retry', () => {
  const state = model(); state.observe(prior({ outcome: 'not-attempted', recovery: 'read-only-recheck' }));
  assert.equal(state.view().visible, true); assert.equal(state.view().canReview, false);
});
test('unknown never claims an active prior and offers only read-only recheck', () => {
  const state = model(); state.observe(unknown());
  assert.equal(state.view().canReview, false); assert.match(state.view().message, /could not be confirmed/);
  assert.equal(state.view().identities.some(line => line.startsWith('Active generation')), false);
});
for (const outcome of ['activated', 'known-committed']) test(`verified exact target ${outcome} clears a prior notice`, () => {
  const state = model(); state.observe(prior()); state.observe(target(outcome)); assert.equal(state.view().visible, false);
});
test('inconsistent success and unsupported schema are visible unknown, never silent success', () => {
  for (const value of [target('other'), { ...target('activated'), schemaVersion: 2 }, { ...target('activated'), activeGeneration: 'a'.repeat(64) }]) {
    const state = model(); state.observe(value); assert.equal(state.view().visible, true); assert.equal(state.view().canReview, false);
  }
});
test('missing outcome cannot prove success after legacy failure', () => {
  const state = model(); state.observe(prior()); state.observe(undefined);
  assert.equal(state.view().visible, true); assert.equal(state.view().canReview, false); assert.match(state.view().issue, /No route outcome/);
});
test('status read failure retains last evidence but removes unsafe Apply advice', () => {
  const state = model(); state.observe(prior()); state.failed(Error('Manager busy'));
  assert.equal(state.view().visible, true); assert.equal(state.view().canReview, false);
  assert.match(state.view().identities.join('\n'), /Last reported generation/);
  state.observe(prior()); assert.equal(state.view().canReview, true);
});
test('malformed read preserves the last notice and cannot hide it', () => {
  const state = model(); state.observe(prior()); state.observe({ outcome: 'activated' });
  assert.equal(state.view().visible, true); assert.equal(state.view().canReview, false);
});
test('reason text stays literal and bounded; input changes cannot change retained identity', () => {
  const state = model(), value = prior({ reason: '<img src=x onerror=alert(1)>' + '\u{1f600}'.repeat(400) });
  state.observe(value); value.activeGeneration = 'd'.repeat(64);
  assert.equal(state.view().reason.startsWith('<img'), true); assert.ok(Array.from(state.view().reason).length <= 512);
  assert.match(state.view().identities.join('\n'), new RegExp('a'.repeat(64)));
});
test('subscriptions and checking state do not activate or discard notices', () => {
  const state = model(); let calls = 0; const dispose = state.subscribe(() => calls++);
  state.observe(prior()); state.checking(true); state.checking(false); assert.equal(state.view().visible, true);
  dispose(); const count = calls; state.observe(unknown()); assert.equal(calls, count);
});
test('shared notices load before the shell; MCP notice is outside saved settings controls', () => {
  const html = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
  assert.ok(html.indexOf('src="mcp-route-update.js"') < html.indexOf('src="feature-pages.js"'));
  const mcp = fs.readFileSync(path.join(root, 'src/features/mcp.js'), 'utf8');
  assert.ok(mcp.indexOf('data-field="route-update"') < mcp.indexOf('data-field="product-panel"'));
  assert.ok(mcp.indexOf('data-field="route-update"') < mcp.indexOf('<fieldset'));
});

test('verified-current clears a legacy notice only for positive matching target proof', () => {
  const state = model(); state.observe(prior());
  state.observe(target('verified-current'));
  assert.equal(state.view().visible, false);
});
test('verified-current rejects wrong routes, incomplete or invalid generations, and non-none recovery', () => {
  const invalid = [
    { route: 'verified-prior' }, { route: 'unknown' },
    { expectedGeneration: undefined }, { activeGeneration: undefined },
    { expectedGeneration: null, activeGeneration: null }, { expectedGeneration: '', activeGeneration: '' },
    { expectedGeneration: 'b'.repeat(63), activeGeneration: 'b'.repeat(63) },
    { expectedGeneration: 'g'.repeat(64), activeGeneration: 'g'.repeat(64) },
    { expectedGeneration: 'B'.repeat(64), activeGeneration: 'B'.repeat(64) },
    { activeGeneration: 'a'.repeat(64) }, { recovery: 'explicit-client-apply' }, { recovery: 'read-only-recheck' },
    { schemaVersion: 2 }, { targetVersion: null }, { targetVersion: '' },
  ];
  for (const overrides of invalid) {
    const state = model(); state.observe(prior()); state.observe({ ...target('verified-current'), ...overrides });
    assert.equal(state.view().visible, true, JSON.stringify(overrides));
    assert.equal(state.view().canReview, false, JSON.stringify(overrides));
  }
});
test('verified-current still requires Root readback after explicit Apply; absence is not success', () => {
  const state = model(); state.observe(prior());
  for (const missing of [undefined, null]) {
    state.observe(missing); assert.equal(state.view().visible, true); assert.equal(state.view().canReview, false);
  }
  state.observe(target('verified-current')); assert.equal(state.view().visible, false);
});

test('hub-only guidance retains malicious text literally without granting recovery actions', () => {
  const value = unknown({ hubOnlyManualInstall: '<img src=x onerror="alert(1)"><a href="javascript:alert(1)">Hub-only install</a>' });
  const expected = value.hubOnlyManualInstall, state = model(); state.observe(value);
  value.hubOnlyManualInstall = 'Changed after readback';
  assert.equal(state.view().hubOnlyManualInstall, expected);
  assert.equal(state.view().visible, true); assert.equal(state.view().canReview, false);
  assert.equal(typeof state.install, 'undefined');
});
test('hub-only guidance bounds oversize strings without splitting a Unicode pair', () => {
  const expected = 'x'.repeat(511) + '\u{1f600}', state = model();
  state.observe(unknown({ hubOnlyManualInstall: expected + 'oversize'.repeat(10000) }));
  assert.equal(state.view().hubOnlyManualInstall, expected);
  assert.equal(Array.from(state.view().hubOnlyManualInstall).length, 512);
  assert.ok(Buffer.byteLength(state.view().hubOnlyManualInstall, 'utf8') <= 2048);
  assert.equal(state.view().canReview, false);
});
test('hub-only guidance ignores optional null, absent and non-string values', () => {
  for (const guidance of [undefined, null, {}, [], 42, false]) {
    const state = model(); state.observe(unknown({ hubOnlyManualInstall: guidance }));
    assert.equal(state.view().hubOnlyManualInstall, '');
    assert.equal(state.view().visible, true); assert.equal(state.view().canReview, false);
  }
});
test('hub-only guidance null on resolved readback does not restore a warning', () => {
  const state = model(); state.observe(unknown({ hubOnlyManualInstall: 'Keep retained evidence; install only a verified Hub package.' }));
  state.observe({ ...target('verified-current'), hubOnlyManualInstall: null });
  assert.equal(state.view().visible, false); assert.equal(state.view().hubOnlyManualInstall, '');
  state.observe(undefined); state.failed('Unrelated later read failed');
  assert.equal(state.view().visible, false); assert.equal(state.view().hubOnlyManualInstall, '');
  state.observe({ ...target('known-committed'), hubOnlyManualInstall: '<img src=x>' });
  assert.equal(state.view().visible, false); assert.equal(state.view().hubOnlyManualInstall, '');
});
