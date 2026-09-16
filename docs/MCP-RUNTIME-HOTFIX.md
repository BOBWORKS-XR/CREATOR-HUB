# MCP Runtime Update Hotfix

2026-09-16. Coordinated hotfixes: Hub 0.1.3 and MCP 2.7.1. Installed user apps
are unchanged. Do not overwrite public Hub 0.1.2 or MCP 2.7.0 assets with these
different bytes. Final disposable installer acceptance passed for both apps.

## Evidence

- User reported many Node processes blocking MCP updates and manually closed them.
  No Node processes remained at the initial inspection, so the exact lifetime of
  those particular processes is unknown.
- Confirmed in MCP source and a failing child-process regression: stdin EOF
  during `wait_for_unity_compile` left the server alive. The SDK stdio transport
  does not handle EOF; the tool's pending polling timers keep the process alive.
- Idle EOF already exited correctly. Keeping a connected idle server alive is
  intentional, not an orphan detector.
- Existing Hub and installer guards blocked locked runtimes without a cleanup
  action. They remain fail-closed; no broad Node termination was introduced.

## Changes

- MCP `src/index.ts`: close the transport and exit on lost stdio or termination
  signals, with a bounded shutdown. Already submitted Unity work is not undone
  or resubmitted.
- Hub Apps row and MCP details: `Disconnect MCP for update`, backed by a native
  confirmation. Resolve the verified installed MCP; inspect only its exact
  private runtime paths. Hold and recheck OS process handles before stopping.
- Cancellation is a no-op. Unknown processes, AI apps, Unity and other Node
  installations are never termination targets. New connections that appear
  during confirmation are not included; a fresh check reports reconnection.
- MCP installer: interactive Yes explicitly stops the selected installation's
  private runtimes. No retries the existing read-only check; Cancel exits.
  Silent installation never invokes cleanup. Existing preinstall/uninstall
  guards run again and still refuse launchers, unknown paths and locked files.

## Verification

- MCP full Node suite: 250 passed, including Windows PowerShell process and file
  fixtures. The EOF regression failed before the source change and passed after.
- Standalone MCP bundle smoke passed; all three shutdown tests also passed
  against the built bundle, not only TypeScript output.
- Hub: 144 UI tests; 107 Rust tests, nine existing opt-in tests excluded;
  17 script tests; strict release Clippy passed.
- Native Windows test uses disposable copies of real Node: multiple runtimes,
  confirmation cancellation, stop/retry, no remaining runtime, newly reopened
  connection, unchanged executable bytes and an unrelated live Node process.
- Installer hook compiled using local NSIS. The fixture deliberately has no
  real installer/uninstaller payload. Its unused-uninstaller warning is expected.

## Scope and Remaining Limits

- The exact new installers passed disposable Windows acceptance, including old
  locked runtimes, native consent/cancellation, silent refusal and settings.
- Every AI client's automatic reconnection policy is not tested. If a client
  reconnects during confirmation, the new connection is not force-closed.
- Full in-app Hub self-update/restart remains untested; guarded installer upgrades
  and signed updater payload verification are separate checks.
- Publish only the accepted binaries. Do not replace historical release assets.
- No Unity project, personal AI settings, or installed apps changed in this work.

## Packaged Test Status

- MCP 2.7.1 run [35037253293](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/actions/runs/35037253293)
  passed upgrades from 2.6.0, 2.7.0-alpha.1, 2.7.0-alpha.2 and 2.7.0. The exact
  packaged cleanup helper stops two private runtimes and preserves unrelated
  Node, all settings and baseline files. The newly installed bundled server
  passes connected-idle and idle/pending-wait EOF checks. Replay
  [35040188482](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/actions/runs/35040188482)
  also passed native Yes/No/Cancel and native app lifecycle on those exact bytes.
  Native preflight and guarded silent installation were tested separately.
- First Hub candidate, commit `3092aea4d55f488bef1bb9406307952372219da3`, run
  [35037235669](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35037235669),
  is REJECTED. Clean and stable-0.1.2 routes passed, but legacy and MCP-only
  native tests found `Command disconnect_mcp not allowed by ACL`. No confirmation
  opened. Browser mocks and Rust unit checks could not catch the missing ACL.
- Commit `1867ef04edcd0e8444d5fac5dbd4fbe112ef4466` adds only the missing command
  manifest/default-main-window permission and a regression test that failed
  before the fix. All 17 script tests pass. The trusted-shell gate is unchanged.
- Corrected Hub build/native run:
  [35038464607](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35038464607).
  This is a full rebuild, not an acceptance replay of the rejected binary.
- That build passed MCP-only native disconnect/update, but legacy discovery
  unexpectedly reported Setup 0.2.2. Cause unknown. Additional inventory capture
  was added; replay 35039611764 passed all four routes on the unchanged installer.
- Final source `ea905d90820c7ba721fb68fdf497858292d514cc` binds MCP 2.7.1 and
  Setup 0.3.0. Run 35040103489 passed its full build and all four native routes.
  Every route discovered public MCP 2.7.1 and Setup 0.3.0 without a check warning.
  Legacy and MCP-only native consent/Cancel/disconnect/update checks passed.
  Earlier 0.1.3 binaries with MCP 2.7.0 pins will not ship.
- MCP 2.7.1 is public stable. All 16 uploaded asset hashes/sizes matched; anonymous
  downloads passed the application's signature, installer/EXE binding and tamper
  rejection checks. Its minHubVersion is 0.1.3. Public 2.7.0 bytes are unchanged.
- User authorized completing publication and then sleeping the PC. Sleep remains
  conditional on both published releases passing final verification.

Companion edits are in `creator-works-mcp-community`. BANTWORKS MCP task handoff
succeeded this turn after the earlier transport failure. No peer response was
needed for the checks above. The private MCP feedback journal records findings.
