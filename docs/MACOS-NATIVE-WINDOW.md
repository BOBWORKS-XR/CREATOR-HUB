# Disposable macOS Owned Window Helper

`scripts/native-macos-window.swift` is a CI-only action helper, not app code or a
customer consent mechanism. It neither enables production writable hosting nor
changes Accessibility, screen-recording, Gatekeeper, signing, or quarantine policy.

## Admission and Use

Native commands require macOS, the matching `RUNNER_ARCH`, `GITHUB_ACTIONS=true`,
`RUNNER_ENVIRONMENT=github-hosted`, `RUNNER_OS=macOS`,
`GITHUB_REPOSITORY=BOBWORKS-XR/CREATOR-HUB`, and
`CREATOR_MACOS_OWNED_GUI_TEST=1`. Admission precedes file/process/window inspection.
These are environment admission checks, not cryptographic runner attestation.
Existing AX trust is required for `identify`, `inspect`, `press`, and `close`;
absence refuses without requesting permission. `availability` only reports the
existing trust Boolean after the same CI/architecture admission.

For `CREATOR_MACOS_APP_PROBE=1` Root captures only, the first foreign AX child
refusal may carry diagnostic PID/role/path, one-level parent/window linkage and
kernel parent metadata. Root identity/native CF window are fenced before/after;
no foreign subtree or editable content is inspected. Same-PID input checks still
refuse. Post-close failures may carry `postProcessStatus`, but remain exit3 with
`postIdentityVerified=false`; absence is not post-identity success. See
[actual Root receipts and the next capture](MACOS-NATIVE-APP-PROBE.md#actual-run-and-diagnostic-follow-up).

## Read-Only Availability Probe

Before building a full GUI acceptance harness, the main-owned
`.github/workflows/native-gui-helpers.yml` can collect this probe on its existing
`macos-latest` and `macos-15-intel` matrix entries. No workflow change or dispatch
is made by this sidecar. Leave GitHub's supplied runner/repository variables
unchanged; only set the explicit helper opt-in. Compile the native branch, not
the separate fixture branch:

```sh
set -euo pipefail
CREATOR_MACOS_OWNED_GUI_TEST=1 node --test scripts/native-macos-window.test.cjs \
  | tee "$RUNNER_TEMP/native-macos-window-tests-$RUNNER_ARCH.tap"
/usr/bin/swiftc scripts/native-macos-window.swift -o "$RUNNER_TEMP/native-macos-window"
CREATOR_MACOS_OWNED_GUI_TEST=1 "$RUNNER_TEMP/native-macos-window" availability \
  > "$RUNNER_TEMP/native-macos-window-availability-$RUNNER_ARCH.json"
cat "$RUNNER_TEMP/native-macos-window-availability-$RUNNER_ARCH.json"
```

Native binary path: `$RUNNER_TEMP/native-macos-window`. Exact probe command:
`CREATOR_MACOS_OWNED_GUI_TEST=1 "$RUNNER_TEMP/native-macos-window" availability`.
It takes no PID, app path, owner file, options, or standard-input fixture.
The only native accessibility call in this branch is
[Apple's AXIsProcessTrusted()](https://developer.apple.com/documentation/applicationservices/1460720-axisprocesstrusted),
which returns the current process's trust state. No permission-request API,
target/process/window inspection, activation, input, launch, TCC or Gatekeeper
change is performed. It is not an action authorization or a trust-bypass switch.
Every inspection/action command still checks trust independently.

An admitted query exits 0 for either Boolean. Example shape, not observed Mac
evidence:

```json
{"schemaVersion":1,"command":"availability","runnerArchitecture":"ARM64","accessibilityTrusted":false,"probeOnly":true,"targetInspectionPerformed":false,"actionAttempted":false,"permissionRequestsPerformed":false,"nativeGuiAccepted":false,"releaseReady":false}
```

`false` establishes that this helper invocation lacks the existing AX
prerequisite: stop the AX GUI lane without prompting, granting trust or changing
OS policy. `true` establishes only that prerequisite for this compiled helper;
owned native app/window/control mapping and outcome acceptance remain untested.
Do not transfer the result to a different binary, path, architecture or runner.
Keep the same compiled binary for any later separately approved harness.
Local/self-hosted, wrong repository/OS, absent opt-in, or mismatched architecture
exit 2 before the query. Extra arguments also refuse before the query.

For main's report/upload step, retain the two explicitly named TAP/JSON files
above separately for `ARM64` and `X64`, including failures with an `always()`
artifact step. Record source revision, runner image/architecture, native binary
path/hash, compile/probe exit status and the unmodified Boolean; missing or
refused evidence is unknown, never a successful false/true probe. TAP includes
the actual native compilation diagnostic and, only under the real admitted
environment plus opt-in, the native availability diagnostic. The test binary
is temporary and deleted after tests; its trust result does not substitute for
the separately compiled stable-path probe JSON. Upload only these helper
reports, not profiles, app data, keys or account/settings material.

All helper receipts, including fixtures and refusals, retain
`releaseReady=false` and `nativeGuiAccepted=false`. Direct 0.1.14 native GUI
acceptance remains TBD. The reported Linux Source/XRes fixture run
`38469450169` and unchanged C44 Windows signed acceptance are separate lanes;
neither establishes Mac AX availability or native product GUI acceptance.

Compile on a Mac runner with its existing SDK:

```sh
swiftc scripts/native-macos-window.swift -o "$RUNNER_TEMP/native-macos-window"
"$RUNNER_TEMP/native-macos-window" identify PID APP_PATH EXECUTABLE_PATH EXECUTABLE_SHA256 BUNDLE_ID
```

The caller must already own the launched PID and pin the executable hash from
its reviewed candidate. The helper never launches, activates, force-closes, or
searches by title/process name. Admitted bundle IDs are Hub, MCP Preview, and
Project Setup. The canonical `.app` must be inside runner temp or the disposable
runner's `Applications` directory; its executable must be inside `Contents`.

`identify` returns a `process` identity and only that PID's showing window IDs,
owners and bounds. It does not output desktop metadata or window titles. Select
the exact intended window from this evidence; do not select the first blindly.
Write `{ "process": IDENTIFY_PROCESS, "window": SELECTED_WINDOW }` as an owned,
nonlinked JSON file under runner temp, then use:

```sh
"$RUNNER_TEMP/native-macos-window" inspect "$RUNNER_TEMP/owner.json"
"$RUNNER_TEMP/native-macos-window" press "$RUNNER_TEMP/owner.json" mcp-allow
"$RUNNER_TEMP/native-macos-window" close "$RUNNER_TEMP/owner.json"
```

The only press actions are `mcp-allow`, `mcp-decline`, `mcp-preview-allow`,
`mcp-preview-decline`, `setup-allow`, and `setup-decline`. Each requires the exact
approved button plus `Not now`, unique and enabled in the same native dialog.
HTML lookalikes, duplicates, absent state, hidden/nonshowing or foreign controls
refuse. Normal close uses the window's native AX close button and refuses while
any native dialog is present. There are no arbitrary labels, coordinates, title
matching, AppleScript, focus forcing, retries, signals or kill fallback.

## Root Close-Only Scope

Only `close` for `com.creatorworks.hub` now uses `observeRootClose`. `inspect`,
all consent `press` actions, and legacy app close retain the original complete
same-PID traversal. No remote node can be an action target. Root close resolves
the held window's [AXCloseButton](https://developer.apple.com/documentation/applicationservices/kaxclosebuttonattribute)
directly; it does not enter content-container descendants.

The finite scope is `root-standard-window-first-order-native-dialogs`, not
global client/dialog coverage. An absent result requires one exact held Root
AX window, `AXStandardWindow`, an explicit typed `AXModal=false`, and a complete
bounded first-order native-child inventory. Each inspected child must have Root
PID and native parent/window CF links to that held window. Only the declared
ordinary content/chrome roles and subroles are supported. Native `AXSheet`,
`AXDialog`, or modal Root state is present; extra windows, alternate layouts,
unreadable/wrong-type/missing required attributes or links, foreign direct
children, and exhausted bounds are unknown and refuse. Missing optional
subrole is accepted only on a supported role after native no-value/unsupported
status, not after communication/type errors.

Primary boundaries are Apple's [first-order AXChildren](https://developer.apple.com/documentation/applicationservices/kaxchildrenattribute),
[window modality](https://developer.apple.com/documentation/applicationservices/kaxmodalattribute),
and [native sheet-parent relationship](https://developer.apple.com/documentation/appkit/nswindow/sheetparent).
This is an ordinary native-window/sheet boundary, not proof that arbitrary
nested/custom accessibility providers or HTML dialogs contain no dialog.
Alternate provider/layout support must not be inferred from these receipts.

Before, immediate, and final pre-action selections repeat this gate and retain
the same Root window/close-button CF references, process/image/CG pins, active,
enabled, visible, hit-test and AXPress checks. The existing live-after or distinct
native-termination postcondition remains mandatory. Caller acceptance now also
requires the explicit absent scope and its original child exit0/no signal.
Unknown refusals include bounded `closeDialog` stage/count/role diagnostics.
Four-second and 200ms messaging bounds, no retry/kill/permission policy, and
all false product-acceptance flags are unchanged.

Local Windows tests establish JS/source guards only. The added SDK scope,
malformed-input and post-identity fixtures are skipped here. A new Intel/ARM
native run must qualify the actual Root layout and close behavior; the reviewed
source hash is a source pin, not native acceptance.

## Identity and Evidence

Checks bind PID plus kernel start seconds/microseconds, process UID, kernel and
AppKit executable paths, bounded on-disk executable SHA-256/file identity,
native bundle ID/path and plist identity. Device and inode fields are decimal
strings so JavaScript cannot round away 64-bit identity. An exact owned CG window ID is mapped
to one AX window with identical bounds; a control must link back through
`AXWindow`. A showing control also requires a PID-bound desktop hit-test at its
center; this is an observation, never a coordinate click. Missing or ambiguous
mapping refuses, without using private window-ID APIs or matching titles.

AX traversal is bounded to 512 elements, depth 16 and four seconds, with 200ms
message timeouts. Only the fixed consent controls and native close control are
reported; no dialog text, editable values or global AX tree is emitted.

Actions are single AXPress attempts. Real identity is checked before and
immediately after; drift refuses success and retains the pre-action evidence.
Exit 2 means refusal before an attempt; exit 3 means an attempted action whose
result/post-identity is unverified. Never retry automatically. If the process
exits before the post-check, exact post-identity cannot be proved: the receipt
stays unverified. The parent must separately collect its owned child's exit.
Successful AXPress is not proof that consent, hosting or closing completed.
Verify the resulting native protocol/state separately. Window disappearance is
reported only when the process remains identity-bound and its exact CG ID is absent.

On-disk SHA-256 is not an immutable mapped-image, publisher or notarization
claim. Public AX APIs do not make PID checks and AXPress one atomic operation;
the post-check detects observable drift, not same-user memory compromise.
Flat internal backends whose native AppKit bundle identity cannot be established
are unsupported/unverified until actual Mac evidence establishes that contract.

Primary contracts: [Apple AX objects](https://developer.apple.com/documentation/applicationservices/axuielement),
[AXWindow linkage](https://developer.apple.com/documentation/applicationservices/kaxwindowattribute),
[kernel start stamps](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h),
and [kernel process paths](https://github.com/apple-oss-distributions/xnu/blob/main/libsyscall/wrappers/libproc/libproc.c).

## SDK Compatibility Failure

Run `38463917232` failed compilation on both Mac architectures before any AX
calls. The Intel SDK 15.5 could not import `PROC_PIDPATHINFO_MAXSIZE` and did not
define `kAXSheetsAttribute`; that run remains failed, not native acceptance.
The path buffer now uses Apple's exact 4096-byte contract (`4 * MAXPATHLEN`,
`MAXPATHLEN = PATH_MAX = 1024`), matching `native/host_parent_macos.rs`, with
returned-length and NUL checks. See [XNU path limits](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/syslimits.h).
Traversal uses public [AXChildren](https://developer.apple.com/documentation/applicationservices/kaxchildrenattribute)
and [AXSheet role](https://developer.apple.com/documentation/applicationservices/kaxsheetrole),
not an invented sheets attribute. Native-dialog detection and close refusal,
traversal bounds, ownership checks and permission policy are unchanged.

## Tests and Remaining Gates

```sh
node --test scripts/native-macos-window.test.cjs
```

On macOS this compiles both the native binary and a separate
`NATIVE_MACOS_WINDOW_FIXTURES` binary. The fixture binary contains no native
frameworks/actions; fixture data cannot be injected into the native CLI.
Fixtures cover PID/hash/start/inode/bundle drift, duplicates, missing/disabled/
hidden controls, window mismatches, AX denial, truncation and post-action drift.
Native admission tests deliberately refuse before any AX inspection or action.
The native compile case runs on macOS without launching an app. The positive
availability case requires the actual hosted CI environment, matching native
architecture and explicit opt-in; it never fabricates successful admission.
When actual trust is false it also confirms all four action/inspection commands
refuse before reading a target. Fixture AX Booleans never prove native trust.

Windows runs source-contract checks only and skips Swift/native cases. It is
not Mac compilation or runtime proof. Intel and ARM Mac runners still need real
AX/bundle/window observations, native consent approve/decline, normal-close
outcome and post-action identity checks. No current fixture result establishes
production writable admission, installed migration, OS trust or release readiness.
