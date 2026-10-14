# Unified Installation Flow

Work in progress for Hub 0.1.14. This is not accepted removal or release evidence.

Hub takes over the existing Creator settings files in their established OS data
locations. It does not need to move Unity projects or create a second copy of
settings that can drift. Standalone executable resources and app registrations
are separate from those persistent data files.

The first-launch guide runs after Hub's terms and preferences, before normal
navigation, automatic view restoration and background update checks. Fresh
installs without prior Creator data or standalone applications skip it.

1. Inspect only source-established Creator settings and known app locations.
2. Ask for native approval and keep exact, verified, deduplicated before-images.
3. Refuse conflicting settings, changed files and unresolved operation outcomes.
4. Open the verified private MCP backend, preserving exclusive settings ownership.
5. Review existing supported client routes through the existing native, journaled
   migration APIs. Never replace custom/foreign entries silently.
6. Verify signed managed-router activation and retained runtime resources.
7. Independently prove safe standalone removal, then retain all app data and
   uninstall only the source-bound legacy application resources.

Steps 1-6 have initial source implementation and unit coverage. Step 7 remains
blocked pending effective dependency-scope integration, generated official uninstaller provenance,
native retention acceptance, platform-specific cleanup and full native-flow tests.
The guide says cleanup is pending; it does not claim completion. A review record
is not permission to uninstall, live-client acceptance or publisher verification.

## Removal Checks

`configured`, app registration names, ownership markers and a batch migration
result of `unchanged/count:0` are not safe-removal proofs. A renamed entry, a
project-local client scope, alternate configuration file or preserved environment
override can still depend on files in an old installation.

Only native independently derived targets may be considered. A frontend or
saved JSON record must not select an uninstaller or authorize deletion. Unknown
versions, changed binaries, busy apps, unresolved configuration scopes, failed
retention checks and cancelled approvals keep the old installation intact.
Do not force-close AI clients, Unity or unrelated Node processes.

## Tests And Boundaries

- Root's focused convergence/store tests pass on Windows. They verify bounded
  inputs, exact backups, changed-source and conflict refusal, unknown recovery,
  retry safety and the distinction between review and removal authorization.
- The isolated guide tests verify no mutation on load, capability gating,
  cancellation, retry, duplicate-click refusal, escaped text and explicit phases.
- Full native first launch, signed update/restart, actual AI-client reconnect,
  macOS/Linux cleanup and end-to-end uninstall retention are still required.

Current Windows source checks: 251 Root Rust tests pass with 11 explicitly
opt-in native tests ignored; strict Clippy passes. Thirty dependency-guard tests
are connected to Root's test target only, not production cleanup. The 15 browser
convergence/startup tests pass, including screenshots at 390 and 1100 pixels.
MCP's supported-client recovery selector has nine passing Windows-hosted Rust
tests; Linux-native operation is not inferred from those selector fixtures.

Published releases and the user's installed applications remain unchanged.
