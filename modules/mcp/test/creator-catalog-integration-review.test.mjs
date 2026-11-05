import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { loadSourceModule } from './source-module-loader.mjs';
import { extractCreatorUnits } from '../scripts/sync-creator-vs-nodes.mjs';

const { generateVSGraph } = await loadSourceModule('../src/tools/generate-vs-graph.ts');
const { validateVSGraph } = await loadSourceModule('../src/tools/validate-vs-graph.ts');
const { CREATOR_VS_NODES, inspectCreatorCatalogPort, hasVerifiedCompletePortContract } = await loadSourceModule('../src/resources/creator-vs-nodes.ts');
const { CREATOR_DOCS_SNAPSHOT } = await loadSourceModule('../src/resources/creator-docs-snapshot.ts');
const { getMCPReference, REFERENCE_RESPONSE_MAX_BYTES } = await loadSourceModule('../src/tools/get-mcp-reference.ts');
const { createCreatorDocsLookup } = await loadSourceModule('../src/tools/lookup-creator-docs.ts');
const { SIDEQUEST_NODE_RESPONSE_MAX_BYTES } = await loadSourceModule('../src/tools/search-sidequest-vs-nodes.ts');
const indexSource = await readFile(new URL('../src/tools/index.ts', import.meta.url), 'utf8');
let guardedTools;

function generate(nodes, connections = [], sdkProfile = 'creator') {
  return generateVSGraph({ graphName: 'MemoryOnlyReview', sdkProfile, nodes, connections });
}
function element(result, id = '1') { return JSON.parse(result.graphJson).graph.elements.find(node => node.$id === id); }

async function validatorWithCatalog(nodes) {
  const realModule = fileURLToPath(new URL('../src/resources/creator-vs-nodes.ts', import.meta.url));
  const bundled = await build({ entryPoints: [fileURLToPath(new URL('../src/tools/validate-vs-graph.ts', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'node20', logLevel: 'silent', plugins: [{ name: 'synthetic-source-catalog', setup(builder) {
      builder.onResolve({ filter: /resources\/creator-vs-nodes\.js$/ }, () => ({ path: 'source-fixture', namespace: 'review-fixture' }));
      builder.onResolve({ filter: /.*/, namespace: 'review-fixture' }, args => args.path === realModule ? { path: realModule, namespace: 'file' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'review-fixture' }, () => ({ loader: 'js', contents:
        `export {hasVerifiedCompletePortContract} from ${JSON.stringify(realModule)};
         export const CREATOR_VS_NODES=${JSON.stringify(nodes)};
         export const CREATOR_VS_NODE_INDEX={revision:${JSON.stringify(CREATOR_DOCS_SNAPSHOT.revision)}};` }));
    } }] });
  return (await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)).validateVSGraph;
}

test('registered search dispatch uses the source-aware helper and preserves the positional legacy wrapper', () => {
  assert.match(indexSource, /case "search_sidequest_vs_nodes":\s*result = searchSourceAwareSidequestVSNodes\(args\)/);
  assert.match(indexSource, /name: "search_sidequest_vs_nodes",\s*description: SEARCH_SIDEQUEST_VS_NODES_DESCRIPTION/);
  assert.match(indexSource, /inputSchema: \{ \.\.\.SEARCH_SIDEQUEST_VS_NODES_SCHEMA, type: "object" \}/);
  assert.match(indexSource, /return searchLegacySidequestVSNodes\(query, category, limit\)/);
});

async function getGuardedTools() {
  if (guardedTools) return guardedTools;
  const guarded = await build({ entryPoints: [new URL('../src/tools/index.ts', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')],
    bundle: true, write: false, format: 'esm', platform: 'node', target: 'node20', logLevel: 'silent',
    banner: { js: `import { createRequire as testCreateRequire } from 'node:module'; const require = testCreateRequire(${JSON.stringify(import.meta.url)});` },
    plugins: [{ name: 'forbid-native-filesystem', setup(builder) {
      builder.onResolve({ filter: /^(?:node:)?fs(?:\/promises)?$/ }, args => args.namespace === 'review-fs' ? { path: args.path, external: true } : { path: args.path, namespace: 'review-fs' });
      builder.onLoad({ filter: /.*/, namespace: 'review-fs' }, args => ({ loader: 'js', contents:
        `const native = require(${JSON.stringify(args.path.includes('promises') ? 'node:fs/promises' : 'node:fs')});
         module.exports = new Proxy(native, { get(target, key) {
           if (key === 'promises') return new Proxy(native.promises || target, {get(t,k) { if(typeof t[k] === 'function') return () => { throw new Error('Native FS forbidden: '+String(k)); }; return t[k]; }});
           if (typeof target[key] === 'function') return () => { throw new Error('Native FS forbidden: '+String(key)); };
           return target[key];
         }});` }));
    } }],
  });
  guardedTools = await import(`data:text/javascript;base64,${Buffer.from(guarded.outputFiles[0].text).toString('base64')}`);
  return guardedTools;
}

test('actual search dispatch runs without native filesystem access', async () => {
  const tool = await getGuardedTools();
  const config = { unityProjectPath: '', assetsPath: '', mcpStatePath: '' };
  for (const source of ['creator', 'legacy', 'all']) {
    const response = await tool.handleToolCall('search_sidequest_vs_nodes', { query: 'OnClick', source }, config);
    const result = JSON.parse(response.content[0].text);
    assert.equal(result.success, true);
    assert.equal(result.source, source);
    assert.ok(result.nodes.length > 0);
    assert.match(result.guidance, /Matching version numbers alone do not prove matching source/);
    assert.match(result.guidance, /Source existence does not establish hosted runtime allowance/);
  }
  const invalid = await tool.handleToolCall('search_sidequest_vs_nodes', { query: 'OnClick', source: 'installed' }, config);
  assert.equal(JSON.parse(invalid.content[0].text).success, false);
});

test('new Creator aliases enforce the selected SDK profile and serialize the declared safe defaults', () => {
  for (const profile of ['none', 'unknown', 'banter']) assert.equal(generate([{ id: 'p', type: 'PersistFileSet' }], [], profile).success, false);
  for (const profile of ['creator', 'hybrid']) {
    const result = generate([{ id: 'p', type: 'SetSpaceStateValue' }], [], profile);
    assert.equal(result.success, true);
    assert.equal(element(result).$type, 'BS.VisualScripting.SetSpaceStateValue');
    assert.deepEqual(element(result).defaultValues, {
      Path: { $type: 'System.String', $content: '' },
      Value: { $type: 'System.String', $content: '' },
      'Value Is JSON?': { $type: 'System.Boolean', $content: false },
      'Is Public Property?': { $type: 'System.Boolean', $content: true },
      'Request Id': { $type: 'System.String', $content: '' },
    });
  }
});

test('new Creator events infer coroutine requirements and validation rejects a missing flag', () => {
  const result = generate([{ id: 'event', type: 'OnPersistFileLoaded' }, { id: 'wait', type: 'WaitForSeconds' }],
    [{ from: 'event', fromPort: 'trigger', to: 'wait', toPort: 'enter', type: 'control' }]);
  assert.equal(result.success, true);
  assert.equal(element(result).coroutine, true);
  const graph = JSON.parse(result.graphJson);
  delete graph.graph.elements[0].coroutine;
  const rejected = validateVSGraph(JSON.stringify(graph), { sdkProfile: 'creator' });
  assert.equal(rejected.valid, false);
  assert.match(rejected.errors.join('\n'), /coroutine/);
});

test('dynamic/inherited ports stay unresolved in catalog output and are not fabricated as defaults', () => {
  const dynamic = CREATOR_VS_NODES.find(node => node.name === 'OnGlobalEvent');
  assert.ok(dynamic.unresolvedPorts.length > 0);
  assert.ok(!dynamic.ports.some(port => port.key === 'trigger' || port.key === 'argument_0'));
  const result = generate([{ id: 'event', type: 'OnGlobalEvent' }]);
  assert.ok(!Object.hasOwn(element(result).defaultValues, 'argument_0'));
  assert.equal(inspectCreatorCatalogPort({ source: 'creator', fullType: dynamic.fullType, kind: 'ValueOutput', key: 'argument_0' }).success, false);
});

test('integrated offline aliases return storage limits and identify player-MCP pages', () => {
  for (const query of ['authenticated player storage', 'authentication token external server', 'PlayerPrefs']) {
    const result = getMCPReference({ source: 'creator-docs', query, limit: 1 });
    assert.equal(result.success, true);
    assert.match(result.entries[0].entryId, /^javascript-api\/saving-data\.md#/);
    assert.match(result.entries[0].guidance, /not private per-player saves/);
    assert.match(result.entries[0].guidance, /not proof of identity/);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= REFERENCE_RESPONSE_MAX_BYTES);
  }
  const player = getMCPReference({ source: 'creator-docs', query: 'MCP', limit: 1 });
  assert.match(player.entries[0].guidance, /Altspace Windows player MCP server/);
  assert.match(player.entries[0].guidance, /not Creator Works Unity Editor/);
});

test('integrated live aliases remain bounded and return only current pinned pages with scoped guidance', async () => {
  const requests = [];
  const lookup = createCreatorDocsLookup({ fetch: async url => {
    requests.push(url);
    if (url.includes('/git/ref/')) return new Response(JSON.stringify({ ref: 'refs/heads/feature/greenfield', object: { type: 'commit', sha: CREATOR_DOCS_SNAPSHOT.revision } }));
    const path = url.split('/Docs/')[1];
    if (path === '_sidebar.md') return new Response(CREATOR_DOCS_SNAPSHOT.sidebar.text);
    const page = CREATOR_DOCS_SNAPSHOT.pages.find(page => page.path === path);
    assert.ok(page, path);
    return new Response(page.text);
  } });
  const storage = await lookup({ query: 'authentication token external server', limit: 1 });
  assert.equal(storage.success, true);
  assert.equal(storage.entries[0].path, 'javascript-api/saving-data.md');
  assert.match(storage.entries[0].guidance, /not private per-player saves/);
  assert.equal(storage.networkRequests, 3);
  const player = await lookup({ query: 'MCP', limit: 1 });
  assert.match(player.entries[0].guidance, /Altspace Windows player MCP server/);
  assert.equal(player.networkRequests, 1);
  assert.ok(requests.every(url => !url.includes('external%20server') && !url.includes('?')));
});

test('static validation rejects a known fixed-source port-kind mismatch', () => {
  const result = generate([{ id: 'save', type: 'PersistFileSet' }, { id: 'set', type: 'SetSpaceStateValue' }],
    [{ from: 'save', fromPort: 'Name', to: 'set', toPort: 'MadeUp', type: 'control' }]);
  // Generation is intentionally not validation; it must not claim runtime proof.
  assert.equal(result.success, true);
  assert.equal(result.runtimeVerified, false);
  const validation = validateVSGraph(result.graphJson, { sdkProfile: 'creator' });
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(error => error.includes('PersistFileSet') && error.includes('Name') && error.includes('ControlOutput')));
  assert.ok(validation.errors.some(error => error.includes('SetSpaceStateValue') && error.includes('MadeUp') && error.includes('ControlInput')));
  assert.equal(inspectCreatorCatalogPort({ source: 'creator', fullType: 'BS.VisualScripting.PersistFileSet', kind: 'ControlOutput', key: 'Name' }).success, false);
});

test('source-derived generation/static success retains revision and excludes runtime claims', () => {
  const result = generate([{ id: 'save', type: 'PersistFileSet' }]);
  const validation = validateVSGraph(result.graphJson, { sdkProfile: 'creator' });
  assert.equal(result.success, true);
  assert.equal(validation.valid, true);
  assert.equal(result.catalogRevision, CREATOR_DOCS_SNAPSHOT.revision);
  assert.equal(validation.catalogRevision, CREATOR_DOCS_SNAPSHOT.revision);
  assert.equal(result.runtimeVerified, false);
  assert.equal(validation.runtimeVerified, false);
  assert.match(result.validationScope, /unvalidated.*Unity import/);
  assert.match(validation.validationScope, /static/);
});

test('actual search wire formatting stays within the response budget', async t => {
  const tool = await getGuardedTools();
  const response = await tool.handleToolCall('search_sidequest_vs_nodes', { query: 'UI', source: 'creator', limit: 25 },
    { unityProjectPath: '', assetsPath: '', mcpStatePath: '' });
  const result = JSON.parse(response.content[0].text);
  const compactBytes = Buffer.byteLength(JSON.stringify(result));
  const wireTextBytes = Buffer.byteLength(response.content[0].text);
  assert.ok(compactBytes <= SIDEQUEST_NODE_RESPONSE_MAX_BYTES);
  assert.ok(wireTextBytes <= SIDEQUEST_NODE_RESPONSE_MAX_BYTES);
  t.diagnostic(JSON.stringify({ compactBytes, wireTextBytes, max: SIDEQUEST_NODE_RESPONSE_MAX_BYTES }));
});

test('partial/inherited/dynamic ports remain warning-only and never become runtime proof', () => {
  for (const [type, fromPort, edgeType, toPort] of [
    ['OnPersistFileLoaded', 'trigger', 'control', ''],
    ['OnGlobalEvent', 'argument_0', 'value', 'Value'],
    ['ReleaseGrab', 'UnknownFuturePort', 'control', ''],
  ]) {
    const result = generate([{ id: 'source', type }, { id: 'sink', type: 'SetSpaceStateValue' }],
      [{ from: 'source', fromPort, to: 'sink', toPort, type: edgeType }]);
    const validation = validateVSGraph(result.graphJson, { sdkProfile: 'creator' });
    assert.equal(validation.valid, true, validation.errors.join('\n'));
    assert.equal(validation.runtimeVerified, false);
    assert.match(validation.warnings.join('\n'), /partial source catalogue/);
  }
  for (const profile of ['banter', 'creator', 'hybrid', 'none', 'unknown']) {
    const result = generate([{ id: 'start', type: 'Start' }], [], profile);
    assert.equal(result.runtimeVerified, false);
    const validation = validateVSGraph(result.graphJson, { sdkProfile: profile });
    assert.equal(validation.runtimeVerified, false);
  }
});

test('helper-created ports must not be hard-rejected from the direct-Unit heuristic alone', async () => {
  const text = `using Unity.VisualScripting;
namespace BS.VisualScripting {
 public class HelperPorts : Unit {
  protected override void Definition() {
   ValueInput<string>("shared", "");
   BuildPorts();
  }
  private void BuildPorts() { ControlOutput("shared"); }
 }
}`;
  const fixture = extractCreatorUnits([{ text, path: 'VisualScripting/HelperPorts.cs', blobSha: 'a'.repeat(40), sha256: 'b'.repeat(64), sourceUrl: 'https://example.invalid/test-fixture' }]).nodes[0];
  assert.equal(fixture.ancestry[0], 'Unit');
  assert.equal(fixture.callsBaseDefinition, false);
  assert.equal(fixture.unresolvedPorts.length, 0);
  assert.deepEqual(fixture.ports.map(port => [port.kind, port.key]), [['ValueInput', 'shared']]);
  const nodes = [fixture, ...CREATOR_VS_NODES];
  const validateFixture = await validatorWithCatalog(nodes);
  const result = generate([{ id: 'helper', type: 'BS.VisualScripting.HelperPorts' }, { id: 'sink', type: 'SetSpaceStateValue' }],
    [{ from: 'helper', fromPort: 'shared', to: 'sink', toPort: '', type: 'control' }]);
  const validation = validateFixture(result.graphJson, { sdkProfile: 'creator' });
  assert.equal(validation.valid, true, `Partial helper metadata must not establish absence: ${validation.errors.join('; ')}`);
  assert.equal(validation.runtimeVerified, false);
  assert.match(validation.warnings.join('\n'), /not verified|partial/);
});

test('only the three reviewed source hashes have complete port contracts', () => {
  const reviewed = ['PersistFileGet', 'PersistFileSet', 'SetSpaceStateValue'];
  assert.deepEqual(CREATOR_VS_NODES.filter(hasVerifiedCompletePortContract).map(node => node.name).sort(), reviewed.sort());
  for (const name of reviewed) {
    const node = CREATOR_VS_NODES.find(node => node.name === name);
    assert.equal(hasVerifiedCompletePortContract(node), true);
    assert.equal(hasVerifiedCompletePortContract({ ...node, source: { ...node.source, sha256: '0'.repeat(64) } }), false);
  }
  assert.equal(hasVerifiedCompletePortContract({ fullType: 'BS.VisualScripting.NotReviewed', source: { sha256: '0'.repeat(64) } }), false);
});

test('changed source hashes downgrade wrong-kind and absent-port errors to warnings', async () => {
  const nodes = CREATOR_VS_NODES.map(node => hasVerifiedCompletePortContract(node)
    ? { ...node, source: { ...node.source, sha256: '0'.repeat(64) } } : node);
  const validateChangedSource = await validatorWithCatalog(nodes);
  for (const fromPort of ['Name', 'MissingAfterSourceChange']) {
    const result = generate([{ id: 'source', type: 'PersistFileSet' }, { id: 'sink', type: 'SetSpaceStateValue' }],
      [{ from: 'source', fromPort, to: 'sink', toPort: 'MissingInput', type: 'control' }]);
    const validation = validateChangedSource(result.graphJson, { sdkProfile: 'creator' });
    assert.equal(validation.valid, true, validation.errors.join('\n'));
    assert.equal(validation.errors.length, 0);
    assert.equal(validation.runtimeVerified, false);
    assert.match(validation.warnings.join('\n'), /partial source catalogue/);
    assert.match(validation.warnings.join('\n'), /MissingInput/);
  }
});
