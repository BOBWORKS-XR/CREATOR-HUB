# Creator Hub 0.1.7

Published Windows stable release with Setup 0.3.1 and MCP 2.7.2. Old published
installers and signed metadata were not replaced. No user project or local
installed app was modified during release acceptance.

## Changes

- Add Unity menu checks actual Windows lock ownership, not just file existence.
  Stale unlocked UnityLockfile files are preserved and no longer block installation.
  Returning to the project picker refreshes its state and retains the selection.
- Plugins supports opt-in preview galleries and streamed package downloads with
  byte counts, speed, scoped cancellation and retry. The Unity helper is 0.1.1.
- Optional large-download metadata preserves the old listing contract. Compressed
  packages are bounded at 256 MiB; catalogue activation is a separate action.
- Existing project consent, no-clobber writes, helper backups, native Unity import
  selection and import receipts remain. Checksums do not establish code safety.

## Exact Acceptance

- [Candidate build 35285728517](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35285728517):
  interface/native tests, lint, packaging, clean install and running-Hub guard.
- [Staged native suite 35287133940](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35287133940):
  four clean/legacy/MCP-only/current-Hub routes with the exact companion builds.
- [Public native suite 35287544498](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35287544498):
  all four routes passed again with staging disabled and public releases. Tests
  include stale-lock helper installation, recognized helper migration, gallery
  media decoding, hosted restoration and protected-state preservation.
- [Unmodified public 0.1.6 to 0.1.7 self-update 35287542182](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35287542182):
  public discovery, native Not now, approved update, automatic restart, exact
  installed hash, footer/registry version and retained preferences/content passed.
- All 15 Hub/Setup/MCP public assets were anonymously downloaded and byte-matched.
  Signed descriptors, Hub updater signature and tamper rejection passed.

Hub installer SHA-256:
`64c5c5848bbcadb217f8e87a73a2e5055f13a2fe72cc5fb10b19470f1eb9252c`.
Installed Hub SHA-256:
`853bcf82d7be4b4fb4188cf19d99f3d08fcf70636cc52bec3199fa76a2f85ab5`.
Product source: `33c41397b2fad564d4bce4ac6442618526de6305`.

## Original Failures And Limits

The first packaged media test checked removal before the queued dialog-close
event ran. Its harness now waits for the same cleanup condition; a focused
browser regression and all 55 Plugins UI tests passed. The candidate installer
was not rebuilt. Companion fixture-line-ending and PowerShell-startup failures
remain documented in [streaming acceptance](PLUGINS-STREAMING-ACCEPTANCE.md).

The guarded draft projection passed at 215,123 bytes. Its immediate post-publish
read did not yet include the release, so the publisher returned a failure instead
of claiming readiness. Publication was not repeated: the subsequent anonymous
feed and real old-app update passed. The public feed is 215,088 bytes, leaving
47,056 bytes beneath the legacy 256 KiB limit. Six Hub assets were published;
draft-only companion staging files were removed first.

Unity 2022 and Unity 6 presentation/lock checks and a real 93 MB Unity 6 streamed
download/import/compile/receipt check passed. These do not prove every community
package, scene runtime, headset, historical MSI migration, or macOS/Linux install.
The outgoing hosted-view updater was not changed by this release; its distinct
0.1.6 acceptance remains in [the previous notes](RELEASE-0.1.6.md).
