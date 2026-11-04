# Windows 0.1.19 Native Harness

Status: prepared for pin review, not native-qualified. No candidate pins have
been supplied, and no build, signing, remote dispatch or installation was run.

## Derivation And Scope

The native drivers and guards were copied from the reviewed harness commit
`e4459b067113beabfeff2c212caa40fc9d7015f0` (tree
`e135b03b86dd0d2a317842e9e8b21847ae125836`). All adapted files have new `019`
names. Historical files are not changed.

- Raw: fresh NSIS install; exact PUBLIC18 guarded `/UPDATE /S /NS` upgrade.
- Production: fresh native UI; signed incoming from PUBLIC12, PUBLIC14, PUBLIC18.
- Migration: the original legacy, Setup-owned Codex, and custom-server cases,
  each using the same-profile PUBLIC12 signed incoming path before migration.
- Outgoing acceptance is separate and is not provided by these workflows.

The baseline registry is the existing `scripts/self-update-baselines.cjs`.
The PUBLIC18 entry is maintained by the parent task. Exact version selection
refuses a fallback to an older baseline.

The new PUBLIC18 lane uses direct Home navigation: public `v0.1.18/src/app.js`
hides the legacy Apps tab and places the updater on Projects. PUBLIC12/14 keep
the old navigation. Protocol, process ownership, screenshots, cancel, settings,
SDK reconnect, backup and recovery assertions remain in the copied drivers.
Inherited unused historical transport factories cannot start the new proxy:
only the bound `production019-input` contract is admitted. No outgoing mode is
admitted by the lifecycle wrapper.

## Input Contract

Only `scripts/fixtures/windows-019-binding.json` binds the new candidate.
It deliberately remains `enabled: false` with null R2 identities. Do not fill
it from the superseded first candidate or private historical fixture19.

After the final R2 build is independently checked, supply:

- `source`: exact product commit and tree.
- `build`: build-result SHA-256, build-input SHA-256, and the complete raw R2
  `windows-019-clean-build` receipt as `provenance`. Its schema/version, exact
  source commit/tree, `status: 0`, `sourceUnchanged: true`, and empty `changed`
  list are required. The complete receipt is retained as `buildProvenance`;
  feed `sourceUnchanged` is projected only from the validated receipt value.
- `installer` and `executable`: exact byte lengths and SHA-256 hashes. The EXE
  must be the installer-extracted image, including the matching preflight image.
- `manifest`: raw byte length/hash, canonical JSON hash, and full parsed builtin
  manifest. Its exact 15 module/resource pins drive extraction and migration.
- `rawRelease`: private prerelease ID, tag and exact installer asset ID.
- `production`: private non-prerelease ID, `v0.1.19`, exact release target commit,
  minimum Hub/protocol fields, and IDs/sizes/hashes for the four signed assets.

Raw admission requires the raw portion complete. Production additionally
requires all signed metadata pins. Network acquisition is GET-only, checks
release and asset identity before and after download, bounds bytes, and writes
only new input paths. Synthetic unit-test data is in a separate test fixture;
native workflows never use it. Existing destinations are refused.

## Workflows And Inputs

- `.github/workflows/windows-019-raw-installer.yml`
  Branch: `validation/windows-019-raw-installer`.
  Dispatch inputs: `expected_harness_commit`, `release_id`, `release_tag`,
  `asset_id`, `asset_name`. All must match the reviewed fixture/current SHA.
- `.github/workflows/windows-019-production.yml`
  Branch: `validation/windows-019-production`.
  Dispatch inputs: `expected_harness_commit`, `incoming_only` (default false),
  `migration_scope` (`all` by default, or `custom-server`, `standard`,
  `incoming-only`). Full qualification uses the defaults, not subset receipts.

Push runs preflight only. Native jobs require workflow_dispatch and exact
repository, workflow, branch, hosted Windows x64 context and harness commit.
New workflow registration on GitHub must be handled by the parent under normal
repository policy before dispatch; no registration/dispatch was attempted here.
The product checkout is bound to fixture commit AND tree before its SDK is used.
Original 480-second lifecycle bounds are retained. Receipt/screenshot artifacts
exclude startup.json; TLS secrets, tokens and raw private configs are not added
to upload paths. `releaseReady` remains false in native harness evidence.

## Local Preflight

Run from this checkout, without starting any installer or Unity:

```powershell
node --test scripts/windows-019-harness.test.cjs scripts/windows-019-updater.test.cjs scripts/windows-019-owned-close.test.cjs scripts/windows-019-migration-phase.test.cjs scripts/windows-019-setup-owned-case.test.cjs scripts/windows-019-unverified-server-case.test.cjs scripts/windows-019-baseline-diagnostics.test.cjs
pwsh -NoProfile -NonInteractive -File scripts/windows-019-preflight.ps1
```

The Node tests use synthetic bytes, parse both workflows with the locked
Playwright dependency's YAML parser, and syntax-check the native JS drivers.
PowerShell preflight parses the three new PS helpers and checks lifecycle
parameter names without invoking their bodies. Passing these is not native
Windows acceptance.

## New Files

```text
.github/workflows/windows-019-raw-installer.yml
.github/workflows/windows-019-production.yml
docs/windows-019-harness.md
scripts/fixtures/windows-019-binding.json
scripts/fixtures/windows-019-test-fixture.cjs
scripts/windows-019-contract.cjs
scripts/windows-019-raw.cjs
scripts/windows-019-raw-install.cjs
scripts/windows-019-production.cjs
scripts/windows-019-acquire.cjs
scripts/windows-019-shared.cjs
scripts/windows-019-preflight.ps1
scripts/native-windows-019-fresh.cjs
scripts/native-windows-019-migration.cjs
scripts/native-self-update-direct-019.cjs
scripts/native-self-update-smoke-019.cjs
scripts/self-update-lab-feed-019.cjs
scripts/native-self-update-lab-019.ps1
scripts/native-window-019.ps1
scripts/native-incoming-migration-owned-close-019.ps1
scripts/windows-019-owned-snapshot.cjs
scripts/windows-019-owned-close.cjs
scripts/windows-019-updater.cjs
scripts/windows-019-setup-owned-case.cjs
scripts/windows-019-unverified-server-case.cjs
scripts/windows-019-baseline-diagnostics.cjs
scripts/windows-019-harness.test.cjs
scripts/windows-019-updater.test.cjs
scripts/windows-019-owned-close.test.cjs
scripts/windows-019-migration-phase.test.cjs
scripts/windows-019-setup-owned-case.test.cjs
scripts/windows-019-unverified-server-case.test.cjs
scripts/windows-019-baseline-diagnostics.test.cjs
```
