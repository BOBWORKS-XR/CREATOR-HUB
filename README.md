# Creator Hub

**Unity tools in one window.** Open Creator SDK / Altspace and Banter projects,
use Creator Works MCP and create or inspect projects with Project Setup.

## Already using Creator Works MCP on Windows?

**Update Creator Hub, not MCP.** In older versions, Hub opened a separate MCP
app. Now MCP and Project Setup are both under **Menu** in Hub. If you see a
different version number next to MCP, it identifies the tools included with
Hub. It is not another download.

1. **Already have Creator Hub?** Open it and choose **Check for updates**, then
   **Update Hub**. If you only have the old MCP app, or your old Hub cannot
   update, use the [official Windows Hub installer](https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/latest).
   Leave the old app and its settings in place; do not uninstall it first.
2. **See "Move to Hub"?** Choose **Move to Hub** to back up your settings and
   review which existing AI connections Hub can take over. Your Unity projects
   stay where they are. Choose **Not now** to carry on without finishing the
   move. If a move stalls and Hub offers **Keep my current setup**, use that to
   keep the settings you have without repeating the move.
3. **Check your connection.** Open your project in Unity, let it finish loading,
   then fully quit and reopen your AI app. Ask it: "Call `get_bridge_status` and
   tell me which project you're connected to and whether it's ready." If it
   reports the right project and is ready, you don't need to run setup again.

In the next update, **Help > My AI cannot see MCP tools > Help me connect**
opens the MCP page. Choose your AI app under **Connection status** for the next
step. You can review a change to just the Unity bridge or one AI app without
running setup for every app. If the read-only check names the wrong project,
choose **My AI opens the wrong project** to review pointing that app's user-level
connection at the selected project. Project-specific settings files are left alone.
For Claude Code, Hub checks the selected project's `.mcp.json` for a Creator
Works or legacy Banter entry. That label means the entry exists, not that Claude
has approved or loaded it. Open Claude Code in that project, use `/mcp` to see
its status, then try the connection check. Hub never edits the project file.

If Hub says **MCP update needs review**, open **Menu > MCP**, check the project
name, then choose **Apply** beside your existing AI app. A connection you set up
yourself can still point to the old MCP; updating Hub doesn't silently change it.

**Platform scope:** Windows x64 is the maintained binary release target. Official
Linux packages (AppImage, DEB, RPM and Flatpak) are discontinued; new macOS builds
are suspended. Existing Mac/Linux downloads remain historical builds, not
supported unified updates.

Experienced contributors can [build from source](docs/BUILD-FROM-SOURCE.md). See the
[experimental Unix packaging notes](docs/EXPERIMENTAL-UNIX-PACKAGING.md): this is
not a claim of Windows feature parity, working host integration or qualified
installation/update support. We welcome Linux and Mac maintainers familiar with
Rust/Tauri, native packaging, settings migration, MCP and signed update testing.

## Creator Hub 0.1.21 for Windows

MCP 2.7.9 adds explicit session-only project registration, bounded project
listing and read-only native inventory consumption from an approved compatible
host. Settings are retained; no helper is automatically installed into projects.
See [release notes and test scope](docs/RELEASE-0.1.21.md).

## Included 0.1.20 Changes

MCP 2.7.8 adds safer reference changes and command recovery, a refreshed Creator
SDK node catalogue and documentation, and advisory graph-performance checks.
Existing settings are retained; installing the update does not rewrite graphs.
See [release notes and test scope](docs/RELEASE-0.1.20.md).

## Included 0.1.19 Hotfixes

This Windows hotfix adds clearer recovery actions for project opening and
preserves an unused Unity lock marker instead of treating its existence alone
as proof that the Editor is running. Held or unverified locks remain protected.

Existing-project Setup uses the project's installed Editor without requiring
the new-project URP template. Newer SDK and Unity versions are preserved, and
supported partial repairs use installed SDK requirements without silently
downgrading packages. Untested runtime validation is reported separately.

See [draft release notes](packaging/windows/0.1.19-release-notes-DRAFT.md) and
[qualification scope](packaging/windows/0.1.19-qualification-DRAFT.md).
These project-opening and Setup fixes are retained in 0.1.21.

## Creator Hub 0.1.18

Project Setup and MCP are included in Hub, with one installer and update stream.
Their source histories are retained under `modules/project-setup` and
`modules/mcp`. Future development lives in this repository.

[Latest Windows installer and release](https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/latest)
and [0.1.21 package qualification](packaging/windows/0.1.21-qualification.json).
Existing Hub users can check for updates. Standalone users install Hub and follow
the first-launch migration review. Recognized MCP 2.7.7 / Setup 0.3.7 installations
get verified backups, reviewed AI-client routing and separately approved removal
of the old app interfaces. Settings and retained MCP runtimes stay available;
Unity projects are not moved. Unknown/custom/conflicting copies are not silently
overwritten or removed.

The standalone repositories, historical downloads and old signed updater files
remain available. Their update feeds are not silently redirected to Hub.
Creator Plugins retired on October 20, 2026. Its retired catalogue UI is removed;
existing assets in Unity projects are not removed.

See [the unified product and migration requirements](docs/UNIFIED-CREATOR-HUB.md).
The following sections are retained release history, not current unified-product
instructions or the latest download.

## Windows 0.1.7

[Download Creator Hub](https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/tag/v0.1.7)
and choose `Creator-Hub-0.1.7-Windows-setup.exe`.

**Add Unity menu now recognizes when Unity has closed**, even if an unlocked
lock file remains. Plugins also gains preview galleries, streamed large-package
downloads, progress and cancellation. [Release checks](docs/RELEASE-0.1.7.md)
include the actual public 0.1.6 to 0.1.7 update and automatic restart.

Hub can **close its idle app views for an update and reopen them
after restart**. Cancel preserves the views and unsaved forms. Active work is
protected; saved app settings, Unity projects and unrelated processes stay put.
Existing app-native permission prompts still apply when views reopen.

**One-time upgrade:** when updating from 0.1.5 or older, close the hosted views
first. Those versions still use their old updater. The automatic flow applies
to future Hub updates from 0.1.6. See [checks and limits](docs/RELEASE-0.1.6.md).

The matching companion versions are **Project Setup 0.3.1** and **MCP 2.7.2**.
Hub installs these apps separately and opens compatible versions inside Hub.
Both also work standalone; Hub does not create duplicate MCP servers.
Earlier published acceptance remains in the
[alpha.6 release history](docs/README-ALPHA6-RELEASE-HISTORY.md).

- **Projects:** detected Creator SDK / Altspace and Banter projects, search,
  sorting and opening in the matching installed Unity Editor.
- **Apps opens by default:** direct Update app buttons, verified downloads and
  approved installation, with guidance for running-app blockers. Private MCP
  connections are disconnected only after confirmation; unrelated Node processes
  are not stopped.
- **Creator Plugins:** remembered Grid/List views, type filters, images, contributor
  credits and incorporation instructions. Its icon/menu stays visible while scrolling.
- **Unity menu:** add the Editor-only catalogue to a selected project. Compact
  Grid/List cards offer Import into project, keeping Unity's normal file selection.
  Cancel allows another attempt without reopening the window.
- **Helper updates:** recognized old versions receive a retained backup and keep
  Unity metadata. Unknown or edited files are protected. Close that Editor first.
- **Import history:** completed requests are retained outside Assets, freeing
  active queue capacity without deleting their final receipts.

**Historical 0.1.7 instructions only:** users updated Hub first, then the
companion apps. A stable version
can update an older prerelease. Channel settings do not authorize downgrades or
silent installation. Your project folders and app settings stay put.
Older previews reporting an intermediate-version requirement can use the 0.1.7
installer directly. If 0.1.1 shows unavailable apps, use Apps > Check for updates
after the project scan finishes. Its old footer says 0.1.0 incorrectly; reinstalling
0.1.1 does not correct that label. See the [earlier hotfix notes](docs/RELEASE-0.1.3.md).

## Historical Companion Apps (0.1.7)

**[Creator Project Setup](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP)**
installs missing approved requirements with consent, creates a pinned Creator
SDK project, initializes Visual Scripting and reopens it for validation.
Android and Windows support are required. Existing-project inspection and
reviewed, backed-up repair are available separately.

**[Creator Works MCP](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP)**
connects compatible AI clients to Unity for inspection and focused editing.
In 0.1.7, MCP ran as a separate app and kept its own settings. Updating that
desktop app did not silently replace bridges in every project.

**Creator Converter** is coming later. Moving Project Setup permanently into
Hub is a separate [planned phase](docs/PROJECT-SETUP-IN-HUB.md), not this release.

## Community

[Browse the catalogue](https://github.com/SideQuestVR/Creator-Community) or
[submit a contribution](https://github.com/SideQuestVR/Creator-Community/issues/new?template=contribution.yml).
Categories include Visual Scripting, prefabs, plugins, Editor tools, recipes,
MCP tools and AI skills. Non-Unity tools follow their own instructions; they
are not automatically imported as Unity assets.

Imports do not place content in scenes or save scenes automatically. Follow
contributor instructions to configure assets. Checksums confirm downloaded
bytes, not code safety. A [private scanning pipeline](docs/PLUGIN-PUBLICATION-CHECKS.md)
is planned; it is not advertised as deployed.

## Scope And Limits

- **Windows x64** is the release target. Native macOS/Linux Unity workflows are
  not covered by Windows acceptance results.
- Windows files are **not Authenticode-signed**. Signed download metadata is
  separate from Windows publisher signing.
- Historical MSI/BANTWORKS installations, custom paths and duplicate copies can
  need manual attention. Do not uninstall them solely to make Hub detect them.
- Project compatibility, headset interaction, networking and performance need
  their own validation. A successful import is not gameplay acceptance.
- Unattended Unity upgrades and takeover of already-running standalone apps
  are not promised. Separate app windows remain supported.

Release-attached acceptance files identify the **exact published binaries**.
[Presentation checks](docs/PLUGIN-PRESENTATION-20260915.md) and the
[historical README](docs/README-HISTORY-20260915.md) are dated evidence, not
proof for later rebuilt packages.

## Development

Tauri / Rust with a plain JavaScript frontend and Playwright tests, not Electron.

```powershell
npm ci
npm --prefix modules/mcp ci
npm --prefix modules/project-setup ci
npm run check:sources
npm run test:modules
cargo test --release --manifest-path src-tauri/Cargo.toml
npm run test:ui
npm run dev
```

Hosted browser tests use the module frontend folders by default; optional
`CREATOR_SETUP_SOURCE` and `CREATOR_MCP_SOURCE` overrides remain available for
explicit legacy fixtures. Existing legacy-compatible packages use reviewed exact
companion hashes, never an arbitrary version label. Unified packaging and migration
are separate acceptance work and are release-blocked on this branch.

[MIT licence](LICENSE) | [Third-party notices](THIRD_PARTY_NOTICES.md) |
[Creator SDK source](https://greenfield-registry.sdq.st/-/web/detail/com.sidequest.creator-sdk)
