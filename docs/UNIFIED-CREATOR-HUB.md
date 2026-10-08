# Unified Creator Hub

Direction approved by the user on 2026-10-03. This supersedes the separate-product
directions in PROJECT-SETUP-IN-HUB.md and SHARED-MCP-DIRECTION.md.

## Product And Repository

- Creator Hub is the one public desktop product, installer and update stream.
- Projects, Project Setup and MCP are sections of that product.
- Plugins has a temporary retirement notice, not an active catalogue.
- CREATOR-HUB is the canonical repository for future development.
- MCP and Setup remain internal modules, not independently installed products.
- modules/mcp and modules/project-setup retain the complete Git ancestry of their
  accepted 2.7.7 and 0.3.7 sources. modules/suite.json records the import revisions.
- Historical repositories, tags, download URLs, signed metadata and installer
  bytes remain available. Do not archive them or redirect their updater feeds
  before standalone migration is tested and available.
- Update the old repository READMEs and release notices to point to Hub when the
  migration release exists; do not claim that current downloads are unified.

## Current State

Published Hub 0.1.12 still installs and hosts separate MCP/Setup applications.
The consolidation branch now has an opt-in Windows built-in candidate builder.
It compiles private backends (no installers or app registrations), packages MCP's
server/runtime/bridge, and binds their hashes into the Hub executable. Native
inventory and startup use these payloads instead of companion discovery. The
separate-app controls and MCP's standalone update check are hidden for built-ins.
Legacy builds remain unchanged when no built-in descriptor is supplied.

Built-in selections now use an opening/error/retry surface, not the legacy
standalone app information and installer page. Startup completes the module's
initial probe/workflow before opening a section selected while it was busy.
Declined permission remains retryable, and a failed inventory prevents automatic
hosting from last-known state. Browser regressions cover both startup orders,
delayed native consent, failure and narrow layouts; they do not replace native
consent, migration or signed update/restart acceptance.

The existing consent and exclusive settings ownership checks remain in place.
This is not migration acceptance: the current modules still use their existing
settings locations, and no legacy client entries are repointed by this phase.
Private MCP startup reads existing settings without persisting the standalone
loader's automatic path/schema migration. Explicit setup/save operations remain
separate; a complete approved migration and backup adapter is still required.
Explicit built-in MCP saves now retain verified, content-addressed before-images
beside the settings file, and launcher/channel saves preserve unknown JSON fields.
Codex configuration edits use a formatting-preserving TOML parser, including
quoted, dotted and inline server entries. Invalid documents refuse rewriting.
These protections are not an approved multi-file migration, activation receipt
or power-loss recovery transaction.
The bundled restore marker can reopen the current build-bound module after an
update; saved paths do not authorize an arbitrary executable.

`npm run build:unified -- unique-build-name` creates a new immutable local
candidate under `artifacts/unified/`. It does not install it or publish a release.
The dedicated clean Windows CI check launches both real backends without
companion installations. The native acceptance script refuses non-disposable
machines before inspecting settings or registrations.

The modules now share a macOS parent-process check using Apple's `proc_pidpath`:
private pipes, direct Hub parent and valid native executable path remain required.
The Hub macOS test jobs exercise the shared native API on Intel and Apple silicon;
this does not prove complete module hosting or native consent on either platform.
Writable MCP hosting remains Windows-only. The
unified builder therefore refuses non-Windows candidates until those contracts
and their native acceptance are implemented. Existing standalone platform builds
are not being removed or relabeled as unified builds.

Standalone Unix MCP now participates in exclusive GUI settings ownership through
an advisory lock. Command admission checks the held marker identity and refuses
changed, replaced or redirected paths. Native module tests run on Linux and both
Mac architectures as well as Windows. Advisory ownership is not immutable payload
protection; writable Unix hosting remains disabled until that separate contract
and complete native acceptance are implemented.

Root source CI and browser fixtures now use the local modules instead of fetching
other repositories. Initial subtree contents must match their accepted source
trees exactly. This branch's release workflow is blocked until distribution and
migration are implemented and accepted; changing a readiness label is not enough.

## Integration Boundary

Reuse the working MCP/Setup command, progress, cancellation and lifecycle
contracts. Avoid a simultaneous rewrite of the tooling logic and installer.
Build module payloads from this repository and include them in the Hub package;
features must work on a clean machine with neither standalone app installed.
Do not use registry presence, a remote companion catalogue or a version label
as authorization to open a built-in feature. Verify the packaged payload identity.

One product does not require one process. Isolated internal backends are allowed
where they preserve lifecycle and failure isolation, but they must not create
separate app registrations, downloads, update buttons or end-user installations.
Only start the MCP backend/runtime when required. Keep a stable managed MCP
entry point so Hub upgrades do not strand AI-client configurations.

Built-in MCP startup now stages the complete verified backend/server/runtime into
`creator-hub/runtime-generations/<platform-arch>/<descriptor-hash>` in local app
data. Only a fully verified staging directory is renamed into the generation
path. A preparation lock serializes concurrent Hub attempts; corrupt existing
generations fail closed rather than being overwritten. Inventory remains
read-only. Old generations are retained without automatic repair or deletion,
so their configured paths do not disappear when Hub resources are replaced.
Startup and post-update restoration both use this path. Unit tests cover same
version/different bytes, retained older payloads, tampering, incomplete sources,
abandoned staging and competing preparation. Native candidate acceptance must
also prove the actual backend and Node run from the verified generation.

This is not stable client routing or migration: no activation receipt is yet
used to repoint existing AI clients, and no legacy client configuration is edited
by staging. Power-loss recovery and a real signed update with active runtime
connections remain release acceptance requirements.

### Queue Ownership Regression

Run 37344015707 preserved the failure of the Apple silicon queue-history test:
`repeated_terminal_imports_archive_without_losing_receipts_or_status` received a
busy lock immediately after its previous operation. The new parent-identity
tests passed; the failed run is not being relabeled successful.

A deterministic duplicate-handle test reproduced retained queue ownership on
Windows too: dropping the original file did not release its lock while a clone
remained alive. Setup already explicitly unlocked its operation guard. Hub and
MCP now use that same guard pattern, with duplicate-handle regression coverage in
all three crates. Runtime preparation also explicitly unlocks its guard. A truly
active operation still refuses another writer; no retry delay or forced process
termination is used. This mechanism is consistent with the Mac failure, but is
not proof of the cause of every previously reported intermittent import issue.

Prefer immutable, versioned runtime payloads and an atomic activation receipt.
Keep the previous verified payload while it is still referenced or running.
Do not overwrite a live node executable, kill unrelated processes or point a
client at a partially installed generation. Actual packaging determines the
implementation; these are requirements, not claims of working code.

## Standalone Migration

The existing signed catalogue validates product identity. MCP 2.x and Setup
0.3.x versions cannot be compared against Hub 0.x as if they were one product.
The MCP launcher update check currently opens a release URL; it is not an
automatic self-updater. Some older users will need a guided one-time installer.

1. Detect the verified existing Hub and standalone installations without changing
   them. Identify duplicate/custom installs and active operations explicitly.
2. Obtain approval for a signed migration package and target Hub installation.
   Respect an already-newer Hub; never downgrade it to the migration baseline.
3. Preserve the old installation and create a retained backup of affected app
   settings and product-owned AI-client entries. Leave Unity projects untouched.
4. Install the verified unified Hub payload into its established product identity.
5. Reuse/migrate settings only through an explicit schema adapter. If both Hub and
   standalone settings exist, resolve conflicting values visibly; do not silently
   replace the user's selected configuration with whichever file was read last.
6. Repoint only recognized product-owned client entries after the target runtime
   is verified. Preserve user-authored entries and retain referenced old runtimes
   until reconnection and the new route have been verified.
7. Open the corresponding Hub section. Preserve applicable notice preferences or
   request new acknowledgement; never manufacture acceptance of new terms.
8. Record success durably. Offer removal of legacy app registrations only after
   verification, and only when no client still depends on their runtime.

Cancellation and failure must leave a usable old installation. Repeated starts,
interrupted migration, already-completed migration and update-after-migration
need explicit tests. Keep diagnostics local and exclude secrets from reports.

The convergence release starts in Hub: detect standalone apps, explain retained
data and backups, and request migration approval. Offer old-app removal only
after migrated settings and a working Hub runtime/client route are verified.
Removal must preserve app data and retained backups; it is not a prerequisite
for starting migration. Final standalone transition builds should offer a
clearly named **Move to Creator Hub** action rather than impersonating Hub or
comparing incompatible product version numbers. These steps are requirements,
not completed migration functionality.

## Plugins Retirement

Approved on 2026-10-08. New builds replace the catalogue in Hub, MCP and Setup
with the same retirement notice. New catalogue fetches, package downloads,
imports and Unity-menu installation are disabled in native dispatch as well as
removed from the UI. Existing receipt/status and cancellation cleanup remain
available. Existing imported assets, Unity projects and receipts are not deleted
or rewritten. Already-installed Unity windows are not silently modified.

Before **2026-10-20 00:00:00 UTC**, the notice offers a button for the fixed URL
`https://creatorplugins.store/`. At and after that cutoff it shows the retired
notice only: no website link or import action. Both frontend and native opener
check the same boundary. Focus/visibility events and a bounded timer refresh an
already-open view; a stale click also rechecks before invoking the native opener.
The transition works offline using the device clock once this build is installed.
It cannot alter old binaries that never install the retirement update, nor enforce
real-world time when a device's clock is incorrect.

Historical browser import coverage runs against an explicitly test-only legacy
catalogue fixture. Production retirement UI has separate date-boundary, layout
and no-import coverage; passing the historical fixture is not evidence that the
retired production catalogue remains available.

## Acceptance Before Rollout

- Windows, macOS Intel, macOS Apple silicon and Linux packaged builds.
- Clean machine: all built-in features work without companion installs or feeds.
- MCP-only, Setup-only, Hub-only, MCP+Setup and all-three migration baselines.
- Existing/custom/duplicate installs, conflicting settings and already-newer Hub.
- Missing requirements, permission refusal, native cancellation and failed install.
- Active Setup work, active MCP connections, stuck owned runtime and unrelated Node.
- Existing client configurations, preferences, terms/notice choices and project
  content are preserved; changed fields have exact backups and a recovery path.
- A migrated user and a fresh user both update to the next exact signed Hub build,
  restart automatically, reopen features and retain working MCP client connections.
- Test the unmodified previous stable updater, not only a simulated release feed.

Run these on disposable installations. Current source tests, the existing hosted
acceptance and a successful monorepo build are not migration acceptance.

## Development

```powershell
npm ci
npm --prefix modules/mcp ci
npm --prefix modules/project-setup ci
npm run check:sources
npm run test:modules
npm run test:scripts
npm run test:ui
```

`node scripts/check-unified-sources.cjs --verify-imports` verifies initial subtree
trees and retained history. Once module code changes intentionally, that initial
import check is historical evidence, not the normal source CI check.
