# Native Hub Integration

## Decision

User clarification, 2026-10-18: MCP and Project Setup must be functions of Hub,
with normal pages in the main Hub interface. Packaging their existing app
interfaces inside Hub is not the requested completed integration.

Hold additional Linux/Flatpak packaging and publication of the hosted-app design.
Keep the published and installed Windows version unchanged. macOS remains
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

- **Confirmed mismatch:** `src/hosted.js` creates an iframe and reconstructs each
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
  restart, complete migration, production Flatpak host operation and direct Hub
  page operation. Prior component/authentication tests cover their named
  mechanisms only; they do not establish these outcomes.

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

Do not choose a release number or publish based on this document. This records
the required architecture and work order, not completed integration or acceptance.
