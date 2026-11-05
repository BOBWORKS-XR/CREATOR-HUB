# Existing-Project Package Qualification

## Scope

Qualify Creator SDK 4.0.22 with Visual Scripting 1.9.12 for existing-project
inspection, backed-up repair and validation in Unity 6000.3.21f1, URP 17.3.0
and Input System 1.20.0. Do not downgrade either requested package. Keep the
existing new-project recipe unchanged until a separate decision and test.

This is not qualification of all newer SDK/Visual Scripting versions, arbitrary
Editor versions, material conversion, graph behavior or multiplayer gameplay.

## Current Evidence

On 2026-10-21, the primary package registries returned:

- Creator SDK 4.0.22: Unity 6000.3; declared Visual Scripting dependency 1.9.1
  and URP dependency 17.4.0. Official archive SHA-1:
  `f5632dda91328e5a118a12efe6f448f53ffb26c3`.
- Visual Scripting 1.9.12: Unity 6000.0. Official archive SHA-1:
  `4edfcc09512f786fe1a7f50476d320b36dab9676`.

Sources: [Creator SDK registry](https://greenfield-registry.sdq.st/com.sidequest.creator-sdk)
and [Unity package registry](https://packages.unity.com/com.unity.visualscripting).
These metadata declarations do not prove the requested combination works.

Both archives were downloaded and matched their registry SHA-1 values; the SDK
also matched its published SHA-512. Original archives and the download receipt
are retained under
`artifacts/sdk-4.0.22-vs-1.9.12-source-2026-10-20T23-30-14-645Z/`.

At the start of qualification, Setup rejected these installed versions. Its validator reported the
actual SDK, URP and Input System versions, but does not separately report or
check the actual Visual Scripting version. Qualification must close that
evidence gap rather than relying only on the manifest request.

SDK 4.0.22 no longer uses the old global
`Banter_GeneratedVSNodesVersion` marker. Its own Visual Scripting setup check
now requires the project-local `NodesBuiltForThisVersion` stamp. Hub's existing
`ConfigureExisting` calls `UnitBase.Rebuild` without setting that stamp. The
SDK's public `SetVSTypesAndAssemblies` sets it, but clears custom selections;
calling that API alone would violate the preservation requirement.

Visual Scripting 1.9.12 initialization still assigns `Manifest.savedVersion`,
whose setter calls `configuration.Save`, including shared VS editor
preferences. The earlier SDK-marker-only restoration approval does not cover
these other preferences. A read-only check of that old marker is insufficient.

## Prepared Existing-Pair Fixture

The first guarded run prepared
`E:/UnityTest/CreatorSetupSdk4022Vs1912-20261021` with resolved registry packages
4.0.22/1.9.12 and both custom selections present. It stopped before
`ConfigureExisting`: normal Unity preparation changed the OpenXR settings asset.
OpenXR stayed at 1.16.1. Its source explains the exact observed feature sorting
and deserialization migration flags. The original run remains failed; it does
not prove that upgrading an old SDK preserves raw XR settings bytes.

The next test uses that first fixture as a read-only source and exclusively
creates `E:/UnityTest/CreatorSetupSdk4022Vs1912-Repair-20261021`. Admission binds
the exact original failed result and seed receipt, rechecks the original source
snapshot, and verifies all 50 original protected files. Only this reviewed
preparation substitution is accepted for `Assets/XR/Settings/OpenXR Package Settings.asset`:

- Original: `70b46e01cc0dff25bbe4eba004043b3546493497bcae15d257e357dce5a9e4f6`.
- Unity-prepared: `19ad8ebdd2e2018e5e8c577436ba7a8ed5d929d0c5fbe8045cdad237b542709b`.

The source assets and manifests are not rewritten. The measured existing-pair
repair requires unchanged protected bytes, including the prepared OpenXR asset,
through every phase. The prior scripts and status are not reused in the target.
The existing audit test name and final result fields remain unchanged. A fresh
SDK readiness result of `Done` is still required; no stamp is fabricated.

## Candidate Implementation

The initial shared validator template had a test-only branch for the exact requested
pair. It calls the SDK's public setup API, retains current and backed-up custom
selections, and only restores the SDK-authored node stamp after checking the
saved selections and rebuilt database. An exclusive before-image records only
that project-local stamp, including whether its API value was null. This is
recovery evidence, not an atomic transaction or automatic rollback.

The candidate waits for the package's background loader through its FIFO work
queue, without changing automatic-update preferences. Reopened validation checks
the resolved Visual Scripting version and the SDK's own readiness. Database
validation must deserialize node payloads: `UnitOptionRow.ToOption()` alone only
resolves metadata and is insufficient. A disposable, in-memory malformed-payload
case must prove rejection without editing the database or authored assets.

Both template branches compile against retained package assemblies. On
2026-10-23, the guarded prepared-fixture run passed actual candidate repair,
malformed-payload rejection and fresh-process validation. Its result is recorded
below. At that checkpoint, newer package admission was not enabled in normal
Setup. The subsequent normal-path qualification is recorded next.

## Normal Setup Qualification (2026-10-26)

Normal existing-project inspection now admits the exact 4.0.22/1.9.12 pair,
selects the qualified validator, and offers repair for a current failed SDK
readiness check. Missing partners use the matching tested pair. Mixed, unknown
and non-registry references are still refused; installed versions are never
automatically replaced. New projects retain the original 4.0.14/1.9.1 recipe.

The project-local `UserSettings/EditorUserSettings.asset` is included in stale
inspection detection and exact backups. Stamp recovery receipts are stored in
each operation's backup, not one fixed filename that prevents repeated repairs.
No automatic rollback is claimed.

The guarded normal-path test PASSED on a new disposable copy after the user
closed Unity. It exercised actual `repair::inspect` and `repair::run`: missing
node database repair, fresh-process validation, deliberately lost project stamp,
failed readiness detection, a second approved repair with a distinct backup,
another validation and a separate reopened SDK/custom-selection check.

- Both repairs retained SDK 4.0.22 / VS 1.9.12 with SDK readiness `Done`, 49,727
  verified node rows including 187 Creator rows, and custom type/assembly selections.
- The manifest, all 82 source files and all 50 protected target files matched.
- All 38 guarded shared VS preferences and the read-only legacy SDK marker
  matched byte-for-byte; zero restoration writes were required. No Unity process remained.
- Independent observation captured all 35 files in the first operation backup
  before repeat preparation and verified their exact contents after the complete
  run. Both stamp receipt schemas, versions and nullable before-images passed validation.

Evidence: `artifacts/sdk-4022-vs1912-production-20261026/production-qualification-1793047635772.result.json`,
SHA-256 `aec445f205179e90404d9c2f848870192cd20e8ffb4f5cb436d9557c81d0f976`;
`backup-observation-1793047830107.result.json` in the same folder.
The frozen target must not be reused or deleted. The result retains
`releaseAcceptance: false`: this proves the normal Setup code path on the tested
Windows Unity Editor, not a packaged Hub update or Linux Unity runtime.

## Acceptance

1. Inspect the exact package archives and their startup side effects. Do not
   modify global package-cache contents to make the test pass.
2. Use an exclusively created disposable project. Preserve the previous test
   fixture, all existing user projects, installed apps and AI-client settings.
3. Require no running Unity editors before the import. Determine the exact VS
   preference keys touched by initialization and obtain approval for their
   narrow backup/restoration, or use a separately isolated test account.
   Do not export the entire Unity preferences registry. The old SDK marker is
   read-only evidence for this pair, not a reason to write the registry.
4. Run ordinary SDK startup, without suppressing it through GREENFIELD_PROJECT
   or changing package source. Execute Setup's actual configuration/validation
   code, with the requested version expectation isolated to the test until
   qualification succeeds.
5. Check actual resolved SDK and Visual Scripting versions after a fresh Unity
   process opens the project. Verify nonempty Creator node data, retained
   custom type/assembly selections, the SDK's own Visual Scripting check being
   Done, and unchanged authored assets, GUIDs,
   scene, graphics/quality settings and project preferences.
6. Only after passing the above, add an explicit tested-pair policy. Keep
   unknown versions and Git/local references refused. Test missing-package
   plans, incompatible combinations, stale inspections and locked projects.
7. Repeat through production inspection, backup, repair and reopen validation
   after that policy change. Verify neither dependency was downgraded and
   every required backup matches its original.

## Release Boundary

The first guarded preparation remains failed at its strict preservation check;
its evidence was not rewritten. The subsequent prepared existing-pair repair
PASSED on 2026-10-23 after the user saved/closed Unity and a fresh process check
found no editors. The current guard suite passed 30 tests before execution.

The real run retained SDK 4.0.22 / Visual Scripting 1.9.12 and passed a separate
Unity process's validation: SDK readiness `Done`, 49,727 checked node rows
including 187 Creator rows, custom type and assembly selections retained, and
deliberately malformed node payload rejected. All 82 read-only source files and
50 protected target files matched. All 38 approved shared VS preferences and
the read-only SDK marker were byte-identical afterward; no restoration writes
were needed. No Unity process remained after completion.

Evidence: `artifacts/sdk-4022-vs1912-20261021/repair-qualification-1792768420930.result.json`,
SHA-256 `1892a7eaf13b7ae3ad527fc94ac2972eedc902c0241e92752f2d1ce9008fca7f`.
The result explicitly retains `releaseAcceptance: false`. The fixture and
original logs remain intact, including old database warnings before rebuilding
and the intentional malformed-payload exception. Do not rerun the fixed target.

Production pair admission, operation-scoped stamp evidence, repairable-readiness
detection and normal inspect/backup/repair/reopen passed the 2026-10-26 test above.
This is not a claim that the currently installed or published app contains the change.
Source/unit checks do not replace the real test or the final packaged install,
migration, update and restart gates.

Keep published Windows bytes unchanged. Linux/Flatpak acceptance continues
separately. macOS remains outside this release.
