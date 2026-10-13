# Creator Hub 0.1.13 Flatpak Experiment

Status: **experimental, not release-ready or a supported product package**.
This is a bounded x86_64 packaging path for the maintenance release, not the
deferred 0.1.14+ unification work. The generator changes no application code,
updater feeds or existing native installers. The maintenance updater separately
detects Flatpak and directs users to their Software app/Flatpak without invoking
the native DEB/RPM updater; CI explicitly provisions the verifier's Python version.
It does not claim
32-bit support. The base checkout is public v0.1.12,
`35a16a45814d821d65b5d203628478449174cd55`.

## Generator Contract

On a disposable Linux x86_64 packaging machine with **already available** Node,
`dpkg-deb` and Python 3.11+:

```sh
node scripts/flatpak-package.cjs \
  --deb /absolute/reviewed/Creator-Hub-0.1.13-amd64.deb \
  --sha256 EXACT_REVIEWED_LOWERCASE_SHA256 \
  --output /absolute/existing-parent/new-013-flatpak-input
```

The SHA argument is mandatory; obtain it from the exact separately approved
native artifact, not a filename, mutable download or this document. Hash matching
binds the supplied bytes, but is not publisher authentication or release approval.
No approved native 0.1.13 DEB/hash was supplied for this implementation. Candidate
generation stops at that missing input; tests use explicitly synthetic fixtures.
Do not rename/relabel v0.1.12 bytes as v0.1.13 or promote a fixture.

- Takes one bounded native DEB snapshot (maximum 256 MiB) and gives that same
  hashed buffer to every parser. Input names and archive compression are not
  architecture or product evidence.
- Uses `dpkg-deb --show --showformat` for Package/Version/Architecture: exactly
  `creator-hub`, `0.1.13`, `amd64`. Uses `--fsys-tarfile` for decompression; never
  installs the DEB or executes its maintainer scripts or executable.
- Python's standard `tarfile` and `configparser` parse the archive and native
  desktop entry. Checks exact Creator Hub name, command and icon contracts and
  ELF64/little-endian/EM_X86_64 executable headers. Bundled ELF resources are
  architecture-checked too. These checks do not establish runtime ABI compatibility.
- Preserves actual main executable, resource and documentation bytes and Unix
  permission modes in `payload.tar`. Executable resource modes are not flattened
  to 0644. Relocates `usr/bin` to `bin`, `usr/lib/Creator Hub` to
  `lib/Creator Hub`, and native documentation/icons under `share`. Only icon
  names and desktop/AppStream metadata are changed for Flatpak export.
- Refuses unsafe/duplicate paths, link/hardlink/device/FIFO/sparse entries,
  special permission bits, unexpected native layout, missing icons, mismatched
  identity, other architectures and stale output. Such inputs need a reviewed
  new contract; the generator does not silently omit or repair them.
- Keeps the exact `native.deb` for provenance and emits the JSON manifest,
  desktop entry, AppStream metainfo, inventory, byte/mode verifier and completion
  receipt. All builder sources have SHA256 pins. Deterministic repacking
  normalizes container owner/timestamps, not payload bytes/modes.
- Output parent must exist. The output directory must **not** exist, even empty.
  Files are created exclusively/read-only and the completion receipt is written
  last. Failures leave inspectable incomplete output; reruns cannot overwrite it.
  This is a write-once tool contract, not an OS immutable-bit/security guarantee.

Tauri CLI 2.11.4's [DEB source](https://github.com/tauri-apps/tauri/blob/8909f221d1515955fc843808032bdc5d62209c96/crates/tauri-bundler/src/bundle/linux/debian.rs)
and [desktop generator](https://github.com/tauri-apps/tauri/blob/8909f221d1515955fc843808032bdc5d62209c96/crates/tauri-bundler/src/bundle/linux/freedesktop/mod.rs)
establish these native paths/identity contracts. The pinned Tauri 2.11.5
[resource resolver](https://github.com/tauri-apps/tauri/blob/tauri-v2.11.5/crates/tauri-utils/src/platform.rs)
checks `../lib/<product name>` relative to the executable before falling back to
`/usr/lib`. Thus `/app/bin/creator-hub` and `/app/lib/Creator Hub` preserve this
layout without a wrapper or runtime environment override. Real resource use is
still an acceptance gate. See also [dpkg-deb's documented parser interfaces](https://manpages.debian.org/bookworm/dpkg/dpkg-deb.1.en.html).

## Runtime Evidence

Checked 2026-10-13 using primary GNOME/Flatpak/Tauri sources:

- The GNOME release team [states that GNOME 50 is supported until GNOME 52,
  planned April 2027](https://discourse.gnome.org/t/upcoming-gnome-51-flatpak-runtime-will-drop-gcr-3-and-libhandy/35111).
  Recheck support/EOL before each experiment; this dated evidence is not an
  indefinite runtime-support promise.
- The official GNOME mirror's `gnome-50` head was
  `1d48484bef19ae411601285fcc1faa19290be397`. Its
  [platform filesystem](https://github.com/GNOME/gnome-build-meta/blob/1d48484bef19ae411601285fcc1faa19290be397/elements/flatpak/platform/filesystem.bst)
  includes [sdk-platform.bst](https://github.com/GNOME/gnome-build-meta/blob/1d48484bef19ae411601285fcc1faa19290be397/elements/sdk-platform.bst),
  which explicitly includes `sdk/webkit2gtk-4.1.bst`, not only WebKitGTK 6.0.
  That [4.1 recipe](https://github.com/GNOME/gnome-build-meta/blob/1d48484bef19ae411601285fcc1faa19290be397/elements/sdk/webkit2gtk-4.1.bst)
  builds GTK3/libsoup3 (`USE_GTK4=OFF`) and names the 4.1 libraries. Runtime
  composition excludes development files, not those runtime libraries. The
  [platform image](https://github.com/GNOME/gnome-build-meta/blob/1d48484bef19ae411601285fcc1faa19290be397/elements/flatpak/platform/platform.bst)
  identifies `org.gnome.Platform`; the
  [runtime export](https://github.com/GNOME/gnome-build-meta/blob/1d48484bef19ae411601285fcc1faa19290be397/elements/flatpak/runtimes-repo.bst)
  includes x86_64. This verifies the supported runtime's **source composition**.
- [Tauri's current prerequisites](https://v2.tauri.app/start/prerequisites/)
  require WebKitGTK 4.1. Its [Flatpak example](https://v2.tauri.app/distribute/flatpak/)
  still shows runtime 47; that example alone is not current support evidence.
- Live HTTPS remote metadata for
  `runtime/org.gnome.Platform/x86_64/50` resolved to commit
  `0bd5091046708e64bc882e8349877cfbae713f6a1e2d0487a5f10af820a2d792`,
  subject `Build of the GNOME Runtime from: 50.5-1-g1d48484be`. Its ref binding
  and Runtime metadata match x86_64/50 and it has no EOL/rebase marker. Six
  content-addressed commit/dirtree objects were fetched over verified HTTPS into
  memory and checked by SHA256, then parsed with GLib's structured GVariant
  parser using the [OSTree schemas](https://github.com/ostreedev/ostree/blob/main/src/libostree/ostree-core.h).
  The runtime tree lists `libwebkit2gtk-4.1.so.0`/`.0.24.4` and
  `libjavascriptcoregtk-4.1.so.0`/`.0.11.8` in `/usr/lib/x86_64-linux-gnu`.
  This is **remote native runtime-content metadata evidence**, not just a sample
  or source recipe. Exact URLs/checksums and limitations are saved in
  [runtime-50-evidence.json](../packaging/flatpak/runtime-50-evidence.json) and copied
  into generated output. No library payload, runtime or SDK was installed; GPG
  signatures were not verified in this metadata-only check. It is not an
  authenticated Flatpak installation/update acceptance or ABI execution test.
- No installed GNOME 50 sandbox was inspected or launched. The existing WSL
  environment has no Flathub remote and lists only aarch64 Freedesktop runtimes;
  it is not x86_64 GNOME acceptance evidence. No remotes, SDKs or packages were
  installed. The receipt explicitly records `contentsVerifiedInSandbox: false`.

Before building, inspect the **actual already installed** x86_64 runtime's EOL,
commit and contents, as recommended by [Flatpak's runtime documentation](https://docs.flatpak.org/en/latest/available-runtimes.html):

```sh
flatpak info org.gnome.Platform/x86_64/50
flatpak run --command=cat org.gnome.Platform/x86_64/50 /usr/manifest.json
flatpak run --command=sh org.gnome.Platform/x86_64/50 -c \
  'find /usr/lib -name "libwebkit2gtk-4.1.so*" -o -name "libjavascriptcoregtk-4.1.so*"'
```

Archive the runtime commit, manifest and library findings. Stop on EOL or missing
4.1 libraries. Matching names alone do not establish the native DEB's complete
GLIBC/OpenSSL/WebKit/other shared-library ABI; check dependencies/symbol versions
inside the exact runtime and capture real startup. Do not bundle guessed host
libraries or disable WebKit's sandbox/TLS to make startup appear to work.

## Sandbox And Product Blockers

The following source findings describe the verified v0.1.12 baseline. Concurrent
maintenance updater edits appeared during this task and were not changed or
accepted by this packaging work; re-audit the exact candidate before packaging.
Those edits do not by themselves establish a Flatpak update contract.
The main maintenance lane has since added a `FLATPAK_ID`/`/.flatpak-info` native
updater refusal in `update_target.rs` and a Flatpak-managed UI state in
`self_update.rs`/`src/app.js`. This is source evidence of a guard, not proof of an
installed Flatpak update channel. It was not edited in this scope.

The [Flatpak sandbox contract](https://docs.flatpak.org/en/latest/sandbox-permissions.html)
isolates host files/processes and redirects XDG config/data/cache locations. The
manifest grants only Wayland, fallback X11/IPC, DRI rendering and network access.
Network is needed for the existing HTTPS catalogue/downloads and hosted loopback
traffic; it also exposes host network services, so it is not a private network.
There is no blanket host/home filesystem access, whole session/system bus,
host-spawn permission, signature/TLS bypass, tray grant or speculative workaround.
Portal D-Bus access is already allowed by Flatpak's default filter.

| Classification | Concrete product boundary at this checkout | Missing proof/contract |
| --- | --- | --- |
| Confirmed unsupported | `projects.rs:cli` permits only Windows x64, calls the hash-pinned `unity.exe` helper; `editor_from` expects `Unity.exe`; `open_unity_project` depends on both. Linux Unity discovery/launch cannot be enabled by a manifest permission. | Accepted Linux editor/helper identity and a consented host launch route with arguments and true outcome. No packaging-only fix. |
| Confirmed contract mismatch | `platform.rs:command`, `manager.rs:open`, `hosted.rs:start` directly spawn executable paths. `/usr` is the runtime and `/app` is this package, not the host. A visible host file is not a compatible sandbox executable. Companions are separate native apps with their own resources/dependencies. | Accepted companion hashes/paths plus explicit same-sandbox vs host/broker deployment, inherited environment and lifecycle protocol. No implicit `flatpak-spawn --host` wrapper. |
| Confirmed namespace mismatch | `platform.rs:running` uses process enumeration/executable ownership; Flatpak has no default access to host processes. `hosted.rs` checks running copies and retains verified backend authority. | Host-aware process identity/busy/cancellation/close ownership; must preserve unrelated clients. Filesystem access or successful spawn is not proof. |
| Confirmed storage divergence | `manager.rs:root` and `projects.rs:saved_path` use `dirs::data_local_dir()/CreatorHub`; discovery uses `dirs::config_dir()`. These resolve under `~/.var/app/com.creatorworks.hub`, not existing native settings. Persisted host project/adopted executable paths may be unavailable or have different portal names. | Explicit reviewed native-to-Flatpak preference/project migration and rollback, no silent takeover or link bypass. |
| Unknown / needs capture | Unity projects, package manifests, `file:` SDK paths and the `.creator-plugins` queue/receipt/backups in `community_project.rs` must resolve identically for host Unity and sandbox Hub. Document-portal paths can differ; code rejects symbolic links. | Persistent directory grant/path mapping with actual host Unity queue/review/import/receipt and lock/backup preservation. No automatic home grant. |
| Unknown / needs primary contract | AI-client settings are owned by the external MCP companion/client, not this packaging generator. A command such as `/app/...` emitted by a sandbox process is not host AI-client executable authority. A stdio client launch and Hub's hosted pipe protocol are distinct. | Each intended host AI client's config namespace, approved executable/stdio route, safe write ownership and reconnect behavior, including an externally launched installed companion. Do not transplant deferred unification contracts. |
| Correct refusal; missing Flatpak route | `platform.rs:managed_installs_supported` is Windows x64 only; `self_update.rs` expects NSIS/`.exe`/Windows install identity. Flatpak `/app` is read-only. Signed native updater feeds are not a Flatpak update channel. | Reviewed signed OSTree remote/channel, old experiment-to-new update, cancellation/restart/data preservation and supported UI routing. No new update feed or signature bypass in this change. |
| Unknown / needs capture | `main.rs:open_resource` and `community.rs` use `xdg-open`; Linux WebKit setup has a SteamOS/AppImage-specific preload check. Portal availability and sandbox `/etc/os-release` differ from the host. | Actual portal file chooser/URL opening, display/render/resource tests on the intended host. No claim from a successful shell launch. |

These are product blockers, not permission tuning suggestions. Several originate
in the native Linux product already; sandboxing adds further boundaries. A GUI
that only displays the catalogue is not a supported replacement for the Hub.
Application/companion/client/updater changes are outside this disjoint write
scope and deliberately stopped pending their primary contracts.

## Build And Acceptance Gates

The generator emits `com.creatorworks.hub.json`; there is no unpinned placeholder
release manifest. With the SDK/runtime/tools already provisioned on a disposable
machine, the separate, explicitly authorized build step would be:

```sh
flatpak-builder --arch=x86_64 --disable-download --repo=/absolute/new-repo \
  --state-dir=/absolute/new-builder-state \
  /absolute/new-build /absolute/new-013-flatpak-input/com.creatorworks.hub.json
```

No `--install-deps-from`, forced cleaning, CI dispatch, install/export/publication
or SDK provisioning is performed by the generator. Module sources are local and
hash-pinned. Architecture guard and source restrictions fail other architectures.
[Builder options](https://docs.flatpak.org/en/latest/flatpak-builder-command-reference.html)
set `strip: false` and `no-debuginfo: true` so cleanup does not mutate ELF bytes.
The build verifies installed native file bytes/modes; compare the final exported
deployment against `inventory.json` too, since build-time verification is not
post-export proof. AppStream/desktop validators and final permission inspection
remain gates. Metadata is experimental, not a reviewed Flathub submission.

1. Supply the exact approved native 0.1.13 DEB/SHA; verify the actual supported
   x86_64 GNOME 50 deployment and all native ABI dependencies.
2. Build and validate manifest/desktop/AppStream; verify exported and installed
   executable/resources hashes and modes, architecture and effective permissions.
3. Real sandbox fresh install, menu launch and GUI on Wayland and fallback X11;
   exercise rendering, resource use, native dialogs, URL/file portals and HTTPS.
4. Resolve and test every host integration above against actual Unity, companions
   and AI clients, with cancellation/busy handling and protected state preserved.
5. Prove an approved signed Flatpak update/restart route, previous-experiment data
   preservation and native-install coexistence. Native Windows acceptance is not
   this gate. No publication is authorized by any successful local test.

Only then can supported-product readiness be reconsidered. Every generated
receipt remains `releaseReady: false`; it cannot self-promote after a build.

## Tests And Scope

```sh
node --test scripts/flatpak-package.test.cjs
```

The tests use Python's actual parsers and synthetic native archive/ELF fixtures,
including executable resources, binary data, non-default modes and renamed input
files. Fixtures/output are confined to disposable directories in
`packaging/flatpak`, cleaned after testing. The real dpkg parser test runs on
Linux; on Windows it is opt-in using `FLATPAK_TEST_WSL_DISTRO` naming an existing
WSL distro. It provisions nothing and does not install or run the fixture.
`FLATPAK_TEST_VALIDATE=1` additionally uses already-installed `flatpak-builder
--show-manifest`, `desktop-file-validate` and `appstreamcli validate --no-net`.
The parser's state is confined to the disposable fixture directory.
Windows archive tests preserve Unix modes in tar headers; they do not prove
Linux installed filesystem modes or GUI/product behavior.

Verified 2026-10-13: **32 focused tests passed, zero skipped**, with
`FLATPAK_TEST_WSL_DISTRO=AndroidXR-Build` and `FLATPAK_TEST_VALIDATE=1`.
This includes actual WSL `dpkg-deb` parsing of a synthetic DEB, Flatpak manifest
parsing, desktop validation and offline AppStream validation. AppStream retains
one informational content-rating advisory; no rating was invented. Initial WSL
shell-format and undated AppStream-release failures were preserved in the task
output, corrected and rerun. Existing WSL systemd-session and Windows-worktree
Git-path warnings remain non-blocking diagnostic output; they were not repaired.
Node syntax and scoped whitespace checks passed. Root `.flatpak-builder` was
attributed to the first manifest-parser invocation (only a 15-byte ccache config
and empty ancestor directories), rechecked and removed; subsequent parser state
stayed under owned fixture scratch. Both scratch locations were verified absent.
There was no native candidate execution, Flatpak build/install or GUI test.

Writes are confined to `scripts/flatpak-package.cjs`, its test,
`packaging/flatpak/*` and this document. There are no commits, pushes, published
artifacts, CI dispatches, live-app changes, host SDK installs or edits to the
separate unification checkout.
