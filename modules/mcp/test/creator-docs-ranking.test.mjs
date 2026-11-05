import assert from 'node:assert/strict';
import test from 'node:test';
import { collectCreatorDocs, blobHash, sha256 } from '../scripts/sync-creator-docs.mjs';
import { loadSourceModule } from './source-module-loader.mjs';

const { CREATOR_DOCS_SNAPSHOT: snapshot } = await loadSourceModule('../src/resources/creator-docs-snapshot.ts');
const { CREATOR_DOCS_INDEX, CREATOR_DOCS_GUIDANCE } = await loadSourceModule('../src/resources/creator-docs.ts');
const { creatorDocsTerms, scoreCreatorDocsPage, scoreCreatorDocsSection, matchesCreatorDocsSection,
  CREATOR_STORAGE_AUTH_GUIDANCE, creatorDocsPageGuidance } = await loadSourceModule('../src/resources/creator-docs-search.ts');
const { splitReferenceMarkdown, getMCPReference, REFERENCE_RESPONSE_MAX_BYTES } = await loadSourceModule('../src/tools/get-mcp-reference.ts');
const { createCreatorDocsLookup } = await loadSourceModule('../src/tools/lookup-creator-docs.ts');

test('refreshed snapshot contains exactly 49 hash-verified content pages at the immutable revision', () => {
  assert.equal(snapshot.revision, 'bf638cb228f4bd5633c0ecb403d8aecfbab703f7');
  assert.equal(snapshot.pages.length, 49);
  assert.equal(CREATOR_DOCS_INDEX.pages.length, 49);
  assert.ok(!snapshot.pages.some(page => page.path === '_sidebar.md'));
  for (const input of [snapshot.license, snapshot.sidebar, ...snapshot.pages]) {
    assert.equal(sha256(Buffer.from(input.text)), input.sha256);
    assert.equal(blobHash(Buffer.from(input.text)), input.blobSha);
    assert.ok(input.sourceUrl.includes(`/${snapshot.revision}/`));
  }
});

test('storage/authentication aliases rank the limitations before unrelated browser snippets', () => {
  for (const query of ['authenticated player storage', 'authentication token external server', 'PlayerPrefs', 'private player inventory', 'durable progress']) {
    const ranked = snapshot.pages.map(page => ({ path: page.path, rank: scoreCreatorDocsPage(page.path, page.title, page.text, query) }))
      .sort((a, b) => b.rank - a.rank);
    assert.equal(ranked[0].path, 'javascript-api/saving-data.md', query);
    const page = snapshot.pages.find(page => page.path === ranked[0].path);
    const sections = splitReferenceMarkdown(page.text).filter(section => matchesCreatorDocsSection(page.path, section.title, section.text, query))
      .sort((a, b) => scoreCreatorDocsSection(page.path, b.title, b.text, query) - scoreCreatorDocsSection(page.path, a.title, a.text, query));
    assert.ok(sections.length > 0, query);
    if (/auth|token/.test(query)) assert.match(sections[0].text, /owner|signed in|no built-in/i);
  }
  assert.equal(snapshot.pages.some(page => scoreCreatorDocsPage(page.path, page.title, page.text, 'unknown_topic_123') > 0), false);
  assert.deepEqual(creatorDocsTerms('How do I use storage?'), ['storage']);
  assert.match(CREATOR_STORAGE_AUTH_GUIDANCE, /not private per-player saves/);
  assert.match(CREATOR_STORAGE_AUTH_GUIDANCE, /not proof of identity/);
  assert.match(CREATOR_STORAGE_AUTH_GUIDANCE, /24 hours/);
  assert.match(CREATOR_STORAGE_AUTH_GUIDANCE, /do not establish/);
});

test('the new MCP docs are explicitly scoped to the Altspace player, not Editor tools', () => {
  for (const path of ['reference/ai-agents-mcp.md', 'reference/mcp-tools.md']) {
    assert.ok(snapshot.pages.some(page => page.path === path));
    assert.match(creatorDocsPageGuidance(path), /Altspace Windows player MCP server/);
    assert.match(CREATOR_DOCS_INDEX.pages.find(page => page.path === path).guidance, /not Creator Works Unity Editor/);
  }
  assert.match(CREATOR_DOCS_GUIDANCE, /Altspace Windows player MCP/);
});

test('updated content still permits exact bounded offline continuations without rewriting text', () => {
  for (const page of snapshot.pages) {
    for (const section of splitReferenceMarkdown(page.text)) {
      let text = '', revision;
      for (let n = 0; n < 100; n++) {
        const result = getMCPReference({ source: 'creator-docs', entryId: `${page.path}#${section.id}`, startOffset: text.length, revision });
        assert.equal(result.success, true, result.error);
        assert.ok(Buffer.byteLength(JSON.stringify(result)) <= REFERENCE_RESPONSE_MAX_BYTES);
        revision ??= result.revision;
        text += result.entries[0].text;
        if (result.entries[0].complete) break;
        assert.ok(n < 99);
      }
      assert.equal(text, section.text);
    }
  }
});

test('bounded online lookup remains opt-in, gets at most three pages and preserves revision/hash checks', async () => {
  let calls = 0;
  const lookup = createCreatorDocsLookup({ fetch: async url => {
    calls++;
    if (url.includes('/git/ref/')) return new Response(JSON.stringify({ ref: 'refs/heads/feature/greenfield', object: { type: 'commit', sha: snapshot.revision } }));
    const path = url.split(`/Docs/`)[1];
    if (path === '_sidebar.md') return new Response(snapshot.sidebar.text);
    const page = snapshot.pages.find(page => page.path === path);
    assert.ok(page, path);
    return new Response(page.text);
  } });
  assert.equal(calls, 0);
  const result = await lookup({ query: 'storage' });
  assert.equal(result.success, true);
  assert.ok(calls <= 5);
  assert.ok(result.entries.length <= 3);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= REFERENCE_RESPONSE_MAX_BYTES);
  const page = result.entries[0];
  const stale = await lookup({ path: page.path, revision: '0'.repeat(40), contentHash: page.contentHash, startOffset: 1 });
  assert.equal(stale.success, false);
  assert.equal(stale.fallback, undefined);
});

test('documentation importer still refuses a changed licence and corrupt snapshot bytes', async () => {
  const fixture = (options = {}) => {
    const texts = { 'LICENSE.md': snapshot.license.text + (options.license ? '\nChanged' : ''), 'Docs/README.md': '# Docs\nHello.\n', 'Docs/_sidebar.md': '- [Home](/)\n' };
    return async url => {
      if (url.includes('/git/trees/')) return new Response(JSON.stringify({ truncated: false, tree: Object.entries(texts).map(([path, text]) => ({ path, type: 'blob', sha: blobHash(Buffer.from(text)), size: Buffer.byteLength(text) })) }));
      const path = url.split(`/${snapshot.revision}/`)[1];
      return new Response(options.corrupt && path === 'Docs/README.md' ? texts[path].replace('Hello', 'Other') : texts[path]);
    };
  };
  await assert.rejects(collectCreatorDocs(snapshot.revision, fixture({ license: true })), /licence/);
  await assert.rejects(collectCreatorDocs(snapshot.revision, fixture({ corrupt: true })), /content differs/);
});
