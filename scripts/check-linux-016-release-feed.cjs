'use strict';
// Separate finite Linux016 route. Never changes the Windows feed contract.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { LEGACY_LIMIT, PUBLICATION_HEADROOM } = require('./check-release-feed.cjs');
const REPO = 'BOBWORKS-XR/CREATOR-HUB';
const VERSION = '0.1.16';
const CATALOG = 'creator-hub-linux-x86_64.json';
const PORTABLE = 'creator-hub-linux-x86_64-portable.json';
const WINDOWS = 'creator-hub-windows-x86_64.json';
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function releases(bytes) {
  assert.ok(Buffer.isBuffer(bytes) && bytes.length <= LEGACY_LIMIT, 'Full installed-client feed exceeds 256 KiB');
  const rows = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  assert.ok(Array.isArray(rows) && rows.length <= 10, 'Exact latest-ten feed required');
  assert.equal(new Set(rows.map(r => r.id)).size, rows.length, 'Duplicate release ID');
  for (const r of rows) assert.ok(r && Array.isArray(r.assets) && typeof r.tag_name === 'string');
  return rows;
}
function windowsSelection(rows) {
  return rows.filter(r => r.draft === false && r.prerelease === false
    && /^v0\.1\.(?:0|[1-9][0-9]*)$/.test(r.tag_name)
    && [WINDOWS, WINDOWS + '.minisig'].every(n => r.assets.some(a => a.name === n)))
    .map(r => ({ id: r.id, version: r.tag_name, assets: r.assets.filter(a => a.name === WINDOWS || a.name === WINDOWS + '.minisig')
      .map(a => ({ id: a.id, name: a.name, size: a.size, digest: a.digest })).sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => Number(b.version.slice(5)) - Number(a.version.slice(5)))[0] || null;
}
function stableIdentity(record) {
  assert.equal(record.tag_name, 'v0.1.14'); assert.equal(record.draft, false); assert.equal(record.prerelease, false);
  assert.ok(Number.isSafeInteger(record.id) && record.id > 0 && Array.isArray(record.assets));
  assert.equal(new Set(record.assets.map(a => a.name)).size, record.assets.length);
  return { id: record.id, tag: record.tag_name, target: record.target_commitish,
    assets: record.assets.map(a => {
      assert.ok(Number.isSafeInteger(a.id) && a.id > 0 && Number.isSafeInteger(a.size) && a.size > 0);
      assert.match(a.digest || '', /^sha256:[a-f0-9]{64}$/); assert.equal(a.state, 'uploaded');
      return { id: a.id, name: a.name, size: a.size, digest: a.digest, url: a.browser_download_url };
    }).sort((a, b) => a.name.localeCompare(b.name)) };
}
function protectWindows(rows, latest, expected) {
  assert.deepEqual(stableIdentity(latest), expected, 'Windows014 latest/assets changed');
  const selected = windowsSelection(rows);
  assert.ok(selected && selected.id === expected.id && selected.version === 'v0.1.14', 'Windows014 discovery changed or fell outside latest ten');
  for (const a of selected.assets) {
    const pinned = expected.assets.find(row => row.name === a.name);
    assert.ok(pinned); assert.deepEqual(a, { id: pinned.id, name: pinned.name, size: pinned.size, digest: pinned.digest });
  }
}
function linuxAssets(record, expected) {
  assert.equal(record.tag_name, 'v' + VERSION); assert.equal(record.prerelease, false);
  assert.equal(record.assets.length, Object.keys(expected).length);
  assert.equal(new Set(record.assets.map(a => a.name)).size, record.assets.length);
  for (const a of record.assets) {
    const p = expected[a.name]; assert.ok(p, 'Unknown Linux asset');
    assert.deepEqual({ id: a.id, size: a.size, sha256: (a.digest || '').replace(/^sha256:/, '') }, p);
    assert.equal(a.digest, 'sha256:' + p.sha256); assert.equal(a.state, 'uploaded');
    assert.equal(a.browser_download_url, `https://github.com/${REPO}/releases/download/v${VERSION}/${a.name}`);
  }
  for (const n of [CATALOG, CATALOG + '.minisig', PORTABLE, PORTABLE + '.minisig']) assert.ok(expected[n]);
  assert.ok(!record.assets.some(a => /windows|\.exe$|\.dmg$|\.zip$|0\.1\.(?:13|14|15|17)/i.test(a.name)), 'Non-Linux/private assets refused');
}
function inspectDraft(bytes, draft, latest, qualification) {
  const rows = releases(bytes);
  assert.equal(draft.id, qualification.draft.id); assert.equal(draft.draft, true);
  linuxAssets(draft, qualification.draft.assets); protectWindows(rows, latest, qualification.windows);
  assert.ok(!rows.some(r => r.id === draft.id || r.tag_name === draft.tag_name), 'Draft already public');
  const projected = [{ ...draft, draft: false, published_at: new Date().toISOString() }, ...rows].slice(0, 10);
  protectWindows(projected, latest, qualification.windows);
  const overhead = Math.max(0, bytes.length - Buffer.byteLength(JSON.stringify(rows)));
  const size = Buffer.byteLength(JSON.stringify(projected)) + overhead;
  assert.ok(size <= LEGACY_LIMIT - PUBLICATION_HEADROOM, 'Need 4 KiB publication headroom below 256 KiB');
  return { version: VERSION, draftId: draft.id, bytes: size, headroom: LEGACY_LIMIT - size, ready: false };
}
function inspectLive(bytes, latest, qualification) {
  const rows = releases(bytes); protectWindows(rows, latest, qualification.windows);
  const matches = rows.filter(r => r.id === qualification.draft.id && r.tag_name === 'v' + VERSION && r.draft === false);
  assert.equal(matches.length, 1, 'Exact published Linux016 row not visible');
  linuxAssets(matches[0], qualification.draft.assets);
  return { version: VERSION, draftId: matches[0].id, bytes: bytes.length, ready: false, publicAcceptance: false };
}
async function readLiveFeed() {
  // Deliberately unauthenticated: authenticated release lists can include private drafts.
  const response = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=10`, {
    headers: { 'User-Agent': 'Creator-Hub/0.1' }, signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  assert.equal(response.status, 200, 'Public release feed unavailable');
  const chunks = []; let size = 0;
  for await (const part of response.body) { size += part.length; assert.ok(size <= LEGACY_LIMIT, 'Full installed-client feed exceeds 256 KiB'); chunks.push(Buffer.from(part)); }
  return Buffer.concat(chunks);
}
module.exports = { REPO, VERSION, CATALOG, PORTABLE, WINDOWS, hash, releases, windowsSelection,
  stableIdentity, protectWindows, linuxAssets, inspectDraft, inspectLive, readLiveFeed };
