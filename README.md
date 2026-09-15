# Creator Hub

**Unity tools in one window.** Open Creator SDK / Altspace and Banter projects,
manage Creator Works MCP and Creator Project Setup, and browse community plugins.

## Windows 0.1.0

[Download Creator Hub](https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/tag/v0.1.0)
and choose `Creator-Hub-0.1.0-Windows-setup.exe`.

The matching companion versions are **Project Setup 0.3.0** and **MCP 2.7.0**.
Hub installs these apps separately and opens compatible versions inside Hub.
Both also work standalone; Hub does not create duplicate MCP servers.
Earlier published acceptance remains in the
[alpha.6 release history](docs/README-ALPHA6-RELEASE-HISTORY.md).

- **Projects first:** detected Creator SDK / Altspace and Banter projects, search,
  sorting and opening in the matching installed Unity Editor.
- **Apps:** verified downloads, approved installation and updates, with guidance
  for running-app blockers. Work is not forcibly closed to install an update.
- **Creator Plugins:** type filters, images, contributor credits, descriptions
  and incorporation instructions.
- **Unity menu:** add the Editor-only catalogue to a selected project. Compact
  cards offer Import into project, keeping Unity's normal file selection.
  Cancel allows another attempt without reopening the window.
- **Helper updates:** recognized old versions receive a retained backup and keep
  Unity metadata. Unknown or edited files are protected. Close that Editor first.
- **Import history:** completed requests are retained outside Assets, freeing
  active queue capacity without deleting their final receipts.

Existing users: **update Hub first**, then the companion apps. A stable version
can update an older prerelease. Channel settings do not authorize downgrades or
silent installation. Your project folders and app settings stay put.

## Companion Apps

**[Creator Project Setup](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP)**
installs missing approved requirements with consent, creates a pinned Creator
SDK project, initializes Visual Scripting and reopens it for validation.
Android and Windows support are required. Existing-project inspection and
reviewed, backed-up repair are available separately.

**[Creator Works MCP](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP)**
connects compatible AI clients to Unity for inspection and focused editing.
MCP remains standalone and retains its settings. Updating its desktop app does
not silently replace bridges in every project.

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
cargo test --release --manifest-path src-tauri/Cargo.toml
npm run test:ui
npm run dev
```

Hosted tests need `CREATOR_SETUP_SOURCE` and `CREATOR_MCP_SOURCE` pointing
to the companion frontend folders. Release builds use reviewed exact companion
hashes, never an arbitrary version label.

[MIT licence](LICENSE) | [Third-party notices](THIRD_PARTY_NOTICES.md) |
[Creator SDK source](https://greenfield-registry.sdq.st/-/web/detail/com.sidequest.creator-sdk)
