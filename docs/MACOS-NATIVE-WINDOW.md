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
Existing AX trust is required; absence refuses without requesting permission.

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

Windows runs source-contract checks only and skips Swift/native cases. It is
not Mac compilation or runtime proof. Intel and ARM Mac runners still need real
AX/bundle/window observations, native consent approve/decline, normal-close
outcome and post-action identity checks. No current fixture result establishes
production writable admission, installed migration, OS trust or release readiness.
