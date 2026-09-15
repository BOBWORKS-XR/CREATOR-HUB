# Plugins Integration Status

Historical 2026-09-14 snapshot below. For the current 2026-09-15 source, packaged
Setup candidate and actual busy-installer refusal, see
[local upgrade testing](LOCAL-UPGRADE-TEST-20260915.md). The new helper creates a
terminal receipt once and derives queued/review states without rewriting it;
old failed fixtures remain intact. Real import/reload and matched-suite upgrade
acceptance remain required. The shared-source hashes below identify the older
snapshot, not the new candidates.

2026-09-14: Local development only. Not release-ready. No installed app, AI
client configuration, public release or real user Unity project was changed.
Only explicitly owned disposable Unity fixtures were modified.

## Product Direction

See [shared MCP direction](SHARED-MCP-DIRECTION.md): standalone MCP remains;
Hub and Setup also provide MCP access. A single managed MCP installation is
the proposed implementation, not yet built. Do not claim that shared packaging
eliminates version checks or historical migration requirements.

## Implemented Locally

- Plugins page in Hub and both standalone apps, not a fourth application.
- Explicit project picker, optional Editor-only menu installation, native
  confirmation, checksum-verified external queue and manual status checking.
- Unity uses its interactive ImportPackage dialog. No automatic import, scene
  saving, project launch, package extraction or replacement of a different helper.
- Native project identities and manifest/version rechecks, cross-app file lock,
  no-clobber publication, bounded queue, pending/offline catalogue rejection.
- Hub includes the reviewed `92e3ef9` connection-drain hotfix. Its two source
  files match that commit exactly; unrelated baseline changes were not pulled in.

## Verified

- Hub: 74 native tests passed, seven opt-in tests skipped; 100 Playwright tests
  passed using the actual feature-branch Setup/MCP interfaces with mocked native
  calls; 11 release-harness tests passed. Strict production Clippy and release
  build passed. Existing all-target baseline lint is not part of this change.
- Setup: 78 native tests and two compiled metadata tests passed; eight opt-in
  tests skipped. 58 Playwright tests, strict all-target Clippy and release build
  passed. No clean-machine installation or SDK download was repeated.
- MCP owner final report: 232 Node tests, 19 standalone UI groups and ten hosted
  UI groups passed. Full native suite: **74 passed, one failed, three ignored**;
  the failure is the journal replacement described below. Release build and
  metadata-only smoke passed (two valid, 13 invalid and two unauthorized-host
  probes). This is not a passing end-to-end suite or a full runtime payload.
- Explicit ignored `prepare_native_unity_acceptance` test passed: it created a
  new fixture, installed the exact embedded helper through production Rust code
  and queued three hash-pinned harmless local exports through production queue code.
- Windows directory publication regression first failed with `std::fs::rename`
  replacing an existing empty directory. Explicit no-replace `MoveFileExW` now
  passes that regression. Unix branches still need native CI acceptance.
- Helper revision `47f0dd36af987b3b8b79fb62751815b4a988e5d262bbfbe859709ad181611ae6`
  defaults an omitted review state to pending; unknown values still reject.
  Peer confirmed the original defect with Unity's actual JSON parser.
- Peer reported the latest Unity 2022.3.39f1 no-import suite: 13 queue/listing
  checks and six restart/recovery checks passed. This does not supersede the
  failed real Unity 6 import recorded below.

## Confirmed Blocking Failure

Fixture: `artifacts/plugins-native-zyUziW`, Unity 6000.3.21f1 on Windows.
The production Rust writer created the helper and all inbox files. The MCP owner
then exercised actual Unity review dialogs; the fixture Editor closed normally.

- Cancel: receipt is `cancelled`; the cancelled asset was not imported.
- Text import: receipt is `imported` and the expected file was imported.
- C# import: actual assets and Unity completion callback exist after assembly
  reload, but receipt remains `review`. The helper reported: `Could not record
  the final import outcome: Unable to remove the file to be replaced.`
- `interactive-result.json` is **passed:false**, statuses
  `cancelled`, `imported`, `review`. Preserve it and the event log; do not rewrite
  receipts, clear tracking or rerun the same import to make the test pass.
- The earlier helper-only successful UI run does not override this newer full
  writer-to-Unity failure. Do not claim all angles or complete native acceptance.

The existing MCP Rust journal also intermittently returned Windows error 1175
in a concurrent suite. Its isolated/serial passes are not proof of a resolved
cause. That implementation was not modified in this parent task.

Microsoft documents 1175 as failure to remove the replaced file, with both names
retained. The Rust publisher's WRITE_THROUGH flag is unsupported, but that alone
does not prove the cause, especially for the separate .NET helper call.
Source: [ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew).

## Bounded Diagnostic

Run `Add-Type -Path scripts/ReceiptReplacementProbe.cs`, then
`[ReceiptReplacementProbe]::Run()` in PowerShell. It writes only a new owned temp
directory. It does not inspect settings, launch Unity, retry or modify real files.

This run passed 1,000 replacements plus readback each for ReplaceFileW flags 0,
flags 1, MoveFileExW replacement and .NET File.Replace. It did **not** reproduce
the observed failure; no production fallback, delay or retry was added.
Evidence: `C:\Users\bobman\AppData\Local\Temp\creator-receipt-probe-cc05e67cc1aa4f358a861e8a04e378b2\result.txt`.

Next test must capture why the Unity receipt replacement fails (handles/sharing,
attributes and file-system error), or reproduce it deterministically before
changing publication behavior. Never repeat asset import to retry receipt storage.

## Diagnostic Binaries Only

`artifacts/plugins-diagnostic-20260914/` preserves new local builds. They still
carry baseline alpha.6 version labels and must not be distributed as those public
releases. No installer or matched hosted compatibility descriptor was created.

| File | SHA-256 |
| --- | --- |
| creator-hub.exe | c908557ad2d4c9ed65b91ee12dd6fc45d357dc05019307637fa83c4bda174100 |
| creator-project-setup.exe | 478710f6a5273e6f2a194a451c05ff3dfe29ce83d4e8e5081ecec3adb1e319c2 |

The older catalogue-only binaries and historical report are preserved separately.
MCP diagnostic EXE: sibling `creator-works-mcp-community` worktree,
`artifacts/plugins-diagnostic-20260914/creator-works-mcp-launcher.exe`, verified
SHA-256 `ee66f1f12336dcd4e6d62369141fe2f67bfc52bbc5968be1e56f9e9c74739799`.
It inherits `2.7.0-alpha.1` but is not the public binary. No full runtime/server
payload or installer is staged with it. Do not launch normally, distribute it,
mix it with older sidecars, or use it to upgrade an installed app.

## Shared Source Freeze

The four shared source files and current C# helper were compared byte-for-byte
across Hub, Setup and MCP and match. All four embedded helper files also match
between Hub and Setup. MCP's separate diagnostic build is recorded above.

| File | SHA-256 |
| --- | --- |
| community.js | b1f1606775c74e3b1f1fc0ed39478dba56ab1666f7ffa6107127f714b6cdfca2 |
| community.css | 06087f51dcb447c6493aab21661c09315b786374d6acbcfa84bdb5e705d257a0 |
| community.rs | 4b0387555e88a0a48aa4398ca8a0472eafb5be87ffa6cd0d53909490d386e9c7 |
| community_project.rs | 51542799c13ced3e21da50c9ae7f9f2f207b9a3e6348aa80870aba11159d7f72 |

## Remaining Gates

Resolve receipt persistence and rerun the failed native workflow with new owned
fixtures. Desktop native picker/consent and exact matched hosted binaries still
need acceptance, as do installation/upgrades and macOS/Linux. Start Location is
still pending exact licence/content review; user-described open licensing is
not a named licence grant. It was not imported or published. Current queue limit
is 100 retained requests per project; history maintenance is not implemented.

Preview remains `http://127.0.0.1:4190/`; it uses the explicit pending test listing
and cannot perform native project operations. Larger shared Hub/MCP packaging,
adoption and uninstall behavior are separate work.
