# Next Non-Mac Release

User request, 2026-10-19: remove Creator Plugins from the app and release Windows
and Linux, including Flatpak. macOS remains suspended. This is a release plan,
not approval of untested packages or a publication receipt.

## Product Change

- Plugins menu items, retirement pages, app help entries and catalogue asset
  loading are removed from Hub and both legacy module interfaces.
- The former website command permanently refuses; it does not depend on a clock
  or launch a browser. The obsolete Flatpak RPC route is removed.
- Existing Unity projects, imported assets, historical helper installations,
  import receipts and cancellation/recovery evidence are not deleted.
- Historical catalogue/adapter tests now use isolated test-only fixtures.
  The source gate rejects reintroducing the removed app interface.

## Version And Publication

- Public 0.1.14 remains unchanged. Its qualification is Windows-only and binds
  exact previously accepted B05 assets; it cannot approve new source or Linux.
- Never publish private 0.1.15 acceptance-fixture bytes. 0.1.16 is the next source
  candidate; its release and tag were absent when checked on 2026-10-19. The
  version bump does not qualify package bytes. No release tag is created yet.
- Extend finite production qualifications only from actual new evidence, with
  public Windows 0.1.14 as the incoming stable baseline. Do not repurpose the old
  receipt, relabel a test package or bypass the guarded publisher/feed budget.

## Outstanding Platform Gates

1. Windows: exact direct-page installer, migration/retirement, signed incoming
   update and automatic restart against the final new candidate. Local read-only
   page tests do not replace these release gates.
2. Linux DEB: actual system cancellation, authorized signed installation,
   automatic restart and preservation against final production bytes. Production
   retirement is explicitly opt-in and still needs native qualification.
   RPM replacement and the new signed portable updater must not be advertised
   as accepted before their respective actual flow tests pass.
3. Flatpak: qualify disclosure Cancel, owned warm/cold activation, host version
   binding, signed update/reactivation and safe removal. The native-window
   launcher needs separately approved native support. The signed portable host
   path is implemented but not yet qualified on SteamOS; a launcher unit-test
   pass or availability of desktop runtimes does not satisfy that requirement.
4. Publish all requested non-Mac platforms only after their final exact bytes
   pass. Preserve original failed reports and historical release assets.

### Current Evidence, 2026-10-20

- Latest production packaging checkpoint: portable run `39352300183` passed.
  Its original ZIP, seven output files and all 373 transport inventory entries
  were independently checked. The Native Support alias and ordinary AppImage
  are byte-identical. The private qualification manifest/descriptor were signed
  with the existing catalogue key and independently verified; all installation,
  update, restart, migration and release acceptance flags remain false.
- Production Flatpak launcher run `39348943839` passed. The original ZIP,
  exact three files, source binding and imported OSTree inventory were checked.
  This establishes the bundle, not native-host installation or operation.
- Actual private 0.1.17 assembly `39352480021` passed from `75a99ff`; its original
  ZIP and eight output roles were checked. This is genuinely compiled target
  code for outgoing-update tests, not a renamed 0.1.16 binary. It must never be
  published or counted as a completed update/restart test.
- Migration run `39355492887` passed the exact seven-directory CI fixture
  correction, then refused `/usr/share/dict` while checking system package
  metadata, before GUI actions or a retirement transaction. That path's actual
  metadata has not yet been captured; its cause remains unverified. Production
  guards and system metadata are unchanged. Fresh installation, public-0.1.12
  manual upgrade, full migration and signed-update native tests remain open.
- Clean source CI `39349309933` passed all six non-Mac jobs. The Deck is again
  reachable in Desktop Mode with GNOME Platform 50; no Hub installation or
  runtime acceptance on that device is implied. Windows published bytes and the
  user's installed Windows app remain unchanged. No Mac jobs were run.

The entries below retain earlier checkpoints and their narrower scopes.

- The exact Windows candidate passed fresh installation, guarded NSIS upgrade,
  signed public-0.1.14-to-0.1.16 update with automatic restart, and the native
  single-guide migration/retirement scenario. Runs `39323383380`, `39322268458`,
  `39326247460` and `39329339764` bind those separate scopes. Migration checks
  verified exact backups, missing-project import without duplicates, current
  preferences/selection/unknown fields, unrelated client entries, retained old
  runtime and SDK transport reconnects after normal close/relaunch. Controlled
  discovery and SDK clients are not public-feed or actual AI-app acceptance.
- Linux integrated Root assembly `39329425701` passed with the fresh signed
  private payload from `39326776585`. This is the default-off portable host
  prototype, not the new portable updater or a release qualification.
  Native selector/registration run `39330707905` passed 72 Linux tests and
  strict Clippy. Restart-coordinator run `39336614036` passed default and
  experimental Linux tests and strict Clippy after a retained, reproduced
  reset/EOF failure. This does not prove signed AppRun/Root update lifecycles.
- AppDir sidecar `39331187141` completed Tauri bundling but refused GTK's
  `Polkit-1.0.typelib` through an overbroad path filter. The narrow correction
  permits only two regular, non-executable GObject metadata files; privileged
  policies/helpers and unreviewed libraries remain refused. A second narrow
  correction admits only the exact required GIO TLS module. Run `39335641660`
  then refused writable copyright/schema data in the original AppImage. The
  original image and metadata are retained; a transport-only permission
  normalization is being tested without changing system sources or relaxing
  final inventory admission. Complete inventory, ABI and size checks remain open.
- Native Linux pages/deferral runs `39331784190` and `39331788410` stopped in an
  invalid pre-map readiness caller. Corrected runs `39332819755` and
  `39332823259` verified the owned singleton Root and terms acceptance, then
  stopped at a strict dynamic-project-row lookup. Neither original failure
  captured the later UI. Presence-first waiting and independent bounded UI/
  owned bitmap failure captures are now tested. Later runs `39335592008` and
  `39334250739` passed direct pages/normal manual relaunch and guide deferral,
  respectively, using the exact existing package. Preferences, client files and
  projects remained exact; only the two source-required completed read records
  per new Root session were appended in the pages scenario. These are not native
  approval, signed-update, Flatpak or physical SteamOS/EGL acceptance.
- Linux single-guide cleanup is implemented, but production retirement protocol,
  package/policy and native approval/recovery qualification remain open. The
  production protocol, package builder, fixed authentication policy and portable
  updater/recovery controls are implemented. Feature CI `39345006862` at
  `c4bddc4` passed native Linux strict lint and Root tests: 455 host-mode tests,
  474 portable-updater tests and 474 production-profile tests, each with 14
  ignored tests. These are library checks, not installed app acceptance.
- Origin-bound first-install recovery at `f77f29e` passed native Linux run
  `39343572836`: 111 default and 136 restart-enabled library tests, plus selector
  tests and strict lint. Recovery advances only one explicitly reviewed step.
  The final Root caller also passed native compilation in `39345006862`.
  Missing UI command grants were reproduced and corrected at `1d9d7ed`;
  all five command-permission checks pass. A production assembly profile mismatch
  was reproduced before correction at `354b890`; all 27 handoff tests then pass.
- Portable package run `39341933523` completed bundling and original/canonical
  inventories, then rejected a valid ICU data ELF with zero `DT_NEEDED` entries.
  The actual retained library and LLVM readelf output establish a valid dynamic
  section and NULL terminator. The parser correction rejects absent, failed,
  truncated or malformed output; its suite passes 52 tests with 14 Unix-only
  tests skipped locally. Static inspection of all 157 unique packaged ELFs
  passed dynamic parsing. Eighteen desktop host dependencies are now classified
  against pinned upstream exclusion evidence; whole-closure version requirements
  replace the incomplete seven-primary-file analysis. The updated suite passes
  58 tests with 14 Unix-only skips. This is not a runtime compatibility pass.
- The Steam Deck is reachable again at its known SSH address. Read-only checks
  identify SteamOS 3.8.16, GNOME Platform 50 and no installed Hub Flatpak. Its
  linker cache has x86_64 providers for the 18 observed dependencies. Bounded
  readelf captures of 26 host libraries have stable before/after stats and hashes;
  all 65 required host tags and 3,732 attributable strong versioned import
  occurrences are present. Unversioned and ambiguous imports, actual loader and
  graphics behavior remain unverified. No Deck settings or packages were changed.
  Signed selector packaging, final production
  migration/update/restart and SteamOS/Flatpak acceptance remain open.
- Public Linux's incoming baseline is 0.1.12 and needs a manual first upgrade;
  public 0.1.14 is Windows-only. A genuinely compiled private 0.1.17 target is
  needed to prove final 0.1.16's outgoing update flow; an old renamed binary or
  replacement version field cannot supply that evidence.
- The complete browser suite passed 436 tests. Independent review caught and
  corrected ordinary AppImages being trapped in setup before packaging. Only
  the dedicated, exact-version Native Support filename (including bounded normal
  browser duplicate suffixes) selects restricted setup; that hint grants no
  installation authority. Its alias must be byte-identical to the ordinary
  AppImage and both launch roles need real native acceptance.
- Production Root assembly `39345920645` at `c13cb9e` succeeded, reusing the
  original signed 0.1.16 private payload. Data-only inspection `39348205069`
  independently passed the complete production DEB, raw/packaged Root transform,
  source tree, helper/policy/service, resources and both build proofs. This is
  not installation or migration acceptance. The production Flatpak producer
  `39348943839` later passed as recorded above; runtime and lifecycle
  qualification remain open.
- Clean source CI `39329938286` passed all six non-Mac jobs. The existing public
  Windows release and user installation remain unchanged. The existing private
  validation draft is transport only and was not published; no Mac job or new
  public release/tag was created.

## Source Validation

The 0.1.16 source candidate passed 375 browser tests, 950 script tests
(135 skipped), 412 integrated Hub Rust tests (14 ignored), and
304 MCP internal-service Rust tests (9 ignored) on Windows. Strict Clippy passed
for integrated Hub and all release targets of MCP and Project Setup. Logs are in
`artifacts/plugins-removal-20261019`. These checks do not qualify an installer,
signed update, automatic restart, or production Flatpak integration.

The Flatpak launcher version now follows the source candidate. Historical
Windows 0.1.14 qualification tests use explicit 0.1.14 fixtures, and reject a
different source version rather than authorizing new bytes with the old receipt.
Clean Windows CI also caught an unused lifecycle idle query in its isolated
native fixture. The fixture now checks active-workflow and completed-work idle
states; strict release Clippy passes without suppressing the warning.

A separate fresh Windows CRLF checkout passed 928 script tests (132 skipped).
Five explicit LF attributes protect exact Unix protocol/source contracts. The
installed-candidate compatibility workflow now builds its refusal-only helper
before script assertions. The pure archive fixture uses Python's canonical path
spelling, retains inode/device checks, and still proves redirected paths are
refused. These are checkout/test corrections, not Mac platform enablement.

The public Windows baseline registry now includes 0.1.14's published installer
and executable hashes, verified against the release API and descriptor. Newer
targets select 0.1.14; historical 0.1.12 transport and 0.1.14-to-test-only-0.1.15
contracts retain their original explicit scopes. This does not supply the new
candidate's signed-update acceptance.

## Linux Harness Diagnosis

Run 39139434211 failed before approving the Hub update: its generic bitmap helper
refused the legitimate main window plus update confirmation, both owned by the
same Hub PID. Later broker cleanup masked this as Owned process is not live.
This establishes a harness error, not a product crash. Modal-specific capture,
bounded authentication-window capture and original-error retention now pass
38 pure regression tests. Native repetition is still required; the existing
capture-only workflow does not approve system authentication or install updates.

The separate frozen-input full-flow controller now admits system Cancel and one
synthetic approval on disposable GitHub Linux runners. Its 104 pure tests and
workflow/script parse checks pass. Scoped acceptance requires actual package and
executable replacement, product-initiated restart, fresh UI ownership, unchanged
settings/selection and unrelated synthetic runtime, and normal close. Native
complete-flow acceptance passed in the bounded run recorded below. Its private
0.1.15 fixture cannot qualify or publish the new source candidate.

Capture run 39259885862 and native system-Cancel run 39260331976 passed their
finite scopes. Cancel retained the original package, live Hub, settings, selected
project and unrelated synthetic runtime. Approval runs, including 39272042921,
verified the exact private 0.1.15 package/ELF, clean `dpkg --verify`, original
Hub exit zero and a genuinely automatic new Hub process. They have not yet
passed the remaining visible-version, preservation and normal-close obligations.

Post-restart harness corrections retain the exact process/hash/UID/parent,
D-Bus, XRes and renderer checks. X11 may reuse an old numerical window ID; the
new process must independently own it. Accessibility reads use the established
same-frame semantic-parent walker, with an initial canonical frame binding.
The already-bound authentication-agent endpoint is rechecked directly instead
of enumerating unrelated system-bus connections that may close after approval.
Dead processes are never admitted as Hub and no manual restart substitutes for
the application's automatic restart. Original failure reports are retained.

Full source CI 39259888960 and direct Linux library checks 39260921684 passed
at source 69cb13a; macOS was skipped. Subsequent controller-only corrections
reuse the immutable signed product inputs rather than rebuilding those apps.
None of these older-package results qualifies a final 0.1.16 installer.

Run 39273696186 verified the replacement and automatic restart, dismissed the
expected migration offer once, and scrolled the owned footer control into view
without opening its link. It still refused visible-version acceptance because
the current accessibility text reader returned no version text. That original
refusal is retained. The subsequent capture identified the source-bound native
status element; the reader now requires its exact current-version string,
visible state, WebKitGTK interface and the same owned renderer.

Run 39294045915 at test source 607a978 passed the full frozen-0.1.14 to private
0.1.15 native flow: system cancellation and authorized signed installation,
exact package/ELF and clean `dpkg --verify`, automatic restart, visible exact
version, settings and selected-project preservation, unrelated synthetic Node
runtime survival, and normal exit zero. The synthetic account was relocked.
This scoped mechanism pass does not qualify final 0.1.16, Flatpak, legacy-app
retirement or public release discovery.

The new Linux 0.1.16 payload producer, run 39294433900 at source 966f35c, passed.
Its exact original artifact ZIP was independently hash-verified, bound to fresh
run/job/attempt metadata, and the nine-file handoff was signed with the existing
production key. No key material is included. Final native assembly, outer
installer qualification and 0.1.16 install/update acceptance remain separate
gates. The finite 0.1.16 build route does not admit Mac or reuse the frozen
0.1.14 qualification.

The first 0.1.16 assembly attempt, 39297225857, passed signed-input staging but
stopped before native compilation. A profile test inherited the real 0.1.16
branch while exercising the frozen 0.1.14 flag combinations. Commit 3bf0fb8
isolates that historical test context and separately exercises the current
preflight, including invalid event/repository/platform inputs. The targeted
tests pass with the new branch set; production admission was not relaxed.

## New Project And Migration Reports

The 2026-10-19 report shows a duplicated Unity-helper warning on Projects. The
same missing/unavailable cached-helper path can block both current Unity Hub
discovery and launching a known project. Native preparation with explicit
approval, without requiring the old Setup app, is implemented in 86115a8.
Background discovery stays cache-only. Explicit Open can prepare only the
missing pinned registry helper; it does not enable optional AI Unity CLI controls.
Root project/helper tests pass on Windows; actual packaged download consent and
Editor launch still need a disposable native acceptance run.

The direct MCP page had omitted the older per-project SDK/bridge badges and
clear selected-row treatment. Those indicators and `aria-pressed` selection are
restored in 592f988; 34d00ba also keeps the recent-project picker aligned with
the displayed path. Native Home inventory now supplies selection and bounded,
independently checked bridge metadata. MCP mutations invalidate the cached Home
inventory; an idle visible Home refreshes once, including an invalidation during
an older in-flight read. Read-only checks and ordinary navigation do not poll.
The latest focused UI suite passed 102 tests, including narrow/wide screenshots,
in-flight selection, queued refresh and explicit-only retry after read failure.

Integrated migration now has one in-app guide and Move to Hub action, a native
snapshot-bound approval and backup/connection/cleanup progress. Verified paths
reuse the existing writers and exact backups; unsafe/custom settings retain
their specific approval/refusal. Unknown outcomes are not replayed. Two
independent source audits identified and tested corrections for colliding-ID
merge bytes, settings drift during exception approval, and cleanup-start/prior
evidence classification. The final focused re-audit found no additional issue.
This is source review, not packaged migration acceptance.

Default Root passed 439 tests and integrated Root 440 (14 ignored each) before
the final coordinator-only correction. That correction passed 45 integrated
convergence tests (1 ignored). The MCP integrated-service library passed 312
tests (9 ignored); strict Clippy passed for both Root modes and the MCP library
and tests. Permission/legacy-controller checks passed 35 tests. The final full
browser suite passed 399 tests, including all five added cache regressions.
None of these latest product changes is in the earlier Windows installer or
signed Linux handoff below. A new local candidate is required; old evidence is
retained and must not be relabelled as acceptance of the new product source.

The isolated portable deployment primitive passed 41 actual Linux tests and
strict Clippy in run 39299443308. Its first workflow failed before any job because
`runner.temp` is unavailable in job-level environment expressions. That original
failure is retained; a regression now requires step-scoped runner paths. This
library was not wired into Hub at that checkpoint. The later default-off host
and startup boundary is described below; full Flatpak/updater integration is
still incomplete. Real complete AppDir inputs, memory/dependency measurements,
Deck activation, signed update, restart and removal remain required.

## Windows Candidate Checkpoint

The current local Setup-audit installer is
`artifacts/unified/windows-016-setup-repair-20261019/installer.exe`, built from
product source `f9f0e1e5cb27b3ae5178c8aac16429e83ba34593` (37,980,864 bytes).
Its SHA-256 is
`f0092e056f7b4245d10350b7954c3dbe5e5356f2e340143d0aefb80078672bc7`.
Final NSIS extraction and production-key runtime/router metadata verification,
including tamper refusal, passed. The installer remains Windows-publisher unsigned;
it has not replaced the user's installed app. `BUILD-EVIDENCE.json` retains its
original build-time scope. Later disposable-runner results supplement it:

- Fresh native install/direct MCP and Setup pages/settings preservation passed
  run `39323383380`; real guarded public14 NSIS update passed `39322268458`.
- Signed public14-to-direct16 update passed run `39326247460` at harness source
  `a961629cf45d00482a42d11c5fef26f635538606`. Native Cancel preserved public14;
  approval verified signed metadata/installer, exited the old app and restarted
  the exact installed 16 executable. Registry/footer, direct pages, retained
  settings and official-SDK managed-route reconnect checks passed. Temporary
  system trust and WebView policy were restored.
- This used controlled prepublication discovery, not public discovery or live
  AI app/Unity acceptance. The transport served exactly five routes with zero
  policy rejections. Four peer-reset events are retained separately; they are
  not four rejected requests or proof of four distinct connections. Earlier
  failed reports remain preserved; installer and signed metadata were not rebuilt.

Installed migration/retirement, outgoing16 update and complete Linux/Flatpak
acceptance remain open. No public 0.1.16 release or Mac work is authorized by
these bounded receipts.
Later ordinary-SDK fixture edits affect only test source; a normalized comparison
confirms the Setup production code remains equivalent to this frozen build.
Full clean CI `39313928050` at that product source passed, including Windows,
Linux, built-in Windows modules, frontend/scripts and both runtime-router jobs;
Mac was skipped. Native Linux library/helper runs also passed, but are not a
complete Linux/Flatpak install/update/restart acceptance.

The default-off portable Linux host/startup boundary passed native Linux CI
`39323108126`. Its producer now requires an actual new feature-bound Root and
binds the canonical AppDir host profile into its complete signed inventory;
older Root images cannot be relabelled. Full portable installation/service,
update/reactivation/removal and SteamOS/Flatpak acceptance remain unfinished.
The Linux-only payload producer is rerunning from current source because the
previous signed private-module input predates the Setup fixes; its equality
guard is not bypassed. The public Windows build remains unchanged.

Native Linux helper transaction run `39326460876` at `ea9f4d2` passed using the
original MCP and Setup DEBs: both fixed retirements, retained live official-SDK
transport and both reconnect aliases, repeat refusal and eleven settings
sentinels preserved with exact bytes/identity/permissions/ownership. This is
isolated mechanism evidence, not packaged 16 migration, real authentication,
interruption recovery, Flatpak or release qualification.

### Objective Setup Audit

The user requested an objective program audit without further teammate captures.
The exact teammate failure remains unknown, but this audit reproduced independent
defects in the supported existing-URP, first-SDK-add flow:

- Existing Visual Scripting settings/database could skip Creator node setup when
  adding the SDK. First-time SDK addition now invokes the existing
  selection-preserving configuration and subsequent reopen validation.
- An orphan validator `.meta` was not protected, and a manifest edit after the
  backup/progress boundary could be overwritten. Inspection now refuses unknown
  temporary targets; publication rechecks the reviewed manifest through a held
  file, and cleanup checks owned file identities and exact bytes. Changed files
  remain for review. Unix locks are advisory, not a global compare-and-swap or
  power-loss transaction.
- The direct Setup page retained old result/report paths after changing project,
  old installation requirements after a failed creation, and stale transfer
  progress at the start of repair. These states are reset/refreshed without
  replaying creation or masking its original error.

Focused repair tests passed 26 cases (4 ignored), plus both explicitly selected
pre-Unity write-boundary regressions. Strict Clippy passed, including integrated
Hub's full target set. Integrated Hub passed 443 tests (14 ignored). The
direct-page file passed all 83 browser tests. These are source checks, not a real Editor result.
A new opt-in fixture tests plain URP plus existing custom Visual Scripting
selections, first SDK addition, exact backups, protected content and a second
validation-only run. The first ordinary run safely stopped in its seed before
SDK import: this machine's SDK-wide node-cache marker was 3.2.17, not 4.0.14.
Its guard deliberately refused changing that global marker. The exact original
failure and fixture are retained; it is not a successful repair or evidence of
a product failure. A separate `GREENFIELD_PROJECT` experiment failed compilation
because that symbol enables SDK-internal GraphEdit code requiring a modified
Visual Scripting runtime (`GraphPaused` and `BanterStubsAllowed`). Its failures,
fixture and source snapshot are retained, but this is an invalid harness, not
proof of a normal SDK defect. The controlled path is removed rather than
patching the SDK or pinning another package to accommodate it.

The subsequent approved ordinary SDK run passed in 198.82 seconds on Unity
6000.3.21f1 with the pinned recipe. It started with an SDK-free URP project,
an existing node database and a custom `System.Text.StringBuilder` selection.
First SDK addition, configuration, reopened validation and a second
validation-only operation passed. Independent verification checked 31 exact
backup files from each operation, five protected authored/settings files,
the custom selection and removal of the owned temporary files/operation lock.
The external wrapper backed up and read back the original single SDK cache
value before launch, allowed the ordinary SDK initializer to update it, then
restored and verified the exact original binary bytes. No artificial cache
value or SDK-internal define was used. Its 17 mocked guard/wrapper tests passed,
including refusal without a write, incomplete snapshot handling and rejection
of zero selected tests. This accepts the supported disposable project scenario;
it does not reproduce the teammate's unseen project or qualify a packaged
install/update, arbitrary pipeline conversion or Linux/Flatpak operation.

The failed compilation did provide separately verified failure-preservation
evidence: 31 original backup files and five protected content/settings files
matched their pre-operation hashes. The custom Visual Scripting selection stayed
present, all three owned temporary files were removed, the operation lock was
released, and observations retained the original named SDK cache value. This
qualifies that failure path only, not SDK installation or successful validation.
The restored ordinary-probe logic suite passed 16 tests (2 ignored), with strict
Clippy, formatting, LF/CRLF guard coverage and seed compilation passing.

The pinned Visual Scripting implementation also proves `config.Save()` writes
editor preferences as well as project settings. Both setup script and test seed
now save only project metadata before their existing asset serialization.
The new regression failed before this change and passed afterward; both C#
scripts compiled against pinned assemblies. Preference loss was not observed
or claimed. Unity/package-version, registry and render-pipeline compatibility
refusals remain unchanged. Setup does not convert existing materials.

Both source CI39306306556 at be8104e and native Linux direct-feature
CI39307534439 at 939aa80 passed. The bounded Windows script suite passed 1,016
tests (140 skipped) before this Setup batch. Original failed/timeout reports are
retained. A subsequent full script rerun timed out at ten minutes after native
PowerShell-dependent fixture failures. An independent immediate-exit PowerShell
control also timed out with no output. This supports a local startup/environment
problem; no PC settings or source guards were changed to hide it. That repeat
must not be reported as passed. None of these results qualifies a new installed candidate, signed
update/restart or complete Linux/Flatpak flow.

The earlier pre-audit local installer at
`artifacts/unified/windows-016-projects-migration-20261019` contains source
35d99c9, not this Setup audit batch. Its installer SHA-256 is
`22bc9ac8965babf7c26d5578c69207642d165219c5565941a7b685d6e3e14112`;
packaged executable SHA-256 is
`51fb46ec7cd26d39f608db4e77615bebf9e450a7ba693ca84620b1a4134d0701`.
Extraction and production-key runtime/router signature plus tamper checks passed.
It was not installed or launched and is superseded by the Setup-audit candidate
above. The older installer below is retained historical evidence only.

The local 0.1.16 direct-feature candidate built successfully at
`artifacts/unified/windows-016-20261019`. Installer extraction verified the raw
and packaged Hub executable using the documented Tauri bundle-marker change;
the two whole-file hashes are intentionally different. PE ProductVersion is 0.1.16.

- Installer SHA-256: `7229cfcf919dc3a9e27a459fd482cbbe059fd54caa9ad379b2a75c8baa113a20`.
- Installed Hub SHA-256: `7ef27351edefe4545d3e530e8d5c51e7eb3092e7cc7b20498591bfe7456c2389`.
- Raw Hub SHA-256: `f15e54f9da730f48b6a3692a41311e49f2b89db077841ce369622b2ccaf60e0f`.
- Both managed runtime/router signatures passed offline production-key checks,
  including rejection of altered metadata. This is not installer acceptance.
- The installed local app was not replaced and remains at its original hash.
- The Windows smoke now has an exact source-bound 0.1.16 direct-page branch;
  historical hosted assertions remain. The focused combined suite passed 55
  tests. Native-HTTP catalogue capture and actual install/update execution are
  still required. Renderer request/resource checks do not claim native-HTTP proof.
- The historical controlled-lab feed/workflow still selects 0.1.12/0.1.14 and
  cannot be used unchanged for an incoming public 0.1.14-to-0.1.16 test. A new
  finite lab contract must preserve those original fixtures and bind this exact
  new installer before native execution.

No 0.1.16 release/draft/tag was created, public assets were unchanged, and no
local installer was run. Linux/Flatpak production gates remain open.

## Earlier Fixture Diagnoses

Run 39257702384 passed preflight and signed input staging but stopped in the
fixture broker before Hub launch. Read-only diagnostic run 39258494136 confirmed
the GitHub runner's root-owned `/opt` is mode 0777. The exact disposable-runner
ancestry setup now secures that measured directory, preserving owner/inode
checks and the original application's ownership requirements. Native repetition
is still required. Earlier preflight/input failures remain recorded: missing
frozen history in shallow checkout, and a private draft exceeding an obsolete
32-asset count cap. Exact frozen-source fetch and a 256 KiB private metadata
budget replace those assumptions without changing selected signed asset pins.

Run 39258879815 then passed fixture protection and launched Hub; the terms
acknowledgement was verified. It stopped at the navigation worker because the
Root child environment intentionally strips the component-probe opt-in. The
controller now creates a separate worker-only environment with that exact flag;
a regression exercises the real frozen admission contract and proves the Root
environment is unchanged. This remains a harness correction, not update or
authentication acceptance.

Flatpak run 39138975316 stopped at AT-SPI/launcher PID provenance before disclosure
input. Corrected bus-peer/namespace observations pass 35 pure regressions, but
are not accepted activation and do not resolve the separate missing SteamOS
host dependency/packaging implementation.

The first source CI run after Plugins removal exposed two prerequisite gaps:
the Unix writer fixture did not include the real integration-context module,
and the frontend job had not built the refusal-only helper needed by its Node
tests. Both have explicit source/workflow regressions. Superseded hosted-app
Unix packaging is disabled while direct integration is required; Linux source
checks remain active and Mac jobs remain disabled.
