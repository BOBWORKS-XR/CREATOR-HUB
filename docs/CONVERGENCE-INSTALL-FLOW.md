# Unified Installation Flow

Work in progress for Hub 0.1.14. The Windows coordinator now invokes the tested
GUI-retirement leaf, but full packaged coordinator acceptance is still pending.
This is not release evidence.

Hub takes over the existing Creator settings files in their established OS data
locations. It does not need to move Unity projects or create a second copy of
settings that can drift. Standalone executable resources and app registrations
are separate from those persistent data files.

The first-launch guide runs after Hub's terms and preferences, before normal
navigation, automatic view restoration and background update checks. Fresh
installs without prior Creator data or standalone applications skip it.

1. Inspect only source-established Creator settings and known app locations.
2. Ask for native approval and keep exact, verified, deduplicated before-images.
3. Refuse conflicting settings, changed files and unresolved operation outcomes.
4. Open the verified private MCP backend, preserving exclusive settings ownership.
5. Review existing supported client routes through the existing native, journaled
   migration APIs. Never replace custom/foreign entries silently.
6. Verify signed managed-router activation and retained runtime resources.
7. After another native approval, retire source-bound standalone GUI files,
   default shortcuts and installed-app entries. Keep all data and old MCP
   Node/server resources at their original paths for existing connections.

Steps 1-6 have source implementation and unit coverage. The reviewed MCP server
path transition now retains exact before-images and changes only that field,
without manufacturing defaults or losing unknown fields. The recognized
previous payload is currently the exact published Windows MCP 2.7.7 server;
custom paths and other unverified versions/platform payloads are refused.

Windows removal has a production adapter for the exact accepted MCP 2.7.7 and
Setup 0.3.7 installations. It validates registration, every installed payload,
uninstaller identity, ordinary paths and normal process exit. Extra/changed files
and custom installs refuse; there is no recursive cleanup or forced process stop.
The guide invokes the separate GUI-retirement operation, not the destructive
whole-directory uninstaller. A distinct negative dependency snapshot checks the
exact native-derived GUI/uninstaller/default-shortcut files and known client
configs. All concrete blockers and changed settings/environment refuse. Unknown
project/profile/managed/plugin/launch contexts remain explicit and require native
approval of custom-GUI integration risk; they still refuse full runtime deletion.
The guide cannot infer completeness from registration, absence or migration count.

Before backups, approval permits verified idle GUI windows to close normally.
Busy or unverified windows are not force-closed. Node and AI-client connections
are not stopped. If normal close saves changed settings, Check again restarts a
fresh review; it cannot bypass uncertain workflow/backend recovery.

Startup examines before-images even when the original GUI is already archived.
An unfinished journal requires fresh backups and connection review, never replay
of persisted paths or authority. Unknown receipts refuse. Partial cleanup returns
an honest pending report rather than a stale untouched-installation label. Only
verified completion of every current native plan enables the completion screen.
A review/completion record is not live-client acceptance or publisher signing.

## Removal Checks

`configured`, app registration names, ownership markers and a batch migration
result of `unchanged/count:0` are not safe-removal proofs. A renamed entry, a
project-local client scope, alternate configuration file or preserved environment
override can still depend on files in an old installation.

Only native independently derived targets may be considered. A frontend or
saved JSON record must not select an uninstaller or authorize deletion. Unknown
versions, changed binaries, busy apps, unresolved configuration scopes, failed
retention checks and cancelled approvals keep the old installation intact.
Do not force-close AI clients, Unity or unrelated Node processes.

## Tests And Boundaries

- Root's focused convergence/store tests pass on Windows. They verify bounded
  inputs, exact backups, changed-source and conflict refusal, unknown recovery,
  retry safety and the distinction between review and removal authorization.
- The isolated guide tests verify no mutation on load, capability gating,
  cancellation, retry, duplicate-click refusal, escaped text and explicit phases.
- Full native first launch, signed update/restart, actual AI-client reconnect,
  macOS/Linux cleanup and end-to-end uninstall retention are still required.

Current Windows source checks: 349 Root Rust tests pass with 13 explicitly
opt-in native tests ignored; strict Clippy passes. Dependency inspection is
connected to a distinct negative gate, not itself removal authorization. The 18
browser convergence/startup tests pass, including screenshots at 390 and 1100
pixels. The guide has 26 isolated controller regressions for explicit cleanup,
native readiness, cancellation, partial reports, refresh and duplicate refusal.
MCP has 253 passing Rust tests with seven opt-in tests ignored, including the
reviewed server-path transition, exact backups and retained recovery scopes.
Linux-native operation is not inferred from those Windows-hosted tests.

The native Windows compatibility-retirement leaf passes both official baselines
in run 38572696237: GUI/registration removal, all eight retained stores, all nine
in-place MCP resources, interrupted retry and old stdio survival/reconnection.
See NATIVE-LEGACY-GUI-RETIREMENT.md. Source integration now invokes this leaf;
the earlier native run did not exercise the new production coordinator. Fresh
packaged first-launch and signed update convergence acceptance remain required.

Published releases and the user's installed applications remain unchanged.

## Actual Coordinator Checkpoint (2026-10-14)

Run 38604727650 passes the real Windows first-launch guide using the immutable
ce62e9d candidate, installed over exact public Hub 0.1.12, MCP 2.7.7 and Setup
0.3.7 baselines. Native backup and GUI-retirement cancellation then approval,
three-client reviewed routing, product server-field preservation, both GUI/app
registration retirement, all nine original runtime files, an existing live MCP
connection and reconnect through old and signed-router paths pass. After the
observed startup update check completes, normal Hub exit also passes.

The initial runs remain preserved: 38596125719 reached installed preservation
then refused a misnamed WebView policy folder; 38596730141 stopped at public
MCP installer exit10 (cause unknown, not proven busy); 38601824666 stopped before
install because a refusal test incorrectly assumed non-CI environment; and
38602694102 passed the migration steps but requested close during startup checks.
Harness corrections did not rebuild or change that candidate.

The current42a35d1 candidate includes independent backup freshness and pre-
adoption receipt checks from aa6f2a6/297177b. Run38608296824 passes its real guide,
including same-length backup and live-settings mutation refusal before routing.
Run38608917818 repeats the guide and separately passes fresh installed components.
Run38610890908 passes its signed Windows update from unmodified public0.1.12 via
a controlled feed, native cancellation, approved install and automatic restart.
Public discovery, outgoing hosted-view restoration, actual AI-app operation,
Mac/Linux migration and Flatpak remain separate. Publication remains held.
