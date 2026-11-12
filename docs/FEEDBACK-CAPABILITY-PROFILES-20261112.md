# SDK-Aware Capability Profiles

Status: implemented in source for the next update; not included in the immutable
0.1.22 installer. Validation is recorded below. No publication or installation.

## Reported Behaviour (0.1.22)

- `src/features/mcp.js` hard-codes "Full Unity + Banter" and "Banter workflow".
- `core,banter` enables shared Creator SDK / Visual Scripting tools, not only
  Banter tools. The displayed name does not identify the selected project's SDK.
- The checked project already exposes `sdkProfile`; the saved `tool_groups`
  preference is separate and must not be silently overwritten.

## Requested Behaviour

- Use clear Altspace / Creator SDK and Banter labels from the checked project.
- Offer an explicit Auto (project SDK) mode for new setup, with manual override.
- Preserve existing manual selections and stable stored group IDs.
- Unknown or stale SDK detection must not guess or rewrite client files. A
  verified mixed SDK project gets the explicitly labelled combined profile.
- Changing projects must refresh the recommendation without silently applying
  configuration changes. Applying a new profile must still use normal review.
- Test Creator SDK, Banter, mixed and unknown projects, stale asynchronous
  responses, saved manual settings, and project changes before applying setup.

The current published payload must not be replaced to add this behaviour.

## Implementation

- Fresh configurations use `auto`; missing legacy fields still default to
  `core`. Explicit manual values and unrelated configuration fields are retained.
- Apply/one-click setup reads SDK metadata again before producing client
  settings. Auto is persisted as intent, never sent as a server group name.
- Current manifest dependencies and reachable lock entries determine the SDK.
  Orphaned lock entries are ignored; malformed/duplicate/unreadable metadata
  offers recheck or manual selection instead of guessing.
- Creator/Altspace gets the shared graph tools without Banter WebRoot JavaScript;
  existing Banter groups are unchanged. Verified hybrid projects expose both.
- Passive checks do not change clients. Existing Follow active project behaviour
  applies only on explicit saved-project selection/options save. Restart changed
  clients; tool lists do not change dynamically within an AI conversation.
- Capability-only saves do not rewrite unchanged Unity script/test preferences.

## Validation

- TypeScript build and 19 group, stdio-server and launcher contract checks passed.
  The Token Saver schema-budget test also passed unchanged.
- 34 direct MCP UI regressions passed, including saved/manual profiles, Auto
  Creator/Banter/hybrid/plain projects, unknown-SDK recovery, late responses,
  active-vs-draft routing, failed saves and 320/1100px layout captures.
- 131 shared native-page and convergence UI checks passed before the final
  narrowly scoped routing correction; its focused regression and 10 shared
  MCP page checks also passed afterward.
- Independent read-only review: no remaining significant capability-profile
  findings. Review corrections cover transitive dependency reachability,
  stale lower lock versions, valid higher Unity resolutions, and target routing.
- Final native full-suite rerun: 333 passed, 0 failed, 9 opt-in tests ignored.
  This includes eight capability tests and the existing settings, backups,
  migration, client ownership, publication and recovery regressions. Do not
  treat this source change as installer, live AI-client or release acceptance.

Commands (from the Hub checkout):

```text
npm --prefix modules/mcp run build
cd modules/mcp
node --test test/tool-groups.test.mjs test/tool-groups-server.test.mjs test/launcher-onboarding.test.mjs
node --test test/tool-context-budget.test.mjs
cd ../..
npx playwright test tests/direct-mcp-regressions.spec.js --workers=2 --reporter=line
npx playwright test tests/native-pages.spec.js tests/convergence.spec.js --workers=2 --reporter=line
npx playwright test tests/native-pages.spec.js --grep MCP --workers=2 --reporter=line
cargo test --release --locked --manifest-path modules/mcp/launcher/src-tauri/Cargo.toml --lib -- --test-threads=1
```

Visual captures: `artifacts/sdk-capability-profiles-20261112/capabilities-1100.png`
and `capabilities-320.png` (inspected; labels fit their controls).

One-click failure coverage uses production preflight resolution, all five
client-format renderers and a source-order regression; it is not a new
end-to-end installation test. No real Unity project, client settings or installed
Hub was intentionally modified by these fixture tests. No version bump, release
build, installation, upload or publication was requested or performed.
