# Native Hub Integration

## Decision

User clarification, 2026-10-18: MCP and Project Setup must be functions of Hub,
with normal pages in the main Hub interface. Packaging their existing app
interfaces inside Hub is not the requested completed integration.

Hold additional Linux/Flatpak packaging and publication of the hosted-app design.
Keep the published Windows version unchanged; explicitly requested local test
installations remain separate from release acceptance. macOS remains
suspended. Preserve existing test artifacts and evidence; do not rebuild old
candidates to change their description.

Use the simpler native-helper approach for Flatpak after direct Hub integration:
the Flatpak launcher activates the native Hub, with one visible, integrated Hub
window. Installation must explicitly disclose that this window runs outside the
Flatpak sandbox. The previously approved helper is not a reason to add another
module UI or a larger sandbox-to-host command relay. Helper installation,
version binding, activation, update and removal still require acceptance. This
decision is not a claim of Flathub eligibility or completed Flatpak support.

## Verified Current State

2026-10-22 priority: complete the direct pages and reported product bugs before
returning to Flatpak. Keep published and installed Windows apps unchanged; no
Mac work. This is source/test work, not a new release or native acceptance.

For a product change, run `npm run test:integration:ui` before a native build.
Then run `npm run test:integration:native` for host-native regression tests,
using the existing Cargo target cache and locked dependency graph. These commands
do not package, sign, install or publish an app. Browser tests use fixture APIs;
host-native tests are not proof of another platform's behavior. Native Linux
install/update/restart acceptance still uses its reviewed platform feature set
and disposable settings. Test-only changes reuse verified product artifacts;
product changes require a newly bound candidate after the focused tests pass.

- **Legacy design, retained for existing builds:** `src/hosted.js` creates an iframe and reconstructs each
  module's full document; `src-tauri/src/hosted.rs` starts its private executable.
  `scripts/build-unified.cjs` packages both launcher executables. This consolidates
  installation, but not the app interfaces or backend entrypoints.
- **Confirmed integration hazards:** module controllers query the global document
  and share DOM IDs with Hub. Both install `window.CreatorRuntime`; module styles
  include global selectors. Loading the old scripts into Hub unchanged is unsafe.
- **Reusable protections:** existing settings stores, exact before-images,
  ownership checks, journals and stable MCP routing are implementation contracts
  to preserve, not data to reset during the UI change.
- **Unknown / not accepted:** actual signed Linux installation and automatic
  restart, complete migration and production Flatpak host operation. Windows
  direct-page read-only evidence is scoped below. Prior component/authentication tests cover their named
  mechanisms only; they do not establish these outcomes.

## Direct Implementation Checkpoint (2026-10-18)

The default-off `integrated-features` Cargo feature now compiles Setup and MCP
as internal Rust libraries. `src-tauri/src/features.rs` dispatches a finite,
bounded command set on blocking workers; no module GUI or module webview is
started. `src/features/` contains scoped pages under the existing Hub shell.
Legacy app-opening commands refuse in this mode, including development builds
without a bundled descriptor. Published Windows builds do not enable the feature.

2026-10-19 Windows local continuation: direct-feature compilation,407 Root
native tests,287 MCP internal-service tests and102 browser tests pass on Windows.
The builder now accepts explicit `--managed --integrated-features` for Windows
x86_64 candidates, without Linux activation/retirement flags or any acceptance
claim. Legacy/default builds remain unchanged. A local candidate can bind its
internal service to the already verified frozen runtime payload; existing
launcher resources remain for descriptor compatibility but are not executed by
direct page navigation. Installed native page/process/preservation checks remain
required before describing this as an accepted Windows integrated build.

The exact installer-extracted Windows candidate at source `98dd708` passed
read-only native page checks in
`artifacts/local-direct-features-20261019/native-run-1792407453032/native-readonly-receipt.json`.
MCP and Setup returned Ready in the single main document, with only WebView2
child processes, no module GUI launch, unchanged settings and a normal close.
The operation journal appended only its expected successful read records.
This is not signed update/restart, complete migration or live-client acceptance.

Direct-feature Hub now uses Projects as its home, with one Hub updater above
the project list. MCP and Setup are menu tools, not separately updated app rows.
Existing update preferences remain under Update settings; legacy builds retain
their Apps/Projects navigation. This frontend change requires a new local Root
candidate; it does not change frozen runtime payloads or published release bytes.

Server-path recovery is a separate native decision. An unrecognized saved MCP
server is not automatically trusted or run. The user may explicitly choose the
already verified Hub runtime instead; only `mcp_server_path` changes, with exact
backups and a recoverable transaction. Cancelling keeps both settings stores.
Project selection, preferences, unknown fields and AI-client entries are not
changed by this step. Snapshot and recognition changes during review require a
new review. Client migration and standalone retirement retain their own gates.

Setup retains its existing creation, installation and repair handlers. MCP uses
an explicit, thread-bound integration scope, retained writer locks, exact
before-images and operation/recovery journals. Its service-only settings review
receipt records the actual native approval; conflict/legacy stores are not
silently merged or reset. Cancelled review keeps the form locked. MCP's stable
managed route is bound only for operations that require it, not page navigation.

Hub owns operation/close/update leases. A returned or panicked MCP workflow can
be closed only after native approval and a second worker-state check; it is not
replayed, rolled back or marked successful. Migration retains its operation
lease through the saved completion record. Update restoration uses normal Hub
navigation, never a saved standalone executable. These mechanisms have portable
tests; native GUI interleavings and installed acceptance remain separate gates.

The experimental Linux host build now registers fixed session activation on its
normal integrated window. An explicit integrated-candidate DEB profile combines
the existing retirement helper/policy with the fixed D-Bus service. Candidate
receipts keep all native operation and release-readiness flags false. The first
native compile/test job is `linux-integrated-features.yml`; it neither signs nor
installs nor publishes software. No new version has been selected or published.

## Implementation Order

1. Add an additive internal Setup library boundary for its existing recipe,
   environment probe and read-only inspection. Keep the current binary and
   packaging unchanged while testing result/path parity. Do not enable mutation
   through an unreviewed library facade.
2. Build a scoped Setup page and namespaced Hub command adapters. Hub owns its
   dialogs, progress and operation/close/update leases. Reuse existing creation,
   installation and backed-up repair algorithms after read-only parity passes.
3. Extract MCP business operations behind an internal service facade and add its
   scoped Hub page. Replace compile-time standalone/internal writer selection
   with explicit integration context before wiring any client settings writer.
   Preserve client ownership, selected projects, consent, backup and recovery.
4. Replace app-level navigation, duplicate chrome, hosted documents and
   open/close-app permissions with normal Hub page lifecycle. Controllers need
   explicit mount/show/hide/dispose, scoped DOM and styles, and scoped events.
   Do not inject backend-supplied HTML into the privileged Hub document.
5. Remove GUI launcher payloads from new packages only after reviewing the signed
   descriptor/router transition and replacing migration's hosted-session adapter.
   Existing descriptors bind launcher paths. Retain old runtime generations until
   their routes are safely migrated; never break them to meet a file-count goal.
6. Wire the Flatpak launcher/helper to this integrated Hub. Then perform complete
   native install, migration, signed update and automatic restart tests against
   the exact final package, with settings and owned client entries preserved.

MCP's Node/server/router processes and deliberate installation/Unity workers may
remain separate processes. They are services, not separate user-facing apps.
The target is one product and interface, not an artificial single-process limit.

## Acceptance Criteria

- MCP and Setup render as ordinary Hub pages, without feature iframes, imported
  standalone documents, nested navigation, independent app updater controls or
  another application permission prompt just to select a page.
- Preserve the existing font/icons. One Hub shell owns navigation, terms, help
  and platform labeling. Pages retain form state across navigation; IDs, styles,
  events, timers, errors and busy state cannot leak between pages.
- One Refresh action causes one operation. Navigation or duplicate clicks cannot
  restart work. Close/update remains blocked during active work; cancellation and
  failure leave a visible, retryable state without forced process termination.
- Tests cover fresh installs, upgrades, pending migration recovery, concurrent
  legacy instances, unchanged third-party client entries, retained projects and
  exact backups. Unknown or changed configurations are preserved, not adopted.
- Package inspection and actual native execution prove direct pages, no launched
  module GUI entrypoints, settings parity, real client connectivity and automatic
  post-update restart. Browser mocks and unit tests are not substitutes.
- Flatpak tests include explicit helper approval, real host operations, one
  window, host settings preservation, restart/reactivation and safe removal.
  Do not claim sandboxed Hub operation when the native helper hosts the window.

Do not choose a release number or publish based on this document. Source and
portable test results do not establish installed migration, update, restart or
Flatpak acceptance.
