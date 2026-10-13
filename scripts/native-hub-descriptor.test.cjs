const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { target, review, updater, stageAccepted, prepareDescriptor } = require('./native-hub-descriptor.cjs');
const { applications, updaterManifest } = require('./release-descriptor.cjs');

const names = ['macos-x86_64-app', 'macos-aarch64-app', 'linux-x86_64-appimage', 'linux-x86_64-deb', 'linux-x86_64-rpm'];
const signature = Buffer.from('untrusted comment: fixture\ntest').toString('base64');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
function fixture(name) {
  const selected = target(name);
  const descriptor = { schemaVersion: 1, appId: 'creator-hub', version: '0.1.13',
    platform: selected.platform, architecture: selected.architecture, packageType: selected.packageType,
    assetName: `Creator-Hub-0.1.13${selected.extension}`, byteLength: 12,
    sha256: 'a'.repeat(64), executableSha256: 'b'.repeat(64) };
  const receipt = { ...descriptor, releaseLine: 'separate-apps', approvedForStable: true,
    identityProtocol: 1, lifecycleProtocol: 1, installerProtocol: 1, minHubVersion: '0.1.12', installerScope: selected.scope,
    evidence: ['https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/123'], checks: {
      discovery: true, cancelPreserves: true, installRestart: true, installedHash: true,
      settingsPreserved: true, connectionsPreserved: true, companionInstallsPreserved: true,
    } };
  return { selected, descriptor, receipt };
}

test('native descriptors and updater keys are distinct for every platform, architecture and package', () => {
  const descriptors = new Set(), keys = new Set();
  for (const name of names) {
    const { selected, descriptor } = fixture(name);
    descriptors.add(selected.descriptor); keys.add(selected.updaterKey);
    assert.ok(Object.isFrozen(selected));
    const feed = updater('0.1.13', descriptor.assetName, signature, selected);
    assert.deepEqual(Object.keys(feed.platforms), [selected.updaterKey]);
    assert.equal(feed.platforms[selected.updaterKey].signature, signature);
    assert.equal(feed.platforms[selected.updaterKey].url,
      `https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.13/${descriptor.assetName}`);
    for (const asset of ['Hub.exe', 'Hub.dmg', '../Hub.AppImage', 'Hub.deb?x=1', 'Hub with spaces.deb']) {
      assert.throws(() => updater('0.1.13', asset, signature, selected));
    }
    for (const other of names.filter(other => other !== name)) {
      const wrong = target(other);
      assert.throws(() => review(fixture(other).receipt, descriptor, wrong));
    }
  }
  assert.equal(descriptors.size, names.length); assert.equal(keys.size, names.length);
  for (const name of ['windows-x86_64-nsis', 'linux-aarch64-deb', 'linux-x86_64-flatpak', 'macos-x86_64-dmg', '__proto__']) {
    assert.throws(() => target(name));
  }
});

test('Windows legacy descriptor naming and updater key remain unchanged', () => {
  const root = path.resolve(__dirname, '..');
  assert.match(fs.readFileSync(path.join(root, 'src-tauri/src/catalog.rs'), 'utf8'),
    /DESCRIPTOR_NAME: &str = "creator-hub-windows-x86_64.json"/);
  const windows = updaterManifest(applications.hub, '0.1.13', 'Creator.Hub_0.1.13_x64-setup.exe', signature);
  assert.deepEqual(Object.keys(windows.platforms), ['windows-x86_64']);
  assert.equal(windows.platforms['windows-x86_64'].url,
    'https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.13/Creator.Hub_0.1.13_x64-setup.exe');
});

test('native publication retains every exact signed-update receipt and separate companion preservation gate', () => {
  for (const name of names) {
    const { selected, descriptor, receipt } = fixture(name);
    assert.deepEqual(review(receipt, descriptor, selected), {
      identityProtocol: 1, lifecycleProtocol: 1, installerProtocol: 1, minHubVersion: '0.1.12',
    });
    for (const field of ['appId', 'version', 'platform', 'architecture', 'packageType', 'sha256', 'executableSha256', 'byteLength']) {
      assert.throws(() => review({ ...receipt, [field]: 'wrong' }, descriptor, selected), /exact artifact/);
    }
    for (const field of Object.keys(receipt.checks)) {
      for (const value of [false, undefined, 1]) {
        assert.throws(() => review({ ...receipt, checks: { ...receipt.checks, [field]: value } }, descriptor, selected), /incomplete/);
      }
    }
    for (const patch of [{ approvedForStable: false }, { schemaVersion: 2 }, { installerProtocol: 0 },
      { installerScope: 'guarded-nsis-update-default-location-no-msi' }, { releaseLine: undefined },
      { releaseLine: 'unified' }, { minHubVersion: 'bad' }, { identityProtocol: 2 }, { lifecycleProtocol: 2 },
      { evidence: [] }, { evidence: ['https://example.com/check'] },
      { evidence: ['https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/actions/runs/123'] }]) {
      assert.throws(() => review({ ...receipt, ...patch }, descriptor, selected));
    }
  }
});

test('matching forged receipts cannot change the admitted product, target or 0.1.13 release', () => {
  const { selected, descriptor, receipt } = fixture(names[0]);
  for (const patch of [{ appId: 'creator-project-setup' }, { appId: 'creator-works-mcp' },
    { version: '0.1.12' }, { version: '0.1.14' }, { version: '0.1.13-rc.1' }, { version: '0.1.13+build' },
    { platform: 'windows' }, { architecture: 'aarch64' }, { packageType: 'nsis' }, { schemaVersion: 2 }]) {
    assert.throws(() => review({ ...receipt, ...patch }, { ...descriptor, ...patch }, selected), /must identify/);
  }
  for (const field of ['descriptor', 'scope', 'updaterKey', 'extension']) {
    assert.throws(() => review(receipt, descriptor, { ...selected, [field]: 'forged' }), /Invalid native Hub target/);
    assert.throws(() => updater('0.1.13', descriptor.assetName, signature, { ...selected, [field]: 'forged' }));
  }
});

test('package integrity and unified Windows run 38384922196 are not native maintenance acceptance', () => {
  const { selected, descriptor, receipt } = fixture(names[0]);
  assert.throws(() => review({ ...descriptor, integrityPassed: true, releaseReady: false }, descriptor, selected), /acceptance is required/);
  assert.throws(() => review({ ...receipt, checks: { integrityPassed: true } }, descriptor, selected), /incomplete/);
  const unified = { ...receipt, releaseLine: 'unified', platform: 'windows', packageType: 'nsis',
    sha256: 'c1a259f27283b5b3cc27e2fc2cbf54d7fc4318fb5828e171d62658106adbebdb',
    executableSha256: '8d52cef4052d064c1ededeaaaaf45c5a403c4c97838617c375e4126679b47f90',
    installerScope: 'guarded-nsis-update-default-location-no-msi',
    evidence: ['https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38384922196'] };
  assert.throws(() => review(unified, descriptor, selected), /acceptance is required/);
});

test('invalid artifact sizes, hashes, extensions, versions and signatures fail closed', () => {
  const { selected, descriptor, receipt } = fixture(names[0]);
  for (const patch of [{ byteLength: 0 }, { byteLength: 1.5 }, { byteLength: 512 * 1024 * 1024 + 1 },
    { sha256: 'A'.repeat(64) }, { sha256: 'bad' }, { executableSha256: '' },
    { assetName: 'Hub.dmg' }, { assetName: '../Hub.app.tar.gz' }, { assetName: `${'a'.repeat(160)}.app.tar.gz` }]) {
    assert.throws(() => review({ ...receipt, ...patch }, { ...descriptor, ...patch }, selected), /artifact identity/);
  }
  for (const version of ['0.1.12', '0.1.14', '0.1.13-rc.1', '0.1.13+build', null]) {
    assert.throws(() => updater(version, descriptor.assetName, signature, selected));
  }
  for (const value of ['', null, 'invalid', `${signature}\n`, Buffer.from('not a signature').toString('base64')]) {
    assert.throws(() => updater('0.1.13', descriptor.assetName, value, selected));
  }
});

test('replaced packaging input refuses before signing and accepted copies cannot be overwritten', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-package-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.AppImage');
  const descriptor = { byteLength: 3, sha256: digest('old') };
  fs.writeFileSync(source, 'new');
  const refused = path.join(root, 'refused.AppImage');
  await assert.rejects(stageAccepted(source, refused, descriptor), /changed while staging/);
  assert.equal(fs.existsSync(`${refused}.sig`), false);
  fs.writeFileSync(source, 'old');
  const destination = path.join(root, 'accepted.AppImage');
  await stageAccepted(source, destination, descriptor);
  await assert.rejects(stageAccepted(source, destination, descriptor));
  assert.equal(fs.readFileSync(destination, 'utf8'), 'old');
  assert.equal(fs.readFileSync(source, 'utf8'), 'old');
});

test('file-backed descriptor preparation validates exact bytes without signing or unified source admission', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-hub-receipt-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { descriptor, receipt } = fixture('linux-x86_64-deb');
  const packageFile = path.join(root, descriptor.assetName), executable = path.join(root, 'creator-hub');
  const receiptFile = path.join(root, 'receipt.json');
  fs.writeFileSync(packageFile, 'native fixture'); fs.writeFileSync(executable, 'exact executable fixture');
  const accepted = { ...receipt, byteLength: fs.statSync(packageFile).size,
    sha256: digest(fs.readFileSync(packageFile)), executableSha256: digest(fs.readFileSync(executable)) };
  fs.writeFileSync(receiptFile, `\uFEFF${JSON.stringify(accepted)}`);
  const result = await prepareDescriptor('linux-x86_64-deb', '0.1.13', packageFile, executable, receiptFile);
  assert.equal(result.descriptor.sha256, accepted.sha256);
  assert.equal(result.descriptor.executableSha256, accepted.executableSha256);
  assert.equal(result.descriptor.installerProtocol, 1);
  assert.equal(Object.hasOwn(result.descriptor, 'releaseLine'), false, 'Keep the consumer descriptor schema unchanged');
  assert.deepEqual(fs.readdirSync(root).sort(), [descriptor.assetName, 'creator-hub', 'receipt.json'].sort());
  await assert.rejects(prepareDescriptor('linux-x86_64-deb', '0.1.14', packageFile, executable, receiptFile), /only the 0.1.13/);
  fs.writeFileSync(packageFile, 'tampered fixture');
  await assert.rejects(prepareDescriptor('linux-x86_64-deb', '0.1.13', packageFile, executable, receiptFile), /exact artifact/);
  fs.writeFileSync(receiptFile, ' '.repeat(32769));
  await assert.rejects(prepareDescriptor('linux-x86_64-deb', '0.1.13', packageFile, executable, receiptFile), /too large/);
});

test('invalid CLI requests refuse before key access or creating output', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-hub-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'output');
  for (const args of [[], ['linux-x86_64-deb', '0.1.14', 'missing', 'missing', output, 'missing'],
    ['windows-x86_64-nsis', '0.1.13', 'missing', 'missing', output, 'missing']]) {
    const result = spawnSync(process.execPath, [require.resolve('./native-hub-descriptor.cjs'), ...args], {
      encoding: 'utf8', env: { ...process.env, CREATOR_HUB_SIGNING_KEY_PATH: path.join(root, 'never-read-key') },
    });
    assert.notEqual(result.status, 0); assert.equal(result.stdout, '');
    assert.doesNotMatch(result.stderr, /never-read-key|signing key|Signing failed/);
    assert.equal(fs.existsSync(output), false);
  }
});
