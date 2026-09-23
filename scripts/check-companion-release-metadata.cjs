const fs = require('node:fs');
const path = require('node:path');
const semver = require('semver');

const MAX_RELEASE_FEED = 256 * 1024;
const MAX_DESCRIPTOR = 32 * 1024;
const DESCRIPTOR_NAME = 'creator-hub-windows-x86_64.json';

function validateLatestRelease(pin, app, releases) {
  const candidates = releases
    .filter(release => release && release.draft !== true && typeof release.tag_name === 'string')
    .map(release => ({ release, version: semver.valid(release.tag_name.replace(/^v/, '')) }))
    .filter(item => item.version)
    .sort((a, b) => semver.rcompare(a.version, b.version));
  const latest = candidates[0];
  if (!latest) throw Error(`${app}: public release feed contains no valid versions.`);

  const assets = new Set((latest.release.assets || []).map(asset => asset.name));
  for (const name of [DESCRIPTOR_NAME, `${DESCRIPTOR_NAME}.minisig`]) {
    if (!assets.has(name)) throw Error(`${app}: ${latest.release.tag_name} is missing ${name}; Hub cannot verify or install this release.`);
  }
  if (latest.version !== pin.version) {
    throw Error(`${app}: reviewed pin ${pin.version} is stale; newest public release is ${latest.version}.`);
  }

  const descriptorAsset = latest.release.assets.find(asset => asset.name === DESCRIPTOR_NAME);
  if (!descriptorAsset?.browser_download_url) throw Error(`${app}: signed descriptor has no download URL.`);
  return descriptorAsset.browser_download_url;
}

async function checkApp(app, pin, token, fetchImpl = fetch) {
  const repo = app === 'setup' ? 'CREATOR-PROJECT-SETUP' : 'CREATOR-WORKS-UNITY-MCP';
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Creator-Hub-release-preflight' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchImpl(`https://api.github.com/repos/BOBWORKS-XR/${repo}/releases?per_page=10`, { headers });
  if (!response.ok) throw Error(`${app}: GitHub release feed returned HTTP ${response.status}.`);
  const feed = await response.text();
  if (Buffer.byteLength(feed) > MAX_RELEASE_FEED) throw Error(`${app}: release feed exceeds the 256 KiB limit used by Hub.`);

  const descriptorUrl = validateLatestRelease(pin, app, JSON.parse(feed));
  const descriptorResponse = await fetchImpl(descriptorUrl, { headers: { 'User-Agent': 'Creator-Hub-release-preflight' } });
  if (!descriptorResponse.ok) throw Error(`${app}: signed release descriptor download returned HTTP ${descriptorResponse.status}.`);
  const descriptorText = await descriptorResponse.text();
  if (Buffer.byteLength(descriptorText) > MAX_DESCRIPTOR) throw Error(`${app}: signed release descriptor exceeds Hub's size limit.`);
  const descriptor = JSON.parse(descriptorText);
  const expectedId = app === 'setup' ? 'creator-project-setup' : 'creator-works-mcp';
  for (const [field, expected] of Object.entries({ appId: expectedId, version: pin.version, assetName: pin.assetName,
    sha256: pin.installerSha256, executableSha256: pin.executableSha256 })) {
    if (descriptor[field] !== expected) throw Error(`${app}: latest signed descriptor does not match reviewed pin field ${field}.`);
  }
  process.stdout.write(`${app}: latest public descriptor matches reviewed ${pin.version} hashes.\n`);
}

async function main() {
  const pins = JSON.parse(fs.readFileSync(path.join(__dirname, 'prerelease-apps.json'), 'utf8'));
  for (const app of ['setup', 'mcp']) await checkApp(app, pins[app], process.env.GH_TOKEN);
}

if (require.main === module) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
module.exports = { MAX_RELEASE_FEED, MAX_DESCRIPTOR, validateLatestRelease, checkApp };
