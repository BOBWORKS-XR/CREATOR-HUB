# macOS 0.1.13 Maintenance Validation

## Scope and Release Hold

This probe is for the **separate-app 0.1.13** Hub only. Unification stays at
0.1.14 or later. It changes no app source, catalog, signed descriptor, companion
installer or Flatpak file. Follow [maintenance gates](MAINTENANCE-0.1.13-GATES.md),
[release gates](RELEASE-GATES.md) and the
[publication checklist](HUB-PUBLICATION-CHECKLIST.md).

The report always has `releaseReady: false` and `updater.tested: false`.
Public 0.1.12 `self_update.rs::installed_location` refuses non-Windows managed
updates: [exact public source](https://github.com/BOBWORKS-XR/CREATOR-HUB/blob/35a16a45814d821d65b5d203628478449174cd55/src-tauri/src/self_update.rs).
Copying a DMG app into Applications and manually launching it is **not** native
update discovery, cancellation, approved download, automatic restart or reconnect
proof. No version-only fixture is built or substituted for the old public app.

## Exact Evidence Binding

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
must match the artifact source except sixteen exact reviewed testing-only paths:
the five Mac files below, the Linux harness/test/window/workflow, the Flatpak
harness/test/workflow/evidence document, and the reviewed Windows baseline changes
in `windows-candidate.yml`, `Test-InstalledCandidate.ps1` and
`self-update-baselines.test.cjs`. The complete finite list is retained in the
report's `productTree.excludedPaths`. There are no directory/glob exclusions:
app source, Unity/script resources, settings, versions, package locks and all
other files retain full mode/type/hash comparison. Any other change is a blocker
requiring review, not permission to rebuild silently. Run/head/merge-parent/tree
and artifact byte binding are unchanged by this testing-path admission.

## Workflow and Native Lanes

`.github/workflows/mac-maintenance-validation.yml` has a paths-limited
`pull_request` trigger for only these five files, plus independent manual
dispatch. This lets the probe run on draft PR22 after the owner commits/pushes
the reviewed files, without merging merely to register a dispatch-only workflow.
No remote dispatch, commit or push was performed by this implementation.
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

In the manual lane the unchanged public 0.1.12 app is installed/launched first.
After its owned PID quits normally, the old bundle is retained in the owned
runner evidence directory, then 0.1.13 is copied to the same Applications path.
Each normal LaunchServices open records the actual PID, bundle path and executable
path, with distinct old/new PIDs. No direct-executable launch fallback bypasses
LaunchServices, security policy or consent. A refused quit stops replacement;
failed replacement is recorded with the original bundle retained, not hidden by
automatic retries or a fabricated success.

## Preservation and GUI Boundaries

Opaque random byte sentinels cover Hub storage/adoption/projects, current and
legacy MCP data roots, Setup cache/receipt roots, a client-entry root, unmanaged
project content and unmanaged installation siblings. Separate MCP/Setup payload
sentinels live in clearly named `.fixture` directories, not fake launchable apps.
Bytes, length and mode are compared after each normal quit and again on failure.
No existing config, auth file, terms-acceptance record or signed app bundle is
edited. The root choices are preservation probes, not proof of every companion's
actual runtime data contract.

This proves **opaque file preservation only**. It does not assert effective
WebKit/localStorage preferences, account identity, real saved/adopted project
semantics, actual companion installs, live-client settings or reconnect.

The compiled Swift helper probes existing
[AX trust](https://developer.apple.com/documentation/applicationservices/axisprocesstrusted())
and [screen-capture access](https://developer.apple.com/documentation/coregraphics/cgpreflightscreencaptureaccess()).
It never requests permissions. Read-only, bounded AX/window snapshots target
only the owned app PID. Missing capability, missing visible window, incomplete
AX capture, legal acknowledgement or a possible privacy/security prompt is
reported as `blocked`. No legal acknowledgement is accepted or seeded by this
probe, even on disposable runners. Any later synthetic test acknowledgement
would need explicit fixture labelling and still would not be real-user consent.
No OS security/privacy prompt may be accepted by the harness.

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

Synthetic tests run only against temporary files and injected lifecycle
operations. They exercise the real validators/orchestration and Windows native
refusal; text checks on Swift/workflow are not a compiled Mac test.

```powershell
& 'C:\Users\bobman\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test --test-reporter=spec scripts/native-mac-maintenance-smoke.test.cjs
```

The local host has no Swift compiler/macOS SDK, so helper compilation, native
installation, GUI snapshots and OS policy behavior remain unverified until the
four disposable native jobs actually run. A green component CI is not that run.
Local Node **24.19.0** verification: **42 harness tests passed, 0 failed, 0 skipped**;
with unchanged `scripts/macos-signing.test.cjs`, **43 passed, 0 failed, 0 skipped**.
Both CJS files pass `node --check`. Workflow assertions are structural only;
no installed YAML parser was available locally and GitHub has not executed this
new workflow. These results are not native installation or GUI acceptance.
Remaining source of acceptance is the preserved native reports plus a separately
reviewed macOS updater lab with exact signed descriptor/archive bytes, real
native cancel/consent, outgoing owned-process shutdown, automatic restart,
effective settings preservation and live companion/client reconnect. Those lab
inputs are not available in this bounded probe; release readiness stays false.

## Files Owned

- `scripts/native-mac-maintenance-smoke.cjs`
- `scripts/native-mac-maintenance-smoke.test.cjs`
- `scripts/native-mac-window.swift`
- `.github/workflows/mac-maintenance-validation.yml`
- `docs/MAC-MAINTENANCE-VALIDATION.md`
