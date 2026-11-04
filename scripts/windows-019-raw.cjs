'use strict';
// Installer-only adapter, derived from e4459b0 windows-r5-raw.cjs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readBounded } = require('./read-bounded-input.cjs');
const c = require('./windows-019-contract.cjs');
const read = (file, limit = 512 * 1024 * 1024) => readBounded(path.resolve(file), limit);
const json = file => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read(file, 2 * 1024 * 1024)));
const record = file => { const bytes = read(file); return { bytes: bytes.length, sha256: c.hash(bytes) }; };
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value) + '\n', { flag: 'wx' });
function inventory(directory) {
  const files = [];
  function walk(folder, prefix = '', depth = 0) {
    assert.ok(depth < 12); assert.equal(fs.lstatSync(folder).isSymbolicLink(), false, 'Linked artifact refused');
    for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
      const name = prefix + item.name, file = path.join(folder, item.name);
      assert.equal(fs.lstatSync(file).isSymbolicLink(), false, 'Linked artifact refused');
      if (item.isDirectory()) walk(file, name + '/', depth + 1);
      else { assert.ok(item.isFile()); files.push(name); assert.ok(files.length <= 64, 'Artifact file bound'); }
    }
  }
  walk(directory); return files.sort();
}
function cleanEnvironment(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !/TOKEN|SECRET|PASSWORD|PRIVATE_KEY|SIGNING|CREDENTIAL|AUTHORIZATION|PROXY|^NODE_OPTIONS$|^NODE_TLS_|^NODE_EXTRA_CA_CERTS$|^SSL_CERT_|^CURL_CA_BUNDLE$|^REQUESTS_CA_BUNDLE$|^CREATOR_|^CARGO_TARGET_DIR$|^RUSTFLAGS$|^RUSTC_WRAPPER$|^RUSTC_WORKSPACE_WRAPPER$|^CARGO_.*RUSTFLAGS$|^TAURI_/i.test(name)));
}
function assertRunner(env = process.env, platform = process.platform) {
  assert.equal(platform, 'win32');
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', RUNNER_ARCH: 'X64',
    GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB', GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_JOB: 'install', GITHUB_REF: c.RAW_REF,
    GITHUB_WORKFLOW_REF: `BOBWORKS-XR/CREATOR-HUB/.github/workflows/windows-019-raw-installer.yml@${c.RAW_REF}`,
    CREATOR_WINDOWS_019_RAW_INSTALL: '1', CREATOR_WINDOWS_ARTIFACT_INSTALL: '1' })) assert.equal(env[key], value, key);
  c.digest(env.GITHUB_SHA, 40); assert.equal(env.GITHUB_SHA, env.EXPECTED_HARNESS_COMMIT);
}
function createAdapter(value = c.pinned) {
  c.validateRaw(value);
  const files = { ...value.manifest.document.modules.mcp.files, ...value.manifest.document.modules.setup.files, ...value.manifest.document.managedRouting.files };
  function boundIdentity(input) {
    c.keys(input, ['schemaVersion', 'releaseId', 'releaseTag', 'assetId', 'assetName', 'bytes', 'sha256', 'receiptSha256']);
    assert.equal(input.schemaVersion, 1);
    for (const [key, expected] of Object.entries({ releaseId: value.rawRelease.id, releaseTag: value.rawRelease.tag,
      assetId: value.rawRelease.assetId, assetName: c.ASSET, bytes: value.installer.bytes,
      sha256: value.installer.sha256, receiptSha256: value.build.resultSha256 })) assert.equal(input[key], expected, key);
    return input;
  }
  function verifyCandidate(directory, receipt, source, binding) {
    boundIdentity(binding); assert.equal(receipt, value.build.resultSha256);
    assert.deepEqual(source, { commit: value.source.commit, manifestSha256: value.build.inputsSha256 });
    assert.deepEqual(inventory(directory), [c.ASSET]);
    assert.deepEqual(record(path.join(directory, c.ASSET)), { bytes: value.installer.bytes, sha256: value.installer.sha256 });
    return { source, producer: value.build.provenance, buildResultSha256: value.build.resultSha256,
      files: { [c.ASSET]: { bytes: value.installer.bytes, sha256: value.installer.sha256 }, 'creator-hub.exe': value.executable } };
  }
  function extractExpected(installer, output, execute = execFileSync) {
    assert.deepEqual(record(installer), { bytes: value.installer.bytes, sha256: value.installer.sha256 });
    assert.equal(fs.existsSync(output), false, 'Extraction destination must not exist');
    const sevenZip = path.join(process.env.PROGRAMFILES || '', '7-Zip/7z.exe');
    assert.ok(path.isAbsolute(sevenZip) && fs.existsSync(sevenZip), '7-Zip unavailable');
    execute(sevenZip, ['x', installer, `-o${output}`, '-y'], { windowsHide: true, timeout: 120000, stdio: 'pipe' });
    const image = path.join(output, 'creator-hub.exe');
    assert.deepEqual(record(image), value.executable);
    assert.deepEqual(record(path.join(output, '$PLUGINSDIR/creator-hub-preflight.exe')), value.executable);
    assert.deepEqual(inventory(path.join(output, 'modules')), Object.keys(files).sort());
    for (const [name, expected] of Object.entries(files)) assert.equal(c.hash(read(path.join(output, 'modules', name))), expected, name);
    return image;
  }
  return { VERSION: c.VERSION, ASSET: c.ASSET, manifest: value.manifest.document, assertRunner, boundIdentity,
    verifyCandidate, extractExpected, inventory, record, read, json, write, hash: c.hash, cleanEnvironment,
    baseline: () => c.baselineFor('0.1.18') };
}
module.exports = { ...c, read, json, record, inventory, write, cleanEnvironment, assertRunner, createAdapter };
if (require.main === module) {
  try {
    assertRunner(); const adapter = createAdapter();
    const [mode, ...args] = process.argv.slice(2);
    if (mode === 'preflight') { assert.equal(args.length, 0); console.log('Reviewed 019 raw pins admitted.'); }
    else {
      assert.ok(['fresh', 'guarded'].includes(mode)); assert.equal(args.length, 3);
      const env = { ...process.env, SOURCE_COMMIT: c.pinned.source.commit, SOURCE_MANIFEST_SHA256: c.pinned.build.inputsSha256 };
      require('./windows-019-raw-install.cjs').run(mode, path.resolve(args[0]), json(path.resolve(args[1])), path.resolve(args[2]), env, execFileSync, adapter);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
