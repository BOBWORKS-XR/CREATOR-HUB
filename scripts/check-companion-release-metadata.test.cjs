const test = require('node:test');
const assert = require('node:assert/strict');
const { validateLatestRelease, checkApp, MAX_RELEASE_FEED } = require('./check-companion-release-metadata.cjs');

const pin = { version: '0.3.4', assetName: 'Creator.Project.Setup_0.3.4_x64-setup.exe',
  installerSha256: 'a'.repeat(64), executableSha256: 'b'.repeat(64) };
const release = (tag, names) => ({ tag_name: `v${tag}`, draft: false, prerelease: false,
  assets: names.map(name => ({ name, browser_download_url: `https://github.com/example/${name}` })) });
const descriptorAssets = ['creator-hub-windows-x86_64.json', 'creator-hub-windows-x86_64.json.minisig'];

test('candidate preflight requires signed metadata on the newest non-draft release', () => {
  const url = validateLatestRelease(pin, 'setup', [release('0.3.1', descriptorAssets), release('0.3.4', descriptorAssets)]);
  assert.equal(url, 'https://github.com/example/creator-hub-windows-x86_64.json');
  assert.throws(() => validateLatestRelease(pin, 'setup', [release('0.3.1', descriptorAssets), release('0.3.4', [])]), /0.3.4 is missing creator-hub-windows-x86_64\.json/);
});

test('drafts are ignored and stale versions or hashes fail before packaging', async () => {
  const assets = descriptorAssets.map(name => ({ name, browser_download_url: `https://example.test/${name}` }));
  assert.equal(validateLatestRelease(pin, 'setup', [{ ...release('9.0.0', []), draft: true }, { ...release('0.3.4', []), assets }]), 'https://example.test/creator-hub-windows-x86_64.json');
  assert.throws(() => validateLatestRelease({ ...pin, version: '0.3.1' }, 'setup', [release('0.3.4', descriptorAssets)]), /pin 0.3.1 is stale/);

  const fetchImpl = async url => url.includes('/releases?')
    ? { ok: true, text: async () => JSON.stringify([release('0.3.4', descriptorAssets)]) }
    : { ok: true, text: async () => JSON.stringify({ appId: 'creator-project-setup', version: '0.3.4', assetName: pin.assetName,
      sha256: pin.installerSha256, executableSha256: 'c'.repeat(64) }) };
  await assert.rejects(checkApp('setup', pin, undefined, fetchImpl), /does not match reviewed pin field executableSha256/);
});

test('release feed response limit matches Hub catalog discovery', () => {
  assert.equal(MAX_RELEASE_FEED, 256 * 1024);
});
