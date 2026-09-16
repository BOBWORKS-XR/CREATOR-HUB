const semver = require('semver');

// Existing Hub releases read this exact endpoint before fetching signed metadata.
const LEGACY_LIMIT = 256 * 1024;
const DESCRIPTOR = 'creator-hub-windows-x86_64.json';
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
  return { bytes: bytes.length, limit: LEGACY_LIMIT, headroom: LEGACY_LIMIT - bytes.length, release: item.tag_name, assets: item.assets.length };
}
async function checkLive(expectedVersion) {
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
  return inspectFeed(Buffer.concat(parts), expectedVersion);
}
module.exports = { LEGACY_LIMIT, inspectFeed, checkLive };
if (require.main === module) checkLive(process.argv[2]).then(result => console.log(JSON.stringify(result)), error => { console.error(error.message); process.exitCode = 1; });
