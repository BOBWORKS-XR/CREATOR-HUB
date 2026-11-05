import { BANTER_CUSTOM_VS_NODES, type BanterCustomVSNode } from '../resources/banter-custom-vs-nodes.js';
import { CREATOR_VS_NODES, CREATOR_VS_NODE_GUIDANCE, CREATOR_VS_NODE_INDEX } from '../resources/creator-vs-nodes.js';

export const SIDEQUEST_NODE_RESPONSE_MAX_BYTES = 32 * 1024;
export const SEARCH_SIDEQUEST_VS_NODES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 128, description: 'Node name, full type, source category or declared port key/type.' },
    category: { type: 'string', minLength: 1, maxLength: 128, description: 'Exact case-insensitive source category.' },
    source: { type: 'string', enum: ['all', 'creator', 'legacy'], default: 'all', description: 'Keep Creator source definitions separate from the legacy Banter sample catalog.' },
    limit: { type: 'integer', minimum: 1, maximum: 25, default: 10, description: 'Maximum nodes; the fixed response budget may return fewer. Refine the query or source when truncated.' },
  },
  required: ['query'],
};
export const SEARCH_SIDEQUEST_VS_NODES_DESCRIPTION =
  'Search Creator SDK Unit definitions or the legacy Banter catalog. Entries include revision, hashes and declared ports/defaults. ' +
  'Inherited/dynamic ports and runtime allowance are unverified; check get_banter_sdk_info first.';

function checked(query: unknown, category: unknown, limit: unknown) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q || q.length > 128 || /[\u0000-\u001f]/.test(String(query))) return { error: 'query must contain between 1 and 128 characters.' };
  if (category !== undefined && typeof category !== 'string') return { error: 'category must be a string.' };
  const cat = typeof category === 'string' ? category.trim() : undefined;
  if (cat !== undefined && (!cat || cat.length > 128 || /[\u0000-\u001f]/.test(String(category)))) return { error: 'category must contain between 1 and 128 characters.' };
  const max = limit ?? 10;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 25) return { error: 'limit must be a whole number between 1 and 25.' };
  return { query: q, category: cat, limit: max };
}

function rank(node: { name: string; fullType: string }, query: string): number {
  const name = node.name.toLowerCase(), type = node.fullType.toLowerCase();
  return name === query ? 0 : type === query ? 1 : name.startsWith(query) ? 2 : type.endsWith(`.${query}`) ? 3 : 4;
}

function legacyMatches(query: string, category?: string) {
  const terms = query.toLowerCase().split(/\s+/);
  return Object.values(BANTER_CUSTOM_VS_NODES as Record<string, BanterCustomVSNode>).filter(node => {
    if (category !== undefined && node.category.toLowerCase() !== category.toLowerCase()) return false;
    const text = [node.name, node.fullType, node.category, ...node.defaultValues.flatMap(value => [value.name, value.type || '']), ...Object.keys(node.serializedFields)].join(' ').toLowerCase();
    return terms.every(term => text.includes(term));
  }).sort((a, b) => rank(a, query.toLowerCase()) - rank(b, query.toLowerCase()) || a.name.localeCompare(b.name));
}

// Kept as a positional API so existing imports can preserve their exact shape.
export function searchLegacySidequestVSNodes(query: string, category?: string, limit?: number): unknown {
  const args = checked(query, category, limit);
  if (args.error) return { success: false, error: args.error, nodes: [] };
  const matches = legacyMatches(args.query!, args.category);
  return { success: true, query: args.query, category: args.category, count: Math.min(matches.length, args.limit!),
    totalMatches: matches.length, truncated: matches.length > args.limit!, catalogSize: Object.keys(BANTER_CUSTOM_VS_NODES).length,
    catalogScope: 'Source-observed legacy Banter custom nodes; confirm the selected package profile with get_banter_sdk_info before authoring.',
    nodes: matches.slice(0, args.limit).map(({ name, fullType, category, version, isEvent, defaultValues, serializedFields }) =>
      ({ name, fullType, category, version, isEvent, defaultValues, serializedFields })) };
}

export function searchSourceAwareSidequestVSNodes(args: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(args).some(key => !['query', 'category', 'limit', 'source'].includes(key))) {
    return { success: false, error: 'Unknown search fields are refused.', nodes: [] };
  }
  const input = checked(args.query, args.category, args.limit);
  if (input.error) return { success: false, error: input.error, nodes: [] };
  const source = args.source === undefined ? 'all' : args.source;
  if (typeof source !== 'string' || !['all', 'creator', 'legacy'].includes(source)) return { success: false, error: 'source must be all, creator or legacy.', nodes: [] };
  const terms = input.query!.toLowerCase().split(/\s+/);
  const creator = source === 'legacy' ? [] : CREATOR_VS_NODES.filter(node => {
    if (input.category !== undefined && node.category?.toLowerCase() !== input.category.toLowerCase()) return false;
    const text = [node.name, node.fullType, node.title, node.category, ...node.ports.flatMap(port => [port.key, port.valueType || ''])].join(' ').toLowerCase();
    return terms.every(term => text.includes(term));
  }).map(node => ({ ...node, catalogSource: 'creator', catalogRevision: CREATOR_VS_NODE_INDEX.revision }));
  const legacy = source === 'creator' ? [] : legacyMatches(input.query!, input.category).map(node => ({
    name: node.name, fullType: node.fullType, category: node.category, version: node.version, isEvent: node.isEvent,
    defaultValues: node.defaultValues, serializedFields: node.serializedFields, catalogSource: 'legacy',
    catalogScope: 'Serialized legacy sample defaults, not a complete port definition or proof this node is installed.',
  }));
  const matches = [...creator, ...legacy].sort((a, b) => rank(a, input.query!.toLowerCase()) - rank(b, input.query!.toLowerCase()) || a.fullType.localeCompare(b.fullType, 'en'));
  const nodes = matches.slice(0, input.limit);
  const result = { success: true, query: input.query, category: input.category, source, count: nodes.length,
    totalMatches: matches.length, truncated: matches.length > nodes.length,
    catalogSize: (source === 'legacy' ? 0 : CREATOR_VS_NODES.length) + (source === 'creator' ? 0 : Object.keys(BANTER_CUSTOM_VS_NODES).length),
    creator: { revision: CREATOR_VS_NODE_INDEX.revision, packageVersion: CREATOR_VS_NODE_INDEX.packageVersion, sourceSetSha256: CREATOR_VS_NODE_INDEX.sourceSetSha256 },
    guidance: CREATOR_VS_NODE_GUIDANCE, nodes };
  while (Buffer.byteLength(JSON.stringify(result)) > SIDEQUEST_NODE_RESPONSE_MAX_BYTES && nodes.length > 0) {
    nodes.pop(); result.count = nodes.length; result.truncated = true;
  }
  if (matches.length && !nodes.length) return { success: false, error: 'A definition exceeds the response budget; inspect its pinned source directly.', nodes: [] };
  return result;
}
