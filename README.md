# Creator Hub

Lightweight Windows app manager for Creator Works MCP and Creator Project Setup.
Windows prerelease `0.1.0-alpha.4`; not a stable release.
Both tools remain usable independently.

## New in Alpha.4

- Projects open in **Recently modified** order, with **Name A-Z** available.
- Update blockers show process IDs, executable paths and the starting app when
  identifiable. This works independently of which AI client you use.
- **Check again** refreshes local status without installing or stopping anything.
  Recovery guidance explains what to do if a connection remains after its app closes.
- Real Windows tests cover alpha.3-to-alpha.4 Hub upgrades, clean installs,
  legacy MCP/Setup upgrades, and a running private-runtime blocker that exits
  cooperatively before a separately approved update.

MCP `2.7.0-alpha.1` and Project Setup `0.3.0-alpha.1` are unchanged in this Hub
hotfix. See [validation and limits](docs/HOTFIX-ALPHA4.md).

## Try the Installer

**Already use Creator Works MCP?** Install Hub, then
choose **Update app** on its MCP page. You do not need Project Setup or a separate
MCP download. The MCP `2.6.0` to `2.7.0-alpha.1` route passed real Windows testing,
including its saved project list and settings. Historical BANTWORKS/MSI installs and duplicate
copies may require attention; do not uninstall them just to make Hub detect an app.

[Download the Windows preview](https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/tag/v0.1.0-alpha.4).
Choose `Creator-Hub-0.1.0-alpha.4-Windows-setup.exe`. Leave **Include prereleases**
enabled to see the matching MCP and Project Setup previews.

Close old Creator Hub preview windows, then run the new installer. It installs
Hub only. Your MCP, Project Setup, settings and Unity projects stay where they are.

- **Open app** opens your usual app with its existing settings.
- **Use this copy** lets you choose when Hub finds more than one installation.
- **Check for an update** checks inside Hub, without a browser detour.
- **Creator Hub update** checks Hub itself on the same stable/test channel.
  Verified downloads do not install until you click **Update Hub** and approve.
  Installer-driven Hub upgrades passed; the complete signed in-app self-update
  and restart route remains untested.
- **Open hosted development preview** opens a compatible app inside Hub after
  you approve. The MCP preview includes its normal controls, not just a read-only
  snapshot. Other app versions remain available in their own window.

The older MCP 2.6.0 installer has a setup problem and is blocked, but an existing
verified MCP can still be opened. See [local setup notes](docs/INSTALLABLE-PREVIEW.md).

## Corrected Product Direction

The long-term goal is one window containing the installed Creator apps.
Planned onboarding detects existing apps and offers
"Update and add to Hub", preserving their installations and settings. Once
adopted, their shortcuts open the corresponding view inside Hub. Nothing found
or "Not now" means Hub-only installation, without changing the other apps.
Standalone apps keep their Creator menu when Hub is absent. See the
[hosted-app plan](docs/HOSTED-APPS.md).

The coordinated Windows preview uses Project Setup `0.3.0-alpha.1` and MCP
`2.7.0-alpha.1`. Hub installs them separately from their verified public releases;
they are not duplicated inside the Hub installer. Only exact reviewed installed
executable hashes enable hosted controls. Native suite acceptance is recorded
with the final candidate, not inferred from a version label. Fixed `--open-app mcp|setup`
navigation and single-window launch handling are tested on Windows. Persistent
adoption, standalone shortcut handoff and transfer of an already-open app are
not implemented yet.
See the [hosted preview](docs/HOSTED-PREVIEW.md) and
[tested native contract](docs/HOSTING-PROTOCOL-PREVIEW.md).

A real project has been created, compiled and reopened/validated through the
hosted interface, including Creator Visual Scripting and both build targets.
An isolated real repair also preserved the scene, custom content and Visual
Scripting selections, retained its backup and passed a second validation.
See the [coordinated release gates](docs/RELEASE-GATES.md) for remaining blockers.

## Current Implementation

- Hub Projects page with search, SDK filters and explicit local-folder additions.
  Reads known MCP/Unity Hub locations and package manifests without scanning drives
  or modifying project files. The Windows preview reuses Project Setup's pinned
  Unity helper for current Hub discovery and exact installed Editor selection.
  No helper is downloaded automatically; fallback lists remain available when it
  is missing, but opening requires the approved helper. Folder removal only edits
  Hub's saved list; it never deletes project content or another app's entries.
- Project Setup hosted UI with native requirements/folder picking, retained form
  state across navigation, scoped progress and native busy-close protection.
- MCP hosted UI with an explicit native approval prompt for normal controls,
  a separate backend/resource directory, guarded writes and a native command
  allowlist. Read-only hosting remains available in development builds.
- In-app verified download, install, open, installed-app reuse and update checks.
- Available/installed versions, download progress, cancellation and visible errors.
- Prereleases and verified background update downloads are enabled by default.
  Each can be turned off independently, and saved choices are preserved.
  Installation always requires approval; a download never authorizes execution.
- Pinned hashes for current public releases; signed Minisign descriptors for
  future releases. Bounded metadata/downloads and Semantic Version comparison.
- Running-app/server checks, no forced Unity or AI client closure, no automatic
  downgrade, and no silent duplicate installation over unknown/legacy copies.
- Reviewed new installers support in-app upgrades at the normal installation
  location. Legacy MSI, unknown and custom installs require attention rather
  than an automatic replacement. Native security/consent prompts may still appear.
- Compact shared interface, morphing logo drawer, keyboard/reduced-motion support,
  gray Hub cube and official white SideQuest mark for Creator Converter.
- Creator Converter and Creator Plugins are Coming soon. Plugins is planned as
  a no-fee community directory, not a payment or subscription service.
  Packages and Community Tools have separate planned sections, including opt-in
  sharing of useful MCP-created utilities. See the [reviewed submission design](docs/COMMUNITY-INDEX.md).

Hub does not modify Unity projects, bridges or AI settings as an inventory action.
Installers retain ownership of their own settings and migrations. No accounts,
telemetry, community package hosting or arbitrary install URLs are added.

## Development

### Upgrade Blocker Guidance

Alpha.4 adds project sorting and clearer upgrade-blocker guidance.
The published alpha.3 installers remain unchanged. Hub identifies running MCP
runtimes and their starting app when available, without assuming a particular
AI client. **Check again** refreshes local status only: it does not download,
install or stop processes. Finish work and disconnect MCP in your AI client
before retrying an update. Broad command matches are labelled **Possible MCP
connection**, not proven ownership. No uninstall is required to close a connection.
See [hotfix validation and remaining limits](docs/HOTFIX-ALPHA4.md).

### Projects Sorting

Projects default to **Recently modified**, with **Name A-Z** available beside
the existing search and SDK filter. Equal dates sort by name; unknown dates go
last. Sorting and filtering do not launch Unity or change project files.

The date is the newest saved file/folder timestamp under `Assets`, `Packages`
and `ProjectSettings`, not the root folder timestamp or the last time Unity was
opened. Generated `Library`, `Temp`, logs and MCP state outside those folders
are excluded. Linked folders are not followed. Dates are read on initial project
discovery and explicit Refresh, not continuously; unsaved Editor changes are not
included. Metadata checks run off the UI thread, with per-project and total
time/entry limits. An unreadable or incomplete scan shows **Modified date
unavailable**, never a guessed date.

```powershell
npm ci
npm run test:ui
npm run check
npm run build -- --no-bundle
```

Build the Hub-only Windows installer, without any experimental app payloads:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Build-Installer.ps1
```

Build the paired hosted development preview from both source checkouts:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/Build-HostedPreview.ps1
```

This pins the newly built Setup EXE into Hub and writes both executables into
`dist/Creator-Hub-Hosted-Setup-Preview`. They remain separate standalone-capable
applications; this is not a public Hub installer or automatic adoption release.

Supply paired `-McpPreview <approved EXE>` and `-McpSha256 <exact SHA-256>`
arguments to include the separate read-only MCP backend. This writes a new
`dist/Creator-Hub-Hosted-Apps-Preview` directory without replacing the Setup-only
pair. A mismatched or unpinned MCP executable cannot start.

The optional `-McpLifecyclePreview` switch enables the tested revision 2
read-only event handshake for a matching MCP candidate. It does not enable MCP
configuration writes or production adoption. Omit it for the original protocol.

Windows x64 is implemented. macOS/Linux native install and lifecycle support is
not implemented or tested. The unsigned EXE requires the normal system WebView2
runtime. Native builds use Tauri/Rust; no Unity Editor is bundled.

## Validation and Limits

Browser tests exercise app states, install routing, progress/cancellation,
opt-ins, Plugins, responsive layout, drawer behavior and image rendering.
Rust tests cover catalog/signature/hash rejection, cancellation, disk failures,
atomic local record replacement and close-state protection. Separate opt-in
network tests download the real pinned installers without executing them; real
Windows inventory tests do not launch or replace apps.

The coordinated MCP and Project Setup prereleases have published signed
descriptors and passed their installed Windows upgrade tests. Hub's own installer
has passed clean installation, busy-app refusal, cooperative update and GUI
startup checks on disposable Windows workers. Alpha.4 also passed an upgrade
from the published alpha.3 installer with existing files and settings preserved.
The final
[native acceptance run](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/34576995054)
passed fresh installs, both-app upgrades and MCP-only upgrades through Hub,
including native consent, saved MCP project/selection, a preference round-trip,
actual busy-close refusal and scoped exit. A real private-runtime fixture blocked
installation until its cooperative exit; no AI client was force-closed.
Project Setup is not required for MCP.
A successful installer exit is not enough: its installed launcher must
match the signed/pinned hash. Failed native installers are not assumed to be
transactional; Hub reports failure and retains cached installers.

See the [coordinated prerelease checklist](docs/PRERELEASE-TESTING.md) for the
exact test flow, channel choices, and remaining self-update limitations. Original
dependency notices ship in each installer's `licenses` folder; third-party
components and brand assets retain their own terms.

See [Roadmap](docs/ROADMAP.md) and [release catalog contract](docs/RELEASE-CATALOG.md).

## Assets and License

MIT. Original Creator Works artwork; Hub's gray backplate is original geometry,
not Unity artwork. SideQuest's unmodified logo remains its property and is not
relicensed under MIT. See [third-party assets](docs/THIRD-PARTY-ASSETS.md).
Selected Lucide SVGs keep their upstream license. Minisign verification uses
Frank Denis's MIT-licensed `minisign-verify`; signing uses Tauri's official CLI.
