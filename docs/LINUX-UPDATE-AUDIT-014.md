# Linux Update Audit Checkpoint

2026-10-15. No full Linux in-app update has been accepted. The later standalone
mechanism test below is separate from signed update/authentication/restart.
Windows' scoped installer tests are separate. Mac work remains suspended.

## Sealed Input Implementation Checkpoint

Disposable [run 38653560191](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38653560191)
at `1e38681` passes the actual `pkexec` to `dpkg --install /proc/self/fd/0`
handoff. The generated 622-byte test package remains exact with all four kernel
seals; write, shrink and growth attempts refuse. Its original pathname is removed
before privilege; installed package/version/content match. Original compact result
is retained locally under `artifacts/linux-sealed-update-38653560191`.

This uses a temporary, explicitly permissive action **only on a disposable runner**,
removed in `finally`; it is never production policy. Actual user authentication,
native Cancel, signed catalog/update, view restoration and restart remain false.

Original failed runs are preserved: `38652808744` assumed a JavaScript rule
backend absent from Ubuntu 22.04's polkit 0.105; `38653046783` required exit0
although the 0.105 `pkaction` source retains exit1 after successful output;
`38653403405` captured two additional empty metadata lines. The corrected readiness
check binds that exact native output, known version and empty stderr. It does not
broaden the executable, package target or authentication authority.

New production source `src-tauri/src/linux_update.rs` is a separate **unaccepted
integration**: verified DEB bytes go to a sealed inherited descriptor; fixed,
root-protected system tools get one system-agent attempt, with no in-app password
collection or sudo/terminal fallback. Exit126 returns cancellation without restart;
127 and uncertain/nonzero outcomes return actionable errors without automatic repair.
Unsupported formats or missing tools refuse before confirmation or view closure.
RPM, AppImage and Flatpak automatic updates are not established by this DEB work.

The actual Root source is compiled independently through
`native/linux-update-check`, avoiding a full GUI build for kernel/command tests.
Portable tests and native-target strict Clippy pass, three integration/source
regressions pass, and Windows Root tests pass (358, with 13 opt-in tests ignored).
[Run 38654369500](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38654369500)
at `76ed726` then executes all four tests of this actual Rust source on Linux,
passes strict native Clippy and three source-integration regressions, and repeats
the real Python `pkexec`/`dpkg` fixture successfully. Native authentication Cancel,
the packaged Rust installation entry point and exact signed Hub install/restart
remain pending; this composition does not substitute for those gates. No user-PC
app or settings were changed.

## Original Dependency Audit

- Correct as-is: `self_update.rs` checks the signed descriptor, downloaded bytes,
  separate installer signature, exact package target and installed/restart path
  before calling installation. Flatpak refuses the native installer, and an
  unbound AppImage refuses replacement. Those refusals must not be bypassed.
- Confirmed source behavior: the locked `tauri-plugin-updater` is 2.11.0.
  Its Linux DEB/RPM installer writes the verified buffer into a temporary file,
  then hands that pathname to the privileged package tool. A failed/nonzero
  `pkexec` result falls through to graphical password collection and terminal
  sudo, without a separate user-cancellation branch.
- Likely wrong for the intended Cancel contract, not yet natively captured:
  dismissing the system authentication prompt could cause another prompt rather
  than stop. The first Hub confirmation's cancellation is a different boundary.
- Unknown / needs capture: binding the privileged package input to the verified
  bytes throughout authentication, actual second-prompt cancellation, competing
  package changes and retained views/settings after an installation failure.
  This is not a demonstrated exploit or proof of data loss.

The exact dependency source was inspected locally and checked against the
[pinned upstream implementation](https://github.com/tauri-apps/plugins-workspace/blob/updater-v2.11.0/plugins/updater/src/updater.rs).
Relevant functions: `install_deb`, `install_rpm`, `try_tmp_locations` and
`try_install_with_privileges`. No dependency or product installer was changed
merely on the basis of this source audit.

## Required Native Check

Use a disposable runner and the actual signed package/update path, never real
user credentials or projects. Capture package identity/hash, source, exact
before/after settings, owned backend lifetimes and normal restart/reconnect.

1. Cancel Hub's own confirmation; nothing is downloaded, closed or installed.
2. Approve Hub, then dismiss system authentication. Require no package change,
   no fallback password collection and an actionable retained-state result.
3. Exercise an unavailable authentication agent/tool and failed package-manager
   command. Refuse cleanly; do not collect/log passwords or force-close tools.
4. Prove the installed bytes match the approved signed artifact, including a
   negative changed-input test at the privilege boundary, before approving the
   installer path. An early buffer hash alone is not that proof.
5. Test approved install, automatic restart, exact version/executable hash,
   settings, embedded views and both old/fresh MCP connections.

A sealed-descriptor DEB handoff is now implemented and scoped separately above,
but is not full signed-update acceptance. A fixed trusted helper remains an
alternative, not an accepted replacement merely because its source exists.
The existing Linux retirement helper prerequisite is a different operation and
does not prove this update flow. Publication remains held.
