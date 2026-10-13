# Creator Project Setup 0.3.1

Windows release: stale unlocked Unity lock files no longer block Add Unity menu.
Plugins gains preview galleries, streamed large-package downloads, progress,
cancellation and Unity helper 0.1.1. Hub integration requires Hub 0.1.7; standalone
use remains available. Existing project consent and backups remain in place.

[Build 35283526299](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/35283526299)
and [installed acceptance 35284656904](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/35284656904)
passed the exact installer from 0.2.2, 0.3.0-alpha.1, alpha.2, alpha.6 and 0.3.0,
including payload/sentinel preservation and native busy-close/cancel/idle behavior.
[Public Hub integration 35287544498](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35287544498)
passed with the same installer and staging disabled. Public downloads and signed
metadata were verified. No user project or installed app was changed by the tests.

Installer SHA-256:
`8bb8aeecb18973f52cb9afe41c251a913b4e30dfbcfdc927edb785c5afd6f664`.
Product source: `d6ab04c008fd49a445f9766d74bc8def2f557f1f`.

This is not new all-platform or clean-machine Unity creation acceptance. Package
checksums establish integrity, not code safety. Full shared evidence and retained
failures are in [Hub's release notes](https://github.com/BOBWORKS-XR/CREATOR-HUB/blob/ui-preview/docs/RELEASE-0.1.7.md).
