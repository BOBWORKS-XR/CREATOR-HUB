# Mac Legacy Standard Trash Contract

## Primary Evidence Checked First

The following Apple contracts were read before changing the probe or requesting
a native Trash test. They establish the documented basis, not a completed native
proof or a promise about every filesystem, permission context or client.

- [Apple uninstall guidance](https://support.apple.com/en-us/102610): quit the app;
  for an app without an uninstaller use Move to Trash. Emptying Trash is the
  separate permanent-deletion step. This proof must never empty Trash.
- [FileManager.trashItem(at:resultingItemURL:)](https://developer.apple.com/documentation/foundation/filemanager/trashitem(at:resultingitemurl:)):
  moves an item to Trash and returns its actual destination. Apple notes that the
  name may change; use the returned URL, not a guessed `~/.Trash/<app>` path.
- [Launch Services kLSAppInTrashErr](https://developer.apple.com/documentation/coreservices/klsappintrasherr?changes=_8_4),
  also its [documented numeric constant](https://developer.apple.com/documentation/coreservices/3074489-anonymous/klsappintrasherr?changes=___1&language=objc):
  an app inside a Trash folder cannot run (`-10660`).
- [NSWorkspace](https://developer.apple.com/documentation/appkit/nsworkspace?language=objc)
  supplies the native asynchronous app-launch request. The exact modern error
  wrapper, lookup behavior and absence of a launched app must still be captured,
  not assumed from the older Launch Services constant.
- [FileManager.getRelationship](https://developer.apple.com/documentation/foundation/filemanager/getrelationship(_:of:in:toitemat:))
  explicitly supports testing whether an item is in the native Trash directory.

## One Bounded Native Proof

Reuse the exact public 2.7.7 DMGs and the existing disposable Intel/ARM baseline,
not a new product build. Only the complete pinned per-user MCP app is eligible.
Verify normal old-GUI exit, present native Cancel then fresh Move to Trash
approval, and call the public `trashItem` API once. Record its returned URL and
native Trash relationship. Do not rename the app into a hidden backup directory.

Compare all member bytes and file/directory identities at the returned URL; verify
strict codesign there. Capture NSWorkspace/LaunchServices lookup, an old-URL launch
attempt and an actual returned-Trash-URL launch attempt, including nested NSError
codes and running legacy GUI PIDs. A generic signing failure does not prove Trash
policy: acceptance requires the documented `kLSAppInTrashErr` and no launched app.
Do not directly execute an app or new Node process from Trash to bypass that policy.
The already-live bounded read-only stdio probes may be observed separately.

Restore only this live experiment's exact verified bundle through a no-overwrite
rename back to its original location; compare all bytes/identities and strict
signature again. Keep exclusive intent/result/restored records and every failure.
No permanent deletion, symlink change, re-signing, private unregister operation,
global LaunchServices rebuild, security bypass, generic recovery framework or Root
wiring is allowed. If OS/runner permissions prevent the proof, record that exact
limitation; do not grant broad permissions or tune an alternative archive path.

## Product Boundary

Original Node/server paths are **not retained while the app is in Trash**. Before
eventual real cleanup, recognized client entries must first receive exact backups,
reviewed migration to Hub's verified stable router and restart/reconnect testing.
Unknown or unmigrated references, including unsupported custom clients, must stop
cleanup. Test connection survival is not settings/client migration acceptance.
Nothing here authorizes product cleanup or full migration/release acceptance.
