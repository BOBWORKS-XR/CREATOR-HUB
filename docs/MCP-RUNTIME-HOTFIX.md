# MCP Runtime Update Hotfix

2026-09-16. Unpublished candidates: Hub 0.1.3 and MCP 2.7.1. Installed user apps
are unchanged. Do not overwrite public Hub 0.1.2 or MCP 2.7.0 assets with these
different bytes. Disposable installer acceptance is being prepared.

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

- MCP full Node suite: 249 passed, including Windows PowerShell process and file
  fixtures. The EOF regression failed before the source change and passed after.
- Standalone MCP bundle smoke passed; all three shutdown tests also passed
  against the built bundle, not only TypeScript output.
- Hub: 144 UI tests; 107 Rust tests, nine existing opt-in tests excluded;
  16 script tests; strict release Clippy passed.
- Native Windows test uses disposable copies of real Node: multiple runtimes,
  confirmation cancellation, stop/retry, no remaining runtime, newly reopened
  connection, unchanged executable bytes and an unrelated live Node process.
- Installer hook compiled using local NSIS. The fixture deliberately has no
  real installer/uninstaller payload. Its unused-uninstaller warning is expected.

## Remaining Release Work

- Build new versioned MCP and Hub installers; do not replace signed installed
  files manually or reuse old release receipts.
- Run actual installed-upgrade acceptance on disposable Windows CI, including
  old locked runtimes, native Yes/No/Cancel and silent refusal.
- Test the complete Hub disconnect -> update -> reconnect path with each client
  being claimed as supported. Client automatic reconnection policies differ.
- Publish only the exact accepted binaries and their new signed metadata.
- No Unity project, personal AI settings, or installed apps changed in this work.

Companion edits are in `creator-works-mcp-community`. Task coordination was
attempted but the app task tools returned `Transport closed`; no peer response
was obtained. The private MCP feedback journal also records the findings.
