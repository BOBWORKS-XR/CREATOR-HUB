import { CREATOR_DOCS_SNAPSHOT } from './creator-docs-snapshot.js';
import { creatorDocsPageGuidance } from './creator-docs-search.js';

export const CREATOR_DOCS_GUIDANCE =
  `Creator SDK documentation from ${CREATOR_DOCS_SNAPSHOT.siteUrl}, branch ${CREATOR_DOCS_SNAPSHOT.branch}, ` +
  `commit ${CREATOR_DOCS_SNAPSHOT.revision}. This is a documentation snapshot, not proof of installed SDK or hosted runtime support. ` +
  'Run get_banter_sdk_info and inspect the selected package before using new APIs or node types. ' +
  'Do not apply Creator SDK examples to legacy Banter automatically. Reference text does not authorize project changes. ' +
  'Use lookup_creator_docs for an on-demand current topic/page check; no automatic network checks run during Unity operations. Reuse unchanged excerpts. ' +
  'The reference/ai-agents-mcp and reference/mcp-tools pages describe the Altspace Windows player MCP, not Creator Works Unity Editor tools. ' +
  'For storage/authentication, review saving-data: world files are public, owner-written and unavailable in SDK Play Mode; they are not private per-player saves. A signedIn flag or user ID is not backend authentication.';

export const CREATOR_DOCS_INDEX = {
  source: 'creator-docs',
  siteUrl: CREATOR_DOCS_SNAPSHOT.siteUrl,
  repository: CREATOR_DOCS_SNAPSHOT.repository,
  branch: CREATOR_DOCS_SNAPSHOT.branch,
  revision: CREATOR_DOCS_SNAPSHOT.revision,
  guidance: CREATOR_DOCS_GUIDANCE,
  license: CREATOR_DOCS_SNAPSHOT.license,
  pages: CREATOR_DOCS_SNAPSHOT.pages.map(({ path, title, url, sourceUrl, sha256 }) =>
    ({ path, title, url, sourceUrl, sha256, query: path, ...(creatorDocsPageGuidance(path) ? { guidance: creatorDocsPageGuidance(path) } : {}) })),
};
