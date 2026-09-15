# Coordinated stable release status

2026-09-15. The user explicitly authorized stable releases for all three apps.
This supersedes older alpha.8 publication holds. Setup 0.3.0 is now public;
Hub and MCP publication remain conditional on their exact-binary checks.

## Latest checkpoint

Setup 0.3.0 was published with all 13 GitHub asset digests verified and the
public installer/metadata downloaded again and checked against Hub's trust key.
Final candidate 35003479084/f8d5423 and installed acceptance 35004470795/600244a
passed four upgrade baselines: 0.2.2, alpha.1, alpha.2 and alpha.6. The same actual
installed app served the approved PNG, refused WM_CLOSE during its native folder
chooser, returned null on Cancel and exited normally when idle. Signed receipt
and all individual upgrade/lifecycle reports are public release assets.

Setup's old tag auto-builder 35005022299 was cancelled with all four publish
steps skipped and then disabled, preserving the exact public artifacts. See its
`docs/STABLE-0.3.0-PUBLICATION.md`. Current master also has a formatting-only test
assertion change and a canonical macOS CI temporary-path configuration; the
cross-platform CI replay is pending. No Windows release binary changed.

Final MCP installer `f403da14237a16d3e7a50620d484c60c0a3fbdbb6abfe1ccaf21e4ffb78e1da9`
and EXE `0fc9f6023973378778a00b063c383f37f2973eec9d89a96b084391c89f2287cd`
passed all three installed upgrades in 35003567089. The same executable passed
native lifecycle and approved PNG checks in 35004965231. That replay as a whole
failed: its historical alpha.2 clean baseline install returned 10 before invoking
the candidate. The later old-guard probe took 15.578s and succeeded; a cold 15s
preflight timeout is a hypothesis, not a captured root cause. The distinct exact
passing receipts may be combined, but the failed replay must remain recorded.
The MCP task is preparing publication with its old rebuild workflow excluded.

Hub candidate 35005538731 is running from `7b491d9`, with accepted stable companion
hashes and source revisions in `scripts/prerelease-apps.json`. It will test four
native routes and actual fresh/known-old Unity helper menu installation, backup,
metadata preservation and cancellation. Do not claim this candidate is accepted
or the whole suite is public until those checks and public asset verification pass.

## Earlier checkpoints

The three-puzzle-face Plugins icon was approved on 2026-09-15 and is now in Hub,
Setup and MCP source. Production PNG SHA-256:
`ff107f1c0bca0380f35f25754fd023d60311fa4457f6fd84255a8f41f78fee6d`.
Hub's 114 UI tests and Setup's 59 UI tests passed again after this change.
MCP reported 243 Node tests and 22 UI groups passed, including PNG checks.

Pre-logo Setup candidate 35000700601 passed. Installed replay 35002542577 at
`f81819f` passed all three baselines (0.2.2, alpha.1, alpha.6). Prior acceptance
35002191261 failed before installation on an outdated baseline-list assertion;
that test expectation was corrected, without changing candidate bytes.
The earlier guard timeout was not reproduced; its cause remains unknown.

MCP independently verified all three upgrade receipts and actual packaged busy/
idle lifecycle checks from replay 35002220505. Original candidate source
`8caf8a818ff5654dc255ab2c02fcf7c21525e7d5`, installer
`762258ab39822d38d67810b8fda3b51cd017503178a23d08ecfb340f92282c77`,
launcher `a35414684d943d214f9584d79debbb64db8e482489bc3c40fafc02368e9fb1dc`.
The initial alpha.2 baseline refusal remains unexplained, not declared fixed.

Those passing artifacts contain the earlier logo and are not the final release.
Final builds: Setup 35003479084 at `f8d5423`, MCP 35003567089 at `5b65478`.
Their new hashes and fresh installed acceptance are pending. Setup's new
CI-only chooser lifecycle check uses the existing real guarded command and
does not add production IPC, install Unity or select a project. Its local
execution-refusal test and syntax checks pass; native acceptance is pending.

## Versions and ownership

- Hub 0.1.0: this checkout; known-helper update/backup, shared native queue/history,
  Projects-first navigation, plugin cards/icon, stable descriptor approval.
- Project Setup 0.3.0: sibling `creator-setup-community`; same native/helper/UI
  changes, existing setup/repair behavior, stable metadata and README.
- MCP 2.7.0: BANTWORKS MCP task, sibling `creator-works-mcp-community`; owns its
  C# queue changes and release preparation. Shared native/frontend port reviewed.
- Project Setup's merge into Hub remains a separate future phase.

## Shared behavior

Known old helper is the exact four-file alpha.8 baseline from commit
`4ab615c9ccd6ac9fff49f55e298ac06e12d46fde`, frozen in
`tests/fixtures/helper-alpha8`. Unknown/edited files are not overwritten.
Update requires a closed Editor, rechecks state, retains a complete backup,
preserves `.meta` files and restores on failed publication without replacing a
raced destination. Staged contents are checked again after Windows reader waits.

The shared queue uses `.creator-plugins/desktop.lock` for short nonblocking native
and Unity operations. At explicit enqueue/retry, terminal requests move without
replacement to `history/requests`; immutable final receipts remain in `receipts`.
The entire bounded inbox and receipts are validated before archival. There is a
100 unresolved-request limit and a 1000-entry recovery scan limit. No history or
user assets are deleted. Status resolves active/history identity under the lock.

Final C# source received from MCP:
`eb62f266835bf42814c3decc224197cb74842fc316428390645d314ca28243a7`.
MCP reported 193 queue/source checks plus 10 restart/callback checks on each
Unity 2022.3.39f1 and 6000.3.21f1, and 101 offline checks per Mono version,
including Rust/C# cross-process lock exclusion. These are not native import-dialog
or exact packaged acceptance by themselves.

## Current evidence

- Hub: final native suite 103 passed, 9 opt-in tests ignored; 114 UI tests and
  13 script tests passed; all-target Clippy passed. The legacy test module was
  moved below runtime items solely to satisfy the all-target ordering lint.
- Setup: 107 native tests plus 2 binary-metadata tests, 59 UI tests, 11 artifact
  checks and all-target Clippy passed. Candidate run 34999682775 failed because
  the no-install guard fixture did not exit; no guard dialog was captured.
  Run 35000700601 (22d3334) adds owned process-tree diagnostics only.
- Final helper presentation smoke: 35 checks each in Unity 2022.3.39f1 and
  6000.3.21f1. Real Unity 6 text Cancel -> retry -> Import passed at
  `artifacts/plugins-presentation-ui-274723ab/interactive-result.json`, preserving
  cancelled/imported receipts, matching text and no active import marker.
- MCP task real C# imports passed compile/reload/reopen in both Unity versions:
  `artifacts/plugins-real-csharp-711a79e8` (6) and `plugins-real-csharp-5f1a75fc`
  (2022) in its checkout. Real ImportPackage(false), not native dialog clicks.
  Its stable candidate run 34999537564 passed upgrades from 2.6 and alpha.1;
  alpha.2 baseline installation failed before candidate installation. Diagnostics
  and exact-binary lifecycle acceptance remain pending; no MCP publication yet.
- Stable descriptor tests: 4 passed. Stable protocol claims require a separate
  `approvedForStable` receipt tied to exact size, installer hash, executable hash
  and GitHub acceptance runs. Prerelease receipts cannot promote stable claims.
- READMEs rewritten for the coordinated versions; old text retained as dated
  history. Windows x64 scope and unsigned publisher status remain explicit.

## Remaining work

1. Retain the earlier intermittent failures as unexplained evidence; both prior
   replay matrices passed without application fixes for those failures.
2. Download the final logo candidates and repeat exact installed upgrade/lifecycle
   checks, without touching installed personal apps or active MCP servers.
3. Bind Hub hosting pins to the accepted companion artifacts; build/test Hub.
4. Exercise exact packaged helper installation/old-helper update through the Hub
   native suite. Real Unity cancellation/retry/C# reload passed above.
5. Sign catalog/update metadata using the existing private key outside the repos,
   never exposing key contents. Publish exact accepted artifacts, not rebuilds.
6. Verify public asset hashes, update discovery and release/tag/source alignment.

No macOS/Linux physical Unity acceptance, unattended arbitrary-project upgrade,
malware-scanning service or headset acceptance is implied.
