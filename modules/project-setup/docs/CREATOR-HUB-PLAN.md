# Creator Hub: Approved Direction

## Latest Packaging Direction

User clarification, 2026-09-14: standalone MCP remains available, and Hub and
Setup should also provide MCP access alongside Plugins. The proposed common
MCP installation/settings ownership is recorded in the sibling Hub worktree's
`docs/SHARED-MCP-DIRECTION.md`. That packaging is not implemented by the current
Plugins preview. Version checks, migration and operation guards remain required.
The sections below retain the earlier hosting contract and its historical tests.

## Hosted Setup Preview Implemented

The current local development pair runs Setup's actual UI inside Hub, with its
own windowless native backend and shared standalone commands. Windows acceptance
confirms real requirements, native picking, retained forms and busy-close guards.
See the sibling Hub repository's `docs/HOSTING-PROTOCOL-PREVIEW.md` for source,
exact tested hashes, native reports and remaining adoption/shortcut/state-transfer
gates. Setup 0.2.2 remains unchanged; no installed user app was replaced.

The MCP owning task has supplied a tested read-only hosting slice. Its writable
lifecycle, cross-command leases and safe disconnect recovery remain separate
acceptance gates. Hub and MCP changes are coordinated with their owning task.

Release audit 2026-09-10: real isolated repair and a second validation passed,
including preserved scene/custom content/VS selections and a retained backup.
Hub cold/warm single-instance launches also passed, but that is navigation only,
not completed standalone adoption. The Setup installer now checks running apps
before displaying the legacy-uninstaller page. A no-install native A/B test
proved early refusal with no process termination. The rebuilt installer still
requires clean installed-upgrade acceptance before publication.

Decision corrected by the user: 2026-09-10. Creator Hub is an optional, lightweight
host containing the installed Creator apps in one window, not a launcher for
separate app windows. It adopts their existing installations and settings.
Creator Project Setup 0.2.2 has shipped publicly; none of this changes its immutable
downloads or claims hosting compatibility for that existing build.

## Product Boundary

- Collapsible left navigation with a real menu toggle and icon tooltips.
- Shared compact chrome: a protruding cube-logo tab without hamburger lines,
  H/M/P corner badges, and a gray isometric backplate for Hub. Standalone apps
  retain their menu when Hub is absent. Hosted apps use Hub's navigation instead,
  after a verified handoff; folder presence or URL parameters are not sufficient.
- Creator Works MCP and Creator Project Setup show Install, Open, or Update.
- Hub setup detects existing Creator apps and asks to "Update and add to Hub".
  Only approved apps receive necessary compatibility updates and adoption, using
  existing settings and files. If none are found or the user chooses "Not now",
  install Hub alone, with no automatic companion-app installation, shortcut
  rerouting or changes to existing apps. Offer adoption again later on request.
- A failed or cancelled update leaves that app unadopted and standalone. A
  compatible app can be added without reinstalling it, with the same consent.
- SideQuest's Creator Converter is Coming soon, with no fake install or download action.
- Creator Plugins is a future community directory, with no platform fees or
  commission. GitHub/website submissions first; hosting, moderation and optional
  SideQuest account integration remain decisions, not implemented capabilities.
- Flat tool detail pages, installed/available versions, download progress, and
  visible failures. No account, subscription, always-running service, or Unity
  Editor bundled in Hub.
- Optional first-launch Unity/Creator SDK assistance belongs in Hub. Keep a
  permanent Setup action. Existing standalone users do not acquire a mandatory
  onboarding flow, another app copy, or changed settings.
- Open displays the actual installed app interface inside Hub. Existing app
  shortcuts route to that view once compatible adoption is established, without
  a duplicate window, installation or settings copy. Hosted UI shares the tool's
  implementation, not a second imitation. This is a first-release requirement.
- Handoff waits for active operations and preserves selection/form/result state.
  Closing or uninstalling Hub must not interrupt Unity, client-owned MCP servers
  or pending app work. Apps retain a standalone fallback if Hub is unavailable.

## Ownership

Hub owns shared window/navigation, hosted-view lifecycle, adoption/shortcut routes,
catalog, inventory and user-approved download/update orchestration. Each tool owns
one reusable UI and backend, project operations, settings, safeguards and its
independently usable release. A headless backend process is compatible with the
one-visible-window requirement. Do not reparent foreign EXE windows. Unity Hub still
owns Unity installation, accounts, licenses and build-module handoffs.

The Creator Works MCP task owns MCP compatibility. This task owns Setup compatibility
and the shared contract below. Creator Converter remains separate work. Do not
change its repository or promise compatibility before its owner agrees.

## Contract 1: Read-only Identity

The exact argument `--creator-hub-info` must exit successfully with one compact
JSON object and a newline on stdout. It must run before GUI, single-instance,
network, configuration migration, project scanning or Unity work. Hub captures
stdout/stderr with a timeout and a maximum 4 KiB combined response. Unknown/extra Hub
arguments fail nonzero with no GUI and no operation. No output path, command,
project route, repair permission or installer instruction is accepted.

Required fields:

```json
{
  "schemaVersion": 1,
  "appId": "creator-project-setup",
  "displayName": "Creator Project Setup",
  "version": "0.3.0-alpha.1",
  "platform": "windows",
  "architecture": "x86_64",
  "capabilities": ["launch.standalone"]
}
```

Stable app IDs: `creator-project-setup`, `creator-works-mcp`. Reserve
`creator-converter` but do not publish a supported entry yet. Platform names
are `windows`, `macos`, `linux`; architectures are `x86_64`, `aarch64` for the
initial catalog. Version is the actual compiled SemVer, not a hard-coded feed
value. Ignore additional metadata fields, reject unsupported schema versions,
and never interpret returned strings as shell commands or trust decisions.

`launch.singleInstance` means a normal second invocation on that platform
reopens the running compatible GUI without resetting it or triggering work. It
does not cover pre-contract releases, elevated copies or a different login
session, and does not indicate a tool is idle or safe to replace. Hub must verify
an executable's provenance before executing even this read-only flag. Its
trusted release descriptor must explicitly advertise `identityProtocol: 1`.
Legacy releases may ignore unknown arguments: do not probe them based on a name
or version guess. Use a verified descriptor or ask the user to install a
supported version. Failed probes must not fall back to ordinary launch.

## Contract 2: Release and Update Catalog

The Hub must discover newer tool releases without requiring a new Hub build.
Use a small authenticated catalog with per-tool stable/preview channels, SemVer,
minimum Hub contract, release-note URL, and per-platform/architecture artifact
records (HTTPS URL, exact size, SHA-256, package type and relative entrypoint).
No arbitrary scripts, command templates or caller-controlled executable paths.

GitHub public release metadata is a discovery source, not arbitrary executable
authority. Only approved repositories/artifacts belong in the catalog. Release
descriptors are data; an adjacent checksum alone is not publisher authentication.
Before automatic downloading/launching ships, establish catalog signing with a
pinned public key, key recovery/rotation, bounded parsing, and rollback/replay
policy. This is separate from paid Windows Authenticode or macOS notarization.

Compare Semantic Versions, not strings or release dates. Ignore drafts.
Prereleases and verified background update downloads default to on for new Hub
profiles; each can be disabled independently and saved choices are preserved.
No downgrade of an installed newer version. Cache verified catalog data for
offline use, show stale/failed checks honestly, and check at startup/on request
rather than continuous polling. Installation is a separate explicit action.

## Installation Safety

- Detect existing installations and offer reuse. Hub inventory is advisory, not
  permission to execute an arbitrary file. Recheck identities and hashes.
- Hub-managed portable installs get versioned directories and a retained prior
  version. Existing native/legacy installations use their supported updater or
  an explicit migration; do not create a competing installation silently.
- Check free space on download, extraction, target and rollback volumes.
- Verify metadata before download and size/hash before extraction or execution.
  Reject archive traversal, links, unexpected entrypoints and partial payloads.
- Do not replace running tools or force-close them. MCP includes long-lived
  server processes used by AI clients, not just its launcher window. Reliable
  process/operation detection is a release gate, not implied by the info command.
- Never change a Unity project, bridge, active MCP route, or AI client settings
  as a side effect of app discovery, Hub closure, or a tool's process exit.
- Keep logs local, bounded and redacted. Uninstalling Hub leaves independently
  installed tools and all user projects/settings intact.

## Delivery Order and Gates

1. Done: publish the tested Setup 0.2.2 Windows release publicly, unchanged.
2. In progress: next-version read-only metadata in Setup and MCP, with matching
   field names and automated/native tests. Reliable Windows re-open is a
   separate gate before either app advertises `launch.singleInstance`.
3. Next: minimum trusted hosted UI/backend contract, proven with Project Setup
   working inside Hub using its existing code, settings, pickers and progress.
4. Next: standalone-to-hosted adoption, shortcut routing, idle state-preserving
   handoff and fallback. Apply the same contract to MCP with its owning task.
5. Integrate the existing signed catalog/download/update work with hosted module
   versions. No arbitrary command execution or running-app replacement.
6. Accept: one window/one settings location, repeated/concurrent shortcut opens,
   busy view switching/handoff, fallback, failure/offline/recovery, install/update,
   signature/hash failures, older/newer versions and active MCP connections.
   Player emulation is outside this plan; Creator Converter remains Coming soon.

## Historical Interface Pass: 2026-09-10

Setup and MCP now have coordinated next-version compact interfaces. Setup's
creation fields collapse into a summary/progress view without changing the
underlying Unity creation or repair contracts. See [UI preview](UI-PREVIEW.md).

A separate local Creator Hub `0.1.0-alpha.1` interface shell now provides an app
catalog, detail views, accessible switcher and pinned public release/source
links. It does not yet install, inventory, update, or embed apps. Its Windows
EXE is an interface preview, not completion of gates 3-5 above. This distinction
must remain visible in the app and any download description.

Next-version support may ship independently after both app contracts agree.
It must not be advertised as a complete Hub or safe automatic updater. Windows
is first; macOS/Linux need native lifecycle, packaging and Unity acceptance.

## Lifecycle Review Finding

The current Windows source for the official Tauri single-instance plugin 2.4.4
allows initialization to continue when its mutex exists but its message window
does not yet exist. Its forwarding call is also synchronous without a timeout.
This is a source-level startup-race/blocked-window risk, not a reproduced failure
in Setup. The candidate plugin was removed from this first metadata-only pass;
no duplicate-launch prevention is claimed. Require simultaneous cold-start and
blocked-GUI tests before adding the capability. Use a narrow reviewed solution,
not an expanding custom IPC framework.

Source reviewed: [Tauri single-instance Windows implementation](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/single-instance/src/platform_impl/windows.rs).

## Historical Install Manager Pass: 2026-09-10

The local Hub now implements verified Windows downloads, public-release update
checks, signed descriptor verification, install/open/adoption actions, progress,
cancellation and explicit update consent. Legacy installers use their normal
window because their silent path may force-close running apps. No seamless
legacy restart claim is made. Future descriptors must be published and signed
with the Hub catalog key before a new app is an authorized update.

Setup keeps native operation guards alive inside its asynchronous Unity workers,
refuses close/exit while busy and rejects new work once closing begins. Its new
installer/uninstaller refuses running-app replacement rather than force-killing
the app. It cannot change an already-installed old uninstaller. Source/race tests
are not native end-to-end installer acceptance; retain protocol zero until the
respective production GUI/package tests pass.

Remaining gates: clean-VM native install/upgrade, signed descriptor publication,
catalog-key backup/recovery and platform-specific acceptance. Creator Plugins
hosting is undecided; GitHub Pages, Bonto and an owner-operated server are
candidates only. Community listings must remain separate from trusted updates.
