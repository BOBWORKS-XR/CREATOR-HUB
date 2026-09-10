# Local Development Handoff: 2026-09-10

## Latest: Writable MCP Candidate and Larger Projects Open Button

The MCP task owns ongoing work after Creator Works Helper handed over. Do not
resume overlapping edits without coordinating. Detailed checkpoint and rejected
candidate evidence: `artifacts/READINESS-EXECUTION.md`.

Candidate 2: `dist/Creator-Hub-Writable-MCP-Candidate-20260910-2`. Full server and
runtime payload included; 12 file hashes verified. Hub hash `eb5bdd389d747a50f404a88c505368be76c9e16af4ee17b6e59567fd60d9be1c`;
MCP hash `02aef2a13ff2bc50f03ebdb1cedc555007ec20f01ba0f985f5975599f3a7ad99`.
This is not installed, published or native writable-accepted. Candidate 1 failed
a new journal replacement test and must not be used. Corrected source passed
60 MCP Rust tests, 219 Node tests, both UI smokes and strict Clippy; Hub passed
32 Rust and 44 browser tests, with 7 Projects tests repeated after alignment.

Projects Open is a 104x44 minimum cyan icon-and-text action, with aligned columns
and responsive wrapping. Existing launch ID, missing-project and busy guards
are unchanged. The current user-owned Projects-Test window has not been replaced.

Writable MCP is separately hash-paired and consented, with complete payload
verification, existing handlers, settings ownership, session-spanning Hub guards
and local bounded incomplete-outcome warnings. Read-only remains the default.
Legacy upgrade acceptance, actual writable paired tests, state transfer and
installed adoption remain gates. Do not turn source/browser evidence into a
claim that the whole Hub product is release-ready.

## Latest Request: SDK and Unity Updates from Projects

Recorded PROJECT-UPDATES.md and linked it from ROADMAP.md. User asked for easy
SDK/Unity updating from the project page. Source review confirms current Setup
repair deliberately blocks differing SDK references and Editor versions; its
settings backup is not sufficient for broad Unity asset migration. No guards
were removed and no misleading enabled Update button was added.

Design: Hub Updates entry -> Setup-owned read-only inspection and approved
compatibility matrix -> explicit reviewed upgrade of a separate copy -> compile
and reopen validation -> separate project registration. Keep original content,
SDK-family and pipeline conversion separate, block unsupported Git/local/embedded
or shared-path layouts, and preserve current MCP connections. This is planned,
not implemented or runtime-tested. Existing release gates remain unchanged.

## Latest: Projects View and Community Tools Proposal

User requested a project-opening page and reviewed community index, then added
opt-in reuse/sharing of MCP-generated scripts and apps. Community Tools is a
planned second Plugins section. See COMMUNITY-INDEX.md for local draft vs public
submission boundaries, source/repository options, license/test notes, GitHub PR
index and unverified Bonto option. MCP owner recorded matching future scope in
feature docs/future-roadmap.md, behind installer/migration/adoption fixes.

Implemented Projects in Hub: explicit view entry/refresh, known current Hub +
legacy Hub + current/legacy MCP locations, own saved list, SDK package detection,
search/filter, folder picker, list-only removal, exact-version Unity launch.
Reads are bounded (200 roots, 2 MiB JSON, 8 KiB ProjectVersion); no recursive drive
scan. Only the pinned cached Setup Unity CLI beta.9 is used on Windows x64; no
PATH executable or automatic helper download. Missing helper gives an actionable
warning and fallback lists; launching still requires that helper. No credentials
are read, and only project metadata is returned. Mixed SDKs are labelled, not
converted or declared compatible. All-Assets legacy SDK detection is not included.

Project opening accepts only a previously listed native ID, rechecks version/SDK,
requires exact installed Unity, and refuses a project lock without deleting it.
It does not upgrade Unity, install packages or invoke MCP operations. A spawn
result is labelled launch requested, never compile/build success.

Checks: 37 browser tests, 27 Rust tests and strict Clippy pass. The explicitly
run live read test found 62 known locations / 36 declared SDK projects. Actual
native WebView acceptance passed in artifacts/hosted-native-1789060313732:
62 all rows/36 SDK rows, search/filter retention, shell-key protection, unknown-ID
launch refusal, no JS errors, unchanged MCP config hash/size/mtime. Test window
closed normally. No valid Unity launch was requested by that test. Native folder
add/removal and valid project opening remain additional acceptance cases.

First native attempt (hosted-native-1789060248741) caught missing Tauri ACL entries
for the new commands. Fixed both build-time command list and main-window
capabilities, rebuilt from source, then repeated the native test successfully.
Browser mocks alone did not catch that defect.

New local paired preview: dist/Creator-Hub-Projects-Test.
- Hub: 03962fe99aa4cba4de6d4695fd1140d8133f6a40dbe94aa51f34aaaa67438a21
- Setup: 0c4509aab57b5f74b0dd298bebd0fdfaa000c7a1b4bd3bb9714d976621105b6b
- MCP: d32545f84942a43ea0358b5288e62508f9985b067ef45d57a0d8ea8c15b8a2f3

Earlier user-owned Hub PID 86476 / Setup 51072 remain untouched. No installer,
commit/push, tags, release, auth/client config or Unity bridge/project changes.
Historical installed-upgrade matrix and complete Hub adoption remain on HOLD.

Measured current vs legacy Unity registry: 55 vs 48 entries, seven current-only
paths. Existing MCP channels may independently cover some of those; no assertion
that all seven are absent from MCP's combined discovery. Feedback records this
bounded source-specific gap, without dumping private paths or claiming token savings.

## Latest Question: All Historical Upgrade Paths

User asked whether installation/upgrades from any previous MCP were tested and
believed Setup unreleased. Live GitHub confirms eight MCP public tags / 13
Windows installer variants, plus Setup 0.2.2 public at 12:14:13 UTC today. The
new Hub-compatible Setup is unreleased; do not remove the older public baseline.
No actual full installed-upgrade matrix has run. User received the non-installing
preview link and LOCAL-USER-TEST.md. Test-only branch push still not approved.

Added INSTALL-UPGRADE-MATRIX.md and folded in MCP owner's source audit from
`creator-works-installer-hotfix/artifacts/INSTALL-UPGRADE-SOURCE-AUDIT.md`.
Confirmed code gaps: no cross-brand installed-product identity migration; MSI
removal attempt exists but discovered MSI source root is not preflighted; old
BANTWORKS GUI name omitted from guard; no arbitrary portable/multiple-copy
reconciliation; default client homes only and incomplete custom managed-field
preservation. Current config wins over legacy rather than merging project lists.
Prepared 2.6.0-only CI sentinel lacks required auto_start, so it cannot prove
valid first launch. A valid config/first-GUI/client migration fixture is required.
No product code was changed for these findings; do not declare universal upgrade
support or treat safe refusal as a successful migration. No installer executed.

## Latest: Optional MCP Lifecycle Events Passed Natively

MCP owner supplied local commit 277639d, exact 2.7.0-alpha.1 read-only EXE:
`d32545f84942a43ea0358b5288e62508f9985b067ef45d57a0d8ea8c15b8a2f3`.
Old 1615c862... artifact remains intact. No installed app/bridge/client change.

Built `dist/Creator-Hub-Lifecycle-Test` with `-McpLifecyclePreview` and exact
MCP pin. Hub hash `9ccae37f395639de778c8dffcd3112a78a16110c01c5c35e0a42919093632f73`;
Setup portable still `0c4509aab57b5f74b0dd298bebd0fdfaa000c7a1b4bd3bb9714d976621105b6b`.
`artifacts/hosted-native-1789058480012/report.json` passed revision 2 read-only
reply, eight actual lifecycle events sequence 0..7 (idle/busy/idle/draining),
picker busy/close refusal, normal EOF/backend exit, no mutation or Setup command
authority, retained UI and unchanged current/legacy config hashes/size/mtime.
No JavaScript errors. Setup was explicitly skipped, not claimed as a dual test.

Also built `dist/Creator-Hub-Lifecycle-Legacy-Test` WITHOUT the optional switch:
Hub `d1a01e219d5d91abe7ce0e2878a9181490cdabae3f5b09483c48bc7ae7281734`, same MCP.
Report `hosted-native-1789058550242` passed the original empty initializer,
unchanged reply shape and zero lifecycle events, plus the same native isolation,
picker/close, read-only and preserved-config checks. Both owned test pairs exited
normally; the user's earlier Hub/Setup remained open and untouched.

Hub validates event session, actual wire size including newline (512 maximum),
closed field set, states/counts and monotonic safe-integer sequence before
forwarding. Events do not unlock Manager's native operation guard. Initialization
is a build-time-only opt-in (`CREATOR_MCP_HOST_READONLY_EVENTS=1`); normal builds
retain the original behavior. No mutable allowlist or production capability added.
Current Hub checks: 20 Rust passed, two explicitly live tests ignored; 32 browser
tests and strict Clippy passed. The MCP owner's feature counts (219 Node/52 Rust)
are separate from the stable 2.6.1 hotfix counts below.

Still incomplete: session-spanning mutable Hub guard, durable outcomes, UI-state
handoff, trusted adoption/standalone routing, full paired Setup+MCP acceptance,
and clean installed upgrade/interactive Retry acceptance. The stable installer
fix is not yet forward-ported into the MCP feature installer. No release until
that integration and the relevant gates pass; never publish this feature's older
installer hooks just because the read-only EXE passed.

## Latest: Release Audit, Launch Routing and Installer Gates

No commits, push, remote creation, tags or release in this release-audit turn.
Read RELEASE-GATES.md and ADOPTION-CONTRACT-DRAFT.md before enabling adoption.
MCP owner agrees with the contract; its existing final lease command is
`finish_ui_operation`. Full writable hosting is still disabled.

New paired build: `dist/Creator-Hub-Launch-Test`:

- Hub: `971d965b47607cc5e3d23ece14c4a3747b3693142d5df2a34698f7de20646d07`
- Setup: `0c4509aab57b5f74b0dd298bebd0fdfaa000c7a1b4bd3bb9714d976621105b6b`
- MCP: `1615c862759f347aa7c8cfc129155d1ad3ddf25c8e3e57f2e438135660961741`

Hub's official single-instance plugin is pinned to 2.4.4. Only no arguments or
`--open-app mcp|setup` are accepted; these navigate only, never install or mutate.
Native report hosted-native-1789055985436 passed real second-launch routing,
invalid-argument exit 2, MCP read-only isolation, picker/busy close, config hash
preservation and normal child exit. Setup was explicitly skipped because the
user's older Hub/Setup session was still open. Never terminate those sessions.

Cold launch report launch-burst-1789056244398 passed three rounds of four
simultaneous launches with one surviving process each. All owned test processes
closed normally. This is bounded runtime evidence, not an exhaustive race proof.

Real Setup repair passed on disposable project
`E:/UnityTest/CreatorSetupRepair-ReleaseGate-20260910-1`. It restored removed
settings/module/node data, retained the backup, preserved SampleScene and custom
content plus System.Text.StringBuilder VS selection, and passed a second real
Unity validation. Receipt: `.creator-project-setup/backups/1789056035479786600-39192/result.json`.
Observed 31,904 VS nodes / 172 Creator nodes, both build targets available.

Setup installer review found its running-app override ran too late to guard the
old-uninstaller page. Added MUI_CUSTOMFUNCTION_GUIINIT, preserving the existing
non-killing check. No-install native A/B reports in Setup's dist directory:
installer-guard-a7e818e3aa2c4b6fbf53f8c4412eb170 (baseline page reached) and
installer-guard-c64c571fc6d94813b105f31b56b5e22a (exit 10 before page, dialog read,
fixture and existing processes retained). One intermediate driver failure was
incorrect OK-button addressing, not guard failure; the corrected driver passed.
Rebuilt NSIS: `Creator Project Setup_0.3.0-alpha.1_x64-setup.exe`, 2,668,406 bytes,
SHA256 `a7bfbcd484506f3f34b491e6c52cce6007aaf8ade44cd4df8284bd6276623069`.
Not executed against a real installation. It is not a tested installed upgrade.
The extracted NSIS launcher hash is
`9c05267f4271d7e2d46d225c746256cc757c64cb60a19dbf9fe380f4eb4cb5e0`;
its real metadata query passed. This differs from the portable 0c4509... because
Tauri packages bundle-specific metadata; never substitute the portable hash in
an installer descriptor. Extraction is in Setup's dist/installer-candidate-20260910.

Final local source checks: Hub 32 browser/18 Rust, Setup 32 browser/33 Rust plus
two actual-EXE metadata tests; strict Clippy passes both. Four explicitly live
Setup tests and two Hub live tests are not silently counted as unit acceptance.

MCP stable hotfix is separate in `creator-works-installer-hotfix`, version 2.6.1;
the public 2.6.0 path-binding defect is confirmed in both source and decompressed
published payload. Final owner handoff reports 199 Node tests, 23 Rust tests,
24 WinPS checks and a native no-install harness. Node log and candidate hash
were independently checked here. Final installer hash is
`3ff79f7e436d9f032a3300aae989c37475f50dc96a73c6d933f84a42663dfd57`,
26,297,294 bytes; extracted launcher hash is
`c200a14b2ddf9616aa7d676ad03267d01e6be0b9386115ef3fa974631326078c`.
Local hotfix commits aac6075 and 72bd13c, not pushed. Its test-only workflow
windows-installer-acceptance.yml is limited to the exact hotfix branch and
manual dispatch, contents:read, no publication steps. Do not run its real
installation script on this machine or spoof its disposable-runner guards.
Clean installed upgrade and interactive earliest-uninstaller/Retry gates remain.
No Windows Sandbox is installed here. Awaiting user approval for a test-only
branch push to a disposable Windows runner. No release/tag permission inferred
from that CI proposal. Also awaiting normal closure of the user's older Hub for
the dual native-backend test. Full adoption/form transfer/recovery still require
implementation; clearing those two test blockers alone does not finish the Hub.

## Previous: Both App Views; MCP Native Read-Only Acceptance

New source generalizes hosting to per-app sessions with native session-owned
allowlists. New preview is `dist/Creator-Hub-Hosted-Apps-Preview/creator-hub.exe`.
The Setup-only pair below remains intact. Exact hashes:

- Hub: `53dce63aeb4b1b27d8083dff8c3d02e0e24854b62491e4c45d94db1ee2e69768`
- Setup: `0c4509aab57b5f74b0dd298bebd0fdfaa000c7a1b4bd3bb9714d976621105b6b`
- MCP under `apps/mcp`: `1615c862759f347aa7c8cfc129155d1ad3ddf25c8e3e57f2e438135660961741`

MCP artifact comes from the owner's local `f044521` source commit. It is NOT
installed or published. Build using `Build-HostedPreview.ps1 -McpPreview <EXE>
-McpSha256 <exact hash>`; the incoming/copy hash is checked and compiled into Hub.

Passed: 30 browser tests using both real app frontends, including persistent
frames, isolated commands, scoped close, progress and 940/560/390/320 layouts;
16 Rust tests (2 explicitly live tests ignored), strict Clippy, diff checks.
Actual MCP native report: `artifacts/hosted-native-1789054948122/report.json`.
It proves read-only config read, own resource directory, no standalone window,
Setup-command rejection, picker/busy-close protection, view retention and normal
backend exit. Current and legacy MCP config hashes/size/mtime stayed unchanged.

Actual two-backend test remains pending: user's earlier Hub PID 86476 still
hosts Setup PID 51072. Do not close them without consent. New Hub correctly
refused a second Setup backend: `artifacts/hosted-native-1789054989770/report.json`.
Once the user closes the earlier Hub, run `scripts/native-host-smoke.cjs` with
CREATOR_HOST_SMOKE_OPEN=1 and CREATOR_HUB_EXE/CREATOR_SETUP_EXE/CREATOR_MCP_EXE
set to the new pair. Omit CREATOR_HOST_SMOKE_SKIP_SETUP and
CREATOR_HOST_SMOKE_EXPECT_RUNNING_GUARD. Optional fresh Unity creation uses
CREATOR_HOST_SMOKE_PROJECT_PARENT=E:\UnityTest. Never overwrite an existing test.

User's latest concern is Andy's NSIS node.exe write error after uninstalling the
previous version. MCP owner task is inspecting installer/public artifact
provenance read-only. Exact Andy filename/source requested, not yet supplied.
No installer code changed here. Do not claim it is merely an old build or fixed.

Pending production work remains adoption consent/update transaction, full MCP
mutation lifecycle, single-instance shortcut routing, live state transfer,
crash recovery and non-Windows support. This preview is not the finished Hub.

## Previous: Hosted Setup Native Slice

The current work supersedes the launcher-only preview below. Source is in both
repos' `src-tauri/src/hosted.rs`; Setup uses `src/runtime.js`, Hub uses
`src/hosted.js` and `src/native.js`. Read
[HOSTING-PROTOCOL-PREVIEW.md](HOSTING-PROTOCOL-PREVIEW.md) before MCP adaptation.

Current paired binaries: `dist/Creator-Hub-Hosted-Setup-Preview/creator-hub.exe`
and `creator-project-setup.exe`. Build with `scripts/Build-HostedPreview.ps1`;
do not copy unrelated/stale Setup executables next to the hash-pinned Hub.
Native acceptance report `artifacts/hosted-native-1789053161217/report.json`
proves the working hosted view, real requirements, retained forms, no separate
Setup window, native picker, busy WM_CLOSE refusal and clean idle shutdown.

Full native creation also passed: `artifacts/hosted-native-1789053314825/report.json`.
Disposable project `E:/UnityTest/CreatorHostedSmoke-1789053322524` compiled and
reopened/validated with Creator SDK 4.0.14, URP and both build targets. Persisted
validation records 31,818 VS nodes including 172 Creator nodes. Real progress
continued while its Hub view was hidden; closing was refused during Unity work.
Only this new test project and its Unity Hub registry entry were created.

MCP task was explicitly invited to implement its frontend runtime abstraction
and then a bounded read-only hosted adapter in its own worktree only. No MCP
installation, stdio client, bridge or public release changed here.

Important discovered native integration bug: Tauri asset iteration yields
compressed release bytes. Fixed using `Assets::get`, with a compiled-asset
regression test. Mock browser fixtures alone do not cover release packaging.

Native driver uses Win32 enumeration scoped to its exact owned PID/executable,
not whole-desktop UI Automation; native dialog controls can lack UIA patterns.
Host denial/cancellation and runtime acceptance are distinct from driver errors.

Pending release gates: adoption consent persistence/update transaction,
single-instance shortcut routing, live standalone form/result transfer, full MCP
mutation lifecycle, crash/unknown-outcome recovery and non-Windows isolation.

## Product Correction After the Preview

The user explicitly corrected the launcher interpretation. Read
[HOSTED-APPS.md](HOSTED-APPS.md) first: installed apps must appear and operate
inside one Creator Hub window, using their existing settings and installation.
Standalone shortcuts should route into Hub after verified adoption. Standalone
windows/menu buttons remain when Hub is absent. Hosted UI is required now, not
a later extra. The App Manager Preview below is useful groundwork, not that
completed experience. Do not publish it as meeting the corrected brief.

Follow-up clarification: Hub setup must detect existing Creator apps, ask to
"Update and add to Hub", update approved apps if necessary and then adopt them.
No apps found or declined consent means install only Hub. No silent update,
adoption, shortcut rerouting or installation of missing companion apps. Keep a
later adoption action and leave a failed/cancelled update in standalone state.

## Current Request

Working in-app Hub downloads/install/open/update for MCP and Project Setup,
plus Creator Converter with official SideQuest branding. Latest addition:
Creator Plugins, a roadmap-only no-fee community directory. Hosting and optional
SideQuest account linking remain undecided. No account, marketplace backend or
package hosting was created.

## Checkouts

- Hub: `C:/Users/bobman/CREATOR-HUB`, local `ui-preview` branch, no public remote.
- Setup: `C:/Users/bobman/CREATOR-PROJECT-SETUP`, `hub-compatibility`.
- MCP: `C:/Users/bobman/creator-works-hub-compatibility`,
  `feature/creator-hub-compatibility`, coordinated MCP task, commit `14556ef`,
  draft PR33. No stable release or installed MCP was changed.

Hub uses the sibling Setup Cargo target directory only as a build cache:
`CARGO_TARGET_DIR=C:/Users/bobman/CREATOR-PROJECT-SETUP/src-tauri/target`.
Standalone output `creator-hub.exe` is therefore in that target/release folder.
Do not confuse earlier dist UI-only binaries with the new installer preview.

Latest Hub copy: `dist/Creator-Hub-0.1.0-alpha.1-App-Manager-Preview.exe`,
SHA256 `9887bc8d7194ffbea7a8c97cc6477549a00cc19650244ca6bc352f8bdd380f3a`.
Latest Setup copy: sibling `dist/Creator-Project-Setup-0.3.0-alpha.1-Hub-Preview.exe`.
Setup's new NSIS built with its non-killing hook. Neither installer was executed.

## Verified

- Hub: signed authentic descriptor positive test, wrong-app/tamper/invalid
  signature/metadata rejection, version comparison and hash/size checks.
  Final default Rust suite: 12 passing tests, two opt-in live tests run separately.
- Real pinned MCP 2.6.0 and Setup 0.2.2 installer downloads completed and matched
  approved hashes. They were NOT executed. Read-only real Windows inventory ran.
- Hub browser suite: 14 passing tests, desktop/mobile screenshots and logo pixels.
- Setup: 30 native unit tests plus two actual binary metadata tests, 32 browser
  tests. Four explicit Unity/Hub mutating tests remain ignored. New native
  operation/close race tests pass; full Setup native WM_CLOSE fixture still needed.
- Both native sources passed strict Clippy at the pre-packaging checkpoint.
- MCP task: 210 Node tests,32 Rust tests, browser layouts, real isolated Tauri
  lifecycle fixture, metadata checks; new NSIS built and not installed.

## Important Boundaries

Legacy Tauri silent/passive installers and old uninstallers can force-close an
app. Current public descriptors remain installerProtocol0 and lifecycleProtocol0.
Use normal installers for them. Newly guarded MCP lifecycle is close-only,
never server quiescence or an update lease. Hub cannot make an old uninstaller
transactional or retroactively remove its force-kill behavior.

Installed MCP and Node servers remain active locally. A legacy BANTWORKS entry
also exists: automatic replacement is blocked rather than consolidating copies.
An explicit verified app selection may be used for opening only; multi-copy
updates remain blocked. No Unity project, client config or bridge was changed.

Setup public NSIS payload EXE SHA256 is
`23006194bd8214b92c980dc1042466d598d6d1daaed26819ab697d67159db49b`.
Its separately published portable EXE is
`4f6e5d28df2c68eed6fe1193e52aae7a4aa26a215191a79fcabca0890896540c`.
They are not interchangeable installation receipts. MCP public payload pin is
`b712aadd91ac63ea64b5bbead28d7dc2fc83d4102f989999d7ea85b427649676`.

## Remaining Before Public Release

Clean-VM fresh install, adoption, upgrade, cancel/failed installer, actual busy
GUI close/refusal/reopen, repeated Open/startup races and independent MCP server
quiescence acceptance. Native Windows security/installer prompts may still need
user interaction. No full seamless-restart claim yet.

Signed descriptors must join future public releases in both app pipelines.
Catalog private key stays outside repos in LocalAppData/CreatorHubReleaseKeys;
only the public key is embedded. Back up the key before shipping. Key recovery/
rotation and macOS/Linux install backends remain release gates.

Artifact downloads now use cancellable asynchronous streaming. A bounded test
checks cancellation while a network future remains pending. Native installers
are not terminated on cancellation; their normal window remains authoritative.
