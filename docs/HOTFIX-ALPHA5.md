# Setup Diagnostics Compatibility Hotfix

Hub `0.1.0-alpha.5` targets Project Setup `0.3.0-alpha.2` and the unchanged MCP
`2.7.0-alpha.1`. This is a Windows test build, not a stable release. Check the
acceptance reports supplied with the exact installer before distributing it.

## What Changes

- Open the new Setup diagnostics build inside Hub after updating both apps.
- If an installed app does not match this Hub's approved hosted build, Hub
  explains the update instead of offering a hosted Open action that will fail.
  The usual **Open app** action remains available for a separate window.
- The paired Setup update reports useful final Unity errors and writes versioned
  local setup receipts. Reporting is optional; review files before sharing.
  No log upload or telemetry is added to Hub.
- Project sorting and the earlier running-connection guidance remain intact.

Update Hub first, then choose **Update app** on Project Setup. Keep **Include
prereleases** enabled for these test versions. Save work before approving an
installation. Hub does not force-close AI clients, Unity or unrelated processes.

## Exact Build and Safety

The Setup executable pin comes from candidate `34587957462`, product source
`a8878c49a4c4cb57268c45484baa9e889b79bac2`. Installed acceptance `34588485597`
passed the guarded default per-user NSIS upgrade from both `0.2.2` and
`0.3.0-alpha.1`, with normal GUI startup/close and synthetic file/data sentinels.
This does not prove every user's settings, historical uninstaller or Unity task.
The signed Setup descriptor requires Hub `0.1.0-alpha.5` or newer for installation
through Hub. Standalone Setup remains independently usable.

Inventory compatibility is guidance only. Launch still locks and re-hashes the
real executable. Nothing relaxes signature, minimum-version, process, filesystem
or consent checks. MCP's artifact pins and source are unchanged.

## Validation

Source checks passed 72 browser tests, 51 Rust tests (five explicit live checks
not run), strict Clippy and formatting. The CI release gate additionally runs
packaging checks, old Hub upgrades and real native installs/hosted controls.
The final installer reports, not these source counts, establish package acceptance.

Before publication, an explicit CI-only staging mode uses the exact accepted
Setup installer plus its real signed descriptor in an isolated test cache.
The unmodified Hub verifies them and requires normal native installation consent.
Reports identify this as **signed staged-cache** acceptance, not public download
discovery. The public feed must be checked separately after publication. This
mode cannot run on a user machine or a self-hosted runner.

A full signed Hub self-update/restart, historical MSI/BANTWORKS migration,
in-flight MCP shutdown, Unity creation/repair, network completion and headset
behaviour remain separate acceptance tasks. Metadata signatures are not Windows
Authenticode signing; the installer still has an unsigned-publisher warning.
