# Stable 0.3.0 Publication

Published on 2026-09-15 from the exact accepted Windows candidate, not a rebuild.

- App source/tag: `f8d5423df9a477ceb65ec62a00358c7900703b66`, `v0.3.0`.
- Build: https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/35003479084
- Four installed upgrade baselines plus real native chooser lifecycle:
  https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/35004470795
- Installer: `1cb72e2ea31345a4679aabf2b0756e847b10b68bc2043988147c2449584e02f2`.
- Installed app: `ed0a57b2421c844a9d30dc5f69f0a358ae9fe32cf6e3b5fd6570028a3337f27d`.
- All 13 uploaded assets matched GitHub's SHA-256 digests. The public installer
  and metadata were downloaded again and checked using Hub's pinned trust key,
  including the tampered-descriptor negative control.

Master also retains the public alpha.6 history, alpha.2 upgrade coverage and
new diagnostic tests. These later commits do not alter the app source, embedded
assets, native code or recipe from the tagged candidate. Earlier assets were
not replaced. Windows publisher signing remains absent.

## Legacy Tag Workflow

Tagging the original build source triggered the older `release.yml` builder
(35005022299), which would rebuild additional binaries through `tauri-action`.
All four jobs were cancelled with every publish step skipped, and the legacy
workflow was disabled through GitHub. A v0.3.0 exclusion is also present on master.
Do not re-enable that workflow or replay the old tag's workflow against this
release: the old tag predates the exclusion. The immutable tag was not moved.
Use the candidate and installed-acceptance workflows for future releases, then
promote their reviewed exact artifacts explicitly.

Hub/MCP coordinated acceptance and publication are separate from this standalone
Setup release. Do not cite this page as proof that the entire suite is published.
