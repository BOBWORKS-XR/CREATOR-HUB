import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createCreatorDocsLookup, LIVE_DOCS_TTL_MS, LIVE_DOCS_PAGE_BYTES } from '../dist/tools/lookup-creator-docs.js';
import { getMCPReference, REFERENCE_RESPONSE_MAX_BYTES } from '../dist/tools/get-mcp-reference.js';
import { registerTools, handleToolCall, parseToolGroupSelection } from '../dist/tools/index.js';
import { createConfigForProject } from '../dist/lib/config.js';

const REF = 'https://api.github.com/repos/SideQuestVR/BanterSDK/git/ref/heads/feature/greenfield';
const RAW = 'https://raw.githubusercontent.com/SideQuestVR/BanterSDK/';
const A = 'a'.repeat(40), B = 'b'.repeat(40);
const hash = text => createHash('sha256').update(text).digest('hex');
function fixture(options = {}) {
  const state = { revision: A, time: 1000000, requests: [], pages: {
    'README.md': '# Creator SDK\nOverview.\n',
    'reference/session-relay.md': '# SessionRelay\nNew live reference data.\n',
    ...options.pages,
  }, ...options.state };
  const fetcher = async (url, init) => {
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.headers.Authorization, undefined);
    state.requests.push({ url, init });
    if (options.intercept) {
      const intercepted = await options.intercept(url, init, state);
      if (intercepted) return intercepted;
    }
    if (url === REF) return new Response(JSON.stringify({ ref: 'refs/heads/feature/greenfield', object: { type: 'commit', sha: state.revision } }));
    assert.ok(url.startsWith(`${RAW}${state.revision}/Docs/`), url);
    const path = url.slice(`${RAW}${state.revision}/Docs/`.length);
    if (path === '_sidebar.md') return new Response(options.sidebar ?? '- Reference\n' + Object.keys(state.pages).map(p => {
      const heading = /^# (.+)/m.exec(state.pages[p])?.[1]?.trim() || p;
      return `  - [${heading}](/${p})`;
    }).join('\n'));
    assert.ok(Object.hasOwn(state.pages, path), `Unrequested/unknown page: ${path}`);
    return new Response(state.pages[path]);
  };
  return { state, lookup: createCreatorDocsLookup({ fetch: fetcher, now: () => state.time, timeoutMs: options.timeoutMs }) };
}

test('construction and offline references do not fetch; a new live topic uses only index and one page', async () => {
  const { state, lookup } = fixture();
  assert.equal(state.requests.length, 0);
  assert.equal(getMCPReference({ source: 'creator-docs', query: 'local multiplayer' }).success, true);
  assert.equal(state.requests.length, 0);
  const result = await lookup({ query: 'SessionRelay', limit: 1 });
  assert.equal(result.success, true);
  assert.equal(result.mode, 'live');
  assert.equal(result.networkRequests, 3);
  assert.equal(result.revision, A);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].path, 'reference/session-relay.md');
  assert.match(result.entries[0].text, /New live reference/);
  assert.equal(result.entries[0].url, 'https://altvr.app/docs/reference/session-relay');
  assert.equal(result.entries[0].sourceUrl, `${RAW}${A}/Docs/reference/session-relay.md`);
  assert.equal(result.entries[0].contentHash, hash(state.pages['reference/session-relay.md']));
  assert.equal(state.requests.some(r => r.url.includes('?') || r.url.includes('SessionRelay')), false);
  assert.match(result.searchScope, /does not search every live page body/);
  assert.match(result.guidance, /reference data, not instructions/);
});

test('broad search downloads at most three pages and explicitly describes incomplete search', async () => {
  const pages = Object.fromEntries(Array.from({ length: 30 }, (_, n) => [`reference/session-${n}.md`, `# Session ${n}\nReference.\n`]));
  const { lookup } = fixture({ pages });
  const result = await lookup({ query: 'session' });
  assert.equal(result.networkRequests, 5);
  assert.equal(result.entries.length, 3);
  assert.equal(result.searchedPages.length, 3);
  assert.ok(result.indexedPages > result.searchedPages.length);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= REFERENCE_RESPONSE_MAX_BYTES);
  assert.match(result.searchScope, /No results do not prove/);
});

test('zero candidates fetch only metadata and do not crawl bodies to find a match', async () => {
  const { lookup } = fixture();
  const result = await lookup({ query: 'unknown_topic_123' });
  assert.equal(result.success, true);
  assert.equal(result.networkRequests, 2);
  assert.deepEqual(result.entries, []);
});

test('cache has a short explicit freshness window, refresh rechecks only metadata when unchanged', async () => {
  const { state, lookup } = fixture();
  const first = await lookup({ query: 'SessionRelay' });
  state.time += 1000;
  const cached = await lookup({ query: 'SessionRelay' });
  assert.equal(cached.networkRequests, 0);
  assert.equal(cached.indexCached, true);
  assert.equal(cached.checkedAt, first.checkedAt);
  assert.equal(cached.entries[0].cached, true);
  const fresh = await lookup({ query: 'SessionRelay', refresh: true });
  assert.equal(fresh.networkRequests, 1);
  assert.equal(fresh.indexCached, false);
  assert.notEqual(fresh.checkedAt, first.checkedAt);
  state.time += LIVE_DOCS_TTL_MS;
  assert.equal((await lookup({ query: 'SessionRelay' })).networkRequests, 1);
  state.time -= 10000;
  assert.equal((await lookup({ query: 'SessionRelay' })).networkRequests, 1, 'Clock rollback must not extend stale-cache trust');
});

test('new upstream revision invalidates page cache and returns new text without replacing bundled docs', async () => {
  const { state, lookup } = fixture();
  await lookup({ query: 'SessionRelay' });
  state.revision = B;
  state.pages['reference/session-relay.md'] = '# SessionRelay\nChanged reference.\n';
  const current = await lookup({ query: 'SessionRelay', refresh: true });
  assert.equal(current.revision, B);
  assert.equal(current.networkRequests, 3);
  assert.match(current.entries[0].text, /Changed reference/);
  assert.notEqual(current.bundledRevision, B);
});

test('query prefers a relevant section and exact path continuation preserves every character', async () => {
  const text = '# Intro\r\nUnrelated.\r\n## SessionRelay\r\n' + 'Example 😀 with \\ escapes and "quotes". '.repeat(200);
  const { lookup } = fixture({ pages: { 'reference/session-relay.md': text }, sidebar: '- [SessionRelay](/reference/session-relay.md)' });
  const search = await lookup({ query: 'SessionRelay', limit: 1 });
  assert.match(search.entries[0].text, /^## SessionRelay/);
  assert.equal(search.entries[0].completePage, false);
  const normalized = text.replace(/\r\n/g, '\n');
  let collected = '', revision, contentHash, offset = 0;
  for (let n = 0; n < 100; n++) {
    const result = await lookup({ path: 'reference/session-relay.md', startOffset: offset, ...(revision ? { revision, contentHash } : {}) });
    assert.equal(result.success, true, result.error);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= REFERENCE_RESPONSE_MAX_BYTES);
    const entry = result.entries[0];
    assert.equal(entry.contentHash, hash(text));
    assert.equal(entry.text.includes('\ufffd'), false);
    collected += entry.text;
    revision = result.revision; contentHash = entry.contentHash;
    if (entry.nextOffset === null) break;
    offset = entry.nextOffset;
    assert.ok(n < 99);
  }
  assert.equal(collected, normalized);
});

test('query excerpt includes a sole term beyond the initial escaped-byte budget', async () => {
  const text = '# API Reference\n' + 'Unrelated introduction. '.repeat(200) +
    '\nSetSpaceState is the requested method.\n' + 'Quoted "text", \\ escapes and \u{1f600}.\n'.repeat(300);
  const { state, lookup } = fixture({ pages: { 'reference/state-api.md': text }, sidebar: '- [SetSpaceState](/reference/state-api.md)' });
  const result = await lookup({ query: 'SetSpaceState', limit: 1 });
  assert.equal(result.success, true);
  const entry = result.entries[0];
  assert.match(entry.text, /SetSpaceState/);
  assert.ok(entry.startOffset > 0);
  assert.ok(entry.startOffset <= text.indexOf('SetSpaceState'));
  assert.ok(entry.startOffset + entry.text.length >= text.indexOf('SetSpaceState') + 'SetSpaceState'.length);
  assert.equal(entry.text, text.slice(entry.startOffset, entry.startOffset + entry.text.length));
  assert.equal(entry.nextOffset, entry.startOffset + entry.text.length);
  assert.equal(entry.contentHash, hash(text));
  assert.ok(Buffer.byteLength(JSON.stringify(entry.text)) <= 2048);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= REFERENCE_RESPONSE_MAX_BYTES);
  assert.equal(state.requests.length, 3);
});

test('query excerpt preserves the existing excerpt when it already contains a term', async () => {
  const text = '# API Reference\nSetSpaceState is documented here.\n' + 'More context. '.repeat(400);
  const { state, lookup } = fixture({ pages: { 'reference/state-api.md': text }, sidebar: '- [SetSpaceState](/reference/state-api.md)' });
  const original = (await lookup({ path: 'reference/state-api.md' })).entries[0];
  const result = await lookup({ query: 'SetSpaceState', limit: 1 });
  assert.equal(result.success, true);
  assert.equal(result.entries[0].startOffset, original.startOffset);
  assert.equal(result.entries[0].text, original.text);
  assert.equal(result.entries[0].nextOffset, original.nextOffset);
  assert.equal(result.entries[0].contentHash, original.contentHash);
  assert.equal(result.networkRequests, 0);
  assert.equal(state.requests.length, 3);
});

test('query excerpt retains Unicode boundaries, selected section and exact continuation', async () => {
  const prefix = '# API Reference\n' + '"\\'.repeat(1800) + '\n';
  const context = '\u{1f600}' + '"\\'.repeat(63) + 'x';
  const normalized = prefix + context + 'SetSpaceState is here.\nSmall tail.\n## Following\n' +
    'Quoted "text", \\ escapes and \u{1f600}.\n'.repeat(350);
  const raw = normalized.replace(/\n/g, '\r\n');
  const { state, lookup } = fixture({ pages: { 'reference/state-api.md': raw }, sidebar: '- [SetSpaceState](/reference/state-api.md)' });
  const result = await lookup({ query: 'SetSpaceState', limit: 1 });
  assert.equal(result.success, true);
  const first = result.entries[0];
  // A 128-character lookbehind lands on the low surrogate; keep the pair.
  assert.equal(first.startOffset, prefix.length);
  assert.match(first.text, /^\u{1f600}/u);
  assert.match(first.text, /SetSpaceState/);
  assert.equal(first.nextOffset, normalized.indexOf('\n## Following'));
  assert.equal(first.text.includes('## Following'), false);
  assert.equal(first.contentHash, hash(raw));
  let collected = first.text, offset = first.nextOffset;
  for (let n = 0; offset !== null; n++) {
    assert.ok(n < 30);
    const continued = await lookup({ path: first.path, revision: result.revision, contentHash: first.contentHash, startOffset: offset });
    assert.equal(continued.success, true, continued.error);
    const entry = continued.entries[0];
    assert.equal(entry.startOffset, offset);
    assert.equal(entry.text, normalized.slice(offset, offset + entry.text.length));
    assert.doesNotMatch(entry.text, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    assert.ok(Buffer.byteLength(JSON.stringify(entry.text)) <= 2048);
    assert.ok(Buffer.byteLength(JSON.stringify(continued)) <= REFERENCE_RESPONSE_MAX_BYTES);
    assert.equal(continued.revision, result.revision);
    assert.equal(entry.contentHash, first.contentHash);
    assert.equal(continued.networkRequests, 0);
    collected += entry.text;
    offset = entry.nextOffset;
  }
  assert.equal(collected, normalized.slice(first.startOffset));
  assert.equal(state.requests.length, 3);
});

test('stale revisions and wrong hashes refuse continuation, never substitute offline text', async () => {
  const { state, lookup } = fixture();
  const initial = await lookup({ path: 'reference/session-relay.md' });
  const request = { path: 'reference/session-relay.md', revision: A, contentHash: initial.entries[0].contentHash, startOffset: 1 };
  const wrongHash = await lookup({ ...request, contentHash: '0'.repeat(64) });
  assert.equal(wrongHash.success, false);
  assert.match(wrongHash.error, /hash changed/);
  assert.equal(wrongHash.fallback, undefined);
  state.revision = B;
  const stale = await lookup({ ...request, refresh: true });
  assert.equal(stale.success, false);
  assert.match(stale.error, /revision changed/);
  assert.equal(stale.fallback, undefined);
});

test('repeated section text retains the offset of the ranked parent context', async () => {
  const repeated = '## Setup\n' + 'Shared setup example. '.repeat(200) + '\n';
  const text = '# First\n' + repeated + '# Later\n' + repeated;
  const { lookup } = fixture({ pages: { 'reference/session-relay.md': text }, sidebar: '- [Later Setup](/reference/session-relay.md)' });
  const result = await lookup({ query: 'later setup', limit: 1 });
  assert.equal(result.success, true);
  assert.equal(result.entries[0].startOffset, text.lastIndexOf('## Setup'));
  assert.equal(result.entries[0].nextOffset, text.lastIndexOf('## Setup') + result.entries[0].text.length);
});

test('Token Saver can continue the exact truncated offline fallback without networking', async () => {
  const { state, lookup } = fixture({ intercept: async () => { throw new Error('Offline'); } });
  const result = await lookup({ query: 'SetSpaceState' });
  const entry = result.fallback.entries[0];
  assert.notEqual(entry.nextOffset, null);
  const response = await handleToolCall('get_mcp_reference', {
    source: 'creator-docs', entryId: entry.entryId, revision: result.fallback.revision, startOffset: entry.nextOffset,
  }, createConfigForProject(''), undefined, parseToolGroupSelection('core'));
  const continued = JSON.parse(response.content[0].text);
  assert.equal(continued.success, true);
  assert.equal(continued.entries[0].startOffset, entry.nextOffset);
  assert.equal(state.requests.length, 1);
});

test('invalid arguments and URL/path escapes are refused before networking', async () => {
  const { state, lookup } = fixture();
  for (const args of [
    {}, { query: '' }, { query: 123 }, { query: 'a'.repeat(129) }, { query: 'how do I' }, { query: 'mcp\nprivate' },
    { query: 'mcp', path: 'README.md' }, { path: 'https://attacker.invalid/a.md' }, { path: '../outside.md' },
    { path: 'reference/%2e%2e/a.md' }, { path: 'reference\\a.md' }, { path: 'reference/a.md?secret=1' },
    { query: 'mcp', limit: 4 }, { query: 'mcp', limit: 0 }, { query: 'mcp', refresh: 'yes' }, { query: 'mcp', secret: true },
    { path: 'README.md', startOffset: 1 }, { path: 'README.md', startOffset: -1 },
    { path: 'README.md', revision: 'main' }, { query: 'mcp', revision: A },
  ]) assert.equal((await lookup(args)).success, false, JSON.stringify(args));
  assert.equal(state.requests.length, 0);
});

test('unknown paths and offsets produce a safe way out, not an arbitrary fetch', async () => {
  const { lookup } = fixture();
  const missing = await lookup({ path: 'secret/file.md' });
  assert.equal(missing.success, false);
  assert.equal(missing.networkRequests, 2);
  assert.equal(missing.fallback, undefined);
  const first = await lookup({ path: 'README.md' });
  const outside = await lookup({ path: 'README.md', revision: A, contentHash: first.entries[0].contentHash, startOffset: 99999 });
  assert.equal(outside.success, false);
  assert.match(outside.error, /outside this page/);
});

test('network failure labels the existing local fallback and never claims live success', async () => {
  const { lookup } = fixture({ intercept: async () => { throw new Error('Offline'); } });
  const result = await lookup({ query: 'local multiplayer' });
  assert.equal(result.success, false);
  assert.equal(result.mode, 'offline-fallback');
  assert.match(result.warning, /not checked current/);
  assert.equal(result.fallback.success, true);
  assert.ok(result.fallback.entries.length);
  assert.equal(result.revision, undefined);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= REFERENCE_RESPONSE_MAX_BYTES);
  const continuation = await lookup({ path: 'README.md', revision: A, contentHash: '0'.repeat(64), startOffset: 1 });
  assert.equal(continuation.fallback, undefined);
});

for (const [name, response] of [
  ['rate limit', () => new Response('Retry later', { status: 429 })],
  ['not found', () => new Response('Missing', { status: 404 })],
  ['redirect', () => new Response(null, { status: 302, headers: { location: 'https://attacker.invalid/' } })],
  ['HTML', () => new Response('<html>Not docs</html>', { headers: { 'content-type': 'text/html' } })],
  ['declared large response', () => new Response('x', { headers: { 'content-length': String(LIVE_DOCS_PAGE_BYTES + 1) } })],
  ['streamed large response', () => new Response('x'.repeat(LIVE_DOCS_PAGE_BYTES + 1))],
  ['bad UTF-8', () => new Response(new Uint8Array([0xff, 0xfe, 0xff]))],
]) test(`${name} is refused without crawling or leaking the remote error body`, async () => {
  const { lookup } = fixture({ intercept: async url => url.endsWith('session-relay.md') ? response() : undefined });
  const result = await lookup({ path: 'reference/session-relay.md' });
  assert.equal(result.success, false);
  assert.equal(result.networkRequests, 3);
  assert.equal(JSON.stringify(result).includes('Not docs'), false);
});

test('one deadline aborts a blocked network request and allows a later retry', async () => {
  let blocked = true;
  const { lookup } = fixture({ timeoutMs: 20, intercept: async (_url, init) => {
    if (blocked) await new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('abort')), { once: true }));
  } });
  const timeout = await lookup({ query: 'SessionRelay' });
  assert.equal(timeout.success, false);
  assert.match(timeout.error, /timed out/);
  blocked = false;
  assert.equal((await lookup({ query: 'SessionRelay' })).success, true);
});

test('malformed or external sidebar links never authorize a request', async () => {
  for (const sidebar of ['<html>Index unavailable</html>', '- [Bad](https://attacker.invalid/x.md)', '- [Bad](/../x.md)', '- [A](/README.md)\n- [B](/README.md)']) {
    const { lookup } = fixture({ sidebar });
    const result = await lookup({ query: 'bad' });
    assert.equal(result.success, false);
    assert.equal(result.networkRequests, 2);
  }
});

test('page cache is bounded to sixteen documents', async () => {
  const pages = Object.fromEntries(Array.from({ length: 17 }, (_, n) => [`reference/p${n}.md`, `# Page ${n}\nBody.\n`]));
  const { lookup } = fixture({ pages });
  for (const path of Object.keys(pages)) assert.equal((await lookup({ path })).success, true);
  assert.equal((await lookup({ path: 'reference/p0.md' })).networkRequests, 1);
  assert.equal((await lookup({ path: 'reference/p16.md' })).networkRequests, 0);
});

test('concurrent callers do not multiply downloads or bypass the per-call bound', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const { state, lookup } = fixture({ intercept: async url => { if (url === REF) await wait; } });
  const first = lookup({ query: 'SessionRelay' });
  const second = await lookup({ query: 'SessionRelay' });
  assert.equal(second.success, false);
  assert.match(second.error, /already running/);
  assert.equal(state.requests.length, 1);
  release();
  assert.equal((await first).success, true);
});

test('registered tool is read-only but open-world, available in normal profiles, and dispatch validates arguments', async () => {
  for (const profile of ['all', 'core', 'read', 'author', 'banter']) {
    const tool = registerTools(parseToolGroupSelection(profile)).find(t => t.name === 'lookup_creator_docs');
    assert.ok(tool, profile);
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.equal(registerTools(parseToolGroupSelection('none')).some(t => t.name === 'lookup_creator_docs'), false);
  const response = await handleToolCall('lookup_creator_docs', { path: '../private.md' }, createConfigForProject(''));
  assert.equal(JSON.parse(response.content[0].text).success, false);
});
