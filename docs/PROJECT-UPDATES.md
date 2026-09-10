# Project SDK and Unity Updates

Status: requested next capability, not implemented. The Projects page currently
discovers projects and opens their exact installed Editor version. No SDK or
Unity version is changed by browsing, refreshing or opening a project.

## Projects Page Entry

Add an **Updates** action for each project once a working reviewed upgrade flow
is available. It opens one project-management view, not a silent updater:

- Current SDK family, package reference and resolved version when available.
- Current Unity Editor version and whether the target Editor is installed.
- Approved target SDK/Unity combinations, with compatibility notes and release
  information. Do not recommend newest solely because its version is higher.
- Separate SDK and Unity choices where the approved compatibility matrix allows
  independent updates. Show coupled changes together when one requires the other.
- A precise change preview and an **Upgrade a copy** action after inspection.

Git/local/embedded SDK references are distinct from registry versions. Do not
replace a development checkout, floating Git ref or embedded package silently.
An unavailable release feed is unknown, not 'up to date'. Missing/corrupt project
metadata must show a recovery step instead of an enabled upgrade button.

## Ownership

Hub owns project selection, navigation and app orchestration. Project Setup owns
the inspect/plan/backup/upgrade/validation implementation so standalone users get
the same behavior. Pass the selected project through a validated native handoff;
do not infer mutation consent from opening a view or replace an existing busy
Setup form. This extends the hosted contract after its lifecycle gates pass.

Current Setup repair is intentionally not an upgrade engine: package_plan blocks
unapproved SDK references, and inspect blocks a different Editor version. Its
existing settings backup is not a full backup of content Unity may reserialize
during an upgrade. Do not remove those checks or relabel Repair as Update.

## First Supported Flow

1. Inspect the selected project read-only. Identify installed SDK family, source
   reference, Unity version, render pipeline, package constraints, project locks,
   active Setup/MCP operations, available disk space and target Editor/modules.
2. Offer only supported source-to-target combinations. Display missing Android
   and Windows build requirements and their separate installation consent.
   Editor installation uses a verified official mechanism and never uninstalls
   an existing Editor. No auto-download while merely listing projects.
3. Show the selected target versions, dependent package changes, expected
   migration steps and destination. Require explicit approval for this plan.
   SDK-family conversion, pipeline conversion and downgrades are not implicit.
4. Close the selected source project normally before preparing its copy. Never
   force-close Unity or AI clients. Refuse active/interrupted operations. Check
   the reviewed configuration fingerprint again immediately before proceeding.
5. Create a separate destination without overwriting an existing folder. Preserve
   authoring content, .meta GUIDs, Packages, ProjectSettings and required local
   dependencies. Identify external file dependencies, symlinks/junctions and
   ambiguous files first; block unsupported layouts rather than produce a copy
   that still modifies the source through shared files. Exclude regenerable
   caches only under an explicit copy policy. Show size/progress/cancellation.
6. Modify only the copy, apply the reviewed package changes and let the selected
   Unity Editor perform its actual upgrade/import. Editing ProjectVersion.txt
   alone is not an Editor upgrade. Run compilation and targeted validation,
   including SDK nodes/references, the actual pipeline and both build targets.
7. Keep per-stage logs and a durable outcome. Reopen and validate the copy before
   offering it as the upgraded project. A failure leaves the original unchanged
   and reports the copy's partial/unknown state without automatic replay.
8. Register the successful copy as a separate project with provenance to its
   source. Do not automatically switch MCP connections, overwrite the original,
   remove its Hub entry or claim headset/multiplayer behavior is verified.

The first implementation should target a small tested compatibility matrix and
upgrade copies only. Arbitrary Unity versions and in-place upgrades are later
capabilities requiring additional acceptance; a settings-only rollback cannot
promise to reverse a Unity-wide asset upgrade.

## SDK Boundaries

- Creator SDK / Altspace: update within supported Creator SDK versions.
- Banter SDK: keep the Banter family unless conversion is explicitly selected.
- Mixed families: report the conflict and require a reviewed conversion plan.
- Built-in to URP: Creator Converter's responsibility, not an incidental SDK
  update. Do not rewrite materials or scenes to satisfy an upgrade prerequisite.

## Acceptance Before Enabling Update

- Unit fixtures for exact, older, newer, Git/local/embedded, mixed SDK and invalid
  metadata; source fingerprints, stale plans, locks and unsupported combinations.
- UI tests for separate/coupled selections, compatibility warnings, missing Editor,
  explicit consent, duplicate clicks, failure/cancel/retry and preserved forms.
- Disposable real projects for each supported upgrade route, including scenes,
  prefabs, Visual Scripting, custom scripts and representative dependencies.
- Hash comparisons proving the original authoring files remain unchanged;
  copying/importing failures, disk exhaustion and external-path refusal tests.
- Exact target Editor and SDK readback, compilation and reopen validation on the
  copy. In-headset, hosted loading and multiplayer testing remain separate.
- Native hosted and standalone operation protection, progress and crash outcome
  recovery. Never advertise universal upgrade compatibility from one test project.

This work does not lower the existing installer/migration/adoption release gates.
