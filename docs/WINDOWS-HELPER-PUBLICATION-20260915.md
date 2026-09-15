# Windows helper publication follow-up

## Outcome

The intermittent directory-publication failure is now handled by bounded,
revalidated Windows recovery. Hub, Setup and MCP share the reviewed source:
`bd39016cb99f7222a28e85ee245b6c2698b06f304e026ad8be1a27ea9d85fa5a`
(`src-tauri/src/community_project.rs`, under `launcher` for MCP).

The public desktop import gate is still off. This report proves the source fix
and local build checks, not a public release, installed upgrade or import-enabled
packaged desktop acceptance. Existing apps, projects, SDKs and scenes were not
replaced or upgraded.

## Evidence

- Microsoft-signed Process Monitor 4.11 was downloaded from the official
  [Sysinternals page](https://learn.microsoft.com/en-us/sysinternals/downloads/procmon).
  The user approved the administrator-prompt diagnostic.
- Capture included only paths below the dedicated temporary directory
  `C:\Users\bobman\AppData\Local\Temp\creator-helper-trace-20260915`.
  Drop Filtered Events was enabled and capture had a 45-second runtime. Its
  saved configuration was checked after Procmon loaded it. Capture and export
  have finished; no security setting was changed and nothing was uploaded.
- The same normal-user test executable reproduced two failures in 100 installs:
  `.tmp7a8Bnt` and `.tmpXYnvXF`. Both failed at `SetRenameInformationFile` with
  `ACCESS DENIED`, `ReplaceIfExists: False`.
- The trace shows the installed Unity Hub reading/enumerating staged contents
  during these rename calls. That is consistent with reader contention; it is
  not proof that antivirus caused the error or that every future error 5 has
  this cause. No other application's process was stopped to make the test pass.
- A controlled Windows test held a child file open with read/write/delete
  sharing. Publication returned OS error 5, left source/destination intact, then
  succeeded after the handle closed. This matches Microsoft's
  [FileRenameInformation contract](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/87f86c9b-6c2a-4803-84b7-131a74a434fa)
  for directories containing open files.

Local evidence is under `artifacts/helper-publication-trace-20260915`:
`capture.pml`, `capture.csv`, `fixture-only.pmc`, `stress-1.log`,
`final-native-tests.log`, and `final-stress-1.log` through `final-stress-10.log`.
Failed disposable roots were retained. PML metadata stays local.

## Narrow Implementation

- Only Windows raw errors 5 and 32 are retryable. Other platforms retain a
  single publication attempt; no copy/overwrite or elevated-install fallback.
- Maximum 20 retry waits and 21 attempts, with a monotonic one-second retry
  budget and waits no longer than 50 ms. Filesystem calls themselves are not
  promised a fixed duration. Deadline is checked after waiting and again after
  validation, immediately before a retry rename.
- The operation lock and owned staging directory stay alive for the whole
  operation. Each attempt rechecks project fingerprint, closed Editor, absent
  destination, compiled payload bytes, allowed entries and linked paths.
- Staging rejects unowned metadata and directories. Already-installed helpers
  still permit Unity-generated metadata, preserving the existing contract.
- Any new destination, including an identical helper or an empty directory,
  aborts. The no-replace OS rename remains the final collision guard.
- Success returns immediately. Persistent failure preserves existing files and
  tells the user to close other apps using the folder and retry; it does not
  recommend disabling security tools.

## Verification

- Final Hub native suite: **93 passed, 0 failed, 9 ignored**. Strict production
  Clippy passed. Explicit ignored stress test run separately below.
- Final stress: **1,000 installs passed**, ten four-worker/100-install runs,
  with Unity Hub still running. An earlier recovery revision also passed 1,000;
  only the final ten logs are evidence for the final source hash.
- Setup shared community suite: **34 passed, 0 failed, 4 ignored**.
- MCP shared project suite: **20 passed, 0 failed, 2 ignored**, reported by the
  MCP task after final source review and exact synchronization.
- Regression cases: open descendant, release/recovery, persistent bounded
  failure, wait deadline, manifest/Unity-version/Editor state changes, raced
  empty/identical/foreign destinations, staged bytes/code/metadata/directory
  changes, actual NTFS descendant-junction injection, narrow error selection.
- The post-validation deadline guard is source-reviewed, but there is no
  injected-clock test specifically expiring time during validation. The
  wait-expiry test is distinct and passed.
- Existing Unity import/cancellation/reload and organization UI evidence is in
  [the main acceptance report](PLUGIN-ACCEPTANCE-20260915.md). Those tests were
  not rerun or relabelled as new packaged desktop tests here.

## Local R3 Build

`dist/Creator-Hub-0.1.0-alpha.7-Plugin-Review-20260915-R3`

- Installer SHA-256:
  `12ba465d4822389ffaa050b6481b2c3b4d1283a809716cd054d79e3eb4326f2b`.
- Executable extracted from that installer and packaged preflight both match:
  `39ab2692fb50a5ef98ff7df67004f1feb121fe3a0e74eb1c28d9c9d314a1e4a2`.
- Existing reviewed hosted-app pins are unchanged. Setup and MCP source were
  synchronized/tested, not rebuilt into new installers in this follow-up.
- The exact packaged executable passed the installer refusal fixture:
  `artifacts/installer-guard-5f9ad7b6af404742b7a81daa7d7d9ff5/report.json`.
  Exit 10, no install section reached, existing processes preserved, `/UPDATE`
  refused while Hub was running, and the owned fixture exited cooperatively.
  `updateAcceptedAfterExit` is null; this is not successful-upgrade acceptance.
- Public import enablement, full installed upgrade acceptance, Start Location
  dependency/runtime acceptance, and macOS/Linux runtime acceptance remain
  separate gates. No public release was changed.
