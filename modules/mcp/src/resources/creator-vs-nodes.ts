import { CREATOR_VS_NODES_SNAPSHOT } from './creator-vs-nodes-snapshot.js';

export const CREATOR_VS_NODE_GUIDANCE =
  'Creator SDK Unit classes from a pinned upstream source revision, not the selected installed package. ' +
  'Run get_banter_sdk_info and compare the actual package/source before authoring. Matching version numbers alone do not prove matching source. ' +
  'Ports are source-declared Definition calls, not a complete runtime inventory: inherited, conditional, helper-created and dynamic ports need Unity inspection. ' +
  'Unknown types, keys and defaults must not be guessed. Source existence does not establish hosted runtime allowance or authorize graph changes.';

export const CREATOR_VS_NODE_INDEX = {
  source: 'creator',
  repository: CREATOR_VS_NODES_SNAPSHOT.repository,
  branch: CREATOR_VS_NODES_SNAPSHOT.branch,
  revision: CREATOR_VS_NODES_SNAPSHOT.revision,
  packageVersion: CREATOR_VS_NODES_SNAPSHOT.packageVersion,
  sourceSetSha256: CREATOR_VS_NODES_SNAPSHOT.sourceSetSha256,
  nodeCount: CREATOR_VS_NODES_SNAPSHOT.nodes.length,
  excludedClassCount: CREATOR_VS_NODES_SNAPSHOT.excludedClasses.length,
  guidance: CREATOR_VS_NODE_GUIDANCE,
  license: CREATOR_VS_NODES_SNAPSHOT.license,
};

export const CREATOR_VS_NODES = CREATOR_VS_NODES_SNAPSHOT.nodes;

// Reviewed complete Definition bodies; a changed source hash falls back to warnings.
// This qualifies declared ports only, never installed/hosted runtime compatibility.
const COMPLETE_PORT_CONTRACTS: Record<string, string> = {
  'BS.VisualScripting.PersistFileSet': '976e128f6cf8ce65ae3df97c3c99289556de24e7e720153274e163367444249e',
  'BS.VisualScripting.PersistFileGet': '2f4e021dc2e17bcec28e5607e699e188e0f93521b18dc2ea15a694f157c545aa',
  'BS.VisualScripting.SetSpaceStateValue': '3af2b5a035ea87b7f52f77ca6dc99edd7e8d0d246667697fd24ae9dbb19c0236',
};

export function hasVerifiedCompletePortContract(node: { fullType: string; source: { sha256: string } }): boolean {
  return COMPLETE_PORT_CONTRACTS[node.fullType] === node.source.sha256;
}

export function inspectCreatorCatalogPort(args: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(['source', 'revision', 'fullType', 'kind', 'key']);
  if (Object.keys(args).some(key => !allowed.has(key)) || args.source !== 'creator' ||
      typeof args.fullType !== 'string' || typeof args.key !== 'string' ||
      !['ValueInput', 'ValueOutput', 'ControlInput', 'ControlOutput'].includes(String(args.kind))) {
    return { success: false, error: 'Specify source=creator, fullType, exact port kind and key. Unknown sources/fields are refused.' };
  }
  if (args.revision !== undefined && args.revision !== CREATOR_VS_NODE_INDEX.revision) {
    return { success: false, error: 'Catalog revision mismatch. Inspect the current source before assuming a port exists.' };
  }
  const node = CREATOR_VS_NODES.find(node => node.fullType === args.fullType);
  if (!node) return { success: false, error: 'Type is not in the reviewed Creator Unit catalog. No port assumptions were made.' };
  const ports = node.ports.filter(port => port.kind === args.kind && port.key === args.key);
  if (ports.length !== 1) return { success: false, error: 'No unambiguous declared port match. It may be inherited, dynamic or absent; inspect the actual Unity graph.',
    fullType: node.fullType, unresolvedPorts: node.unresolvedPorts, runtimeVerified: false };
  return { success: true, source: 'creator', revision: CREATOR_VS_NODE_INDEX.revision, fullType: node.fullType,
    port: ports[0], evidence: node.source, runtimeVerified: false, guidance: CREATOR_VS_NODE_GUIDANCE };
}
