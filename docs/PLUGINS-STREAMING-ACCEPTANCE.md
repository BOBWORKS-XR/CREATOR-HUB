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
- Setup native tests: 116 unit and two integration checks passed locally. MCP:
  117 Rust and 250 Node tests passed. Strict Setup Clippy passed; MCP strict
  all-target Clippy reports a pre-existing eight-argument `one_click_setup`
  command warning, outside this change. Its existing CI uses tests and fmt.
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
- The same marked disposable fixture then downloaded the exact 93,245,650-byte
  package through Unity's real `UnityWebRequest` and file-backed handler. SHA-256,
  final size and temporary-file cleanup passed. `large-download-result.json`
  records this download-only check; no extra import was started.
- Preserve the first failed fixture `artifacts/plugins-large-5HzFiI`: its minimal
  manifest omitted UIElements, causing three CS1069 errors in the supplied Readme.
  Adding that declared dependency to the second disposable fixture resolved them.
- First Setup CI run 35282736581 stopped on the old-helper fixture's LICENSE.md
  hash: its working copy had the released CRLF bytes but Git's older index had LF.
  Renormalizing that fixture under the existing `-text` rule preserves the exact
  released hash in clean checkouts. No checksum check was weakened. The concurrent
  MCP candidate was cancelled because its fixture had the identical index issue.

## Companion Installer Evidence

- Setup 0.3.1 candidate [35283526299](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/35283526299)
  passed package checks. [35284656904](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/35284656904)
  passed installed upgrades from 0.2.2, 0.3.0-alpha.1, alpha.2, alpha.6 and 0.3.0,
  exact payload/sentinel preservation, and native busy-close refusal, chooser
  cancellation and idle close. Installer SHA-256:
  `8bb8aeecb18973f52cb9afe41c251a913b4e30dfbcfdc927edb785c5afd6f664`.
- MCP 2.7.2 [35283535011 attempt 2](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/actions/runs/35283535011)
  passed the build and five installed upgrade baselines. Attempt 1 stopped on
  the PowerShell refusal-test process's 10-second startup timeout; the same source
  passed on rerun, without changing assertions or product code.
  [35285385998](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/actions/runs/35285385998)
  replayed the exact installer from 2.6.0, 2.7.0-alpha.1, alpha.2, 2.7.0 and 2.7.1,
  including native installer No/Cancel/Yes on 2.7.1, scoped private-runtime
  cleanup, unrelated Node preservation and native busy/idle lifecycle.
  Installer SHA-256:
  `13f0e14bf321227f59788f13ec9253dff092891bb3144607e37263d5ee16e2ca`.
- Both signed catalogue descriptors require Hub 0.1.7 because its hosted apps
  are pinned to exact reviewed executable hashes. Descriptor signatures, payload
  hashes and tamper rejection passed locally. These are not Authenticode claims.

## Release Gates Still Required

The combined Hub build passed in
[35285728517](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35285728517).
Its initial native suite stopped on the gallery harness checking the video count
immediately after `dialog.close()`, before the queued close-event cleanup. The
harness now waits for the same zero-video condition with a bounded Playwright
assertion, matching the browser lifecycle. The exact harness also has a local
browser regression test. No product code or candidate installer changed.
Hub packaged UI/upgrade acceptance, signed artifact verification, legacy release
feed budget and previous-stable Hub in-app update/restart acceptance remain.
Companion drafts are unpublished until combined acceptance passes.
Do not change an existing published installer to ship these changes.
