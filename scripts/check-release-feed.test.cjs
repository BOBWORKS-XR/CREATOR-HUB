const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { LEGACY_LIMIT, PUBLICATION_HEADROOM, inspectFeed, inspectDraft } = require('./check-release-feed.cjs');
const descriptor = 'creator-hub-windows-x86_64.json';
const release = () => ({ tag_name: 'v0.1.3', draft: false, assets: [{ name: descriptor }, { name: `${descriptor}.minisig` }] });
const bytes = items => Buffer.from(JSON.stringify(items));
test('legacy discovery gate uses original response bytes, including release body and asset metadata', () => {
  const item = release();
  assert.equal(inspectFeed(bytes([item]), '0.1.3').release, 'v0.1.3');
  item.body = 'x'.repeat(LEGACY_LIMIT);
  assert.throws(() => inspectFeed(bytes([item]), '0.1.3'), /installed Hub limit/);
  item.body = '\u00e9'.repeat(LEGACY_LIMIT / 2);
  assert.throws(() => inspectFeed(bytes([item]), '0.1.3'), /installed Hub limit/);
});
test('gate accepts exact byte limit and refuses one more byte', () => {
  const body = bytes([release()]);
  const exact = Buffer.concat([body, Buffer.alloc(LEGACY_LIMIT - body.length, 32)]);
  assert.equal(inspectFeed(exact, '0.1.3').headroom, 0);
  assert.throws(() => inspectFeed(Buffer.concat([exact, Buffer.from(' ')]), '0.1.3'), /installed Hub limit/);
});
test('draft, missing signature and unexpected version cannot satisfy publication discovery', () => {
  assert.throws(() => inspectFeed(bytes([{ ...release(), draft: true }]), '0.1.3'), /missing/);
  assert.throws(() => inspectFeed(bytes([{ ...release(), assets: [{ name: descriptor }] }]), '0.1.3'), /missing/);
  assert.throws(() => inspectFeed(bytes([release()]), '0.1.4'), /missing/);
  assert.throws(() => inspectFeed(bytes({}), '0.1.3'), /not an array/);
});
test('self-update installation harness refuses non-disposable machines before doing work', () => {
  const result = spawnSync(process.execPath, [require.resolve('./native-self-update-smoke.cjs')], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false' } });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /restricted to a disposable GitHub-hosted Windows runner/);
});

test('self-update assertions and evidence derive versions from the installer pins', () => {
  const source = require('node:fs').readFileSync(require.resolve('./native-self-update-smoke.cjs'), 'utf8');
  const assertions = source.slice(source.indexOf('const hub ='));
  // Ignore four-part loopback addresses, but reject literal versions and version regexes.
  assert.doesNotMatch(assertions, /(?<![\d.])\d+(?:\\?\.\d+){2}(?![\d.])/, 'Only the from/to pins may hardcode release versions');
});
test('draft gate accounts for full asset metadata and release notes before publication', () => {
  const current = bytes([{ ...release(), tag_name: 'v0.1.2', body: 'x'.repeat(240000) }]);
  const draft = { ...release(), draft: true, body: 'x'.repeat(24000) };
  assert.throws(() => inspectDraft(current, draft, '0.1.3'), /installed Hub limit/);
  draft.body = 'Short release notes with links to full evidence.';
  assert.ok(inspectDraft(current, draft, '0.1.3').headroom >= PUBLICATION_HEADROOM);
});
test('draft gate rejects barely-fitting updates and does not rewrite public releases', () => {
  const current = bytes([{ ...release(), tag_name: 'v0.1.2', body: 'x'.repeat(LEGACY_LIMIT - 2000) }]);
  assert.throws(() => inspectDraft(current, { ...release(), draft: true }, '0.1.3'), /publication headroom/);
  assert.throws(() => inspectDraft(bytes([release()]), { ...release(), draft: true }, '0.1.3'), /already public/);
  assert.throws(() => inspectDraft(bytes([]), release(), '0.1.3'), /unpublished draft/);
});
test('draft projection uses the same latest-ten window as installed Hub', () => {
  const current = bytes(Array.from({ length: 10 }, (_, i) => ({ ...release(), tag_name: `v0.0.${10 - i}`, body: i === 9 ? 'x'.repeat(245000) : '' })));
  const projected = inspectDraft(current, { ...release(), draft: true }, '0.1.3');
  assert.ok(projected.bytes < 5000, 'The eleventh, now-oldest release drops from the request');
  assert.equal(projected.previousStable, '0.0.10');
});
