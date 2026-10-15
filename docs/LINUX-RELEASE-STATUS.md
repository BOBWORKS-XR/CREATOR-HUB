# Linux Release Status

2026-10-15. Linux and Flatpak remain **unpublished development work**. The
published Windows 0.1.14 artifacts and local Windows installations are unchanged.
Mac support remains suspended. No TEST ONLY package is a release candidate.

## Implemented Boundaries

- Root has a nondefault `experimental-linux-migration` route for the exact MCP
  2.7.7 DEB. It checks backed-up settings, signed routing, known client GUI
  dependencies and idle GUI state, makes one native/polkit authorization attempt,
  then independently verifies the retained runtime. A write-ahead record keeps
  unknown outcomes pending; recognized retained-package completion can be reviewed
  without replaying dpkg. The default production removal refusal is unchanged.
- Linux source integration and owned native fixtures passed
  [38750164868](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38750164868):
  all-target Root check, 138 migration/dependency tests, six helper-client tests,
  default/experimental helper fixtures, 15 native filesystem reader tests and
  four sealed-updater kernel tests. See the
  [scoped receipt](evidence/linux-migration-preflight-38750164868.json).
- The finite helper also implements fixed Setup 0.3.7 inspection and experimental
  scriptless tombstone preparation/retirement, with its own protected attempt
  marker. Root's Setup retirement route and installed transaction are not accepted.
- `native/flatpak-host-reader` implements bounded native-current-user observations
  and a metadata-only local diagnostic. It is not a sandbox-facing broker, writer
  or caller authenticator. See [its contract](../scripts/flatpak-host-reader.md).
- The signed Linux updater source seals verified DEB bytes for the system package
  installer. Source/kernel mechanism tests are not authentication/update/restart
  acceptance. RPM and AppImage automatic installation still refuse; Flatpak must
  use its own authenticated update origin, not native dpkg inside its sandbox.

## Remaining Release Gates

1. Install/package the reviewed production helper, complete Setup coordinator
   integration, and test actual GUI-close/reopen races, system lock contention,
   cancellation, interruption and recovery. A pre-authentication idle check is
   not proof against a GUI reopened while authentication is pending.
2. Exercise actual Hub migration with exact old packages, synthetic settings,
   byte-verified backups, live MCP connections and reconnects, preserving unknown
   settings and unrelated processes. The earlier isolated MCP mechanism pass does
   not qualify the new helper, Setup or Root's complete migration.
3. Test the actual signed Hub update, native approval/authentication/Cancel,
   installation, automatic restart, owned view restoration and preservation on
   a current-source package. Do not rebuild an app for harness-only changes.
4. Implement Flatpak's authenticated native host connection and project/Unity
   operations, then test install/update/rollback/uninstall with exact host and
   sandbox state. The reader's observations never authorize migration writes;
   writers need their own full byte before-images and transaction ownership.
5. Resolve the native UI test's Page/window provenance policy before another
   operation-acceptance run. Captured semantic Parent mismatches are not evidence
   that a global cache, role, timing or renderer workaround is correct.
6. Choose and qualify the Linux publication version/assets without replacing
   Windows 0.1.14 bytes or metadata. Repeat the old-client release-feed guard.

## Existing Users And Startup Reports

Published Hub 0.1.12 commit `35a16a45814d821d65b5d203628478449174cd55`
explicitly refuses non-Windows in-app updates in `self_update.rs:72-75`.
Linux therefore needs a one-time manual installer migration; acceptance must
separately cover that path and the new outgoing signed updater. A new server
feed cannot remove the old binary's native refusal.

The EGL and GTK module reports are investigated in
[Linux startup diagnostics](LINUX-STARTUP-DIAGNOSTICS.md). WebKit's default EGL
display failure is fatal; the GTK module-load message is normally nonfatal.
Neither was reproduced in the retained native captures. The reporter's exact
build, distribution, full output and window behavior remain unknown. The reporter
subsequently identified it only as an older build that may already be corrected;
it is not a confirmed current-build defect. No new GPU,
preload, driver, sandbox or global GTK-module override was added.
