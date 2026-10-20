# Linux Release Status

2026-10-18. Linux and Flatpak remain **unpublished development work**. The
published Windows 0.1.14 artifacts and local Windows installations are unchanged.
Mac support remains suspended. No TEST ONLY package is a release candidate.

## Current Direct Integration Checkpoint

These newer results supersede only the corresponding historical tests below;
they do not qualify a public Linux release.

- Integrated Root assembly [39134487363](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/39134487363)
  uses product source `5065fb1112b9e96978e40e64503fa979f559baae`.
  Its DEB SHA256 is
  `8f9ff4b4694d00150bf86f7a5befc6a1cfc80610d55212b717d602ceb84fe86c`.
  MCP and Setup are first-party pages backed by internal Rust libraries, not
  iframes or launched companion GUIs. Existing Windows builds remain unchanged.
- Actual installed pages, notice acknowledgement, saved preferences, normal
  close and manual reopen passed on those bytes in
  [39135547995](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/39135547995).
  Configuration migration, exact backups, preserved foreign entries, signed
  routing and fresh reopen passed in
  [39138256641](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/39138256641).
  The latter also exercised the actual router, sealed Node and MCP SDK stdio
  initialize/tools-list/EOF flow without tool calls or termination signals.
  It did not install or retire old standalone DEBs or run an AI application.
- The integrated signed update target is built and independently verified, but
  actual system cancellation, authorized installation and automatic restart are
  still unaccepted. Target 0.1.15 remains private acceptance-only test input.
- Flatpak's native-window launcher has built and installed on disposable Ubuntu.
  Run [39138975316](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/39138975316)
  verified the launcher process/window but stopped before any disclosure action:
  its AT-SPI application PID did not match the test's bound launcher namespace
  PIDs. Cancel, warm/cold activation and signed update remain unaccepted. This
  is not evidence of a product activation failure or SteamOS support.
- Read-only inspection and an isolated loader test on actual Steam Deck OLED
  hardware running SteamOS 3.8.16 confirmed that the integrated native ELF needs
  `libwebkit2gtk-4.1.so.0` and `libjavascriptcoregtk-4.1.so.0`, which are absent
  from that host. The exact private version-only 0.1.15 test ELF exited 127
  before starting Hub. The current DEB-host Flatpak launcher cannot supply
  those libraries. A self-contained SteamOS host package and its install/update
  path are unfinished implementation work, not a test that already passed.
- That Deck's existing desktop shortcut still selects 0.1.8; its downloaded
  0.1.12 AppImage is mode 0644. The old log contains the optional GTK module
  messages, but no captured EGL failure. No old shortcut, downloaded image,
  real settings, package installation or GPU setting was changed. Do not infer
  an EGL fix or failure from the dependency test.

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
  helper/policy binaries. The actual catalog/target/minisign source also verified
  the local descriptor, installer signature, package/ELF hashes and three tamper
  controls in an offline cross-platform verifier. That is not Linux native
  installation, discovery or restart acceptance. All 0.1.15
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
- Actual installed Hub signed15 discovery and native confirmation capture passed
  [39109115768](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/39109115768).
  The normal check fetched the signed descriptor/signature and target package,
  and the real GTK confirmation displayed the expected question and buttons.
  It stopped before confirmation input; installed14 was unchanged. This is a
  disposable TLS lab result, not public discovery, installation, authentication,
  restart or restored-view acceptance. See the
  [scoped receipt](evidence/linux-signed-discovery-39109115768.json).
- Native Hub-level `Not now` cancellation then passed
  [39109603217](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/39109603217).
  Exactly one source-bound GTK cancellation dismissed the dialog; the same Root
  stayed live, updater controls became actionable again, package/image14 and
  saved acknowledgement stayed unchanged, and normal close exited0. No installer
  manifest or system authorization was requested. This fixture had no open
  module views; system Cancel, successful installation, restart and view
  restoration remain separate gates. See its
  [scoped receipt](evidence/linux-update-confirmation-cancel-39109603217.json).
- Native [39042096460](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/39042096460)
  passed Flatpak transport Clippy, real kernel credentials/pidfds and the actual
  inherited-FD echo-child lifecycle. This did not launch an installed Flatpak,
  expose the host reader or implement Hub/Unity/project operations. Its scoped
  [result](evidence/flatpak-host-transport-39042096460.json) keeps integration,
  migration, signed update and release gates false.
- The installed synthetic Flatpak exchange then passed in
  [39107022380](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/39107022380):
  exact app/runtime/image pins, inherited authenticated FD exchange, owned normal
  exit/reap and unchanged isolated settings. The fixture is unsigned and exposes
  no host reader or settings/project API. See the [scoped receipt](evidence/flatpak-installed-transport-39107022380.json).
  Failure39106656388 had captured the actual harmless `extra-args` value
  `--usb-list=;--usb-list=;`. Flatpak1.18.4 serializes both empty USB lists
  unconditionally in its context writer. Only that exact form is admitted;
  nonempty USB queries, other args and replacement app/runtime paths still refuse.

## Remaining Release Gates

2026-10-18 audit: helper source6073b93 has no post-authentication GUI-presence
check before `transaction-attempted` and dpkg. Root's last check occurs before
pkexec. This was a confirmed missing guard, not demonstrated corruption.
Helper correctione711ef5 now pins and hashes the protected fixed GUI, acquires a
non-truncating/non-writing writer descriptor, verifies the same file identity,
and holds it across the complete transaction before marking any attempt. Linux
write-open/exec exclusion covers normal execution of that exact inode, not
copied/replacement images or explicit loader execution. Owned WSL kernel tests
passed busy-open, held-exec refusal, rename/unlink compatibility, unchanged bytes
and modes, and execution after close; this is not dpkg or Hub authentication
acceptance. Native helper fixtures and actual dpkg-under-guard qualification
remain pending. The default production removal refusal is unchanged.

Native component run39108555106 at test sourceb3e5b73 retained successful
terms, permission decline/retry/approval and normal Root exit. It still stopped
before module operations on semantic Parent containment. The corrected WM-frame
diagnostic matched the real decorated frame exactly, but its hit-test path did
not reach the remote WebKit control. Neither diagnostic authorizes input or
establishes component acceptance. The pinned GTK/WebKit source contract must
resolve this harness mismatch before another operation attempt.

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

Current-package run39106806681 reached the same read-only diagnostic with exact
source button/heading matches. It then refused a geometry assumption: the native
client was `[171,130,940,580]`, while GTK's AX frame was `[170,110,942,605]`.
The existing X11 helper already provides the EWMH-decorated frame rectangle;
read-only comparison is being corrected to that contract, not a guessed offset.
Strict semantic-Parent and action authority still refuse. Normal Root close and
exit0 passed; component operation, migration and updater acceptance remain false.

Runs39106116170/39106292475 also exposed the hosted image's world-writable policy
ancestry. The [primary image provisioning](https://github.com/actions/runner-images/blob/main/images/ubuntu/scripts/build/configure-system.sh)
recursively changes `/usr/share` to0777. The disposable current-component workflow
now secures only `/usr/share`, `/usr/share/polkit-1` and its `actions` directory to
0755, after exact root-owner/type/path checks and with retained before/after
identity records. No recursive chmod, application repair, authentication-policy
override or production ownership-check relaxation was added.
