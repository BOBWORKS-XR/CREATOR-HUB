# Linux Release Status

2026-10-18. Linux and Flatpak remain **unpublished development work**. The
published Windows 0.1.14 artifacts and local Windows installations are unchanged.
Mac support remains suspended. No TEST ONLY package is a release candidate.

## Implemented Boundaries

- Root has a nondefault `experimental-linux-migration` route for the exact MCP
  2.7.7 and Setup 0.3.7 DEBs. It checks backed-up settings, signed routing, known client GUI
  dependencies and idle GUI state, makes one native/polkit authorization attempt,
  then independently verifies retained package state. Independent per-product records keep
  unknown outcomes pending; recognized retained-package completion can be reviewed
  without replaying dpkg. The default production removal refusal is unchanged.
- Linux source integration and owned native fixtures passed
  [38754211437](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38754211437):
  all-target Root check, 138 migration/dependency tests, ten helper-client tests,
  22 standalone client/stubbed coordinator tests,
  default/experimental helper fixtures, 15 native filesystem reader tests and
  four sealed-updater kernel tests. See the
  [scoped receipt](evidence/linux-migration-preflight-38754211437.json).
- The finite helper also implements fixed Setup 0.3.7 inspection and experimental
  scriptless tombstone preparation/retirement, with its own protected attempt
  marker. Second-app cancellation preserves the first pending review. No package
  transaction is replayed from a journal. Full native Root retirement is not accepted.
- Exact MCP plus Setup package transactions passed in disposable native run
  [38755581264](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38755581264).
  The same live MCP PID and 53 tools survived both, both Node aliases reconnected,
  nine runtime files and eight settings sentinels stayed byte-identical, and both
  negative repeats preserved their recovery state. This is a sudo mechanism
  experiment, not Hub approval/authentication or full migration acceptance.
  See its [scoped receipt](evidence/linux-deb-helper-mechanism-38755581264.json).
- `native/flatpak-host-reader` implements bounded native-current-user observations
  and a metadata-only local diagnostic. It is not a sandbox-facing broker, writer
  or caller authenticator. See [its contract](../scripts/flatpak-host-reader.md).
- The signed Linux updater source seals verified DEB bytes for the system package
  installer. Source/kernel mechanism tests are not authentication/update/restart
  acceptance. RPM and AppImage automatic installation still refuse; Flatpak must
  use its own authenticated update origin, not native dpkg inside its sandbox.
- Current private Linux source `f66d37f` passed producer
  [39041386789](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/39041386789).
  Its original ZIP, API provenance and native payload were verified, then a new
  signed handoff was created without including a key. The helper-bearing DEB
  assembly is [39042071452](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/39042071452),
  dispatched at `6fc73d1` with explicit acceptance-only packaging. Its Root and
  helper tests passed, but nine-file ZIP staging refused the Windows wrapper's
  raw backslash names before package compilation. Signed payload bytes were not
  changed. The canonical packer now tests raw names on Windows too, and staging
  runs before dependency installation. Corrected assembly
  [39042746816](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/39042746816)
  at `534465a` passed the complete helper-bearing DEB build and archive audit.
  It is a frozen acceptance-only package, not a public installer qualification.
- Actual fresh installation and manual public 0.1.12 -> current 0.1.14 replacement both
  passed in [39105776879](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/39105776879).
  The exact installed Hub/helper/policy bytes, root ownership/modes, dpkg state
  and clean `dpkg --verify` were checked. Synthetic settings, client configs,
  retained runtime, backup and project fixtures were unchanged. No app or AI
  client was launched; this does not establish migration, consent, system
  authentication or in-app updating. See the [scoped receipt](evidence/linux-installed-candidate-39105776879.json).
- An outer-only Linux 0.1.15 target passed native build/package verification in
  [39105404389](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/39105404389).
  It uses product source `534465a`, changes only four Root version fields and
  signed runtime metadata, and retains the exact compiled MCP/Setup/router and
  helper/policy binaries. The local signed update descriptor is verified; the
  installer signature still requires the actual-source input verifier. All 0.1.15
  bytes are acceptance-only and must never be published. This creates an update
  target, not an update/restart acceptance result. The earlier private-draft read
  failure [39105308246](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/39105308246)
  occurred before compilation; draft-read capability is now isolated from the
  read-only native builder.
- Linux-only test packaging now adds the fixed retirement helper and one
  fixed-path polkit action requiring uncached `auth_admin` in all contexts.
  It does not use `argv1`, which polkit 0.105 does not enforce. The helper still
  admits only finite commands. The default production refusal remains closed;
  Windows and Mac default build paths are unchanged. See the
  [acceptance recipe](../packaging/linux/RETIREMENT-ACCEPTANCE.md).
- Native [39042096460](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/39042096460)
  passed Flatpak transport Clippy, real kernel credentials/pidfds and the actual
  inherited-FD echo-child lifecycle. This did not launch an installed Flatpak,
  expose the host reader or implement Hub/Unity/project operations. Its scoped
  [result](evidence/flatpak-host-transport-39042096460.json) keeps integration,
  migration, signed update and release gates false.

## Remaining Release Gates

1. Qualify the production helper after the acceptance-only package and installation
   checks, and test actual GUI-close/reopen
   races, system lock contention,
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

## Latest Native Failure Evidence

Run 38754063155 directly reproduced the old `HOME=/root` dpkg warning under
fixture UID 1001 and passed the corrected HOME-unset audit. Setup absence and
original-package inspection subsequently passed. No user configuration is loaded
by these fixed system-tool commands.

Run 38754932346 captured the later Setup postcheck failure: dpkg reported its
notice missing under `/usr/share/doc`, and the unchanged distribution config
explicitly excluded that optional documentation tree. The required marker was
moved to `/usr/share/creator-project-setup`; no system policy override, retry or
repair was applied to the failed transaction. Fresh disposable native run
38755581264 subsequently qualified the new destination with unchanged distro
exclusions and clean dpkg verification. No application installer was built.

Read-only UI capture 38754335602 narrowed the original three missing-parent
edges: a role-49 scroll pane enumerated by an `iframe` group, plus two role-33
menu objects. It queried only already-collected endpoints and issued no input
after refusal. This is not Page-ownership or operation acceptance. No further
unchanged action retry is justified by that capture alone.

Native 38767944392 verified normal Root EWMH close and parent-observed exit 0
without using a DOM walk for closing the exact owned native frame. Component
operation still refused the same semantic Parent mismatch. Read-only run
39041753996 found the exact fixed button but no matching HEADING-role context,
so its independent frame-hit diagnostic stopped before geometry or input.
The retained screenshot visibly contains the expected heading. This is a harness
provenance/context issue still needing evidence, not a passed component operation
or a reason to weaken the existing action ownership rules. See the separate
[full updater prerequisites](LINUX-NATIVE-UPDATER-PLAN.md); a verifier and source
tests are not an implemented full-flow updater test.

Read-only run 39042527460 subsequently found the exact source heading ID/name on
an h2 object with numeric role 82, and the fixed button ID on role 43; all 31
known-object metadata reads completed without errors. That distinguishes a role
contract mismatch from missing UI. No control action or frame-hit proof followed.
