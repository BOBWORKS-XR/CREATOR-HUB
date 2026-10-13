const test = require('node:test');
const assert = require('node:assert/strict');
const { target, review, updater, stageAccepted } = require('./native-hub-descriptor.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const names = ['macos-x86_64-app', 'macos-aarch64-app', 'linux-x86_64-appimage', 'linux-x86_64-deb', 'linux-x86_64-rpm'];
const signature = Buffer.from('untrusted comment: fixture\ntest').toString('base64');
test('replaced packaging input is refused before signing, and accepted copies cannot be overwritten', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-package-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.AppImage');
  const descriptor = { byteLength: 3, sha256: crypto.createHash('sha256').update('old').digest('hex') };
  fs.writeFileSync(source, 'new');
  await assert.rejects(stageAccepted(source, path.join(root, 'refused.AppImage'), descriptor), /changed while staging/);
  assert.equal(fs.existsSync(path.join(root, 'refused.AppImage.sig')), false);
  fs.writeFileSync(source, 'old');
  const destination = path.join(root, 'accepted.AppImage');
  await stageAccepted(source, destination, descriptor);
  await assert.rejects(stageAccepted(source, destination, descriptor));
  assert.equal(fs.readFileSync(destination, 'utf8'), 'old');
});
test('native descriptors and updater entries match each installed package, never DMG or Windows NSIS', () => {
  const descriptors = new Set();
  for (const name of names) {
    const selected = target(name); descriptors.add(selected.descriptor);
    const feed = updater('0.2.0', `Hub-0.2.0${selected.extension}`, signature, selected);
    assert.deepEqual(Object.keys(feed.platforms), [selected.updaterKey]);
    for (const asset of ['Hub.exe', 'Hub.dmg', '../Hub.AppImage', 'Hub.deb?x=1']) assert.throws(() => updater('0.2.0', asset, signature, selected));
  }
  assert.equal(descriptors.size, names.length);
  assert.throws(() => target('linux-aarch64-deb'));
});
test('native publication requires exact reviewed update/restart/preservation checks and scoped artifact identity', () => {
  for (const name of names) {
    const selected = target(name);
    const descriptor = { appId: 'creator-hub', version: '0.2.0', platform: selected.platform, architecture: selected.architecture, packageType: selected.packageType, byteLength: 12, sha256: 'a'.repeat(64), executableSha256: 'b'.repeat(64) };
    const receipt = { ...descriptor, schemaVersion: 1, approvedForStable: true, identityProtocol: 1, lifecycleProtocol: 1, installerProtocol: 1, minHubVersion: '0.1.12', installerScope: selected.scope,
      evidence: ['https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/123'], checks: { discovery: true, cancelPreserves: true, installRestart: true, installedHash: true, settingsPreserved: true, connectionsPreserved: true } };
    assert.equal(review(receipt, descriptor, selected).installerProtocol, 1);
    for (const field of ['platform', 'architecture', 'packageType', 'sha256', 'executableSha256', 'byteLength']) assert.throws(() => review({ ...receipt, [field]: 'wrong' }, descriptor, selected));
    for (const field of Object.keys(receipt.checks)) assert.throws(() => review({ ...receipt, checks: { ...receipt.checks, [field]: false } }, descriptor, selected));
    assert.throws(() => review({ ...receipt, installerScope: 'guarded-nsis-update-default-location-no-msi' }, descriptor, selected));
    assert.throws(() => review({ ...receipt, approvedForStable: false }, descriptor, selected));
  }
});
