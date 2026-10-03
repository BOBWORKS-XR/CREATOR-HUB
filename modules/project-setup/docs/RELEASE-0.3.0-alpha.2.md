# Creator Project Setup 0.3.0-alpha.2

Windows diagnostics hotfix prerelease. Stable 0.2.2 and the earlier prerelease
remain unchanged. This release keeps the same Unity/Creator SDK recipe.

## What Changed

- A recognized final Unity package-download failure now shows the failed package,
  host, connection error, exit code and connection-check guidance, instead of only
  "Unity setup failed". Earlier recovered warnings are not treated as the cause.
- Creation receipts now record the Setup version, timestamp, platform and paths
  of existing Unity logs, so optional user reports can be tied to the right build.
- Failed creation explicitly explains that the retained folder cannot be resumed
  or overwritten by Create. A fresh attempt needs a different project name.
- [Reporting instructions](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/blob/hub-compatibility/docs/REPORTING.md)
  explain which files to keep and what to redact before sharing.

Logs remain local. No telemetry, automatic upload, automatic retry, security-policy
changes or project deletion was added. This improves diagnosis; it does not claim
to fix a user's network or Unity's package server.

## Install

Use the Windows installer or the portable ZIP from this release. Keep `licenses/`
with the portable EXE. Close Setup normally before upgrading. Both forms work
standalone; Creator Hub is optional. Windows binaries are not Authenticode signed.

For hosted use, update to the matching
[Creator Hub 0.1.0-alpha.5](https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/tag/v0.1.0-alpha.5)
first. Signed metadata tells older Hubs to update Hub before installing this
Setup version. Standalone Setup remains independent. No MCP update is required.

## Validation

[Clean Windows candidate checks](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34587957462)
passed for source `a8878c49a4c4cb57268c45484baa9e889b79bac2`: 41 Rust tests,
34 browser tests, strict Clippy, packaged notices, exact executable identity,
portable ZIP and installer guard checks. Four explicit live Unity/Hub tests were
not run. The release contains these exact accepted binaries, not a rebuild.

[Installed upgrade acceptance](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34588485597)
passed on two separate disposable Windows runners: public 0.2.2 to alpha.2 and
public alpha.1 to alpha.2. Each tested early refusal with a same-name owned test
process alive, unchanged refusal snapshots, cooperative exit, successful update,
installed executable/license hashes, synthetic preservation sentinels, real GUI
startup and normal close. See `release-verification.json` for exact hashes/scope.

These tests do not establish real user-settings migration, every historical
uninstaller, a busy Unity creation/repair, reporter-side network recovery or
successful project completion. Native macOS/Linux workflows, full project
recovery and headset behavior are outside this Windows diagnostics acceptance.
