'use strict';
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const KEY = 'creator-hub.mcp-product-review.v1';
const current = 'C:\\Users\\fixture\\AppData\\Roaming\\creator-works-mcp\\launcher-config.json';
const legacy = 'C:\\Users\\fixture\\AppData\\Roaming\\banter-mcp\\launcher-config.json';
const backup = (file, digest) => `${path.win32.dirname(file)}\\.creator-hub-settings-backups\\${path.win32.basename(file)}.${digest.repeat(64)}.bak`;
let fingerprint, recall, remember;
before(async () => {
  const helper = await import(pathToFileURL(path.resolve(__dirname, '../src/features/product-review.js')).href);
  ({ productReviewFingerprint: fingerprint, recalledProductReview: recall, rememberProductReview: remember } = helper);
});
function report(status = 'conflict') {
  return { status, currentPath: current, legacyPath: legacy,
    evidencePath: 'C:\\Users\\fixture\\AppData\\Roaming\\creator-works-mcp\\.creator-hub-product-settings',
    backups: status === 'legacy-only' ? [backup(legacy, 'b')] : [backup(current, 'a'), backup(legacy, 'b')], recovery: [] };
}
function storage(initial = null) {
  const values = new Map(initial === null ? [] : [[KEY, initial]]);
  const calls = [];
  return { values, calls,
    getItem(key) { calls.push(['get', key]); return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { calls.push(['set', key, value]); values.set(key, value); },
  };
}

test('exact conflict and legacy-only reports have stable, complete backup identities', () => {
  for (const status of ['conflict', 'legacy-only']) {
    const value = report(status), result = fingerprint(value);
    assert.equal(typeof result, 'string'); assert.ok(result.length > 0);
    assert.equal(fingerprint(structuredClone(value)), result);
    assert.equal(fingerprint({ ...value, approved: true }), result, 'Approval is a separate caller decision');
    assert.equal(fingerprint({ ...value, backups: [...value.backups].reverse() }), result);
  }
});

test('no stored approval is inferred from complete existing backups or completed history', () => {
  const value = report();
  value.recovery = [{ historical_completed: true, completed: true, history_only: false, files: [] }];
  const saved = storage(); assert.equal(recall(value, saved), false);
  assert.equal(saved.calls.some(([kind]) => kind === 'set'), false);
  assert.equal(saved.values.size, 0);
});

test('fingerprint refuses unsupported status, malformed collections and missing backup coverage', () => {
  for (const value of [null, {}, report('none'), report('current'), report('identical'),
    { ...report(), backups: null }, { ...report(), recovery: null }, { ...report(), backups: [] },
    { ...report(), backups: [backup(current, 'a')] }, { ...report(), backups: [backup(legacy, 'b')] },
    { ...report(), backups: [...report().backups, backup(current, 'c')] },
    { ...report(), backups: [backup(current, 'a'), backup(current, 'a')] },
    { ...report('legacy-only'), backups: report().backups }, { ...report(), legacyPath: current }]) {
    assert.equal(fingerprint(value), null);
  }
});

test('fingerprint requires exact backup directory, basename, lowercase hash and suffix', () => {
  const correct = backup(current, 'a');
  for (const invalid of [null, 42, correct.replace('.creator-hub-settings-backups', 'other'),
    correct.replace('launcher-config.json.', 'other.json.'), correct.replace('a'.repeat(64), 'a'.repeat(63)),
    correct.replace('a'.repeat(64), 'a'.repeat(65)), correct.replace('a'.repeat(64), 'A'.repeat(64)),
    correct.replace('a'.repeat(64), 'g'.repeat(64)), correct + '.extra', correct.replace(/\.bak$/, '.BAK'),
    'C:\\other\\.creator-hub-settings-backups\\' + path.win32.basename(correct)]) {
    assert.equal(fingerprint({ ...report(), backups: [invalid, backup(legacy, 'b')] }), null);
  }
});

const invalidPaths = [
  ['empty', ''], ['null', null], ['non-string', 4],
  ['relative', 'relative/launcher-config.json'], ['drive-relative', 'C:relative/launcher-config.json'],
  ['parent segment', 'C:\\Users\\fixture\\..\\launcher-config.json'],
  ['dot segment', 'C:\\Users\\fixture\\.\\launcher-config.json'],
  ['control character', 'C:\\Users\\fixture\\launcher-config.json\n'], ['oversized', 'x'.repeat(4097)],
];
for (const key of ['currentPath', 'legacyPath']) for (const [label, value] of invalidPaths) {
  test(`legacy-only report refuses ${label} ${key}`, () => {
    const sample = report('legacy-only'); sample[key] = value;
    if (key === 'legacyPath' && typeof value === 'string') sample.backups = [backup(value, 'b')];
    assert.equal(fingerprint(sample), null, `${key}: ${JSON.stringify(value)}`);
  });
}

test('pending or malformed recovery never qualifies even alongside completed history', () => {
  for (const recovery of [[null], [{}], [{ historical_completed: false, completed: true }],
    [{ historical_completed: true }, { historical_completed: false }]]) {
    const value = { ...report(), recovery };
    assert.equal(fingerprint(value), null); assert.equal(recall(value, storage()), false);
    assert.throws(() => remember(value, storage()));
  }
});

test('remember writes only its key and exact readback recalls across independent mounts', () => {
  for (const status of ['conflict', 'legacy-only']) {
    const value = report(status), saved = storage();
    saved.values.set('unrelated', 'preserved');
    remember(value, saved);
    assert.equal(saved.calls.filter(([kind]) => kind === 'set').length, 1);
    assert.equal(saved.calls.find(([kind]) => kind === 'set')[1], KEY);
    assert.equal(saved.values.get('unrelated'), 'preserved');
    const mounted = storage(saved.values.get(KEY));
    assert.equal(recall(structuredClone(value), mounted), true);
    assert.equal(mounted.calls.some(([kind]) => kind === 'set'), false);
  }
});

test('valid receipt mismatch is false and never renewed by a status read', () => {
  const saved = storage(); remember(report(), saved);
  const original = saved.values.get(KEY), beforeSets = saved.calls.filter(([kind]) => kind === 'set').length;
  for (const value of [report('legacy-only'), { ...report(), backups: [backup(current, 'c'), backup(legacy, 'b')] },
    { ...report(), currentPath: current.replace('fixture', 'other'), backups: [backup(current.replace('fixture', 'other'), 'a'), backup(legacy, 'b')] }]) {
    assert.equal(recall(value, saved), false); assert.equal(saved.values.get(KEY), original);
  }
  assert.equal(saved.calls.filter(([kind]) => kind === 'set').length, beforeSets);
});

for (const [label, raw] of [['empty', ''], ['invalid JSON', 'not-json'], ['oversized', 'x'.repeat(32769)],
  ['null', 'null'], ['array', '[]'], ['missing fields', '{}'],
  ['wrong version', JSON.stringify({ version: 2, fingerprint: 'unused' })],
  ['non-string fingerprint', JSON.stringify({ version: 1, fingerprint: 7 })]]) {
  test(`malformed stored receipt ${label} throws instead of becoming approval or mismatch`, () => {
    assert.throws(() => recall(report(), storage(raw)), raw.slice(0, 100));
  });
}
test('extra stored receipt fields are not accepted as the exact versioned schema', () => {
  const raw = JSON.stringify({ version: 1, fingerprint: fingerprint(report()), extra: true });
  assert.throws(() => recall(report(), storage(raw)));
});

test('storage read exceptions propagate and invalid reports never write', () => {
  const unavailable = { getItem() { throw Error('Storage unavailable'); }, setItem() { assert.fail('Unexpected write'); } };
  assert.throws(() => recall(report(), unavailable), /Storage unavailable/);
  for (const value of [null, report('current'), { ...report(), backups: [] },
    { ...report(), recovery: [{ historical_completed: false }] }]) {
    const saved = storage(); assert.throws(() => remember(value, saved));
    assert.equal(saved.calls.length, 0);
  }
});

test('remember propagates write/read failures and rejects unconfirmed or changed readback', () => {
  assert.throws(() => remember(report(), { setItem() { throw Error('Quota exceeded'); } }), /Quota exceeded/);
  assert.throws(() => remember(report(), { setItem() {}, getItem() { throw Error('Readback failed'); } }), /Readback failed/);
  for (const returned of [null, '', 'changed']) {
    assert.throws(() => remember(report(), { setItem() {}, getItem() { return returned; } }));
  }
});

test('fingerprinting and storage do not mutate the native report', () => {
  const value = report(), original = structuredClone(value), saved = storage();
  Object.freeze(value.backups); Object.freeze(value.recovery); Object.freeze(value);
  fingerprint(value); remember(value, saved); assert.equal(recall(value, saved), true);
  assert.deepEqual(value, original);
});
