# Incremental Visual Scripting

Assessment date: 2026-10-20. Planning only; no incremental tools are wired.
Keep this feature outside the frozen Linux 0.1.16 candidate and its acceptance
claims. Mill's ignored disposable API spike is pending evidence, not a passed
implementation or a supported-version declaration.

## Assessment And Existing Paths

- **Confirmed gap:** canonical `modules/mcp` has generation, whole-asset writing
  and validation, but no registered `inspect_vs_graph` / `edit_vs_graph`, complete
  resolved graph snapshot, or VS-specific incremental transaction/recovery tests.
- **Unknown:** the reported existing graph, installed Unity/VS/SDK versions,
  missing units, ports, references and failure mechanism. No project or graph was
  supplied or inspected. This assessment does not diagnose corruption or establish
  that the user's graph is unsupported.
- **Correct distinction:** creation/import validation is not incremental editing;
  generic scene Undo and Shader Graph rollback are patterns, not VS guarantees.

Source anchors refer to the inspected working tree; line numbers may move.

| Existing surface | Source and limitation |
| --- | --- |
| Schema and dispatch | [Tool schemas:128](../modules/mcp/src/tools/index.ts#L128), [dispatch:1759](../modules/mcp/src/tools/index.ts#L1759); the Unity validation command is sent at [2747](../modules/mcp/src/tools/index.ts#L2747) and handled at [bridge:955](../modules/mcp/unity-extension/Editor/BanterMCPBridge.cs#L955). |
| Generator | [generate-vs-graph.ts:218](../modules/mcp/src/tools/generate-vs-graph.ts#L218) constructs serialized graph JSON; [365](../modules/mcp/src/tools/generate-vs-graph.ts#L365) allocates fresh unit GUIDs. It is not an existing-graph API builder or round-trip editor. |
| Writer | [write-vs-graph.ts:49](../modules/mcp/src/tools/write-vs-graph.ts#L49) validates, then replaces the whole asset at [79](../modules/mcp/src/tools/write-vs-graph.ts#L79). Its generated asset has an empty object-reference array at [135](../modules/mcp/src/tools/write-vs-graph.ts#L135); no stale hash, persistent backup or Unity Undo transaction protects this path. Do not route edits through it. |
| Unity validator | [bridge:1468](../modules/mcp/unity-extension/Editor/BanterMCPBridge.cs#L1468) imports/loads a `ScriptGraphAsset`, returns asset GUID/dependency hash and counts, and inspects resolved value inputs at [1613](../modules/mcp/unity-extension/Editor/BanterMCPBridge.cs#L1613). Its [result schema:6972](../modules/mcp/unity-extension/Editor/BanterMCPBridge.cs#L6972) is not a full node/port/edge/reference snapshot; dependency hash is not the proposed exact disk hash. |
| Transport | [unity-bridge-transport.ts:54](../modules/mcp/src/lib/unity-bridge-transport.ts#L54) binds project/editor identity and avoids file fallback after a sent-but-unacknowledged pipe command. [index.ts:3405](../modules/mcp/src/tools/index.ts#L3405) distinguishes pending from completed. Reuse these contracts, not timeout-as-success or automatic resubmission. |
| Reusable patterns | [Shader Graph mutation:4961](../modules/mcp/unity-extension/Editor/BanterMCPBridge.cs#L4961) checks expected hash; [5473](../modules/mcp/unity-extension/Editor/BanterMCPBridge.cs#L5473) verifies byte recovery. These are Shader Graph-specific, not a VS adapter or durable VS backup. [Scene batch:3977](../modules/mcp/unity-extension/Editor/BanterMCPBridge.cs#L3977) groups Undo, but its [closed dispatcher:4036](../modules/mcp/unity-extension/Editor/BanterMCPBridge.cs#L4036) contains no VS operations. |
| Existing tests | [visual-scripting.test.mjs:354](../modules/mcp/test/visual-scripting.test.mjs#L354) covers duplicate/dangling serialized IDs; [426](../modules/mcp/test/visual-scripting.test.mjs#L426) covers writer metadata GUID preservation. [Port tests:13](../modules/mcp/test/bridge-visual-scripting-port-validation.test.mjs#L13) and [Shader Graph tests:42](../modules/mcp/test/shader-graph.test.mjs#L42) are source-contract checks. [Compatibility fixture:115](../modules/mcp/compatibility/obstacle-course/Editor/VisualScriptingCompatibilityValidator.cs#L115) checks import, attachment and scene reload, not incremental edits/Undo. None were executed for this assessment. |

## First Slice And Inspection Contract

- [ ] Introduce a versioned protocol and a closed, locally implemented VS API
  adapter. Admit only explicitly tested Unity + resolved VS package + relevant
  unit-assembly versions. Documentation alone does not establish compatibility.
  Unknown/missing units, failed definitions, invalid connections, ambiguous APIs
  or unsupported versions refuse; no generic `force` or fallback serializer.
- [ ] Start with one existing, persistent, project-owned `ScriptGraphAsset`
  beneath `Assets`. Refuse State Graphs, embedded scene/prefab graphs, nested graph
  editing, Play Mode, compiling/importing, linked/foreign paths and dirty target
  assets/open graph edits. Check dirty state before any forced import and again
  before mutation; never discard or save unrelated unsaved work.
- [ ] `inspect_vs_graph` returns asset GUID/path, adapter/version identity, unit
  and connection GUIDs, actual resolved control/value port keys and types,
  defaults, connections, variables, object references and existing layout/groups.
  Use asset GUID + element GUID + port kind/direction/key, never graph indices,
  instance IDs, generated JSON `$id` values or guessed catalogue ports.
  Include explicit supported operations/factories and refusal diagnostics so a
  client does not guess a capability from the package name or tool profile.
- [ ] Hash the exact disk `.asset` **and** `.meta` bytes using a versioned,
  domain-separated, length-framed SHA-256 input. Return their individual hashes
  too; bind the inspection to the selected project/editor, asset identity and
  adapter. Recheck file identity/bytes and loaded-versus-disk consistency; dirty
  refusal is required even when disk hashes match. Fail on incomplete inspection.
- [ ] Preserve null and persistent asset references by GUID + local file ID and
  expected type. Resolve/recheck through Unity. Refuse nonpersistent scene-object
  references in an asset; do not silently replace them with null. External/nested
  asset references remain references, never authorization to edit those assets.
  Preserve an unset/default target's self behavior separately from a connected
  null value; inspection and preview must expose that distinction.
  Encode 64-bit local file IDs as decimal strings, not lossy JavaScript numbers.

## Typed Edit And Transaction Checklist

- [ ] Add a small TS request/result module and closed bridge command handlers;
  wire schemas, dispatch, read/author groups and annotations only after acceptance.
  No arbitrary type/member invocation, reflection payload, C#, raw JSON/YAML
  patch or canvas automation. Internal version-specific API binding is not a
  caller-programmable reflection interface.
- [ ] Required initial operations: add an allowlisted node through a closed,
  version-specific factory, typed literal/default updates and explicit
  control/value connect/disconnect. Candidate factories are Sequence, Custom
  Event/Trigger Custom Event and ordinary null-check/branch units; only enable
  each after its actual constructor, configuration and ports pass native tests.
  Require finite explicit positions for new nodes; do not run automatic layout
  over existing content. Validate factory options before calling Unity setters
  that clamp counts, and read their actual ports back after insertion.
  Return newly assigned stable GUIDs bound to caller-local batch aliases. An
  inspection/rewiring-only increment is useful groundwork but does not complete
  this request: adding individual nodes is an explicit acceptance requirement.
  Set an initial maximum of 32 operations and 64 KiB request,
  with finite asset/element/reference/response limits measured in the spike before
  enablement. Reject oversized batches/snapshots, unknown fields, duplicate IDs,
  type mismatch and incomplete results. Treat an occupied control output or value
  input as a conflict: `ConnectToValid` may disconnect it implicitly. Require an
  explicit disconnect naming the expected existing edge/endpoints in this batch;
  never authorize replacement by a generic flag. `SetDefaultValue` may silently
  ignore an unsupported type: inspect its actual value/type after the API call
  and again after reload, not merely its return/exception status.
  Arbitrary node factories and deletion are deferred; any later deletion must refuse attached
  edges unless each disconnect is explicit, with no cascade or GUID regeneration.
- [ ] Preview applies the exact batch to a detached clone through the supported
  VS APIs and returns the semantic diff, warnings and a plan identity bound to
  operation bytes + inspection hash + adapter. Prove clone isolation, reference
  retention and GUID stability in the spike. Preview must not dirty/save the
  source, create backups/assets, change layout or add Undo entries.
- [ ] Apply requires that reviewed plan, expected disk hash and a bounded
  idempotency key. Persist a journal scoped to project/asset/key/request hash.
  Same completed key returns the recorded result; different payload reuse refuses.
  A semantic no-op does not rewrite the asset/meta or create an Undo entry.
  Pending/unknown dispatch is queried by its original command/project IDs, never
  retried automatically or reported as completed.
- [ ] Before mutation, persist and read-back-verify exact asset/meta backups plus
  the before-image/reference/semantic inventory and journal. Recheck expected
  hash, file/asset identity, versions and clean state after backup and immediately
  before applying. Backup failure or drift means no mutation.
  Keep recovery data in a dedicated project-local directory outside `Assets`,
  `Packages` and disposable `Library` caches. Reuse the existing project-scoped
  `.bantworks-mcp` storage contract without sharing result-file cleanup rules;
  do not auto-prune unresolved backups or journals.
- [ ] Apply once on Unity's editor thread through the VS API in one target-only
  Undo transaction using `RegisterCompleteObjectUndo`, not `RecordObject`, for the
  VS asset. In-memory Undo is not a disk transaction or durable backup. Save only
  the target asset, reimport/reload and inspect it again. Compare expected
  operations and every unaffected unit/edge GUID,
  reference, layout/group, variable and default; require unchanged asset GUID and
  `.meta` bytes. Normal editing uses Unity APIs, not byte rewriting or Save All.
- [ ] On failure, record the exact phase and attempt the owned Undo rollback;
  verify loaded and disk state. Exact backup-byte restoration is recovery only,
  never normal editing. Refuse restoration over a foreign replacement or later
  edit; retain backup/journal and report unknown recovery instead. Interrupted
  journals block new edits until explicit review; never auto-replay a batch.

## Required Evidence Before Wiring

- [ ] Disposable EditMode fixtures prove adding an allowlisted node, inspection
  identities/real ports, typed
  values/references, preview isolation, stale asset/meta and dirty refusal,
  unsupported versions/missing units, explicit edge semantics and size limits.
- [ ] Prove backups precede mutation, failed second-operation rollback, one-step
  Undo/Redo, target-only saves, cold reload persistence and unchanged unrelated
  graph content/assets/scenes. Inject save/import/readback/recovery failures and
  domain reload/interruption; retain exact before/after evidence.
- [ ] Test repeated/no-op/idempotency keys, conflicting keys and pending transport
  without duplicate application. A successful API call or changed inspector is
  insufficient without serialized reload/reference/GUID assertions.
- [ ] Review Mill's pending spike and its exact version/API/results first; no
  supported version is claimed here. Obtain a consented minimal graph and package
  versions separately to diagnose the in-the-wild report.
- [ ] Carry Dewey's package-source findings into that spike's pinned evidence:
  serialized `GraphElement.guid` versus unstable FullSerializer `$id`/`$ref`,
  occupied-port disconnection, default-value readback and VS complete-object Undo.
  The reported package 1.9.9 minimum of Unity 2021.3 is a package requirement,
  not tested coverage; the reported fixture uses Unity 6000.3.2 only. Neither
  establishes support for other Unity/package combinations or external guards.
- [ ] Keep generation (`generate_vs_graph` / `write_vs_graph`) separate. This
  feature does not prove graph runtime behavior, networking, multiplayer authority
  or synchronization. Custom-event names are reported trimmed/case-insensitive,
  with 0-10 arguments and no guaranteed receiver order; verify these contracts
  before adding event-specific operations or recommending event wiring. Do not
  infer multiplayer delivery/order or unknown external guard behavior from them.
  Release/native qualification remains with the parent task.

## Primary API References

Verified documentation on 2026-10-20; not an executed compatibility matrix. The
`@1.9` package pages currently identify themselves as VS 1.9.12.

- [ScriptGraphAsset](https://docs.unity3d.com/Packages/com.unity.visualscripting@1.9/api/Unity.VisualScripting.ScriptGraphAsset.html) documents its `Macro<FlowGraph>` base; [FlowGraph](https://docs.unity3d.com/Packages/com.unity.visualscripting@1.9/api/Unity.VisualScripting.FlowGraph.html) exposes unit and typed connection collections.
- [IGraphElement](https://docs.unity3d.com/Packages/com.unity.visualscripting@1.9/api/Unity.VisualScripting.IGraphElement.html) exposes `guid`; this does not prove that any chosen clone/mutation route preserves it.
- [Undo.RegisterCompleteObjectUndo](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/Undo.RegisterCompleteObjectUndo.html) documents object-state recording. VS serialization-specific Undo/Redo still requires the disposable tests above.
- [AssetDatabase.SaveAssetIfDirty](https://docs.unity3d.com/6000.0/Documentation/ScriptReference/AssetDatabase.SaveAssetIfDirty.html) documents saving a specified asset; the adapter must verify availability and target-only behavior on its admitted version.
