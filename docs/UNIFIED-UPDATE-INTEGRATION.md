# Unified Update Integration - 2026-10-13

This is development integration, not a release or installed update acceptance.
PR21 and the source publication guard remain held.

## Implemented Boundaries

- Optional managed Windows candidates package signed runtime and router
  descriptors. The retained protocol-1 entry point stays stable across compatible
  Hub updates; changed retained bytes refuse activation rather than self-repair.
- The private MCP handshake binds managed routing only after writable native
  approval. Routed client entries have zero arguments, and launcher settings
  retain the physical server path rather than the empty-argument sentinel.
- Selected existing clients can be reviewed together. Exact before/after images,
  native displacement evidence, interruption classifications and local backups
  are retained. Unknown/conflicting outcomes never trigger blind rollback.
- Recovery is visible in MCP. Paths are independently derived from supported
  clients; the journal cannot authorize a different settings path. Adjacent
  single-client journals remain inspectable alongside the new shared batch root.
- Ordinary built-in Windows client setup uses its exact parsed snapshot too.
  Existing files use the reviewed-write journal; new-file publication refuses
  replacement. Completed history is distinguished from current completion, so
  later approved setup does not become a false interrupted-migration warning.
  Unfinished adjacent journals block new central setup. This admission is not
  a global atomic reservation against concurrent independent writers.
- Hosted bridge status and installation consume build-verified resource buffers.
  Unix pathname mutation cannot replace the consumed bridge/logo snapshots.
- Convergence restores old standalone-backed Hub views using the new verified
  built-ins. Saved paths still grant no executable authority.

## Native Updater Work

Windows keeps its published NSIS descriptor/key and guarded per-user registered
installation path. Companion NSIS management has not been enabled on Unix.

Hub has package-specific native descriptor and updater keys for Apple silicon
and Intel macOS app archives, Linux AppImage, DEB and RPM. A package cannot select
another architecture or installer type. Native descriptors require separate,
exact signed-discovery/cancel/install/restart/preservation acceptance receipts;
a Windows receipt cannot authorize them.

AppImage replacement targets the outer original file, not the read-only mounted
binary. Mac replacement stages beside Applications, rejects other bundle roots,
links, special files, duplicate/traversal entries and oversized archives, checks
the signed executable hash and native code signature, then atomically exchanges
the complete directories. The old app is retained. Failed extraction/signature
checks occur before publication; an uncertain post-swap flush outcome requests
manual restart and is not reported as untouched installation.

Unix startup fingerprints and before-install rechecks refuse observed moved,
replaced or in-place-modified installations. These are not filesystem CAS or
protection against malicious ancestor replacement, prelaunch environment
substitution, process-memory compromise or arbitrary storage cache loss.
Native Mac/Linux target replacement and full installed update tests remain
required. System security/licensing prompts are never bypassed.

Native and Windows Hub descriptor producers verify their copied signing input
against the exact reviewed package hash/size before signing. A changed source
package cannot produce a success report with a mismatched signed descriptor.

## Actual Client Evidence

Only installed clients are required: Codex, Claude Code and Claude Desktop.
Missing OpenCode/Antigravity remain format-test coverage, not a release blocker.

Codex CLI 0.162.0-alpha.17.2 reached the MCP server but initially refused its
read-only health tool as approval-required. `get_bridge_status` lacked its
read-only annotation. After adding that annotation, the actual client completed
the call with the exact disposable project path and expected `ready=false`.
No authoring tool was relabeled read-only and no global permissions were weakened.

Evidence is retained in `artifacts/live-clients-20261013-01`, `-02` and `-03`.
The passing call used a rebuilt source bundle and the candidate's private Node,
temporary client overrides and an ephemeral read-only session. It was not an
installed stable-router/signed-update or live Unity Editor acceptance test.

The exact packaged server and private Node in Windows candidate
`managed-route-20261013-02` passed the same actual Codex call without a rebuilt
bundle override (`artifacts/live-clients-20261013-04`). The installer SHA-256 is
`c3195b2e3e59889881fef7e82500f391015aea99a9b0574585f6e0bc17301c19`;
the extracted installed executable is
`1a89967a4c972fcd2fa01e1dee8e413b0dc5c074f1ca2dc30174059988861e8d`.
Its runtime/router metadata is signed, its NSIS installer is unsigned and its
version remains 0.1.12. It has not replaced the user's installed apps.

Native runtime CI at source `7edf6fb` passed on Windows, Linux x64, macOS Intel
and Apple silicon. Retained Unix JSON verifies exact server/runtime consumption,
tamper refusal, owned cleanup and actual SDK transport against the real server
bundle. These are execution component checks, not native GUI/install/update or
authenticated AI-client acceptance. Mac native app-exchange and read-only
resource staging tests also passed in the Hub lane before the MCP lint failure.
Platform-only lint failures were corrected separately in `dc60489`; the failed
runs remain failed and are not counted as passing full CI.

The self-update workflow's stale 0.1.10 fixture setting now matches its native
0.1.11 baseline, with a regression check. This only repairs that existing test
harness; a next-version candidate still needs a separately pinned previous
public stable baseline and exact signed installed-update acceptance.

Claude Code connected to the candidate server, but its existing OAuth session
expired before a model/tool call. Claude Desktop opens at sign-in. User login
is required; credentials were not read, copied, transferred or automated.

## Combined Source Follow-Up

The hosted launcher now checks exact form and backend-operation snapshots before
saving. One-click setup, managed-entry removal, project launcher preferences and
feedback preferences use snapshot-bound publication too. Current/legacy data
locations are reused, with explicit backup/conflict/recovery review; no separate
Hub preference copy, automatic legacy uninstall or schema guess was introduced.

Native Unix existing-file publication uses same-volume kernel exchange and
no-replace retention of the actual displaced object. Ambiguous outcomes retain
evidence and stop without rollback. Linux headless fixtures passed 64 tests on
the earlier 1.92 compiler; new CI runs these on pinned 1.99 and both Mac
architectures. This does not close the GUI executable-use or consent acceptance
gaps. See PRODUCT-SETTINGS-PRESERVATION.md and MCP-UNIX-HOSTING-BOUNDARY-AUDIT.md.

Combined local checks on Rust 1.99: Hub 153 passed / 11 opt-in ignored, MCP 239
passed / 7 ignored, strict all-target Clippy passed, browser 275 passed. Root
scripts passed 93 / 1 Unix-permission skip before the additional minimum-OS
regression, which passed separately. An old atomic-write fixture initially
failed because built-in saves intentionally retain a backup; it now verifies
the exact old bytes and absence of temporary files instead of forbidding the
backup directory. The original failed log remains retained.

The retained RPM passed native metadata/digest checks, but rpm2cpio 4.17 exited
unsuccessfully. Direct libarchive extraction passed all ten resource hashes in
run 38326950306, using the same package hash. This is extraction, not installed
RPM or full AppImage acceptance. The original packaging run 38324292677 remains
failed on Linux; both Mac packages passed integrity/signature checks. Their
Info.plist declared 10.13 despite the pinned Node runtime's 13.5 requirement;
source now explicitly declares 13.5 and needs fresh package verification.

Rust is pinned to 1.99 locally and in the build workflows. Test workflows cancel
superseded per-branch runs; publishing has no new cancellation behavior. The
temporary RPM pull-request diagnostic trigger was removed after capture.

## Remaining Release Gates

- Full accepted product-settings convergence and conflict review, without legacy
  uninstall/data loss. The current modules still use existing settings locations.
- Actual signed previous-stable discovery, refusal, update, restart, restored
  views and client reconnect against the exact packaged candidate.
- Writable Unix native GUI operation/consent/ownership and distribution acceptance;
  production Unix writable mode remains off. See MCP-UNIX-EXECUTION.md.
- Native Mac runtime identity/enforcement, resource/package integrity and cleanup
  acceptance on both architectures. Cross-compilation is not this evidence.
- Experimental native packages now have an explicit builder/CI path with MCP
  forced read-only and releaseReady=false. Node is not re-signed after its
  backend build-time hash; packaged resource bytes must still match the bound
  manifest. See EXPERIMENTAL-UNIX-PACKAGING.md.
- Authenticated actual Codex/Claude Code/Claude Desktop calls after fresh setup
  and upgrade, including a live disposable Editor project.
- Legacy removal and final migration helpers only after these checks. Historical
  repositories, release assets, signatures and updater files remain untouched.
