'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const legacy = require('./windows-artifact-candidate.cjs');
const pinned = require('./fixtures/windows-r5-raw-binding.json');
const SOURCE = Object.freeze({ commit: '032bb101823fcfff1c5b85f863bb7381db8285e4', tree: '6a1441ea078a1a35f1580ad91b83dd546dc2e536' });
const VERSION = '0.1.18', ASSET = 'Creator.Hub_0.1.18_x64-setup.exe';
const WORKFLOW = '.github/workflows/windows-r5-raw-installer.yml';
const MODULE_FILES = ['mcp/creator-works-mcp-launcher.exe', 'mcp/server/creator-works-mcp.mjs', 'mcp/server/runtime/node.exe',
  'mcp/server/runtime/LICENSE', 'mcp/server/runtime/VERSION', 'mcp/server/unity-extension/Editor/BanterMCPBridge.cs',
  'mcp/server/unity-extension/Editor/CreatorWorksMCPLogo.png', 'mcp/server/LICENSE', 'mcp/server/THIRD_PARTY_NOTICES.md',
  'setup/creator-project-setup.exe', 'routing/creator-hub-mcp-router.exe', 'routing/router.json', 'routing/router.minisig',
  'routing/runtime.json', 'routing/runtime.minisig'];
const digest = value => { assert.match(value ?? '', /^[a-f0-9]{64}$/); assert.notEqual(value, '0'.repeat(64)); };
function validatePins(value) {
  assert.equal(value.enabled, true, 'R7 binary pins are not populated; no download or native action allowed');
  assert.equal(value.schemaVersion, 1); assert.equal(value.version, VERSION); assert.equal(value.outgoingFixtureVersion, '0.1.19');
  assert.deepEqual(value.source, SOURCE);
  for (const key of ['installer', 'executable', 'manifest']) {
    assert.ok(Number.isSafeInteger(value[key]?.bytes) && value[key].bytes > 0 && value[key].bytes <= 512 * 1024 * 1024);
    digest(value[key].sha256);
  }
  for (const key of ['buildResultSha256', 'buildInputsSha256']) digest(value[key]);
  const manifest = value.manifest.document;
  digest(value.manifest.sha256Canonical);
  assert.equal(legacy.hash(Buffer.from(JSON.stringify(manifest))), value.manifest.sha256Canonical,
    'Canonical manifest must also be independently bound when pins are filled');
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.platform, 'windows'); assert.equal(manifest.arch, 'x86_64');
  const files = { ...manifest.modules.mcp.files, ...manifest.modules.setup.files, ...manifest.managedRouting.files };
  assert.deepEqual(Object.keys(files).sort(), [...MODULE_FILES].sort()); for (const hash of Object.values(files)) digest(hash);
  assert.equal(manifest.modules.mcp.version, '2.7.7'); assert.equal(manifest.modules.setup.version, '0.3.7');
  assert.equal(manifest.managedRouting.protocol, 1);
  return value;
}
function assertRunner(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32');
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_JOB: 'install', GITHUB_REF: 'refs/heads/validation/windows-menu-merge-20261027',
    GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/${WORKFLOW}@refs/heads/validation/windows-menu-merge-20261027`,
    CREATOR_WINDOWS_R5_RAW_INSTALL: '1', CREATOR_WINDOWS_ARTIFACT_INSTALL: '1' })) assert.equal(env[key], value, key);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/); assert.equal(env.GITHUB_SHA, env.EXPECTED_HARNESS_COMMIT);
}
function createAdapter(value) {
  validatePins(value);
  const files = { ...value.manifest.document.modules.mcp.files, ...value.manifest.document.modules.setup.files,
    ...value.manifest.document.managedRouting.files };
  function boundIdentity(input) {
    assert.equal(input.schemaVersion, 1);
    for (const key of ['releaseId', 'assetId']) assert.ok(Number.isSafeInteger(input[key]) && input[key] > 0);
    for (const key of ['releaseTag', 'assetName']) { assert.match(input[key] ?? '', /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/); assert.ok(!input[key].includes('..')); }
    assert.equal(input.bytes, value.installer.bytes); assert.equal(input.sha256, value.installer.sha256);
    assert.equal(input.receiptSha256, value.buildResultSha256); return input;
  }
  function verifyCandidate(directory, receipt, source, binding) {
    boundIdentity(binding); assert.equal(receipt, value.buildResultSha256);
    assert.deepEqual(source, { commit: SOURCE.commit, manifestSha256: value.buildInputsSha256 });
    assert.deepEqual(legacy.inventory(directory), [ASSET]);
    assert.deepEqual(legacy.record(path.join(directory, ASSET)), value.installer);
    return { source, producer: { kind: 'local-r7-build', sourceTree: SOURCE.tree, buildResultSha256: value.buildResultSha256,
      privateAsset: binding }, files: { [ASSET]: value.installer, 'creator-hub.exe': value.executable } };
  }
  function extractExpected(installer, output, execute = execFileSync, inspect = legacy) {
    assert.deepEqual(inspect.record(installer), value.installer);
    assert.equal(fs.existsSync(output), false, 'Extraction destination must not exist');
    const sevenZip = path.join(process.env.PROGRAMFILES || '', '7-Zip/7z.exe');
    assert.ok(path.isAbsolute(sevenZip) && fs.existsSync(sevenZip), '7-Zip unavailable');
    execute(sevenZip, ['x', installer, `-o${output}`, '-y'], { windowsHide: true, timeout: 120000, stdio: 'pipe' });
    const image = path.join(output, 'creator-hub.exe');
    assert.deepEqual(inspect.record(image), value.executable);
    assert.deepEqual(inspect.record(path.join(output, '$PLUGINSDIR/creator-hub-preflight.exe')), value.executable,
      'Installer preflight must equal the exact installed launcher');
    assert.deepEqual(inspect.inventory(path.join(output, 'modules')), Object.keys(files).sort());
    for (const [name, expected] of Object.entries(files)) assert.equal(inspect.hash(inspect.read(path.join(output, 'modules', name), 512 * 1024 * 1024)), expected, name);
    return image;
  }
  return { ...legacy, VERSION, ASSET, manifest: value.manifest.document, assertRunner, boundIdentity, verifyCandidate, extractExpected };
}
module.exports = { SOURCE, VERSION, ASSET, WORKFLOW, MODULE_FILES, pinned, validatePins, assertRunner, createAdapter };
if (require.main === module) {
  try {
    assertRunner(); const adapter = createAdapter(pinned);
    const [mode, ...args] = process.argv.slice(2);
    if (mode === 'preflight') { assert.equal(args.length, 0); console.log('Exact R7 pins populated; installer-only input admitted'); }
    else {
      assert.ok(['fresh', 'guarded'].includes(mode)); assert.equal(args.length, 3);
      const env = { ...process.env, SOURCE_COMMIT: SOURCE.commit, SOURCE_MANIFEST_SHA256: pinned.buildInputsSha256 };
      require('./windows-artifact-install.cjs').run(mode, path.resolve(args[0]), legacy.json(path.resolve(args[1])), path.resolve(args[2]), env, execFileSync, adapter);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
