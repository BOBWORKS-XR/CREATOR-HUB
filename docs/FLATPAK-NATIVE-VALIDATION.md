# Disposable Flatpak Native Validation

Experimental sidecar for `allplatformmaintenance0.1.13`, separate applications.
`releaseReady=false` is unconditional, including a completely green probe run.
Main owns the native Linux signed updater and final product review; macOS is a
separate lane. Consolidation remains deferred to 0.1.14 or later. This sidecar
does not edit application source, the package generator, packaging assets,
existing workflows, release feeds or signing inputs.

## Exact Reviewed Inputs

| Identity | Value |
| --- | --- |
| Repository / source PR | `BOBWORKS-XR/CREATOR-HUB`, PR22 |
| Successful CI run / attempt | `38393759689` / `1` |
| Source head | `6d47bd0790cfc5c3560495bbd92c37b3cd06df14` |
| CI artifact build / PR merge | `cb7499b592b4260f6733b7ff5ef7c670f74233a0` |
| Source and merge tree | `8b1deb17843f753f7b6fe5cf3560412ed8b541d9` |
| Linux artifact ID | `11810908524` |
| Artifact name | `hub-development-Linux-X64-cb7499b592b4260f6733b7ff5ef7c670f74233a0` |
| Artifact ZIP bytes | `96940196` |
| Artifact ZIP SHA256 | `681ef6fcb50f77f588f6f9e88a13fbbf9545b56ba6473f4fe749c3a6a22f44d1` |
| Native DEB | `Creator Hub_0.1.13_amd64.deb` |
| Native DEB bytes | `5975036` |
| Native DEB SHA256 | `57ff363701a49c8d603efb677a3720ddc5c2b2443a9b019f0afd5be922ac5374` |

The user supplied the reviewed DEB hash/size. Public GitHub metadata was checked
on 2026-10-13 for the successful run, source head, repository, artifact ID,
artifact digest/size, merge parents and equal source/merge trees. No native
installation, Flatpak build or remote workflow dispatch was performed locally.
The workflow repeats these checks against live metadata and downloaded bytes;
this dated table is not proof that an artifact remains available indefinitely.
See [the exact CI run](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38393759689).

## Before-Merge Execution

The new workflow runs on `pull_request` changes limited to the four probe files,
so it does not need an early default-branch merge or a potentially unavailable
new `workflow_dispatch` endpoint. Pull-request runs use the exact reviewed
defaults above, not a latest-success lookup. Manual dispatch remains available
once GitHub exposes the workflow; explicit inputs select another separately
reviewed PR22 run/head/artifact/ZIP hash+size/DEB hash+size.

Checkout uses the harness PR head, not its merge ref. Before provisioning:

1. Fetch the exact candidate source commit from the public repository.
2. Check actual `HEAD^{commit}` against the workflow's requested harness ref.
3. Diff that source against harness HEAD with renames disabled. Accept only the
   finite reviewed test-only exclusions below, including coexisting platform
   probes and the Windows baseline acceptance edits. Workflow triggers remain
   limited to the original four Flatpak probe files.
4. Refuse a dirty checkout, ref mismatch or any difference outside those exact
   paths. Product/resource/packaging/runtime changes and existing build CI changes
   still fail. Newer harness source is not silently treated as the binary's source.
5. Require the requested successful PR22 CI run, its successful Linux job in the
   same attempt, repository IDs, source head, exact artifact ID/name/digest/size,
   merge second-parent/source relationship and equal source/merge product tree.

An expired artifact or mismatched ref stops the run. Update the reviewed pins
explicitly; do not fall back to another release, run, artifact or renamed DEB.
The artifact label is deliberately **not** equated with the run's head SHA.

`PROBE_FILES` remains the four Flatpak paths. `REVIEWED_TEST_ONLY_FILES` adds
exactly these twelve paths to the frozen `TREE_EXCLUSIONS`, with no directory
or filename-pattern exemptions:

- `scripts/native-linux-maintenance-smoke.cjs`
- `scripts/native-linux-maintenance-smoke.test.cjs`
- `scripts/native-linux-window.py`
- `.github/workflows/linux-maintenance-validation.yml`
- `scripts/native-mac-maintenance-smoke.cjs`
- `scripts/native-mac-maintenance-smoke.test.cjs`
- `scripts/native-mac-window.swift`
- `.github/workflows/mac-maintenance-validation.yml`
- `docs/MAC-MAINTENANCE-VALIDATION.md`
- `.github/workflows/windows-candidate.yml`
- `scripts/Test-InstalledCandidate.ps1`
- `scripts/self-update-baselines.test.cjs`

The regression fixture accepts all sixteen reviewed paths against source
`6d47bd0790cfc5c3560495bbd92c37b3cd06df14`, then rejects product code/resources,
package inputs, runtime evidence, build CI, and unreviewed probe paths when each
is added to that same coexistence fixture. Dirty checkout and exact-ref refusal
are retained. These exclusions authorize test coexistence, not new product bytes.

## Runner Scope

Only `ubuntu-24.04` GitHub-hosted Linux x86_64 in the exact repository is accepted.
The CLI refuses Windows, local Linux/WSL, macOS, ARM, self-hosted runners and
arbitrary roots. Tool/package provisioning exists only in that disposable job.
No local PC/WSL installation commands are part of validation instructions.

All Flatpak operations use a fresh user installation under
`RUNNER_TEMP/creator-flatpak-validation/home`, a separate system-directory
placeholder, fresh XDG roots, a synthetic D-Bus session and an Xvfb X11 display.
The native DEB is installed on the disposable runner to take a coexisting native
beforeimage; it is not launched concurrently or accepted as a native GUI test.
Only package-owned regular files and explicitly generated synthetic settings,
AI-client, Unity-project and Flatpak-data sentinel files are hashed. No home
scan, credential file, production signing key or existing project is read.

The GitHub action uses its ordinary read-only Actions/Contents token for API
downloads; no secrets context, credential file, token dump or write permission
is used. ZIP bytes are hash/size checked before bounded structural parsing.
Traversal, duplicates, links, special modes/files, unexpected file extensions,
excess members/expanded bytes and multiple DEBs are refused. Only the DEB is
extracted. The existing generator independently checks its exact hash,
`creator-hub` / `0.1.13` / `amd64`, ELF identity, resources and modes, and emits
the immutable SHA-pinned Flatpak inputs.

## Concrete Trial

- Provision Flatpak/builder/OSTree/GPG and GUI capture tools using the runner's
  package manager. Add the official HTTPS Flathub `.flatpakrepo` in the isolated
  user installation, require `gpg-verify=true`, and perform ordinary verified
  GNOME50 Platform/SDK installs. Record actual installed commits, EOL/rebase
  metadata, runtime manifest and WebKitGTK/JavaScriptCore 4.1 library paths.
- Build the exact generator manifest, export its actual app commit, sign it and
  the local repository summary using a fresh one-day **test-only** GPG identity
  generated inside this runner. Import only that public key into the local test
  remote. No production issuer identity or private-key export is involved.
- Install that exported commit and verify original executable/resource bytes
  and Unix modes against the native inventory. Structurally parse installed
  permissions: exactly GUI sockets, IPC, DRI and network, with no additional
  filesystem, full bus, environment or host-spawn grants.
- Capture actual `/.flatpak-info`, sandbox XDG paths, denied native-data/project
  paths, hidden host sentinel process, and `ldd` results inside GNOME50. Missing
  dependencies are blockers, not authorization to copy guessed libraries.
- Launch the actual packaged native WebKit window. Bind its X11 window PID to
  `/app/bin/creator-hub` inside the unique Flatpak instance. Capture window pixels,
  dimensions/color variance, OCR, launch diagnostics and namespace context.
  Require native `0.1.13`, rendered Flatpak-managed update/refusal text, and the
  completed explicit Linux-unsupported management state, not forever checking.
- If terms appear, use only the visible real checkbox and button, with bounded
  unambiguous OCR targeting. This is an explicitly synthetic VM acknowledgement,
  **not real user terms consent**. No storage seeding, DOM injection, parent-key
  change, private authority override or disabled WebKit sandbox is used.
- Make a second deployment from the finished candidate tree, retaining its
  original native executable, resources, XML and version. Add only a test marker
  bound to candidate commit, source, DEB hash and generation. Select an explicitly
  labelled local `50-validation-fixture` runtime derived from the authenticated
  GNOME50 commit. Export/sign a different app commit and use actual scoped
  `flatpak update` to deploy it, then verify the marker, original inventory and
  another native GUI capture.
- Create a second signed commit of that local runtime with identical payload,
  update only that runtime ref, verify both generation hashes and unchanged
  official Platform/SDK and app commits, require empty actual OSTree filesystem
  diffs for original-to-fixture and fixture-to-next-generation, and repeat native
  GUI capture.
- In `finally`, compare all protected before/after hashes, sizes and modes and
  host-sentinel survival, including on earlier failures. Stop only the uniquely
  identified experimental instance and the harness-owned sentinel/GPG agent.

This is a **same-version OSTree generation update**. Artifact and current source
version stay `0.1.13`. It is not a new-version binary, changed-footer update,
native14 fixture, GNOME ABI upgrade, unification, publisher-authenticated update
service or full product acceptance. Nothing in the test repository is published
or uploaded. GUI diagnostic failures are retained while the independent
integrity-bound local update trial may continue; the final job still fails for
failed checks.

## Evidence And Remaining Gates

`evidence/report.json` exists before provisioning. `finally` and workflow
`always()` finalization retain original phase errors, label unreached phases
blocked and force `releaseReady=false`. Download/tool failures, GUI crashes,
timeouts, permission/path failures and incomplete runs are not success. An
abrupt VM termination can prevent any upload; `always()` is not a promise to
survive loss of the runner. Evidence upload is an explicit file allowlist,
excluding packages, repositories, profiles, archives and all signing keys.
Command output has bounded retained tails; parsers receive complete bounded
output. Launch logs retain at most their final 64 KiB.

| Classification | Finding / scope |
| --- | --- |
| Correct as-is | This source has `supported:false` Linux MCP/Setup management. Explicit unsupported UI is the expected result, not fake Linux management acceptance. |
| Unknown / needs capture | Visible Flatpak refusal is native GUI evidence, not a direct trusted-IPC test of `download_hub_update` / `install_hub_update` refusal or disabled-button state. |
| Unknown / needs capture | No Linux host broker, reviewed Unity/helper/AI-client/companion artifacts or full process-ownership/consent harness were supplied. Capture path/PID namespace barriers, not full-host support. |
| Unknown / needs capture | Native and sandbox XDG data diverge. Opaque sentinel preservation proves neither migration nor rollback nor actual preference/content semantics. |
| Unknown / needs capture | Original resource inventory plus rendered Hub pixels do not accept every real hosted view, project operation or embedded asset. |

Before implementing any second native UI driver, ask main for its reusable
Linux harness **artifact contract**: exact run/source/artifact/hash, entry point,
WebKit/driver versions, Flatpak launch/instance handle, normal trusted-shell IPC
access, synthetic-consent procedure and report schema. Required evidence must
bind the installed app/runtime commits and executable hash and cover raw-command
denial, legitimate updater state, direct download/install refusal, disabled
Update Hub, rendered resources, completed unsupported management and retained
preferences. This sidecar supplies only bounded pixel/namespace capture, not a
duplicate of main's signed-updater/product UI suite. Main must review complete
product acceptance separately; no passed sidecar receipt authorizes publication.

During implementation, concurrent `scripts/native-linux-maintenance-smoke.cjs`
and `scripts/native-linux-window.py` appeared and were read, not edited or run.
The window driver currently takes `ACTION PID EXPECTED_EXE_SHA256`, verifies
`/proc/PID/exe` and uses the host AT-SPI application PID. That is not yet a
reviewed Flatpak instance/PID-namespace or trusted updater-command contract.
No additional accessibility-bus grant or weakened ownership check was added
to force reuse. Obtain main's reviewed artifact contract before replacing this
bounded capture or adding product-command acceptance.

## Local Tests And Primary Sources

Local non-installing checks:

```sh
node --check scripts/flatpak-native-smoke.cjs
node --test scripts/flatpak-native-smoke.test.cjs scripts/flatpak-package.test.cjs
```

On Windows the generator's real Linux/WSL integration test remains skipped;
do not set its optional WSL installation/validation variables for this task.
No Flatpak/native installation acceptance is claimed from these tests.

Primary references checked for the runtime/toolchain design:

- [Flatpak command reference](https://docs.flatpak.org/en/latest/flatpak-command-reference.html): per-user installs, export/signing, local repository updates, `build-commit-from`, scoped update flags and namespace/process inspection.
- [Flatpak builder command reference](https://docs.flatpak.org/en/latest/flatpak-builder-command-reference.html): actual manifest builds and export options.
- [Flatpak sandbox permissions](https://docs.flatpak.org/en/latest/sandbox-permissions.html): filtered bus, XDG isolation, process/filesystem boundaries and minimal GUI/network grants.
- [Flathub installation](https://docs.flathub.org/docs/for-users/installation): official HTTPS repository setup with its public GPG trust material.
- [Available runtimes](https://docs.flatpak.org/en/latest/available-runtimes.html) and [GNOME50 developer notes](https://release.gnome.org/50/developers/): runtime selection; installed commit/content/EOL checks remain mandatory.
- [GitHub workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs) and [artifact API](https://docs.github.com/en/rest/actions/artifacts): run/source/attempt metadata, immutable artifact IDs, archive digests and temporary download redirects.
- [OSTree diff reference](https://manpages.debian.org/bookworm/ostree/ostree-diff.1.en.html): compare real revisions for added, modified or deleted filesystem entries before claiming unchanged runtime payload.

Earlier runtime source/remote metadata evidence remains in
`packaging/flatpak/runtime-50-evidence.json`; it is not substituted for this
experiment's authenticated installation and native execution capture.
