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

Setup currently rejects these installed versions. Its validator reports the
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

Status: pending real Unity execution. Three existing Unity editors were open
at preparation time; the user has been asked to save and close them. No newer
package compatibility is claimed yet. Source/unit checks do not replace the
real test or the final packaged install, migration, update and restart gates.

Keep published Windows bytes unchanged. Linux/Flatpak acceptance continues
separately. macOS remains outside this release.
