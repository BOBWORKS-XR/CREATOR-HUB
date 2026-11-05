import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { extractCreatorUnits, tokenizeCSharp, collectCreatorNodes } from '../scripts/sync-creator-vs-nodes.mjs';
import { blobHash, sha256 } from '../scripts/sync-creator-docs.mjs';
import { loadSourceModule } from './source-module-loader.mjs';

const { CREATOR_VS_NODES_SNAPSHOT: snapshot } = await loadSourceModule('../src/resources/creator-vs-nodes-snapshot.ts');
const { CREATOR_VS_NODES, inspectCreatorCatalogPort } = await loadSourceModule('../src/resources/creator-vs-nodes.ts');
const { BANTER_CUSTOM_VS_NODES } = await loadSourceModule('../src/resources/banter-custom-vs-nodes.ts');
const { searchSourceAwareSidequestVSNodes: search, searchLegacySidequestVSNodes: legacy,
  SEARCH_SIDEQUEST_VS_NODES_SCHEMA, SIDEQUEST_NODE_RESPONSE_MAX_BYTES } = await loadSourceModule('../src/tools/search-sidequest-vs-nodes.ts');

function input(text, path = 'VisualScripting/Test.cs') {
  const bytes = Buffer.from(text);
  return { text, path, blobSha: blobHash(bytes), sha256: sha256(bytes), sourceUrl: `https://example.invalid/pinned/${path}` };
}

test('Creator snapshot retains immutable source identity, licence, and Unit-only coverage', () => {
  assert.equal(snapshot.revision, 'bf638cb228f4bd5633c0ecb403d8aecfbab703f7');
  assert.equal(snapshot.packageVersion, '4.0.25');
  assert.ok(snapshot.nodes.length > 190);
  assert.equal(new Set(snapshot.nodes.map(node => node.fullType)).size, snapshot.nodes.length);
  assert.equal(snapshot.sourceSetSha256, createHash('sha256').update(JSON.stringify(snapshot.sources.map(({ path, sha256 }) => ({ path, sha256 })))).digest('hex'));
  assert.equal(blobHash(Buffer.from(snapshot.license.text)), snapshot.license.blobSha);
  assert.equal(sha256(Buffer.from(snapshot.license.text)), snapshot.license.sha256);
  for (const node of snapshot.nodes) {
    assert.ok(node.ancestry.some(type => /(?:^|\.)Unit$/.test(type)), node.fullType);
    assert.equal(node.runtimeAllowance, 'not-established-by-source');
    assert.equal(node.inheritedPortsResolved, false);
    assert.equal(node.portCoverage, 'declared-source-only');
    const source = snapshot.sources.find(source => source.path === node.source.path);
    assert.equal(node.source.sha256, source.sha256);
    assert.equal(node.source.blobSha, source.blobSha);
    assert.ok(source.sourceUrl.includes(`/${snapshot.revision}/`));
  }
  for (const helper of ['StateUnitUtil', 'PersistFileUnitSupport', 'RecordingUnitSupport', 'CoroutineRunner', 'VisualScriptingEvent']) {
    assert.ok(!snapshot.nodes.some(node => node.name === helper), helper);
    assert.ok(snapshot.excludedClasses.some(item => item.fullType.endsWith(`.${helper}`)), helper);
  }
});

test('storage nodes expose exact declared keys/defaults, not fabricated namespace ports', () => {
  const node = CREATOR_VS_NODES.find(node => node.name === 'PersistFileSet');
  assert.deepEqual(node.ports.map(port => [port.kind, port.key]), [
    ['ControlInput', ''], ['ControlOutput', ''], ['ValueInput', 'Name'], ['ValueInput', 'Data'],
  ]);
  assert.equal(node.ports.find(port => port.key === 'Data').default.value, '');
  assert.equal(node.ports.find(port => port.key === 'Data').valueType, null, 'Do not pretend overload inference is a resolved type');
  const state = CREATOR_VS_NODES.find(node => node.name === 'SetSpaceStateValue');
  assert.deepEqual(state.ports.filter(port => port.kind === 'ValueInput').map(port => port.key),
    ['Path', 'Value', 'Value Is JSON?', 'Is Public Property?', 'Request Id']);
  assert.equal(state.ports.find(port => port.key === 'Is Public Property?').default.value, true);
  assert.equal(state.ports.find(port => port.key === 'Value Is JSON?').default.value, false);
});

test('inherited and dynamic event ports remain unresolved; alternate typed/default forms retain evidence', () => {
  const global = CREATOR_VS_NODES.find(node => node.name === 'OnGlobalEvent');
  assert.ok(global.unresolvedPorts.some(port => port.keyExpression === '"argument_" + i'));
  assert.ok(!global.ports.some(port => port.key === 'argument_0' || port.key === 'trigger'));
  const click = CREATOR_VS_NODES.find(node => node.name === 'OnClick');
  assert.equal(click.callsBaseDefinition, true);
  assert.ok(click.ports.some(port => port.key === 'banterPlayerEvents' && port.valueType === 'GameObject' && port.default.value === null));
  const trigger = CREATOR_VS_NODES.find(node => node.name === 'TriggerUnityEvent');
  assert.ok(trigger.ports.some(port => port.key === 'Target' && port.valueType === 'VisualScriptingEvent'));
  assert.ok(trigger.defaultAssignments.some(item => item.field === 'Target' && item.value.value === null));
  assert.equal(trigger.obsolete, true);
  assert.ok(CREATOR_VS_NODES.some(node => node.name === 'OnBanterTriggerEnter' && node.ancestry.some(type => type.includes('TriggerEventUnit'))));
});

test('source reader ignores strings/comments/helper classes and refuses guessed default/dynamic values', () => {
  const fixture = input(`using Unity.VisualScripting;
namespace BS.VisualScripting {
// public class Fake : Unit { }
internal class Helper { string text = "class Fake2 : Unit { }"; }
public abstract class Base : Unit { }
[UnitCategory("BS\\\\Test")] public class Real : Base {
 protected override void Definition() {
   first = ValueInput<int>("Count", 2);
   target = ValueInput(typeof(UnityEngine.GameObject), nameof(target));
   first.SetDefaultValue(ComputeDefault());
   for (int i = 0; i < 2; i++) ValueOutput<object>("item_" + i);
   another = ValueInput("Flag", Unknown.Flag);
 }
}
public class Unknown : ExternalUnit { }
}`);
  const parsed = extractCreatorUnits([fixture]);
  assert.deepEqual(parsed.nodes.map(node => node.name), ['Real']);
  const node = parsed.nodes[0];
  assert.equal(node.ports[0].default.value, 2);
  assert.equal(node.ports[1].key, 'target');
  assert.equal(node.ports[1].valueType, 'UnityEngine.GameObject');
  assert.equal(node.ports[1].default.status, 'not-declared-inline');
  assert.equal(node.defaultAssignments[0].value.status, 'unresolved');
  assert.equal(node.ports[2].default.status, 'unresolved');
  assert.equal(node.unresolvedPorts.length, 1);
  assert.ok(!node.ports.some(port => port.key === 'item_0'));
  assert.throws(() => tokenizeCSharp('/* unterminated'), /Unterminated/);
  assert.throws(() => tokenizeCSharp('var s = """raw""";'), /needs generator review/);
  const alias = input('using Unity.VisualScripting;\nusing Unit = External.Fake;\nnamespace BS.VisualScripting { public class NotUnit : Unit {} }');
  assert.equal(extractCreatorUnits([alias]).nodes.length, 0);
  const big = input('using Unity.VisualScripting; namespace BS.VisualScripting { public class Big : Unit { protected override void Definition() { n = ValueInput("large", 9007199254740993); f = ValueInput("float", 0.1f); } } }');
  assert.ok(extractCreatorUnits([big]).nodes[0].ports.every(port => port.default.status === 'unresolved'));
});

test('source-aware search finds Creator additions and preserves bounded legacy results', () => {
  for (const query of ['PersistFileSet', 'SetSpaceStateValue', 'UserFromCollider']) {
    const result = search({ query, source: 'creator' });
    assert.equal(result.success, true);
    assert.equal(result.nodes[0].name, query);
    assert.equal(result.nodes[0].catalogSource, 'creator');
    assert.equal(result.nodes[0].catalogRevision, snapshot.revision);
    assert.match(result.guidance, /Source existence does not establish hosted runtime allowance/);
  }
  const all = search({ query: 'OnClick' });
  assert.equal(all.source, 'all');
  assert.deepEqual(new Set(all.nodes.map(node => node.catalogSource)), new Set(['creator', 'legacy']));
  for (const query of ['TeleportTo', 'OnClick', 'String', 'Player', 'not_a_known_node']) {
    const old = legacy(query, undefined, 25);
    const result = search({ query, source: 'legacy', limit: 25 });
    assert.equal(old.catalogSize, 162);
    assert.equal(result.totalMatches, old.totalMatches);
    assert.deepEqual(result.nodes.map(node => node.fullType), old.nodes.map(node => node.fullType));
    for (const node of old.nodes) assert.deepEqual(node.defaultValues, BANTER_CUSTOM_VS_NODES[node.name].defaultValues);
  }
  for (const args of [{ query: 'UI', limit: 25 }, { query: 'state', limit: 25 }, { query: 'BS', source: 'creator', limit: 25 }]) {
    const result = search(args);
    assert.equal(result.success, true);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= SIDEQUEST_NODE_RESPONSE_MAX_BYTES);
    assert.equal(result.count, result.nodes.length);
    assert.equal(result.truncated, result.nodes.length < result.totalMatches);
  }
});

test('unknown sources/arguments/ports refuse and never claim runtime validation', () => {
  assert.equal(SEARCH_SIDEQUEST_VS_NODES_SCHEMA.additionalProperties, false);
  for (const args of [{ query: '' }, { query: 'x', source: 'installed' }, { query: 'x', source: null }, { query: 'x', source: ['all'] }, { query: 'x', limit: 26 }, { query: 'x', category: 1 }, { query: 'x', projectPath: 'forbidden' }, { query: 'x\n' }]) {
    assert.equal(search(args).success, false, JSON.stringify(args));
  }
  const base = { source: 'creator', revision: snapshot.revision, fullType: 'BS.VisualScripting.PersistFileSet', kind: 'ValueInput', key: 'Data' };
  const found = inspectCreatorCatalogPort(base);
  assert.equal(found.success, true);
  assert.equal(found.runtimeVerified, false);
  for (const change of [{ source: 'installed' }, { revision: '0'.repeat(40) }, { key: 'MadeUp' }, { fullType: 'BS.VisualScripting.StateUnitUtil' }, { ignoreHash: true }]) {
    assert.equal(inspectCreatorCatalogPort({ ...base, ...change }).success, false);
  }
  assert.equal(inspectCreatorCatalogPort({ ...base, fullType: 'BS.VisualScripting.OnGlobalEvent', kind: 'ValueOutput', key: 'argument_0' }).success, false);
});

test('collector verifies complete immutable source, licence and corruption before extracting', async () => {
  const revision = 'a'.repeat(40);
  const texts = { 'LICENSE.md': snapshot.license.text, 'package.json': '{"name":"com.sidequest.creator-sdk","version":"4.0.25"}',
    'VisualScripting/Test.cs': 'using Unity.VisualScripting; namespace BS.VisualScripting { public class Test : Unit { } }' };
  const fixture = (options = {}) => async url => {
    if (url.includes('/git/trees/')) return new Response(JSON.stringify({ sha: revision, truncated: options.truncated ?? false,
      tree: Object.entries(texts).map(([path, text]) => ({ type: 'blob', path, sha: blobHash(Buffer.from(text)), size: Buffer.byteLength(text) })) }));
    const key = url.split(`/${revision}/`)[1];
    assert.ok(Object.hasOwn(texts, key));
    return new Response(options.corrupt && key === 'VisualScripting/Test.cs' ? texts[key].replace('Test', 'Lost') : texts[key]);
  };
  assert.equal((await collectCreatorNodes(revision, { fetcher: fixture() })).nodes.length, 1);
  await assert.rejects(collectCreatorNodes('feature/greenfield'), /immutable/);
  await assert.rejects(collectCreatorNodes(revision, { fetcher: fixture({ truncated: true }) }), /incomplete/);
  await assert.rejects(collectCreatorNodes(revision, { fetcher: fixture({ corrupt: true }) }), /hash differs/);
});
