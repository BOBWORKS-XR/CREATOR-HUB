'use strict';
// Source-only on every OS: no compiler, subprocess, product or settings invocation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const crate = path.join(root, 'native', 'flatpak-host-launch');
const read = file => fs.readFileSync(path.join(crate, file), 'utf8');
const api = read('src/lib.rs');
const launch = read('src/linux/launch.rs');
const identity = read('src/linux/identity.rs');
const transport = read('src/linux/transport.rs');
const kernel = read('src/linux/transport/tests.rs');

test('new private crate has only pinned Linux libc and sha2 dependencies', () => {
  const manifest = read('Cargo.toml');
  assert.match(manifest, /publish = false/);
  assert.match(manifest, /\[workspace\]/);
  assert.match(manifest, /libc = "=0\.2\.190"/);
  assert.match(manifest, /sha2 = "=0\.10\.9"/);
  assert.doesNotMatch(manifest, /flatpak-host-reader|tauri|dbus|reqwest|tokio/);
  const expected = fs.readFileSync(path.join(root, 'native/linux-update-check/Cargo.lock'), 'utf8')
    .replace('name = "creator-hub-linux-update-check"', 'name = "creator-hub-flatpak-host-launch"');
  assert.equal(read('Cargo.lock').replace(/\r\n/g, '\n'), expected.replace(/\r\n/g, '\n'));
});

test('bootstrap has one fixed installed ref and executable, not a host command interface', () => {
  assert.match(identity, /app\/com\.creatorworks\.hub\/x86_64\/flatpak-test/);
  assert.match(identity, /\/app\/libexec\/creator-hub-flatpak-launch-echo/);
  assert.match(launch, /Command::new\("\/usr\/bin\/flatpak"\)/);
  assert.equal([...launch.matchAll(/Command::new/g)].length, 1);
  for (const option of ['--user', '--commit=', '--runtime-commit=', '--instance-id-fd=4', '--die-with-parent']) {
    assert.ok(launch.includes(option), option);
  }
  assert.doesNotMatch(api + launch + identity + transport, /flatpak-spawn|--forward-fd|--filesystem|--talk-name|--devel|RequestConsent|GetStatus|InspectMigration|NativeHostSettings|launcher-config|\.claude|\.codex|Unity/);
  assert.match(read('src/main.rs'), /args\.len\(\) != 2 \|\| args\[1\] != "prove-installed"/);
  assert.match(read('src/echo.rs'), /args\.len\(\) != 2 \|\| args\[1\] != "echo-v1"/);
});

test('only build-time review pins and isolated native runner state select inputs', () => {
  assert.deepEqual([...identity.matchAll(/option_env!\("([^"]+)"\)/g)].map(m => m[1]).sort(), [
    'CREATOR_FLATPAK_LAUNCH_APP_COMMIT', 'CREATOR_FLATPAK_LAUNCH_ECHO_SHA256',
    'CREATOR_FLATPAK_LAUNCH_FLATPAK_SHA256', 'CREATOR_FLATPAK_LAUNCH_RUNTIME_COMMIT',
  ]);
  assert.ok(launch.indexOf('let pins = Pins::compiled()?') < launch.indexOf('let uid = identity::uid()?'));
  assert.match(launch, /command\.env_clear\(\)/);
  assert.match(launch, /creator-flatpak-launch-proof/);
  assert.match(launch, /github-hosted/);
  assert.doesNotMatch(launch, /std::env::vars|\.envs\(|\.create_dir|File::create|fs::write|remove_dir/);
});

test('actual seqpacket recvmsg validates per-message credentials and pidfds', () => {
  for (const token of ['libc::socketpair', 'libc::SOCK_SEQPACKET', 'libc::SO_PASSCRED', 'SO_PASSPIDFD',
    'libc::recvmsg', 'libc::MSG_CMSG_CLOEXEC', 'libc::MSG_TRUNC', 'libc::MSG_CTRUNC', 'libc::SCM_CREDENTIALS',
    'SCM_PIDFD', 'libc::SCM_RIGHTS', 'OwnedFd::from_raw_fd', 'missing-sender-pidfd']) {
    assert.ok(transport.includes(token), token);
  }
  assert.doesNotMatch(transport, /SO_PEERCRED|libc::bind|libc::listen|libc::connect/);
  assert.match(identity, /foreign-launch-tree/);
  assert.match(identity, /sender-pidfd-mismatch/);
  assert.match(identity, /sender-changed/);
  assert.match(identity, /deployment-mount-mismatch/);
  assert.match(identity, /echo-image-object-mismatch/);
  assert.match(identity, /unexpected-sandbox-grant/);
});

test('fixed protocol and finite owned cleanup cannot expose reader or claim release acceptance', () => {
  assert.match(read('src/protocol.rs'), /SIZE: usize = 48/);
  assert.match(read('src/protocol.rs'), /Release = 5/);
  assert.match(launch, /Duration::from_secs\(30\)/);
  assert.match(launch, /Duration::from_secs\(2\)/);
  assert.match(launch, /child\.kill\(\)/);
  assert.doesNotMatch(launch, /killpg|pkill|killall|flatpak kill|\.wait\(\)/);
  for (const field of ['signedDeploymentVerified', 'uiCallerAuthenticated', 'hostReaderExposed',
    'hostIntegrationAccepted', 'migrationAccepted', 'releaseReady']) {
    assert.ok(api.includes(`${field}\\\":false`), field);
  }
});

test('native tests exercise forked writers, real ancillary rejection, and a spawned echo binary', () => {
  for (const token of ['libc::fork', 'libc::sendmsg', 'libc::SO_PEERCRED', 'sender-exited',
    'sender-changed', 'foreign-launch-tree', 'read_dir("/proc/self/fd")', 'libc::SCM_RIGHTS']) {
    assert.ok(kernel.includes(token), token);
  }
  const echo = read('tests/echo.rs');
  assert.match(echo, /CARGO_BIN_EXE_creator-hub-flatpak-launch-echo/);
  assert.match(echo, /linux::launch::spawn/);
  assert.match(echo, /linux::launch::reap/);
  assert.equal([...kernel.matchAll(/#\[ignore =/g)].length, 4);
  assert.equal([...echo.matchAll(/#\[ignore =/g)].length, 1);
});
