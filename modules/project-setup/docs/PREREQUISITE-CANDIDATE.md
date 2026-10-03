# Windows Prerequisite Installation Candidate

Status: published Windows prerelease `0.3.0-alpha.6`. The following is its
development history; older local artifacts are not the published CI binaries.

## Alpha.6 Release (2026-09-13)

The clean committed candidate and all three installed upgrades have passed:
[candidate](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34754280271),
[stable 0.2.2 / alpha.1 / alpha.2 upgrades](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34754654023).
Signed release metadata is prepared for the exact CI installer and extracted
executable, with minimum Creator Hub 0.1.0-alpha.6. The
[fresh prerequisite test](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34754298548)
and [paired Hub staged matrix](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/34754847040)
also passed. All 11 Setup public assets match the accepted stage, including
signature and tamper-rejection checks. Hub records public-feed acceptance separately.
Current verification and limitations are in the
[alpha.6 release notes](RELEASE-0.3.0-alpha.6.md); the sections below preserve
earlier local candidate results and must not be read as tests of the new CI bytes.

## Alpha.6 Matched-Candidate Checkpoint

Alpha.6 includes the alpha.5 requirements refresh and alpha.4 download metrics,
plus the Creator Hub menu correction: it opens Hub releases, not the historical
planning document. Existing candidate ZIPs are unchanged. This is a local test
build, not a public release. Paired Hub hosting requires verification of the
exact new executable and separate native acceptance; packaging alone is not
proof of installation, upgrade, or fresh-machine success.

## Alpha.5 Requirements Display

Alpha.3 and alpha.4 retained the initial requirements list until the complete
project-creation operation ended. This could show Unity as Missing while the
newly installed Editor was already importing the project.

Alpha.5 includes the native installation-check snapshot in the first project
progress event. The requirements rows, old blocker and Hub action update before
import finishes. Both standalone and hosted views consume the same event; no
extra refresh request is queued behind hosted creation. Later import updates do
not repeat the inventory, and project-written progress files cannot supply it.
Incomplete checks remain incomplete: a download or a stage number alone never
marks requirements installed. Project creation stays locked until completion.
The download visibility from alpha.4 is retained. Prior candidate files and their
acceptance evidence below are unchanged; this is not a released update.

Local alpha.5 checks: 63 Rust tests, 2 executable metadata checks, 49 browser
tests and 15 packaging/owned-process tests pass, with strict Clippy and formatting.
The UI regression covers the reported Missing-to-Installed transition during
import, cleared stale blockers, unchanged creation locks and no queued refresh
command. Native serialization tests prevent project progress files from claiming
installation checks. Real clean-machine and installed-upgrade acceptance of this
new executable remain separate from these checks.

## Alpha.4 Download Visibility

Alpha.4 adds current-file bytes, total file size and transfer speed to the
prerequisite progress panel. The full Editor/tools download size is separate.
Existing alpha.3 binaries and their acceptance evidence below are unchanged.

- Hub download bytes come from Setup's existing HTTP stream.
- Unity Editor/module rates are estimates from recent installer-file growth in
  the configured download cache, polled once a second. File handles are closed
  immediately; no installer files are read, modified or locked against writes.
- Observation is restricted to names and sizes from the pinned Windows x64
  release, also checked against the approved CLI preview. Unknown, ambiguous,
  inaccessible or already-complete files show size/rate as unavailable.
- CLI grouped percentages are not treated as current-file percentages or bytes.
  Installer phases remain indeterminate. Speed resets between components and
  retries; missing updates clear the last displayed rate.
- Rates describe observed transfer/file growth, not Internet connection capacity.
  This improves visibility, not download speed. Actual beta.9 telemetry on the
  second PC still needs verification; local tests are not that acceptance.

Reference: [pinned Unity release manifest](https://services.api.unity.com/unity/editor/release/v1/releases?version=6000.3.21f1).
No dependency, download URL, verification, approval, install argument or licence
handling changes are part of this display update. No automatic log upload.

Local alpha.4 checks: 62 Rust tests, 2 executable metadata checks, 47 browser
tests and 15 packaging/owned-process tests pass. Strict Clippy and formatting
checks pass. A real PowerShell child writes a fixture with exclusive sharing;
size and nonzero rate update while its CLI percentage stays unchanged. Ordinary
data reads failed this test; metadata-only handles pass without opening the
installer contents. This fixture does not download or install Unity.
Published `0.3.0-alpha.2` does not install missing Unity requirements.

## Intended Flow

1. Enter a new project name and parent folder.
2. Choose **Set up and create project** when Windows requirements are missing.
3. Review the native installation confirmation: exact Editor version, locations,
   estimated download and conservative free-space reserve. Explicitly accept
   the linked Unity, Android SDK/NDK and OpenJDK terms to proceed.
4. Setup downloads the pinned official Hub installer and checks its exact SHA-256,
   valid Windows Authenticode signature, signing certificate and product version
   before launch. The verified official Unity CLI installs Editor/modules.
   Windows may request administrator approval.
5. Setup checks actual Editor/tool files and the installed URP template. An
   installer exit code alone is not considered sufficient.
6. If an active Unity licence cannot be verified, open Unity Hub from the prompt,
   complete first-run setup and sign-in/activation, and return to the same form.
   An authentication/configuration response is not proof of an inactive licence;
   it still blocks project creation until an active licence is verified.
   Installed prerequisites are retained; no project folder is created before
   this check passes.
7. Continue through the existing Creator SDK project creation, compilation,
   Visual Scripting initialization and second-session validation.

This is a single setup action, not a promise to bypass account, licence or OS
approvals. macOS/Linux automatic installation is not implemented.

## Boundaries

- The Editor/SDK recipe is unchanged. Android and Windows remain mandatory.
- An existing old Hub is not silently upgraded; automatic project registration
  still requires Hub 3.21.1 or newer. New projects can be added from disk in an
  older Hub.
- A ready, licensed CLI-only installation remains usable without adding Hub.
  If activation is missing and Hub is absent, the candidate offers an approved
  Hub installation before the sign-in handoff. That native CLI-only activation
  route still needs user acceptance testing.
- Missing Android modules can be added to the verified managed Editor. A
  damaged core Editor or unregistered/conflicting installation is blocked with
  instructions instead of being overwritten or duplicated.
- Installation approval is followed by a fresh path/inventory check. Module
  installs also check that the selected Editor is closed. No app is force-closed.
- Cancellation is available before installation. Once an installer has started,
  Setup waits for it; it does not abruptly kill an installer or offer a misleading
  immediate cancel button.
- Download percentages and component messages are forwarded from the CLI.
  Installation phases remain indeterminate; the CLI's installation percentage
  is not treated as measured extraction progress.
- Preflight storage is a conservative reserve, not an exact disk estimate. It
  cannot guarantee that another program will not consume space during setup.
- Retrying inspects the installation again. A partial/unregistered Editor that
  cannot be verified is not silently removed. Failed project folders are still
  preserved, not recreated over existing content.
- Raw Unity account/licence and CLI environment responses are parsed only in
  memory, not written into support logs. Other logs still require review before
  sharing.

## Validation Gates

The local candidate passes 57 Rust unit tests, 2 executable metadata
integration tests, 43 UI tests and strict Clippy. These are not clean-machine
installation proof.

The healthy-machine creation smoke passed on 2026-09-11: existing requirements
were reused without installation; the licence precheck passed; a new disposable
project compiled, initialized 31,818 Visual Scripting nodes including 172 Creator
nodes, passed second-session validation for Android/Windows and URP, and was
read back from Hub's project registry. This does not prove a fresh-account
activation flow, native Hub list visibility, or actual Android/Windows builds.

Local packaging checks also passed, including original notices, extracted
installed payload identity, portable metadata and an active-app installer guard.
These are not installed-upgrade acceptance of alpha.3.

The owner approved a disposable Windows CI installation of Unity and required
Android tools without using their Unity account. Early runs stopped before
installation: the image included Hub, preview output was not pure JSON, and
the system volume had insufficient free space. The image's signed Hub is now
removed with its own uninstaller; only ordinary files in unused CodeQL/Python
tool caches are cleared. Linked entries and all existing Editor folders are
left untouched. Application storage checks were not relaxed for CI.

Run [34595273184](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34595273184)
captured the exact CLI preview format for a committed regression fixture.
Run [34598566899](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34598566899)
saved successful full-install and isolated OpenJDK-repair receipts. Its test also
passed reuse and Java/javac/ADB/NDK clang execution before the final licence query
returned exit 4 (configuration/context required). The overall run was cancelled
near that failure and is not a passing gate. The saved logs, not a quiet live
log display, establish that installation completed.

Source `a002320` handles read-only licence-query authentication/configuration
exits as an unverified licence requiring a user handoff; unrelated errors still
fail. It also displays the CLI's actual `msg` progress text. The rerun
[34602021240](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34602021240)
records checkpoints after each phase, executed tool versions, and bounded
process/download activity without command lines or account data. It passed on
2026-09-11 at source `a00232046092f36181c960cd94e9608edfa7c675`:

| Actual disposable Windows check | Result |
| --- | --- |
| Cancel before installation, no Editor/modules/project created | Passed |
| Hub 3.21.1 download, valid pinned signature and installation | Passed |
| Unity 6000.3.21f1, required Android tools, Windows support, URP template | Passed |
| Reuse verified installation without a second installation approval | Passed |
| Remove only owned `java.exe`, reinstall the OpenJDK module | Passed |
| Execute Java/javac 17.0.18, ADB 36.0.0, NDK clang 18.0.3 | Passed |
| Unverified licence requires user handoff, no project created | Passed |
| Unity account used or licence activation tested | No |

The actual installation/repair smoke took 928.59 seconds; the complete job,
including fixture preparation and compilation, took about 23 minutes. The
acceptance receipt reports `completed`, `prerequisitesVerified`,
`cancellationVerified`, `existingInstallReused`, `missingJdkRepaired` and
`activationHandoffRequired` as true. `projectCreated`, `unityAccountUsed` and
`licenseActivationTested` remain false. This proves the tested automated
installation route, not a fresh-user project or native dialog interaction.
Future runs use opt-in workflow dispatch; the temporary push trigger was removed.

Separate gates remain for declined elevation, interrupted downloads and retry,
fresh-machine sign-in/activation, and Creator project creation after a fresh
install. Only isolated OpenJDK repair has real module-repair evidence; this does
not prove every damaged installation can be repaired. Do not label untested
routes verified from unit tests.

Creator Hub currently pins the older Setup executable and drops the new event.
An isolated Hub patch (`a02cf14817b23546958516996a6d09bea0518301`) adds native and
renderer `requirements-progress` allowlists and independent bounded event
throttles, with forwarding/session/transition tests. It is not published or
pinned to this executable. Do not update that pin before candidate acceptance.

## Other-PC Acceptance

Use the exact alpha.6 prerelease, with matching Creator Hub
alpha.6 for hosted testing, or standalone. Keep the portable package and its notices
together. Do not uninstall existing Editors or delete projects for this test.

1. Choose a new project name and parent folder with enough free space. Select
   **Set up and create project** and review **Accept and install**.
2. Approve Windows prompts only for the expected verified Unity installers.
   Expect download/component stages; installation is not a timed percentage.
3. If prompted, complete Unity Hub first-run setup, sign-in and activation.
   Return to Setup and select **Create and validate project**. It should reuse
   the installed requirements, not download the whole Editor again.
4. Success means the new project passes compilation, Creator/Visual Scripting
   setup and reopen validation. Open it in Unity to check for first-run dialogs
   or compile errors. This is not an Android/Windows build or headset test.

On failure, retain the exact displayed error, candidate version and local report
path. Review the receipt/log before sharing it, following [Reporting](REPORTING.md).
If a project folder was already created, preserve it; Create does not resume or
overwrite failed projects. A retry must use a new name unless a separate reviewed
repair is explicitly chosen.

## Source Contracts

- [Unity CLI reference](https://docs.unity.com/en-us/unity-cli/unity-cli-reference)
- [Unity's installation command guidance](https://github.com/Unity-Technologies/skills/blob/main/skills/unity-cli/references/editors-install.md)

The pinned CLI is experimental. Its actual `--help` and read-only previews were
checked: JSON dry-run is required; the NDJSON dry-run produced no final report.
Even `--quiet --json` previews prepend dependency notices on stdout. The adapter
permits only the exact known notice syntax before one complete JSON document;
unknown warnings/errors and trailing data remain rejected.
The genuine Hub 3.21.1 Windows download was independently verified locally.
Beta.9's `hub install` rejected it during CI with a signature error naming a
macOS Developer ID; Setup therefore uses its own Windows trust verification
and official installer launch. No signature-check bypass flag is used.
OpenJDK uses a release-specific module ID, and repair dry-runs must include
`--reinstall` to describe the same repair set as the approved install.
