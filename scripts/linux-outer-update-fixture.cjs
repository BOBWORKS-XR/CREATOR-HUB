// Acceptance-only Linux 14 -> 15 input. Never a release or private-module builder.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { capture } = require('./sign-unix-payload.cjs');
const { runtimeDescriptor } = require('./mcp-runtime-descriptor.cjs');
const { bumpRootVersion, VERSIONS, sourceEntries } = require('./build-outer-update-fixture.cjs');
const archive = require('./module-archive.cjs');
const routing = require('./managed-router-package.cjs');
const unix = require('./unix-package-payload.cjs');
const ROOT = path.resolve(__dirname, '..');
const FROM = '0.1.14', TO = '0.1.15';
const BASELINE = Object.freeze({
  source: '534465a86554e95b909bf9c7decbbb29cbca5267', tree: 'db8c7b091d22f598bc789ac97d8d0153c391c8ec',
  directory: 'artifacts/linux-candidate-39042746816',
  manifest: '9202a9522fd7a34d101684dc1d8316c99f7f92de4e9f56555d4065145f3acfac',
  deb: '06beb134dd2be9fbf08dadbb1a49e97a07ff4e591c56967b8d2cc5b8b844b14f',
  helper: 'b3e4603af16c4c0f7b1962af8466e19b70d646f9b93dd35d82ec5c06639dc813',
  policy: '5eb715286ff8d8cda8e612f8dc9d28d396068b2cdd470a5f3d92d7355e3e37c9',
});
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash = file => capture(file, 512 * 1024 * 1024).sha256;
function baseline(input) {
  const manifestFile = path.join(input, 'builtin-manifest.json');
  assert.equal(fileHash(manifestFile), BASELINE.manifest, 'Exact independently reviewed Linux14 manifest required');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  assert.equal(manifest.platform, 'linux'); assert.equal(manifest.arch, 'x86_64');
  archive.validateBinding(manifest);
  require('./build-unified.cjs').verifyStage(path.join(input, 'modules'), manifest);
  for (const [name, record] of Object.entries(manifest.payloadArchive.files)) {
    const got = capture(path.join(input, 'modules', name), record.size);
    assert.deepEqual(got, { size: record.size, sha256: archive.rawFiles(manifest)[name] });
  }
  return manifest;
}
function runtimeBody(manifest) { return Buffer.from(JSON.stringify(runtimeDescriptor(manifest, TO))); }
function checkSource(root, entries, changed = {}) {
  let total = 0;
  for (const [name, expected] of Object.entries(entries)) {
    const file = path.join(root, name), record = capture(file, 256 * 1024 * 1024), body = fs.readFileSync(file);
    total += body.length; assert.ok(total <= 512 * 1024 * 1024);
    assert.equal(hash(body), record.sha256, 'Source changed while reading');
    if (Object.hasOwn(changed, name)) assert.equal(record.sha256, changed[name].sha256, 'Version-only source drift');
    else assert.equal(crypto.createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex'), expected,
      'Fixture source differs from pinned Git tree');
  }
  assert.ok(Object.keys(changed).every(name => VERSIONS.includes(name)), 'Only Root version fields may change');
}
function prepareRuntime(label, services = {}) {
  const root = services.root || ROOT, execute = services.execute || execFileSync, signer = services.signer || routing;
  assert.equal(services.platform || process.platform, 'win32', 'Local existing-key signing path is Windows-only');
  assert.match(label, /^linux-runtime15-[a-z0-9-]{1,60}$/);
  const input = path.join(root, BASELINE.directory), manifest = baseline(input);
  const body = runtimeBody(manifest), output = path.join(root, 'artifacts', label);
  assert.equal(fs.existsSync(output), false, 'Immutable signing output already exists');
  const verifier = path.join(root, 'src-tauri/target/release/examples/verify-package-input.exe');
  const verifierPin = capture(verifier, 256 * 1024 * 1024, true);
  fs.mkdirSync(output, { mode: 0o700 });
  const json = path.join(output, 'runtime15.json'), sig = path.join(output, 'runtime15.minisig');
  fs.writeFileSync(json, body, { flag: 'wx', mode: 0o644 });
  // Only this deterministic Linux15 metadata body reaches the existing signer.
  assert.equal(hash(fs.readFileSync(json)), hash(runtimeBody(baseline(input))));
  const signature = signer.signDetached(json, signer.signingKey(root));
  assert.ok(Buffer.isBuffer(signature) && signature.length > 0 && signature.length <= 4096);
  fs.writeFileSync(sig, signature, { flag: 'wx', mode: 0o644 });
  assert.equal(String(execute(verifier, [json, sig], { encoding: 'utf8', windowsHide: true, timeout: 30000 })).trim(),
    `Verified trusted package signature: ${hash(body)}. No activation or client changes.`);
  assert.deepEqual(capture(verifier, verifierPin.size, true), verifierPin);
  assert.deepEqual(fs.readFileSync(json), runtimeBody(baseline(input)));
  return { output, acceptanceOnly: true, targetVersion: TO, runtimeSha256: hash(body), signatureSha256: hash(signature),
    privateModulesRecompiled: false, releaseReady: false };
}
function nativeAdmission(env, platform, arch) {
  assert.equal(platform, 'linux'); assert.equal(arch, 'x64');
  for (const [name, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
    GITHUB_REPOSITORY_ID: '1364807512', GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/heads/validation/linux-outer-update-fixture-014', CREATOR_LINUX_OUTER_UPDATE_FIXTURE: '1' })) {
    assert.equal(env[name], value, `Disposable native fixture admission differs: ${name}`);
  }
  assert.ok(!Object.keys(env).some(n => /^(TAURI_SIGNING_|CREATOR_HUB_SIGNING_|LD_PRELOAD$|NODE_OPTIONS$)/.test(n)),
    'Native fixture refuses signing credentials or runtime injection');
}
function build(root, input, metadata, services = {}) {
  const env = services.env || process.env, execute = services.execute || execFileSync;
  nativeAdmission(env, services.platform || process.platform, services.arch || process.arch);
  const run = (cmd, args, options = {}) => execute(cmd, args, { cwd: root, env, encoding: 'utf8',
    windowsHide: true, timeout: 600000, maxBuffer: 1024 * 1024, ...options });
  const git = args => String(run('git', args)).trim();
  assert.equal(fs.realpathSync(root), root); assert.equal(git(['rev-parse', 'HEAD']), BASELINE.source);
  assert.equal(git(['show', '-s', '--format=%T', 'HEAD']), BASELINE.tree);
  assert.equal(git(['status', '--porcelain=v1', '--untracked-files=normal']), '', 'Clean pinned product checkout required');
  const entries = sourceEntries(git(['ls-tree', '-rz', '--full-tree', 'HEAD']));
  checkSource(root, entries);
  const original = baseline(input), files = archive.rawFiles(original);
  const originalDeb = path.join(input, 'native-packages/Creator Hub_0.1.14_amd64.deb');
  assert.equal(fileHash(originalDeb), BASELINE.deb);
  const output = path.join(root, 'artifacts/linux-outer-update-15');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(output, { recursive: false });
  const json = path.join(metadata, 'runtime15.json'), sig = path.join(metadata, 'runtime15.minisig');
  assert.deepEqual(fs.readFileSync(json), runtimeBody(original), 'Only exact Linux15 runtime metadata admitted');
  capture(sig, 4096);
  const target = path.join(output, 'target');
  const cargo = ['--release', '--locked', '--manifest-path', path.join(root, 'src-tauri/Cargo.toml'), '--target-dir', target];
  run('cargo', ['build', ...cargo, '--example', 'verify-package-input'], { stdio: 'inherit' });
  const verified = String(run(path.join(target, 'release/examples/verify-package-input'), [json, sig])).trim();
  assert.equal(verified, `Verified trusted package signature: ${hash(runtimeBody(original))}. No activation or client changes.`);
  const changes = {};
  for (const name of VERSIONS) {
    const bytes = bumpRootVersion(name, fs.readFileSync(path.join(root, name)));
    fs.writeFileSync(path.join(root, name), bytes); changes[name] = { sha256: hash(bytes) };
  }
  checkSource(root, entries, changes);
  const modules = path.join(output, 'modules'); fs.mkdirSync(modules);
  for (const [name, expected] of Object.entries(files)) {
    const destination = path.join(modules, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(input, 'modules', name), destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, original.payloadArchive.files[name].mode);
    assert.equal(fileHash(destination), expected);
  }
  fs.copyFileSync(json, path.join(modules, 'routing/runtime.json'));
  fs.copyFileSync(sig, path.join(modules, 'routing/runtime.minisig'));
  const manifest = structuredClone(original); delete manifest.payloadArchive;
  for (const name of ['routing/runtime.json', 'routing/runtime.minisig']) manifest.managedRouting.files[name] = fileHash(path.join(modules, name));
  const decoderTarget = path.join(output, 'decoder-target');
  run('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(root, 'native/module-archive/Cargo.toml'), '--target-dir', decoderTarget], { stdio: 'inherit' });
  const decoder = path.join(decoderTarget, 'release/creator-hub-module-archive');
  const payload = path.join(output, archive.FILE);
  manifest.payloadArchive = archive.create(modules, manifest, payload);
  archive.verify(payload, manifest, decoder);
  const descriptor = path.join(output, 'builtin-manifest.json');
  fs.writeFileSync(descriptor, JSON.stringify(manifest, null, 2), { flag: 'wx' });
  const extracted = path.join(output, 'baseline-deb');
  run('/usr/bin/dpkg-deb', ['--extract', originalDeb, extracted]);
  const retirement = path.join(output, 'linux-retirement'); fs.mkdirSync(retirement);
  for (const [source, expected] of [
    ['usr/libexec/creator-hub-deb-retirement-helper', BASELINE.helper],
    ['usr/share/polkit-1/actions/com.creatorworks.hub.deb-retirement.policy', BASELINE.policy],
  ]) {
    assert.equal(fileHash(path.join(extracted, source)), expected);
    const dest = path.join(retirement, path.basename(source));
    fs.copyFileSync(path.join(extracted, source), dest, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dest, source.endsWith('.policy') ? 0o644 : 0o755);
  }
  const overlay = require('./linux-retirement-package.cjs').writeOverlay(root, output, { [payload]: archive.FILE });
  const buildEnv = { ...unix.packageEnvironment(env, 'linux', 'writable'),
    CREATOR_BUILTIN_MANIFEST: descriptor, CARGO_TARGET_DIR: target };
  run(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--bundles', 'deb', '--config', overlay, '--', '--locked'],
    { env: buildEnv, timeout: 1800000, stdio: 'inherit' });
  const raw = path.join(output, 'creator-hub'); fs.copyFileSync(path.join(target, 'release/creator-hub'), raw, fs.constants.COPYFILE_EXCL);
  const integrity = unix.validatePackages({ output, bundleDirectory: path.join(target, 'release/bundle'), manifest,
    productName: 'Creator Hub', rawHub: raw, archiveDecoder: decoder, mcpMode: 'writable', linuxRetirementCandidate: true });
  checkSource(root, entries, changes); baseline(input);
  for (const [name, expected] of Object.entries(files)) if (!['routing/runtime.json', 'routing/runtime.minisig'].includes(name)) {
    assert.equal(fileHash(path.join(modules, name)), expected, 'Private compiled payload changed');
  }
  assert.equal(integrity.packages.length, 1);
  const packageFile = path.join(output, integrity.packages[0].path);
  const helperReceipt = JSON.parse(String(run('python3', ['-B', path.join(root, 'scripts/linux-retirement-package-verify.py'),
    packageFile, BASELINE.helper, BASELINE.policy, TO])));
  const receipt = { schemaVersion: 1, acceptanceOnly: true, sourceCommit: BASELINE.source, sourceTree: BASELINE.tree,
    sourceVersion: FROM, targetVersion: TO, changedSourceFiles: VERSIONS, privateModulesRecompiled: false,
    privateModulesResigned: false, privateFiles: files, integrity, helperReceipt,
    signedUpdateAccepted: false, restartAccepted: false, releaseReady: false };
  fs.writeFileSync(path.join(output, 'fixture-receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  return { output, receipt };
}
module.exports = { BASELINE, FROM, TO, baseline, runtimeBody, prepareRuntime, nativeAdmission, checkSource, build };
if (require.main === module) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === 'prepare-runtime' && args.length === 1) console.log(JSON.stringify(prepareRuntime(args[0])));
    else if (command === 'build' && args.length === 3) console.log(JSON.stringify(build(...args)));
    else throw Error('Use prepare-runtime LABEL or build PINNED_PRODUCT_ROOT PINNED_INPUT METADATA_DIRECTORY');
  } catch { console.error('Linux acceptance fixture stopped; preserve owned evidence. No release acceptance.'); process.exitCode = 1; }
}
