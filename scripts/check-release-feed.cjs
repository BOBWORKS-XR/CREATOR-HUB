const semver = require('semver');

// Existing Hub releases read this exact endpoint before fetching signed metadata.
const LEGACY_LIMIT = 256 * 1024;
const PUBLICATION_HEADROOM = 4 * 1024;
const DESCRIPTOR = 'creator-hub-windows-x86_64.json';
const REPO = 'BOBWORKS-XR/CREATOR-HUB';
function inspectFeed(bytes, expectedVersion) {
  if (!Buffer.isBuffer(bytes)) throw Error('Supply original UTF-8 response bytes.');
  if (bytes.length > LEGACY_LIMIT) throw Error(`Release list is ${bytes.length} bytes; installed Hub limit is ${LEGACY_LIMIT}.`);
  if (!semver.valid(expectedVersion)) throw Error('Invalid expected release version.');
  const releases = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(releases)) throw Error('Release list is not an array.');
  const item = releases.find(r => r.tag_name === `v${expectedVersion}` && !r.draft);
  if (!item || !Array.isArray(item.assets) || ![DESCRIPTOR, `${DESCRIPTOR}.minisig`].every(name => item.assets.some(a => a.name === name))) {
    throw Error('Expected public release with both signed catalog files is missing.');
  }
  const previousStable = releases.filter(r => !r.draft && !r.prerelease)
    .map(r => typeof r.tag_name === 'string' ? r.tag_name.replace(/^v/, '') : '')
    .filter(v => semver.valid(v) && !semver.prerelease(v) && semver.lt(v, expectedVersion))
    .sort(semver.rcompare)[0] || null;
  return { bytes: bytes.length, limit: LEGACY_LIMIT, headroom: LEGACY_LIMIT - bytes.length, release: item.tag_name, assets: item.assets.length, previousStable };
}
function inspectDraft(currentBytes, draft, expectedVersion) {
  if (!Buffer.isBuffer(currentBytes) || currentBytes.length > LEGACY_LIMIT) throw Error('Existing public feed already exceeds installed Hub limits.');
  if (!semver.valid(expectedVersion) || !draft || draft.tag_name !== `v${expectedVersion}` || draft.draft !== true) throw Error('Expected an unpublished draft with the exact version.');
  const existing = JSON.parse(currentBytes.toString('utf8'));
  if (!Array.isArray(existing)) throw Error('Release list is not an array.');
  if (existing.some(item => item.tag_name === draft.tag_name)) throw Error('This release is already public; do not replace it.');
  // Retain every GitHub field, including assets and body. A compact tag list misses the defect.
  const published = { ...draft, draft: false, published_at: new Date().toISOString() };
  const projected = Buffer.from(JSON.stringify([published, ...existing].slice(0, 10)));
  const overhead = Math.max(0, currentBytes.length - Buffer.byteLength(JSON.stringify(existing)));
  const result = inspectFeed(Buffer.concat([projected, Buffer.alloc(overhead, 32)]), expectedVersion);
  if (result.headroom < PUBLICATION_HEADROOM) throw Error(`Draft leaves only ${result.headroom} bytes; need ${PUBLICATION_HEADROOM} bytes of publication headroom. Shorten notes or bundle new evidence attachments before publishing.`);
  return { ...result, draft: true, requiredHeadroom: PUBLICATION_HEADROOM };
}
async function readLiveFeed() {
  const response = await fetch('https://api.github.com/repos/BOBWORKS-XR/CREATOR-HUB/releases?per_page=10', {
    headers: { 'User-Agent': 'Creator-Hub/0.1' }, signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw Error(`GitHub release list failed: HTTP ${response.status}`);
  const parts = [];
  let received = 0;
  for await (const part of response.body) {
    received += part.length;
    if (received > LEGACY_LIMIT) throw Error(`Release list exceeds installed Hub's ${LEGACY_LIMIT}-byte limit.`);
    parts.push(part);
  }
  return Buffer.concat(parts);
}
async function checkLive(expectedVersion) { return inspectFeed(await readLiveFeed(), expectedVersion); }
async function checkDraft(expectedVersion) {
  if (!semver.valid(expectedVersion)) throw Error('Invalid expected release version.');
  const { execFileSync } = require('node:child_process');
  const gh = args => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true }));
  const record = gh(['release', 'view', `v${expectedVersion}`, '--repo', REPO, '--json', 'databaseId,isDraft']);
  if (!record.isDraft || !Number.isSafeInteger(record.databaseId)) throw Error('Expected an unpublished draft.');
  const draft = gh(['api', `repos/${REPO}/releases/${record.databaseId}`]);
  return inspectDraft(await readLiveFeed(), draft, expectedVersion);
}
module.exports = { LEGACY_LIMIT, PUBLICATION_HEADROOM, inspectFeed, inspectDraft, checkLive, checkDraft };
if (require.main === module) (process.argv[3] === '--draft' ? checkDraft(process.argv[2]) : checkLive(process.argv[2]))
  .then(result => console.log(JSON.stringify(result)), error => { console.error(error.message); process.exitCode = 1; });
