# Product Plan

## 0.1 - New Project Baseline

- Windows portable app and installer.
- Environment detection with exact missing requirements.
- Guarded creation from Unity's installed URP template.
- Pinned Creator SDK registry installation.
- Android active by default, with Android and Windows support both mandatory.
- Batch compilation and a local receipt.
- Initialize Creator Visual Scripting and validate it in a second Editor session.
- Real setup stages and elapsed time; explicit completion/Open/Create another states.
- macOS/Linux packaging and detection preview.

## 0.2 - Hub Registration and Repair Preview

- Inspect an existing project without changing it.
- Show a proposed compatibility repair.
- Reject open projects, stale reviews, links and incompatible versions.
- Back up manifests, project settings and generated Visual Scripting data before
  an approved repair or Unity validation; verify backup file hashes.
- Merge custom Visual Scripting selections and verify them on reopening.
- Re-run package, compilation, render-pipeline, and platform validation.
- Register completed new projects using a pinned, checksum-verified official
  Unity CLI helper with a compatible desktop Hub. Require Hub 3.21.1+, distinguish
  CLI records from UI visibility, and allow independent retry. Older Hubs keep the
  manual Add-from-disk route; do not present CLI-only records as desktop success.
- Do not edit Hub's private database or silently link Unity Cloud.
- Windows 0.2.2 adds an explicit confirmed Hub restart to reload the running
  list; it never force-closes Hub or targets Unity Editors.

Still required before promoting repair beyond preview: broader existing-project
fixtures, recovery UX, third-party package callback coverage, and native
macOS/Linux acceptance. Backups are selective; failure recovery is manual.

## 0.3 - Optional Creator Hub Compatibility

- The approved [Creator Hub plan](CREATOR-HUB-PLAN.md) replaces reciprocal
  installer prompts as the primary direction. Hub installs, opens and updates
  independent tools; Setup remains fully usable without it.
- Add pre-GUI, read-only app identity/version reporting with no project or
  settings changes. Coordinate identical field names with Creator Works MCP.
- Make Windows re-open focus the current GUI without losing its form or work.
- Publish verified release descriptors in a later packaging pass so Hub can
  compare installed and available versions independently of its own version.
- Keep project handoff, bridge installation, native GUI embedding, and the
  Coming Soon URP Converter outside the first compatibility change.

## Next Priority - Prerequisite Installation Candidate

The Windows-first alpha.6 implementation is now a published prerelease. Alpha.3
installation evidence is retained; alpha.4 adds download size/rate visibility,
and alpha.5 refreshes the installed requirements before project import. Alpha.6
adds the Hub menu correction. Clean CI and actual installed upgrades from stable
0.2.2 and prereleases alpha.1/alpha.2 have passed, along with a fresh prerequisite
installation/reuse/JDK-repair run and paired Hub staged native tests. See the
[candidate flow and release gates](PREREQUISITE-CANDIDATE.md). The historical gap
below still describes published alpha.2; do not treat the candidate as released.

On 2026-09-11, the approved disposable Windows test installed the actual pinned
Hub, Editor and required tools, reused the installation, repaired isolated
OpenJDK damage, executed Java/javac/ADB/NDK clang and required an activation
handoff without using an account or creating a project. A separate healthy-PC
project creation/reopen smoke passed. These are two separate results, not proof
of the complete fresh-user account-to-project flow. Native sign-in/UAC and that
combined flow remain stable-promotion gates; the prerelease documents those
limits. Acceptance of the paired Hub build remains a prerelease gate.

Historical starting point: a fresh-PC report on 2026-09-11 shows Unity Hub 3.13.0 present but the pinned
Editor, modules and template absent. Source inspection confirms that the app
only probes those requirements and opens Hub; it never runs an Editor/module
installation. This is a gap against the intended beginner setup workflow, not
evidence that the user used it incorrectly. The diagnostics alpha.2 hotfix does
not add prerequisite installation.

Original Windows-first implementation plan:

- Offer one explicit **Install requirements** action. Preview the exact Editor,
  required Android/Windows components, install location and available disk space.
  Keep Android and Windows mandatory. Do not install unrelated optional tools.
- Reuse Unity's official CLI, with a reviewed version and verified download.
  Validate its actual command contract before implementation. The existing
  registration helper is pinned, but its 45-second registration runner is not
  suitable for long Editor installs and must not be reused unchanged.
- Install the pinned Editor when absent; add only missing compatible modules to
  an existing managed installation. Preserve other Editors/projects. Do not
  uninstall or overwrite a manually installed Editor to make it manageable.
- Handle missing/old Hub explicitly. Keep Hub's automatic-project-registration
  version gate separate from the Editor installation prerequisites. A missing
  Editor should not look like six unrelated faults; an optional Hub feature
  should not look like a mandatory project-creation failure.
- Show real download/install stages and local logs. Handle disk-full, network,
  permission, cancellation and partially installed states with a new inspection
  before retry. Never infer success from a launched command or exit code alone.
- Keep Unity sign-in, licensing, third-party module agreements and OS elevation
  explicit. Do not bypass these prompts, force-close apps, change security/proxy
  settings, or automatically accept terms.
- Re-probe the executable, required tools and URP template after installation,
  then enable the existing project creation and second-session validation flow.
  A missing template must have an evidenced supported recovery route.

Acceptance must cover a clean machine, Hub-only (including older Hub), missing
modules, a complete existing installation and a manually located Editor. Test
failed download, disk-full/insufficient-space, denied elevation and a safe retry.
At least one disposable real Windows test must install the pinned Editor and
required modules, create a Creator SDK project, initialize Visual Scripting and
pass reopen validation. Existing app installer/hosting tests do not prove this.
macOS/Linux installation remains separate until tested natively.

Primary references checked 2026-09-11:

- [Unity CLI installation and module commands](https://docs.unity.com/en-us/unity-cli/use-unity-cli)
- [Unity CLI command reference](https://docs.unity.com/en-us/unity-cli/unity-cli-reference)
- [Unity's Hub bootstrap reference](https://github.com/Unity-Technologies/skills/blob/main/skills/unity-cli/references/config-hub.md)

The CLI is experimental. Documentation establishes an official automation route,
not proof that every supported PC or the pinned helper already works end to end.

## Next Safety Pass

- Add project/cache volume free-space preflight and a clear disk-full failure.
  A packaged 0.2.2 test on F: failed during UPM extraction with `ENOSPC`; Setup
  preserved the failed folder/logs but only reported a generic Unity failure.
  Do not auto-delete unrelated content or retry a partial project as new.

## Later

- Tested macOS and Linux installation workflows.
- Signed/notarized packages.
- SideQuest-maintained compatibility recipe feed with integrity metadata.
- Safe SDK upgrades with preview, backup, rollback, and migration checks.
- Team presets and optional starter samples.
