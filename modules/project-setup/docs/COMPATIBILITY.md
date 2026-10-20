# Compatibility Evidence

## Approved Windows Recipe

| Item | Requested or declared | Observed in Unity |
|---|---:|---:|
| Unity Editor | 6000.3.21f1 | 6000.3.21f1 |
| Creator SDK | 4.0.14 | 4.0.14 |
| URP | SDK declares 17.4.0 | 17.3.0 built-in |
| Input System | SDK declares 1.4.4 minimum | 1.20.0 |
| Android support | Required | Available |
| Windows support | Required | Available |

Disposable Windows project `CreatorSetupSmoke-008` compiled and passed the
strict baseline validator on 2026-09-10. The test used the exact project-creation
function behind the application button.

Unity 6000.3.10f1 was also tested and rejected for this recipe: Creator SDK
4.0.14 uses UI Toolkit members that are not available to compilation on that
Editor patch, despite the package metadata declaring 6000.3.10f1. This is why
the application pins a tested recipe instead of following the registry's
`latest` tag or minimum Editor field automatically.

This proves package resolution and Editor compilation on the tested Windows
machine. It does not prove Android/Windows player builds, hosted loading,
headset behavior, macOS/Linux execution, or multiplayer behavior.

## 0.2.0 Windows Preview Checks (2026-09-10)

- `CreatorSetupSmoke-011`: fresh creation through the application's backend,
  separate Unity reopen/validation, then CLI registration. The CLI listed the exact
  project path after adding it. **This did not prove desktop Hub registration**;
  see the 0.2.1 correction below.
- `CreatorSetupRepair-003`: disposable copy with a missing required module and
  missing node database, plus a custom `System.Text.StringBuilder` type selection.
  Approved repair restored the module and generated 31,904 nodes, including 172
  Creator nodes. All pre-repair type/assembly selections passed the preservation
  check after reopening. The sample scene and user-content sentinel were unchanged;
  the backed-up manifest matched the original bytes.
- A subsequent validation-only operation also passed on that repaired project.
  Both validation logs contained zero C# compilation errors.
- Hub retry passed for an already-registered project. Unity CLI treats a duplicate
  `projects add` as an error, so Setup checks the registry first and verifies the
  final state instead of reporting a false failure.
- 17 Rust unit tests and 15 Playwright tests passed, including stale-review
  rejection, open-project blocking, approval gating, backup integrity, exact-path
  Hub matching, failed Hub retry, and both 980px and 720px UI layouts.
- Rust Clippy passed with warnings treated as errors.
- The real helper download path was tested with the cache absent. The downloaded
  Windows binary matched the pinned size and SHA-256, and Hub verification passed.

These checks cover the tested Windows/Unity recipe, not arbitrary existing
projects. CLI registry readback is distinct from desktop Hub compatibility and
UI visibility. Native macOS/Linux workflows and full player builds remain
unverified. No user-maintained project was repaired during these tests.

## 0.2.1 Hub Compatibility Correction (2026-09-10)

A user reproduced the missing-project issue in Hub 3.14.4 despite the successful
CLI receipt. Read-only inspection found the project in the CLI's `hub.db` projects
table but not in `projects-v1.json`. The installed Hub's `ProjectStorage` code
confirmed it reads/writes the JSON store. This is a storage incompatibility, not
merely a stale Hub window.

The downloaded official Hub 3.21.1 installer was inspected without installing or
executing it. Its distributed application code uses the same SQLite schema and
`hub.db` path as the CLI and supports migration from the JSON store. No Unity
implementation code was copied into this repository.

Setup now gates CLI registration on detected Hub 3.21.1+ and reports unknown,
older, or prerelease versions as requiring review/update. Creation and Open stay
available. The retry refreshes Hub detection and never recreates the project.
The success wording describes database registration, not observed UI visibility.

Regression checks: 19 Rust unit tests and 16 frontend tests, including a legacy
Hub failure gate that stops before any helper operation. Live native visibility
after upgrading Hub remains an acceptance check; source compatibility alone is
not recorded as a passed UI test.

## 0.2.2 Running Hub Refresh (2026-09-10)

- Hub 3.21.1 visibly omitted `F:\UnityTest\hubtest2`, although the official CLI
  listed that exact path in its registry. Read-only inspection of the installed
  Hub showed `loadProjects()` is called during initialization; ordinary refresh
  recollects metadata for paths already in memory, not new database entries.
- Closing the Hub window left its main process running in the system tray.
- The application's new Windows Restart Manager routine was executed against
  that Hub after user approval. It requested graceful shutdown of the verified
  main Hub process only, with no force flag, then reopened Hub.
- Native window capture confirmed `hubtest2` at the top of the Projects list.
  The three pre-existing Unity Editor processes retained their process IDs;
  the main Hub process changed from 62028 to 28972. No Editor was launched or
  intentionally closed, and no project creation/repair ran during this check.
- This closes the earlier native Hub visibility acceptance gap for this tested
  Windows/Hub version. macOS/Linux automatic restart, busy-install handling,
  and unresponsive-Hub behavior have not been tested live. The confirmation
  explicitly asks users to finish downloads/installations before restarting.
- Regression checks: 22 Rust tests passed (four live tests excluded from the
  default suite), 21 Playwright UI tests passed, and Clippy passed with warnings
  treated as errors. The separate live Hub restart test also passed. UI tests
  cover successful, cancelled, failed and duplicate restart requests, disabled
  conflicting controls, and manual instructions on non-Windows platforms.
- The final portable 0.2.2 EXE also passed the complete native GUI workflow:
  `CreatorSetupRelease-022` was created on a drive with available space, compiled,
  initialized Visual Scripting, and passed the separate reopen validator. Its
  receipt reported both required build targets supported and 172 Creator nodes;
  neither Unity log contained a C# compilation error. The running Hub initially
  omitted the project. Cancelling the native restart dialog left Hub PID 28972
  unchanged; confirming replaced it with PID 55396. Native Hub capture then
  showed the new project and its exact path at the top of Projects. All three
  original Unity Editor process IDs remained unchanged throughout.
- An earlier attempt on a full project drive failed with package extraction
  `ENOSPC` errors. Its project and logs were retained; it was not reported as a
  successful creation. Free-space preflight and a clearer disk-full message are
  still needed. The successful retest used a different destination, not an
  overwrite of that failed project.

The app reports registry and restart outcomes separately. It does not claim to
read back every user's visible Hub list, silently restart Hub, or overwrite its
internal registry. Restart failure/cancellation preserves the completed project.

## Next-Version Hub Identity Foundation (Unreleased)

Branch `hub-compatibility`, version `0.3.0-alpha.1`, adds only the read-only
`--creator-hub-info` entry point before Tauri startup. It does not add a Hub,
installer, updater, single-instance behavior, or project handoff.

- Windows release-subsystem EXE returned one 198-byte UTF-8 JSON line, exit 0,
  and empty stderr; version/platform/architecture matched its build.
- Process tests used isolated configuration/cache directories and confirmed
  they remained empty. Extra, repeated, case-invalid and unknown Hub arguments returned exit
  2, empty stdout, and no generated files within the five-second test bound.
- 27 unit tests and two executable integration tests passed; four opt-in live
  Unity/Hub tests remained excluded. All 21 frontend tests and Clippy passed.
- There are no new dependencies. Metadata advertises `launch.standalone` only.
  Single-instance startup races, blocked GUI forwarding, operation quiescence,
  native macOS/Linux execution, signed release descriptors and automatic update
  safety remain separate release gates in the Creator Hub plan.

The public 0.2.2 artifact hashes and Unity setup behavior were not changed by
this branch. This is compatibility foundation work, not a released Hub feature.
