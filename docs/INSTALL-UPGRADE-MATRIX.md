# Installation and Upgrade Acceptance

Status checked 2026-09-10 against GitHub release metadata and local reports.
This is a release gate, not a claim that these cases have passed.

## Current Evidence

Passed locally: real hosted Setup creation/reopen; isolated repair/revalidation
with preserved content and backup; native MCP read-only hosting, both original
and optional lifecycle protocols; busy-close refusal; single-window launches;
source/UI regression tests; non-installing installer-guard fixtures.

NOT yet passed: actual installed MCP upgrade, migration from all older releases,
interactive old-uninstaller/Retry flows, full writable MCP hosting, persistent
adoption, existing standalone form handoff or Hub uninstall recovery.
The prepared disposable-runner script currently tests only 2.6.0 -> 2.6.1 and
has not run. Passing that one path will not satisfy this full matrix.

## Source Audit Findings

The MCP owner reviewed the stable 2.6.1 candidate at local commit 72bd13c,
historical manifests and its unedited generated NSIS template. These are source
findings, not results from running historical installers:

- **Confirmed missing:** cross-brand installed-product migration. BANTWORKS
  used a different product name, publisher and identifier. Candidate discovery
  uses current Creator Works identities only. Importing launcher JSON is not
  removal/replacement of the old installation or its connected MCP server.
- **Confirmed incomplete:** MSI source-directory preflight. Tauri does attempt
  same-current-name/publisher HKLM MSI removal, but the early safety check knows
  only the destination and prior HKCU current-product root. It does not check
  the separately discovered MSI source directory. The old uninstaller's behavior
  and elevation/refusal still need an actual installed test; do not report all
  MSI migration code as absent or its safety as established.
- **Confirmed missing:** the runtime guard does not recognize the legacy
  `bantworks-mcp-launcher.exe` name, even if supplied that old directory. Fix
  and test that boundary before introducing a legacy uninstall handoff.
- **Confirmed missing:** arbitrary portable/custom installation adoption and
  reconciliation of multiple copies in the MCP installer. Hub's own refusal
  guards do not create those installer capabilities.
- **Confirmed limited:** client setup helpers target default client homes and
  replace managed server entries, preserving unrelated entries but not every
  custom field inside the managed entry. Alternate homes need explicit fixture
  coverage. Installation alone does not invoke these client setup helpers.
- **Correct as implemented, not a merge:** existing current launcher config wins
  over legacy config. Legacy import occurs only if current config is absent;
  two divergent project lists are not automatically combined.
- **Test gap:** the prepared CI config sentinel omits required `auto_start`.
  It proves opaque-file preservation only, not successful settings loading.
  Add a valid historical config and an isolated first writable GUI launch,
  separately from byte-preservation and read-only hosted acceptance.

The inference that old/new installations may coexist is plausible from identity
discovery, but it is not yet an observed installed-upgrade result. Keep both
functional migration and data-preservation acceptance pending.

## Public Baselines

The public MCP release inventory contains eight version tags and 13 Windows
installer assets. Test direct upgrades from each installer type separately;
an MSI baseline is not equivalent to an EXE baseline of the same version.

| Product | Version | Public installer baselines | Actual upgrade result |
| --- | --- | --- | --- |
| BANTWORKS MCP | 2.0.1 | NSIS EXE, MSI | Not run |
| BANTWORKS MCP | 2.3.0 | NSIS EXE, MSI | Not run |
| Creator Works MCP | 2.4.0-2 | NSIS EXE, MSI | Not run |
| Creator Works MCP | 2.4.0-3 | NSIS EXE, MSI | Not run |
| Creator Works MCP | 2.5.0 | NSIS EXE, MSI | Not run |
| Creator Works MCP | 2.5.1 | NSIS EXE | Not run |
| Creator Works MCP | 2.6.0-rc.1 | NSIS EXE | Not run |
| Creator Works MCP | 2.6.0 | NSIS EXE | Prepared, not run |
| Creator Project Setup | 0.2.2 | NSIS EXE, portable EXE/ZIP | Not run |

Primary inventories:
[MCP releases](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases)
and [Setup 0.2.2](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/releases/tag/v0.2.2).
Setup 0.2.2 is public, published 2026-09-10 at 12:14:13 UTC, even if not announced.
The new Hub-compatible Setup and Hub itself are still local development builds.
Do not delete/reclassify existing public assets to simplify the upgrade tests.

MCP standalone ZIPs, source checkouts and privately shared development installers
are additional discovery/configuration cases, not assumed NSIS installations.
Unavailable historical binaries cannot be claimed as tested. Unknown, modified
or multiple installations must preserve data and explain a recovery path, not
silently overwrite an executable or create a second installation.

## Scenario Coverage

Each supported baseline needs an isolated, hash-pinned direct-upgrade run and
settings/registration/payload comparisons. Also cover these distinct boundaries:

| Scenario | Required outcome | Status |
| --- | --- | --- |
| Clean Windows, no Creator apps | Hub alone unless companion installation approved | Pending |
| Existing compatible MCP / Setup / both | Detect exact installation; consent; no duplicate settings or app | Pending |
| Earlier MCP needs compatibility update | Show current/target versions, approved update then real hosted UI | Pending |
| BANTWORKS -> Creator Works | Preserve project list/settings/client entries; no conflicting second server or app | Product migration missing; legacy GUI guard missing |
| MSI -> NSIS, per-user vs per-machine | Correct product identity/location and explicit elevation; no silent duplicate | MSI source preflight incomplete; installed behavior untested |
| Standard-user Windows account | Either supported install or clear elevation handoff with no partial change | Pending |
| App or private Node is running | Refuse before old uninstaller/write; explain what to close | Guard fixtures pass; installed cases pending |
| Retry / Cancel, normal interactive installer | Retry rechecks; cancel preserves old files/settings/registration | Pending |
| Busy project/bridge operation | Finish accepted work; no forced Unity, app or client shutdown | Partial native tests; full adoption pending |
| Path with spaces, Unicode and special characters | Literal correct path handling and exact matching | MCP script fixtures pass; installed cases pending |
| Custom/portable path, old + new copies | Do not overwrite unknown files or install a duplicate automatically | Source guards; native installed cases pending |
| Disk full, denied access, antivirus/file lock | Actionable failure; no false success or unsupported rollback promise | Partial unit coverage; installed cases pending |
| Offline, corrupt/missing download, changed hash | Keep working standalone app, reject untrusted execution | Partial unit coverage; native flow pending |
| Cancel adoption / Not now | Existing standalone routing/settings unchanged | Full adoption pending |
| Repeated click, two launches, stale result | No duplicate install, window, mutation or stale consent | Launch tests pass; install/adoption pending |
| Crash/lost reply after accepted operation | Record unknown outcome, inspect result; never automatically replay | Durable recovery pending |
| Hub removed, missing or changed | Standalone remains usable; no routing loop or arbitrary EXE execution | Pending |
| Final installed payload | EXE/runtime/server/bridge match tested package; client config preserved | Pending |
| First launch and client setup after migration | Valid historical settings load; custom fields/default and alternate homes preserved or reviewed | Not covered by current opaque sentinel |
| Unity with updated bridge | Compile and harmless live command on selected disposable project | Final installed package pending |

Safe refusal is not successful upgrade support. Record separate functional,
data-preservation and recovery results; do not paint a blocked upgrade green.
Record unsupported scenarios explicitly instead of claiming "any version".

## Execution Rules

- Run real old/new installers only in disposable Windows environments, never
  over the user's working MCP, client connections or Unity projects.
- Download the exact published asset and verify its digest before execution.
  Test each baseline in a fresh environment; previous tests must not mask it.
- Capture baseline registry identity, paths, settings sentinels, files/hashes
  and owned process IDs. Use fake client configuration, not account credentials.
- Verify one intended installation, preserved settings/project choices, correct
  new payload, no unrelated process termination, and clear restart instructions.
- Silent automation does not cover installer pages, security prompts or
  interactive Retry/Cancel. Those need explicit native UI acceptance.
- A test-only branch push needs user approval. No release tags or uploads are
  implied. Publish only after exact final candidates pass the applicable gates.
- Windows x64 is the current target. macOS/Linux acceptance remains separate;
  Windows success is not proof of cross-platform installation or recovery.
