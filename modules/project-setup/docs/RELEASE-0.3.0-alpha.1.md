# Creator Project Setup 0.3.0-alpha.1

Windows testing prerelease for the Creator Hub suite. Stable 0.2.2 remains available;
this release is not marked as the stable/latest release.

## Changes

- Compact layout and shared Creator app navigation.
- Read-only Creator Hub identity and the backend for a build-pinned hosted preview.
- Early refusal when an installer detects Setup running. It does not force-close
  active work or continue into a potentially destructive legacy uninstall path.
- App MIT licence and original third-party notices accompany the Windows packages.
- The existing project creation, Visual Scripting initialization and reviewed
  repair flows remain available. Android and Windows support are both required.

## Installation and Testing

For the integrated route, install and open
[Creator Hub 0.1.0-alpha.3](https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/tag/v0.1.0-alpha.3),
choose Project Setup, and approve its verified installation or update. Open its
hosted view after installation. Install MCP separately only when you need it;
MCP can also be used with an existing Unity project without installing Setup.

For standalone use, get this release's
[Windows installer or portable ZIP](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/releases/tag/v0.3.0-alpha.1).
Extract the ZIP and run its EXE, keeping the included `licenses` folder with the
portable app. The installer places notices in its own `licenses` folder.
Neither standalone app requires Hub.

Close Setup normally before updating from 0.2.2. Updates require approval.
Stable-to-newer-prerelease and prerelease-to-newer-stable are forward upgrades;
disabling prereleases must not trigger a downgrade to an older stable version.
General rollback and automatic Unity/SDK version migration are not offered.

Test the suite with the matching [Creator Hub prerelease](https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/tag/v0.1.0-alpha.3)
and [Creator Works MCP prerelease](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases/tag/v2.7.0-alpha.1).
Start with a disposable Unity project, then check project creation/validation,
MCP connection and one small saved scene edit. Follow the
[testing guide](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/blob/hub-compatibility/docs/PRERELEASE-TESTING.md)
and report exact versions, steps and relevant errors/logs.

## Validation Limits

The exact final artifact and CI evidence are recorded in the release's verification
receipt. Native installed tests cover public 0.2.2 upgrading to this prerelease,
active-app refusal, unchanged refusal snapshots, cooperative exit, installed hashes,
synthetic preservation sentinels, and real main-window startup and normal close.

[Candidate checks](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34527681202)
and [installed upgrade acceptance](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34528338440)
passed for these exact files. Native regression tests: 35 passed, with four
explicit live Unity/Hub tests not run. Browser interface tests: 32 passed.

Subsequent [Creator Hub native suite acceptance](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/34536443333)
passed clean-install, older-app upgrade, and MCP-only routes using these unchanged
Setup files and the published Hub candidate. It checks real verified installation,
installed hashes, fixture preservation, hosted interfaces and consent, retained
form state, folder-picker cancellation, and explicit refusal to close Hub while
an operation is active. The MCP-only route leaves Setup uninstalled.

These checks do not establish migration of real user settings or project receipts,
the safety of every historical uninstaller, busy Unity creation/repair, full Hub
adoption or self-update, headset behavior, published multiplayer spaces, or native
macOS/Linux acceptance.
Hosted development previews retain their preview status. Setup remains usable
standalone; persistent shortcut takeover is not advertised.

## Download Verification

SHA-256 checksums accompany the files. Hub also requires signed release metadata
for supported verified download/install actions. These signatures are separate
from Windows Authenticode signing: Windows executables are still unsigned and
may show an Unknown Publisher or SmartScreen warning.

Creator-owned application code is MIT-licensed. Dependency and brand-asset terms
are retained in the included notices; they are not all relicensed as MIT.
