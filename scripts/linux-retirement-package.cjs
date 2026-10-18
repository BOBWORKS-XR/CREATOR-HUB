// Explicit candidate profiles for the existing signed Unix assembly. Never installs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const HELPER = '/usr/libexec/creator-hub-deb-retirement-helper';
const POLICY = '/usr/share/polkit-1/actions/com.creatorworks.hub.deb-retirement.policy';
const FEATURE = 'experimental-linux-migration';
const DEFAULT_PROFILE = 'retirement-acceptance';
const INTEGRATED_PROFILE = 'integrated-candidate';
const INTEGRATED_SHORT = 'Creator Hub';
const INTEGRATED_LONG = 'Manage projects, connect AI tools to Unity and set up Creator SDK projects.';
const SERVICE = '/usr/share/dbus-1/services/com.creatorworks.hub.Host.service';
const SERVICE_BYTES = Buffer.from('[D-BUS Service]\nName=com.creatorworks.hub.Host\nExec=/usr/bin/creator-hub --flatpak-activate\n');
const FLAGS = { nativeGuiAccepted: false, migrationAccepted: false, authenticationAccepted: false,
  signedUpdateAccepted: false, releaseReady: false };

function profileName(profile = DEFAULT_PROFILE) {
  assert.ok(profile === DEFAULT_PROFILE || profile === INTEGRATED_PROFILE, 'Unknown native DEB candidate profile');
  return profile;
}

function checkOptions({ enabled, platform, arch, installer, managed, experimentalUnix,
  experimentalWritable, prepareManagedUnix, signedUnixInput }) {
  assert.equal(typeof enabled, 'boolean', 'The Linux retirement test option must be explicit');
  if (!enabled) return;
  assert.ok(platform === 'linux' && arch === 'x86_64' && installer === true && managed === true
    && experimentalUnix === true && experimentalWritable === true && !prepareManagedUnix
    && typeof signedUnixInput === 'string' && path.isAbsolute(signedUnixInput),
  '--linux-retirement-test-candidate requires signed native Linux x86_64 DEB assembly, --installer, --managed, --experimental-unix and --experimental-unix-writable');
}

function record(file, mode, limit = 32 * 1024 * 1024) {
  const before = fs.lstatSync(file);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1
    && before.size > 0 && before.size <= limit, 'Bounded, independent regular package file required');
  if (process.platform !== 'win32') assert.equal(before.mode & 0o7777, mode, 'Unexpected package source mode');
  const bytes = fs.readFileSync(file);
  const after = fs.lstatSync(file);
  for (const key of ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs']) assert.equal(after[key], before[key], 'Package input changed');
  // Ownership here is the expected DEB header, not the staging user's UID/GID.
  return { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length, mode, uid: 0, gid: 0 };
}

function stage(root, output, resources, env, execute = execFileSync, { profile = DEFAULT_PROFILE } = {}) {
  profileName(profile);
  assert.equal(process.platform, 'linux', 'Native Linux process required; no local installation is performed');
  assert.equal(process.arch, 'x64', 'Only the fixed x86_64 helper is supported');
  assert.equal(env.GITHUB_ACTIONS, 'true');
  assert.equal(env.RUNNER_ENVIRONMENT, 'github-hosted');
  assert.equal(env.GITHUB_REPOSITORY, 'BOBWORKS-XR/CREATOR-HUB');
  assert.equal(env.GITHUB_REPOSITORY_ID, '1364807512');
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
  assert.equal(fs.realpathSync(root), root, 'Canonical source root required');
  assert.equal(fs.realpathSync(output), output, 'Redirected candidate output refused');
  const relative = path.relative(path.join(root, 'artifacts/unified'), output);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Owned immutable candidate output required');
  const directory = path.join(output, 'linux-retirement');
  fs.mkdirSync(directory); // Never overwrite an earlier helper, policy or receipt.
  const target = path.join(directory, 'helper-target');
  execute('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(root, 'native/linux-deb-retirement/Cargo.toml'),
    '--features', 'experimental-transaction', '--target', 'x86_64-unknown-linux-gnu', '--target-dir', target],
  { cwd: root, env, stdio: 'inherit', windowsHide: true });
  const helper = path.join(directory, path.posix.basename(HELPER));
  fs.copyFileSync(path.join(target, 'x86_64-unknown-linux-gnu/release/creator-hub-linux-deb-retirement'), helper, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(helper, 0o755);
  const policy = path.join(directory, path.posix.basename(POLICY));
  assert.ok(fs.lstatSync(path.join(root, 'packaging/linux', path.posix.basename(POLICY))).isFile(), 'Regular source policy required');
  fs.copyFileSync(path.join(root, 'packaging/linux', path.posix.basename(POLICY)), policy, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(policy, 0o644);
  const overlay = writeOverlay(root, output, resources, { profile });
  const files = { [HELPER]: record(helper, 0o755), [POLICY]: record(policy, 0o644) };
  const receipt = { schemaVersion: 1, acceptanceOnly: true, sourceCommit: env.GITHUB_SHA,
    platform: 'linux', arch: 'x86_64', rootFeature: FEATURE, helperFeature: 'experimental-transaction',
    files, ...(profile === INTEGRATED_PROFILE ? { profile } : {}), ...FLAGS };
  fs.writeFileSync(path.join(output, 'linux-retirement-candidate.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  return { overlay, files, profile };
}

function writeOverlay(root, output, resources, { profile = DEFAULT_PROFILE } = {}) {
  profileName(profile);
  const directory = path.join(output, 'linux-retirement');
  const helper = path.join(directory, path.posix.basename(HELPER));
  const policy = path.join(directory, path.posix.basename(POLICY));
  const template = profile === INTEGRATED_PROFILE ? 'tauri-integrated-candidate.json' : 'tauri-retirement-acceptance.json';
  const recipe = JSON.parse(fs.readFileSync(path.join(root, 'packaging/linux', template)));
  assert.deepEqual(Object.keys(recipe), ['build', 'bundle']);
  assert.deepEqual(recipe.build, { features: profile === INTEGRATED_PROFILE
    ? [FEATURE, 'integrated-features', 'experimental-flatpak-host'] : [FEATURE] });
  assert.deepEqual(Object.keys(recipe.bundle).sort(), ['linux', 'longDescription', 'shortDescription', 'targets']);
  assert.deepEqual(recipe.bundle.targets, ['deb']);
  assert.deepEqual(Object.keys(recipe.bundle.linux), ['deb']);
  assert.deepEqual(Object.keys(recipe.bundle.linux.deb).sort(), ['depends', 'files']);
  assert.deepEqual(recipe.bundle.linux.deb.depends, ['policykit-1']);
  assert.deepEqual(recipe.bundle.linux.deb.files, { [HELPER]: path.posix.basename(HELPER), [POLICY]: path.posix.basename(POLICY) });
  if (profile === INTEGRATED_PROFILE) {
    assert.equal(recipe.bundle.shortDescription, INTEGRATED_SHORT);
    assert.equal(recipe.bundle.longDescription, INTEGRATED_LONG);
  } else assert.ok(recipe.bundle.shortDescription.startsWith('TEST ONLY - '));
  recipe.bundle.linux.deb.files = { [HELPER]: helper, [POLICY]: policy };
  recipe.bundle.resources = resources;
  const overlay = path.join(output, profile === INTEGRATED_PROFILE
    ? 'tauri-linux-integrated-candidate.json' : 'tauri-linux-retirement-acceptance.json');
  fs.writeFileSync(overlay, JSON.stringify(recipe, null, 2), { flag: 'wx', mode: 0o644 });
  return overlay;
}

function verifyDeb(root, output, integrity, staged, execute = execFileSync) {
  const profile = profileName(staged.profile);
  assert.equal(integrity.integrityPassed, true);
  assert.deepEqual(integrity.packages.map(entry => entry.format), ['deb']);
  const entry = integrity.packages[0];
  assert.match(entry.path, /^native-packages\/[^/\\]+\.deb$/);
  const file = path.join(output, entry.path);
  const image = record(file, fs.lstatSync(file).mode & 0o7777, 512 * 1024 * 1024);
  assert.equal(image.sha256, entry.sha256);
  const verified = JSON.parse(execute('python3', ['-B', path.join(root, 'scripts/linux-retirement-package-verify.py'), file,
    staged.files[HELPER].sha256, staged.files[POLICY].sha256,
    JSON.parse(fs.readFileSync(path.join(root, 'src-tauri/tauri.conf.json'))).version,
    ...(profile === INTEGRATED_PROFILE ? ['--profile', profile] : [])],
  { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 64 * 1024 }));
  const expected = { ...staged.files };
  if (profile === INTEGRATED_PROFILE) {
    assert.equal(verified.profile, profile, 'Verifier must acknowledge the explicit integrated candidate profile');
    expected[SERVICE] = { sha256: crypto.createHash('sha256').update(SERVICE_BYTES).digest('hex'),
      size: SERVICE_BYTES.length, mode: 0o644, uid: 0, gid: 0 };
  }
  assert.deepEqual(verified.files, expected, 'DEB ownership, modes and bytes must match the staged helper and policy plus any required activation service');
  assert.equal(record(file, image.mode, 512 * 1024 * 1024).sha256, image.sha256, 'DEB changed during verification');
  const receipt = { schemaVersion: 1, acceptanceOnly: true, archiveIntegrityPassed: true,
    package: { path: entry.path, sha256: image.sha256, size: image.size }, files: verified.files,
    systemInstallationTested: false, ...(profile === INTEGRATED_PROFILE ? { profile } : {}), ...FLAGS };
  fs.writeFileSync(path.join(output, 'linux-retirement-package-integrity.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
  return receipt;
}

module.exports = { HELPER, POLICY, FEATURE, DEFAULT_PROFILE, INTEGRATED_PROFILE, INTEGRATED_SHORT,
  INTEGRATED_LONG, SERVICE, SERVICE_BYTES, FLAGS, checkOptions, record, stage, writeOverlay, verifyDeb };
