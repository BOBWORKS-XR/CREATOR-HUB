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

## One Reversible Experiment

After the measured normal-close/stdio baseline, exercise **only MCP's GUI
executable**. A dedicated native NSAlert must first be cancelled, followed by a
whole-bundle byte/inode check and a live stdio check. A second fresh native alert
must be approved. The VM-only driver targets only the exact owned helper PID,
parent, kernel executable and hash, native modal window and enabled AX button;
it performs an actual AXPress, not a fabricated receipt or consent flag.

Keep both source/destination directory descriptors open. Write exclusive synced
intent/archived/restored records under this one experiment's folder. First prove
actual `RENAME_EXCL` collision refusal with an existing sentinel. Then archive
only `Contents/MacOS/creator-works-mcp-launcher` into that folder, without overwrite.
All nine original server/resource paths remain. Do not edit Info.plist, move the
app bundle or re-sign anything. [Apple's native rename flags](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/stdio.h)
provide the exclusive primitive; native execution must establish its actual result.

While it is absent, measure strict bundle signature, Gatekeeper assessment,
LaunchServices registration, an absolute-URL native launch attempt, the already
live stdio connection and reconnects through **both original Node aliases**.
Restore the exact archived inode with another exclusive rename and verify the
whole bundle and strict signature again. A barrier deadline restores only this
live experiment's verified before-image; journals never replay or grant authority.
This is not a generic recovery framework or a production retirement helper.

The workflow may pass for a complete, measured and restored experiment. Product
migration, permanent retirement, installer/update and release acceptance flags
stay false. Busy-workflow refusal, competing external installers and crash/power
loss recovery are not claimed. No user-PC application/settings change, credential
access, forced process stop or security bypass is involved.

## Baseline Already Captured

[Run 38632099882](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38632099882),
commit `47accf85f10aa70fc7e570d41c8a61aa8976acba`, completed both Intel and ARM
captures. Both pinned apps passed strict signature and normal Quit/exit 0, with
every original file unchanged. On each architecture the existing MCP stdio PID
returned 53 tools before and after GUI close; both original Node aliases
reconnected with 53 tools and exited normally on EOF. Synthetic isolated server
config bytes were unchanged. Gatekeeper assessment rejected all four old app
copies (exit 3); no bypass was attempted. That run intentionally stopped before
archival and returned failure. It is retained, not replaced by this experiment.

## Verification

Portable refusal/source tests:

`node --test scripts/native-macos-legacy-retirement-probe.test.cjs native/legacy-retirement-unix-proof.test.cjs`

Native workflow results and exact report facts will be appended after execution.
