'use strict';
// TEST ONLY: installed echo transport, never a Hub/settings/reader acceptance test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const APP = 'com.creatorworks.hub';
const REF = `app/${APP}/x86_64/flatpak-test`;
const RUNTIME = 'runtime/org.gnome.Platform/x86_64/50';
const ECHO = 'creator-hub-flatpak-launch-echo';
const HOST = 'creator-hub-flatpak-host-launch';
const REMOTE = 'creator-installed-transport-fixture';
const FLATPAK = '/usr/bin/flatpak';
const OSTREE = '/usr/bin/ostree';
const BRANCH = 'refs/heads/validation/flatpak-installed-host-launch-014';
const CHILDREN = ['home', 'config', 'data', 'cache', 'runtime', 'tmp', 'flatpak'];
const FALSE_FIELDS = ['signedDeploymentVerified', 'uiCallerAuthenticated', 'hostReaderExposed',
  'hostIntegrationAccepted', 'migrationAccepted', 'releaseReady'];
const SHA = /^(?!0{64}$)[a-f0-9]{64}$/;
const LIFECYCLE_TESTS = Object.freeze([
  'linux::launch::tests::installed_session_retains_live_echo_and_finishes_explicitly',
  'linux::launch::tests::duplicate_challenge_poison_closes_without_retry',
  'linux::launch::tests::drop_reaps_only_its_owned_child_and_other_session_remains_live',
  'linux::launch::tests::expired_live_session_refuses_and_cannot_restart_exchange',
]);

function admission(env = process.env, platform = process.platform, arch = process.arch,
  uid = process.getuid?.(), gid = process.getgid?.()) {
  assert.equal(platform, 'linux', 'Native Linux required');
  assert.equal(arch, 'x64', 'Native x86_64 required');
  assert.ok(Number.isInteger(uid) && uid > 0 && Number.isInteger(gid) && gid > 0, 'Non-root runner required');
  for (const [key, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
    RUNNER_OS: 'Linux', RUNNER_ARCH: 'X64', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
    GITHUB_REPOSITORY_ID: '1364807512', GITHUB_REF: BRANCH,
    CREATOR_FLATPAK_INSTALLED_TRANSPORT: '1' })) assert.equal(env[key], value, key);
  assert.ok(['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME), 'Unsupported workflow event');
  assert.match(env.GITHUB_SHA || '', /^[a-f0-9]{40}$/);
  assert.match(env.GITHUB_RUN_ID || '', /^[1-9][0-9]*$/);
  assert.match(env.GITHUB_RUN_ATTEMPT || '', /^[1-9][0-9]*$/);
  assert.equal(env.FLATPAK_ID, undefined, 'Native host required');
  for (const key of Object.keys(env)) {
    assert.ok(!/^(LD_|DYLD_|CARGO_ENCODED_RUSTFLAGS$|RUSTFLAGS$|RUSTC_WRAPPER$|RUSTC_WORKSPACE_WRAPPER$|NODE_OPTIONS$|BASH_ENV$|ENV$)/.test(key), `Injection variable ${key}`);
  }
  assert.ok(path.isAbsolute(env.RUNNER_TEMP || ''), 'Absolute runner temp required');
  assert.equal(path.resolve(env.RUNNER_TEMP), env.RUNNER_TEMP, 'Canonical runner temp required');
  return { uid, gid, work: path.join(env.RUNNER_TEMP, 'creator-flatpak-launch-proof') };
}

function childEnvironment(work) {
  const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    FLATPAK_FANCY_OUTPUT: '0', FLATPAK_TTY_PROGRESS: '0' };
  for (const [key, name] of Object.entries({ HOME: 'home', XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data',
    XDG_CACHE_HOME: 'cache', XDG_RUNTIME_DIR: 'runtime', TMPDIR: 'tmp', FLATPAK_USER_DIR: 'flatpak' })) {
    env[key] = path.join(work, name);
  }
  return env;
}

function ordinary(file, uid, { directory = false, privateMode, executable = false, system = false } = {}) {
  const stat = fs.lstatSync(file);
  assert.ok(directory ? stat.isDirectory() : stat.isFile(), `Ordinary object required: ${file}`);
  assert.equal(stat.uid, system ? 0 : uid, `Wrong owner: ${file}`);
  assert.equal(stat.mode & 0o7022, 0, `Unsafe mode: ${file}`);
  if (privateMode !== undefined) assert.equal(stat.mode & 0o777, privateMode, `Private mode: ${file}`);
  if (executable) assert.ok(stat.mode & 0o111, `Not executable: ${file}`);
  return stat;
}

function safeDirectory(file, uid, privateMode) {
  assert.ok(path.isAbsolute(file));
  assert.equal(path.resolve(file), file, 'Canonical directory required');
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    assert.ok(stat.isDirectory() && (stat.uid === 0 || stat.uid === uid), `Unsafe ancestor: ${current}`);
    assert.equal(stat.mode & 0o7022, 0, `Writable ancestor: ${current}`);
  }
  if (privateMode !== undefined) return ordinary(file, uid, { directory: true, privateMode });
  return fs.lstatSync(file);
}

function image(file, uid, system = false) {
  const stat = ordinary(file, uid, { executable: true, system });
  assert.ok(stat.size > 64 && stat.size <= 32 * 1024 * 1024, 'Bounded executable required');
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.subarray(0, 6).equals(Buffer.from([127, 69, 76, 70, 2, 1])), 'Little-endian ELF64 required');
  assert.equal(bytes.readUInt16LE(18), 62, 'x86_64 ELF required');
  return { path: file, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: stat.size,
    dev: stat.dev, ino: stat.ino, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777, nlink: stat.nlink };
}

function commit(text) {
  assert.match(text, /^[a-f0-9]{64}\n?$/, 'Exact lowercase OSTree commit required');
  const value = text.trimEnd(); assert.match(value, SHA); return value;
}

function sections(text) {
  assert.ok(Buffer.byteLength(text) <= 65536 && !/[\\\0\r]/.test(text), 'Unsupported metadata encoding');
  const result = Object.create(null); let group;
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    assert.ok(line.length <= 8192, 'Metadata line limit');
    if (/^\[[a-zA-Z ]+\]$/.test(line)) {
      group = line.slice(1, -1); assert.equal(result[group], undefined, 'Duplicate group');
      result[group] = Object.create(null); continue;
    }
    const at = line.indexOf('='); assert.ok(group && at > 0, 'Malformed metadata');
    const key = line.slice(0, at); assert.match(key, /^[a-z][a-z-]*$/);
    assert.equal(result[group][key], undefined, 'Duplicate key');
    result[group][key] = line.slice(at + 1);
  }
  return result;
}

function context(input) {
  assert.ok(input, 'Missing Context');
  assert.ok(Object.keys(input).every(key => ['shared', 'sockets', 'devices', 'features'].includes(key)), 'Unexpected grant');
  for (const [key, expected] of Object.entries({ shared: ['ipc'], sockets: ['fallback-x11', 'wayland'], devices: ['dri'] })) {
    const values = (input[key] || '').split(';').filter(Boolean).sort();
    assert.deepEqual(values, expected, `Unexpected ${key} grants`);
  }
  assert.ok(input.features === undefined || input.features === '' || input.features === '!devel;', 'Unexpected features');
}

function metadata(text, permissionsOnly = false) {
  const groups = sections(text);
  assert.deepEqual(Object.keys(groups).sort(), permissionsOnly ? ['Context'] : ['Application', 'Context']);
  if (!permissionsOnly) {
    assert.deepEqual({ ...groups.Application }, { name: APP, runtime: RUNTIME.slice(8), command: `/app/libexec/${ECHO}` });
  }
  context(groups.Context); return groups;
}

function nativeReport(text, status) {
  assert.ok(Buffer.byteLength(text) <= 8192, 'Native output limit');
  const value = JSON.parse(text);
  assert.deepEqual(Object.keys(value).sort(), ['schemaVersion', 'scope', 'syntheticLaunchProofPassed',
    'ownedChildReaped', 'reason', ...FALSE_FIELDS].sort(), 'Unexpected native report');
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.scope, 'synthetic-owned-flatpak-launch-only');
  for (const field of FALSE_FIELDS) assert.equal(value[field], false, field);
  assert.equal(status, 0, 'Native transport refused; original report retained');
  assert.equal(value.syntheticLaunchProofPassed, true);
  assert.equal(value.ownedChildReaped, true);
  assert.equal(value.reason, 'synthetic-echo-and-owned-exit');
  return value;
}

function pinsFrom(app, runtime, echo, flatpak) {
  return Object.freeze({ CREATOR_FLATPAK_LAUNCH_APP_COMMIT: commit(app),
    CREATOR_FLATPAK_LAUNCH_RUNTIME_COMMIT: commit(runtime),
    CREATOR_FLATPAK_LAUNCH_ECHO_SHA256: commit(echo),
    CREATOR_FLATPAK_LAUNCH_FLATPAK_SHA256: commit(flatpak) });
}

function fixtureMetadata() {
  return `[Application]\nname=${APP}\nruntime=${RUNTIME.slice(8)}\ncommand=/app/libexec/${ECHO}\n`;
}

function lifecycleExecutable(text, target) {
  assert.ok(Buffer.byteLength(text) <= 1024 * 1024, 'Cargo output limit');
  const rows = text.trimEnd().split('\n').map(line => JSON.parse(line));
  const finished = rows.filter(row => row.reason === 'build-finished');
  assert.equal(finished.length, 1); assert.equal(finished[0].success, true);
  const artifacts = rows.filter(row => row.reason === 'compiler-artifact' && row.executable);
  assert.equal(artifacts.length, 1, 'Exactly one library test executable required');
  const artifact = artifacts[0];
  assert.equal(artifact.target.name, 'creator_hub_flatpak_host_launch');
  assert.deepEqual(artifact.target.kind, ['lib']); assert.equal(artifact.profile.test, true);
  const executable = artifact.executable;
  assert.ok(path.isAbsolute(executable)); assert.equal(path.resolve(executable), executable);
  assert.equal(path.dirname(executable), path.join(target, 'release', 'deps'));
  assert.match(path.basename(executable), /^creator_hub_flatpak_host_launch-[a-f0-9]{16}$/);
  return executable;
}

function lifecycleResult(name, result) {
  assert.ok(LIFECYCLE_TESTS.includes(name), 'Only fixed lifecycle tests are supported');
  assert.ok(!result.error && !result.signal && result.status === 0, 'Lifecycle test failed; original logs retained');
  assert.ok(Buffer.byteLength(result.stdout || '') <= 16384 && Buffer.byteLength(result.stderr || '') <= 16384,
    'Lifecycle output limit');
  const lines = (result.stdout || '').split(/\r?\n/);
  assert.ok(lines.includes('running 1 test'), 'Exactly one test must execute');
  assert.ok(lines.includes(`test ${name} ... ok`), 'The exact requested test must pass');
  assert.equal(lines.filter(line => line.startsWith('test result:')).length, 1);
  assert.ok(lines.some(line => /^test result: ok\. 1 passed; 0 failed; 0 ignored; 0 measured; [0-9]+ filtered out; finished in [0-9.]+s$/.test(line)),
    'Only one passed test with zero failed, ignored or measured tests can earn a pass');
  return { name, passed: 1, failed: 0, ignored: 0 };
}

function runLifecycleTests(execute, checkpoint) {
  const results = [];
  for (const [index, name] of LIFECYCLE_TESTS.entries()) {
    checkpoint('before', index, name);
    let result;
    try {
      result = execute([name, '--exact', '--ignored', '--test-threads=1', '--color=never']);
    } finally {
      checkpoint('after', index, name);
    }
    results.push(lifecycleResult(name, result));
  }
  return results;
}

function run() {
  const env = process.env;
  const { work, uid, gid } = admission();
  assert.equal(process.geteuid(), uid); assert.equal(process.getegid(), gid);
  assert.ok(!fs.existsSync('/.flatpak-info'), 'Native context required');
  safeDirectory(env.RUNNER_TEMP, uid);
  // Exclusive creation: never adopt, repair, clear, or delete an existing store.
  fs.mkdirSync(work, { mode: 0o700 });
  safeDirectory(work, uid, 0o700);
  for (const name of [...CHILDREN, 'logs', 'frozen', 'build', 'target', 'lifecycle-target']) {
    fs.mkdirSync(path.join(work, name), { mode: 0o700 });
  }
  const report = { schemaVersion: 1, scope: 'installed-synthetic-flatpak-transport-only', phase: 'prepare',
    sourceCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT,
    unsignedFixture: true, flatpakDeploymentTested: false, syntheticLaunchProofPassed: false,
    fixedEchoLifecycleTestsPassed: false,
    signedUpdateAccepted: false, ...Object.fromEntries(FALSE_FIELDS.map(key => [key, false])) };
  const base = childEnvironment(work);
  const source = path.resolve(__dirname, '..');
  const crate = path.join(source, 'native', 'flatpak-host-launch');
  const manifest = path.join(crate, 'Cargo.toml');
  let count = 0;
  const save = (name, value) => fs.writeFileSync(path.join(work, name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  const invoke = (file, args, childEnv = base, timeout = 30000, mustPass = true) => {
    assert.ok(++count <= 300, 'Finite fixture command budget exceeded');
    const index = String(count).padStart(2, '0');
    const result = spawnSync(file, args, { cwd: source, env: childEnv, encoding: 'utf8',
      timeout, killSignal: 'SIGTERM', maxBuffer: 1024 * 1024, shell: false });
    for (const channel of ['stdout', 'stderr']) {
      fs.writeFileSync(path.join(work, 'logs', `${index}.${channel}`), (result[channel] || '').slice(0, 1024 * 1024), { flag: 'wx', mode: 0o600 });
    }
    save(`logs/${index}.json`, { file, args, status: result.status, signal: result.signal,
      error: result.error?.code || null });
    if (mustPass) assert.ok(!result.error && result.status === 0 && !result.signal, `Command ${index} failed (see bounded logs)`);
    return result;
  };
  const fp = args => invoke(FLATPAK, args).stdout;
  const info = (system, option, ref) => fp(['info', system ? '--system' : '--user', option, ref]).trimEnd();
  const settings = CHILDREN.slice(0, 4).map((name, i) => {
    const file = path.join(work, name, 'transport-settings-sentinel.json');
    fs.writeFileSync(file, `${JSON.stringify({ testOnly: true, kind: name, nonce: crypto.randomBytes(24).toString('hex'), i })}\n`, { flag: 'wx', mode: 0o600 });
    return file;
  });
  const settingsSnapshot = () => settings.map(file => {
    const s = ordinary(file, uid, { privateMode: 0o600 });
    return { path: file, bytes: s.size, mode: s.mode & 0o777, uid: s.uid, gid: s.gid, dev: s.dev, ino: s.ino,
      sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  });
  const beforeSettings = settingsSnapshot();
  save('settings-before.json', beforeSettings);
  try {
    assert.equal(invoke('/usr/bin/git', ['rev-parse', 'HEAD']).stdout.trimEnd(), env.GITHUB_SHA, 'Checkout/source mismatch');
    assert.equal(invoke('/usr/bin/git', ['status', '--porcelain', '--untracked-files=all', '--', 'native/flatpak-host-launch']).stdout, '', 'Dirty native source');
    const nativeSource = [];
    const collect = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        assert.ok(entry.isFile() || entry.isDirectory(), 'Nonordinary source');
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) collect(file);
        else {
          const data = fs.readFileSync(file); assert.ok(data.length <= 256 * 1024, 'Source size limit');
          nativeSource.push({ path: path.relative(source, file).split(path.sep).join('/'),
            sha256: crypto.createHash('sha256').update(data).digest('hex'), bytes: data.length });
        }
        assert.ok(nativeSource.length <= 64, 'Source inventory limit');
      }
    };
    collect(crate); save('source.json', { commit: env.GITHUB_SHA, files: nativeSource });
    safeDirectory('/usr/bin', uid);
    const flatpakImage = image(FLATPAK, uid, true);
    assert.equal(fp(['--version']), 'Flatpak 1.18.4\n', 'Reviewed Flatpak 1.18.4 required');
    assert.equal(info(true, '--show-ref', RUNTIME), RUNTIME);
    assert.equal(info(true, '--show-origin', RUNTIME), 'flathub');
    const runtimeCommit = commit(info(true, '--show-commit', RUNTIME));
    const runtimeLocation = `/var/lib/flatpak/${RUNTIME}/${runtimeCommit}`;
    assert.equal(info(true, '--show-location', RUNTIME), runtimeLocation, 'Alternate runtime deployment refused');
    safeDirectory(runtimeLocation, uid);
    const runtimeFiles = ordinary(`${runtimeLocation}/files`, uid, { directory: true, system: true });
    const runtimeProvenance = { ref: RUNTIME, commit: runtimeCommit, location: runtimeLocation,
      origin: 'flathub', signatureAcceptance: false, metadata: info(true, '--show-metadata', RUNTIME),
      installedRuntimeAndExtensionInventory: fp(['list', '--system', '--runtime', '--columns=ref,active,origin']),
      files: { dev: runtimeFiles.dev, ino: runtimeFiles.ino, uid: runtimeFiles.uid, mode: runtimeFiles.mode & 0o777 } };
    save('runtime-provenance.json', runtimeProvenance);

    const cargo = env.CREATOR_FLATPAK_FIXTURE_CARGO;
    assert.ok(path.isAbsolute(cargo || '') && path.basename(cargo) === 'cargo', 'Explicit Cargo executable required');
    assert.ok(path.isAbsolute(env.CARGO_HOME || '') && path.isAbsolute(env.RUSTUP_HOME || ''), 'Explicit public toolchain/cache homes required');
    const buildEnv = { ...base, PATH: `${path.dirname(cargo)}:/usr/bin:/bin`, CARGO_HOME: env.CARGO_HOME,
      RUSTUP_HOME: env.RUSTUP_HOME, CARGO_NET_OFFLINE: 'true' };
    assert.match(invoke(cargo, ['--version'], buildEnv).stdout, /^cargo 1\.99\.0 /, 'Reviewed Rust toolchain required');
    const cargoArgs = bin => ['build', '--locked', '--offline', '--release', '--manifest-path', manifest,
      '--target-dir', path.join(work, 'target'), '--bin', bin];
    report.phase = 'compile-echo';
    invoke(cargo, cargoArgs(ECHO), buildEnv, 180000);
    const originalEcho = image(path.join(work, 'target', 'release', ECHO), uid);
    const frozen = path.join(work, 'frozen', ECHO);
    fs.copyFileSync(originalEcho.path, frozen, fs.constants.COPYFILE_EXCL); fs.chmodSync(frozen, 0o500);
    const frozenImage = image(frozen, uid);
    assert.equal(frozenImage.nlink, 1, 'Frozen echo must not be a Cargo hardlink');
    assert.equal(frozenImage.sha256, originalEcho.sha256);
    const libexec = path.join(work, 'build', 'files', 'libexec');
    fs.mkdirSync(path.dirname(libexec), { mode: 0o755 }); fs.mkdirSync(libexec, { mode: 0o755 });
    fs.copyFileSync(frozen, path.join(libexec, ECHO), fs.constants.COPYFILE_EXCL); fs.chmodSync(path.join(libexec, ECHO), 0o755);
    fs.writeFileSync(path.join(work, 'build', 'metadata'), fixtureMetadata(), { flag: 'wx', mode: 0o644 });
    report.phase = 'install-fixture';
    fp(['build-finish', '--no-inherit-permissions', '--no-exports', '--socket=wayland', '--socket=fallback-x11',
      '--device=dri', '--share=ipc', `--command=/app/libexec/${ECHO}`, path.join(work, 'build')]);
    metadata(fs.readFileSync(path.join(work, 'build', 'metadata'), 'utf8'));
    const repository = path.join(work, 'repository');
    fp(['build-export', '--subject=TEST ONLY installed transport echo, NOT Creator Hub', repository, path.join(work, 'build'), 'flatpak-test']);
    const exportedCommit = commit(invoke(OSTREE, [`--repo=${repository}`, 'rev-parse', REF]).stdout);
    fp(['remote-add', '--user', '--no-gpg-verify', '--no-enumerate', '--no-use-for-deps', REMOTE, pathToFileURL(repository).href]);
    fp(['install', '--user', '--noninteractive', '--assumeyes', '--no-related', '--no-deps', REMOTE, REF]);
    const appLocation = path.join(work, 'flatpak', REF, exportedCommit);
    const inspect = () => {
      for (const name of CHILDREN) safeDirectory(path.join(work, name), uid, 0o700);
      assert.equal(info(false, '--show-ref', REF), REF);
      assert.equal(info(false, '--show-origin', REF), REMOTE);
      assert.equal(info(false, '--show-commit', REF), exportedCommit);
      assert.equal(info(false, '--show-location', REF), appLocation);
      assert.equal(info(false, '--show-runtime', REF), RUNTIME.slice(8));
      assert.equal(info(true, '--show-commit', RUNTIME), runtimeCommit);
      assert.equal(info(true, '--show-location', RUNTIME), runtimeLocation);
      assert.equal(info(true, '--show-ref', RUNTIME), runtimeProvenance.ref);
      assert.equal(info(true, '--show-origin', RUNTIME), runtimeProvenance.origin);
      assert.equal(info(true, '--show-metadata', RUNTIME), runtimeProvenance.metadata);
      assert.equal(fp(['list', '--system', '--runtime', '--columns=ref,active,origin']),
        runtimeProvenance.installedRuntimeAndExtensionInventory, 'Runtime/extension inventory changed');
      const appMetadata = fp(['info', '--user', '--show-metadata', REF]); metadata(appMetadata);
      const permissions = fp(['info', '--user', '--show-permissions', REF]); metadata(permissions, true);
      safeDirectory(appLocation, uid);
      const appFiles = ordinary(path.join(appLocation, 'files'), uid, { directory: true });
      safeDirectory(path.join(appLocation, 'files', 'libexec'), uid);
      const echo = image(path.join(appLocation, 'files', 'libexec', ECHO), uid);
      assert.equal(echo.sha256, originalEcho.sha256, 'Installed echo changed');
      assert.deepEqual(image(FLATPAK, uid, true), flatpakImage, 'Native Flatpak changed');
      assert.deepEqual(image(frozen, uid), frozenImage, 'Frozen echo changed');
      assert.deepEqual(image(originalEcho.path, uid), originalEcho, 'Echo recompiled during host-only build');
      const rt = ordinary(`${runtimeLocation}/files`, uid, { directory: true, system: true });
      assert.deepEqual({ dev: rt.dev, ino: rt.ino, uid: rt.uid, mode: rt.mode & 0o777 }, runtimeProvenance.files);
      return { ref: REF, commit: exportedCommit, location: appLocation, metadata: appMetadata, permissions,
        appFiles: { dev: appFiles.dev, ino: appFiles.ino, uid: appFiles.uid, mode: appFiles.mode & 0o777 }, echo };
    };
    const installedBefore = inspect();
    const pins = pinsFrom(exportedCommit, runtimeCommit, installedBefore.echo.sha256, flatpakImage.sha256);
    save('independent-pins.json', { pins, unsignedFixture: true, flatpakImage, frozenImage,
      exportedCommit, runtimeCommit, installedBefore, runtimeLocation, compileHostAfterThisReceipt: true });
    report.phase = 'compile-pinned-host';
    // Only the host bin is built after independent installed deployment/image inspection.
    const pinnedBuildEnv = Object.freeze({ ...buildEnv, ...pins });
    invoke(cargo, cargoArgs(HOST), pinnedBuildEnv, 180000);
    assert.deepEqual(inspect(), installedBefore, 'Deployment changed during host compilation');
    report.hostImage = image(path.join(work, 'target', 'release', HOST), uid);
    report.phase = 'native-prove-installed';
    const proofEnv = Object.freeze({ ...base, RUNNER_TEMP: env.RUNNER_TEMP,
      GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'BOBWORKS-XR/CREATOR-HUB',
      CREATOR_FLATPAK_LAUNCH_PROOF: '1' });
    const native = invoke(report.hostImage.path, ['prove-installed'], proofEnv, 42000, false);
    save('native-result.json', { status: native.status, signal: native.signal, error: native.error?.code || null,
      stdout: native.stdout || '', stderr: native.stderr || '' });
    assert.deepEqual(image(report.hostImage.path, uid), report.hostImage, 'Host image changed during native exchange');
    assert.deepEqual(inspect(), installedBefore, 'Deployment changed during native exchange');
    assert.deepEqual(settingsSnapshot(), beforeSettings, 'Isolated settings changed');
    const proof = nativeReport(native.stdout || '', native.error || native.signal ? null : native.status);
    report.native = proof; report.pins = pins; report.flatpakDeploymentTested = true;
    report.syntheticLaunchProofPassed = true; report.ownedChildReaped = true;
    const checkpoint = (label, testImage) => {
      const deployment = inspect();
      assert.deepEqual(deployment, installedBefore, 'Deployment changed during lifecycle tests');
      assert.deepEqual(image(report.hostImage.path, uid), report.hostImage, 'Pinned host changed during lifecycle tests');
      const sentinels = settingsSnapshot(); assert.deepEqual(sentinels, beforeSettings, 'Isolated settings changed');
      if (testImage) assert.deepEqual(image(testImage.path, uid), testImage, 'Lifecycle executable changed');
      save(`lifecycle-${label}.json`, { scope: 'fixed-installed-echo-lifecycle-only', deployment,
        runtime: runtimeProvenance, hostImage: report.hostImage, testImage, settings: sentinels,
        ...Object.fromEntries(FALSE_FIELDS.map(key => [key, false])), signedUpdateAccepted: false });
    };
    report.phase = 'compile-lifecycle-tests';
    checkpoint('before-build');
    const lifecycleTarget = path.join(work, 'lifecycle-target');
    // A separate library-test target cannot overwrite the pinned host/echo bins.
    const compiled = invoke(cargo, ['test', '--locked', '--offline', '--release', '--lib', '--no-run',
      '--message-format=json', '--manifest-path', manifest, '--target-dir', lifecycleTarget], pinnedBuildEnv, 180000);
    const executable = lifecycleExecutable(compiled.stdout, lifecycleTarget);
    safeDirectory(path.dirname(executable), uid);
    const testImage = image(executable, uid); report.lifecycleTestImage = testImage;
    checkpoint('after-build', testImage);
    report.phase = 'native-fixed-echo-lifecycle';
    const results = runLifecycleTests(args => invoke(executable, args, proofEnv, 75000, false),
      (phase, index, name) => {
        report.phase = `native-fixed-echo-lifecycle-${index + 1}-${phase}`;
        checkpoint(`${index + 1}-${phase}`, testImage);
      });
    save('lifecycle-tests.json', { scope: 'fixed-installed-echo-lifecycle-only', tests: results,
      ...Object.fromEntries(FALSE_FIELDS.map(key => [key, false])), signedUpdateAccepted: false });
    report.lifecycleTests = results; report.fixedEchoLifecycleTestsPassed = true; report.phase = 'complete';
  } catch (error) {
    report.failure = String(error.message).slice(0, 2048);
    process.exitCode = 1;
  } finally {
    try {
      const after = settingsSnapshot(); save('settings-after.json', after);
      assert.deepEqual(after, beforeSettings); report.isolatedSettingsPreserved = true;
    } catch (error) {
      report.isolatedSettingsPreserved = false; report.settingsFailure = String(error.message).slice(0, 1024);
      report.fixedEchoLifecycleTestsPassed = false;
      process.exitCode = 1;
    }
    save('report.json', report);
    console.log(JSON.stringify(report));
  }
  return report;
}

if (require.main === module) {
  try {
    assert.deepEqual(process.argv.slice(2), ['run'], 'Only run is accepted; no paths or overrides');
    run();
  } catch (error) {
    console.error(String(error.message).slice(0, 2048)); process.exitCode = 1;
  }
}
module.exports = { APP, REF, RUNTIME, ECHO, HOST, BRANCH, CHILDREN, FALSE_FIELDS,
  admission, childEnvironment, ordinary, safeDirectory, image, commit, sections, context, metadata,
  nativeReport, pinsFrom, fixtureMetadata, LIFECYCLE_TESTS, lifecycleExecutable, lifecycleResult, runLifecycleTests };
