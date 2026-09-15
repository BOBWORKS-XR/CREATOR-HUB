# Creator Plugins handling and acceptance

Status: alpha.8 packaged acceptance in progress, 2026-09-15. Public Hub
publication is paused until the exact installer upgrade and packaged Unity
flow pass. The candidate enables experimental menu installation and reviewed
imports; native consent and all catalogue/project guards remain in place.

Current measured results and the captured Windows publication failure are in
[PLUGIN-ACCEPTANCE-20260915.md](PLUGIN-ACCEPTANCE-20260915.md).
The bounded publication fix and 1,000 successful stress installs are recorded in
[WINDOWS-HELPER-PUBLICATION-20260915.md](WINDOWS-HELPER-PUBLICATION-20260915.md).

## Boundaries

- Categories describe contributions, not installation destinations.
- Unity asset packages retain their original paths and GUIDs. Desktop transfer
  only queues a verified package outside Assets; Unity performs interactive file
  selection. Never save scenes or report queued files as imported.
- ZIPs, UPM packages, MCP servers, AI skills and recipes must not be treated as
  Unity asset packages. Instructions remain available; no client configuration,
  credentials, executable startup commands or package manifests are changed.
- Schema 1 stays compatible with released consumers. A future typed installation
  contract needs versioning and separate client/scope/ownership adapters.
- Preserve installed apps, project settings, existing helper versions and old
  test evidence. No forced shutdown of the running Burger/Blamb Editor.

## This Pass

1. Inspect downloaded Unity archives before desktop transfer: bounded gzip/tar,
   valid GUID records, Assets-only destinations, no traversal/links/duplicates,
   code and scene inventory. Show existing destination warnings for the selected
   project. This is structural review, not code safety or SDK compatibility proof.
2. Make each contribution's destination explicit in all three apps. Only supported
   Unity contributions get Unity controls; AI/MCP/ZIP/recipe items use instructions.
   Add per-category incorporation steps. In Unity, preview selected graph/prefab
   moves, reuse a Visual Scripting/VS or Prefabs folder, or create it after consent.
   Use AssetDatabase moves, never external moves of assets or their meta files.
3. Keep loading, cancellation, failures and unresolved import outcomes distinct.
4. Run one acceptance matrix: parser and routing tests; UI tests; native tests;
   Unity 2022.3.39f1 and 6000.3.21f1 compile/protocol tests; fresh interactive
   fixtures for cancel, text and C# reload. Record actual results, not intentions.
5. Inspect Egon's package against Lookout's Creator SDK 3.2.17 and Burger's Banter
   SDK 3.1.2. Do not upgrade SDKs or rewrite graphs to make a test pass. Use fresh
   disposable fixtures for destructive or incompatible cases.

## Acceptance Evidence

- Cancellation: terminal cancelled receipt, no payload asset, no scene changes.
- Text import: terminal imported receipt and exact imported text.
- C# import: terminal receipt survives reload; compiled type/value and an assembly
  reload after review are observed. A source file alone is insufficient.
- Busy/recovery: no duplicate import, no automatic retry, unknown stays unknown.
- Native/Desktop: forged entry IDs, stale metadata, checksum failures and invalid
  formats cannot write project files; UI-only hiding is not an authorization gate.
- Protected projects: inspect exact versions and dependencies before selection;
  record file hashes/backups before any approved write. Never open/save scenes.

## Deferred Installation Adapters

Skill bundles require validated SKILL.md, explicit client and project/user scope,
collision handling and rollback ownership. MCP servers additionally need reviewed
startup/remote transport settings and explicit execution consent. Existing MCP
client setup serializers are not general-purpose installation/removal adapters.
UPM needs dependency/conflict review and a backed-up manifest transaction. These
remain instructions-only until their separate contracts and tests exist.
