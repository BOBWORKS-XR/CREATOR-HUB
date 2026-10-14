# Linux Update Audit Checkpoint

2026-10-15. Source audit only; no Linux in-app update has been accepted by this
check. Windows' scoped installer tests are separate. Mac work remains suspended.

## Evidence

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

A sealed-descriptor handoff or a fixed trusted helper are possible designs,
not accepted implementations. Investigate the actual OS/tool contracts before
choosing either; do not replace one unproven authority boundary with another.
The existing Linux retirement helper prerequisite is a different operation and
does not prove this update flow. Publication remains held.
