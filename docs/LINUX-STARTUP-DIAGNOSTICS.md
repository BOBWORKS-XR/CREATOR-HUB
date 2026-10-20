# Linux Startup Diagnostics

2026-10-15; inspected checkout `fa6268774c6dd0daa1f3aecb38cef96c8fde7f53`.
Bounded Linux/Flatpak sidecar only. No launch, installation, workflow dispatch,
commit, credential-file access, or product/startup change. Windows untouched;
macOS remains suspended. Existing unrelated work is preserved.

## Classification

| Finding | Classification | Evidence / limit |
| --- | --- | --- |
| `could not create default EGL display` | Confirmed fatal upstream path; local occurrence/root cause unknown | WebKit logs the capitalized form, including an EGL error suffix, immediately before `CRASH()`. Not an optional warning. |
| `failed to load module "window-decoration-gtk-module"` | Normally nonfatal module-load message; exact module identity unverified | GTK logs with `g_message()` and returns. KDE's documented-by-source library is **window-decorations** (plural), not the supplied singular name. Preserve the original line. |
| Blaming the module message for EGL failure | Likely wrong, not proven | The identified KDE module reloads Breeze decoration CSS; no causal link to the EGL initialization failure is established. |
| Existing Linux renderer/preload overrides | Unknown / needs capture | Source behavior is established below; benefit or harm on the affected machine is not. Leave unchanged. |
| No new renderer override, dependency installation, or package rebuild | Correct as-is for this investigation | No reproducible narrow Creator Hub source defect was established. |

## Local Evidence

- Case-insensitive search of tracked source/docs/scripts found neither quoted
  message. A second search of 1,687 selected loose Linux/Flatpak/AppImage text
  artifact files, including `.stderr`, `.stdout` and extensionless streams,
  found zero occurrences of either quote or the plural module variant. This
  excludes unopened archives, binaries and files outside the selected scope;
  it does not prove the reported failure never occurred.
- Native Root run `38639742819`,
  `artifacts/native-linux-root-38639742819/linux-root-probe/report.json`:
  recorded DEB `0.1.14`, assembly source `5bb05a2`, system WebKitGTK
  `2.50.4-0ubuntu0.22.04.1`, native terms acceptance, nonblank owned capture,
  normal Root exit 0, and complete empty stdout/stderr. Broad acceptance fields
  remain false. This is historical, scoped evidence, not a new native test.
- Flatpak run `38643675124`,
  `artifacts/flatpak-gui-capture-38643675124/gui-report.json`: product `7eb00ad`,
  one launch, owned window, normal-close reap/exit 0. Failure is
  `Rendered terms not proven by OCR`; render correctness remains unverified.
  Its complete 187-byte `hub.stderr` contains only an AT-SPI accessibility-bus
  `ServiceUnknown` warning. Rehashed SHA-256 matches the report:
  `ee59ba7f916d2461c5ac635c797bdab27de8ca44d45f0abb2e47881c42bb9364`.
- Native component run `38717024669`,
  `artifacts/native-linux-components-38717024669/linux-root-probe/components-report.json`:
  failure is a stale AT-SPI object during `mcp-operation`; Root exit is unknown.
  Do not relabel it as either quoted startup error.
- Newer component run `38744967551`,
  `artifacts/native-linux-components-38744967551/linux-root-probe/components-report.json`:
  immutable product `4f3744d`, nonblank owned window capture, same stale AT-SPI
  failure at `mcp-operation`, and zero-byte `root.stderr`. Neither quote is
  reproduced in this interval. `eof=false` and Root exit null mean this is not
  a complete clean-exit stream or complete component acceptance.

### Versions And Runtime Boundary

| Layer | Observed version / relationship |
| --- | --- |
| Current Root and Setup Cargo locks | Tauri `2.11.5`, Wry `0.55.1`, gtk binding `0.18.2`, webkit2gtk binding `2.0.2` |
| Current MCP launcher Cargo lock | Tauri `2.9.5`, Wry `0.53.5`, gtk binding `0.18.2`, webkit2gtk binding `2.0.1` |
| Captured native DEB renderer | `/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess`, distro package version above |
| Captured Flatpak ref | `app/com.creatorworks.hub/x86_64/flatpak-test`; GNOME Platform/SDK branch `50` |
| Captured Platform commit | `0bd5091046708e64bc882e8349877cfbae713f6a1e2d0487a5f10af820a2d792` |
| Captured Flatpak app commit | `32745d5e9f4d01e0c732272b3c02d5d9c11cb462677d5c52c2d0417192464d5c` |

Cargo binding versions are **not** installed GTK/WebKit/Mesa library versions.
The Flatpak metadata and `elf-needed.stdout` identify GTK3/WebKitGTK 4.1 ABI;
the package report resolves libraries under the sandbox's `/usr`, not proof of
the host DEB's native-library versions. Exact Flatpak WebKit/GTK/Mesa versions
and mounted GL-extension commits still need capture. GNOME branch `50` alone
does not identify those versions or prove an ABI/driver mismatch.

`src-tauri/src/main.rs:314-336` already sets
`WEBKIT_DISABLE_DMABUF_RENDERER=1` on Linux when absent, including Flatpak. It
also sets a Wayland-library `LD_PRELOAD` when `/etc/os-release` says SteamOS,
the named library exists, and no preload is set. `cdb6cff` introduced that
preload; the DMABUF default already existed. The source comment's AppImage
explanation is not runtime proof for DEB/Flatpak. The preload path is resolved
in the process's filesystem namespace, not necessarily the SteamOS host.

## Upstream Semantics

Primary sources checked on 2026-10-15:

- [WebKit current default display source](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/graphics/egl/PlatformDisplayDefault.cpp)
  and [matching 2.50.4 source](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebCore/platform/graphics/egl/PlatformDisplayDefault.cpp):
  default-display creation logs then crashes when `GLDisplay::create` fails.
  [GLDisplay 2.50.4](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebCore/platform/graphics/egl/GLDisplay.cpp)
  returns null for either `EGL_NO_DISPLAY` or failed `eglInitialize`. The quote
  alone does not distinguish these, the driver, or an X11/Wayland cause.
- [WebProcess 2.50.4](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebKit/WebProcess/glib/WebProcessGLib.cpp)
  tries eligible GBM, then surfaceless, then default display. A renderer crash
  can therefore be distinct from the GTK shell's exit; capture the emitter PID
  and full suffix rather than treating shell exit 0 as rendering proof.
  [DMABUF transport selection](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebKit/UIProcess/gtk/AcceleratedBackingStore.cpp)
  returns an empty transport mode for a nonzero disable setting. This does not
  guarantee that every later EGL use is avoided; adding a GPU-disable flag is
  not an evidence-based fix.
- [GTK3 module loader](https://github.com/GNOME/gtk/blob/gtk-3-24/gtk/gtkmodules.c)
  logs a failed load and continues, without an explicit abort on that branch.
  It can reflect absence, incompatible dependencies, or a missing init symbol,
  not just a missing package. [GTK running documentation](https://docs.gtk.org/gtk3/running.html)
  lists `GTK3_MODULES`, `GTK_MODULES`, `--gtk-module` and the `gtk-modules`
  setting as request sources. Empty `GTK_MODULES` would not rule out the others.
- [KDE module build](https://github.com/KDE/kde-gtk-config/blob/master/window-decorations-reload-module/CMakeLists.txt)
  names `libwindow-decorations-gtk-module`; its
  [implementation](https://github.com/KDE/kde-gtk-config/blob/master/window-decorations-reload-module/reloader.c)
  monitors decoration CSS and theme changes. Inference: an unavailable host
  desktop integration module can explain this optional message in a sandbox.
  Neither that origin nor the singular spelling is proven for the report.
- [Flatpak extensions](https://docs.flatpak.org/en/latest/extension.html)
  distinguishes mounted extensions recorded in `/.flatpak-info` from merely
  installed ones. [Command reference](https://docs.flatpak.org/en/latest/flatpak-command-reference.html)
  provides deployment/instance/GL-driver queries. `--gl-drivers` alone does not
  prove which GL library the failing process mapped.

## Smallest Next Capture

Not executed here. Use the affected Linux desktop, exact existing installation
and original launch method. Do not install anything or switch display backend,
runtime, GPU policy or sandbox permissions. No baseline is established for an
unidentified package. For the experimental per-user Flatpak only, after verifying
that this is the affected installed ref:

```bash
REF=app/com.creatorworks.hub/x86_64/flatpak-test
flatpak --version
flatpak info --user "$REF"
flatpak info --user --show-commit "$REF"
RUNTIME=$(flatpak info --user --show-runtime "$REF")
flatpak info --user --show-commit "$RUNTIME"
flatpak info --user --show-extensions "$RUNTIME"
flatpak --gl-drivers
printf 'session=%s desktop=%s gdk=%s\n' \
  "${XDG_SESSION_TYPE-unset}" "${XDG_CURRENT_DESKTOP-unset}" "${GDK_BACKEND-unset}"
umask 077
CAPTURE=$(mktemp -d /tmp/creator-linux-startup.XXXXXX)
date -u +%FT%TZ >"$CAPTURE/start.utc"
flatpak run --user "$REF" >"$CAPTURE/stdout.log" 2>"$CAPTURE/stderr.log"
STATUS=$?
printf '%s\n' "$STATUS" >"$CAPTURE/launcher-exit.txt"
printf 'Capture: %s\n' "$CAPTURE"
```

Use `--system` instead only if the selected app/runtime is system-installed;
app and runtime may have different installation scopes. Preserve query errors,
not a guessed version. Observe for 20 seconds, note normal/blank/no window and
the full message with suffix, then close normally if responsive. Do not approve
terms, migration or component operations. If hung, retain evidence and stop;
do not force-kill or keep replaying the same launch.

While that one launch is running, a second terminal can select its instance
from `flatpak ps --columns=instance,application,pid,child-pid,commit,runtime-commit`.
For only the exact Hub instance, `flatpak enter INSTANCE sh -c` can read selected
`app-commit`, `runtime-commit`, `app-extensions` and `runtime-extensions` keys of
`/.flatpak-info`. This proves mounted commits, not renderer success. Attribute
the emitter/renderer PID and selected GTK/WebKit/EGL/GL/Wayland entries from its
`/proc/PID/maps`; do not dump process environments, credentials or unrelated apps.
For native DEB, retain the actual executable path/hash and distro GTK/WebKit/Mesa
package versions instead of substituting Flatpak's runtime identity.

Only after reproducing an EGL failure with a Mesa-backed process, a separate
diagnostic-only launch may add `--env=EGL_LOG_LEVEL=debug` to `flatpak run`.
[Mesa documents this as log verbosity](https://docs.mesa3d.org/egl.html), not a
rendering fix. No persistent overrides, software-rendering flags, library copies,
preload additions, or sandbox disabling. Keep baseline and diagnostic logs separate.

Stop/go: full raw error, affected package/runtime identity and emitter mapping
come first. A minimal source change needs a matching source contract plus a
reproduction/regression demonstrating the defect; none is established here.

## AX Parent Contract Sidecar

2026-10-15, read-only source investigation of `38744967551`'s original
`own_tree:156` / `parent.get_role()` refusal. The parent task removed only the
parent PID/role diagnostic fields; this sidecar changes no guards or scripts.

- **Confirmed contract:** [libatspi PID documentation](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/method.Accessible.get_process_id.html)
  queries the application's bus connection, not the accessible object's path.
  Therefore `owner.node(parent)` succeeding does not contradict a later
  object-not-found error. The diagnostic removal proves neither object liveness
  nor containment success.
- **Confirmed mechanism:** WebKit 2.50.4's
  [object wrapper](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebCore/accessibility/atspi/AccessibilityObjectAtspi.cpp)
  exports stored `m_parent` through `parentReference()`, whereas `childAt()` and
  `children()` use the core object's current children. Parent assignment is
  [deferred from `parentObjectUnignored()`](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebCore/accessibility/atspi/AXObjectCacheAtspi.cpp).
  `cacheDestroyed()`/`elementDestroyed()` unregister wrappers; the
  [registry](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebCore/accessibility/atspi/AccessibilityAtspi.cpp)
  emits defunct/removal notifications and unregisters D-Bus object interfaces.
  These reads are not one atomic tree snapshot.
- **Relationship, not an escape allowance:**
  [core insertion](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebCore/accessibility/AccessibilityObject.cpp)
  flattens ignored children, and
  [semantic parent selection](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebCore/accessibility/AXCoreObject.cpp)
  skips ignored ancestors. Strict immediate reverse-edge equality is therefore
  not a universal contract. A local iframe's
  [scroll-view parent](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebCore/accessibility/AccessibilityScrollView.cpp)
  resolves through its frame-owner element; wrappers share the document's Page
  root. The [Page accessibility root](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebCore/accessibility/atspi/AccessibilityRootAtspi.cpp)
  exposes the main-frame root and its GTK embedding parent. No reviewed source
  establishes that an orphan/defunct iframe parent should be accepted outside
  the same bound Root frame.
- **Client boundary:** `helper.children()` actually uses child count plus indexed
  children, not a direct wire `GetChildren`. The
  [libatspi 2.44.1 implementation](https://github.com/GNOME/at-spi2-core/blob/AT_SPI2_CORE_2_44_1/atspi/atspi-accessible.c)
  can serve those calls and Parent from cache; clearing cache invalidates local
  cache flags, not producer object lifetime. This source tag/current API docs
  are contract references, not a newly measured runner-library version.

**Likely wrong upstream, not proven causal:** `AccessibilityAtspi::parentChanged`
for an object returns when `!m_clients.isEmpty()`, opposite its root overload,
child-change path and comment. This also appears in current main. It is a
concrete parent-notification asymmetry worth checking in the scoped event trace,
not proof of this failure: the harness already clears the child's cache before
reading Parent. Do not presume that disabling caching or upgrading fixes it.

**Narrow hypothesis, unproven:** an iframe-ancestor reference became unexported
while its renderer bus remained live; a traversal/Parent reference survived that
object lifetime boundary. This explains PID success plus GetRole failure without
inventing an extra window. It does not identify whether the stale reference came
from the producer's Parent reply or the client proxy/cache.

**Exact next evidence, no input or policy relaxation:** during one otherwise
authorized unchanged run, record bounded ordered metadata for the original child
`C`, enumerating parent `E`, and semantic parent `P`: canonical unique bus/path,
the original Parent request/reply/error, and whether child enumeration used cached
or actual `ChildCount`/`GetChildAtIndex` replies. Before the embedded transition,
subscribe only to the bound renderer's `defunct`, `RemoveAccessible`, parent-change
and child-reference events; retain refs/order, not text/content. A separately
labelled diagnostic wire read of `C.Parent` and bounded `E.GetChildren` can compare
producer replies with libatspi results, but must not retry an action or replace
the original refusal. Record the actual libatspi package/mapped image version.

Removal of `P` between its return and the failing call supports a lifetime
transition. A cached `P` differing from the wire reply localizes client staleness.
A wire-returned unexported `P`, without an intervening removal in a complete
scoped capture, supports a producer inconsistency. A live, stable `P` absent from
the collected frame requires new topology evidence, not an automatic exception.
No capture or native test was run by this sidecar.

### Run 38745733761: Three Missing Parents

Read `artifacts/native-linux-components-38745733761/linux-root-probe/mcp-ready-tree-refusal.json`:
31 collected refs, 30 Parent checks, three missing semantic-parent refs; neither
ref list is truncated. All three nodes, their enumerating parents and their
missing parents use the bound renderer bus `:1.4`; node PID is `3399`. This proves
the membership mismatch in the collected frame, not foreign ownership, parent
liveness or a complete atomic producer-tree snapshot.

- Role `49`, depth 9: `19ae6205...` -> missing `88a8e700...`, enumerated by
  `c622d382...`.
- Role `33`, depth 11: `b3f1b87d...` -> missing `1e392cd0...`, enumerated by
  `28057268...`.
- Role `33`, depth 11: `c4f3a28b...` -> missing `841d9ace...`, same enumerator.

**Confirmed mapping correction:** the
[WebKit 2.50.4 enum](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebCore/accessibility/atspi/AccessibilityAtspiEnums.h)
and [libatspi enum](https://github.com/GNOME/at-spi2-core/blob/AT_SPI2_CORE_2_44_1/atspi/atspi-constants.h)
both define `49=ScrollPane`, `33=Menu`. The missing-Footer divergence starts at
72; do not apply a global `+1`. WebKit maps both ScrollArea/TabPanel to 49 and
Menu/MenuListPopup to 33, so these numbers alone cannot identify DOM elements.

**Ignored-parent hypothesis remains unproven:** core insertion can flatten an
ignored container, but semantic parent assignment already uses
`parentObjectUnignored()`. Plain flattening does not establish that the exported
Parent should still name the omitted container. A retained wrapper Parent and a
new core child list remain a plausible mismatch, not a sanctioned escape rule.
[Menu-list construction](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebCore/accessibility/AccessibilityMenuList.cpp)
creates one synthetic popup per menu-list owner;
[popup inclusion](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebCore/accessibility/AccessibilityMenuListPopup.cpp)
separates `isVisible()` (always false) from `computeIsIgnored()`. Thus hidden,
collapsed or not-showing is not proof of accessibility-ignored ancestry.

**Smallest distinguishing capture:** after retaining the original refusal, a
separate diagnostic may query only those three `P` endpoints, under unchanged
bus/process binding: remote role or exact error, allowlisted `tag/computed-role/
toolkit`, Parent ref, and bounded child refs. Compare each with its already
recorded `C` and `E`; obtain the same metadata for `C/E` only as needed. Do not
query names/text, traverse unknown ancestors, act, or treat the probe as authority.
An unexported `P` supports the lifetime hypothesis; a live select/ComboBox owner
with its Menu child narrows the popup hypothesis. Ignoredness still needs matched
producer evidence or a minimal pinned reproduction, not inference from visibility.
Containment continues to refuse; no guards or diagnostic scripts changed here.
