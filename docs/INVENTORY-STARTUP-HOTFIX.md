# Hub discovery and displayed-version hotfix

Status: published as stable 0.1.2 after exact-artifact acceptance. Recorded 2026-09-16.

## Published result

- Release: https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/tag/v0.1.2 (public/latest).
- Source/tag: `108b016322262eaa5d8b6f2c3177bdb7b8363661`.
- CI: https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35032986083.
- All four native routes, 141 UI tests, 105 Rust tests, 16 script tests and strict
  lint passed. Actual packaged startup displays 0.1.2 and discovers apps without
  manual retry. Exact public 0.1.1 to 0.1.2 installer upgrade passed.
- Public installer SHA256: `a7da62fe16a99beead8872d0b1f185eb0db60ed6253d13f12ff190e89a9d4ef0`.
- Public executable SHA256: `efa17b33e2abca6a0f2de39996dabf81e98a41052e33b21a25b8b96ffa66b31e`.
- All 17 public asset sizes/digests and five anonymous downloads were verified;
  signatures and tamper rejection passed. Old 0.1.1 assets remain unchanged.
- No user installation was replaced. The full in-app self-update/restart is not
  proven by the installer upgrade tests and remains a separate acceptance path.

## Confirmed baseline

- Published Hub 0.1.1 is installed and running from the normal per-user location.
- Executable product/file version: 0.1.1. SHA256: `0a852411d81c36fa81eb1a06678509a48f7006f940e2eb432f59307e02c48d9e`.
- Its footer incorrectly says 0.1.0 because `src/index.html` hard-codes that value.
- Native Apps status showed `Another Hub operation is already running.` Both detail views then reported unavailable inventory and misleading future-update guidance.
- Startup opens Projects, which asynchronously calls `project_inventory`, then immediately calls `app_inventory`. Both take the exclusive Manager guard. A slow project scan rejects both initial app checks; Hub's own update check was also skipped.
- A manual Check for updates in the installed app recovered inventory. Setup's Update app became enabled. MCP correctly remained blocked by an active app/connection. No installer was started and no app, connection or Unity project was closed.

## Source changes

- Serialize the four discovery calls sharing Manager: Projects, Apps, Hub update status, and plugin project targets. Failure releases the queue. Cancellation and user actions are not deferred; native guards remain in force.
- Display the executable's Cargo package version through the existing trusted top-level initialization, independent of inventory/network state. Static browser previews no longer claim a release version.
- Check Hub updates even when companion discovery fails.
- Show the actual inventory error and a local-only Retry app discovery action on every page. Preserve last-known versions but disable stale app actions until discovery succeeds.
- Remove the obsolete assertion that in-Hub support requires an unavailable future release.
- Strengthen native suite acceptance to assert successful initial UI discovery and the actual displayed version before its direct native checks.

## Verification

- Four new UI regressions failed against the baseline and pass with the changes: slow startup, displayed version, error/retry plus independent Hub checking, and invalid responses retaining last-known data without permitting stale updates.
- Full UI suite: 141 passed. The stale-response test also passes with automatic downloads enabled.
- Rust: 105 passed, 9 explicit opt-in tests ignored.
- Script suite: 16 passed, including serialized discovery, recovery after rejection/synchronous exceptions, and immediate cancellation/actions.
- Release Clippy: passed with warnings denied. `git diff --check`: passed.
- New error/retry screenshot inspected at 560px; no clipping or overlap.

Commands:

```powershell
npm run test:ui -- --workers=4
cargo test --release --locked --manifest-path src-tauri/Cargo.toml
cargo clippy --release --locked --manifest-path src-tauri/Cargo.toml -- -D warnings
node --test scripts/*.test.cjs
```

## Earlier pre-release checkpoint (superseded)

These changes are based on `7fc8835` on `feature/plugins-list-grid`. No published assets, tags, version numbers, MCP/Setup sources, installed binaries, or user project files were replaced. Existing untracked logo drafts are unrelated and preserved.

For the next release, use a new version rather than replacing 0.1.1 assets. Build with the established hosted-app pins and run the disposable installed/native suite with the strengthened startup assertions before publication. The patched packaged WebView and full self-update/restart have not been tested in this turn. The installed 0.1.1 can still encounter the startup race on another launch until a corrected build is installed.
