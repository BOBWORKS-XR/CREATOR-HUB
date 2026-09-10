# Creator Hub 0.1.0-alpha.3 for Windows

This is a local test build, not a public stable release.

Hub now checks for its own updates as well as MCP and Project Setup updates.
Test updates and verified downloads start enabled; you can turn either off.
Installing still needs your approval. Self-update restart is awaiting its final
installed test, so this candidate is not yet the published test release.

## Install

1. Save your work and close any old Creator Hub windows.
2. Run the Creator Hub setup file.
3. Open Creator Hub and select MCP or Project Setup.

Only Hub is installed. Your other apps, settings and Unity projects stay put.
Windows may show an unsigned-publisher warning. If a Microsoft runtime is missing,
the installer will offer to download it.

## Existing Apps

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
