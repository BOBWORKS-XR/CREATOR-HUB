# Coordinated stable release status

2026-09-15. The user explicitly authorized stable releases for all three apps.
This supersedes older alpha.8 publication holds. Hub 0.1.0, Setup 0.3.0 and MCP
2.7.0 are now public stable releases. Published binaries are frozen.

## Hub 0.1.5: Public and Latest

Published 2026-09-16 with explicit user approval. MCP remains 2.7.1 and Setup
remains 0.3.0. [Release and full audit](RELEASE-0.1.5.md).

- Revised transparent Plugins icon with larger, lower puzzle corner and indented
  outer edge. Apps opens by default, including the Creator Hub menu entry.
- Build 35090029622 passed 161 UI, 107 Rust and 28 script tests, strict Clippy,
  packaging and clean installed acceptance. Nine opt-in Rust tests were skipped.
- Native replay 35091512400 passed all four installation/upgrade lanes using
  unchanged installer bytes. Its test-only icon correction respected production
  CSP; the first run's failed test reports are preserved, not labelled passed.
- Public self-update 35092200617 passed unmodified 0.1.4 discovery, native Cancel,
  approved update, automatic restart into exact 0.1.5, footer/registry versions,
  retained preference/content, Apps default and exact transparent icon pixels.
- All six public downloads and signatures verified. Latest was promoted only
  after that run; anonymous latest-download metadata matches the accepted file.
- Eleven 0.1.3 diagnostic attachments were consolidated into a byte-verified ZIP.
  Historical installers/updater files are untouched. Current feed is 251,681
  bytes, 10,463 below the legacy cap; no user apps or projects were changed.

## Hub 0.1.4: Previous Stable

Published 2026-09-16 with explicit user approval. MCP remains 2.7.1 and Setup
remains 0.3.0. [Release and full audit](RELEASE-0.1.4.md).

- Primary **Disconnect and update** makes the guarded MCP update flow visible;
  standalone disconnect is a bordered button. Existing native permission and
  process-ownership checks remain in place.
- Exact candidate 35085595417 passed four native installation/upgrade lanes,
  including disconnect Cancel, approved scoped cleanup, install Cancel/retry,
  unrelated Node survival and retained settings/project selection.
- Public native run 35088525701 passed unchanged installed 0.1.3 discovery,
  native cancellation, approved update, automatic restart into exact 0.1.4,
  correct footer/registry and retained preference/unmanaged content.
- All six anonymous public downloads matched the accepted signed files. Latest
  was promoted only after the native test; its download feed matches 0.1.4.
- Six historical release bodies were archived and shortened, not discarded.
  All 148 previous assets are unchanged. The public response is 255,193 bytes,
  below the legacy 262,144-byte cap by 6,951 bytes.
- Initial post-publication feed-read failure and the cancelled stale-assertion
  harness run are retained in the audit, not relabelled as successful tests.
  No user installation, AI setting or Unity project was changed.

## Hub 0.1.3 and MCP 2.7.1 Hotfixes: Public

**Later correction:** the initial 0.1.3 publication made the GitHub release list
too large for installed 0.1.2. The release body text was compacted; all assets
remain unchanged. Real in-app discovery, cancellation, update and automatic
restart from unmodified 0.1.2 to 0.1.3 now pass in run 35079200231. See
[the repair evidence](RELEASE-FEED-0.1.3.md) and
[mandatory future gates](RELEASE-GATES.md). The older untested-self-update notes
below describe the original publication checkpoint, before this new acceptance.

Published 2026-09-16:

- Hub: https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/tag/v0.1.3
- MCP: https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases/tag/v2.7.1
- Project Setup remains 0.3.0 with unchanged installer bytes. Update Hub first.

Hub source/tag is `ea905d90820c7ba721fb68fdf497858292d514cc`. Run 35040103489
passed 144 UI tests, 107 Rust tests (nine opt-in ignored), 17 script tests,
strict lint, packaging and all four native routes. All 26 candidate checksums
matched locally. The accepted installer is 5,998,067 bytes, SHA-256
`c373134d370aeeaca08e9408a581baa862f631c5bb8f3a87dc558e69c3506d0b`;
installed EXE is 13,415,424 bytes, SHA-256
`83a56c6f94f253d7155ac8f236479ce8f5c889ad34a2bf1776498103ee7b4728`.

Native clean, alpha.3, alpha.5 and stable 0.1.2 Hub routes passed. Legacy and
MCP-only routes exercised two private Node connections, Cancel, confirmed scoped
disconnect, unrelated-process preservation and a separately approved update.
Each route discovered public MCP 2.7.1 and Setup 0.3.0 without warnings. Saved
settings, native hosted views and the packaged Unity menu checks passed.

MCP exact installer `4782b6ab04e09a8d24c5fd67d8c75fde8b508d09c04cb1391d953cd51d3aaa66`
is built from `cd0e5c0344955323e34ee12cee452b871002c566`; installed EXE is
`6e1ba9d8d4eee99b35b60c9093efd1b3c19183d2cc184266a0696b8a57b0376d`.
Run 35037253293 passed four historical baselines; replay 35040188482 passed
native Yes/No/Cancel and lifecycle on unchanged bytes. Local Node suite: 250.
Installer interaction and guarded silent installation were tested separately.

All 20 Hub and 16 MCP public asset digests/sizes matched staged files. Anonymous
downloads (five Hub, four MCP) passed application-key verification, installer/EXE
binding and tamper rejection. Hub updater signature and latest-download feed
passed. All 17 old Hub 0.1.2 assets and the MCP 2.7.0 installer remain unchanged.
Hub descriptor minimum is 0.1.0; MCP 2.7.1 requires Hub 0.1.3 for its new binding.

No personal app installation, AI setting or real Unity project was changed.
Full in-app Hub self-update/restart, every AI reconnect policy and physical
macOS/Linux acceptance remain outside these checks. Installers are not
Authenticode signed. Earlier rejected candidates and unexplained Setup discovery
failure remain documented in `MCP-RUNTIME-HOTFIX.md`, not relabelled as passes.

MCP post-push CI found a formatting-only test assertion failure. Commit e5d0ce7
corrects line wrapping and adds the early candidate format gate; no published
bytes changed. Follow-up CI 35041250085 has passed all Node jobs and the Windows
format check; broader source/build jobs were still running at this checkpoint.
They run on GitHub independently of the user PC. Accepted Windows release tests
above are complete. The user requested sleep after publication verification.

Evidence: `artifacts/node-runtime-hotfix/ci-35040103489`, `reviewed-0.1.3.json`,
`release-0.1.3`, `public-0.1.3-verification.json`; corresponding MCP worktree
`ci-35037253293`, `ci-35040188482` and `public-2.7.1-verification.json`.

## Previous Hub 0.1.2 Hotfix

Published 2026-09-16 (local): https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/tag/v0.1.2.
Exact source/tag: `108b016322262eaa5d8b6f2c3177bdb7b8363661`.
Run 35032986083 passed 141 UI tests, 105 Rust tests (nine opt-in ignored), 16
script tests, strict lint, packaging and all four native suite routes.

- Packaged startup displays 0.1.2 and discovers companion apps without a manual
  retry. The project/app discovery race, hard-coded footer and hidden error are
  addressed; app discovery failure no longer skips Hub's own update check.
- Clean/same-version and alpha.3/alpha.5/0.1.1 installer upgrades passed. Native
  MCP/Setup updates passed cancellation/retry and preserved settings. Hosted UI,
  running-app protection and the unchanged packaged Unity helper passed.
- Installer: 5,993,585 bytes; SHA-256
  `a7da62fe16a99beead8872d0b1f185eb0db60ed6253d13f12ff190e89a9d4ef0`.
- Executable: 13,458,432 bytes; SHA-256
  `efa17b33e2abca6a0f2de39996dabf81e98a41052e33b21a25b8b96ffa66b31e`.
- All 17 public asset digests/sizes match. Five anonymous public downloads and
  application trust-key/updater-signature/tamper checks passed. All 17 assets of
  0.1.1 are unchanged. The signed update descriptor requires Hub 0.1.0.
- MCP 2.7.0 and Setup 0.3.0 installers remain unchanged. The user PC was not
  reinstalled; its manual update-check retry restored app discovery.
- Full in-app Hub self-update/restart remains untested. The installer is not
  Authenticode-signed. These Windows checks do not certify arbitrary plugins.

Evidence: `artifacts/hotfix-0.1.2-ci`, `hotfix-0.1.2-release`,
`hotfix-0.1.2-public-check`, `hotfix-0.1.2-reviewed-receipt.json` and
`hotfix-0.1.2-public-verification.json`.

## Previous Hub 0.1.1 Hotfix

Published 2026-09-15: https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/tag/v0.1.1.
Exact source/tag: `37f393bf42ec22bd424c4d6d701dfecb1cd43570`.
Run 35017516816 passed 137 UI tests, 104 Rust tests (nine opt-in ignored), 13
script tests, strict lint, packaging and all four native suite jobs. The tested
installer upgraded Hub 0.1.0 and alpha.3/alpha.5, with same-version/clean checks.
Actual MCP/Setup Apps-row Cancel/retry, protected configuration, native hosting
and alpha.8/stable helper backup/update passed. No user project was changed.

- Installer: 5,991,379 bytes; SHA-256
  `b00a1db327cfaf17689f81a2eec5bc2b9c1e837c067a20039a86c45f139180a3`.
- Installed executable: 13,457,920 bytes; SHA-256
  `0a852411d81c36fa81eb1a06678509a48f7006f940e2eb432f59307e02c48d9e`.
- All 17 draft/public asset digests matched, five assets were anonymously
  downloaded again, and the application trust-key/signature verifier passed
  installer/EXE binding, updater signature and changed-descriptor rejection.
- Public 0.1.0 assets, standalone Setup 0.3.0 and MCP 2.7.0 are unchanged.
  The newer opaque-background logo drafts were not shipped; the existing clean
  Plugins cube appears enlarged in the active-page menu trigger.
- Full in-app Hub self-update/restart remains untested. The signed 0.1.1 feed
  requires Hub 0.1.0; older previews can use the versioned installer directly.

Evidence: `artifacts/hotfix-0.1.1-ci`, `hotfix-0.1.1-release`,
`hotfix-0.1.1-public-check` and `hotfix-0.1.1-public-verification.json`.

## Previous 0.1.0 Checkpoint

Hub 0.1.0 is public/latest at
https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/tag/v0.1.0.
Exact source/tag: `f75947911049c261c8db6f750be0c9e1a3e740be`.
Run 35006894107 passed build, 114 UI tests, 103 Rust tests (nine opt-in ignored),
13 script tests, lint and all four native suite jobs. Installer acceptance covered
clean/same-version and public alpha.3, alpha.5 and alpha.6 upgrades. Native suite
covered clean, legacy, MCP-only and latest-Hub routes using public Setup/MCP.

- Installer: 5,988,479 bytes, SHA-256
  `6a8c36305e5bb573c6fd27be846dca5448b10326f6445f018a193575ce54ff95`.
- Installed executable: SHA-256
  `ab39023374ccf9738bb070089327ddb52337032780c7a9124b87ff2a82e5a2de`.
- Actual packaged menu install/update tested native Cancel and confirmation,
  complete backup, preserved metadata and unchanged fixture project files.
- Real hosted controls, preserved MCP settings/selection, active-runtime update
  refusal, native folder-picker close guard and normal hosted close all passed.
- All 17 public assets match reviewed local digests and sizes. Five public assets
  were downloaded again; application trust-key verification, updater signature
  and tamper rejection passed. No accepted binaries were rebuilt for publication.

Evidence: `artifacts/stable-0.1.0-final-ci`, `stable-0.1.0-release`,
`stable-0.1.0-public-check` and `stable-0.1.0-public-verification.json`.
The separate `release-acceptance.json` records final approval; the original
candidate report is retained unchanged with its pre-acceptance flags. The window
title still says Development Preview, but package/release identity is 0.1.0.
Future in-app Hub self-update and physical macOS/Linux acceptance remain untested.

Next separate update: remembered List/Grid view for desktop Plugins and the Unity
window. Do not amend the stable tag or replace published assets for that feature.
Two Discord posts are requested: MCP-first and Hub/Project-Setup-first, both with
Creator Plugins and the optional Unity window. Setup migration into Hub stays a
later phase. Earlier checkpoint statements below are historical, not current gates.

## Previous checkpoint (superseded)

MCP 2.7.0 is public with 16 verified assets. Public installer name is
`Creator.Works.MCP_2.7.0_x64-setup.exe` (the verified f403da hash below), now
reflected in Hub's pins. The MCP task re-downloaded installer/metadata/signature/
checksums and reverified hashes, signature and tamper rejection. Its tag/master
55fe93e is a docs/test/workflow-only descendant of app-source 5b65478. The tag's
legacy release workflow skipped every rebuild/publish job.

Hub build 35005538731 did not produce an installer: 102 Rust tests passed and one
hosted broken-output test failed at the child fixture exit assertion. The prior
test discarded stderr and did not distinguish a nonzero exit from exceeding its
three-second wait. Both variants and all 103 native tests pass locally. Commit
f759479 adds bounded stderr/status/late-exit diagnostics without changing product
behavior or relaxing that assertion; all-target Clippy also passes. New build
35006894107 from f759479 is running. Preserve the first failed run; do not claim
its cause was fixed or that Hub's final native acceptance has run yet.

Setup's canonical macOS fixture-path and assertion-formatting follow-up passed
CI 35005878626 on Windows, Linux, Apple silicon and Intel macOS, plus the frontend.
These are source/build checks, not macOS/Linux physical Unity acceptance.

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

## Earlier remaining work (completed by the latest checkpoint)

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
