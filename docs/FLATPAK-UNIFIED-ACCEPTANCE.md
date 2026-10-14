# Unified Linux And Flatpak Acceptance Plan

Audit: 2026-10-14, Hub 0.1.14; checkout HEAD
`cc2c2836da79afb9ef4a02ebbdcd47ab502a295d`, with concurrent uncommitted
coordinator changes. This is a source/fixture audit, not a frozen payload binding.
No Linux app, Flatpak, installer, user settings or auth file was opened here.
No workflow was dispatched. All readiness and migration acceptance remain false.

## Findings And Classification

| Classification | Current evidence | Consequence |
| --- | --- | --- |
| Correct as-is | `scripts/build-unified.cjs:97-112` defines `copy` before `executable`, but invokes it only after the same-scope `const executable` is initialized. `scripts/unix-managed-payload.test.cjs` executes this preparation branch with mocked native tools on Linux x86_64/aarch64 and both Mac architectures. | No unbound reference or temporal-dead-zone failure; no builder patch warranted. Passing a synthetic fixture is not a fresh native Rust payload. |
| Correct as-is | `scripts/unix-managed-payload.cjs` requires clean, source/run-bound disposable native preparation; it emits unsigned inputs, not Hub/signing authority/acceptance. `scripts/assemble-unix-payload.cjs` verifies the signed handoff and private-source equivalence before building the outer Hub. | Preserve these gates. Do not relabel stale artifacts as current 0.1.14. |
| Confirmed incompatible with a Flatpak acceptance claim | `scripts/native-unix-hosted-acceptance.cjs:35` and `scripts/native-unix-window.py:ensure_runner` explicitly refuse Flatpak. `scripts/native-builtin-smoke.cjs` requires Windows and WebView2 CDP. | None is an existing full Flatpak or native Linux built-in migration driver. These refusals are intentional, not defects. |
| Confirmed missing integration | `native/mcp-router/src/lib.rs:Store::installed`, `src-tauri/src/builtin.rs:generations`, and MCP settings derive XDG locations. Flatpak redirects XDG config/data to its own app-private directories. | An unchanged sandbox build would select different product/route stores; it cannot claim retention of the native host stores. |
| Confirmed missing integration | MCP `hosted_unix.rs:parent_host` requires private inherited FIFOs and the direct Creator Hub parent; `hosted.rs:run` locks the parent image. Unix writable admission also requires a signed managed route and current settings ownership. | A D-Bus proxy, `flatpak-spawn`, environment flag or copied receipt does not satisfy the existing hosting contract. |
| Likely wrong, not runtime-proven | Repacking Ubuntu-built GUI/backend ELFs into an unrelated GNOME runtime, or executing a Flatpak-built backend on the host. | ELF dependencies, symbol versions, WebKitGTK, resources and execution policy require actual tests on each side; file hashes alone do not establish ABI compatibility. |
| Unknown / needs capture | Current 0.1.14 real Linux GUI, writable migration, package replacement/reconnect, Wayland, and Flatpak caller/portal admission. | Keep native Linux, component fixtures and Flatpak acceptance separate. |

Flatpak's app-private XDG locations are documented in
[Flatpak conventions](https://docs.flatpak.org/en/latest/conventions.html).
Native defaults below mean independently derived host XDG directories, not
hardcoded paths when a user has configured other XDG roots.

## Smallest Proposed Manifest

This is an exact **local experiment recipe**, not a checked-in packaging change
or a usable migration package. It requires a reviewed, future broker-aware UI
build; the unchanged current UI does not implement that boundary. Start x86_64
only. Do not claim aarch64 acceptance from synthetic preparation fixtures.

GNOME documents stable Platform/SDK branch 50 in its
[published build outputs](https://gnome.pages.gitlab.gnome.org/gnome-build-meta/docs/ci-outputs.html).
Branch 50 is a bounded candidate choice, not a claim that it is newest, supported
for the required lifetime, or ABI-compatible with this payload. Record the exact
Platform/SDK commits used by the disposable experiment. No such commits were
resolved or installed during this audit.

```yaml
id: com.creatorworks.hub
runtime: org.gnome.Platform
runtime-version: '50'
sdk: org.gnome.Sdk
command: creator-hub
build-options:
  strip: false
  no-debuginfo: true
finish-args:
  - --socket=wayland
  - --socket=fallback-x11
  - --device=dri
  - --share=ipc
  - --share=network
  - --talk-name=com.creatorworks.hub.HostMcp1
modules:
  - name: creator-hub-reviewed-input
    buildsystem: simple
    sources:
      - type: dir
        path: flatpak-input
    build-commands:
      - install -Dm755 bin/creator-hub /app/bin/creator-hub
      - install -Dm644 'lib/Creator Hub/modules.tar.gz' '/app/lib/Creator Hub/modules.tar.gz'
      - install -Dm644 share/applications/com.creatorworks.hub.desktop /app/share/applications/com.creatorworks.hub.desktop
      - install -Dm644 share/icons/hicolor/128x128/apps/com.creatorworks.hub.png /app/share/icons/hicolor/128x128/apps/com.creatorworks.hub.png
      - install -Dm644 share/metainfo/com.creatorworks.hub.metainfo.xml /app/share/metainfo/com.creatorworks.hub.metainfo.xml
```

The proposed five-file staging tree is exactly the five source paths above.
Require ordinary files/ancestors, no links or extra files, canonical modes,
bounded sizes and an independently reviewed hash inventory before building.
The Hub ELF must embed the final archive descriptor for the exact archive.
Preserve signed routing/runtime metadata and executable modes **inside** the
bounded archive; do not apply Tauri's example recursive resource `chmod 644` to
unpacked Node/router/backend executables. Disable builder ELF debug extraction
and stripping, then compare installed Hub/archive bytes again. Builder options
are defined in the [manifest reference](https://docs.flatpak.org/en/latest/flatpak-builder-command-reference.html).

The resource destination is grounded in locked `tauri-utils` 2.9.3
`resource_dir_from`: Linux first tries the executable's existing
`../lib/<package_info.name>`. Existing package-layout fixtures use `Creator Hub`.
For `/app/bin/creator-hub`, an existing `/app/lib/Creator Hub` is therefore the
candidate resource directory. Prove this with the actual ELF, not an assumed
`/app/share` copy or APPDIR override. The desktop file must use
`Exec=creator-hub`, `Icon=com.creatorworks.hub`, `Terminal=false`; metainfo must
match the app/desktop ID and version. These input files do not exist as a reviewed
Flatpak staging tree yet.

[Tauri's Flatpak guide](https://v2.tauri.app/distribute/flatpak/) supports the
binary/resources/desktop/icon/metainfo pattern, but its example runtime numbers
are not this application's ABI proof. Missing libraries must be built for the
selected runtime; do not copy arbitrary host `.so` files to make startup pass.

Permissions deliberately omit `home`, `host`, host config/data paths, global
session/system bus access, `org.freedesktop.Flatpak` host-command access, extra
process visibility and `--allow=devel`. Network is included only for current
Hub catalogue/download functionality; it is not needed merely to talk to the
broker. A later broker-only/offline UI can remove it after proving its call graph.
Network permission also exposes host abstract Unix sockets, so the broker must
enforce authority itself; the bus filter is not the sole security boundary.
The graphics and narrowly named bus permissions follow
[Flatpak sandbox guidance](https://docs.flatpak.org/en/latest/sandbox-permissions.html).
No software-rendering or sandbox-disabling workaround is proposed.

## Host MCP Broker Boundary

Proposed transport: session D-Bus name `com.creatorworks.hub.HostMcp1`, object
`/com/creatorworks/hub/HostMcp1`, interface `com.creatorworks.hub.HostMcp1`.
These names are a design proposal, not implemented interfaces.

1. Install the native, signed host broker/router through a separately reviewed
   native user installation. The Flatpak manifest must not bootstrap arbitrary
   host executables. Missing/unsupported broker means blocked host operations,
   no migration, no fallback to `flatpak-spawn --host` or generic command launch.
2. Start with only `GetStatus` and `InspectMigration`. Return bounded, redacted
   status, stable client IDs and a broker-owned plan ID/digest. Never accept a
   config path, executable, argv, environment, installer URL or script from the
   UI. Even inspection requires narrowly scoped caller admission and must not
   return entire AI configs or secret values.
3. A later `RequestConsent(planId)` uses the native host's own dialog. A separate
   `ApplyMigration(planId, reviewedDigest)` consumes a one-use broker-owned
   approval bound to caller identity, exact before-images, settings ownership
   and selected actions. Neither a frontend boolean nor a journal receipt grants
   authority. Recheck immediately before mutation; changed/missing/foreign
   entries refuse. Recovery is separately inspected and explicitly reviewed.
4. Authenticate the live bus sender, not claimed `FLATPAK_ID`/PID/app ID. D-Bus
   provides connection credentials; libflatpak exposes running app/arch/commit
   and sandbox/main-process PIDs, but warns that lifecycle tracking is racy.
   Require independently trusted deployment/payload binding, UID, live process
   start/image/namespace identity, bounded protocol version and a session nonce.
   Recheck bus owner/process/deployment drift. A nonce or same-UID match alone
   proves neither app ownership nor approval. Actual filtered-bus/proxy-to-app
   credential mapping remains an implementation blocker; do not equate a proxy
   PID or instance-list entry to the UI process.
5. Keep native MCP runtime execution on the host. The host router's normal stdio
   remains the AI client's entrypoint and selects signed host generations.
   Never write `/app/...`, sandbox `/run/user/.../doc/...`, Flatpak-internal Node,
   or a raw mutable legacy Node target into native client routing. GUI closure,
   sandbox exit and Flatpak uninstall must not terminate those server runtimes.
6. Reuse native settings transactions, parser-preserving client adapters and
   signed activation machinery, not generic file RPC. A broker process is not
   the current direct Hub parent; add an explicitly reviewed admission adapter
   rather than weakening checks or renaming an unrelated executable to Hub.
   Host payload dependencies need their own native ABI proof.

The credential primitives are described by the
[D-Bus specification source](https://raw.githubusercontent.com/d-bus/dbus/master/doc/dbus-specification.xml)
and [libflatpak instance API](https://docs.flatpak.org/en/latest/libflatpak-api-reference.html).
They do not establish that a complete secure broker implementation exists here.

Canonical product settings stay host-owned:
`<host config>/creator-works-mcp/launcher-config.json`, with read/review retention
of `<host config>/banter-mcp/launcher-config.json`. Existing `product_settings.rs`
explicitly protects this shared store rather than introducing another Hub copy.
Canonical routes/generations stay under `<host data>/creator-hub`, scoped by
`linux-x86_64` or `linux-aarch64`. Sandbox config/data holds only sandbox UI state;
do not silently import or overwrite the host settings with a sandbox-default copy.
Preserve unknown JSON fields, legacy server folders, projects and exact foreign
client entries. Client paths are derived by host adapters (for example
`~/.claude.json`, `~/.codex/config.toml`, `~/.gemini/config/mcp_config.json`,
`<host config>/opencode/opencode.jsonc`), never selected by RPC. No auth files
are part of this inventory.

Keep Setup host launch/install/restart operations blocked in the first increment.
Current Setup probes host Unity Hub config and launches native tools; these are
not ordinary sandbox reads. A subsequent project operation must use an explicit
host-owned project grant. Document portal `GetHostPaths` exists from interface
version 5, but a returned path is not host write/execution consent. Prove grant
identity, canonical project root, revocation and host/sandbox path equivalence;
otherwise refuse. See the [Documents portal contract](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Documents.html).

## Reusable Native Linux Route

Use native Linux first; it cannot confer Flatpak acceptance.

| Existing route | Exact useful contract | Limit |
| --- | --- | --- |
| `.github/workflows/unix-managed-payload.yml`, `platform=linux`, Ubuntu 22.04 | `npm run build:unified -- ci-unsigned-unix-payload --managed --experimental-unix --experimental-unix-writable --prepare-managed-unix`; then native `unix-transfer pack/verify`. Produces unsigned modules/router, canonical modes, exact commit/tree/run binding. | No outer Hub, key, GUI or migration acceptance. Push admission is restricted to `validation/unix-payload-014` and the workflow path; source changes alone do not automatically refresh this lane. |
| `.github/workflows/unix-managed-assembly.yml` | Main supplies exact independently reviewed signed input pins; `npm run build:unified -- ci-signed-unix-hub --managed --experimental-unix --experimental-unix-writable --signed-unix-input "$temp/signed-unix-input"`. Builds only outer Hub plus verification/archive tools. | No installer or full native GUI acceptance in this invocation. Existing default artifact IDs/hashes are not proof of freshness. |
| `.github/workflows/native-gui-helpers.yml`, Linux job | Existing executable `scripts/native-unix-window.py`: PID/start/image hash + XRes owner + same-PID AT-SPI window; `snapshot`, allowlisted native-dialog `click`, and normal `close`. Sealed backends use live parent/FD/seals identity, not a receipt alone. | Synthetic GTK fixture and kernel/helper primitives only; no real packaged-Hub migration/update driver. Helper normal-close receipts deliberately cannot claim a reaped successful exit. |
| `.github/workflows/unified-unix-candidate.yml` | Experimental native DEB/RPM/AppImage compilation and payload/container integrity. | Default read-only packaging, not signed writable migration acceptance. |
| `.github/workflows/unix-hosted-acceptance.yml` | Metadata/container prerequisite report from the read-only candidate lane. | Deliberately fails/blocks full acceptance; rejects Flatpak and is not the signed writable carrier consumer. |

The reusable GUI environment is the helper workflow's disposable local X11
session: Python GI/GTK3/AT-SPI, libX11/libXres, D-Bus, Xvfb and Openbox;
`CREATOR_UNIX_WINDOW_TEST=1`, `GDK_BACKEND=x11`, `NO_AT_BRIDGE=0`, private
`XDG_RUNTIME_DIR`, `dbus-run-session -- xvfb-run ...`. Never spoof GitHub runner
admission on the user's PC. Reuse only an explicitly owned session/window.

There is no complete current Linux equivalent of the Windows CDP smoke harness
in the inspected scripts. Main needs a current-payload launcher and bounded Hub
navigation/review driver, plus the existing native helper for dialogs. Current
native helper clicks are limited to the three existing hosted/routing dialogs;
Convergence and product/client review controls require separately reviewed
coverage. No global keyboard/mouse tool, unrestricted AT-SPI traversal, injected
consent or live-client auth is a substitute. Wayland is a separate test route.

Refresh rule after Rust changes: fixture tests rerun current JavaScript, not Rust
compilation. Changes in assembly `PRIVATE_SOURCE_PATHS` (MCP, Setup, router,
shared parent/retirement code, module archive/key) require fresh unsigned native
preparation and reviewed signing. Root-only Rust changes outside that set can
reuse proven equivalent private inputs but still require a fresh outer assembly,
Hub hash/embedded descriptor and actual GUI run. No preparation or assembly was
performed in this audit, and no current native bytes were relabeled.

## Required Acceptance Tests

Run only in an explicitly disposable native Linux/Flatpak account and owned
session; seed synthetic app/client/project fixtures, never real auth. Keep
immutable before-images and report failed cleanup separately from original failure.

| Gate | Smallest exact positive/negative evidence |
| --- | --- |
| Native current14 baseline | Bind source/tree/run/attempt, Hub hash, private input hashes/modes and signed descriptors. Exercise actual Hub terms, Convergence deferral, hosted decline/retry/status/recipe and parent-reaped normal closure. Component scope must report migration skipped, never full flow. |
| Flatpak ABI/resources | Build/export five-file recipe; retain resolved manifest, app/Platform/SDK commits and arch. Check ELF interpreter/NEEDED/symbol versions, real nonblank WebKit rendering, resource lookup and archive bytes/modes. Repacking alone does not pass. |
| No broker / foreign peer | Missing broker, wrong version/app/deployment, proxy/PID ambiguity, reused PID, changed bus owner, oversized/unknown method/field, replay/expired nonce and arbitrary path/argv/env must refuse without host writes or process launch. |
| No-consent retention | Preview, Later/Keep existing, cancel, read-only launch and failed admission leave exact host/sandbox settings, legacy registrations/desktop files, client entries, projects and active route unchanged, including absence. Run without broad home/host permissions. |
| Reviewed migration | Known exact legacy client entries in JSON/JSONC/TOML convert only after native review; preserve unrelated bytes/options/unknown fields. Current-vs-legacy product conflicts and custom server selection stay explicit. Concurrent standalone owner or changed before-image refuses. |
| Interrupted recovery | Interrupt each staged transaction boundary; inspect partial state and rederive destinations independently. Resume/rollback only exact recognized snapshots; substituted files, journal-selected paths, missing backup or changed namespace refuse. No phantom success. |
| Retained runtime | Existing connection continues on old signed host generation; new connection uses approved new generation. Close sandbox UI, replace/rollback Flatpak, then reconnect actual host stdio command and enumerate tools. Preserve unrelated Node/Unity/client processes; cleanup only exact owned children. |
| Portal / Setup | Explicit owned project grant works with real host and sandbox path identity; revoked/foreign/document-only aliases refuse. Host install/restart and project writes remain blocked until separate consent/dependency/closed-editor proof. |
| Flatpak lifecycle | Fresh install and native-legacy coexistence; update/cancel/rollback/uninstall preserve host runtime/settings/projects and sandbox state unless separately approved data deletion. Flatpak owns outer updates; native Tauri installer/update/removal commands must not operate on the sandbox deployment. |
| Real user workflow | Actual configured host AI connection and Unity workflow remain a separate authorized acceptance gate. Helper events, metadata receipts and SDK fixture connections do not manufacture that proof. |

## Local Verification And Next Step

Read-only source audit plus disposable fixtures on Windows, 2026-10-14:

| Command | Result | Scope |
| --- | --- | --- |
| `node --test scripts/unix-managed-payload.test.cjs` | 14 passed | Current `copy`/preparation branch, mocked compiler/tools, owned temporary files. |
| `node --test scripts/build-unified.test.cjs scripts/native-unix-hosted-acceptance.test.cjs` | 58 passed | Modes/bindings/refusals; synthetic package extraction and blocked receipts. |
| `node --test scripts/unix-package-payload.test.cjs` | 15 passed, 1 skipped | Payload/mode/package policy; Unix mode/link test skipped on Windows. |
| `python -B scripts/native-unix-window.test.py` | 36 passed, 2 skipped | Mocked owned-window/identity controls; Linux private receipt/kernel cases not run. |
| `python -B scripts/native-unix-window-fixture.test.py` | 8 passed | Pure driver regressions, no GTK/X11/proc/live-app reads. |

Smallest next action for main: refresh the appropriate source-bound native inputs
and outer Linux Hub, then capture the existing owned native GUI primitive against
that exact Hub/backend before designing a full guide lane. Flatpak remains
blocked on reviewed UI/broker admission, caller mapping, native host packaging,
runtime ABI, portal grant handling and actual sandbox migration/lifecycle tests.
This document does not authorize production changes or publication.
