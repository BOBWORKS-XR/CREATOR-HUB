# Plugins Streaming And Editor Detection

Candidate scope: Hub 0.1.7, Setup 0.3.1, MCP 2.7.2 and Unity helper 0.1.1.
This note records source and local test evidence, not publication approval.

## Confirmed Defects

- The Windows menu installer treated any `Temp/UnityLockfile` as a running
  Editor. A user-selected project had a stale, exclusively readable file with
  no Unity process running. The new probe checks actual sharing ownership,
  preserves the file, and fails closed on inaccessible files. The dialog refreshes
  its project list on focus without changing the selected project.
- Legacy listings permit only 32 MiB downloads. A supplied 93,245,650-byte
  unitypackage exceeded that contract. Large transfers now stream to temporary
  files rather than buffering the compressed package and expanded archive.

## Preserved Boundaries

- `listing.json` retains its 32 MiB contract for older installed clients.
  Optional `downloads.json` supplies an exact id/version-bound download, only
  for a reviewed listing without an existing download. It never replaces a
  legacy checksum. Catalogue activation waits for published compatible clients.
- Compressed packages are capped at 256 MiB, desktop archive inspection at
  2 GiB expanded and 20,000 members. Size, SHA-256, URL, path and GUID checks
  remain mandatory. These checks do not establish code safety.
- Scoped cancellation cleans temporary downloads and permits immediate retry.
  Unity uses a file-backed download handler and streams cache verification.
- Explicit project selection and native consent remain. Queues stay outside
  Assets; Unity controls file selection. No existing scene is automatically saved.

## Local Evidence (2026-09-18)

- Hub: 119 Rust tests and 178 browser tests passed; 54 are Plugins UI cases.
- Setup: 61 browser tests passed on the complete rerun. The earlier failure was
  Chromium `ERR_NO_BUFFER_SPACE` while opening the local test server, before any
  app assertion. No product change was made for that environment failure.
- Real Unity 2022.3.39f1 and 6000.3.21f1 each passed 63 presentation/protocol
  checks. While each Editor was running, its lock denied the exclusive probe.
  Reports: `artifacts/plugins-media-2022.3.39f1-9f86f0ea` and
  `artifacts/plugins-media-6000.3.21f1-1cb5790a`.
- Raw supplied package download matched 93,245,650 bytes and SHA-256
  `b9a99519a74bdbd5d75d997bed87118896c39a4d712b9ff708e63520ea4fdf94`.
  Streaming archive inspection found 33 assets, two code files and one scene.
- Disposable `artifacts/plugins-large-DIbgt7` passed the actual Rust queue to
  Unity 6000.3.21f1 import, compilation/reload and persisted `imported` receipt.
  The scene and protected content were not opened or saved. This was batch import,
  not a native import-dialog click or scene/runtime acceptance.
- Preserve the first failed fixture `artifacts/plugins-large-5HzFiI`: its minimal
  manifest omitted UIElements, causing three CS1069 errors in the supplied Readme.
  Adding that declared dependency to the second disposable fixture resolved them.

## Release Gates Still Required

Exact Windows candidate builds, installed upgrades from current stable and
historical baselines, packaged UI checks, signed artifact verification, legacy
release-feed budget and previous-stable Hub in-app update/restart acceptance.
Do not change an existing published installer to ship these changes.
