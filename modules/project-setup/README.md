# Creator Project Setup

Create a SideQuest Creator SDK Unity project without editing package manifests,
installing Git, dragging package files or using a terminal.

## Windows 0.3.1

**[Download Project Setup](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/releases/tag/v0.3.1)**
as a Windows installer or portable ZIP. Keep the `licenses` folder with the
portable app. Close Setup normally before upgrading.

You can also install and open it inside
**[Creator Hub 0.1.7](https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/tag/v0.1.7)**.
For hosted use, update Hub first. Standalone Setup does not require Hub or MCP.

0.3.1 fixes Add Unity menu remaining blocked by a stale unlocked Unity lock file.
Plugins gains preview galleries and streamed downloads with progress and cancel.
See [verified upgrade checks and limits](docs/RELEASE-0.3.1.md).

- Detect installed tools and show which requirements are missing.
- With approval, install the pinned Editor, Android tools, Windows support and
  URP template. Downloads show size, progress and speed.
- Create a project with the Creator SDK in your chosen folder. Existing project
  folders are never silently overwritten.
- Initialize Visual Scripting, compile, reopen and validate.
- Inspect existing projects first, then offer reviewed repair with a backup.
- Keep useful local logs and versioned error/recovery information. Sharing
  feedback is optional; logs are not automatically uploaded.
- Browse Creator Plugins or add its Unity Editor menu to a selected project.
  Cards show images, authors and descriptions. Import keeps Unity's file
  selection, with cancellation and retry in the same window.
- Update a recognized old plugin helper with a backup. Unknown or edited files
  remain protected; Unity must be closed for the helper update.

## Pinned Recipe

| Requirement | Version / scope |
| --- | --- |
| Unity Editor | 6000.3.21f1 |
| Creator SDK | 4.0.14 |
| URP | 17.3.0 as resolved by the approved Editor |
| Input System | 1.20.0 |
| Android | Build Support, SDK, NDK and OpenJDK, required |
| Windows | Standalone build support, required |

Creator SDK 4.0.14 declares URP 17.4.0; the pinned Editor resolves URP 17.3.0.
The app records both values. Recipe updates require a separate validation pass.

Unity licence activation, permission prompts and installation licence approval
can still require user interaction. Optional automatic Unity Hub registration
depends on its installed version. Setup does not remove Unity licensing
requirements or replace every Unity Hub function.

## Creator Plugins

[Browse contributions](https://github.com/SideQuestVR/Creator-Community) or
[submit one](https://github.com/SideQuestVR/Creator-Community/issues/new?template=contribution.yml).
Visual Scripting, prefabs, plugins, Editor tools, recipes, MCP tools and AI skills
have separate categories and instructions. Only supported Unity packages route
to Unity import. No automatic scene placement or saving is performed.

Completed import requests move into retained history outside Assets, so repeated
cancellation/retry does not fill the active queue. Checksums verify bytes, not
code safety. Contributor instructions and project validation still matter.

## Compatibility And Support

- Windows x64 is the release target. Shared macOS/Linux code exists, but their
  full Unity installation and creation flows are not physically accepted by
  Windows test results.
- Windows files are not Authenticode-signed; signed Hub download metadata is a
  separate verification mechanism.
- Existing-project repair remains a reviewed, backup-first workflow, not an
  unattended migration of arbitrary projects. Render-pipeline conversion is
  a separate future tool.
- Compiling or importing does not prove headset interaction, multiplayer or
  performance. Validate the project in its actual target client.
- For failed setup, use the [reporting guide](docs/REPORTING.md). Review logs
  for private paths or information before sharing them.

Release acceptance evidence identifies exact binaries. Older results remain in
the [historical README](docs/README-HISTORY-20260915.md). This repository remains
active; merging Setup into Hub is a future phase, not part of 0.3.0.
The later published alpha.6 acceptance notes are also retained in the
[alpha.6 release history](docs/README-ALPHA6-RELEASE-HISTORY.md).

## Development

Tauri / Rust with a plain JavaScript frontend, not Electron.

```powershell
npm ci
cargo test --release --manifest-path src-tauri/Cargo.toml
npm run test:ui
npm run dev
```

[Creator Works MCP](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP) |
[Creator SDK source](https://greenfield-registry.sdq.st/-/web/detail/com.sidequest.creator-sdk) |
[MIT licence](LICENSE)
