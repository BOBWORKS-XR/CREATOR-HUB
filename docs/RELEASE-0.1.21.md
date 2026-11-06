# Creator Hub 0.1.21 for Windows

Includes Creator Works MCP 2.7.9. Project Setup remains 0.3.7.

## Changes

- AI clients can explicitly register an existing Unity project for the current
  MCP session without changing saved projects or selecting it automatically.
- Project lists support bounded pages and field selection for larger workspaces.
- Read-only native inventory can consume a validated, temporary snapshot from
  an opt-in compatible native host. The host must ask for permission. Hub does
  not install the helper in a Unity project or probe a running world.
- Windows short-path aliases cannot bypass a disabled saved project route.
  Existing route identities and preferences are retained.

See [session project and native inventory details](../modules/mcp/docs/session-projects-native-inventory.md).

## Update Safety

The existing signed updater is retained. Private acceptance used the actual
0.1.20 installer and this exact 0.1.21 installer, checking cancellation, automatic
restart, preferences, protected files, and old/new MCP connections in three
disposable Windows profiles. Public update acceptance must pass before this
release is marked latest.

No project conversion or forced Editor upgrade is included. Back up important
work and review AI actions. Windows installers are not publisher-signed;
updater signatures are verified separately.

## Platforms

New official binaries are Windows x64 only. Historical macOS and Linux downloads
remain available. Source remains available for community builds; maintainers
with the relevant platform experience are welcome. No new Mac, Linux or Flatpak
package is claimed by this release.

## Verification Scope

Source and bundled protocol checks, installer guards, signature/tamper checks,
and the three private update cases passed. Native consent and snapshot reading
also passed in a disposable Windows IL2CPP player. Full native-client Main/XR
operation and physical input are separate from that fixture. This release does
not ship a new native client or new incremental Visual Scripting graph editor.
