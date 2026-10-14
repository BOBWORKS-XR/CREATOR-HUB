# Unified Update Integration - 2026-10-13

This is development integration, not a release or installed update acceptance.
PR21 and the source publication guard remain held.

## Latest Acceptance Checkpoint, 2026-10-14

- [Windows run38620271427](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38620271427)
  accepts B03 sourcea914bb9: real fresh installation, embedded interfaces,
  native decline/retry, migration/GUI retirement, retained old runtime paths,
  and repeat fresh-profile startup after an explicit save. Installer
  `edc47ecca5e80ce950d5b8ecf6bb32c46fa531e163b9d6ab7722b143a02a4e7a`,
  installed Hub `dd74917a67e360a479158d81149a385ad813da9213661959928543a8f366dfca`.
- Later source7ab0a52 binds review to the retained legacy image and refuses
  unfinished outcomes. Its rebuilt B04 installer is awaiting native acceptance;
  B03's result does not cover this change. The guide now tests an actual restart
  after completed migration, not only a restart after a fresh settings save.
  Root tests: 352 passed, 13 platform-specific ignored; strict Clippy passed.
  MCP tests: 277 passed; Setup packaging scripts: 15 passed.
- [Prepared payload run38621563945](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38621563945)
  passes Linux, Apple Silicon and Intel native product-settings tests at a311810.
  This covers exact old-server recognition and owned test-root alias handling,
  not packaged interfaces, legacy app retirement or signed updates.
- Fresh Mac run38615878801 verifies version0.1.14, package identity and normal
  close on both architectures. Its blank screenshots were captured early,
  at 4.39s/5.65s, before the intended sampler deadline. Cause is unverified.
  [Control run38623617492](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38623617492)
  reuses those exact DMGs without rebuilding, comparing private/ordinary direct
  launch and ordinary LaunchServices launch with measured capture age >=20s.
- Flatpak run38619251453 builds and installs the exact reviewed Linux package
  and passes native linkage. Its retention probe fails because `--sandbox`
  omits app-private XDG mapping. The corrected normal-sandbox read and distinct
  actual14 package replacement are under test in
  [run38624468436](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38624468436).
  This is same-version package replacement, not a future signed update.

All full-product/public-discovery/live-AI-app and release-ready gates remain
false. Unix standalone retirement and Flatpak host integration are still
unimplemented/unaccepted. No user-PC installation or configuration was changed
by these disposable-runner tests. The dated checkpoints below retain earlier
results and do not supersede these distinctions.

2026-10-14 checkpoint: current reviewed Windows source42a35d1 passes actual
first-launch convergence in run38608296824, including native cancellation,
same-length backup/settings drift refusal, reviewed three-client routing,
GUI-only retirement, preserved original runtimes and old/signed-router reconnect.
Run38608917818 repeats this flow and passes real fresh installation, both embedded
module interfaces, explicit settings saves, normal closing and tamper recovery.
Installer SHA256 b3a42b8d67ef94edefa9cefa9e3791a196febb9d88a2163d38dcfed49c09c13d;
installed Hub SHA256 9c52bdee2a53dee1caaa535b0fb40d23e1bdce9ea72fae5e817f9f82dd221ecc.

Run38610890908 passes the same signed installer through the unmodified public
0.1.12 app's actual update button: controlled-feed discovery, native cancellation,
approved installation, automatic restart, version/hash checks, preserved browser
preference/unmanaged content, embedded module reopening and managed SDK reconnect.
`publicDiscovery=false` and `releaseReady=false`: this is prepublication signed
update acceptance, not public-route or live AI-app/model acceptance.

All three fresh signed Unix outer assemblies pass run38607998719 at7eb00ad with
private sourcea517375 from preparation38599976833. No GUI, migration or update
acceptance follows from this build. Fresh packaged Mac version/AX/close diagnostics
are queued in run38613119845 at85ecdb8. The older Mac close-only run38597644861
remains qualified separately. Flatpak run38612495075 verifies actual Linux inputs
and archive members, then fails during SDK AppStream composition before installation.
The original report is retained. Native Mac/Linux migration, full outgoing-view
update restoration, actual AI apps and Flatpak host integration remain release gates.

## Current Target: Unified 0.1.14

0.1.13 is unpublished and is not an upgrade prerequisite. Public Hub 0.1.12
remains the pinned update baseline; earlier 0.1.13 receipts below are historical
regressions, not acceptance of 0.1.14. The settings locations are reused, not
silently relocated, and no legacy application is automatically uninstalled.

The 0.1.14 follow-up protects Setup's invalid/unreadable Editor cache and refuses
unbound AppImage replacement or redirected Linux restart targets. Windows native
installation coverage now includes inactive legacy settings, Setup's cache and
Claude Desktop conversion. See PRODUCT-SETTINGS-PRESERVATION.md and
UPDATER-TARGET-SAFETY.md for exact test scope and open limitations.

Unix single/batch client review, product-settings review and recovery now share
compiled private-module admission. Linux/macOS additionally require the existing
experimental backend feature. The builder has a separate
`--experimental-unix-writable` mode requiring both `--experimental-unix` and
`--managed`; it compiles that backend feature, binds the actual mode and retains
`writableGuiAccepted=false` / `releaseReady=false`. Existing native consent,
workflow, ownership, signed routing and resource checks are unchanged. Default
Unix candidates stay read-only. Source/Windows tests are not native Unix GUI
acceptance and these changes do not authorize publication.

Local Windows checks at this follow-up: 291 browser tests, 183 Hub tests
(11 opt-in ignored), 245 MCP tests (7 ignored), 23 Setup bootstrap tests
(two opt-in ignored), and strict MCP/Setup all-target Clippy passed.
The local unsigned/unmanaged 0.1.14 installer built and its extracted executable
was verified; it was not installed over the user's apps. It cannot stand in for
the final signed/managed, installed update or actual-client acceptance package.

The first 0.1.14 read-only Unix candidate at source
`93e67329b150e1db3d632ea5c999fa6b944f6ad3` passed native AppImage/DEB/RPM and
both Mac architecture package-integrity lanes in
[38457394304](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38457394304).
The earlier Intel DMG failure in 38452354388 remains an unexplained packaging
failure: the succeeding run does not establish its cause. Future failures now
retain verbose subprocess output, the actual signed app and generated DMG script.
No security workaround or re-signing was introduced by that diagnostic change.

[38457384942](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38457384942)
passed Windows fresh installation. Its upgrade lane reached the installed native
inventory, then the negative companion-install probe collided with Hub's correct
startup operation lock. The test now waits only for the exact busy response,
with a deadline; any other result must still match the built-in-install refusal.
The original failed lane is retained. Later experimental-admission source changes
require their own exact package acceptance; this earlier installer is not final.

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
expired before a model/tool call. A fresh retry after the user's sign-in report
returned the same native authentication failure (`live-clients-20261013-06`).
Both installed CLI entrypoints reported `loggedIn=false` through their native
status command. Desktop is now visibly signed in and exposes its existing
Creator Works connector; an authenticated candidate health call is still pending.
No account credentials were inspected or authentication UI automated.
The user subsequently accepted their existing Claude Code/Desktop connections
and supplied a VS Code screenshot showing `creator-works` connected. Current
Claude authentication is no longer waiting for user action. That report is not
an automated post-update tool-call or live Editor acceptance receipt; unrelated
failed VS Code entries are untouched.

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
scripts passed 93 / 1 Unix-permission skip including the minimum-OS
regression. An old atomic-write fixture initially
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

The new Apple-silicon package from run 38329321548 passed exact resource and
ad-hoc signature integrity. Its retained Info.plist was inspected and declares
13.5. Intel verification remains pending; neither is writable GUI, Gatekeeper,
notarization, authenticated client or installed-update acceptance.

The Linux AppImage mutation was reproduced byte-for-byte with the packager's
patchelf operation on MCP, Setup, Node and Hub. A Linux-only opaque archive now
binds the original module bytes before Hub compilation; both package inspection
and Hub use the same bounded Rust TAR/gzip decoder. The retained original Linux
payload passed the native archive/extraction pipe with every raw hash unchanged
and private Node 24.17.0 runnable. That is not a new AppImage package result.

Local integration checks after the archive changes: Hub 161 passed / 11 ignored,
strict all-target Clippy passed, scripts 98 passed / 3 explicit native or Unix
permission skips. Native archive/RUNPATH checks run with their prerequisites in
the packaging lane; archive consumer changes trigger that lane. Manual dispatch
can select one target, while pull requests continue to check all three.

Rust is pinned to 1.99 locally and in the build workflows. Test workflows cancel
superseded per-branch runs; publishing has no new cancellation behavior. The
temporary RPM pull-request diagnostic trigger was removed after capture.

## Exact-Source Follow-Up

All three final source-81e585b workflows passed: general CI 38334244372,
Unix packaging 38334244363 and direct installed acceptance 38334240825.
The retained fresh/upgrade reports pass 19/23 checks and bind installed Hub
`c4dded7e4194a36050bfc84e9a34a5f5491e9f61bf5a42e812bbd5230bdcfc02`.
These remain unsigned direct-installer tests, not signed in-app updating.

Both native Mac reports from the same final packaging run pass exact resource
and ad-hoc signature integrity. Their retained Info.plists each declare 13.5.
Apple-silicon DMG: `1025ef070bfb524c539935be6ed50f9fb790edab1a0ac5a690e7cb4fc41fac52`.
Intel DMG: `0345ee6870f007a4eff8a20a27d25dbc4bcb65cdccbff817de3e55241f07485a`.
Both retain `writableGuiAccepted=false` and `releaseReady=false`.

The public updater test now uses one shared, hash-pinned baseline selection in
its workflow and native harness. Current target 0.1.12 retains historical
0.1.11 coverage; a future 0.1.13 target selects public 0.1.12. Live discovery
must identify that exact previous stable or the test refuses before installation.
Changing this test selection does not prove a signed update has occurred.

The native launch audit at source 81e585b confirmed Unix hashed an ordinary file
and then executed its pathname. The router's headless, single-threaded supervisor cannot
be reused inside Tauri's multithreaded GUI. Linux execution-bound admission and
macOS suspended-child code identity/enforcement must be proven before writable
mode is enabled; resource lookup and GUI consent are separate integration tests.

## Unpublished 0.1.13 Candidate

The development version is now 0.1.13 so a future signed update can exercise a
real change from public 0.1.12. No release or legacy feed was changed.

- Linux built-in launch now snapshots the bounded approved executable, seals a
  memfd and executes that image from a syscall-only `pre_exec` hook. Native WSL
  component tests pass four cases, including 16 concurrent launches, exact
  argv/environment/cwd/stdio, EOF/wait and foreign pathname/in-place replacement.
  They used cached Rust 1.92; native pinned-1.99 CI remains separate.
- Mac built-in launch derives approved CodeDirectories, starts the child
  suspended and checks kernel identity/enforcement before continuing. All four
  previously retained Mac backends have only ad-hoc flags `0x2`; those cannot
  satisfy this new admission. The builder now signs Rust backend copies with
  HARD/KILL before manifest binding. Pinned Node bytes are not re-signed. New
  native Mac fixtures and packages must still pass; this is not notarization or
  publisher-signing acceptance.
- Both Unix built-in MCP backends now receive their resource directory through
  validated private initialization and bind build-verified snapshots before
  consent. This removes dependence on memfd executable canonicalization or a
  nonexistent `.app` Resources layout around the flat internal backend. The
  internal resource binding is not on either public command allowlist; it does
  not bypass consent or enable writable mode. Windows/standalone lookup remains
  unchanged. Captures reject non-regular files and bound growth during reading.
- A loopback-only lab feed has hash-bound snapshots and exactly five GitHub
  routes, without relay, redirects or disabled TLS checks. Unit tests verify the
  producer's plain-text metadata signature versus base64 updater signature. Its
  reports explicitly deny public/native acceptance. VM-only trust setup, a real
  signed target and the unmodified-old-app run remain required; it has not run on
  the user's PC.

OS libraries, publisher trust and arbitrary detached descendants are outside
the GUI executable binding guarantee. Source integration does not lift the
Unix writable or publication gates. Installation/update/GUI acceptance must
refer to the final 0.1.13 package hashes, not the previous 0.1.12 candidates.

## Prepublication Windows Update Acceptance

The exact locally built managed 0.1.13 candidate passed native fresh20 and
guarded `/UPDATE /S /NS` upgrade24 checks in
[38376581718](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38376581718).
Installer SHA-256 is
`c1a259f27283b5b3cc27e2fc2cbf54d7fc4318fb5828e171d62658106adbebdb`;
installed Hub SHA-256 is
`8d52cef4052d064c1ededeaaaaf45c5a403c4c97838617c375e4126679b47f90`.
Candidate product source is `d59c030eb7567bbd5a93c005830d407acfc81b1d`.

[Signed lab acceptance 38384922196](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38384922196)
then used the unmodified public 0.1.12 installer and executable. Its actual
Update Hub button discovered the signed target through a controlled five-route
feed. Native cancellation preserved the running old app; approval installed
the exact candidate and restarted it automatically without a manual launch.
Footer/registry, saved browser preference and unmanaged content checks passed.
Both included backends opened after native consent, and the signed managed
router connected/reconnected with the official MCP SDK, including Creator docs.
System TLS verification and exact temporary VM-root cleanup passed.

This is controlled-feed prepublication acceptance, not public GitHub discovery,
live AI/model or live Editor acceptance, outgoing-update view restoration, Unix
writable operation or release readiness. The user requires all platforms released
together. Original failed/cancelled harness runs remain unchanged, including
38384247618: its app/lifecycle receipts passed but the workflow falsely failed
because the helper had no explicit success exit. The corrected rerun verifies
the independent app receipt as well as the process exit code.

## Unified 0.1.14 Validation (2026-10-13)

0.1.14 is the approved unified target. The unpublished 0.1.13 evidence above
remains historical; it is not the accepted 0.1.14 installer.

The managed Windows candidate from product source
`c44f9b30cf7ca41c27d66fcd3fb41a562e1dca1f` passed actual fresh installation
and direct public-0.1.12 upgrade in
[38463811138](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38463811138).
The retained fresh/upgrade reports pass 21/27 checks. They include inactive
legacy MCP settings and Setup editor-cache preservation, native consent
decline/retry, reviewed Codex/Claude Code/Claude Desktop configuration migration,
exact before-images, idempotence and official SDK tool listing.

The same exact candidate then passed
[38465322506](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38465322506):
the unmodified public 0.1.12 app discovered the signed target through the
controlled five-route feed, retained its executable/settings on cancellation,
installed after native approval and restarted automatically. Installed version,
preferences and unmanaged content survived; both included backends opened after
native consent and the signed managed router connected/reconnected with the
official MCP SDK. Temporary VM TLS trust was removed. No user-PC installation
or trust-store change was used for these tests.

- Installer SHA-256: `76dc1398a5b08200bdf048d6d63a9f85bb7cbdb62629d255c8910a7508d95147`.
- Installed Hub SHA-256: `d0866c2398c2970e3e0716ef1cb62e866f114a7a77b473cfbbb56317ec33d71b`.
- Runtime/router metadata uses the existing compiled trusted release key.
  This is not Windows Authenticode publisher signing or Apple notarization.

The installed Codex CLI also completed a real read-only `get_bridge_status` call
using this candidate's private Node/server and an unopened disposable project.
The Claude Code CLI connected to MCP but its provider monthly spending limit
blocked the model call; this is not a passed tool-call test or an authentication
failure. Neither CLI test proves post-update managed routing or live Editor
operation, and Claude Desktop's actual post-update call remains pending.

Native Mac Intel/Apple-silicon owned-window helpers now compile and pass their
ownership/refusal fixtures in
[38465095134](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38465095134).
The Linux helper binds owned PID/start/executable identity, and supports an
explicit independently pinned sealed-child receipt. Its kernel/pure fixtures
do not establish packaged backend GUI acceptance. Both helpers remain test-only;
missing ownership/accessibility evidence refuses without generic input or kills.

Experimental Unix packaging still has `writableGuiAccepted=false` and
`releaseReady=false`. The new explicit writable producer is experimental and
requires signed managed routing; it is not production permission. Full native
writable operation, migration, signed update/restart, outgoing-view restoration,
actual clients/Editor and Flatpak host operation remain gates. Public discovery
is not covered by the controlled Windows feed. No 0.1.14 release is published.

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
