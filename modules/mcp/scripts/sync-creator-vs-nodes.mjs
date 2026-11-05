import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blobHash, sha256 } from './sync-creator-docs.mjs';

const repository = 'SideQuestVR/BanterSDK';
const reviewedLicenseSha256 = '13a77431376172fc19640b667dd2b1c689e5a013ebf5fa8fa93f58f9c5b66504';
const portMethods = new Set(['ControlInput', 'ControlOutput', 'ValueInput', 'ValueOutput']);
const unityRoots = {
  Unit: ['Unity.VisualScripting.Unit'],
  EventUnit: ['Unity.VisualScripting.EventUnit'],
  TriggerEventUnit: ['Unity.VisualScripting.TriggerEventUnit', 'Unity.VisualScripting.GameObjectEventUnit<Collider>', 'Unity.VisualScripting.EventUnit<Collider>', 'Unity.VisualScripting.Unit'],
};
const rootTypeReference = 'https://docs.unity3d.com/Packages/com.unity.visualscripting@1.9/api/Unity.VisualScripting.TriggerEventUnit.html';

// This is a conservative source reader, not a C# compiler. Unknown syntax stays
// unknown; it is never evaluated and never used to invent a runtime port.
export function tokenizeCSharp(text) {
  const tokens = [];
  let i = 0, line = 1;
  const add = (kind, start, startLine) => tokens.push({ kind, text: text.slice(start, i), start, end: i, line: startLine });
  while (i < text.length) {
    const start = i, startLine = line;
    if (/\s/.test(text[i])) { if (text[i++] === '\n') line++; continue; }
    if (text.startsWith('//', i)) { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (text.startsWith('/*', i)) {
      i += 2;
      while (i < text.length && !text.startsWith('*/', i)) if (text[i++] === '\n') line++;
      assert.ok(i < text.length, 'Unterminated C# comment'); i += 2; continue;
    }
    if (text[i] === '"' || text[i] === "'" || text.startsWith('@"', i) || text.startsWith('$"', i) || text.startsWith('$@"', i) || text.startsWith('@$"', i)) {
      while (['$', '@'].includes(text[i])) i++;
      assert.ok(!text.startsWith('"""', i), 'Unsupported C# raw string syntax needs generator review');
      const prefix = text.slice(start, i), quote = text[i++];
      if (quote !== '"' && quote !== "'") { add('symbol', start, startLine); continue; }
      const verbatim = prefix.includes('@');
      let closed = false;
      while (i < text.length) {
        const char = text[i++];
        if (char === '\n') line++;
        if (!verbatim && char === '\\') { i++; continue; }
        if (char === quote) {
          if (verbatim && text[i] === quote) { i++; continue; }
          closed = true; break;
        }
      }
      assert.ok(closed, 'Unterminated C# string');
      add(prefix.includes('$') ? 'interpolated' : quote === '"' ? 'string' : 'char', start, startLine);
      continue;
    }
    if (/[A-Za-z_]/.test(text[i])) { while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) i++; add('identifier', start, startLine); continue; }
    if (/[0-9]/.test(text[i])) { while (i < text.length && /[A-Za-z0-9_.]/.test(text[i])) i++; add('number', start, startLine); continue; }
    i++; add('symbol', start, startLine);
  }
  return tokens;
}

function closeAt(tokens, start, open, close) {
  assert.equal(tokens[start]?.text, open);
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (tokens[i].text === open) depth++;
    if (tokens[i].text === close && --depth === 0) return i;
    // Only closing tokens should reduce the depth.
    if (tokens[i].text !== close) continue;
  }
  throw new Error(`Unclosed ${open} at line ${tokens[start].line}`);
}

function expression(tokens, text) {
  return tokens.length ? text.slice(tokens[0].start, tokens.at(-1).end) : '';
}

function stringLiteral(token) {
  if (token?.kind !== 'string') return undefined;
  if (token.text.startsWith('@"')) return token.text.slice(2, -1).replaceAll('""', '"');
  // JSON covers the strings used in SDK keys, including escaped backslashes.
  // C#-only escapes remain unknown rather than being decoded incorrectly.
  try { return JSON.parse(token.text); } catch { return undefined; }
}

function literal(tokens, text) {
  const source = expression(tokens, text);
  if (tokens.length === 1) {
    const value = stringLiteral(tokens[0]);
    if (value !== undefined) return { status: 'literal', expression: source, value };
    if (source === 'true' || source === 'false') return { status: 'literal', expression: source, value: source === 'true' };
    if (source === 'null') return { status: 'literal', expression: source, value: null };
  }
  if (/^(?:string|String|System\.String)\.Empty$/.test(source)) return { status: 'constant', expression: source, value: '' };
  if (/^-?\d+$/.test(source) && Number.isSafeInteger(Number(source))) {
    return { status: 'literal', expression: source, value: Number(source) };
  }
  return { status: 'unresolved', expression: source };
}

function argsAt(tokens, start) {
  const end = closeAt(tokens, start, '(', ')'), parts = [];
  let from = start + 1, depth = 0;
  for (let i = from; i < end; i++) {
    if (['(', '[', '{', '<'].includes(tokens[i].text)) depth++;
    else if ([')', ']', '}', '>'].includes(tokens[i].text) && !(tokens[i].text === '>' && tokens[i - 1]?.text === '=')) depth--;
    if (tokens[i].text === ',' && depth === 0) { parts.push(tokens.slice(from, i)); from = i + 1; }
  }
  parts.push(tokens.slice(from, end));
  return { parts, end };
}

function keyValue(tokens, text) {
  const value = literal(tokens, text);
  if (typeof value.value === 'string') return value.value;
  const match = /^nameof\(\s*(?:[A-Za-z_]\w*\.)*([A-Za-z_]\w*)\s*\)$/.exec(value.expression);
  return match?.[1];
}

function extractClass(record, tokens, classIndex, namespace, attributes, text) {
  let open = classIndex + 2;
  while (open < tokens.length && !['{', ';'].includes(tokens[open].text)) open++;
  if (tokens[open]?.text !== '{') return undefined;
  const end = closeAt(tokens, open, '{', '}');
  const header = tokens.slice(classIndex + 2, open);
  const colon = header.findIndex(t => t.text === ':');
  const baseType = colon < 0 ? '' : expression(header.slice(colon + 1).filter((t, i, all) => i < (all.findIndex(x => x.text === ',') < 0 ? all.length : all.findIndex(x => x.text === ','))), text).replace(/\s+/g, '');
  const ports = [], unresolvedPorts = [], defaultAssignments = [];
  let definitionSeen = false, baseDefinition = false;
  for (let i = open + 1; i < end; i++) {
    if (tokens[i].text !== 'Definition' || tokens[i + 1]?.text !== '(' || tokens[i - 1]?.text !== 'void') continue;
    const parameters = argsAt(tokens, i + 1);
    if (tokens[parameters.end + 1]?.text !== '{') continue;
    definitionSeen = true;
    const methodEnd = closeAt(tokens, parameters.end + 1, '{', '}');
    for (let j = parameters.end + 2; j < methodEnd; j++) {
      if (tokens[j].text === 'base' && tokens[j + 1]?.text === '.' && tokens[j + 2]?.text === 'Definition') baseDefinition = true;
      if (tokens[j].text === 'SetDefaultValue' && tokens[j - 1]?.text === '.' && tokens[j + 1]?.text === '(') {
        const values = argsAt(tokens, j + 1);
        defaultAssignments.push({ field: tokens[j - 2]?.text, value: literal(values.parts[0], text), line: tokens[j].line });
      }
      if (!portMethods.has(tokens[j].text) || tokens[j - 1]?.text === '.') continue;
      let call = j + 1, valueType = null;
      if (tokens[call]?.text === '<') {
        const typeEnd = closeAt(tokens, call, '<', '>');
        valueType = expression(tokens.slice(call + 1, typeEnd), text);
        call = typeEnd + 1;
      }
      if (tokens[call]?.text !== '(') continue;
      const { parts } = argsAt(tokens, call);
      const typeArgument = /^typeof\((.+)\)$/.exec(expression(parts[0], text));
      const keyIndex = typeArgument ? 1 : 0;
      if (typeArgument) valueType = typeArgument[1];
      const key = keyValue(parts[keyIndex] ?? [], text);
      const evidence = { method: tokens[j].text, line: tokens[j].line };
      if (key === undefined) { unresolvedPorts.push({ ...evidence, keyExpression: expression(parts[keyIndex] ?? [], text) }); continue; }
      const input = tokens[j].text === 'ValueInput';
      ports.push({ key, kind: tokens[j].text, valueType, typeStatus: valueType ? 'source-type-expression' : 'not-resolved',
        ...(tokens[j - 1]?.text === '=' ? { field: tokens[j - 2].text } : {}),
        ...(input ? { default: parts.length > keyIndex + 1 ? literal(parts[keyIndex + 1], text) : { status: 'not-declared-inline' } } : {}),
        ...evidence });
    }
    i = methodEnd;
  }
  const attribute = name => {
    const i = attributes.findIndex(t => t.text === name && t.kind === 'identifier');
    return i >= 0 && attributes[i + 1]?.text === '(' ? stringLiteral(attributes[i + 2]) ?? null : null;
  };
  return { name: tokens[classIndex + 1].text, fullType: `${namespace}.${tokens[classIndex + 1].text}`,
    baseType, title: attribute('UnitTitle'), category: attribute('UnitCategory'),
    abstract: attributes.some(t => t.text === 'abstract'), obsolete: attributes.some(t => t.text === 'Obsolete'),
    obsoleteMessage: attribute('Obsolete'), definitionSeen, baseDefinition, ports, unresolvedPorts, defaultAssignments,
    source: { path: record.path, blobSha: record.blobSha, sha256: record.sha256, sourceUrl: record.sourceUrl,
      line: tokens[classIndex].line }, end };
}

export function extractCreatorUnits(inputs) {
  const classes = [];
  for (const input of inputs.filter(input => input.path.startsWith('VisualScripting/') && input.path.endsWith('.cs'))) {
    const tokens = tokenizeCSharp(input.text);
    const aliases = tokens.flatMap((token, index) => token.text === 'using' && tokens[index + 2]?.text === '=' ? [tokens[index + 1].text] : []);
    const visit = (start, end, namespace = '') => {
      let attributes = [];
      for (let i = start; i < end; i++) {
        if (tokens[i].text === 'namespace') {
          let j = i + 1;
          while (j < end && !['{', ';'].includes(tokens[j].text)) j++;
          const name = expression(tokens.slice(i + 1, j), input.text).replace(/\s+/g, '');
          if (tokens[j].text === '{') {
            const close = closeAt(tokens, j, '{', '}'); visit(j + 1, close, namespace ? `${namespace}.${name}` : name); i = close;
          } else { namespace = name; i = j; }
          attributes = []; continue;
        }
        if (tokens[i].text === '[') {
          const close = closeAt(tokens, i, '[', ']'); attributes.push(...tokens.slice(i, close + 1)); i = close; continue;
        }
        if (tokens[i].text === 'class') {
          const found = extractClass(input, tokens, i, namespace, attributes, input.text);
          if (found) { classes.push({ ...found, aliases, unityUsing: /(?:^|\n)\s*using\s+Unity\.VisualScripting\s*;/.test(input.text) }); i = found.end; }
          attributes = []; continue;
        }
        if ([';', '{', '}'].includes(tokens[i].text)) attributes = [];
        else attributes.push(tokens[i]);
      }
    };
    visit(0, tokens.length);
  }
  assert.equal(new Set(classes.map(item => item.fullType)).size, classes.length, 'Duplicate class definitions need manual review');
  const byName = new Map(classes.map(item => [item.fullType, item]));
  const ancestry = (item, seen = new Set()) => {
    if (seen.has(item.fullType)) return undefined;
    seen.add(item.fullType);
    const base = item.baseType.replace(/<.*$/, '');
    // Only exact reviewed Unity roots are accepted. Other hierarchies must
    // be deliberately added, not guessed from names ending in "Unit".
    const parent = byName.get(base.includes('.') ? base : `${item.fullType.slice(0, item.fullType.lastIndexOf('.'))}.${base}`);
    const chain = parent && ancestry(parent, seen);
    if (parent) return chain ? [parent.fullType, ...chain] : undefined;
    const root = base.replace(/^Unity\.VisualScripting\./, '');
    if (Object.hasOwn(unityRoots, root) && (base.startsWith('Unity.VisualScripting.') || (item.unityUsing && !item.aliases.includes(root)))) {
      return root === 'TriggerEventUnit' ? unityRoots[root] : [item.baseType, 'Unity.VisualScripting.Unit'];
    }
    return undefined;
  };
  const nodes = [], excludedClasses = [];
  for (const item of classes) {
    const chain = ancestry(item);
    if (!chain || item.abstract || !item.fullType.startsWith('BS.VisualScripting.')) {
      excludedClasses.push({ fullType: item.fullType, path: item.source.path,
        reason: !item.fullType.startsWith('BS.VisualScripting.') ? 'not-current-creator-namespace' : item.abstract ? 'abstract-base' : 'no-reviewed-Unit-ancestry' });
      continue;
    }
    const { end, unityUsing, aliases, abstract, baseType, definitionSeen, baseDefinition, ...node } = item;
    nodes.push({ ...node, ancestry: chain, isEvent: chain.some(type => /(?:^|\.)EventUnit</.test(type)),
      portCoverage: 'declared-source-only', inheritedPortsResolved: false,
      definitionSeen, callsBaseDefinition: baseDefinition,
      runtimeAllowance: 'not-established-by-source',
      portGuidance: 'Declared Definition calls only; conditional calls may not be active. Inherited, helper-created and dynamic ports are not resolved. Inspect actual Unity ports before wiring.' });
  }
  return { nodes: nodes.sort((a, b) => a.fullType.localeCompare(b.fullType, 'en')),
    excludedClasses: excludedClasses.sort((a, b) => a.fullType.localeCompare(b.fullType, 'en')) };
}

async function readBounded(url, maxBytes, fetcher) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, `Source fetch failed: ${url}`);
  assert.ok(!response.redirected, 'Unexpected source redirect');
  const parts = []; let size = 0;
  for await (const part of response.body) { size += part.length; assert.ok(size <= maxBytes, 'Source exceeds size bound'); parts.push(part); }
  return Buffer.concat(parts);
}

export async function collectCreatorNodes(revision, { fetcher = fetch, cacheDir } = {}) {
  assert.match(revision, /^[a-f0-9]{40}$/, 'An immutable SDK commit is required');
  const tree = JSON.parse(await readBounded(`https://api.github.com/repos/${repository}/git/trees/${revision}?recursive=1`, 8 * 1024 * 1024, fetcher));
  assert.equal(tree.sha, revision, 'Tree does not match the requested commit');
  assert.equal(tree.truncated, false, 'Refuse incomplete SDK tree');
  assert.ok(Array.isArray(tree.tree));
  const selected = tree.tree.filter(entry => entry.type === 'blob' && (entry.path === 'LICENSE.md' || entry.path === 'package.json' || /^VisualScripting\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.cs$/.test(entry.path))).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  assert.ok(selected.length >= 3 && selected.length <= 500, 'Unexpected source count');
  assert.equal(new Set(selected.map(entry => entry.path)).size, selected.length);
  assert.ok(selected.some(entry => entry.path === 'LICENSE.md') && selected.some(entry => entry.path === 'package.json'));
  const inputs = [];
  let totalBytes = 0;
  for (const entry of selected) {
    assert.match(entry.sha, /^[a-f0-9]{40}$/);
    assert.ok(Number.isSafeInteger(entry.size) && entry.size > 0 && entry.size <= 2 * 1024 * 1024);
    const sourceUrl = `https://raw.githubusercontent.com/${repository}/${revision}/${entry.path}`;
    let bytes;
    const cached = cacheDir && resolve(cacheDir, revision, ...entry.path.split('/'));
    if (cached) { try { bytes = await readFile(cached); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    bytes ??= await readBounded(sourceUrl, 2 * 1024 * 1024, fetcher);
    assert.equal(bytes.length, entry.size, `Source size differs: ${entry.path}`);
    assert.equal(blobHash(bytes), entry.sha, `Source hash differs: ${entry.path}`);
    totalBytes += bytes.length;
    assert.ok(totalBytes <= 32 * 1024 * 1024, 'Source set exceeds total size bound');
    if (cached) { await mkdir(dirname(cached), { recursive: true }); await writeFile(cached, bytes); }
    inputs.push({ path: entry.path, sourceUrl, blobSha: entry.sha, sha256: sha256(bytes), text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) });
  }
  const license = inputs.find(input => input.path === 'LICENSE.md');
  assert.equal(license.sha256, reviewedLicenseSha256, 'Review changed SDK licence before importing');
  const pkg = JSON.parse(inputs.find(input => input.path === 'package.json').text);
  assert.equal(pkg.name, 'com.sidequest.creator-sdk');
  const extracted = extractCreatorUnits(inputs);
  assert.ok(extracted.nodes.length > 0, 'No reviewed Unit classes found');
  return { schemaVersion: 1, repository: `https://github.com/${repository}`, branch: 'feature/greenfield', revision,
    packageVersion: pkg.version, rootTypeReference, sourceSetSha256: createHash('sha256').update(JSON.stringify(inputs.map(({ path, sha256 }) => ({ path, sha256 })))).digest('hex'),
    license, sources: inputs.map(({ text, ...source }) => source), ...extracted };
}

async function main() {
  assert.ok(process.argv.length === 4 || process.argv.length === 6, 'Usage: node scripts/sync-creator-vs-nodes.mjs --revision COMMIT [--cache-dir PATH]');
  assert.equal(process.argv[2], '--revision');
  if (process.argv.length === 6) assert.equal(process.argv[4], '--cache-dir');
  const snapshot = await collectCreatorNodes(process.argv[3], { cacheDir: process.argv[5] });
  const output = fileURLToPath(new URL('../src/resources/creator-vs-nodes-snapshot.ts', import.meta.url));
  await writeFile(output, '// Generated by scripts/sync-creator-vs-nodes.mjs; immutable upstream source, not runtime validation.\n' +
    `export const CREATOR_VS_NODES_SNAPSHOT = ${JSON.stringify(snapshot, null, 2)};\n`);
  console.log(JSON.stringify({ output, revision: snapshot.revision, nodes: snapshot.nodes.length, excluded: snapshot.excludedClasses.length }));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error); process.exitCode = 1; });
