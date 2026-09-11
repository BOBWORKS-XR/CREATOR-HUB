# Creator Hub Windows Preview

This package is the Windows test build 0.1.0-alpha.5, not a stable release.
Use the acceptance reports supplied with this exact installer; a completed build
alone is not proof of a successful upgrade.

Alpha.5 supports Project Setup 0.3.0-alpha.2 and gives clear update guidance when
an app cannot yet open inside Hub. Update Hub first, then Project Setup. The
usual separate app window stays available. MCP 2.7.0-alpha.1 is unchanged.
See [this hotfix's scope](HOTFIX-ALPHA5.md).

Alpha.4 adds recently-modified/name sorting to Projects and clearer running-connection
details with a read-only **Check again** action before upgrades. It does not stop
AI clients, uninstall MCP or erase application data. See
[hotfix validation](HOTFIX-ALPHA4.md) for the exact tested scope.

Hub now checks for its own updates as well as MCP and Project Setup updates.
Test updates and verified downloads start enabled; you can turn either off.
Installing still needs your approval. A full Hub self-update to a later signed
version remains untested. Installer-driven alpha.3-to-alpha.4 Hub upgrades and
the app install/upgrade flow passed the separate
[native acceptance checks](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/34576995054).

## Install

1. Save your work and close any old Creator Hub windows.
2. Run the Creator Hub setup file.
3. Open Creator Hub and select MCP or Project Setup.

Only Hub is installed. Your other apps, settings and Unity projects stay put.
Windows may show an unsigned-publisher warning. If a Microsoft runtime is missing,
the installer will offer to download it.

## Existing Apps

Already using MCP? Install Hub first, leave Include prereleases enabled, and
choose Update app on the MCP page. No separate MCP download or Project Setup
installation is needed. This was tested with MCP 2.6.0, preserving its settings
and selected project through the update to 2.7.0-alpha.1.

Choose Open app to use your usual app with all its settings. If more than one
copy is found, choose Use this copy next to the one you recognise. Nothing is
merged or removed.

The coordinated preview supports the accepted Project Setup and MCP builds inside
Hub. Install/update the app first, then choose Open hosted development preview.
MCP asks for approval before enabling its normal controls. Other versions keep
opening in their own windows; unverified files cannot be used for hosting.

The older MCP 2.6.0 installer has a setup problem. Hub blocks that installer,
but you can keep using an existing MCP. Check for an update before installing.

Hub asks before installing another app. It never forces your apps to close.
Unknown app files are not opened or replaced.

## Validation Boundary

Automated checks and exact installer hashes are recorded with the candidate.
See the coordinated prerelease testing guide for coverage and remaining limits.
This is not a finished stable release or proof of every Unity/SDK workflow.
