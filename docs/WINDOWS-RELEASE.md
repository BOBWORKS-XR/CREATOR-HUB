# Creator Hub 0.1.1 for Windows

Install Hub, then choose Creator Works MCP or Creator Project Setup from its
app menu. Hub downloads verified official installers and asks before installing.
Compatible apps can open inside Hub or in their own windows, using their existing
settings. This release supports MCP 2.7.0 and Project Setup 0.3.0.

Projects opens first, with Creator SDK/Altspace and Banter projects together.
Creator Plugins offers remembered Grid/List views, community contributions, category filters and a Unity
Editor menu. Add the menu while the selected project is closed; open Unity and
choose Creator Plugins > Browse. Import opens Unity's usual file-selection
window. Cancelling lets you try again without reopening the Plugins window.
The Plugins heading and icon follow the active page, and its app menu stays
visible while scrolling. MCP and Setup can be updated directly from Apps.

Recognized older menu files can be updated with a retained backup. Unknown or
locally edited helper files are not replaced. Unity scenes are never saved by
the plugin manager. Package checksums establish integrity, not code safety or
SDK compatibility; selected imported C# code runs in Unity.

Save work before updating. Hub does not force-close Unity or AI clients. Close
the app or disconnect the listed MCP connection if an update is blocked, then
use Check again. Keep the default installation folder for managed updates.
Custom, duplicate, MSI and unrecognized installations may require manual review.

Windows x64 is the supported release platform. Windows may show an unsigned
publisher warning; the signed update catalogue is separate from Authenticode.
Installer upgrades and exact artifact checks are recorded with the release.
Automatic self-update to a future version, every Unity project configuration,
macOS/Linux native behavior and headset performance are not proven by these tests.

Source and feedback: https://github.com/BOBWORKS-XR/CREATOR-HUB
Community submissions: https://github.com/SideQuestVR/Creator-Community/issues/new?template=contribution.yml
