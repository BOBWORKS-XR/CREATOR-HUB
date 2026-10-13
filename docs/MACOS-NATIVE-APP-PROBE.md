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
JSON containing `report`, optional partial/complete `surface`, `passed`, and the
always-false product acceptance flags. Exit 0 requires complete capture, a
verified normal AX close and this exact spawned child's exit code 0 without a
signal. Otherwise exit 2; preflight refusal is printed without creating output.

The new output retains `plan.json`, `launch.json`, `owner.json`, `surface.json`
when sampling reached that stage, final `report.json`, and numbered tool
`.json`/`.stdout`/`.stderr` files. Intermediate reports and original refusal
output are immutable. `report.json` separates `captureCompleted`, `acceptedExit`,
`ownedChildExit`, `closeError`, `cleanupUncertain` and overall `passed`.
`surfaceSummary` records role counts and whether an AXWebArea was observed. Its
absence or missing HTML labels is a snapshot limitation, not a claim that the
frontend was ready or inaccessible on every run. `captureCompleted` means this
bounded Root-window snapshot completed, not that terms/menu targets were accepted.
All final report product flags remain false: `nativeGuiAccepted`, `mcpAccepted`,
`migrationAccepted`, `updateAccepted`, `releaseReady`.

Main should upload the explicit JSON/tool evidence with `always()` even on
failure, separating ARM64 and X64 and recording the supplied package/API evidence
beside it. Do not upload `private-home`, Root stdout/stderr, account material or
unrelated runner data. These disposable profile/log files remain on the runner;
the probe never reads them or cleans up original evidence. Retain preflight
stdout in main's separate job log when no output directory could be created.

## Capture And Cleanup Contract

At runtime the probe compiles a byte-exact copy of the existing
`native-macos-window.swift` into the new output, with no fixture define or source
edits. That one pinned binary handles availability, identification, before/after
inspection and the single normal-close attempt. It is never recompiled during
the probe. Compiling tools is not building the Hub package.

The existing helper intentionally reports only fixed native-consent controls.
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
is bounded to 512 elements, depth 16, four seconds and 2048 bytes per label.
Labels are emitted only for noneditable roles with positive bounds inside Root;
editable values, AXValue, other apps and the global AX tree are never read.
Missing titles/descriptions are observed limitations, not invented labels.
WebKit elements exposing a different PID refuse: do not relax ownership to
obtain a prettier capture. This first capture does not assert that terms/menu
labels or future action targets exist.

Only the unchanged helper's `close` command may attempt cleanup, once, with
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
