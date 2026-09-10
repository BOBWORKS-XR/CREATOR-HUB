# Coordinated Windows Preview

Target versions: Creator Hub 0.1.0-alpha.3, Creator Works MCP 2.7.0-alpha.1,
Creator Project Setup 0.3.0-alpha.1. These are test releases, not stable releases.

## Try the Flow

Existing MCP users start with Hub, not a separate MCP prerelease installation.
Project Setup is optional. [Download the Windows preview](https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/tag/v0.1.0-alpha.3)
and choose the `Windows-setup.exe` asset.

1. Save your work and close the old Hub. Install the new Hub EXE once.
2. Leave **Include prereleases** enabled. Choose **Check for updates**.
3. Choose MCP or Project Setup, then **Install app** or **Update app** and approve.
4. Close an old app or active MCP clients if prompted. Hub never force-closes them.
5. Choose **Open hosted development preview** to use the accepted app inside Hub.
   MCP asks before enabling controls. Your existing project list and settings
   belong to the installed app; Hub does not replace them with a separate list.
6. **Open app** remains available for a separate window. Choosing between duplicate
   old installations does not delete either copy.

The original Hub previews without an updater need the one-time new installer.
Newer Hub builds include an in-app update check; a complete self-update handoff
to a later signed Hub version remains a separately recorded acceptance test.
Do not assume a successful download proves that restart path.

## Stable and Test Updates

- Enabling prereleases permits a newer test version over an older stable version.
- Disabling prereleases permits a newer stable version over an older test version.
- Disabling prereleases does **not** silently downgrade a newer test version to
  an older stable version. There is no automatic rollback button in this preview.
  Returning to an older version needs a separate reviewed backup/reinstall path.
- Downloading never authorizes installation. Unknown signatures, hashes, app
  copies, MSI migrations, and unsafe installation locations are refused.

## Evidence Before Publication

Passed [native acceptance](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/34536443333):
clean installation, MCP `2.6.0` to `2.7.0-alpha.1` with no Setup installed, and
both-app upgrades including Setup `0.2.2` to `0.3.0-alpha.1`. Existing valid MCP
project selection and an isolated setting were checked in the actual hosted UI.
The close test observes Hub's native refusal warning while a real picker is open.

Each app's exact installer must pass its own Windows install/upgrade checks.
Its signed descriptor binds installer size/hash and the EXE extracted from that
installer. Hub pins those installed EXEs; portable companion EXEs are not substitutes.

The Hub candidate additionally runs `native-suite-smoke.cjs` on separate disposable
GitHub-hosted Windows machines for clean installation, an older-version upgrade
of both apps, and an MCP-only upgrade with Project Setup left uninstalled.
It tests public signed release discovery, download, actual in-app installation,
preservation of a valid saved MCP project list/selection, native consent, both
hosted interfaces, an isolated MCP preference write/restoration, folder-picker
close protection, and scoped exit.
The test refuses a local/self-hosted machine before resolving app paths.
Its browser connection uses a temporary app-specific debugging policy only on
those disposable workers, checks that the port is loopback-only and removes the
owned policy afterward. Shipped app security settings are unchanged.

Reports and screenshots are uploaded with the candidate. A failed check blocks
Hub publication; browser mocks and an installer exit code alone do not pass it.
This test does not create a Unity project, connect an AI client, or establish
SDK, scene, headset, hosted-room or multiplayer behavior. Those remain project tests.

## Report a Problem

Include the three version numbers, which button you used, whether you started
with an old installation, and the exact error. Redact personal paths and project
names before sharing screenshots. Keep the previous installer until the new
flow works for you; do not delete your Unity projects or launcher settings.
