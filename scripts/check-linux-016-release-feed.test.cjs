'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('./check-linux-016-release-feed.cjs');
function fixture() {
  const names = require('./linux-016-release-qualification.cjs').assetNames();
  const assets = Object.fromEntries(names.map((n, i) => [n, { id: i + 100, size: 10, sha256: String(i % 10).repeat(64) }]));
  const row = (name, p, version = '0.1.16') => ({ id: p.id, name, size: p.size, digest: 'sha256:' + p.sha256,
    state: 'uploaded', browser_download_url: `https://github.com/${f.REPO}/releases/download/v${version}/${name}` });
  const latest = { id: 14, tag_name: 'v0.1.14', target_commitish: 'a'.repeat(40), draft: false, prerelease: false,
    assets: [f.WINDOWS, f.WINDOWS + '.minisig', 'old.exe'].map((n, i) => row(n, { id: 50 + i, size: 100, sha256: 'b'.repeat(64) }, '0.1.14')) };
  const draft = { id: 16, tag_name: 'v0.1.16', draft: true, prerelease: false, body: 'Linux only', assets: names.map(n => row(n, assets[n])) };
  const qualification = { draft: { id: 16, assets }, windows: f.stableIdentity(latest) };
  return { qualification, latest, draft, bytes: Buffer.from(JSON.stringify([latest])) };
}
module.exports = { fixture };
if (require.main === module) {
  test('projects the full Linux row without changing Windows discovery/latest', () => {
    const x = fixture(), before = f.windowsSelection(JSON.parse(x.bytes));
    const result = f.inspectDraft(x.bytes, x.draft, x.latest, x.qualification);
    assert.equal(result.ready, false); assert.ok(result.headroom >= 4096);
    const live = Buffer.from(JSON.stringify([{ ...x.draft, draft: false }, x.latest]));
    assert.deepEqual(f.windowsSelection(JSON.parse(live)), before);
    assert.equal(f.inspectLive(live, x.latest, x.qualification).publicAcceptance, false);
  });
  test('preserves every existing release field in size/headroom calculations', () => {
    const x = fixture(); x.draft.body = 'x'.repeat(255 * 1024);
    assert.throws(() => f.inspectDraft(x.bytes, x.draft, x.latest, x.qualification), /headroom/);
    assert.throws(() => f.releases(Buffer.alloc(256 * 1024 + 1)), /256 KiB/);
    x.draft.body = ''; const pad = Buffer.alloc(254 * 1024, 32);
    assert.throws(() => f.inspectDraft(Buffer.concat([x.bytes, pad]), x.draft, x.latest, x.qualification), /headroom/);
  });
  test('Windows latest, original assets, and latest-ten visibility are mandatory', () => {
    for (const mutate of [x => { x.latest.id++; }, x => { x.latest.assets[0].digest = 'sha256:' + 'e'.repeat(64); },
      x => { x.latest.tag_name = 'v0.1.16'; }, x => { x.latest.assets[0].id++; }]) {
      const x = fixture(); mutate(x); assert.throws(() => f.inspectDraft(x.bytes, x.draft, x.latest, x.qualification));
    }
    const x = fixture(); const rows = Array.from({ length: 9 }, (_, i) => ({ id: i + 1000, tag_name: `v0.1.${20 + i}`, draft: false, prerelease: false, assets: [] }));
    assert.throws(() => f.inspectDraft(Buffer.from(JSON.stringify([...rows, x.latest])), x.draft, x.latest, x.qualification), /fell outside/);
  });
  test('unknown, duplicate, private, missing, changed and redirected product assets refuse', () => {
    for (const mutate of [x => x.draft.assets.pop(), x => x.draft.assets.push(x.draft.assets[0]),
      x => { x.draft.assets[0].name = 'private017.zip'; }, x => { x.draft.assets[0].size++; },
      x => { x.draft.assets[0].browser_download_url = 'https://example.invalid/a'; },
      x => { x.draft.assets[0].digest = null; }, x => { x.draft.id++; }, x => { x.draft.prerelease = true; }]) {
      const x = fixture(); mutate(x); assert.throws(() => f.inspectDraft(x.bytes, x.draft, x.latest, x.qualification));
    }
  });
  test('already public, wrong visible row and incomplete Windows catalog cannot be adopted', () => {
    const x = fixture(); assert.throws(() => f.inspectDraft(Buffer.from(JSON.stringify([x.latest, x.draft])), x.draft, x.latest, x.qualification), /already public/);
    assert.throws(() => f.inspectLive(x.bytes, x.latest, x.qualification), /not visible/);
    const old = structuredClone(x.latest); old.assets.shift();
    assert.throws(() => f.inspectDraft(Buffer.from(JSON.stringify([old])), x.draft, x.latest, x.qualification), /discovery/);
  });
  test('public feed uses no authenticated draft inventory and enforces the bound while reading', async t => {
    let call, parts = [Buffer.from('[]')], status = 200;
    t.mock.method(global, 'fetch', async (url, options) => { call = { url, options }; return { status, body: (async function* () { yield* parts; })() }; });
    assert.equal((await f.readLiveFeed()).toString(), '[]');
    assert.equal(call.url, `https://api.github.com/repos/${f.REPO}/releases?per_page=10`);
    assert.deepEqual(call.options.headers, { 'User-Agent': 'Creator-Hub/0.1' }); assert.equal(call.options.redirect, 'error');
    assert.ok(call.options.signal); parts = [Buffer.alloc(256 * 1024), Buffer.alloc(1)];
    await assert.rejects(f.readLiveFeed(), /256 KiB/); status = 403; await assert.rejects(f.readLiveFeed(), /unavailable/);
  });
}
