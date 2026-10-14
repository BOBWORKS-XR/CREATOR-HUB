# Owned Mac Root Surface Probe

`scripts/native-macos-app-probe.cjs` captures the initial Root app's AX roles and
labels on a disposable GitHub-hosted Mac. It is not a terms-acceptance harness,
MCP test, client migration, update/restart test or release acceptance. The prior
availability reports from `38472680551` establish an AX prerequisite for those
helper invocations, not the Root HTML terms/menu contract or this new sampler.

## Caller Preconditions

Main owns the workflow, exact native 0.1.14 package/resource verification, API
proof, independently reviewed `APP_PATH`/installed Hub SHA-256 and signature
carrier. This script does not build, install, download, sign, dispatch or choose
an app. Executable SHA-256 alone does not establish source provenance, resource
integrity, publisher identity or package acceptance.

Both opt-ins must be explicit: `CREATOR_MACOS_APP_PROBE=1` and
`CREATOR_MACOS_OWNED_GUI_TEST=1`. Other admission values must be the actual
GitHub-provided environment: `GITHUB_ACTIONS=true`, `RUNNER_ENVIRONMENT=github-hosted`,
`RUNNER_OS=macOS`, `GITHUB_REPOSITORY=BOBWORKS-XR/CREATOR-HUB`, and `RUNNER_ARCH`
matching native Node/Swift (`ARM64` or `X64`). These checks are not cryptographic
runner attestation. Local/self-hosted/non-Mac/mismatched runs refuse before app
reads or output creation. No successful admission is synthesized by the CLI.

Provide an already extracted, caller-pinned `.app` under canonical `RUNNER_TEMP`.
Only its `Contents/MacOS/creator-hub` may be launched. The executable must be a
matching thin 64-bit Mach-O; universal/unknown layouts refuse rather than guess.
Inputs must be canonical, nonlinked, same-UID single-link regular files. Info.plist
and executable bytes/file identity are pinned before launch and independently
matched to the running process by the unchanged native window helper. A new
output directory must be under runner temp, disjoint from the pinned app, and
not exist; old reports are never replaced or deleted.

## Command And Outputs

After main's package/resource gates, on each matching Mac matrix entry:

```sh
CREATOR_MACOS_APP_PROBE=1 CREATOR_MACOS_OWNED_GUI_TEST=1 \
  node scripts/native-macos-app-probe.cjs \
  --app "$APP_PATH" --hub-sha256 "$HUB_SHA256" \
  --output "$RUNNER_TEMP/root-app-probe-$RUNNER_ARCH-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
```

`APP_PATH` and `HUB_SHA256` must come from main's independent pins, not a newly
computed hash that merely agrees with an unreviewed input. The script prints
JSON containing `report`, optional partial/complete `surface`, optional verified
window-only `bitmap`, `passed`, and the
always-false product acceptance flags. Exit 0 requires complete capture, a
verified normal AX close and this exact spawned child's exit code 0 without a
signal. Otherwise exit 2; preflight refusal is printed without creating output.

The new output retains `plan.json`, `launch.json`, `owner.json`, `surface.json`
when sampling reached that stage, final `report.json`, and numbered tool
`.json`/`.stdout`/`.stderr` files. Intermediate reports and original refusal
output are immutable. `report.json` separates `captureCompleted`, `acceptedExit`,
`ownedChildExit`, `closeError`, `cleanupUncertain` and overall `passed`.
`surfaceSummary` records role counts and whether an AXWebArea was observed.
`captureCompleted` now also requires an owned Root AXWebArea and preserved native
CF window reference in the readiness receipt. It does not accept terms/menu
targets or product GUI flow. Partial snapshots remain in `surface.json` and
original tool output on timeout/refusal.
All final report product flags remain false: `nativeGuiAccepted`, `mcpAccepted`,
`migrationAccepted`, `updateAccepted`, `releaseReady`.

Main should upload the explicit JSON/tool evidence with `always()` even on
failure, separating ARM64 and X64 and recording the supplied package/API evidence
beside it. Do not upload `private-home`, Root stdout/stderr, account material or
unrelated runner data. These disposable profile/log files remain on the runner;
the probe never reads them or cleans up original evidence. Retain preflight
stdout in main's separate job log when no output directory could be created.

## Capture And Cleanup Contract

At runtime the probe compiles a byte-exact copy of the current
`native-macos-window.swift` into the new output, with no fixture define or source
edits. That one pinned binary handles availability, identification, before/after
inspection and the single normal-close attempt. It is never recompiled during
the probe. Compiling tools is not building the Hub package.

The action helper intentionally reports only fixed native-consent controls.
An embedded, separately compiled **read-only** Swift sampler therefore records
Root roles and bounded AXTitle/AXDescription labels; it contains no action API.
It must independently have existing AX trust; trust from another binary is not
transferred. Both trust checks occur before launching Root, without prompts or
OS-policy changes. Sampler source/binary identity and all compile output are
retained in the owned directory.

Exactly one Root executable is spawned directly, with a new empty disposable
HOME/CFFIXED_USER_HOME, Library folders, XDG profile/cache paths and TMPDIR. The
Root environment is allowlisted, not inherited from real client profiles. No
client configs/accounts are read or deliberately written; no settings, terms
or feature controls are clicked. The app may make its own first-start writes
inside this disposable profile. No companion app is launched by the probe.

Identification waits at most 20 seconds for the owned child and exactly one
showing window; multiple windows refuse rather than select by title or order.
Native identity binds the app bundle ID/path, executable/Info.plist file pins,
PID/start stamp/UID and CG window ID/bounds. The sampler additionally verifies
the kernel parent is the probe process. Every visited AX element must belong
to that PID and descend from the uniquely bounds-matched Root window. Capture
is bounded to 512 elements, depth 16, four seconds per observation and 2048 bytes
per label. Readiness waits at most 20 seconds and 32 observations. A Root-only
AXObserver watches public layout/creation notifications. The run loop waits on
notifications or the deadline, not a guessed settle sleep. Only changed node
snapshots are retained. The original Root window CF reference stays held and
must compare equal to the uniquely bounds-matched window on every observation.
`nativeRootSnapshot` retains that initial process/window pin in success or
partial failure output; it is not a claim of current identity after failure.
Unsupported notifications, missing owned AXWebArea, foreign PID or changed
Root reference remain failures; no readiness condition authorizes an action.
Labels are emitted only for noneditable roles with positive bounds inside Root;
editable values, AXValue, other apps and the global AX tree are never read.
Missing titles/descriptions are observed limitations, not invented labels.
WebKit elements exposing a different PID refuse: do not relax ownership to
obtain a prettier capture. This first capture does not assert that terms/menu
labels or future action targets exist.

Only the helper's `close` command may attempt cleanup, once, with
the pinned owner and binary. No activation, clicks, terms approval, signals,
kill, terminate, AppleScript, TCC/Gatekeeper change or fallback is available.
If terms block closure, the app is inactive, the helper refuses/post-identity is
unverified, or the exact child does not exit 0 within 15 seconds, the run stays
failed. An exit 0 alone never converts a refused close into acceptance. A live
child or timed-out tool is recorded as cleanup uncertain and left to disposable
runner lifecycle; no automatic retry or termination is attempted.

Primary contracts: [Apple AX children](https://developer.apple.com/documentation/applicationservices/kaxchildrenattribute),
[AX trust](https://developer.apple.com/documentation/applicationservices/1460720-axisprocesstrusted),
and [XNU parent/start identity](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h).

## Actual Run And Diagnostic Follow-Up

Original run `38477465791` remains failed on both architectures, retained under
`artifacts/mac-root-probe-38477465791-arm/root-app-probe` and the corresponding
`-intel` directory. Both tools compiled and both availability checks passed.
ARM captured eight native shell nodes, no AXWebArea, then child6406 exited0
without a signal. Close returned exit3, `actionAttempted=true`,
`postIdentityVerified=false`, `process-start-drift`. This establishes the exact
owned child's exit, not verified post-close identity or Root HTML GUI flow.
Intel inspect/close returned exit2 `foreign-ax-element`, no action/surface and
uncertain cleanup. Its missing PID/role cannot establish WebKit attribution.

Under the explicit Root probe opt-in only, the first refused element already
returned by Root AXChildren gets diagnostic PID/role/path, one-level AXParent/
AXWindow linkage and that PID's kernel parent/UID/start metadata. No foreign
children, titles, values or global discovery are queried; traversal stops.
Root process/window/native CF reference are independently fenced before/after.
`rootStillOwned=false` means that fence is unverified. Original refusal output
is retained; the caller additionally retains only the first diagnostic in
`foreign-element.json`. This does not grant input authority.
[AXUIElementGetPid](https://developer.apple.com/documentation/applicationservices/axuielement_h)
reports an object's associated PID, not permission to act on another process.

Post-close failures still return exit3. New `postProcessStatus` distinguishes
ESRCH absence, the same kernel start/UID, a different/reused process and an
unavailable observation. The old generic `process-start-drift` stays `unknown`.
See [Apple's libproc wrapper](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.c).
`report.closeAssessment.callerOwnedExit0` separately requires the exact spawned
PID's exit0/no-signal event. Absence or exit0 cannot promote an exit3 receipt.
Successful close acceptance now also binds complete before/after Root identities
and the owned exit. Unknown output, PID reuse, partial identities and refusals
cannot pass. No blind close retry is added.

Smallest next native test: run the same pinned Root once per architecture into
fresh output. Keep `foreign-element.json` if emitted, original inspect/close
stdout and tool exit codes, `surface.json` with changed snapshots/notification
readiness, and `report.json` with exact child exit/separate close assessment.
ARM should explain readiness or retain its bounded failure; Intel should identify
the first refused child without entering it. All product flags remain false.

## Window-Only Bitmap Diagnostic

Run `38480897377` compiled on both Macs. ARM reached the 20-second readiness
deadline with eight native chrome nodes, no AXWebArea and no AX notifications;
its close stayed exit3/unaccepted despite caller exit0 and post-kernel absence.
Intel's first foreign child at `window/0/0` was AXGroup PID3070, UID501, kernel
parent1. Its native parent/window linked to Root3060 and the frozen Root CF
references were unchanged. Originals remain in
`artifacts/mac-root-probe-38480897377-{arm,intel}`. These observations do not
establish visual blankness or authorize foreign AX input.
[WebKit bug297546](https://bugs.webkit.org/show_bug.cgi?id=297546) and
[PR49539](https://github.com/WebKit/WebKit/pull/49539) document a remote-AX
mechanism consistent with the Intel linkage. That is context, not proof of this
foreign executable's identity; no private API from that change is injected.

The next diagnostic attempts one bitmap before normal cleanup, including when
strict AX inspection/readiness failed. The same compiled read-only sampler
has a `bitmap-fence OWNER_FILE PROBE_PARENT_PID` command. After the unchanged
real-GHA/repository/native-architecture/opt-in guards, it checks
[CGPreflightScreenCaptureAccess()](https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess%28%29).
False returns a denial receipt without inspecting pixels or invoking capture.
Unknown/refused output also prevents capture. No permission request API, TCC/
Gatekeeper change, prompt, global AX discovery, activation or input is added.

With existing permission, the bitmap command independently validates the saved
Root PID, kernel parent/start/UID, executable path/hash/file identity,
Info.plist identity, exact CG window ID/owner/visibility and frozen bounds. It
does not enter AX children and cannot authorize any AX action. The caller runs
the exact-window-only noninteractive command once:

```sh
/usr/sbin/screencapture -l EXACT_OWNED_CG_WINDOW_ID -x NEW_OWNED_PNG_PATH
```

No interactive, full-screen, rectangle, alternate-window or retry mode exists.
Output is only the new private `window-bitmap/root-window.png` within the fresh
probe directory; existing output refuses. The same native permission/Root/CG
fences run again after capture. Failed CLI status, unknown permission, changed
PID/start/hash/bounds/window ID or missing post-fence cannot verify the image.
The PNG is capped at 32 MiB, checked for PNG/IHDR metadata and positive bounded
dimensions, hashed and made private. Header checks are not pixel/render proof;
Retina scaling/window shadows can differ from point-space CG bounds. Before/
after fences detect observable drift, not an atomic window-server transaction.
Preflight is a current sampler observation, not a guarantee that the separate
OS capture tool succeeds; an OS refusal has no permission-changing fallback.

New receipts: `report.json.windowBitmap`, `window-bitmap/receipt.json`, numbered
`bitmap-fence-before`, `window-bitmap` and `bitmap-fence-after` tool receipts,
and the PNG only if capture was attempted. A false preflight has
`attempted=false`, `completed=false`, reason
`screen-capture-permission-unavailable` and no PNG. `completed=true` means the
window-only capture/file/identity checks completed, not that the pixels show a
working frontend. It never changes the original AX/readiness/close error,
`passed` logic or any GUI/MCP/migration/update/release acceptance flag.

The invocation is unchanged. Main owns upload wiring: retain all JSON/tool
refusals with `always()`, but upload the PNG only when
`report.windowBitmap.completed === true`. Failed/unfenced partial PNGs remain
private on the disposable runner, never a trusted Root artifact. Continue to
exclude profile/Root logs. No native screenshot was executed by local tests.
Smallest next test is one fresh caller-pinned run on each Mac and visual review
of only the verified PNG, distinguishing visible Root HTML from a blank window
without treating either result as full product acceptance.

## Tests And Remaining Gates

Run 38561264659 at `840d1e8` reaches the read-only sampler on both native Mac
architectures. Root-only before/after inspection succeeds on each. ARM still
reports `root-web-area-readiness-unverified`; Intel reports
`ax-children-unbounded-or-unreadable`. These are unaccepted captures, not proof
that the app's rendered frontend is broken. Reports are preserved under
`artifacts/mac-root-probe-38561264659/`.

The next diagnostic adds one bounded `errorDetail` for the refused children
operation: actual numeric AX status, count/type, timing and cached role/depth/PID.
It keeps the original error, deadlines, action helper and false acceptance flags.
There is no fallback read, retry, permission change or action-authority relaxation.
Local JS/guard fixtures pass; native compilation/runtime remains pending.

The ARM close evidence in run 38563802054 records one Root-owned close AXPress,
result zero, then caller-owned PID 1948 exiting zero without a signal. AppKit
metadata inspection was rejected during termination; kernel absence afterward
was recorded as diagnostic only. The helper now has a separate
`native-termination` postcondition. It keeps `postIdentityVerified=false`, never
fabricates a live `after.process`, and requires matching images/path, exact
unfiltered CG-window absence and two definitive kernel absences. Caller acceptance
also requires its original child to exit zero without a signal. Old arbitrary
errors/PID disappearance still cannot pass. Whole-tree/consent action authority
is unchanged; Intel remote-child close selection remains refused. Native runtime
validation of this changed helper remains pending.

Run 38572700956 compiles the new helper and its SDK fixtures on both Mac targets.
The ARM close still returns `process-start-drift`, followed by exact owned-child
exit zero and kernel absence. The final live recheck previously conflated a
failed/missing kernel read with actual drift. It now captures bytes/errno and
uses the same exact kernel classifier: only definitive absence becomes
`expected-process-absent`; start/UID/PID drift and unavailable reads still refuse.
Generic drift is not whitelisted. No retries, timing or pre-action authority
changed. Twelve additional distinction fixtures were added; Windows ran source
guards only and skipped SDK execution. Intel pre-action foreign-element refusal and
missing Root WebArea remain separate gaps.

Run 38575009554 at `b6042b1` accepts ARM's normal Root termination with the exact
caller-owned exit zero and distinct native termination receipt. Live identity
remains false, honestly. ARM still lacks the WebArea capture. Intel completes
the Root surface capture but its unchanged whole-tree close selector refuses a
foreign descendant before acting. These separate results do not constitute
writable GUI, migration, update or release acceptance; those flags remain false.
Reports are retained under `artifacts/mac-root-probe-38575009554/`.

The next checkpoint adds a Root-only close selector with the explicit finite
`root-standard-window-first-order-native-dialogs` tri-state described in
[the helper contract](MACOS-NATIVE-WINDOW.md#root-close-only-scope). It does not
traverse the nested Intel remote content or authorize remote input. Present or
unknown native dialog/sheet coverage refuses; the caller rejects missing or
malformed scope evidence even with exit0. Original receipts remain unchanged.

Next native run, without workflow changes: use the existing Root-surface Intel
and ARM matrix with the reviewed source revision. First run
`node --test scripts/native-macos-window.test.cjs scripts/native-macos-app-probe.test.cjs`
on each Mac SDK. Only if those fixtures/compilation pass, run the existing
caller-pinned Root probe once per architecture, retaining helper source/binary
hashes, normal-close stdout, `closeDialog` proof/refusal, live/termination
postcondition, and exact `ownedChildExit`. Intel success requires Root capture
plus normal close and original exit0/no signal. ARM's missing WebArea remains
a separate capture gap even if normal close succeeds. Do not widen the scope,
change timing, retry actions, or claim native product acceptance from the hash
pin or fixture results.

```sh
node --test scripts/native-macos-app-probe.test.cjs
```

Tests exercise admission/refusal, independent pin/owner drift, fresh profile,
accepted-exit requirements and read-only source contracts with synthetic files.
On macOS a separate test compiles the sampler and exercises a pre-AX local
refusal without launching any app. Windows skips that native compile case.
No synthetic test establishes Root AX mapping or native package provenance.
Actual Mac Root capture/normal closure, direct14 native GUI, MCP, migration and
signed native update/restart acceptance remain separate TBD gates.

## Actual Run 38597644861: Component Results Only

The diagnostic/helper revision is `829238e`, but both input app packages remain
the old experimental artifacts (parent identified as **0.1.13**) from run `38463917023`, source
`8ba08a390ce888ea8e478cbcc79f52d7ca73587b`, build `5283fd05252d6bbe3253d41ded4064ec50cddbc7`.
This is not a current 0.1.14 app capture. Evidence is retained under
`artifacts/mac-root-probe-38597644861/{intel,arm}/root-app-probe/`; the separately
downloaded bitmaps are under each architecture's `bitmap/root-window.png`.
Version qualification: the bound source's `tauri.conf.json` declares 0.1.14,
while these native receipts pin Info.plist bytes without exposing its embedded
bundle version. The artifact audit therefore verifies the exact old input
hashes, not an independently read native 0.1.13 version. Fresh current14 capture
must retain the embedded bundle version as well as its source/build/image pins.

Component-level observations, not new product acceptance flags:

| Component | Intel | ARM |
| --- | --- | --- |
| Native helper/sampler compilation receipts | exit0, no signal | exit0, no signal |
| Root-only read-only inspection before/after | complete, held Root CF preserved | complete, held Root CF preserved |
| Finite native close-dialog scope | absent, windowCount1, childCount5 | absent, windowCount1, childCount5 |
| Exact normal Root close and original child exit | accepted, PID4873, code0/no signal | accepted, PID2718, code0/no signal |
| Separate native termination postcondition | verified; live identity false | verified; live identity false |
| Exact-owned-window bitmap capture | complete | complete |
| AX document/surface capture | refused | readiness unverified |

The parent reports native SDK fixtures passed on both architectures. The local
artifact review independently verifies both compiler receipts, close stdout and
report bindings. Both termination receipts retain the original expected process
and window, verified image bindings and window absence, and two kernel reads
with bytes0/errno3. Neither forges a live `after` identity. The reviewed helper
source SHA256 is `212a8c94149d159da69c4161220333969fbc71bd555ee951c26d9ff04bae2a68`.

Both PNGs are 1052x692 and match their receipts: Intel 226195 bytes/SHA256
`66e27f5ce8980a8e7737f07216ea03a58a0dfcd99c31716d9fdea556c2329426`;
ARM 234136 bytes/SHA256
`de889102948528efe52647f1aa5c28098b89142db3d065cb134aecedbd9599aa`.
Direct visual inspection shows a centered terms modal, rendered Hub content and
the macOS label on both. This establishes nonblank rendering for these exact old
inputs only, not current14 or operability. Finite **native** dialog absence does
not assert absence of the visibly present HTML terms modal.

The overall report still has `passed:false`, `captureCompleted:false`,
`acceptedExit:true`, `cleanupUncertain:false` and error
`root-surface-capture-unverified` on both. All native GUI/MCP/migration/update/
release acceptance flags remain false.

### Precise Surface Failure And Remaining Unknowns

- Intel: sampler exit2/no signal/not timed out, error
  `remote-ax-parent-unverified`, only Root AXWindow and Root AXGroup retained,
  no completed snapshot. The rejected remote node/path/PID, AXParent status,
  returned CF type, parent CF equality and initial/post-read phase are not
  emitted. `attr()` collapses unsuccessful reads to nil, and `remoteLinks()`
  reports the same refusal for missing/error/wrong-type/unequal parent links.
  The remote containing-window result is also not emitted. Association remains
  unknown; refusal is correct. No remote action is authorized.
- Intel's sampler source SHA256
  `1303c22e19b70ac88aba5a7180d0ec19ad7d5dee8a926d03220533075ada74cc`
  and app image hash are unchanged from run `38575009554`, which captured 34
  nodes including a WebArea. A sampler-code regression is not established;
  the cause of the differing native association result remains unknown.
- ARM: sampler exit2/no signal/not timed out, error
  `root-web-area-readiness-unverified`. Its 20-second readiness deadline expires
  with observerStatus0, one observation/changed snapshot at revision0, seven
  Root-owned window/chrome nodes and no AXWebArea. No relevant notification
  produced a second observation. The child helper also maps native no-value/
  unsupported status to an empty list, so the receipt does not distinguish an
  empty content container from unavailable AX children. It cannot prove a blank
  app, a permanently absent document, or broken terms/navigation.

### Smallest Next Capture And Driver Contract

First use exact fresh **current14** Intel/ARM candidates with source/build/artifact,
executable and Info.plist pins and disposable profiles; do not relabel these old
inputs. Retain the same Root fences, bitmap and close/owned-exit receipts. A
future authorized metadata-only sampler change should retain the original
refusal and capture numeric AXParent/AXWindow read errors, CF types, native link
equalities, rejected node path/depth/PID and initial/post-read phase. ARM also
needs actual content-group child read status/count and notification revision,
not empty-list inference. No extra authority, action, blind retry or longer
deadline follows from this diagnostic contract.

An owned AX document route remains read-only until exact native associations and
control mapping are proven. Even a successful remote read association is not
authority to press its checkbox/button; the existing consent helper is unchanged.

The native WebKit inspector is not an established driver for the unchanged
current release. Apple's [inspectable-content contract](https://developer.apple.com/documentation/safari-developer-tools/enabling-inspecting-content-in-your-apps)
requires app opt-in (default false). The pinned Wry 0.55.1 source enables it only
under debug/devtools with the corresponding webview setting; current Root Cargo
features do not enable devtools. [Tauri's inspector guide](https://v2.tauri.app/develop/debug/#using-the-inspector-in-production)
likewise distinguishes debug/feature-enabled builds from ordinary release inputs.

If AX exposure remains unavailable, a source-supported alternative is a separate,
test-only [embedded Tauri WebDriver](https://v2.tauri.app/develop/tests/webdriver/)
diagnostic build. The documented Mac route requires an embedded app plugin;
external `tauri-driver` does not attach to an unchanged Mac WKWebView. This is a
proposal, not an installed or validated driver. Before implementation, review
exact plugin versions/session isolation and native binding to the caller-owned
Root process, main webview and held native window. Do not expose a production
endpoint or substitute title/PID/name/UID alone for that binding.

The first driver contract is read-only: unique visible
`#usage-terms-dialog`, terms version, checkbox unchecked, continue disabled, and
the pinned current14 document. A later separately authorized test may exercise
ordinary checkbox/button and navigation interactions through their real
handlers, observing native persistence and resulting UI. No mocked IPC, direct
`accept_usage_terms` call, storage seeding, checked-state assignment or CSS-modal
removal may replace consent. The instrumented build's navigation result remains
distinct from unchanged-package/native product acceptance. No code, build,
workflow dispatch, commit or push was performed during this artifact audit.

## Fresh14 Diagnostic Receipt Contract

The sampler now retains the original remote-link refusal plus a bounded
`errorDetail.kind=remote-links`: initial/post-metadata phase, cached node
path/depth/PID/Root PID/window ID, and the actual AXParent/AXWindow error,
messaging-timeout error, elapsed time, returned/expected CF types, value presence
and CF equality (null when not established). It uses the existing two native
attribute reads, never a fallback read or action. Peer/process/role/CF fences,
20-second readiness and 4-second traversal deadlines remain unchanged.
`axDiagnostics.childObservations` separately retains zero/no-value/unsupported
child-count results from the latest traversal, at most32 with an explicit
truncation flag. No-value/unsupported is not a verified zero count. These fields
are diagnostic facts, never ownership, absence or action authority.

After owner identification, `package-identity.json` records the actual
CFBundleIdentifier, CFBundleExecutable, CFBundleShortVersionString and
CFBundleVersion. XML/binary Info.plist is parsed from the same bounded descriptor
bytes whose hash/device/inode/size were checked against the owner, between
unchanged native Root fences. Missing/numeric/boolean/malformed version values,
owner/CF/image drift and an unexpected requested version refuse; there is no
source-version or display-title fallback. The action helper is unchanged, with
reviewed LF-normalized SHA256
`212a8c94149d159da69c4161220333969fbc71bd555ee951c26d9ff04bae2a68`.

The legacy CLI still records actual package identity but source coverage is
explicitly unresolved. Fresh signed assembly diagnostics add all three options:

```sh
node scripts/native-macos-app-probe.cjs \
  --app "$APP_PATH" --hub-sha256 "$HUB_SHA256" --output "$RUNNER_TEMP/root-app-probe" \
  --expected-version 0.1.14 \
  --assembly-receipt "$RUNNER_TEMP/package-proof/signed-unix-assembly.json" \
  --assembly-receipt-sha256 "$ASSEMBLY_RECEIPT_SHA256"
```

The receipt must be the existing canonical `signed-unix-assembly.json` schema,
outside the app and inside runner temp, independently hash-pinned, bounded16KiB,
and architecture/version matched. The report retains `assemblyCommit` separately
from the private payload's source/build/tree/run/attempt and handoff hash, and
records the probe checkout independently. These are caller-hash-bound metadata,
not a new signature or artifact-to-executable proof:
`artifactToImageBindingVerified:false` remains explicit. The parent must retain
its independently checked artifact/package-to-image binding. No key is read.

### Parent-Owned Fresh Workflow Hooks

Run `38607998719` assembles the outer source `7eb00ad` with private signed source
`a517375` from run `38599976833`. Its no-bundle outputs alone are not an `.app`.
No workflow or build was changed/executed by this diagnostic task. To obtain a
real current14 capture, the parent needs these bounded hooks:

1. Pin the successful matching Mac job, run/attempt/source, artifact ID/size/ZIP
   digest and existing assembly receipt. Do not reuse the old run38463917023
   candidate bindings or substitute the probe checkout SHA for package source.
2. On each matching Mac runner, use the existing verified nine-file signed input
   staging and handoff hash. **Packaging must run in the already admitted
   `.github/workflows/unix-managed-assembly.yml` job**, because the builder
   checks its exact workflow identity and clean source. A standalone Root probe
   workflow cannot invoke this builder under current admission; do not spoof
   `GITHUB_WORKFLOW_REF` or widen admission. Either append the Mac probe hooks
   to that assembly job, or let a separate probe lane consume its packaged app.
   The existing signed-assembly command needs the
   supported `--installer` option to produce and validate an actual native app:

   ```sh
   npm run build:unified -- ci-mac-root-fresh014 --installer --managed \
     --experimental-unix --experimental-unix-writable \
     --signed-unix-input "$RUNNER_TEMP/signed-unix-input"
   ```

   Keep the existing assembly admission, trusted signatures, private-source diff,
   resource/hash/mode and native package checks. This compiles only the outer;
   do not reconstruct an app from raw `creator-hub` or fabricate Info.plist.
   The resulting assembly commit belongs to this packaging run, not necessarily
   7eb00ad; the private source must remain the exact verified a517375 inputs.
3. Stage the actual validated app in a new disposable runner-temp directory and
   supply its independently bound bundled executable hash, not an assumed hash
   from the no-bundle binary. Stage/hash-pin its assembly receipt separately.
4. Run both Mac JS test files on the SDK first, then the fresh CLI above with the
   unchanged two hosted opt-ins. Retain `package-identity.json`,
   `assembly-receipt.json`, report source identities, surface detail/child
   observations, exact-owned bitmap and normal-close/original-child exit proof
   even when AX readiness refuses. All product acceptance flags stay false.

Local focused checkpoint: 65 tests passed, zero failed, 122 Mac SDK cases skipped
on Windows. The new SDK fixtures exercise the actual emitted link refusal branches
and XML/binary plist parsing, but have not run on a Mac in this task. The action
helper/hash is unchanged; the new sampler still requires native compilation and
fresh packaged execution. No current14 rendering/terms/navigation acceptance is
claimed from these tests or downloaded no-bundle artifacts.

Run38607998719's Mac assembly jobs were independently observed completed/success.
Staged ZIPs are retained in `artifacts/mac-probe-assembly-38607998719/` (ARM at
the root, Intel in `intel/`); only their bounded assembly JSON was extracted,
and no candidate code was executed. Both parsed receipts bind outer commit
`7eb00ad8a61db307c71bb95459ac85b7a957088d` and private commit
`a517375633f149aed719c8d5d84031f3303c0bcd`, private run38599976833, declared14.
This is assembly/source metadata, not an installed native bundle-version read.

| Staged Artifact | API ZIP Bytes | Verified API ZIP SHA256 | Extracted Assembly Receipt SHA256 |
| --- | --- | --- | --- |
| ARM11916418273 | 54532809 | `0a33c48dda3bbc1846e079a85467af436148d4b4a8430caa622928610c9f40d7` | `ff6205ccba5f24d56956321fe6932e8cfcd31a22151cc745fe7636fd02574883` |
| Intel11915954494 | 56059062 | `e528730c81f503aee15c3ed8e6cff52093f41f7f3181c8ed1bdfb19800808cae` | `5d76d8d82126efe587f2bfeecee7444e36accfaa7e98497049d5dea3cb87e3a5` |

### Fresh Workflow Checkpoint (Not Run Yet)

The user authorized the admitted `unix-managed-assembly.yml` hook changes. Its
display name now identifies fresh14 Mac packaging/Root diagnostics; the existing
single path-filtered validation-branch push and manual input shape are unchanged.
All6410998xx input IDs, sizes, ZIP/handoff hashes, draft-container checks and
split stage-input-write/assembly-read permissions remain unchanged. Linux keeps
the empty installer argument array; only Mac receives `--installer`.

Mac SDK fixtures run before assembly/launch. The existing builder validates the
real app and DMG, resource/mode/signature integrity and exact build-bound
descriptor. The new pre-launch hook rechecks primary package/assembly/executable/
Info.plist pins, parses only pinned plist bytes with native plutil, and records
raw `Info.plist` plus `package-info.json` before enforcing actual14. Mismatch
refuses app launch while retaining the actual metadata. The disposable copy is
resource/signature/image checked before exporting its path/hash. The independent
assembly receipt SHA comes from the primary build output before copying, not
from a supplied assertion or the diagnostic receipt itself.

The probe receives all fresh14 options above. Its separate native
`package-identity.json` must bind the actual live Root and held window. Always-run
retainers keep DMG, integrity/manifests/source metadata, numeric AX refusal phase,
normal-close and original-child-exit reports. The PNG is retained only when the
exact-owned-window bitmap receipt and byte/image pins match; no desktop screenshot
or alternate window capture is added. All product acceptance flags stay false,
including when the smaller Root diagnostic completes successfully.

Local checkpoint: 67 focused tests pass, zero fail; 122 SDK cases remain skipped
on Windows. YAML parsing, inline JavaScript syntax, input/permission/trigger
guards and whitespace checks pass. The SDK fixture now also verifies the exact
plutil stdin arguments against Foundation-generated XML/binary plists on Mac.
No native packaging, workflow run, commit or push was performed locally. The
parent must review and push this workflow once; source checks do not establish
actual current14 GUI capture or terms/navigation acceptance.

### Actual Fresh ARM38613119845 And Bitmap Admission Correction

Completed ARM job116021388745 at `85ecdb861475a69e1e21f22368722a299c06ea74`
passed SDK tests, native app/DMG packaging and package binding. Its native receipt
has both bundle version fields `0.1.14`, `packageIdentityValidated:true`, outer
source85ecdb8 and private sourcea517375/run38599976833. Root image SHA256 is
`16ef1b41718fb3381fc4a02a26eeaa5a573ec748438e97ea0c91cbe0cc1b37c1`.
Normal native close/termination and original PID13870 exit0/noSignal passed;
cleanup is not uncertain. All product acceptance flags remain false.

The distinct probe failure is still `root-web-area-readiness-unverified` under
the outer `root-surface-capture-unverified`. This time the content group's
`root-window/0` AXChildren count is definitively **zero in the initial read**:
AXError0, timeout-set error0, countVerified true, elapsed0.04354ms. Only seven
Root window/chrome nodes were observed at revision0; no notification produced
another observation before the 20-second deadline. This establishes neither
permanent document absence nor blank rendering. Root before/after CF fences pass.

The bitmap tool exited0 with a completed exact-window receipt (1052x692,
234135 bytes, SHA256
`a37b8869130b771971cc4e9efb40408da64344afb5f24bf82162148417e8224b`).
Completed-job logs prove a separate workflow assertion bug: `sameImage(image,
report.windowBitmap.image)` compares every receipt key, including `path`, while
`bitmapImage()` returns pins/dimensions without a path. The real receipt reproduces
this unconditional shape mismatch. The corrected diagnostic gate requires the
reported path to equal the exact owned file, requires identical pin-field sets,
then compares every pin. Missing/foreign paths, missing/extra pins, any changed
pin or promoted acceptance flag still refuse. Generic `sameImage`, probe ownership,
native roles/peer/CF/phase fences and all capture/action behavior are unchanged.

Artifact11917619627 is independently API-size/hash checked (43758 bytes, ZIP
SHA256 `1f2ee1fa0e80d688bf880dfa2ecdd5e4779dc589cce4861c007785c4e4fc44ed`);
ten bounded reports are retained under `artifacts/mac-root-probe-38613119845/arm/`.
The PNG was not uploaded because its admission step failed, so these retained
receipts cannot establish visually nonblank fresh14 rendering. Correcting the
gate cannot recover pixels from the completed runner. No rebuild/rerun, native
authority change or Git operation was performed during this diagnosis. The
workflow regression executes the exact gate against the observed receipt shape
and negative path/pin/flag cases: locally 68 pass, zero fail, 122 SDK cases skipped.

Concrete real GUI operation already implemented: one verified Root-native close
button AXPress followed by the live/termination and original-child-exit proof.
It must still be captured on this fresh app before any current14 claim. The next
terms operation would be one actual checkbox interaction, observing the normal
continue-button enable transition without accepting terms yet. It is currently
blocked by unverified document/control associations and the absence of any
authorized Root-terms writable action in the helper. Remote read association,
rendered pixels, source selectors or unit fixtures do not supply that capability;
no fake IPC, storage seeding, new remote press or blanket CF coercion is added.

### Same-Package Control38623617492

Run38623617492 at `3d956a3e320840d96ae505e624d066b91845f20e` reused the
archived ARM/Intel DMGs from38615878801 at17b769a. No Root/private module rebuild,
resigning, resource or entitlement changes were made. All six jobs passed SDK
fixtures and independently qualified the primary package before failing the
capture step. The API-bound artifact ZIP hashes/sizes were independently checked;
bounded reports and pixels are retained under
`artifacts/mac-root-control-38623617492/`.

| Context | ARM | Intel |
| --- | --- | --- |
| Direct/private | Nonblank terms and Hub at20.36s; AXChildren -25204 on Root AXGroup, then AXWindows -25204 after-fence | Nonblank terms and Hub at20.38s; package AXWindows -25204 |
| Direct/ordinary | Nonblank terms and Hub at24.33s; Root AXGroup children0, no WebArea by deadline | Nonblank terms and Hub at20.46s; AX surface capture completed |
| LaunchServices/ordinary | No admitted PNG; `owned-process-start-drift` | No admitted PNG; `owned-process-start-drift` |

Intel/direct-ordinary recorded34 nodes, including one Root-PID AXWebArea,
the terms AXCheckBox and the `Accept and continue` AXButton. The intermediate
foreign AXGroup was admitted for metadata only through native parent/window CF
association. This is a concrete document/control observation, not press authority;
no checkbox or continue action was attempted.

The four PNGs were visually inspected after exact before/after process/start,
executable/plist and CG window fences, local PNG hash/length/dimension checks and
native file-modification age checks. All show the terms modal and Hub content,
including the macOS label. This disproves persistent white rendering at20s in
these four disposable controls, not an ordinary-user or whole-product acceptance
claim. The earlier38615878801 white PNGs were real early captures: ARM4.3938s,
Intel5.6473s, after package AX refusal short-circuited the sampler. They were not
20-second observations. No WebKit initialization/resource/entitlement defect has
been established. An AX refusal is not evidence of blank pixels.

Confirmed harness limitations: the sampler requires the Root's kernel parent
to equal the Node caller, while LaunchServices creates a non-child process.
The combined guard did not record which field actually differed; actual parent
PID is still unverified. All four direct controls also abandoned the bounded log
tool with `toolLifetimeUncertain:true`, but their receipt discarded whether the
cause was timeout or output overflow. Normal close was consequently skipped;
acceptedExit is false and cleanup remains uncertain. That refusal is retained,
not treated as a successful close. LaunchServices has no caller-owned exit
receipt and must never synthesize one.

The narrow follow-up adds captured kernel bytes/errno, expected/observed scalar
fields and comparison results to the original `owned-process-start-drift` error.
Partial/unavailable reads expose no observed identity. It retains the same
parent/UID/real-UID/start/path/image guards and performs no extra native read.
Log failure receipts now retain the exact finite plan, timeout/overflow/exit/error
code, bounded byte counts and elapsed time, including when the after-fence
refuses. No raw stderr is copied, deadline is still5s and output ceiling512KiB.
The fixed `/usr/bin/log show` wrapper has no native GUI/action path. Its unknown
lifetime is now separate from GUI/helper-tool uncertainty: it still sets
`readOnlyDiagnosticToolLifetimeUncertain:true`, `cleanupUncertain:true` and
`passed:false`, but does not block an independently authorized normal Root close.
Compiler/sampler/bitmap/action-tool uncertainty still blocks that close. The
unchanged helper rechecks exact image/plist/kernel/window, finite native dialogs,
close-button role/state/hit peer and native CF reference before its one AXPress.
No log result supplies action authority or a synthetic exit receipt. Native
action helper and product acceptance flags are unchanged. New SDK fixtures require
a Mac runner; Windows tests alone cannot verify emitted Swift compilation.

Local follow-up checkpoint:207 cases,83 passed,0 failed,124 native/SDK skipped;
whitespace checks pass. The unchanged reviewed action-helper SHA256 remains
`212a8c94149d159da69c4161220333969fbc71bd555ee951c26d9ff04bae2a68`.

Smallest next native test after parent review: reuse these same qualified DMGs
and run LaunchServices/ordinary on ARM and Intel for the exact failing kernel
field, plus Intel/direct-ordinary for the missing log-tool status (its AX capture
already completed) and independent close receipt. No all-platform build is needed.
The authorized workflow selector accepts only `selected-three`, `ls-arm`,
`ls-intel`, or `intel-ordinary`. Push/default dispatch selects exactly the three
follow-ups; each individual enum emits one case. A permissions-empty selection
job emits the finite include matrix; the package qualification job retains its
read-only permissions and all original artifact/DMG/executable/source pins.
Unknown selectors refuse before matrix output. There is no six-case product
repeat, arbitrary JSON matrix input, new package build or signature operation.
Parent review/commit/push and native SDK/capture results are still required.

After the selected capture, the smallest terms-authority capture is read-only:
uniquely identify the exact terms heading, Root-PID AXCheckBox and `Accept and
continue` AXButton in the same held native document/window. Record successful
typed AXParent and AXWindow reads for each control, exact parent/window CF
association, active Root identity, bounds, enabled/hidden state, supported
AXPress action and a Root-PID native hit-test peer CF-equal to that control.
Recheck the same control, parent and held window references plus all Root
kernel/image/plist pins within the invocation. Missing, unequal, malformed,
ambiguous, remote-PID target, changed-reference or unavailable state must refuse.
The checkbox and continue button need not share a parent; each must retain its
own exact native parent. The recorded traversal indices/labels are not authority.

The34-node receipt does not contain those control-state, hit-peer and stable
parent/control CF facts. Root-PID metadata and the foreign ancestor's read-only
association do not fill that gap. No terms press or new remote-action authority
is implemented. Only after actual native capture establishes this contract should
an explicitly bounded action be considered: one checkbox AXPress, native checked
state and Continue-enabled transition; then a separately verified native Continue
AXPress and actual terms disappearance/navigation receipt. Any new selector must
have SDK negatives for every missing/drifted association, role, state and peer,
without weakening the existing MCP/Setup consent paths. Terms, owned AI/Setup GUI,
live AI and whole-product acceptance remain separate and unaccepted.

Likewise, only after the selected kernel metadata establishes a native launch
association should a distinct read-only LaunchServices fence be considered.
Parent1/name/UID alone are not authority, and LaunchServices still has no genuine
caller-owned Root exit code.

### Intel Terms Read-Only Capture Checkpoint

Actual selected run38629771103 at877db61 passed SDK fixtures and primary package
qualification on all three cases. Independently verified ZIP receipts are under
`artifacts/mac-root-control-38629771103/`. Both LaunchServices refusals are now
parent-only: full136-byte kernel info, errno0, parent1 instead of Node2052/4493;
PID/UID/real-UID/start match. Both helpers separately verify native termination,
without a fabricated caller-owned exit. No further LS test is needed for that
known harness contract.

Intel/direct-ordinary verifies one normal close AXPress0, exact kernel/window/
image bindings and PID2962 exit0/noSignal (`acceptedExit:true`). Its log helper
overflowed527684 bytes against524288 after913.5ms; not a timeout. GUI-tool
uncertainty is false, diagnostic lifetime/cleanup uncertainty remain true and the
suite stays false. Its AXWindows initial read is -25204 at220.97ms, count unknown.
Its exact-window PNG is independently pinned and visually nonblank at20.83s.

The next implementation adds only `native-macos-terms-inspect.swift`, its tests,
probe integration and a dedicated `intel-terms-readonly` selector. Push/default
dispatch now emits that one same-DMG Intel/direct-ordinary case, never LS/ARM or a
new package build. Existing old cases require explicit manual selection.

The separate inspector reuses the existing compiled sampler support declarations
for admission/kernel/image/children guards; it does not modify the action helper.
It starts after genuine Root identification and polls only actual native document
evidence: at most32 read-only attempts/20s, each capped4s, depth16/nodes512,
256 recorded reads and0.2s messages. It retains exact owner bytes and any held
native Root window CF reference across attempts. Only unavailable initial
AXWindows -25204/zero windows or an incomplete unique terms inventory can remain
pending. Association, identity, ambiguity and control-state failures are never
retried into acceptance. Attempts retain monotonic time, elapsed time, Root age,
original error/detail and whether native readiness remained pending.

The unique known terms container/document and both controls must be native-read
and Root-linked. Metadata includes strict parent/window CF links, Root-PID targets,
container/document/parent PIDs, typed enabled/hidden/checkbox state, bounded native
action names, bounds and exact native hit peers. Parent child-list membership,
Root kernel/images/window and held references are rechecked. Missing state stays
unknown; independent safe fields/second control are retained where possible,
but capture refuses. Initially disabled Continue is an observation, not a driver
failure or permission to press. No AX action/set-value, DOM/IPC or storage write
exists; `termsAccepted` and `actionAuthorityEstablished` always remain false.

Local checkpoint:213 cases,87 pass,0 fail,126 native/SDK skipped on Windows.
The Mac fixtures compile the actual multi-file inspector, poison local admission,
and exercise strict CF types/links, every required fact and bounded pending/refusal
distinctions without a live target. One stale source guard was updated to the
parent's explicit5bb05a2 Linux-only assembly pins/installer command; Mac archived
DMG qualification pins are unchanged. No product or action-helper source changed;
the reviewed helper remains212a8c94149d159da69c4161220333969fbc71bd555ee951c26d9ff04bae2a68.
Native source has not run until the parent stages these files on the validation
branch. The child inspector cannot be substituted with an old workflow run.
