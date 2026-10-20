const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateManifest, checkSources, checkRemovedPlugins, assertReleaseReady } = require('./check-unified-sources.cjs');
const manifest = require('../modules/suite.json');
const root = path.resolve(__dirname, '..');

test('unified source retains Hub identity and both explicit legacy source records', () => {
  assert.equal(validateManifest(manifest), manifest);
  assert.deepEqual(checkSources(root, manifest).modules, ['mcp', 'setup']);
});

test('source paths cannot escape the canonical module locations', () => {
  for (const field of ['path', 'frontend']) {
    const invalid = structuredClone(manifest);
    invalid.modules.mcp[field] = '../outside';
    assert.throws(() => validateManifest(invalid), /source provenance or path/);
  }
});

test('source gate refuses reintroduced Plugins navigation, assets and retirement UI', () => {
  assert.doesNotThrow(() => checkRemovedPlugins('<main>Projects</main>', 'fixture'));
  for (const html of ['<button data-view="plugins">', '<button data-local-view="plugins">', "<section id='view-plugins'>", '<script src="community.js">', '<script src="community-adapter.js">',
    '<link href="community.css">', '<img src="icons/creator-plugins.png">', '<p>Creator Plugins has retired</p>']) {
    assert.throws(() => checkRemovedPlugins(html, 'fixture'), /Removed Plugins interface is still included: fixture/);
  }
});

test('legacy app versions are not mistaken for Hub product versions', () => {
  assert.equal(manifest.baselineHub, '0.1.12');
  assert.equal(manifest.modules.mcp.baselineTag, 'v2.7.7');
  assert.equal(manifest.modules.setup.baselineTag, 'v0.3.7');
  const invalid = structuredClone(manifest);
  invalid.appId = 'creator-works-mcp';
  assert.throws(() => validateManifest(invalid), /Invalid unified/);
});

test('consolidated sources do not claim tested packaging or migration readiness', () => {
  assert.throws(() => assertReleaseReady(manifest), /not a unified release/);
  assert.throws(() => assertReleaseReady({ ...manifest, phase: 'ready' }), /Invalid unified/);
});

test('Linux release readiness remains closed for missing receipts, proofs and unsupported checks', () => {
  const os = require('node:os'), linux = require('./linux-016-release-qualification.cjs');
  const { fixture } = require('./linux-016-release-qualification.test.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linux016-readiness-held-'));
  try {
    const receipt = path.join(directory, 'synthetic-not-qualified.json');
    const value = fixture(), bytes = Buffer.from(JSON.stringify(value) + '\n'); fs.writeFileSync(receipt, bytes, { flag: 'wx' });
    const intent = { version: '0.1.16', platform: 'linux-x86_64', receiptPath: receipt, sha256: linux.hash(bytes) };
    assert.throws(() => assertReleaseReady(manifest, { version: intent.version, platform: intent.platform }), /not a unified release/);
    assert.throws(() => assertReleaseReady(manifest, { ...intent, version: '0.1.17' }), /Only Linux 0.1.16/);
    assert.throws(() => assertReleaseReady(manifest, { ...intent, sha256: undefined }));
    assert.throws(() => assertReleaseReady(manifest, intent), /Unqualified portable checks/);
    delete value.proofs['portable-approve']; const missing = Buffer.from(JSON.stringify(value) + '\n'); fs.writeFileSync(receipt, missing);
    assert.throws(() => assertReleaseReady(manifest, { ...intent, sha256: linux.hash(missing) }), /Closed qualification/);
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test('Linux readiness binds the receipt digest and current source version/key independently', t => {
  const os = require('node:os'), linux = require('./linux-016-release-qualification.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linux016-readiness-identity-'));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  fs.mkdirSync(path.join(directory, 'src-tauri/src'), { recursive: true });
  for (const file of ['package.json', 'src-tauri/tauri.conf.json']) fs.writeFileSync(path.join(directory, file), JSON.stringify({ version: '0.1.16' }));
  const key = path.join(directory, 'src-tauri/src/catalog-key.pub');
  fs.writeFileSync(key, 'untrusted comment: unit identity only\n' + linux.PUBLIC_KEY + '\n');
  const receipt = path.join(directory, 'mock-only.json'), digest = 'a'.repeat(64), reviewed = { version: '0.1.16' }, calls = [];
  t.mock.method(linux, 'loadQualification', (file, sha256) => { calls.push({ file, sha256 }); return reviewed; });
  const intent = { version: '0.1.16', platform: 'linux-x86_64', receiptPath: receipt, sha256: digest, root: directory };
  assert.equal(assertReleaseReady(manifest, intent), reviewed);
  assert.deepEqual(calls, [{ file: receipt, sha256: digest }]);
  fs.writeFileSync(key, 'untrusted comment: changed key\n' + 'A'.repeat(linux.PUBLIC_KEY.length) + '\n');
  assert.throws(() => assertReleaseReady(manifest, intent), /Production descriptor key differs/);
  fs.writeFileSync(key, 'untrusted comment: unit identity only\n' + linux.PUBLIC_KEY + '\n');
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ version: '0.1.17' }));
  assert.throws(() => assertReleaseReady(manifest, intent), /Publication version differs/);
});

test('Linux release CLI cannot use source checks, verify-draft or booleans to bypass readiness', () => {
  const { spawnSync } = require('node:child_process'), os = require('node:os');
  const linux = require('./linux-016-release-qualification.cjs'), { fixture } = require('./linux-016-release-qualification.test.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'linux016-cli-held-'));
  try {
    const receipt = path.join(directory, 'synthetic-not-qualified.json'), bytes = Buffer.from(JSON.stringify(fixture()) + '\n');
    fs.writeFileSync(receipt, bytes, { flag: 'wx' });
    const args = ['--platform', 'linux-x86_64', '--version', '0.1.16', '--receipt', receipt, '--sha256', linux.hash(bytes)];
    for (const flags of [args, ['--release', ...args], ['--release', '--verify-draft', ...args]]) {
      const result = spawnSync(process.execPath, [require.resolve('./check-unified-sources.cjs'), ...flags],
        { cwd: os.tmpdir(), encoding: 'utf8', timeout: 10000, windowsHide: true });
      assert.equal(result.status, 1); assert.equal(result.stdout, '');
      assert.match(result.stderr, flags.includes('--release') ? /Unqualified portable checks/ : /Qualification options require --release/);
    }
  } finally { fs.rmSync(directory, { recursive: true }); }
});

test('Linux qualification digest is not silently accepted by the Windows release CLI', () => {
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(process.execPath, [require.resolve('./check-unified-sources.cjs'), '--release', '--version', '0.1.14',
    '--platform', 'windows-x86_64', '--sha256', 'a'.repeat(64)], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 1); assert.match(result.stderr, /Linux qualification digest requires linux-x86_64/);
  assert.equal(result.stdout, '');
});

test('source CI uses module interfaces without fetching separate repositories', () => {
  const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /modules\/project-setup\/src/);
  assert.match(ci, /modules\/mcp\/launcher\/src/);
  assert.doesNotMatch(ci, /repository: BOBWORKS-XR\/CREATOR-(?:PROJECT-SETUP|WORKS-UNITY-MCP)/);
});

test('headless Unix writer fixtures compile the actual integration context', () => {
  const fixture = fs.readFileSync(path.join(root, 'native/mcp-router/tests/hosted-boundary/src/lib.rs'), 'utf8');
  const config = fs.readFileSync(path.join(root, 'native/mcp-router/tests/hosted-boundary/Cargo.toml'), 'utf8');
  assert.match(fixture, /#\[path = "[^"\n]*modules\/mcp\/launcher\/src-tauri\/src\/integration_context.rs"\]\s*mod integration_context;/);
  assert.match(config, /\[features\]\s*integrated-service = \[\]/);
  assert.doesNotMatch(fixture, /fn protected_writers\(/);
});
