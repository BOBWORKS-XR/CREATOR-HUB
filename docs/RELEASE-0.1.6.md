# Creator Hub 0.1.6

Published stable/latest after both signed-update acceptance paths passed.
MCP remains 2.7.1 and Project Setup remains 0.3.0. Their binaries are unchanged.

## Changes

- Hub's update confirmation includes the idle hosted views it will close and
  reopen. Cancel preserves their unsaved forms and existing processes.
- Verified downloads complete before closure. Hub closes only its owned app
  backends and waits for exit; active work, AI clients and other processes are
  not force-stopped. Unsaved forms are discarded only after update approval.
- A bounded one-shot record restores views after restart, using the normal
  executable checks and app permission prompts. Declined/failed reopening has a
  retry button; successfully restored views are not duplicated.
- Restoration waits for companion startup work and serializes background reads
  with inventory. Apps remains the default page and settings are preserved.

From 0.1.5 or older, close views once to install this update. Old installed
binaries cannot acquire new updater behavior before they themselves are updated.
Future updates from 0.1.6 use the automatic close/reopen flow.

## Accepted Evidence

- Product source/tag: `8138c24ceec368298d8892dfa01e3662c865bb3d` / `v0.1.6`.
- [Build and four native lanes](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35097259476):
  169 UI tests, 111 Rust tests (nine opt-in tests excluded), strict Clippy and
  script checks. Clean install and Hub alpha.3, alpha.5 and 0.1.5 upgrades;
  real companion app operation, seeded-record restoration and decline/retry.
- [Unmodified public 0.1.5 to 0.1.6](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35099272105):
  public discovery, native Cancel, approved in-app installation, automatic
  restart, exact executable/footer/registry version, preferences and unmanaged
  content preserved. Apps default and transparent Plugins icon verified.
- All six public assets were downloaded anonymously and byte-matched. Catalog,
  installer and updater signatures, extracted EXE and tamper rejection passed.
- Public release-list response: 234,895 bytes, 27,249 below the legacy 256 KiB
  ceiling. No historical assets or updater files were replaced.

The [new outgoing updater test](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35100145403)
also passed with both views open. Its disposable source fixture uses this runtime
with only version metadata changed to 0.1.5, then updates to the exact public
0.1.6. The fixture is never published and is not represented as an unmodified
old release. Cancel preserved both views, the unsaved Setup form and MCP config.
Approval closed the original owned processes, installed/restarted automatically
and reopened both views after app-native permission. Original/replacement PIDs
were checked; an unrelated Node runtime survived. Latest promotion occurred only
after both independent update paths passed. The anonymous latest updater URL
then returned the exact accepted 0.1.6 manifest.

## Original Failures

[First candidate 35094977239](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35094977239)
passed source/installer checks but failed native restoration. Transport-ready
arrived before the companion's initial work released the shared operation lease.
That installer was rejected. Controlled-delay regression tests and the rebuilt
native suite now cover startup completion and background-read serialization.
An intermediate build was cancelled when the latter case was reproduced.

One local browser run failed before page load with `ERR_NO_BUFFER_SPACE`; its
failure context was preserved. The complete two-worker rerun and Windows CI
passed all 169 tests. The guarded publisher's immediate post-publication check
saw a cached old response; publication was not repeated. A subsequent ordinary
public feed read passed before the installed-client test.

The first new-updater fixture run stopped before launching Hub because its
harness expected the raw build EXE hash, not the packaged payload hash. The
fixture builder now extracts and checks its installer/preflight payload like
the main candidate gate. No public executable was rebuilt or replaced for this
test-harness correction.

## Exact Installer

- File: `Creator-Hub-0.1.6-Windows-setup.exe`, 6,077,623 bytes.
- SHA-256: `96e0059f0cbcc4ce1dc66ed86d05ad0274e9e63b108db5febe1e61120fd28adb`.
- EXE SHA-256: `ea6df01fd6200b28125cb5302db6ca6dcc24a70279a729adb35cd572a08a4ea9`.

Windows x64 evidence only. No user PC installation, Unity project, AI setting
or unrelated process was used as a test fixture. This does not add Windows
Authenticode signing, historical MSI migration, or macOS/Linux acceptance.
