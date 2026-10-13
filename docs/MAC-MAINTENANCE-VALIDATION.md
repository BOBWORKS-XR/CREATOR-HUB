# macOS 0.1.13 Maintenance Validation

## Scope and Release Hold

This probe targets the **unreleased separate-app 0.1.13** Hub as a maintenance
regression foundation only. **0.1.13 remains on hold:** no new signing or
publication, and no reduced Mac/Linux standalone-only 0.1.13 release.
Unification remains planned for 0.1.14 or later, together on every platform.
The actual native preference regression must be validated against these packages;
package hashes and unit tests alone do not establish native persistence.
This probe changes no app source, catalog, signed descriptor, companion
installer or Flatpak file. Follow [maintenance gates](MAINTENANCE-0.1.13-GATES.md),
[release gates](RELEASE-GATES.md) and the
[publication checklist](HUB-PUBLICATION-CHECKLIST.md).

The report always has `releaseReady: false` and `updater.tested: false`.
AI/Unity workflows, real companion installs and live-client reconnect also stay
untested. Synthetic CI terms acknowledgement is explicitly **not customer consent**.
Public 0.1.12 `self_update.rs::installed_location` refuses non-Windows managed
updates: [exact public source](https://github.com/BOBWORKS-XR/CREATOR-HUB/blob/35a16a45814d821d65b5d203628478449174cd55/src-tauri/src/self_update.rs).
Copying a DMG app into Applications and manually launching it is **not** native
update discovery, cancellation, approved download, automatic restart or reconnect
proof. No version-only fixture is built or substituted for the old public app.

## Current Package Binding

The Mac defaults now bind to successful all-five-job
[CI 38442820243](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38442820243).
Reviewed product head: `cef6f60310e88349e57951a2bbe0213e86fd05e7`.
Artifact checkout merge: `dcbd0f8c84bd3ab5d6b463972f7701c5e3541a2e`.
Both trees are `71c584be90aba7f28b67edda1c61782972d1f760`; API-verified
merge parents remain public baseline `35a16a45814d821d65b5d203628478449174cd55`
then the exact reviewed head. Repository/run/head, artifact names, IDs, lengths,
digests, expiry and workflow repository IDs were checked independently.

| Architecture | Artifact ID | ZIP bytes | Independently Hashed ZIP SHA-256 |
| --- | --- | --- | --- |
| Intel | 11838031910 | 5436847 | `9a215d6d2d1a9cdd180d37ce036d56896baead24cfff3e3368cd43cdf2a997ab` |
| ARM64 | 11837072258 | 5154053 | `3ccbc6f62528490f696045fbe8a4575936d89fec617aabf09b70b526038530b8` |

The single-member DMGs were independently extracted and hashed locally:

- Intel: 5468115 bytes, `3a62251de7eac0dccd0cdf10052b0745263c981cf72ca562df5c0fb1a9f50389`.
- ARM64: 5181127 bytes, `ebdbec2ef2e98b682cc107a926bcd683f39c9cca59b7eb621a72406c94a976a2`.

Local archives, extracted packages and hash notes are retained under
`artifacts/native-prefs-38442820243/`; `verified-mac-packages.json` records the
exact local paths. No Mac app was mounted or installed on this Windows host.
The workflow/script pins and matching binding fixture were rebound; an added
regression rejects the former `288` tuple. Local Node 24 verification is
**134 passed, 0 failed, 1 skipped** across 135 tests; the skipped file-symlink
case requires Windows privilege, while directory-junction refusal passed.

This is **package/source proof only**, not native persistence or release
acceptance. The next four Mac lanes must establish terms and auto-download
retention in the actual installed native-preference candidate after review.
No dispatch, commit or push was performed here. Gatekeeper rejection and the
historical old-12 failures remain separate, unmodified evidence. WebKit candidate
key diagnostics remain active-store-unbound; the native preference path means a
missing browser key alone does not establish a native preference failure.

## Current Native Preference Results

[38446601180](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38446601180)
reused the exact `cef6` packages above, with test-only execution source `d24455e`.
All four lanes completed rendered native WebKit, synthetic terms retention,
automatic-download OFF before and after normal quit/relaunch, sentinel
preservation and normal owned cleanup. Each reports zero functional failures,
`packageAndManualChecksPassed=true`, `termsPersistenceTested=true` and
`autoDownloadPreferencePersistenceTested=true`.

The workflow remains **blocked**, not a successful release receipt: every lane
retains Gatekeeper assessment status 3 for the not-notarized ad-hoc app. The
ARM upgrade also retains the old public-12 bundle minimum mismatch. Current
candidate minima cover their executable minima on both architectures. No
security policy was changed. Per-app quarantine approval, signed in-app updating
and companion operation remain untested by this run.

This test changed the switch in 13 after installation. It did **not** prove
migration of an OFF choice made in public 12. A separate `legacy-preferences`
lane now changes only that exact old checkbox, requires OFF after normal old-app
relaunch, then requires OFF on the new app's first open and relaunch without
clicking its switch. The native helper has separate fixed 12 and 13 actions;
all existing ownership, capability, no-security-prompt and single-action guards
remain. `validation_scope=legacy-preferences` runs just the two new architecture
lanes and reuses the same packages, without building another app. Native results
for this additional migration case remain pending.

## Historical Original Binding

Read-only GitHub API queries on 2026-10-13 established that
[CI 38393759689](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38393759689)
completed successfully. Its head is
`6d47bd0790cfc5c3560495bbd92c37b3cd06df14`, but its artifact label uses the
checked-out PR merge `cb7499b592b4260f6733b7ff5ef7c670f74233a0`.
Both commits have tree `8b1deb17843f753f7b6fe5cf3560412ed8b541d9`.
The merge parents are public baseline `35a16a45814d821d65b5d203628478449174cd55`
then that exact reviewed head. The harness repeats this verification; matching
an artifact name alone is insufficient.

| Architecture | Artifact ID | ZIP bytes | Pinned ZIP SHA-256 |
| --- | --- | --- | --- |
| Intel | 11811084737 | 5430330 | `907c757a41d5ea051b30dc91ee188896d9415dd86fad8f070e48a9c384bf87cf` |
| ARM64 | 11810464108 | 5133821 | `d50be98f6d950eadf8191df762f8efc1840436a94a2538956781dfc9620a8057` |

The candidate DMG pins supplied for these artifacts are Intel **5462525 bytes**,
`9697ba880b8c5169ebfae7b8d09ae03a94f367dcad6816e6295a2c9ed3d84128`, and
ARM64 **5161483 bytes**,
`d023fe401c6cf1edb340e0eb9f06dabce988f5168e9b9d9ebb1ddd08a8c2728a`.
These are not ZIP hashes. The workflow must verify downloaded bytes before use;
this local Windows implementation did not mount or install those packages.

Public 0.1.12 pins were independently read from both its GitHub release asset
digests and its [SHA256SUMS.txt](https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.12/SHA256SUMS.txt):

| Public DMG | Bytes | SHA-256 |
| --- | --- | --- |
| `Creator.Hub_0.1.12_x64.dmg` | 5397091 | `1eeec9bc53903b43ed0466ee97caa66f86f9725d40d3129ebfac717bd4b9528f` |
| `Creator.Hub_0.1.12_aarch64.dmg` | 5102365 | `5254e7cb372526e15ec1f51ae4962e7ace5436df45d1897ce5a2a71170092fce` |

Admission requires the exact repository/run/head, successful original CI, pinned
artifact ID/name/ZIP length/digest, artifact workflow repository IDs, equal head
and merge trees, and exact PR merge parents. The downloaded ZIP digest is checked
before extracting its single expected DMG. Extra entries or traversal are refused.
All committed file hashes/modes, including submodules, in the harness checkout
must match the artifact source except twenty-three exact reviewed testing-only paths:
the five Mac files below, the Linux harness/test/window/workflow, the Flatpak
harness/test/workflow/evidence document, and the reviewed Windows baseline changes
in `windows-candidate.yml`, `Test-InstalledCandidate.ps1` and
`self-update-baselines.test.cjs`; the signed Windows lab workflow/test, its four
exact public fixture paths, and the Flatpak XRes test helper. These are test
inputs and drivers, not app code or shipped permissions. The complete finite list is retained in the
report's `productTree.excludedPaths`. There are no directory/glob exclusions:
app source, Unity/script resources, settings, versions, package locks and all
other files retain full mode/type/hash comparison. Any other change is a blocker
requiring review, not permission to rebuild silently. Run/head/merge-parent/tree
and artifact byte binding are unchanged by this testing-path admission.

## Workflow and Native Lanes

The workflow owner has changed
`.github/workflows/mac-maintenance-validation.yml` to **manual dispatch only**,
after registration of the earlier paths-limited PR probe. The structural test
requires that sole trigger; this worker did not edit the workflow. The owner
reported successful dispatch registration while PR22 remained draft. No merge
is needed solely for registration. No remote dispatch, commit or push was
performed by this implementation.
The evidence directory is allocated canonically in a runner step, not through
the unavailable job-level `runner` context; see
[GitHub context availability](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability).

Four disposable GitHub-hosted jobs cover Intel `macos-15-intel` and ARM
`macos-latest`, each with `fresh` and `manual-upgrade`. Fork PRs, self-hosted
runners, other repos and non-Mac machines are refused. Node is pinned to 24;
the artifact source must pin Rust 1.99.0. This workflow does not compile Rust or
rebuild packages. It uses only `contents: read` and `actions: read`, no issuer keys.
The API token is limited to the download step, never forwarded to archive hosts
or the native helper. Optional independently reviewed executable hash inputs
may strengthen the check; otherwise that hash is derived from the pinned,
code-seal-verified DMG and compared with the installed executable.

Both lanes install to the real per-user `~/Applications/Creator Hub.app`, not a
temporary runnable copy. An existing per-user or system Hub or a running Hub
causes refusal. DMGs mount read-only. Both packaged and installed app must pass
`codesign --verify --deep --strict`, exact identifier, both bundle version fields,
single target architecture, numeric bundle/Mach-O minimum OS and host OS checks.
The original `Signature=adhoc` is retained and required; it is not Developer ID
or notarization proof. `spctl --assess` is read-only; rejection remains a blocker.
A bundle minimum below its Mach-O minimum also remains a blocker. Testing on
current runners does not establish operation on the declared oldest supported OS.

The fresh lane requires the actual 0.1.13 Terms screen, acknowledges it through
the synthetic controls below, captures the rendered MCP body, quits normally
and relaunches. The body must return without a second acknowledgement.

In the manual lane the unchanged public 0.1.12 app is installed/launched first.
It undergoes the same first-run acknowledgement, body capture and normal
quit/relaunch persistence check. After the relaunched old PID quits normally,
the old bundle is retained in the owned runner evidence directory, then 0.1.13
is copied to the same Applications path. Both the first 0.1.13 open and its
normal relaunch must render the body with the old acknowledgement preserved.
Returning terms are blocked, never silently acknowledged again. No version-only
fixture is substituted for the public old app.

Each normal LaunchServices open records the actual PID, bundle path and executable
path, with distinct PIDs for all phases. No direct-executable launch fallback bypasses
LaunchServices, security policy or consent. A refused quit stops replacement;
failed replacement is recorded with the original bundle retained, not hidden by
automatic retries or a fabricated success.

## Target 13 Auto-Download Persistence Addon

This bounded diagnostic tests only the effective **Download verified updates
automatically** preference in 0.1.13 across an owned normal quit and relaunch.
It changes no product runtime/UI behavior, workflow, consent record or artifact
pin. The owner must rebind the unchanged pins to accepted candidate CI before
native execution; this worker does not accept or dispatch the pending builds.

The original capture at
`artifacts/mac-b4-intel-fresh-38413382537/native-report.json`,
`launches[0].afterTermsSnapshot.axNodes`, contains exactly one enabled control:
`AXRole=AXCheckBox`, `AXTitle=Download verified updates automatically`,
`AXValue=1`, `AXEnabled=true`. That observation is an available control, **not
preference persistence proof**. The original report stays blocked with
`releaseReady: false`, `effectivePreferencesTested: false` and returning Terms
on normal relaunch. The corresponding ARM fresh report retains Terms across
relaunch but also has `effectivePreferencesTested: false`; neither report
establishes persistence of other browser preferences. Both original reports and
their Gatekeeper rejections are retained, not overwritten or promoted.

On the initial rendered 0.1.13 body only, the addon requires that exact unique
enabled checkbox at value `1`, then performs **one** normal `AXPress` requesting
`0`. The Swift helper requires a separate command-only opt-in,
`CREATOR_MAC_SYNTHETIC_PREFERENCE_TEST=1`, exact hosted CI/repository, matching
owned PID/bundle/executable, both installed bundle version fields equal to
`0.1.13`, an active app, existing AX and screen capabilities, a display, one
visible window, a complete WebKit MCP body and no Terms/security/privacy prompt.
It rechecks the role, exact title, enabled state and value immediately before
the press. No arbitrary action, other checkbox, old-12 preference mutation,
permission grant, JavaScript/localStorage injection or direct storage write is
permitted. This synthetic test is **not customer consent**.

The action receipt binds identity, role/title, `beforeValue=1`,
`requestedValue=0`, `targetVersion=0.1.13` and the synthetic/no-customer/no-user-PC
flags. A successful receipt alone cannot establish the result: an actual owned
post-action AX snapshot must show `0`. The first PID then has to quit normally;
the normal LaunchServices relaunch must have a distinct PID and show the same
exact enabled checkbox at `0`, without another press. Its normal quit is also
required. An uncertain press is never repeated, and a returning `1`, missing,
ambiguous or disabled checkbox is recorded as failure, not repaired by the probe.

Reports retain `beforeAutoDownloadSnapshot`, `afterAutoDownloadSnapshot` and
`relaunchedAutoDownloadSnapshot` in the target launch rows. All new reports
start with `autoDownloadPreferencePersistenceTested: false` and
`effectivePreferencesTested: false`; both become true only after the full
observed target pair and normal lifecycle checks complete. The explicit
`effectivePreferencesScope` is `0.1.13-auto-download-normal-quit-relaunch-only`;
`otherBrowserPreferencesTested` stays false. A blocked initial target body
leaves the addon untested, rather than assuming an off state on relaunch.
Old-12 baseline problems and original Terms failures remain separate blockers;
a narrower target preference result cannot make them pass or make the release
ready. `releaseReady` always stays false.

Gatekeeper assessment/rejection and ad-hoc, unsigned/not-notarized publisher
status are unchanged. These are not relabelled as damaged seals, runtime or
preference failures. The addon grants no OS approval and changes no policy;
the actual quarantined per-app approval flow remains unverified here. Optional
native Terms-file read/hash capture is not added by this preference-only addon.

## Captured Intel AX Classifier Correction

In [Mac probe 38427551219](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38427551219),
the X64 fresh relaunch snapshot for PID `2135` retained one empty Terms-labelled
`AXGroup`, but no Terms checkbox or Continue button. It also contained the MCP
WebArea/body and one enabled auto-download checkbox at `0`. The prior classifier
called this `terms` from the group title alone and skipped the relaunch PNG.
That classification is not proof that the visible Terms dialog reappeared.

The corrected Node classifier and Swift preference guard use the same rule:
exactly one `AXCheckBox` with the full Terms checkbox title and exactly one
`AXButton` titled `Accept and continue` establish Terms controls. Partial,
ambiguous, wrong-role or near-match controls remain unready/refused; Terms text
outside a group without the complete controls also remains unready. A labelled
group alone can establish neither consent nor a body. It is tolerated only with
the MCP WebArea/body and one enabled exact auto-download checkbox at `0` or `1`.
Real Terms controls still prevent a preference press, even with background body
nodes present. No pixel, PID/window identity or permission gate is relaxed.

Raw snapshots retain the group; no nodes are filtered out of native reports.
The inline frozen regression copies the relevant native nodes verbatim and
records full-snapshot SHA-256
`bbf2668c8ab0bcb27d47490f969c5d8c6fcbca6d2d81a2c66bd033fbd176fc37`.
The ordinary owned relaunch body PNG must now be captured and pass the existing
pixel gate before persistence can be reported. This corrected native capture
and the updated Swift helper still require execution on Mac CI; local fixture
replay does not create a new native acceptance result. Local Node 24 checks:
**112 tests passed, 0 failed, 0 skipped**, including 14 classifier regressions.

The X64 manual lane's original old-12 screenshot was viewed: its sampled body
crop is white, with one color and zero non-background samples. Its first failure
at `synthetic-terms-0.1.12` is preserved, target 13 was not reached, and the cause
remains unknown. This minimal correction adds no paint delay, screenshot retry
or late-success promotion. All original reports, Gatekeeper rejections, old-12
minimum-OS blockers, release holds and artifact pins remain unchanged.

## Preservation and GUI Boundaries

Opaque random byte sentinels cover Hub storage/adoption/projects, current and
legacy MCP data roots, Setup cache/receipt roots, a client-entry root, unmanaged
project content and unmanaged installation siblings. Separate MCP/Setup payload
sentinels live in clearly named `.fixture` directories, not fake launchable apps.
Bytes, length and mode are compared after each normal quit and again on failure.
No existing config, auth file, terms-acceptance record or signed app bundle is
edited. The root choices are preservation probes, not proof of every companion's
actual runtime data contract.

These sentinels prove **opaque file preservation only**. Separate GUI relaunch
checks test the app's own synthetic Terms acknowledgement and the one target-13
auto-download preference above, not arbitrary WebKit/localStorage preferences,
account identity, real saved/adopted project semantics, actual companion installs,
live-client settings or reconnect.

The compiled Swift helper probes existing
[AX trust](https://developer.apple.com/documentation/applicationservices/axisprocesstrusted())
and [screen-capture access](https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess()).
It never requests permissions. Bounded AX/window snapshots target only the owned
app PID. Missing capability, missing visible window, incomplete AX capture or a
possible privacy/security prompt is blocked. Mutations are limited to the
separately opted-in target-13 preference action above and this explicitly
opted-in **synthetic disposable CI terms test**, using normal
[AXPress](https://developer.apple.com/documentation/applicationservices/kaxpressaction)
on these exact controls, in order:

- `AXCheckBox`, exact `AXTitle`: `I have read and agree to these terms, including the risk assumption and liability limitations above.`
- `AXButton`, exact `AXTitle`: `Accept and continue`.

The helper requires `GITHUB_ACTIONS=true`, `RUNNER_ENVIRONMENT=github-hosted`,
`RUNNER_OS=macOS`, exact `GITHUB_REPOSITORY=BOBWORKS-XR/CREATOR-HUB` and
`CREATOR_MAC_SYNTHETIC_TERMS_TEST=1`. The opt-in is passed only to the two helper
commands, not injected into the installed app. PID, bundle ID, canonical installed
bundle/executable paths, active app, existing AX/screen capability, exactly one
window, complete WebKit Terms tree, unique roles/titles, enabled state and checkbox
value are checked before pressing. Each press occurs at most once; an uncertain
result is retained as failure, never retried. The app creates its own acceptance
record through its actual UI. No terms storage seed, CDP, JavaScript console
injection, auth mutation or key logging is used. All action receipts have
`syntheticTestOnly: true`, `customerConsent: false`, `userMachineUsed: false`.
No user machine, real customer consent or OS security/privacy prompt is eligible.

Each existing body/Terms GUI phase requires WebKit AX evidence and a PNG of the exact owned
window. The initial Terms PNG precedes either press. Post-acknowledgement and
persisted-body PNGs require `Creator Works MCP` in the complete AX tree, not
only title-bar chrome. The state/window are rechecked on both sides of capture.
PNG SHA-256, phase/PID and decoded pixel metrics are recorded. Pixel sampling
excludes 6% at each side and 20% at both top and bottom, checks bounded dimensions,
color diversity and non-background samples. Pixel variation alone is not
semantic, AI, Unity or updater acceptance.

Only the exact owned PID/bundle/executable may receive
[normal quit](https://developer.apple.com/documentation/appkit/nsrunningapplication/terminate()).
There is no force kill, unrelated app close, forced unmount, TCC/Gatekeeper
change, quarantine removal, signing bypass or auth mutation. Apps/mounts that
cannot stop normally are retained and reported. `download-report.json`,
`binding.json` and `native-report.json` are uploaded even on failure, not promoted
into native signed-update acceptance receipts. Exit 1 denotes failure; exit 2
denotes a blocked GUI/security scope. Prior failed
[CI 38392823489](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38392823489)
remains referenced and is not overwritten or reclassified by a later pass.

## Local Verification and Next Evidence

The existing native reports from
[Mac body probe 38402267985](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38402267985)
were inspected locally at
`artifacts/mac-body-intel-38402267985/native-report.json` and
`artifacts/mac-body-arm-38402267985/native-report.json`. Both report existing AX
trust, screen-capture access and a display, and contain the actual owned WebKit
Terms tree with the two exact controls. Their `owned-gui-0.1.13.png` captures
show the first-run terms screen. Neither report proves acknowledgement or a
post-terms MCP body. Both retain Gatekeeper rejection (exit 3) and the previous
no-acknowledgement blocker; ARM additionally retains the bundle/Mach-O minimum
mismatch. These reports are historical evidence, not overwritten or promoted by
the new synthetic test. `historicalNativeReports` retains the original blocked
status, scope, zero-failure count and architecture-specific blockers, separately
from the original failed component CI in `historicalFailures`.

Synthetic tests run only against temporary files and injected lifecycle
operations. They exercise the real validators/orchestration and Windows native
refusal; text checks on Swift/workflow are not a compiled Mac test.

```powershell
& 'C:\Users\bobman\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test --test-reporter=spec scripts/native-mac-maintenance-smoke.test.cjs
```

The local host has no Swift compiler/macOS SDK. Compilation and execution of
the new AXPress, body-pixel and persisted-terms checks remain unverified until
the disposable native jobs run. Existing native snapshots do not establish the
new actions. Local Node **24.19.0** verification: **67 harness tests passed,
0 failed, 0 skipped**. Both CJS files pass `node --check`; Swift/workflow assertions
are structural only. These source/unit results are not native GUI acceptance.

The preference addon retains that 67-test baseline. Local Node 24 verification
now passes **98 harness tests, 0 failed, 0 skipped** (31 added). Pure injected-ops
faults cover missing/ambiguous/disabled checkbox state, already-off/near-match
controls, privacy prompts, action and snapshot identity mismatches, a receipt
without an observed off state, returning on after normal relaunch, uncertain
presses, absent capabilities, returning Terms and refused normal quits. The
existing old-12 blocker/normal-cleanup tests still pass. A simulated report is
an orchestration test, not an actual native preference result; Swift compilation
and target-13 preference persistence remain unverified until Mac CI runs.

All existing source/run/artifact pins above remain unchanged. The owner's ARM
minimum-OS configuration and other product/build-bound changes require a new
successful CI baseline before pins are reviewed/refreshed and the native lanes
run. They are not added to a broader tree-exclusion allowlist. Gatekeeper exit 3
and minimum mismatch remain blockers, with no policy bypass.
Remaining source of acceptance is the preserved native reports plus a separately
reviewed macOS updater lab with exact signed descriptor/archive bytes, real
native cancel/consent, outgoing owned-process shutdown, automatic restart,
effective settings preservation and live companion/client reconnect. Those lab
inputs are not available in this bounded probe; release readiness stays false.

## Bounded Post-Exit WebKit Diagnostic

The additional `webkitPreferenceDiagnostics.captures` receipts are diagnostics,
not acceptance evidence. They run after **each verified normal exit**, including
owned cleanup following the existing off-to-on relaunch failure. Failed,
already-exited, unrequested or forced termination never authorizes a store read.
The original GUI assertion, raw snapshots, PNG gates, Gatekeeper assessment,
historical failures and `releaseReady: false` are unchanged. Swift and artifact
pins are unchanged. No new runtime/UI behavior or permissions are introduced.

Pinned Wry 0.55.1 uses `WKWebsiteDataStore::defaultDataStore` when no custom
identifier/incognito configuration is supplied. The expected app origin is
`tauri://localhost`. WebKit primary source derives the default non-container root
as `$HOME/Library/WebKit/com.creatorworks.hub/WebsiteData`, and distinguishes
legacy `LocalStorage` from unified `Default` storage:
[default Cocoa paths](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/WebsiteData/Cocoa/WebsiteDataStoreCocoa.mm),
[localStorage filenames](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/NetworkProcess/storage/LocalStorageManager.cpp).

Only these exact source-derived candidates are inspected; no directory search,
other app/profile scan or container fallback is performed:

- `LocalStorage/tauri_localhost_0.localstorage`
- `Default/<H>/<H>/LocalStorage/localstorage.sqlite3`, only when `Default/salt` is exactly eight bytes.

`H` is unpadded base64url of SHA-256 over UTF-8 `tauri://localhost` followed by
the salt, for identical top/client origins. This follows
[origin-path derivation](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/NetworkProcess/storage/NetworkStorageManager.cpp),
[salt size](https://github.com/WebKit/WebKit/blob/main/Source/WTF/wtf/FileSystem.h),
[base64url encoding](https://github.com/WebKit/WebKit/blob/main/Source/WTF/wtf/text/Base64.h).
Those paths are **candidates, not proof of the running WebKit version's active
origin/profile**. Every receipt retains `activeStoreBound: false` and
`rootCause: unknown`; absent, unsupported or ambiguous candidates remain unknown.

Production reads require the existing exact hosted-Mac CI guard, an app WebKit
root absent at lane preflight, and no running Hub after the verified exit.
The fixed paths reject symlinks/junctions, non-files, hardlinks and foreign UID
ownership. Each candidate DB and WAL is capped at 2 MiB, SHM at 128 KiB, and salt
at eight bytes. A present rollback journal, orphan sidecar, invalid salt or two
candidate DBs refuses key capture. Root/file identity, size, mode, timestamps and
SHA-256 are recorded, not file contents.

Exact bounded DB/WAL/SHM bytes are copied to a private, newly owned scratch
directory under `RUNNER_TEMP`, outside the uploaded report directory. Node 24
SQLite opens only the copy with `readOnly`, `query_only` and `trusted_schema=OFF`;
WAL is retained, not bypassed using immutable mode. Source identity and hashes,
including sidecar absence, are rechecked after the query. Drift invalidates the
key receipt. Scratch copies are removed in `finally`; no salt bytes or raw DBs
are reported/uploaded. Cleanup failure is unknown, not a pass.

Only the exact `ItemTable` schema is accepted:
`key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB NOT NULL ON CONFLICT FAIL`.
The parameterized query reads only `creator-hub.auto-download`, with a 64-byte
value bound. Recognized values are UTF-16LE `true`/`false`; receipts record that
key's type, size, raw hex and decoded value, or an error. A missing key can be
reported only inside a validated candidate DB, never inferred from missing files.
No unrelated keys or values are selected. See
[SQLite storage schema/query](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/NetworkProcess/storage/SQLiteStorageArea.cpp) and
[UTF-16 blob binding](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/sql/SQLiteStatement.cpp).

Local Node 24 verification currently has **133 passed, 0 failed, 1 skipped**
across 134 tests (22 additional tests). The skipped file-symlink test requires
Windows symlink privilege; the actual directory-junction refusal test passed.
Fixtures cover both exact layouts, encoded true/false, WAL-only committed data,
unchanged source SHM, malformed/missing/ambiguous stores, schema/value bounds,
links, source drift and failure-cleanup receipts. These are synthetic fixtures,
not the runner's actual storage or native acceptance. Main dispatches the next
native run after review; backend persistence/lifecycle root cause remains unknown.

## Files Owned by This Worker

- `scripts/native-mac-maintenance-smoke.cjs`
- `scripts/native-mac-maintenance-smoke.test.cjs`
- `scripts/native-mac-window.swift`
- `docs/MAC-MAINTENANCE-VALIDATION.md`

The workflow is owned separately. Its path remains one of the five historical
Mac testing-only tree exclusions; this task edits only the four files above.
