# Setup Diagnostics Compatibility Hotfix

Hub `0.1.0-alpha.5` targets Project Setup `0.3.0-alpha.2` and the unchanged MCP
`2.7.0-alpha.1`. Both updates are public Windows prereleases, not stable releases:
[Hub alpha.5](https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/tag/v0.1.0-alpha.5)
and [Setup alpha.2](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/releases/tag/v0.3.0-alpha.2).
The acceptance reports supplied with the exact installers record the tested scope.

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
not run), 11 Node safety/packaging tests, strict Clippy and formatting.

- The [candidate build job](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/34589242223)
  passed packaging and installed checks for product source
  `3c79efac8e58c05aa2229384ea2546736ba3eba8`. The first downstream test attempt
  could not access an unpublished fixture. A workflow-only correction at
  `2b626c43df0072d42e0d2d609ac629ad5e3dd532` resolved that test setup failure;
  the product installer was not rebuilt.
- [Prepublication native acceptance](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/34590430861)
  passed clean, legacy and MCP-only lanes. Setup used its real signed descriptor
  and exact accepted installer in an isolated staged cache; this did not prove
  public discovery. Native signature, hash, version and consent checks stayed on.
- [Post-publication native acceptance](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/34591146264)
  passed all three lanes again with staging disabled and the same Hub installer.
  Clean and legacy lanes used Setup's public signed release and download;
  the MCP-only lane left Setup uninstalled. Tests covered public Hub alpha.3
  and alpha.4 upgrades, app installation, actual hosted controls, synthetic
  settings preservation, busy-close refusal and scoped exit.
- All 19 Hub and 11 Setup public assets were independently downloaded without
  authentication and matched the reviewed files. Descriptor/updater signatures
  and tamper rejection also passed. No user-installed apps or Unity projects
  were changed by these tests.

The published Hub installer SHA-256 is
`befcc1da883c9ad13af7c7971865bf1c3cf7a63102a297af743e5f059ad96fbc`.
Its actual installed executable SHA-256 is
`1196f20b748aff1ab2d269736308939dc0e221a13c9f220857017284ba7b4427`.
Portable companion executables are not substitutes for that installed-file pin.
Published assets remain the accepted, signed files; this source document also
records the later public-feed test.

A full signed Hub self-update/restart, historical MSI/BANTWORKS migration,
in-flight MCP shutdown, Unity creation/repair, network completion and headset
behaviour remain separate acceptance tasks. Metadata signatures are not Windows
Authenticode signing; the installer still has an unsigned-publisher warning.
