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
