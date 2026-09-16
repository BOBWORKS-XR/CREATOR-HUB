const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { LEGACY_LIMIT, inspectFeed } = require('./check-release-feed.cjs');
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
