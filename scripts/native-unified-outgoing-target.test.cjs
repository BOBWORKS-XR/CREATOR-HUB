const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const target = require('./native-unified-outgoing-target.cjs');
const feed = require('./self-update-lab-feed.cjs');
const driver = require('./native-unified-outgoing-smoke.cjs');
const config = () => ({ schemaVersion: 1, kind: target.KIND, baselineVersion: '0.1.14', targetVersion: '0.1.15',
  directory: path.resolve(__dirname, 'nonexistent-outgoing-inputs'), builtinManifestPath: path.resolve(__dirname, 'staged-builtin-manifest.json'), pins: { ...target.TARGET.pins } });
const environment = () => ({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows',
  HTTPS_PROXY: 'http://127.0.0.1:12345', HTTP_PROXY: 'http://127.0.0.1:12345', NO_PROXY: '127.0.0.1,localhost,::1',
  CREATOR_SELF_UPDATE_LAB_CONFIG: path.resolve(__dirname, 'absent-config.json'),
  CREATOR_SELF_UPDATE_LAB_BASELINE: path.resolve(__dirname, 'absent-installer.exe') });
const contract = () => ({ targetVersion: target.TARGET.version, baseline: { ...target.BASELINE }, pins: { ...target.TARGET.pins },
  routes: [{ host: 'api.github.com', path: feed.FEED_PATH }, ...[feed.DESCRIPTOR, `${feed.DESCRIPTOR}.minisig`, target.TARGET.asset, 'latest.json']
    .map(name => ({ host: 'github.com', path: `/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.15/${name}` }))] });

test('only reviewed genuine B03 14 -> acceptance-only 15 config; public12 remains separately pinned', () => {
  target.validateConfig(config());
  assert.equal(feed.baselineFor('0.1.15').version, '0.1.12');
  assert.equal(feed.baselineFor('0.1.15').installer, '0cd8a4493dd9a5b77fbc5fe160582a2b2698fea43aedd9118b2d5b3bd3c51a18');
  for (const [field, value] of [['baselineVersion', '0.1.12'], ['baselineVersion', '0.1.14-fixture'], ['targetVersion', '0.1.16'],
    ['kind', 'prepublication-signed-lab-update'], ['schemaVersion', 2], ['directory', 'relative'], ['builtinManifestPath', 'relative']]) {
    assert.throws(() => target.validateConfig({ ...config(), [field]: value }));
  }
  assert.throws(() => target.validateConfig({ ...config(), fakeVersion: '0.1.12' }));
  assert.throws(() => target.validateConfig({ ...config(), pins: { ...target.TARGET.pins, executable: target.BASELINE.exe } }));
  assert.throws(() => target.assertBaselineBytes(Buffer.from('public12'), Buffer.from('pretend14')));
});
test('owned reviewed factory required; no public12 fallback or arbitrary transport route', () => {
  if (!feed.createUnifiedOutgoingContract) assert.throws(() => target.loadContract(config()), /Owner integration required/);
  target.verifyContract(contract());
  for (const change of [value => value.baseline.version = '0.1.12', value => value.baseline.exe = 'a'.repeat(64),
    value => value.routes.push({ host: 'github.com', path: '/extra' }), value => value.routes[2].host = 'foreign.test',
    value => value.routes[3].path += '?arbitrary', value => value.pins.installer = 'b'.repeat(64)]) {
    const value = contract(); change(value); assert.throws(() => target.verifyContract(value));
  }
  assert.equal(target.startLabProxy, feed.startLabProxy, 'Use the exact reviewed transport, not a copy');
  const scope = target.discoveryScope(contract());
  for (const flag of ['publicDiscovery', 'liveAiAcceptance', 'productAcceptance', 'releaseReady']) assert.equal(scope[flag], false);
});
test('admission rejects user PC/self-hosted/non-Windows/version fixtures/TLS coercion/non-owned proxy before any paths', () => {
  driver.assertAdmission(environment(), 'win32');
  for (const [field, value] of [['GITHUB_ACTIONS', 'True'], ['RUNNER_ENVIRONMENT', 'self-hosted'], ['RUNNER_OS', 'Linux'],
    ['HTTPS_PROXY', 'http://localhost:12345'], ['HTTPS_PROXY', 'https://127.0.0.1:12345'],
    ['HTTPS_PROXY', 'http://user:password@127.0.0.1:12345'], ['HTTP_PROXY', 'http://127.0.0.1:9'],
    ['HTTPS_PROXY', 'http://127.0.0.1:12345/relay'], ['NO_PROXY', '*'], ['NODE_TLS_REJECT_UNAUTHORIZED', '0'],
    ['NODE_EXTRA_CA_CERTS', 'foreign.pem'], ['ALL_PROXY', 'http://proxy'], ['NODE_OPTIONS', '--require=fake'],
    ['CREATOR_HOSTED_UPDATE_FIXTURE', '{}']]) {
    assert.throws(() => driver.assertAdmission({ ...environment(), [field]: value }, 'win32'));
  }
  assert.throws(() => driver.assertAdmission(environment(), 'linux'));
  assert.throws(() => target.selectLab(path.resolve('should-not-be-read'), { GITHUB_ACTIONS: 'false' }), /disposable/);
});
test('local CLI refuses without installer, UI, proxy, config or trust operations', () => {
  assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, 'native-unified-outgoing-smoke.cjs')], {
    env: { ...process.env, GITHUB_ACTIONS: 'false', CREATOR_SELF_UPDATE_LAB_CONFIG: 'nonexistent', CREATOR_SELF_UPDATE_LAB_BASELINE: 'nonexistent' },
    encoding: 'utf8', windowsHide: true,
  }), error => error.status === 1 && /disposable/.test(error.stderr) && error.stdout === '');
});
test('available real receipt metadata matches fixed outer-only pins, not native acceptance', () => {
  const folder = path.resolve(__dirname, '../artifacts/outer-update-fixture/reviewed-a914bb9-20261014-04');
  if (!fs.existsSync(path.join(folder, 'fixture-receipt.json'))) return;
  const receipt = JSON.parse(target.readBounded(path.join(folder, 'fixture-receipt.json'), target.LIMITS.metadata));
  assert.equal(receipt.kind, 'outgoing-unified-14-outer-only-15-acceptance-fixture');
  assert.equal(receipt.baseline.version, target.BASELINE.version);
  assert.equal(receipt.baseline.sourceCommit, target.BASELINE.sourceCommit);
  assert.equal(receipt.baseline.files['installer.exe'].sha256, target.BASELINE.installer);
  assert.equal(receipt.baseline.files['installer-extracted/creator-hub.exe'].sha256, target.BASELINE.exe);
  assert.equal(receipt.baseline.files['builtin-manifest.json'].sha256, target.BASELINE.builtinManifest);
  assert.equal(receipt.baseline.files['mcp-runtime.json'].sha256, target.BASELINE.runtimeDescriptor);
  assert.equal(receipt.builtinManifest.managedRouting.files['routing/runtime.json'], target.TARGET.runtimeDescriptor);
  const staged = path.resolve(__dirname, '../artifacts/unified/unified-014-repeat-20261014-03/builtin-manifest.json');
  if (fs.existsSync(staged)) target.readBuiltinManifest(staged);
  assert.deepEqual(receipt.pins, target.TARGET.pins);
  const metadata = target.readBounded(path.join(folder, 'signed', feed.DESCRIPTOR), target.LIMITS.metadata);
  assert.equal(target.hash(metadata), target.TARGET.pins.descriptor);
  assert.equal(JSON.parse(metadata).minHubVersion, target.BASELINE.version);
  assert.equal(JSON.parse(metadata).assetName, target.TARGET.asset);
  for (const flag of ['outgoingNativeUpdateTested', 'viewsRestored', 'releaseReady', 'privateKeyIncluded']) assert.equal(receipt[flag], false);
});
