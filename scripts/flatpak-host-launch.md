# Synthetic Native Flatpak Launch Proof

Source implementation only. This is not Hub integration, a broker, a settings
reader, a publisher verifier or release acceptance. Only the new
`native/flatpak-host-launch/` and matching source test/this handoff are owned here.
The ff8 checkpoint was read; current parent source was f66d37f. Concurrent native
producer 39041386789, packaging/workflows, Root and every existing reader remain
parent-owned and unchanged. No commit, dispatch, build, native invocation,
installation, permission or settings operation was performed in this task.

## Implemented Mechanism

- Linux x86_64 only. Native executable accepts exactly `prove-installed`;
  sandbox echo accepts exactly `echo-v1`. No path, argv, operation or settings
  input is accepted. The native side executes only `/usr/bin/flatpak`, with a
  finite cleared environment and a fixed app/ref/command.
- Actual nonblocking `AF_UNIX/SOCK_SEQPACKET` socketpair. The host enables
  `SO_PASSCRED` and `SO_PASSPIDFD`; every received packet must carry exactly one
  `SCM_CREDENTIALS` and one kernel `SCM_PIDFD`. Unknown controls, `SCM_RIGHTS`,
  absent credentials/pidfd, short/oversized/truncated packets refuse. Received
  descriptors are adopted and closed even on refusal.
- Only FD 3 (echo socket) and FD 4 (Flatpak's instance-ID output pipe) survive
  child exec, besides null stdio. `close_range(CLOSE_RANGE_CLOEXEC)` preserves
  Rust's exec-error pipe until exec. No named listener or D-Bus transport exists.
- Six fixed 48-byte frames: Ready, Challenge, Echo, Close, Closed, Release. The
  host obtains its challenge from nonblocking kernel randomness. The echo waits
  for Release, keeping the sender alive while Closed is independently checked.
- Each response rechecks its sender pidfd, kernel PID/UID, process start time,
  and an at-most-eight-process ancestry to the retained native child. Deployment
  checks read only numeric-kernel-PID procfs objects: different PID/mount
  namespaces, actual `/app` and `/usr` directory dev/inode, actual echo ELF
  dev/inode/SHA-256, and bounded `/.flatpak-info` through that process's root.
  Replaced app/runtime paths, build/devel markers and additional nonempty grant
  classes refuse. The metadata parser deliberately accepts only a strict simple
  generated-keyfile subset; unsupported escaping refuses instead of guessing.
- One 30-second deadline covers preparation and exchange, with at most two
  additional seconds for cleanup/reap. Only the retained unreaped direct Child
  may be killed on failure; no app-ID/process-group/global termination exists.
  Success requires the normal owned outer exit 0. This does not independently
  certify all descendant cleanup. I/O or exec blocked inside the kernel still
  needs the parent's external job/process deadline.

The result is bounded JSON. `signedDeploymentVerified`, `uiCallerAuthenticated`,
`hostReaderExposed`, `hostIntegrationAccepted`, `migrationAccepted` and
`releaseReady` remain false even on synthetic proof success. The only success
claim is `syntheticLaunchProofPassed` plus `ownedChildReaped`.

## First Native CI Checkpoint: No Flatpak Setup Needed

Parent coordination is required before executing these commands. Use a disposable
non-root x86_64 GitHub-hosted Linux job in BOBWORKS-XR/CREATOR-HUB. Require kernel
support for SO_PASSPIDFD/SCM_PIDFD (upstream Linux 6.5+) and close_range CLOEXEC.
An unsupported setsockopt refuses as `unsupported-kernel-pidfd-credentials`;
there is no SO_PEERCRED, nonce-only or numeric-PID-only fallback. Procfs must be
available for the kernel-identity tests. Never change sysctl, tracing privileges,
LSM policy or Flatpak permissions to force a pass.

Dependencies are locked libc 0.2.190 and sha2 0.10.9. The lock graph is copied
from the existing linux-update-check lock, changing only this crate's name.
Provision its public dependencies through the parent's existing approved setup;
all commands below resolve offline and must retain the exact source snapshot.

```sh
CRATE=native/flatpak-host-launch/Cargo.toml
TARGET="$RUNNER_TEMP/flatpak-host-launch-target"
cargo test --locked --offline --manifest-path "$CRATE" --target-dir "$TARGET" --lib
CREATOR_FLATPAK_LAUNCH_KERNEL_TEST=1 cargo test --locked --offline --manifest-path "$CRATE" --target-dir "$TARGET" --lib linux::transport::tests:: -- --ignored --test-threads=1
CREATOR_FLATPAK_LAUNCH_KERNEL_TEST=1 cargo test --locked --offline --manifest-path "$CRATE" --target-dir "$TARGET" --test echo native_echo_binary_inherits_fd3_completes_protocol_and_exits -- --ignored --test-threads=1
```

The four ignored kernel tests use real forked writers, actual ancillary messages,
live/dead pidfds, owned ancestry, foreign start/UID refusal, SCM_RIGHTS descriptor
cleanup, oversize/missing-credential refusal and a short actual poll deadline.
The separate ignored integration test spawns the real echo binary through the
same inherited-FD pre-exec function, exchanges all frames, and reaps exit 0.
It does not claim Flatpak mounting or GUI admission. Default tests exercise
protocol/parser/pin refusals without starting Flatpak.

## Second Checkpoint: Parent-Owned Installed Flatpak Fixture

Use the verified Flatpak 1.18.4 launch contract and pin the actual native binary
bytes. The parent must prepare a separately reviewed TEST ONLY fixture, not
weaken the existing six/seven-file production packager. Put the retained echo
binary at `/app/libexec/creator-hub-flatpak-launch-echo` in that fixture, with the
same four grants: wayland, fallback-x11, dri, ipc. Do not use the real Hub entry
point: it has no echo handler and has an unqualified single-instance handoff.

The fixed app ref is `app/com.creatorworks.hub/x86_64/flatpak-test`, installed
in the isolated user store below. The exact GNOME Platform runtime is
`org.gnome.Platform/x86_64/50`, preinstalled in the default system installation.
Expected deployment `files` directories are derived from full 64-hex commits;
alternate installations, subpath deployment names or path aliases refuse.
The parent independently records signature/provenance, runtime/extensions,
effective permissions, source commit/tree and native executable hashes.
An explicitly unsigned isolated fixture is sufficient for transport testing;
record that fact and keep signed-deployment and integration acceptance false.

Before native execution, the parent creates a fresh, current-user-owned 0700
`$RUNNER_TEMP/creator-flatpak-launch-proof` with 0700 children `home`, `config`,
`data`, `cache`, `runtime`, `tmp` and `flatpak`. Nothing here creates, repairs,
adopts or deletes those directories. Install the fixture with that isolated
HOME/XDG and `FLATPAK_USER_DIR` (the last child). No live-user Flatpak store.

Compile the echo first without host pins and retain its exact bytes. After the
fixture's deployment commits and echo/native Flatpak SHA-256 values have been
independently reviewed, compile ONLY the native launcher with these four
compile-time environment values. They are not runtime RPC/environment claims:

```text
CREATOR_FLATPAK_LAUNCH_APP_COMMIT
CREATOR_FLATPAK_LAUNCH_RUNTIME_COMMIT
CREATOR_FLATPAK_LAUNCH_ECHO_SHA256
CREATOR_FLATPAK_LAUNCH_FLATPAK_SHA256
```

Use `cargo build --locked --offline --release --bin creator-hub-flatpak-host-launch`
with this manifest and the owned target dir after setting those values. Do not
rebuild/repackage the already pinned echo during this host-only build. Missing,
non-lowercase, wrong-length or all-zero pins refuse before native preparation.
Runtime also requires `CREATOR_FLATPAK_LAUNCH_PROOF=1`, actual GitHub-hosted job
flags/repository and RUNNER_TEMP. These are disposable-execution guards, NOT
caller authentication. Run only the built native launcher with
`prove-installed`, collecting its stdout, exit status and the parent's independent
source/deployment evidence. All child environment values are fixed from this
owned fixture; no live desktop/session bus is inherited.

Negative gates before any reader exposure: wrong commit/hash or mount, native
or foreign writer, sender/instance drift, unsupported inspection/kernel, early
exit, malformed/truncated traffic and failed normal cleanup must refuse. The
current source contains no signature verifier, immutable user-owned deployment
guarantee, full runtime-extension attestation, actual Hub caller adapter, host
reader invocation, migration, settings/project/Unity access or user consent.
Even a successful second checkpoint does not complete those gates.

## Verification Recorded Here

`node --test scripts/flatpak-host-launch.test.cjs`: six source-only checks pass.
Rustfmt parsing/formatting passes. Rust compilation, Clippy, all Linux syscall
tests and the installed-Flatpak checkpoint remain NOT RUN pending parent
coordination. No native mechanism pass or release acceptance is claimed.

Primary contracts: [Flatpak foreground FD preservation](https://github.com/flatpak/flatpak/blob/a02d0ba48abe9aacc377de15699e5d8c024b5669/common/flatpak-run.c#L4055),
[upstream passthrough test](https://github.com/flatpak/flatpak/blob/a02d0ba48abe9aacc377de15699e5d8c024b5669/tests/test-run.sh#L98),
[per-message Linux credentials/pidfds](https://github.com/torvalds/linux/blob/v6.6/include/net/scm.h#L124),
[credentials validation](https://github.com/torvalds/linux/blob/v6.6/net/core/scm.c#L45),
[procfs access limitations](https://man7.org/linux/man-pages/man5/proc_pid_root.5.html).
