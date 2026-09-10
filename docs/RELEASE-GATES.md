# Coordinated Release Gates

Requested 2026-09-10: Creator Hub, Creator Works MCP and Creator Project Setup.
The user approved the public Hub repository and test-branch pushes. Public
installers and release tags still require the relevant acceptance gates and
recorded package evidence. A preview must not be advertised as
completed adoption. Runtime acceptance is distinct from source/unit tests.

## Status

2026-09-10 scope update: the coordinated alpha.3 installer is being prepared
on GitHub for prerelease testing. It has no embedded app payloads or adoption claims.
Exact reviewed app builds can open inside Hub after native consent; standalone
opening remains available. Unknown/multiple copies need explicit selection, and
the known-broken MCP 2.6.0 installer is denied by hash. This does not complete the
full embedded/adoption release gates below. Native installation/upgrade and GUI
startup acceptance is now part of the Windows candidate workflow. A completed
build alone does not pass that gate. Hub self-update handoff remains separate.

Current release flow and supported channel choices are in
[Prerelease Testing](PRERELEASE-TESTING.md). The final workflow runs both clean
installation and real older-version upgrades through Hub, followed by both native
hosted apps. Project Setup's notice-complete candidate34527681202 and installed
upgrade34528338440 passed. MCP's notice-complete candidate34527053871 and general
CI34527053003 passed, including an exact extracted-EXE metadata smoke with no
configuration changes. Neither result alone proves the final Hub integration.

The new updater passed local source, signature-contract and interface review.
Review found a missing plugin configuration and premature cleanup before a
failed installer launch; both were corrected. The configuration regression test
uses the actual generated Tauri context. Do not infer signed self-update or
restart acceptance from that test. Public Hub update assets are not yet published.

MCP test-branch run 34521776854 passed its disposable Windows 2.6.0 to
2.7.0-alpha.1 upgrade: active private-runtime refusal in ordinary and /UPDATE
modes, successful update after cooperative exit, extracted payload hashes,
opaque settings/unmanaged-file preservation and busy-uninstall refusal.
This does not prove all historical migrations or first writable GUI use.
General MCP CI run 34521779687 also passed Windows/macOS/Linux launcher checks
and Node 20/22/24 server checks; this is not native installer acceptance on macOS/Linux.

See [installation/upgrade matrix](INSTALL-UPGRADE-MATRIX.md) for the full public
baseline inventory and untested scenarios, and [local user test](LOCAL-USER-TEST.md)
for a non-installing preview test. The current 2.6.0 -> 2.7.0-alpha.1 check is not broad
historical upgrade coverage. Setup 0.2.2 is already public and remains a baseline.

| Gate | Status | Evidence / remaining work |
| --- | --- | --- |
| Hub Projects page | Native listing and guard checks passed | hosted-native-1789060313732: 62 known / 36 SDK locations, filters/search retained, unknown-ID launch rejected; valid Editor launch and native add/remove acceptance still pending |
| MCP installer path-with-spaces defect | Confirmed broken; 2.6.1 candidate built | Final packaged `-File` guard: 199 Node, 23 Rust and 24 WinPS checks plus native no-install harness pass; actual installed upgrade and interactive old-uninstaller/Retry acceptance remain separate gates |
| Setup real creation and reopen validation | Passed on prior Setup-first pair | Native report hosted-native-1789053314825; repeat against final artifacts |
| Setup inspection, backup, repair and stale-plan protection | Real repair and second validation passed | Disposable CreatorSetupRepair-ReleaseGate-20260910-1; preserved scene/custom content/custom VS selections, backup retained, 31,904 VS nodes/172 Creator nodes; hosted final-pair repetition pending |
| Setup early old-uninstaller guard | Native A/B passed; installer rebuilt | Baseline reached legacy page while app ran; new MUI GUI-init check refused with exit 10 before the page; fixture and existing processes survived. No production installer executed |
| MCP read-only hosting | Passed, including optional lifecycle events and legacy initialization | Native reports hosted-native-1789058480012 and hosted-native-1789058550242; actual config metadata/hashes unchanged, no mutation authority |
| Full MCP hosted operations | Writable candidate implemented; native acceptance pending | Existing handlers, exact payload pins, per-session consent, GUI ownership, workflow guard and local unknown-outcome records; 44 browser tests passed, final Projects alignment reran 7 tests; no installed replacement |
| Both native app backends together | Waiting for earlier Setup session to close | Duplicate Setup refusal passed in hosted-native-1789054989770 |
| Single Hub window and safe launch routing | Warm and cold Windows acceptance passed | hosted-native-1789055985436 plus launch-burst-1789056244398: three rounds of four concurrent cold launches, exactly one instance each; fixed view IDs only, invalid args rejected |
| Verified installed-app discovery and downloads | Implemented; final release regression pending | Hash/signature, cancellation, process and filesystem guards |
| Update-and-adopt consent, state preservation and standalone fallback | Incomplete | No silent absorption, no copied settings, no shortcut changes on failed/declined adoption |
| Final installer execution/upgrade acceptance | Pending | Existing clients, locked runtime, cancel/retry, no destructive partial upgrade; isolated environment only |
| Historical BANTWORKS/MSI migration | Confirmed code gaps, not just unrun tests | Legacy GUI-name guard corrected in source; product identity migration and MSI discovered-source preflight remain incomplete; see installation matrix |
| Offline startup, failure recovery and Hub removal | Pending | Retain usable standalone apps and unknown-operation outcomes |
| Versions, README, licenses, hashes and signed catalog descriptors | Pending final binaries | Do not sign a descriptor for an unverified extracted executable |
| macOS/Linux native support | Unverified | Do not label Windows testing as cross-platform acceptance |

Earlier baseline checkpoint: Hub 37 browser tests and 27 Rust tests passed;
Setup 32 browser tests, 33 Rust tests and two real-EXE metadata tests passed.
Both pass strict Clippy. Opt-in live tests are not represented as ordinary unit
coverage. Native reports and exact candidate hashes are in the local development
handoff; tests must be repeated where later code changes affect their coverage.

The installer hotfix has now been forward-ported into the MCP feature branch.
The notice-complete artifact must repeat installed acceptance before publishing.
Passing hosted UI tests does not validate its installer or retroactively update
the public 2.6.0 package. Current local Hub regression:40 Rust tests plus57 browser
tests pass, with four explicit live Rust tests excluded from that count.

The current upgrade CI sentinel proves opaque-file preservation, not valid
launcher settings or first GUI load. Valid historical configs and fake client
profiles, including alternate homes/custom managed fields, remain required.

This machine has no Windows Sandbox. User-approved test-only GitHub branches
now run clean Windows installed-upgrade acceptance on disposable hosted runners.
The first installer fixture printed ready but exited before the guard ran;
this was not evidence that the installer killed it. Explicit keepalive fixtures
now have cooperative stop signals, exit diagnostics and prelaunch survival checks.
Silent NSIS acceptance does not prove the interactive uninstall-selection page
or Retry dialog. Keep those gates distinct. The older user-owned hosted Setup
session must be closed normally before the simultaneous-backend native trial.

## Publication Order

1. Test the MCP stable installer hotfix independently; do not bundle experimental
   Hub changes into that recovery release.
2. Finish and test the app/Hub compatibility contract together, including normal
   standalone use. Preserve the stable releases as rollback/reference artifacts.
3. Build and test the exact candidates, record hashes and limitations, then
   prepare matching app release descriptors and Hub catalog compatibility.
4. Review the staged diffs/docs for private paths, feedback, secrets and artifacts.
5. Push reviewed commits/tags and publish only tested artifacts. Verify downloads
   against recorded hashes after publication. If any core gate remains failed,
   hold the affected release and report the concrete blocker.

## Protected State

Do not force-close Unity, Unity Hub, AI clients, MCP stdio processes or unrelated
Creator windows. Never install a test build over the user's live installation.
Use E:\UnityTest for fresh disposable project fixtures; existing projects and
their manual content are not release-test fixtures without explicit selection.
Keep screenshots, machine-specific reports and private feedback out of git.
