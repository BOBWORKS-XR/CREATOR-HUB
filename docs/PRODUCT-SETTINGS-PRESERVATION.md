# Product Settings Preservation - 2026-10-13

Development adapter only. No release readiness, installed acceptance, legacy
removal, data relocation or authenticated-client acceptance is claimed.

## Traced Stores

Paths below are derived by the existing modules using `dirs` (not new Hub-owned
copies). Source locations are the authority; platform-native acceptance is still
required.

| Store | Existing location and contract |
| --- | --- |
| MCP launcher | `config_dir()/creator-works-mcp/launcher-config.json`; fallback `config_dir()/banter-mcp/launcher-config.json`. Current wins. `main.rs` LauncherConfig/ProjectChannel preserve unknown JSON fields with serde flatten. Hosted preview limits are 256 KiB and 256 channels. |
| MCP explicit-save backups | Adjacent `.creator-hub-settings-backups/launcher-config.json.<sha256>.bak`. The existing settings_backup adapter retains exact bytes and refuses altered retained images. |
| MCP project state | Project-local `.bantworks-mcp/state`, including `launcher-settings.json`. It is not an account preference store or executable authorization. |
| Setup editor discovery | `data_local_dir()/CreatorProjectSetup/editor-roots.json`; JSON array of paths. `bootstrap.rs` reads at most 16 KiB, takes 16 absolute roots and remembers the parent of a verified Editor location. This is a discovery cache, not a new preference-object schema. |
| Setup tools/logs | Existing `CreatorProjectSetup/tools/unity-cli`, `tools/unity-hub`, and `logs`; same `dirs::data_local_dir()` derivation for standalone/built-in use. |
| Setup project data | Project-local `.creator-project-setup/setup-receipt.json`, progress, validation/operation receipts and repair backups. `repair.rs` retains selected project/package before-images under `.creator-project-setup/backups/<id>`. Community helper backups remain `.creator-plugins/helper-backups`. |
| Setup project discovery | `community_project.rs::stored_paths` reads `data_local_dir()/CreatorHub/projects.json` and both existing MCP launcher files. No independent Setup project-list migration is needed. |
| Terms/UI state | Setup/MCP/Hub each have their existing localStorage terms keys. Hosted terms acceptance is supplied through the established Hub presentation contract. Terms acknowledgements are not copied or manufactured by this adapter. |
| Hub adoption | `manager.rs::adopt` records only a verified executable path under `data_local_dir()/CreatorHub/<app>.json`. It does not migrate module preferences. Built-ins refuse legacy executable management. |
| Hub projects/restore | Existing `CreatorHub/projects.json` contains `paths`; `hosted_restore.rs` uses `hub-updates/hosted-restore.json` and current verified built-ins, never saved executable-path authority. |

## Classification

- **Correct as-is:** shared current/legacy MCP locations, current-first read
  precedence, unknown launcher/channel field round-trip, Setup editor-cache/tool
  paths, project-local receipts/backups, and read-only startup without migration.
  No new unified preference schema or duplicate Hub settings directory is needed.
- **Confirmed broken:** the prior hosted `save_config` path serializes the UI
  document into the general atomic-write primitive without tying publication to
  the loaded before-image. A disposable regression reproduces replacement of
  newer external fields; a before-image backup alone does not prevent that loss
  from the active file. Legacy-only first saves did not retain a content-addressed
  before-image of the *selected legacy source*.
- **Confirmed missing:** visible current/legacy conflict and interrupted product
  save review. Different documents are not a proven merge contract.
- **Likely wrong, not failure-proven here:** Setup editor-root remembering uses
  a direct `fs::write` and an unreadable roots file is treated as an empty cache.
  No speculative cache rewrite was made.
- **Unknown / needs capture:** final installed signed-update preservation of
  Setup's editor cache, native WebView preference storage, native Mac/Linux
  writable operation, every product writer, and actual client reconnect.

## Narrow Adapter

`modules/mcp/launcher/src-tauri/src/product_settings.rs` is reached by the
existing hosted command adapter and the narrow backend preference-save hooks.
It leaves standalone loaders/saves unchanged.

- Built-in hosted loads retain the exact selected document snapshot. They keep
  current-first precedence, including ignoring an invalid inactive legacy file.
  Only the owned form's explicit `load_config` handler renews that before-image;
  product-status, discovery and onboarding reads do not renew it. A regression
  reads externally changed settings in the background, then verifies stale form
  saving still refuses without overwriting the external fields.
- Explicit hosted saves refuse changed/deleted/newly-created snapshots. Existing
  current files use the already implemented recovery Transaction with exact
  before/after images, displacement checks and completion evidence. No migration
  engine file was changed.
- First explicit saves retain the selected legacy source before-image and use
  create-if-absent publication. The legacy original stays in place. Merely opening
  the view does not create or import settings.
- `one_click_setup` now loads an operation-local `(LauncherConfig, Operation)`
  from the actual current/fallback server file, not the unsaved UI document.
  The consumed operation token supplies that exact before-image to its commit.
  It does not read, renew or replace `LOADED`. A later external edit refuses the
  commit before the subsequent bridge/project/client steps; this is not a
  transaction around earlier CLI preparation or the entire setup workflow.
- The four previously unbound Codex/Claude Code/Antigravity/OpenCode removal
  handlers now pass their exact parsed before-images to the existing client
  publication adapter. Existing ownership, no-op and serialization rules stay
  unchanged. Claude Desktop removal was already snapshot-bound.
- Project `launcher-settings.json` mutations and built-in feedback/check-in
  preference writes use exact read snapshots and the same journal engine through
  scoped publication hooks. Unknown JSON preference fields are preserved in the
  built-in path. Standalone feedback retains its original compact schema/reset
  behavior. These sequential writes can partially complete and retain local
  recovery evidence; no automatic multi-file rollback is claimed.
- `product_settings_status` is read-only. `review_product_settings` requires the
  existing owned writable UI workflow plus native Windows approval for backup or
  interrupted-save resume. Journal targets are independently fixed to the existing
  current launcher path. Unknown/conflicting outcomes are never blindly rolled
  back; differing current/legacy settings can be backed up without merging.
- `.creator-hub-product-settings` beside the current launcher file contains only
  recovery evidence, not a second active preference store. Backup inspection
  discovers exact retained copies again after a process restart.
- The small built-in-only review control does not exist in standalone/read-only
  mode and does not invoke client configuration, project mutation or sign-in.

## Validation And Remaining Gate

Rust 1.99.0: 23 focused native tests passed. They exercise stale snapshots,
unknown fields, backup corruption, locked failed writes, durable exact images,
first-save refusal, existing read precedence and original preservation.
76 hosted/browser tests passed, including nine focused action-admission,
explicit-backup, recovery-visibility and 390/940px wrapping tests. The nine
focused browser tests passed again after the final recovery-message follow-up.
Strict all-target MCP Clippy passes on Rust/Clippy 1.99, and the unified source
check passes. Native tests and Clippy include the background-read regression.
The follow-up includes fresh-server versus unsaved-form one-click snapshots,
operation-local stale commits, all four removal publication hooks, project-local
launcher preferences and sequential feedback/check-in publication. The existing
two standalone feedback tests and launcher-preference regression also pass.
Tests use disposable files and injected publication hooks, never real client
configuration paths. The first follow-up run passed 22/23: its feedback assertion
used the launcher's fixed backup basename for `settings.json`. The helper was
corrected to derive the actual basename; the complete 23-test rerun passes.

Commands:

```text
cargo test --release --locked --manifest-path modules/mcp/launcher/src-tauri/Cargo.toml product_settings -- --test-threads=1
cargo clippy --release --locked --manifest-path modules/mcp/launcher/src-tauri/Cargo.toml --all-targets -- -D warnings
npx playwright test tests/hosted.spec.js tests/product-settings.spec.js --workers=2
npx playwright test tests/product-settings.spec.js --workers=1
node scripts/check-unified-sources.cjs
cargo test --release --locked --manifest-path modules/mcp/launcher/src-tauri/Cargo.toml feedback::tests -- --test-threads=1
cargo test --release --locked --manifest-path modules/mcp/launcher/src-tauri/Cargo.toml launcher_settings_updates_preserve_fields_and_defaults -- --test-threads=1
```

This is not a global transaction around every writer. Asset installation (bridge
and logo), Hub project-list writes and Setup project authoring remain their
existing contracts. Project/feedback journals remain local to their independently
derived settings path; recovery of those files is a separate explicit/manual
review, not authority granted by the launcher's recovery UI. The first-ever
create-if-absent save retains legacy data but does not claim a completed multi-file
migration receipt. Production Unix writable mode stays held; the existing explicit
experimental-unix-hosting feature may use the shared publication adapter. No
feature or release flag is enabled by this work. Exact rebuilt installed/native
acceptance remains required.

No installed app/client configuration, credential, terms acknowledgement, project
or legacy installation was changed by these tests. The five original dirty
Cargo/schema files were hash-rechecked unchanged during the work.
