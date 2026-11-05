const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'can', 'do', 'for', 'how', 'i', 'in', 'is', 'it', 'of', 'on', 'or', 'the', 'to', 'use', 'with']);

export function creatorDocsTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9_]+/).filter(term => term.length > 1 && !STOP_WORDS.has(term)))];
}

export const CREATOR_STORAGE_AUTH_GUIDANCE =
  'Storage limits: Persist File nodes / BS.PersistFileBridge store public world files; only the signed-in world owner can write, and they are unavailable in SDK Play Mode. ' +
  'They are not private per-player saves. Space state expires 24 hours after its last change; user state is transient. localStorage belongs to one device/app install, not an account. ' +
  'The docs do not establish a general world-facing authentication-token contract for an external backend. A user ID or signedIn flag is not proof of identity. ' +
  'Do not embed shared secrets in graphs/pages, export host credentials, or bypass the SDK allow-list (including by substituting reflected PlayerPrefs). ' +
  'Review javascript-api/saving-data.md and multiplayer/overview.md; verify issuer, audience, expiry and guest handling before designing backend authentication.';

export const CREATOR_PLAYER_MCP_GUIDANCE =
  'These pages describe the Altspace Windows player MCP server, not Creator Works Unity Editor tools. ' +
  'Do not assume its movement/view/voice tools are registered here or automatically configure a player connection.';

export function creatorDocsPageGuidance(path: string): string | undefined {
  if (['reference/ai-agents-mcp.md', 'reference/mcp-tools.md'].includes(path)) return CREATOR_PLAYER_MCP_GUIDANCE;
  if (['javascript-api/saving-data.md', 'multiplayer/overview.md'].includes(path)) return CREATOR_STORAGE_AUTH_GUIDANCE;
  return undefined;
}

function preferredPages(query: string): Map<string, number> {
  const terms = creatorDocsTerms(query);
  const has = (pattern: RegExp) => terms.some(term => pattern.test(term));
  const result = new Map<string, number>();
  if (has(/^(?:auth(?:entication|enticated|orization)?|token|tokens|jwt|credentials?|signedin|signin|login|playerprefs|storage|persist(?:ence|ent|filebridge|fileset|fileget)?|durable|saves?|saving|inventory|progress)$/)) {
    result.set('javascript-api/saving-data.md', 80);
    result.set('multiplayer/overview.md', 12);
  }
  if (has(/^(?:mcp|agents?)$/)) {
    result.set('reference/ai-agents-mcp.md', 40);
    result.set('reference/mcp-tools.md', 35);
  }
  return result;
}

/** Ranking hints only. Never convert an alias match into an API/support claim. */
export function scoreCreatorDocsPage(path: string, title: string, text: string, query: string): number {
  const terms = creatorDocsTerms(query);
  const count = (value: string) => terms.filter(term => value.toLowerCase().includes(term)).length;
  return (preferredPages(query).get(path) ?? 0) + count(`${path} ${title}`) * 4 + count(text);
}

export function scoreCreatorDocsSection(path: string, title: string, text: string, query: string): number {
  const terms = creatorDocsTerms(query);
  const lower = `${title}\n${text}`.toLowerCase();
  const direct = terms.filter(term => lower.includes(term)).length;
  const pageWeight = preferredPages(query).get(path) ?? 0;
  const auth = terms.some(term => /^(?:auth|authenticated|authentication|token|tokens|jwt|credentials?|signin|login|signedin)$/.test(term));
  const sectionHint = pageWeight && /world files|rules and limits|no built-in|localstorage/i.test(lower) ? 8 : 0;
  return pageWeight + direct + terms.filter(term => title.toLowerCase().includes(term)).length * 4 +
    sectionHint + (auth && /signed in|owner|no built-in/i.test(lower) ? 12 : 0);
}

/** Exact-reference lookup should keep its old all-terms behavior outside known aliases. */
export function matchesCreatorDocsSection(path: string, title: string, text: string, query: string): boolean {
  const terms = creatorDocsTerms(query);
  return terms.length > 0 && (terms.every(term => `${path}\n${title}\n${text}`.toLowerCase().includes(term)) || preferredPages(query).has(path));
}
