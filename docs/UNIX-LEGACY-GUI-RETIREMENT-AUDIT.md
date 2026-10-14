# Unix Legacy GUI Retirement Audit

2026-10-14, bounded independent audit for unified 0.1.14. No Root integration,
installed-app change, legacy execution, package removal, commit or release.

## Decision

**No Unix production retirement mutator is justified by the current evidence.**
The missing contracts are native idle/close detection, reviewed filesystem
mutation/registration behavior, and preservation of execution at the original
paths. `native/legacy-retirement-unix.rs` was intentionally not added.

This advances package provenance beyond the previous server-only proof: all ten
public MCP 2.7.7 / Setup 0.3.7 Unix packages have independently checked package
sizes/digests and measured GUI/metadata/runtime member pins. These are evidence,
not native install/update/retirement acceptance or publisher authentication.

The portable checks exercise the evidence format and prevent collapsing distinct
package pins. They do not execute an old GUI or runtime and cannot lift a release
gate. Root's explicit non-Windows retirement refusal must remain.

## Evidence Captured

Primary public releases and current unauthenticated asset metadata:

- [MCP 2.7.7](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases/tag/v2.7.7),
  release `402569194`, target `9cd12e28d1dd05057b84166d4718a5d6369eff93`.
- [Setup 0.3.7](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/releases/tag/v0.3.7),
  release `402568854`, target `4a76945272560f9e0d2b93296a5223bf3e891eb2`.

Each product publishes Intel/ARM Mac DMGs and x64 Linux DEB/RPM/AppImage. This
audit covers those ten packages, not other versions, distro rebuilds or Flatpak
commits. MCP's separate Node ZIP is not a GUI installation or a retirement target.

[Exact package and member pins](evidence/legacy-unix-public-package-pins-014.json)
contain all package URLs, bytes and SHA-256 values plus 79 selected member records.
Both complete Mac app bundles were captured for each product/architecture:
13 files per MCP app (including all nine server resources), four per Setup app.
The two DEB control archives contain only `control` and `md5sums`, no removal or
retention script. RPM payloads were inspected, **not RPM scriptlets**; no claim
about their removal hooks is made.

Raw release metadata, archive listings, control text, extracted selected files,
and the passive capture helper are retained at:

`C:\Users\bobman\AppData\Local\Temp\creator-hub-unix-retirement-014-20261014`

The original server-only proof and packages were read, not altered:

`C:\Users\bobman\AppData\Local\Temp\creator-hub-unix277-audit\PROOF.md`

Extraction used installed 7-Zip 26.00 on Windows. No downloaded executable,
AppImage, script, server or installer was run; no Mac DMG was natively mounted.
Initial helper failures (7-Zip's automatic RPM/gzip traversal, then Windows
symlink-creation refusal) were corrected in the capture helper, not product code.
AppImage link contents are now recorded without creating Windows symlinks.

### Distinct Native Payloads

| Product / Package | GUI Bytes | GUI SHA-256 |
| --- | ---: | --- |
| MCP DEB/RPM | 20525304 | `6cc50ba3c770c1774512a99dc24d514f4350f51d03fd27bb4259ec16249c2ab2` |
| MCP AppImage | 20562081 | `32ffc9172ed630dc5d18e205bc0e6d7a1ff27bb9865714d4c630ee998c54a343` |
| MCP Mac ARM | 17051392 | `2e7f6aaa4594287fb147862d851017de5f79a6a90a6e41133f336c23eca00c66` |
| MCP Mac Intel | 17667936 | `cb0390af593cf85306b76688f83427d8a744a5094b99c5f673248ed72005fbca` |
| Setup DEB | 20899824 | `f9c3a25c062b68cafed0c46b762532bed72127635015587324119a02d63b2944` |
| Setup RPM | 20899824 | `56e0bc61cbadba67c991b4c65521c8af9da096723838c85de187aa71741394d1` |
| Setup AppImage | 20918864 | `556aafb0e8e4d227c7cdd985d43a245133029a93c3651d90131a07c738e3c825` |
| Setup Mac ARM | 14354064 | `2d460179cfbfc184f2cd8427fa6fdd31c25a2930f3738e534c2f7c5a37bc6a4e` |
| Setup Mac Intel | 14745072 | `f76b2d94dcb1984695c847bc02b461e32da493161a3ad946808312795b411fe9` |

The same-size Setup DEB/RPM GUIs are different bytes. Their cause was not
diagnosed here; neither a version nor a size check can replace a package pin.
MCP's AppImage Node differs from DEB/RPM Node too:

- DEB/RPM: 123459976 bytes, `62d66443847de1f527f74afe715900b12884ace52136dc9cd8e91e61acc2f527`.
- AppImage: 123468168 bytes, `0d950b73272dae118ac74590791e3c64eefc2e5c9565cd51bc7fa93abbf9d516`.
- Mac ARM: 120591840 bytes, `f5f9b9db4d95f5e0340982685f083de654c21eef9d9122cab5321081ccaa2601`.
- Mac Intel: 122917328 bytes, `bd6cd97b046bd816399fea7893bcf6867e9ec55fd02aef3284875dd32b31e060`.

In each package `runtime/node.exe` is a second native payload with the same
bytes/hash as `runtime/node`. Both original names must stay, even on Unix.
All five Unix `.mjs` files remain 1221209 bytes and
`8d7cbe21d3b3691d6b1aa052846d6ee36f4274c18bd4228c6d4a73583be74149`.

## Source And Original Paths

Checked the retained public-tag commits, not inferred from current private code:

- [MCP launcher source](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/blob/v2.7.7/launcher/src-tauri/src/main.rs):
  `get_persistent_server_dir`, `sync_ephemeral_bundle`, `resolve_mcp_root`,
  `resolve_node_command` and `config_path_for` establish the contracts below.
- [MCP lifecycle](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/blob/v2.7.7/launcher/src-tauri/src/lifecycle.rs):
  close requests refuse active commands/workflows; externally published busy
  window properties are Windows-only. `gui_owner` is Windows-only in this tag.
- [Setup bootstrap](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/blob/v0.3.7/src-tauri/src/bootstrap.rs):
  editor roots and logs are in `dirs::data_local_dir()/CreatorProjectSetup`, not
  the app bundle. Project receipts/logs remain inside the user's project.
- Current Root `convergence.rs::legacy_apps` enumerates `/Applications` and
  native-home `Applications` Mac apps, `/usr/bin` Linux GUIs, and
  `platform::default_exe`'s local-data fallback. This is presence detection,
  **not installed provenance, ownership, full discovery or removal authority**.

Exact package layouts:

| Format | GUI / Registration | Original MCP Runtime |
| --- | --- | --- |
| Mac DMG copy | `<base>/Creator Works MCP.app/Contents/MacOS/creator-works-mcp-launcher`; analogous Setup app | Same app's `Contents/Resources/server` |
| DEB/RPM | `/usr/bin/creator-works-mcp-launcher`, `/usr/bin/creator-project-setup`; respective `/usr/share/applications/<Product>.desktop` | `/usr/lib/Creator Works MCP/server` |
| MCP AppImage | Arbitrary image path; internal `AppRun`, `AppRun.wrapped`, `usr/bin/creator-works-mcp-launcher` | Image's `usr/lib/Creator Works MCP/server`, exposed at its mount/extraction path |

The launcher returns ordinary packaged resource roots directly. Only roots
classified as ephemeral trigger copying into native local-data
`creator-works-mcp/server`, with a `banter-mcp.mjs` alias. It also mirrors into
an **already existing** `bantworks-mcp/server`; fallback discovery additionally
recognizes `banter-mcp/server`. Environment-provided roots and custom saved server
paths exist in the source contract and cannot be overwritten by retirement.

Preserve all original package/cache/alias/custom roots, not just the selected
project or a route found in known client configs. A free current Unix advisory
GUI lock does not prove the published Unix 2.7.7 GUI is closed: it lacks that
lock. Node connections must not be stopped to infer GUI idleness.

Persistent stores are separate: native-config `creator-works-mcp` and `banter-mcp`
launcher settings, native-local-data `CreatorProjectSetup`, Hub preferences,
before-images/recovery journals, client configs and Unity projects remain intact.
Resolve native directories on the target OS; do not hard-code Windows/XDG defaults
or read a configured path to manufacture a trusted retirement destination.

## Findings And Smallest Scope

| Classification | Scope / Finding | Consequence |
| --- | --- | --- |
| Correct as-is | Windows GUI-only retirement; all original server resources retained | Reuse its approval/backup/journal policy, not its destructive uninstaller |
| Correct as-is | Root's non-Windows retirement refusal | Keep until native contracts and packaged acceptance exist |
| Confirmed broken for required retention | Moving/deleting the complete MCP Mac app | Removes original `Contents/Resources/server` paths even if a cache exists |
| Unknown / needs capture | Pinned per-user Mac `~/Applications` GUI-only file retirement | Smallest structural MCP candidate, **not an accepted implementation** |
| Unknown / needs capture | Pinned per-user Mac Setup whole-bundle archival | Contains no bundled Node/server; simplest first native control case |
| Unknown / needs capture | Mac signature/registration behavior after MCP main-executable archival | Preserve every resource and do not re-sign or alter quarantine to make a test pass |
| Confirmed incompatible with bounded per-user cleanup | DEB/RPM GUI and runtime are in root-owned package paths | No direct system-file moves, package DB edits or whole-package removal |
| Confirmed incompatible with arbitrary-client retention | Deleting/disabling MCP's entire AppImage | Removes the image needed to expose its old runtime; cached clients are not every client |
| Unknown / needs capture | Arbitrary/custom AppImage install/integration paths | No source-established finite on-disk image destination or external desktop registration |

There is therefore **no accepted production Unix OS/path scope today**. A future
first leaf should be native-home `Applications` only, current-user-owned ordinary
paths, exact architecture/product/bundle pins, no extra files or duplicate/system
installs, no symlinks/hardlinks, closed verified GUIs and fresh native approval.
Do not admit `/Applications` merely because it happens to be writable.

For MCP, only the pinned main GUI executable can be considered for archival;
the bundle directory and every original resource path stay. For Setup, its exact
four-file bundle is the separate simpler candidate. Native registration removal
must be established; hiding an icon, changing a label, or only unregistering an
otherwise runnable GUI is not complete GUI retirement.

The Mac packages include sealed `CodeResources`; both Node aliases are recorded
as resources. Apple's [code-signing contract](https://developer.apple.com/library/archive/technotes/tn2206/_index.html)
requires treating signed bundles as immutable and distinguishes bundle validation
from single-file executable validation. **Inference:** hollowing MCP's app may
affect retained Node launch/registration policy. Actual behavior is unknown and
must be measured without bypassing signing/quarantine checks.

DEB/RPM need an explicitly designed replacement/compatibility package transaction
that retains the exact original server paths and normal package ownership while
retiring GUI entries. Neither copied caches nor remove-then-restore are adequate.
No such transaction was implemented or run. RPM scriptlets remain uninspected.

Flatpak ownership stays with its assigned task. These ten release packages cannot
prove a Flatpak commit, permission model, host-path visibility or data retention.
Do not repurpose this pin set as Flatpak removal authority.

Unknown versions, old BANTWORKS GUI names, arbitrary copies, extra/changed members,
managed installs, redirected roots, unsupported architectures, package ownership
ambiguity or unresolved custom GUI integrations must refuse automated retirement.

## Next Native Capture

Use fresh disposable Mac Intel and ARM runners; no user's app or home data. Start
with Setup, then independently test MCP. The following are acceptance requirements,
not commands already executed or an authorization to clean a real installation.

1. Verify the exact DMG size/SHA from the JSON; mount read-only with `hdiutil` and
   copy its exact app to a disposable user's `Applications`. Capture `plutil`,
   `codesign --verify --strict`, signature details, xattrs/quarantine, ownership,
   dev/inode/link counts, complete member hashes and actual registration state.
2. Exercise normal close refusal while a real old-GUI workflow is busy, then
   cooperative normal exit while idle. Confirm the old Unix GUI cannot bypass
   ownership merely because Hub's current lock is free. No SIGTERM/SIGKILL.
3. Seed isolated exact settings/client before-images. For MCP connect at the
   original bundle Node/server paths before retirement, not a copied cache.
   Keep that connection alive and retain every original resource/member name.
4. In the disposable test only, obtain native decline then approval, journal the
   exact before-image, and archive only the reviewed GUI target without overwrite.
   Capture supported registration-removal behavior; do not assume a private
   LaunchServices utility is a stable production API. Verify Node independently
   with `codesign`/`otool` and capture signature/launch policy without bypasses.
5. Require existing stdio `tools/list` survival, new same-path Node reconnect,
   both Node aliases, all nine MCP resources and every settings/client/store hash.
   Test GUI-only archive interruption, exact-byte tamper, same-size replacement,
   source/parent namespace changes, restart recovery and repeat native approval.
   A recorded journal must never replay paths or authorize cleanup by itself.
6. Only then design the OS leaf. A plain pathname `fs::rename` is not proof of
   Windows held-handle identity/reservation parity. Establish source/destination
   binding, no-overwrite, filesystem durability and competing-install behavior.
7. Finally exercise the real unified installer/first-launch coordinator and signed
   update/restart on each architecture. Portable proof checks or a standalone
   leaf pass do not constitute that acceptance.

Linux follow-up belongs on isolated Debian and RPM-native VMs: capture `dpkg -L`
or `rpm -qpl`, scripts, package verification and original-runtime dynamic loading
before designing a retention-preserving replacement package. AppImage additionally
needs real mount lifetime/reconnect and integration-path evidence; do not assume
its internal symlinked desktop entry is a host desktop registration.

## Verification

`node --test native/legacy-retirement-unix-proof.test.cjs` checks only captured
public evidence and distinct payload identities. Production files and shared
agent files were not edited. No native retirement or release claim is made.
