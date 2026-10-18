// Private outgoing-update test target. Never publishes or installs anything.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { capture } = require('./sign-unix-payload.cjs');
const { bumpRootVersion, VERSIONS, sourceEntries } = require('./build-outer-update-fixture.cjs');
const { checkSource } = require('./linux-outer-update-fixture.cjs');
const builder = require('./build-unified.cjs');
const archive = require('./module-archive.cjs');
const unix = require('./unix-package-payload.cjs');
const retirement = require('./linux-retirement-package.cjs');
const { runtimeDescriptor } = require('./mcp-runtime-descriptor.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const BASELINE = Object.freeze({
  source: 'bbd0a5d58562a3d8af0c84e5360eef9d26803eef',
  manifest: 'cabbc045eea9b29901f44d4b0c4cb1da1ffdf570821003a5118b25edb6a84996',
  deb: 'a4d2db459966f475a982cbe72591f32222e9c7050a1a7f4c870e1c6634c0f8b3',
  helper: '8b9e937f3b0c2e9336732b0c92f6a6bf33b8f25f693f52c9a27a34f1585d232c',
  policy: '5eb715286ff8d8cda8e612f8dc9d28d396068b2cdd470a5f3d92d7355e3e37c9',
});
const FROM = '0.1.14', TO = '0.1.15';
const PRIVATE = ['modules/mcp', 'modules/project-setup', 'native/mcp-router',
  'native/host_parent_macos.rs', 'native/plugins_retirement.rs', 'native/convergence-server-unix.rs',
  'src-tauri/src/module_archive.rs', 'src-tauri/src/catalog-key.pub'];

function admission(env, platform, arch) {
  assert.equal(platform, 'linux'); assert.equal(arch, 'x64');
  for (const [name, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
    GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/validation/linux-integrated-update-fixture' })) assert.equal(env[name], value, name);
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
  assert.ok(!Object.keys(env).some(name => /^(TAURI_SIGNING_|CREATOR_HUB_SIGNING_|LD_|DYLD_|NODE_OPTIONS$|RUSTFLAGS$|CARGO_ENCODED_RUSTFLAGS$)/.test(name)),
    'Signing credentials and inherited runtime/compiler injection are refused');
}

function baseline(input) {
  const raw = fs.readFileSync(path.join(input, 'builtin-manifest.json'));
  assert.equal(hash(raw), BASELINE.manifest);
  const manifest = JSON.parse(raw);
  assert.equal(manifest.platform, 'linux'); assert.equal(manifest.arch, 'x86_64');
  archive.validateBinding(manifest);
  builder.verifyStage(path.join(input, 'modules'), manifest);
  for (const [name, expected] of Object.entries(archive.rawFiles(manifest))) {
    const item = capture(path.join(input, 'modules', name), manifest.payloadArchive.files[name].size);
    assert.equal(item.sha256, expected); assert.equal(item.size, manifest.payloadArchive.files[name].size);
  }
  assert.equal(capture(path.join(input, 'native-packages/Creator Hub_0.1.14_amd64.deb'), 256 * 1024 * 1024).sha256, BASELINE.deb);
  return manifest;
}

function build(root, input, metadata, services = {}) {
  const env = services.env || process.env, execute = services.execute || execFileSync;
  admission(env, services.platform || process.platform, services.arch || process.arch);
  const run = (command, args, options = {}) => execute(command, args, { cwd: root, env,
    encoding: 'utf8', windowsHide: true, timeout: 600000, maxBuffer: 1024 * 1024, ...options });
  const git = args => String(run('git', args)).trim();
  assert.equal(fs.realpathSync(root), root);
  assert.equal(git(['rev-parse', 'HEAD']), env.GITHUB_SHA);
  assert.equal(git(['status', '--porcelain=v1', '--untracked-files=normal']), '', 'Clean product source required');
  git(['diff', '--exit-code', BASELINE.source, 'HEAD', '--', ...PRIVATE]);
  const entries = sourceEntries(git(['ls-tree', '-rz', '--full-tree', 'HEAD']));
  checkSource(root, entries);
  const original = baseline(input), files = archive.rawFiles(original);
  const output = path.join(root, 'artifacts/linux-integrated-update-15');
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.mkdirSync(output);
  const target = path.join(output, 'target'), json = path.join(metadata, 'runtime15.json'), sig = path.join(metadata, 'runtime15.minisig');
  const runtime = Buffer.from(JSON.stringify(runtimeDescriptor(original, TO)));
  assert.deepEqual(fs.readFileSync(json), runtime); capture(sig, 4096);
  const cargo = ['--release', '--locked', '--manifest-path', path.join(root, 'src-tauri/Cargo.toml'), '--target-dir', target];
  run('cargo', ['build', ...cargo, '--example', 'verify-package-input'], { stdio: 'inherit' });
  assert.equal(String(run(path.join(target, 'release/examples/verify-package-input'), [json, sig])).trim(),
    `Verified trusted package signature: ${hash(runtime)}. No activation or client changes.`);
  const changes = {};
  for (const name of VERSIONS) {
    const body = bumpRootVersion(name, fs.readFileSync(path.join(root, name)));
    fs.writeFileSync(path.join(root, name), body); changes[name] = { sha256: hash(body) };
  }
  checkSource(root, entries, changes);
  const modules = path.join(output, 'modules'); fs.mkdirSync(modules);
  for (const [name, expected] of Object.entries(files)) {
    const dest = path.join(modules, name); fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(input, 'modules', name), dest, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dest, original.payloadArchive.files[name].mode);
    assert.equal(capture(dest, original.payloadArchive.files[name].size).sha256, expected);
  }
  for (const [source, name] of [[json, 'runtime.json'], [sig, 'runtime.minisig']]) fs.copyFileSync(source, path.join(modules, 'routing', name));
  const manifest = structuredClone(original); delete manifest.payloadArchive;
  for (const name of ['routing/runtime.json', 'routing/runtime.minisig']) manifest.managedRouting.files[name] = hash(fs.readFileSync(path.join(modules, name)));
  const decoderTarget = path.join(output, 'decoder-target');
  run('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(root, 'native/module-archive/Cargo.toml'), '--target-dir', decoderTarget], { stdio: 'inherit' });
  const decoder = path.join(decoderTarget, 'release/creator-hub-module-archive'), payload = path.join(output, archive.FILE);
  manifest.payloadArchive = archive.create(modules, manifest, payload); archive.verify(payload, manifest, decoder);
  const descriptor = path.join(output, 'builtin-manifest.json'); fs.writeFileSync(descriptor, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  const extracted = path.join(output, 'baseline-deb');
  run('/usr/bin/dpkg-deb', ['--extract', path.join(input, 'native-packages/Creator Hub_0.1.14_amd64.deb'), extracted]);
  const helperDir = path.join(output, 'linux-retirement'); fs.mkdirSync(helperDir);
  const staged = { profile: retirement.INTEGRATED_PROFILE, files: {} };
  for (const [name, digest, mode] of [[retirement.HELPER, BASELINE.helper, 0o755], [retirement.POLICY, BASELINE.policy, 0o644]]) {
    const source = path.join(extracted, name); assert.equal(capture(source, 32 * 1024 * 1024).sha256, digest);
    const dest = path.join(helperDir, path.basename(name)); fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL); fs.chmodSync(dest, mode);
    staged.files[name] = retirement.record(dest, mode);
  }
  builder.stageIntegratedMcpResources(root, output, manifest);
  const overlay = retirement.writeOverlay(root, output, { [payload]: archive.FILE }, { profile: retirement.INTEGRATED_PROFILE });
  builder.stageIntegrationService(output, overlay);
  const buildEnv = { ...builder.integrationEnvironment(unix.packageEnvironment(env, 'linux', 'writable'), output, true),
    CREATOR_BUILTIN_MANIFEST: descriptor, CARGO_TARGET_DIR: target };
  run(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--bundles', 'deb',
    ...builder.integrationArguments('linux', 'x86_64', true, true), '--config', overlay, '--', '--locked'],
  { env: buildEnv, timeout: 1800000, stdio: 'inherit' });
  const raw = path.join(output, 'creator-hub'); fs.copyFileSync(path.join(target, 'release/creator-hub'), raw, fs.constants.COPYFILE_EXCL);
  const integrity = unix.validatePackages({ output, bundleDirectory: path.join(target, 'release/bundle'), manifest,
    productName: 'Creator Hub', rawHub: raw, archiveDecoder: decoder, mcpMode: 'writable', linuxRetirementCandidate: true });
  const helperReceipt = retirement.verifyDeb(root, output, integrity, staged, execute);
  checkSource(root, entries, changes); baseline(input);
  for (const [name, expected] of Object.entries(files)) if (!name.startsWith('routing/runtime.')) {
    assert.equal(capture(path.join(modules, name), original.payloadArchive.files[name].size).sha256, expected);
  }
  const receipt = { schemaVersion: 1, acceptanceOnly: true, sourceCommit: env.GITHUB_SHA,
    baselineSource: BASELINE.source, sourceVersion: FROM, targetVersion: TO, changedSourceFiles: VERSIONS,
    standalonePayloadRecompiled: false, integratedLibrariesCompiled: true, integrity, helperReceipt,
    signedUpdateAccepted: false, restartAccepted: false, releaseReady: false };
  fs.writeFileSync(path.join(output, 'fixture-receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  return receipt;
}

module.exports = { admission, baseline, build, BASELINE, FROM, TO, PRIVATE };
if (require.main === module) {
  const [root, input, metadata] = process.argv.slice(2);
  assert.equal(process.argv.length, 5);
  console.log(JSON.stringify(build(root, input, metadata)));
}
