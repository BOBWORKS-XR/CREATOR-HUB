# Native Hub Activation From Flatpak

## Scope And Status

This isolated implementation follows the approved simpler path: the Flatpak is
a launcher, and the actual integrated Hub window runs **outside the Flatpak
sandbox**, with native host XDG/settings and native MCP/Setup functions. It is
not the earlier sandboxed-GUI/native-Core relay and does not host old app pages.

**Source and portable tests only. Not release-ready or installed support.** Root
startup wiring exists behind `integrated-features` plus
`experimental-flatpak-host`. A signed native installer containing the service, a real Flatpak
launcher build, installed activation, host settings retention, signed DEB update,
automatic restart/reactivation and removal remain required acceptance gates.
The historical echo/kernel fixtures and their receipts remain unchanged.

This first profile is **Linux x86_64, native DEB installation only**. A compatible
graphical desktop, session D-Bus activation, GTK3/GIO, and the native Hub's
GTK/WebKit/polkit dependencies are required. The existing native updater only
approves DEB; AppImage and RPM updates remain manual and are not added here.
SteamOS/Steam Deck, RPM/AppImage host installation, 32-bit x86 and other native
installation layouts are unsupported or unverified by this path. A Flatpak file
alone is not a working universal Linux installation. The service itself adds no
systemd unit or polkit rule; this does not generalize Ubuntu test results to
other desktops or authentication agents.

The launcher foundation did not modify Root startup. The subsequent direct Hub
integration adds native service wiring and an explicit integrated DEB candidate
profile. Installed/published Windows bytes, website and existing test-only
package profiles remain unchanged.

## Launcher Contract

`native/flatpak-native-activation` builds two distinct executables:

- `creator-hub-flatpak-activate`: the only executable in the Flatpak payload.
  Displays the native-window disclosure, then sends exactly `Start()` to the
  fixed session service. It accepts no CLI path, command, environment mapping,
  version or settings arguments. There is no automatic retry. Its temporary GTK
  dialog closes before native activation. It reads/writes no host settings and
  stores no duplicate product configuration.
- `creator-hub-flatpak-check-native-input`: an offline build/review tool, **not
  installed in the Flatpak**. It verifies the exact-version Linux x86_64 DEB
  descriptor and installer with Root's compiled public release key. It verifies
  both Minisign signatures and signed package length/SHA256. Caller-supplied
  keys, trusted booleans, foreign formats and TEST ONLY assets are refused.

The service contract is tied to the actual parent-owned
`src-tauri/src/flatpak_bootstrap.rs` by the Node regression:

```text
Name:      com.creatorworks.hub.Host
Path:      /com/creatorworks/hub/Host
Interface: com.creatorworks.hub.Host1
Method:    Start() -> ()
Deadline:  15 seconds, no retry
```

A successful unit reply is an activation response, **not** publisher identity,
actual native window appearance, installation, migration or update acceptance.
No new command/event relay, inherited-FD GUI session, arbitrary host execution,
password provisioning or host-file grant is introduced.

The fixed **Get Native Hub** action opens only the current launcher's exact
GitHub release tag using `org.freedesktop.portal.OpenURI`. It does not download,
authenticate or install software and cannot report that native support exists.
It is never redirected to an unverified arbitrary/latest URL by runtime data.
Each native update still uses Hub's existing signed native updater; a compatible
`Host1.Start()` protocol need not require a second paired GUI binary update.

## Root Contract And Remaining Acceptance

1. Feature-gate the approved native activation flag `--flatpak-activate`. This
   starts the normal integrated Hub, **not** the experimental zero-window Core
   or the old module GUIs. Do not forward Flatpak environment/arguments to it.
2. Register the existing fixed GIO `serve` service for the normal native Hub
   instance. Keep its RAII `Service` alive for that instance's lifetime. `Start`
   shows/focuses that same first-party Hub window, using the existing
   single-instance path and busy/close/update checks. Existing normal native
   launches must also own the service so Flatpak cannot create a second Hub.
3. Include the following exact overlay in the native **DEB before normal signing**:

   ```text
   /usr/share/dbus-1/services/com.creatorworks.hub.Host.service
   root:root 0644; root:root 0755 ancestors

   [D-BUS Service]
   Name=com.creatorworks.hub.Host
   Exec=/usr/bin/creator-hub --flatpak-activate
   ```

   Session D-Bus activation runs it as the desktop user. No `User=root`, shell,
   system service, caller-selected path or privileged dispatch is permitted.
   Standard session-service directories are documented by the
   [D-Bus specification](https://dbus.freedesktop.org/doc/dbus-specification.html#message-bus-starting-services).
4. Preserve that service and native startup behavior in subsequent signed DEBs.
   Review native/Flatpak desktop IDs so two installations do not create confusing
   duplicate application-menu entries. This slice does not delete old entries.
5. Gate release on the actual integrated native pages, single visible window,
   repeat activation, migration, real operations, settings preservation, signed
   DEB update/restart and later Flatpak reactivation. Portable/echo passes do not
   replace these gates.

## Offline Packaging And Verification

The generator `scripts/flatpak-native-activation.cjs` takes a reviewed Linux
launcher ELF, its independently supplied source/tree/size/SHA256 pins and a new
stage directory. It creates a normal offline Flatpak-builder recipe, a five-file
launcher payload with the existing icon/license, a native DEB service overlay,
and a scope-limited stage receipt. It neither builds a new native installer
format nor installs/signs/publishes anything. There are no old launcher binaries,
module archives, MCP router, server runtime or user settings inside this payload.

The isolated recipe uses `app/com.creatorworks.hub/x86_64/native-activation-test`
and the existing GNOME50 candidate runtime, not a public/Flathub release claim.
Only these grants are requested:

```text
--socket=wayland
--socket=fallback-x11
--talk-name=com.creatorworks.hub.Host
```

There is no network, filesystem, full session/system bus, host-spawn, process,
device or IPC grant. Flatpak filters D-Bus and provides URI portals; a portal
does not silently confer installer privileges. See
[Flatpak permissions](https://docs.flatpak.org/en/latest/sandbox-permissions.html)
and the [OpenURI portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.OpenURI.html).

For an actual signed native installer, prepare an isolated input directory with:

```text
creator-hub-linux-x86_64-deb.json
creator-hub-linux-x86_64-deb.json.minisig
native-installer.deb
native-installer.minisig
```

The final name is the existing **plain** detached Minisign signature, not a new
signature or installer format. Verify it with the offline Rust checker. Then run
`scripts/flatpak-native-helper-package.py` on Linux with that exact DEB, version,
and the package/ELF hashes returned by the trusted-key checker. It uses the
unchanged strict package archive reader, inspects a private FD copy with
`dpkg-deb`, verifies native package identity and exact root/service bytes/modes,
and rejects extra D-Bus services, control scripts and system D-Bus policy grants.
It does not install, extract to live system paths, register a service, request a
password or itself authenticate caller-supplied digests. Both checks and original
producer/source/artifact binding are required; neither alone is installation.

**Missing installability piece:** the sandbox has no approved portal/API for
installing our arbitrary native DEB. The user must perform the one-time native
DEB install through the host's normal, separately verified distribution and
authorization flow. No matching signed native DEB with this feature and service
has been accepted here. Do not describe the button or stage as working support.

Removing the Flatpak removes only the launcher; it must not silently uninstall
native Hub or delete host settings. Native removal uses the normal DEB package
manager. Its preservation behavior still needs a disposable acceptance test.

## Local Checkpoint

Portable Rust tests, host strict Clippy, Node recipe/source tests and Python
in-memory package checks are available. Linux cross-Clippy currently stops in
the GTK/GIO sys build scripts because no Linux GTK sysroot/pkg-config is
configured. The local WSL image also lacks pkg-config. No stub, permission
relaxation, substitute success flag or native/CI dispatch was used to hide that.
Native GTK compilation is now dispatched in the dedicated, read-only
`linux-integrated-features.yml` workflow. Its result and installed Flatpak/DEB
operations must be recorded independently; no native acceptance is inferred from
the source wiring or the local cross-compile limitation.
