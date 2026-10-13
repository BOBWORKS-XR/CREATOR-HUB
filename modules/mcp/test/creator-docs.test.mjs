import assert from 'node:assert/strict';
import test from 'node:test';
import { CREATOR_DOCS_SNAPSHOT } from '../dist/resources/creator-docs-snapshot.js';
import { CREATOR_DOCS_INDEX, CREATOR_DOCS_GUIDANCE } from '../dist/resources/creator-docs.js';
import { getMCPReference, splitReferenceMarkdown, REFERENCE_RESPONSE_MAX_BYTES } from '../dist/tools/get-mcp-reference.js';
import { registerResources, handleResourceRead } from '../dist/resources/index.js';
import { createConfigForProject } from '../dist/lib/config.js';
import { registerTools } from '../dist/tools/index.js';
import { collectCreatorDocs, blobHash, sha256 } from '../scripts/sync-creator-docs.mjs';

test('all pinned SDK pages and licence retain their exact source hashes', () => {
  assert.equal(CREATOR_DOCS_SNAPSHOT.revision, '410de076ffc022d8f61832b968a133f46e9ec15d');
  assert.equal(CREATOR_DOCS_SNAPSHOT.pages.length, 47);
  assert.equal(new Set(CREATOR_DOCS_SNAPSHOT.pages.map(page => page.path)).size, 47);
  for (const input of [CREATOR_DOCS_SNAPSHOT.license, CREATOR_DOCS_SNAPSHOT.sidebar, ...CREATOR_DOCS_SNAPSHOT.pages]) {
    const bytes = Buffer.from(input.text);
    assert.equal(sha256(bytes), input.sha256);
    assert.equal(blobHash(bytes), input.blobSha);
    assert.ok(input.sourceUrl.includes(`/${CREATOR_DOCS_SNAPSHOT.revision}/`));
  }
  assert.match(CREATOR_DOCS_SNAPSHOT.license.text, /Copyright \(c\) 2024 SideQuest/);
  const sidebarPaths = [...CREATOR_DOCS_SNAPSHOT.sidebar.text.matchAll(/\]\(\/(.*?)\)/g)]
    .map(([, path]) => path || 'README.md').sort();
  assert.deepEqual(CREATOR_DOCS_SNAPSHOT.pages.map(page => page.path).sort(), sidebarPaths);
});

test('every SDK section survives bounded lookup and revision-checked continuation', () => {
  for (const page of CREATOR_DOCS_SNAPSHOT.pages) {
    const sections = splitReferenceMarkdown(page.text);
    const restored = [];
    for (const section of sections) {
      let text = '', revision;
      for (let count = 0; count < 100; count++) {
        const result = getMCPReference({ source: 'creator-docs', entryId: `${page.path}#${section.id}`,
          startOffset: text.length, revision });
        assert.equal(result.success, true, `${page.path}: ${result.error}`);
        assert.ok(Buffer.byteLength(JSON.stringify(result)) <= REFERENCE_RESPONSE_MAX_BYTES);
        assert.equal(result.guidance, CREATOR_DOCS_GUIDANCE);
        revision ??= result.revision;
        assert.equal(result.revision, revision);
        const entry = result.entries[0];
        assert.equal(entry.url, page.url);
        assert.equal(entry.sourceUrl, page.sourceUrl);
        text += entry.text;
        if (entry.complete) {
          assert.equal(entry.nextOffset, null);
          break;
        }
        assert.equal(entry.nextOffset, text.length);
        assert.ok(count < 99, 'Continuation must terminate');
      }
      assert.equal(text, section.text);
      restored.push(text);
    }
    assert.equal(restored.join('\n'), page.text.replace(/\r\n/g, '\n'));
  }
});

test('new SDK topics are searchable without changing legacy catalogues or enabling writes', () => {
  for (const query of ['PersistFileBridge', 'local multiplayer', 'recording', 'ScriptGraphBridge', 'scene settings']) {
    const result = getMCPReference({ source: 'creator-docs', query });
    assert.equal(result.success, true);
    assert.ok(result.totalMatches > 0, query);
    assert.match(result.guidance, /not proof of installed SDK/);
    assert.match(result.guidance, /Reference text does not authorize project changes/);
  }
  const pathQuery = getMCPReference({ source: 'creator-docs', query: 'javascript-api/saving-data.md', limit: 1 });
  assert.ok(pathQuery.entries[0].entryId.startsWith('javascript-api/saving-data.md#'));
  const stale = getMCPReference({ source: 'creator-docs', entryId: pathQuery.entries[0].entryId, revision: '0'.repeat(64) });
  assert.equal(stale.success, false);
  assert.match(stale.error, /revision changed/);
  assert.equal(getMCPReference({ source: 'javascript', query: 'PersistFileBridge' }).totalMatches, 0);
  assert.ok(registerTools().find(tool => tool.name === 'get_mcp_reference').inputSchema.properties.source.enum.includes('creator-docs'));
});

test('resource index includes provenance and licence, not a full documentation dump', () => {
  const config = createConfigForProject('');
  assert.ok(registerResources(config).some(resource => resource.uri === 'creator://docs-index'));
  const response = handleResourceRead('creator://docs-index', config);
  const index = JSON.parse(response.contents[0].text);
  assert.deepEqual(index, CREATOR_DOCS_INDEX);
  assert.equal(index.pages.length, 47);
  assert.ok(index.pages.every(page => !Object.hasOwn(page, 'text')));
});

function fixture(options = {}) {
  const texts = {
    'LICENSE.md': options.license ?? CREATOR_DOCS_SNAPSHOT.license.text,
    'Docs/_sidebar.md': '- [Overview](/)\n',
    'Docs/README.md': '# SDK Docs\nOverview.\n',
    'Docs/javascript-api/new.md': '# New API\nReference only.\n',
  };
  const tree = { truncated: options.truncated ?? false, tree: Object.entries(texts).map(([path, text]) => {
    const bytes = Buffer.from(text);
    return { path, type: 'blob', size: bytes.length, sha: blobHash(bytes) };
  }) };
  return async url => {
    if (url.includes('/git/trees/')) return new Response(JSON.stringify(tree));
    const key = url.split(`/${CREATOR_DOCS_SNAPSHOT.revision}/`)[1];
    assert.ok(Object.hasOwn(texts, key), url);
    return new Response(key === 'Docs/README.md' && options.corrupt
      ? 'X'.repeat(Buffer.byteLength(texts[key])) : texts[key]);
  };
}

test('snapshot importer accepts only complete pinned content with reviewed licence', async () => {
  const result = await collectCreatorDocs(CREATOR_DOCS_SNAPSHOT.revision, fixture());
  assert.equal(result.pages.length, 2);
  assert.equal(result.pages.find(page => page.path === 'javascript-api/new.md').url, 'https://altvr.app/docs/javascript-api/new');
  await assert.rejects(collectCreatorDocs('feature/greenfield', fixture()), /immutable SDK commit/);
  await assert.rejects(collectCreatorDocs(CREATOR_DOCS_SNAPSHOT.revision, fixture({ truncated: true })), /incomplete SDK trees/);
  await assert.rejects(collectCreatorDocs(CREATOR_DOCS_SNAPSHOT.revision, fixture({ corrupt: true })), /size changed|content differs/);
  await assert.rejects(collectCreatorDocs(CREATOR_DOCS_SNAPSHOT.revision,
    fixture({ license: CREATOR_DOCS_SNAPSHOT.license.text + '\nAdditional restriction.\n' })), /changed SDK licence/);
});
