# Mac Legacy Retirement Diagnostic

Scope: exact public Setup 0.3.7 and MCP 2.7.7 DMGs on disposable Intel and ARM
GitHub-hosted Macs. This is not a production removal helper, migration,
installer acceptance, or a release gate waiver.

The [passive audit](UNIX-LEGACY-GUI-RETIREMENT-AUDIT.md) and its exact package/member
pins remain the baseline. No old release bytes, signatures or metadata change.

## What The Probe Measures

- Fixed opt-in `validation/mac-legacy-retirement-014` branch and matching native
  architecture, before filesystem/process inspection. No arbitrary package or
  destination arguments. Refuse existing product apps in either application root.
- Read-only native DMG mount, exact package digest/size, fresh ordinary per-user
  `~/Applications` copy, full pinned file inventory, UID/link/dev/inode/hash facts,
  native plist, strict bundle signature, unchanged xattrs and Gatekeeper assessment.
- Exact directly owned GUI PID/parent/start time/kernel executable/native app
  identity. Standard AppKit Quit only after repeat identity and byte verification;
  the public tags guard `RunEvent::ExitRequested`. Report actual owned exit,
  rather than treating acceptance of Quit as proof of exit or external busy state.
- MCP's independently verified original `runtime/node` and `runtime/node.exe`,
  dependency layout, live newline stdio initialize/tools-list across normal GUI
  close, two original-path reconnects and ordinary EOF exit. No Unity tool call.
  The synthetic isolated server config is measured separately from real settings
  migration. All nine original resource paths and all other app files must match.
- Related LaunchServices registration paths are read-only observations, not
  authority to unregister an installed app.

## Deliberate Stop

No archive or removal operation is implemented. A successful normal GUI exit does
not establish native review/cancellation, an exclusive install/namespace
reservation, no-overwrite durable archive/recovery, or supported registration
removal. There is also no native busy-workflow exercise yet. The probe records the
first concrete failure and the missing retirement contract; it never force-stops
an app, removes/re-signs a bundle, alters quarantine, edits a package database or
seeds legal consent. Apps stay installed in the disposable runner. That is **not**
completion of the user's Hub-only requirement.

The workflow deliberately returns failure even when its baseline capture completes.
Every migration, retirement, updater and release acceptance flag remains false.
No user-PC application/settings changes or credentials are involved.

## Verification

Portable refusal/source tests:

`node --test scripts/native-macos-legacy-retirement-probe.test.cjs native/legacy-retirement-unix-proof.test.cjs`

Native workflow results and exact report facts will be appended after execution.
