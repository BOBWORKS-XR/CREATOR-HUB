# Creator Project Setup 0.2.2 - Windows Release

A portable setup tool for creating and validating a SideQuest Creator SDK Unity
project without editing package manifests, dragging package files, or using Git
or a terminal.

Promoted from prerelease after automated checks, native packaged-app testing,
and user confirmation that Restart Unity Hub made the project visible. The
original tested downloads and checksums are unchanged; the app footer still
says Preview. Existing-project repair remains experimental.

## New In This Build

- **Restart Unity Hub from the completion screen.** A project can be registered
  successfully but missing from a running Hub's cached Projects list. The new
  confirmed restart fully closes and reopens Hub, including when it is hidden in
  the tray. Unity Editors remain open. Nothing is force-terminated.
- **Separate registration from refresh.** Saving a registry entry no longer
  appears as a completed Hub refresh. Cancel and retry retain the ready project.
- **Hub version check.** Automatic registration requires Hub 3.21.1 or newer,
  opened at least once. Older/unknown versions get explicit update or Add from
  disk instructions rather than a false success.

## Included

- Detect installed Unity, Android SDK/NDK/OpenJDK, Windows build support and URP.
- Create a new project with the tested recipe: Unity 6000.3.21f1, Creator SDK
  4.0.14, URP 17.3.0 and Input System 1.20.0. Android and Windows are required.
- Resolve packages, initialize Creator Visual Scripting nodes, and reopen Unity
  in a second validation pass before marking the project ready.
- Show setup stages, import activity, elapsed time and local validation receipts.
- Inspect existing projects without changing files, then offer reviewed,
  opt-in settings backup and targeted repair/validation for the tested recipe.

## Downloads

- `Creator-Project-Setup-0.2.2-Windows.exe`: portable app; run directly if WebView2
  is already installed.
- `Creator-Project-Setup-0.2.2-Windows-portable.zip`: the same app with instructions.
- `Creator-Project-Setup-0.2.2-Windows-setup.exe`: optional installer, including
  WebView2 prerequisite handling.
- `SHA256SUMS-0.2.2.txt`: checksums for the three downloads.

## Tested And Limited

The missing-project case was reproduced in Hub 3.21.1. The final portable EXE
created a fresh project, initialized Visual Scripting, and passed the separate
Unity reopen check with no C# compilation errors. The native Cancel action left
Hub running unchanged; confirming Restart made that new project visible in the
native Hub window while all existing Unity Editor process IDs stayed unchanged.
22 Rust tests and 21 frontend tests pass, plus a separate live restart check and
Clippy with warnings treated as errors.

Finish Hub downloads/installations before confirming a restart. A refused
shutdown stops without forcing it. The app does not inspect every user's Hub UI.

This is a **Windows release for the tested recipe**, not a guarantee for arbitrary
SDK versions, existing projects, player builds, hosted spaces or headset behavior. Existing
repair backs up settings/manifests/generated Visual Scripting data, not the whole
project; retain your own full backup. macOS/Linux automatic restart is not
implemented; their native workflows remain unverified. Unity sign-in, licensing
and missing Editor/module installation remain Unity Hub handoffs.

Ensure the project and package-cache drives have enough free space. Disk-space
preflight is not yet implemented; a disk-full test stopped with Unity's log
retained, but the UI currently reports a generic setup failure.

The Windows files are **unsigned**. Only run trusted copies and compare the
published checksums. Optional Creator Hub support for installing, opening, and
updating the independent tools is next-version work. This release does not
install or reconfigure the MCP and does not contain Hub integration.
