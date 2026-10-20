'use strict';
// Fixed production launcher producer. No app execution, installation or signing.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROFILE = 'production-native-activation-016', VERSION = '0.1.16';
const REPO = 'BOBWORKS-XR/CREATOR-HUB', REPO_ID = 1364807512;
const WORKFLOW = '.github/workflows/flatpak-native-production-016.yml';
const BRANCH = 'refs/heads/validation/linux-flatpak-production-016';
const ID = 'com.creatorworks.hub', NAME = `${ID}.Host`;
const COMMAND = 'creator-hub-flatpak-activate', REF = `app/${ID}/x86_64/stable`;
const RUNTIME = 'org.gnome.Platform/x86_64/50', SDK = 'org.gnome.Sdk/x86_64/50';
const TOOLCHAIN = '1.99.0', TARGET = 'x86_64-unknown-linux-gnu';
const CRATE = 'native/flatpak-native-activation';
const KEY = 'src-tauri/src/catalog-key.pub';
const SOURCES = Object.freeze([
  `${CRATE}/Cargo.toml`, `${CRATE}/Cargo.lock`, `${CRATE}/src/lib.rs`,
  `${CRATE}/src/main.rs`, `${CRATE}/src/linux.rs`, `${CRATE}/src/check.rs`,
  `${CRATE}/${NAME}.service`, KEY, 'src-tauri/icons/128x128.png',
  'LICENSE', 'package.json', 'src-tauri/tauri.conf.json',
]);
const PERMISSIONS = Object.freeze(['--socket=wayland', '--socket=fallback-x11', `--talk-name=${NAME}`]);
const FLAGS = Object.freeze(Object.fromEntries([
  'candidateExecuted', 'flatpakInstalled', 'flatpakActivationAccepted', 'nativeHelperInstalled',
  'nativeRootWiringAccepted', 'settingsPreserved', 'signedUpdateAccepted', 'restartAccepted',
  'runtimeAccepted', 'steamDeckAccepted', 'publisherSignatureAccepted', 'releaseReady',
].map(k => [k, false])));
const BUNDLE = `Creator.Hub_${VERSION}_x86_64.flatpak`;
const LIMIT = 64 * 1024 * 1024;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const pin = bytes => ({ size: bytes.length, sha256: hash(bytes) });
function keys(value, names) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...names].sort(), 'Unknown or missing producer fields');
}
function sha(value, length = 64) { assert.ok(typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value)); }
function validate(input) {
  keys(input, ['schemaVersion', 'profile', 'sourceCommit', 'sourceTree', 'files']);
  assert.equal(input.schemaVersion, 1); assert.equal(input.profile, PROFILE);
  sha(input.sourceCommit, 40); sha(input.sourceTree, 40); keys(input.files, SOURCES);
  for (const value of Object.values(input.files)) {
    keys(value, ['size', 'sha256']); sha(value.sha256);
    assert.ok(Number.isSafeInteger(value.size) && value.size > 0 && value.size <= 2 * 1024 * 1024);
  }
  return input;
}
function admission(env, platform = process.platform, arch = process.arch, uid = process.getuid?.()) {
  assert.equal(platform, 'linux'); assert.equal(arch, 'x64'); assert.ok(Number.isInteger(uid) && uid > 0);
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_ID: String(REPO_ID),
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: BRANCH, GITHUB_WORKFLOW_REF: `${REPO}/${WORKFLOW}@${BRANCH}` })) assert.equal(env[key], value, key);
  sha(env.GITHUB_SHA, 40);
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) assert.match(env[key] || '', /^[1-9][0-9]*$/);
  assert.ok(!env.DISPLAY && !env.WAYLAND_DISPLAY && !env.FLATPAK_ID, 'Headless native producer only');
  for (const key of Object.keys(env)) assert.ok(!/^(LD_|DYLD_|TAURI_|WEBKIT_|APPIMAGE$|APPDIR$|PYTHON|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|NODE_TLS_REJECT_UNAUTHORIZED$|SSL_CERT_|CURL_CA_BUNDLE$|RUSTFLAGS$|CARGO_ENCODED_RUSTFLAGS$|RUSTC$|RUSTC_WRAPPER$|RUSTC_WORKSPACE_WRAPPER$|CARGO_BUILD_|CARGO_TARGET_|CARGO_PROFILE_|GIT_CONFIG_|BASH_ENV$|ENV$|FLATPAK_VALIDATE_|CREATOR_HUB_SIGNING_)/.test(key)
    && !key.toLowerCase().endsWith('proxy'), 'Injected build, trust, signing or runtime settings refused');
  assert.ok(!env.RUSTUP_TOOLCHAIN || env.RUSTUP_TOOLCHAIN === TOOLCHAIN);
}
function preflight(env = process.env, platform, arch, uid) {
  admission(env, platform, arch, uid);
  assert.ok(typeof env.SOURCE_PINS === 'string' && Buffer.byteLength(env.SOURCE_PINS) <= 16384);
  return validate(JSON.parse(env.SOURCE_PINS));
}
function ordinary(file, directory = false) {
  assert.ok(path.isAbsolute(file) && path.resolve(file) === file);
  for (let next = file;; next = path.dirname(next)) {
    const info = fs.lstatSync(next); assert.equal(info.isSymbolicLink(), false, 'Linked path refused');
    if (next !== file || directory) assert.ok(info.isDirectory());
    if (path.dirname(next) === next) break;
  }
}
function read(file, maximum = LIMIT, multipleLinks = false) {
  ordinary(file);
  const before = fs.lstatSync(file);
  assert.ok(before.isFile() && (multipleLinks || before.nlink === 1) && before.size > 0 && before.size <= maximum);
  const stamp = s => [s.dev, s.ino, s.size, s.mode, s.nlink, s.uid, s.gid, s.mtimeMs, s.ctimeMs];
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    assert.deepEqual(stamp(fs.fstatSync(fd)), stamp(before));
    const bytes = Buffer.alloc(before.size + 1); let count = 0;
    while (count < bytes.length) { const n = fs.readSync(fd, bytes, count, bytes.length - count, null); if (!n) break; count += n; }
    assert.equal(count, before.size); assert.deepEqual(stamp(fs.fstatSync(fd)), stamp(before));
    assert.deepEqual(stamp(fs.lstatSync(file)), stamp(before)); return bytes.subarray(0, count);
  } finally { fs.closeSync(fd); }
}
function put(root, name, body, mode = 0o644) {
  const file = path.join(root, name);
  let directory = root;
  for (const part of name.split('/').slice(0, -1)) {
    directory = path.join(directory, part);
    if (!fs.existsSync(directory)) { fs.mkdirSync(directory, { mode: 0o755 }); fs.chmodSync(directory, 0o755); }
    ordinary(directory, true);
  }
  fs.writeFileSync(file, body, { flag: 'wx', mode }); fs.chmodSync(file, mode);
}
function json(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
function workPath(env) {
  ordinary(env.RUNNER_TEMP, true); assert.equal(fs.realpathSync(env.RUNNER_TEMP), env.RUNNER_TEMP);
  return path.join(env.RUNNER_TEMP, 'flatpak-native-production-016');
}
function sourceAPI(input, repository, commit) {
  validate(input);
  assert.equal(repository.id, REPO_ID); assert.equal(repository.full_name, REPO);
  assert.equal(commit.sha, input.sourceCommit); assert.equal(commit.tree.sha, input.sourceTree);
  return { repositoryId: repository.id, sourceCommit: commit.sha, sourceTree: commit.tree.sha };
}
async function collect(github, context, env = process.env) {
  const input = preflight(env);
  assert.equal(context.sha, env.GITHUB_SHA); assert.equal(context.ref, BRANCH); assert.equal(context.eventName, 'workflow_dispatch');
  assert.equal(`${context.repo.owner}/${context.repo.repo}`, REPO);
  const repo = { owner: 'BOBWORKS-XR', repo: 'CREATOR-HUB' };
  const { data: repository } = await github.rest.repos.get(repo);
  const { data: commit } = await github.rest.git.getCommit({ ...repo, commit_sha: input.sourceCommit });
  const api = sourceAPI(input, repository, commit);
  const work = workPath(env); fs.mkdirSync(work, { mode: 0o700 });
  json(path.join(work, 'input-binding.json'), { schemaVersion: 1, profile: PROFILE, input,
    api,
    harnessSource: context.sha, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, ...FLAGS });
}
function bound(bytes, expected) { assert.deepEqual(pin(bytes), expected, 'Source or package bytes differ'); return bytes; }
function validateSource(bytes) {
  keys(bytes, SOURCES);
  const toml = bytes[`${CRATE}/Cargo.toml`].toString('utf8');
  assert.match(toml, /^name = "creator-hub-flatpak-native-activation"$/m);
  assert.match(toml, /^version = "0\.1\.16"$/m); assert.match(toml, /^\[workspace\]$/m);
  assert.ok(!/^(?:build|links)\s*=/m.test(toml), 'Additional crate build entry point refused');
  assert.equal(JSON.parse(bytes['package.json']).version, VERSION);
  assert.equal(JSON.parse(bytes['src-tauri/tauri.conf.json']).version, VERSION);
  const lib = bytes[`${CRATE}/src/lib.rs`].toString('utf8');
  assert.ok(lib.includes('include_str!("../../../src-tauri/src/catalog-key.pub")'));
  assert.ok(lib.includes('pub const METHOD: &str = "Start";'));
  assert.ok(bytes[KEY].toString('utf8').startsWith('untrusted comment:'));
}
function compileArguments(source, target) {
  return ['build', '--release', '--locked', '--no-default-features', '--manifest-path',
    path.join(source, CRATE, 'Cargo.toml'), '--bin', COMMAND, '--target', TARGET, '--target-dir', target];
}
function checkoutSources(input, source, git) {
  validate(input);
  assert.equal(git(['rev-parse', `${input.sourceCommit}^{tree}`]).trim(), input.sourceTree);
  const sources = {};
  for (const name of SOURCES) {
    const row = git(['ls-tree', input.sourceCommit, '--', name]).trim();
    assert.match(row, /^100644 blob [a-f0-9]{40}\t/);
    assert.equal(row.slice(row.indexOf('\t') + 1), name, 'Unexpected source Git entry');
    const bytes = git(['show', `${input.sourceCommit}:${name}`], { encoding: null });
    bound(bytes, input.files[name]); sources[name] = bytes; put(source, name, bytes);
  }
  validateSource(sources); return sources;
}
function elf(bytes) {
  assert.ok(bytes.length >= 64 && bytes.length <= LIMIT && bytes.subarray(0, 7).equals(Buffer.from([127, 69, 76, 70, 2, 1, 1])));
  assert.equal(bytes.readUInt16LE(18), 62); assert.ok([2, 3].includes(bytes.readUInt16LE(16)));
}
function metadata() {
  return `[Application]\nname=${ID}\nruntime=${RUNTIME}\nsdk=${SDK}\ncommand=${COMMAND}\n\n[Context]\nsockets=wayland;fallback-x11;\n\n[Session Bus Policy]\n${NAME}=talk\n`;
}
function metainfo() {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<component type="desktop-application">\n<id>${ID}</id>\n<metadata_license>CC0-1.0</metadata_license>\n<project_license>MIT</project_license>\n<name>Creator Hub</name>\n<summary>Open native Creator Hub with separately approved native support</summary>\n<description><p>This manually installed Flatpak bundle is a launcher. The Creator Hub window runs outside the Flatpak sandbox and uses native host settings. Native support requires a separate signed package and your approval. Get Native Hub opens the dedicated Creator.Hub.Native.Support_${VERSION}_amd64.AppImage setup download, not the ordinary Hub AppImage. Close setup normally, then reopen this Flatpak. Native Hub updates use its separate signed updater; compatible host updates do not require a matching launcher update. This bundle does not provide an application update remote. The required GNOME runtime is not included.</p></description>\n<launchable type="desktop-id">${ID}.desktop</launchable>\n<url type="homepage">https://github.com/BOBWORKS-XR/CREATOR-HUB</url>\n<releases><release version="${VERSION}"/></releases>\n</component>\n`;
}
function payload(launcher, sources) {
  elf(launcher);
  const desktop = Buffer.from(`[Desktop Entry]\nType=Application\nName=Creator Hub\nComment=Opens native Hub outside the sandbox; separately approved native support required\nExec=${COMMAND}\nIcon=${ID}\nTerminal=false\nCategories=Development;\n`);
  const data = {
    [`bin/${COMMAND}`]: { body: launcher, mode: 0o755 },
    [`share/applications/${ID}.desktop`]: { body: desktop, mode: 0o644 },
    [`share/icons/hicolor/128x128/apps/${ID}.png`]: { body: sources['src-tauri/icons/128x128.png'], mode: 0o644 },
    [`share/metainfo/${ID}.metainfo.xml`]: { body: Buffer.from(metainfo()), mode: 0o644 },
    [`share/licenses/${ID}/LICENSE`]: { body: sources.LICENSE, mode: 0o644 },
  };
  const files = { metadata: { body: Buffer.from(metadata()), mode: 0o644 } };
  for (const [name, row] of Object.entries(data)) {
    files[`files/${name}`] = row;
    if (name.startsWith('share/') && !name.startsWith('share/licenses/')) files[`export/${name}`] = row;
  }
  return files;
}
function expectedInventory(files) {
  const out = {};
  for (const [name, row] of Object.entries(files)) {
    out[name] = { kind: 'file', mode: row.mode, ...pin(row.body) };
    for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) out[parent] = { kind: 'directory', mode: 0o755 };
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b, 'en')));
}
function inventory(root, unix = process.platform === 'linux') {
  ordinary(root, true); const out = {}; let total = 0;
  function walk(dir, prefix = '') {
    const names = fs.readdirSync(dir).sort(); assert.ok(names.length <= 64);
    for (const name of names) {
      assert.match(name, /^[A-Za-z0-9_.-]+$/);
      const relative = prefix + name, file = path.join(dir, name), s = fs.lstatSync(file);
      assert.ok(Object.keys(out).length < 64 && !s.isSymbolicLink());
      const mode = s.mode & 0o7777;
      if (s.isDirectory()) { if (unix) assert.equal(mode, 0o755); out[relative] = { kind: 'directory', mode: 0o755 }; walk(file, relative + '/'); }
      else {
        assert.ok(s.isFile() && s.nlink === 1); if (unix) assert.ok([0o644, 0o755].includes(mode));
        const body = read(file); total += body.length; assert.ok(total <= LIMIT + 2 * 1024 * 1024);
        out[relative] = { kind: 'file', mode: unix ? mode : (relative === `files/bin/${COMMAND}` ? 0o755 : 0o644), ...pin(body) };
      }
    }
  }
  walk(root); return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b, 'en')));
}
function commands(work) {
  const stage = path.join(work, 'stage'), repo = path.join(work, 'repo'), imported = path.join(work, 'imported');
  const bundle = path.join(work, 'output', BUNDLE), checkout = path.join(work, 'checkout');
  return { stage, repo, imported, bundle, checkout,
    export: ['build-export', '--arch=x86_64', '--no-update-summary', repo, stage, 'stable'],
    bundleArgs: ['build-bundle', '--arch=x86_64', repo, bundle, ID, 'stable'],
    init: [`--repo=${imported}`, 'init', '--mode=archive-z2'],
    importArgs: ['build-import-bundle', '--no-update-summary', imported, bundle],
    fsck: [`--repo=${imported}`, 'fsck', '--verify-bindings'],
  };
}
function inspectBundle(work, expected, execute) {
  const c = commands(work), before = pin(read(c.bundle));
  execute('/usr/bin/ostree', c.init); execute('/usr/bin/flatpak', c.importArgs);
  execute('/usr/bin/ostree', c.fsck);
  assert.equal(String(execute('/usr/bin/ostree', [`--repo=${c.imported}`, 'refs'])).trim(), REF, 'Unexpected bundle refs');
  const commit = String(execute('/usr/bin/ostree', [`--repo=${c.imported}`, 'rev-parse', REF])).trim(); sha(commit);
  assert.equal(String(execute('/usr/bin/ostree', [`--repo=${c.repo}`, 'rev-parse', REF])).trim(), commit, 'Bundle changed exported commit');
  execute('/usr/bin/ostree', [`--repo=${c.imported}`, 'checkout', '--user-mode', '--force-copy', commit, c.checkout]);
  const found = inventory(c.checkout); assert.deepEqual(found, expected, 'Complete imported bundle inventory differs');
  assert.equal(read(path.join(c.checkout, 'metadata'), 65536).toString('utf8'), metadata());
  bound(read(c.bundle), before);
  return { commit, bundle: before, inventory: found, runtime: RUNTIME, sdk: SDK, declaredPermissions: [...PERMISSIONS] };
}
function cleanEnvironment(work) {
  return { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: path.join(work, 'home'),
    XDG_CONFIG_HOME: path.join(work, 'config'), XDG_DATA_HOME: path.join(work, 'data'), XDG_CACHE_HOME: path.join(work, 'cache'),
    XDG_RUNTIME_DIR: path.join(work, 'runtime'), TMPDIR: path.join(work, 'tmp'), FLATPAK_USER_DIR: path.join(work, 'installation') };
}
function produce(env = process.env) {
  const input = preflight(env), work = workPath(env);
  assert.equal(process.geteuid(), process.getuid(), 'Effective identity must remain unprivileged');
  ordinary(work, true); const ws = fs.lstatSync(work);
  assert.equal(ws.uid, process.getuid()); assert.equal(ws.mode & 0o7777, 0o700);
  assert.deepEqual(fs.readdirSync(work), ['input-binding.json']);
  const binding = JSON.parse(read(path.join(work, 'input-binding.json'), 65536));
  keys(binding, ['schemaVersion', 'profile', 'input', 'api', 'harnessSource', 'runId', 'runAttempt', ...Object.keys(FLAGS)]);
  assert.equal(binding.schemaVersion, 1); assert.equal(binding.profile, PROFILE); assert.deepEqual(binding.input, input);
  assert.deepEqual(binding.api, { repositoryId: REPO_ID, sourceCommit: input.sourceCommit, sourceTree: input.sourceTree });
  assert.equal(binding.harnessSource, env.GITHUB_SHA); assert.equal(binding.runId, env.GITHUB_RUN_ID); assert.equal(binding.runAttempt, env.GITHUB_RUN_ATTEMPT);
  for (const k of Object.keys(FLAGS)) assert.equal(binding[k], false);
  const source = path.join(work, 'source'), target = path.join(work, 'target'), output = path.join(work, 'output');
  for (const name of ['home', 'config', 'data', 'cache', 'runtime', 'tmp', 'installation', 'cargo-home', 'source', 'output']) fs.mkdirSync(path.join(work, name), { mode: 0o700 });
  const childEnv = cleanEnvironment(work), trace = [];
  const execute = (command, args, options = {}) => {
    assert.ok(path.isAbsolute(command) && Array.isArray(args));
    trace.push({ command, arguments: args });
    return execFileSync(command, args, { cwd: work, env: childEnv, encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024, ...options });
  };
  try {
    const git = (args, options = {}) => execute('/usr/bin/git', ['-C', ROOT, ...args], { env: { ...childEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, ...options });
    assert.equal(git(['rev-parse', 'HEAD']).trim(), env.GITHUB_SHA);
    const sources = checkoutSources(input, source, git);
    for (let directory = source;; directory = path.dirname(directory)) {
      for (const name of ['config', 'config.toml']) assert.equal(fs.existsSync(path.join(directory, '.cargo', name)), false, 'Inherited Cargo configuration refused');
      if (path.dirname(directory) === directory) break;
    }
    const rustup = path.join(env.CARGO_HOME || path.join(env.HOME, '.cargo'), 'bin/rustup');
    const toolFiles = {};
    for (const tool of ['rustc', 'cargo']) {
      const file = execute(rustup, ['which', '--toolchain', TOOLCHAIN, tool], { env: { ...childEnv, RUSTUP_HOME: env.RUSTUP_HOME || path.join(env.HOME, '.rustup') } }).trim();
      ordinary(file); toolFiles[tool] = { path: file, ...pin(read(file, 256 * 1024 * 1024)) };
    }
    const compiler = execute(toolFiles.rustc.path, ['--version', '--verbose']);
    const cargo = execute(toolFiles.cargo.path, ['--version']);
    assert.match(compiler, /^rustc 1\.99\.0 /); assert.match(compiler, /^host: x86_64-unknown-linux-gnu$/m); assert.match(cargo, /^cargo 1\.99\.0 /);
    const args = compileArguments(source, target);
    execute(toolFiles.cargo.path, args, { cwd: source, timeout: 900000, env: { ...childEnv,
      CARGO_HOME: path.join(work, 'cargo-home'), RUSTC: toolFiles.rustc.path,
      PATH: `${path.dirname(toolFiles.rustc.path)}:/usr/bin:/bin` } });
    for (const name of SOURCES) bound(read(path.join(source, name), 2 * 1024 * 1024), input.files[name]);
    const launcher = read(path.join(target, TARGET, 'release', COMMAND), LIMIT, true); elf(launcher);
    put(output, COMMAND, launcher, 0o755);
    const build = { toolchain: TOOLCHAIN, target: TARGET, compiler, cargo, toolFiles, arguments: args,
      files: input.files, publicKey: input.files[KEY], launcher: pin(launcher), onlyLauncherCompiled: true };
    const files = payload(launcher, sources), expected = expectedInventory(files), c = commands(work);
    fs.mkdirSync(c.stage, { mode: 0o700 }); for (const [name, row] of Object.entries(files)) put(c.stage, name, row.body, row.mode);
    assert.deepEqual(inventory(c.stage), expected);
    const tools = {};
    for (const [tool, args] of [['/usr/bin/flatpak', ['--version']], ['/usr/bin/ostree', ['--version']]]) {
      tools[tool] = { version: execute(tool, args).trim(), ...pin(read(fs.realpathSync(tool), 32 * 1024 * 1024)) };
    }
    execute('/usr/bin/flatpak', c.export); assert.deepEqual(inventory(c.stage), expected);
    execute('/usr/bin/flatpak', c.bundleArgs);
    const inspection = inspectBundle(work, expected, execute);
    for (const row of Object.values(toolFiles)) bound(read(row.path, 256 * 1024 * 1024), { size: row.size, sha256: row.sha256 });
    for (const [tool, row] of Object.entries(tools)) bound(read(fs.realpathSync(tool), 32 * 1024 * 1024), { size: row.size, sha256: row.sha256 });
    bound(read(path.join(output, COMMAND)), build.launcher);
    const receipt = { schemaVersion: 1, profile: PROFILE, version: VERSION, appId: ID, architecture: 'x86_64',
      ref: REF, source: binding, build, tools, bundle: { name: BUNDLE, ...inspection.bundle },
      inspection, commands: trace, packagingCompleted: true, bundleInspectionPassed: true,
      distribution: 'manual-single-file-bundle', nativeHostModel: 'separately-approved-outside-sandbox',
      nativeHostUpdates: 'separate-signed-native-updater', runtimeProvisioned: false, ...FLAGS };
    json(path.join(output, 'production-flatpak-receipt.json'), receipt); return receipt;
  } catch (error) {
    json(path.join(output, 'production-flatpak-refusal.json'), { schemaVersion: 1, profile: PROFILE,
      packagingCompleted: false, error: String(error.message).slice(0, 2000), ...FLAGS }); throw error;
  }
}
module.exports = { PROFILE, VERSION, WORKFLOW, BRANCH, REPO, REPO_ID, ID, NAME, COMMAND, REF, RUNTIME, SDK, TOOLCHAIN,
  TARGET, CRATE, KEY, SOURCES, PERMISSIONS, FLAGS, BUNDLE, hash, pin, validate, admission, preflight, collect,
  read, sourceAPI, validateSource, checkoutSources, compileArguments, metadata, metainfo, payload, expectedInventory, inventory, commands, inspectBundle,
  cleanEnvironment, produce };
if (require.main === module) {
  try {
    assert.equal(process.argv.length, 3, 'Only preflight or package is accepted; no paths or commands');
    const mode = process.argv[2]; assert.ok(['preflight', 'package'].includes(mode));
    if (mode === 'preflight') { preflight(); console.log(JSON.stringify({ profile: PROFILE, preflightPassed: true, ...FLAGS })); }
    else { const result = produce(); console.log(JSON.stringify({ profile: PROFILE, bundle: result.bundle, bundleInspectionPassed: true, ...FLAGS })); }
  } catch (error) { console.error(String(error.message).slice(0, 2000)); process.exitCode = 1; }
}
