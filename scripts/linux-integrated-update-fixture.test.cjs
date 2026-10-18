const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fixture = require('./linux-integrated-update-fixture.cjs');
const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64',
  GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/heads/validation/linux-integrated-update-fixture', GITHUB_SHA: 'a'.repeat(40) };

test('only a hosted Linux source-bound validation push can compile the private test target', () => {
  fixture.admission(env, 'linux', 'x64');
  for (const key of Object.keys(env)) assert.throws(() => fixture.admission({ ...env, [key]: 'wrong' }, 'linux', 'x64'));
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['linux', 'ia32']]) {
    assert.throws(() => fixture.admission(env, platform, arch));
  }
  for (const name of ['TAURI_SIGNING_PRIVATE_KEY', 'CREATOR_HUB_SIGNING_KEY_PATH', 'LD_PRELOAD', 'NODE_OPTIONS', 'RUSTFLAGS']) {
    assert.throws(() => fixture.admission({ ...env, [name]: 'refused' }, 'linux', 'x64'));
  }
});

test('a refused local invocation cannot run a compiler or inspect/change source', () => {
  let called = false;
  assert.throws(() => fixture.build('not-a-source', 'not-an-input', 'not-metadata', {
    env, platform: 'win32', arch: 'x64', execute: () => { called = true; },
  }));
  assert.equal(called, false);
});

test('the native baseline is fixed and changed metadata refuses before payload access', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integrated-update-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'builtin-manifest.json'), '{}');
    assert.throws(() => fixture.baseline(dir));
    assert.equal(fixture.FROM, '0.1.14'); assert.equal(fixture.TO, '0.1.15');
    assert.equal(fixture.BASELINE.deb, 'a4d2db459966f475a982cbe72591f32222e9c7050a1a7f4c870e1c6634c0f8b3');
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('the test target retains native direct features and independent public-signature verification', () => {
  const source = fs.readFileSync(path.join(__dirname, 'linux-integrated-update-fixture.cjs'), 'utf8');
  assert.ok(source.includes("builder.integrationArguments('linux', 'x86_64', true, true)"));
  assert.ok(source.includes('builder.stageIntegratedMcpResources(root, output, manifest)'));
  assert.ok(source.includes('retirement.INTEGRATED_PROFILE'));
  assert.ok(source.includes('builder.stageIntegrationService(output, overlay)'));
  assert.ok(source.includes('verify-package-input'));
  assert.ok(source.includes("git(['diff', '--exit-code', BASELINE.source, 'HEAD', '--', ...PRIVATE])"));
  assert.ok(source.includes('checkSource(root, entries, changes); baseline(input)'));
  assert.ok(source.includes('signedUpdateAccepted: false, restartAccepted: false, releaseReady: false'));
  assert.ok(!source.includes('signDetached') && !source.includes('release upload') && !source.includes('dpkg --install'));
  assert.deepEqual(fixture.PRIVATE.slice(0, 3), ['modules/mcp', 'modules/project-setup', 'native/mcp-router']);
});
