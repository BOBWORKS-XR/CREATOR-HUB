const test = require('node:test');
const assert = require('node:assert/strict');
const { applications, validVersion, reviewReceipt, updaterManifest } = require('./release-descriptor.cjs');

const descriptor = { appId: 'creator-hub', version: '0.1.0-alpha.3', byteLength: 123, sha256: 'a'.repeat(64), executableSha256: 'b'.repeat(64) };
const receipt = { ...descriptor, schemaVersion: 1, approvedForPrerelease: true, identityProtocol: 0, lifecycleProtocol: 0, installerProtocol: 1,
  minHubVersion: '0.1.0-alpha.3', installerScope: 'guarded-nsis-update-default-location-no-msi',
  evidence: ['https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/123'] };

test('release versions use canonical SemVer without build metadata or path content', () => {
  assert.equal(validVersion('0.1.0-alpha.3'), true);
  for (const value of ['v1.0.0', '01.0.0', '1.0.0+other', '../1.0.0', '1.0.0-', null]) assert.equal(validVersion(value), false);
});
test('native claims are bound to exact reviewed app, version, size and both hashes', () => {
  assert.deepEqual(reviewReceipt(receipt, descriptor, applications.hub), { identityProtocol: 0, lifecycleProtocol: 0, installerProtocol: 1, minHubVersion: '0.1.0-alpha.3' });
  for (const key of ['appId', 'version', 'byteLength', 'sha256', 'executableSha256']) assert.throws(() => reviewReceipt({ ...receipt, [key]: 'different' }, descriptor, applications.hub), /exact artifact/);
  for (const patch of [{ approvedForPrerelease: false }, { installerProtocol: 2 }, { installerScope: 'all installers' }, { evidence: [] }, { evidence: ['https://example.com/check'] }, { evidence: ['https://github.com/BOBWORKS-XR/OTHER/actions/runs/123'] }, { minHubVersion: 'bad' }]) {
    assert.throws(() => reviewReceipt({ ...receipt, ...patch }, descriptor, applications.hub));
  }
});
test('Hub updater feed binds the same versioned repository asset and detached signature', () => {
  const signature = Buffer.from('untrusted comment: test\nfixture').toString('base64');
  const manifest = updaterManifest(applications.hub, descriptor.version, 'Creator-Hub-0.1.0-alpha.3-Windows-setup.exe', signature);
  assert.equal(manifest.version, descriptor.version);
  assert.equal(manifest.platforms['windows-x86_64'].signature, signature);
  assert.equal(manifest.platforms['windows-x86_64'].url, 'https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.0-alpha.3/Creator-Hub-0.1.0-alpha.3-Windows-setup.exe');
  for (const asset of ['../setup.exe', 'file with spaces.exe', 'other.exe?x=1']) assert.throws(() => updaterManifest(applications.hub, descriptor.version, asset, signature));
  assert.throws(() => updaterManifest(applications.hub, descriptor.version, 'setup.exe', 'invalid'));
});
