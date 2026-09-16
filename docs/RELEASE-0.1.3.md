# Creator Hub 0.1.3

2026-09-16 evidence packaging update: the eleven separate build, installed and
native test-report JSON attachments are preserved byte-for-byte in
[verification-reports.zip](https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/download/v0.1.3/verification-reports.zip).
Its `CONTENTS.json` records original filenames, asset IDs, sizes and hashes.
Individual report attachment URLs changed; installers, signatures, catalog and
updater metadata, checksums and licence attachments are untouched. Consolidating
diagnostics keeps the release-list response readable by older installed Hubs.

- **Unblock MCP updates inside Hub.** If verified private MCP runtimes are still
  running, Apps and MCP details offer **Disconnect MCP for update**.
- **Confirm once, then update.** Cancel changes nothing. Confirming stops only
  that verified installation's private runtimes. The normal guarded update remains
  a separate action. Other Node processes, Unity and AI applications stay open.
- **MCP 2.7.1 support.** The matching MCP hotfix exits correctly when an AI client
  disconnects during pending work. Hub includes the exact new hosting binding.
- Project Setup remains **0.3.0**. Plugins, Grid/List views, the Unity menu and
  projects remain available; this hotfix does not modify existing Unity projects.

## Update

**Update Hub first**, then MCP from Apps. Use Check for updates, or close Hub
and run `Creator-Hub-0.1.3-Windows-setup.exe`. No uninstall or settings deletion
is needed. If an AI client reconnects immediately, pause its MCP connection and
retry. Unknown installations still need explicit attention, not mass termination.

Windows x64. The installer is not Authenticode-signed. Signed update metadata
and checksums verify published bytes; they do not certify community plugin code.

## Acceptance

The exact final installer's
[Windows acceptance run](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35040103489)
passed **144 UI tests, 107 Rust tests, 17 script tests** and strict lint. Nine
opt-in Rust diagnostics were excluded. All four native routes passed: clean,
legacy companions, MCP-only and upgrade from Hub 0.1.2. Native Cancel, confirmed
disconnect, separately approved update, protected settings and hosted views
passed against public MCP 2.7.1 and Setup 0.3.0. Original receipts are attached.

Installer SHA-256:
`c373134d370aeeaca08e9408a581baa862f631c5bb8f3a87dc558e69c3506d0b`.

The earlier candidate with a missing command permission was rejected. A local
permission regression and actual packaged native checks now cover that defect.
An earlier legacy fixture also reported an unexpected older Setup release; its
cause was not established. Diagnostic capture was added, not a speculative
product workaround. The final receipt records what this candidate actually saw.

After publication, excessive GitHub release-list metadata blocked older clients'
discovery. Compact release-page text repaired the feed without replacing any
assets. [Actual 0.1.2 to 0.1.3 in-app update/restart acceptance](RELEASE-FEED-0.1.3.md)
now passes, including cancellation and preserved preferences. Earlier attached
receipts retain their original, narrower scope.

Every AI client's reconnect policy, native macOS/Linux, headset behavior and
arbitrary package code were not retested for this Windows hotfix.
