# Release Work

## Unified Product Work

- User decision 2026-10-14: macOS support is suspended. Active release targets are
  Windows and Linux, with Flatpak still requiring its own host-operation gates.
  Do not run Mac jobs, publish new Mac artifacts or use Mac acceptance as a
  release blocker. Preserve historical downloads, source and diagnostic evidence.
  Resuming Mac support requires a new explicit user request.

- Creator Hub is the approved future single product and canonical source repository.
  Develop MCP in `modules/mcp` and Setup in `modules/project-setup`; their old
  repositories are retained for historical downloads and explicit migration work.
- Read `docs/UNIFIED-CREATOR-HUB.md` before packaging or changing update routes.
  Source consolidation is not a completed unified installer or migration.
- Preserve existing Hub identity, legacy signed metadata, settings and owned
  AI-client entries. Do not redirect legacy feeds, remove old apps or archive
  repositories before native migration acceptance.
- Keep `scripts/check-unified-sources.cjs --release` refusing publication until
  real built-in distribution and legacy migration acceptance replace the source-only gate.
- Generated module Tauri schemas are not intentional source changes; do not stage
  them with feature work solely because a native test rewrote their paths.
- Before expensive packaging or native acceptance, run focused tests for every
  changed harness/workflow and parse its native scripts. A harness correction
  must add a regression for the observed failure.
- Reuse immutable candidate artifacts for harness-only changes. Record product
  source separately from test source, and require the same installer/image hashes.
  Do not rebuild passed product bytes because documentation or tests changed.
- Classify native failures as product, harness, environment, or unverified.
  Missing platform integration is unfinished feature work, not merely a build
  failure or a release that only needs another test. State that distinction early.

- Read `docs/RELEASE-GATES.md` and `docs/HUB-PUBLICATION-CHECKLIST.md` before any
  release work. Prior permission to publish one version is not standing authority
  to publish future versions.
- Publish Hub drafts through `scripts/publish-hub-draft.cjs`. Do not bypass its
  old-client response-size gate with a direct GitHub publish command.
- Do not declare a release ready until the exact previous stable app has passed
  public discovery, native cancellation, approved in-app update, automatic
  restart, version/hash checks and preference/content preservation. A silent
  installer test, source tests or working download URLs alone are insufficient.
- Keep old published installer bytes and signed metadata immutable. Compact
  release-page text and link full notes; bundle future evidence to avoid bloating
  the GitHub release-list response consumed by older installed clients.
- Preserve original failure reports and state the tested scope. Use disposable
  runners for installation tests; do not modify the user's live app or projects
  just to obtain release acceptance.
