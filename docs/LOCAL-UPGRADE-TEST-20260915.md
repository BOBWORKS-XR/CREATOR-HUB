# Existing Installation Upgrade Test

User approved replacing existing installed builds on 2026-09-15 to test the real
update process. This is local installation authority, not public publication,
permission to discard settings, or permission to terminate AI clients or Unity.

## Baseline Read Back

| App | Actual executable version | Uninstall registration |
| --- | --- | --- |
| Creator Hub | 0.1.0-alpha.6 | 0.1.0-alpha.4 |
| Creator Project Setup | 0.3.0-alpha.6 | 0.3.0-alpha.1 |
| Creator Works MCP | 2.7.0-alpha.1 | 2.5.1 |

All are installed under their named directories in `%LOCALAPPDATA%`. Exact
executable hashes match the recorded existing public builds. Registrations are
older than the actual payloads; verify both instead of trusting either alone.
All three GUIs and several private MCP Node processes were active at inventory.
No processes were stopped and no installed files were replaced.

First capture: `artifacts/upgrade-baseline-737185dfb83c4b6da93ca66ec46734ce`.
Five known JSON settings files were copied with matching before/after/copy hashes.
Ten relevant running processes were observed. No credential files were copied.
The exact previous Hub diagnostic EXE returned exit 10 from its read-only
`--installer-preflight` check while the installed Hub was open. No installer ran.
This is a guard observation, not an accepted upgrade; repeat with the final bytes.

## Sequence

1. Resolve the confirmed receipt/journal persistence defect with the MCP owner.
   Preserve failed fixtures; use new disposable projects for actual import tests.
2. Build full versioned local candidates: Hub 0.1.0-alpha.7, Setup
   0.3.0-alpha.7 and MCP 2.7.0-alpha.2. Hub/Setup source versions are now bumped;
   this does not publish anything. Do not use diagnostic EXEs as install payloads.
3. Check extracted installer hashes, packaged notices and complete MCP runtime
   resources. Establish exact companion hashes for the matched Hub build without
   inventing an acceptance run or bypassing signed catalogue checks.
4. Capture known settings using `scripts/Capture-UpgradeBaseline.ps1`, then take
   a fresh capture immediately before installation while apps are idle. Preserve
   WebView preferences and AI client configuration; do not reset user data.
5. Confirm busy installers refuse before uninstall/extraction and name relevant
   blockers. Ask the user to close the relevant apps and MCP-owning clients
   normally. Do not kill unrelated Node, Unity, Codex or other AI client processes.
6. Run the actual installers against their registered paths, Hub first for the
   matched hosted suite. Do not substitute direct EXE copies for upgrade testing.
7. Compare installed hashes, actual versions, registry versions, shortcuts and
   settings. Open standalone and hosted views without duplicate visible apps.
   Plugins import acceptance uses a throwaway project, not the user's Forest.

## Honest Scope

The receipt fix is in native/helper testing; real Unity acceptance and matched
installer checks remain necessary. Shared MCP component packaging is a
separate planned architecture, not included by simply updating these apps.
An installer-driven local upgrade is not proof of GitHub update discovery,
background downloads, all historic versions, MSI migration or other platforms.
Nothing is published without a separate release decision and passed gates.

## Candidate Source Checks

- Hub: 78 native tests passed, seven opt-in tests skipped; 100 UI tests passed;
  11 explicit release-harness tests passed. A mistaken Node filename glob first
  ran zero tests; it is not counted as evidence.
- Shared native status tests include four new cases for read-only review status,
  final-receipt precedence, wrong/malformed active requests and old intermediate
  receipts. The shared native file hash is
  `c19e63131983d15cf7382fa6b9509e64777b7ec103d817600af19852a1120445`.
- Setup: 82 native tests and two packaged metadata checks passed; eight opt-in
  tests skipped. 58 UI tests, 15 release-harness checks and strict all-target
  Clippy passed. Hub strict production Clippy also passed.
- Frozen helper candidate hash:
  `934a880bcbc9139cba2b75753edde47ededb82b88c5ce7f8b91f4238382d1af5`.
  All four helper files were copied and hash-compared across the three apps.
- New production-writer fixture: `artifacts/plugins-native-i8Ws70`. Exact new
  helper and three harmless pinned packages were queued; no user project was
  selected. `plugins-native-uqPcb1` is an unused old-helper fixture after an agent
  copy-path error, not acceptance evidence. Neither old fixture was rewritten.

## Packaged Setup And Real Busy Refusal

Candidate: sibling `creator-setup-community/dist/windows-candidate-alpha7-local-20260915/candidate`.
Full NSIS and portable ZIP were built; extraction, exact metadata, notices,
unsupported arguments and the no-install guard fixture passed. Source is dirty
and explicitly recorded as such; this is not an accepted CI source revision.

| Artifact | SHA-256 |
| --- | --- |
| Setup alpha.7 installer | af2fd4d8b855e096b8ed080423f5484d0d2834e598a294e83d2c738d3ad0ad70 |
| Extracted installed EXE | 4e7e05ef293014f966d2331e4b8b673ee855fc89c1f4112e2cb71f4d26159ee3 |
| Portable EXE | ee1860bce49ddf2d0af1a06fa0bbdc1ed11eb43191ea509a161f31e00135ec2f |
| Portable ZIP | c08bb8239fdf60dc829197a2f2a5fd76de64fb80f1370497d18c9376d4b8cfc3 |

The exact new NSIS installer ran with `/S /UPDATE` while the existing installed
Setup was open. It returned **10**, the app survived and its uninstaller hash
was unchanged. Before/after captures compared all three installed executable
hashes and registration fields plus five settings files: **no differences**.
Evidence is under `artifacts/upgrade-before-setup-refusal-20260915` and
`artifacts/upgrade-after-setup-refusal-20260915`. No app was upgraded in this test.

Feature-branch push/candidate-CI permission was requested separately. No public
release, signed catalogue update, invented acceptance ID or weakened trust check
was used to make a local companion appear verified.

## Hub And MCP Packages

Hub installer: `dist/Creator-Hub-0.1.0-alpha.7-Existing-Apps-Candidate-R2`.
This build deliberately uses the existing accepted Setup alpha.6 and MCP alpha.1
pins. It is a Hub-only upgrade candidate, **not** the new matched three-app set.
Do not install the new companion candidates and expect this Hub to host them.

| Artifact | SHA-256 |
| --- | --- |
| Hub alpha.7 installer | 5d8eddb3ccc4dc57de3e69cfff9e5552757ca1fb0e3dac4ecc6fa046e73bcf4e |
| Hub extracted installed/preflight EXE | f06b859a9ce6797ba5bf5a5d4ab892ae61f94896e559a5e493efbf2a7ddfee10 |
| MCP alpha.2 installer | efd441bc65606b0ce98b4734f73be5e40280fb43d22b2fa73620a5dae9ead3f9 |
| MCP extracted installed EXE | 95475bac506980e8b0f7679df6f0570b37eefc628d0a3c29558ec0729603ccf5 |

MCP candidate is in the sibling worktree's
`artifacts/windows-candidate-alpha2-local-20260915`, with complete private Node
and server/bridge resources plus notices. Its `candidate.json` records exact
bytes and pending gates. This is not the incomplete diagnostic EXE.

Both exact Hub and MCP installers were invoked with `/S /UPDATE` while their
installed apps were open. Each returned **10**, preserved the active app and
existing uninstaller, and left all three installed executable/registration
records and five settings files unchanged. Captures are under
`artifacts/upgrade-before-hub-refusal-20260915`, `upgrade-after-hub-refusal-20260915`,
`upgrade-before-mcp-refusal-20260915` and `upgrade-after-mcp-refusal-20260915`.
The closed-app upgrade and Hub self-update have not been performed.

The first Hub packaging attempt failed because an unset `CARGO_TARGET_DIR`
remained a literal NSIS preflight path. `Build-Installer.ps1` now resolves and
sets its default target explicitly, then restores the caller's environment.
R2 built and passed extraction/preflight/notices/guard checks. An additional
error-path check verified restoration with unset and relative targets without
creating output. The failed output folder remains intact; no installed file
was involved.

## Live Unity Attempt: Inconclusive

The user directly approved the live test in this task after an earlier pause in
the MCP task. Opened only `plugins-native-i8Ws70`, Unity 6000.3.21f1, PID 92048.
The prepared test window was opened without rerunning Prepare or rewriting inbox.

Computer Use reported intervening user input during review/cancel actions. The
first package (`01 Cancel check`) was actually imported, not cancelled. Its real
started/completed callbacks and immutable `imported` receipt are present. The
expected-cancel asset exists; no active marker remains. This is not evidence of
a product cancellation defect, nor a passing planned workflow.

The user subsequently clarified in the MCP task, "I imported". The first
receipt therefore correctly records the user's chosen import. That individual
import succeeded; the originally planned cancellation/C# test remains incomplete.

No text/C# follow-up import was attempted. No receipt was rewritten, no asset was
deleted, and no clear/retry action was used to force a passing result. There is
no `interactive-result.json`. The fixture was closed normally through its own
observed Close button; its shutdown log and absent PID confirm closure. Existing
user projects were not selected. Unity wrote its ordinary global layout prefs,
so this is not a claim that every personal preference was untouched.

Preserve `interactive-events.log`, `Editor-interactive-parent.log` and the queue.
The next native attempt must use a new disposable fixture during an uninterrupted
desktop interval. The original C# reload/persistence gate remains unconfirmed.
