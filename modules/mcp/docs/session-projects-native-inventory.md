# Session Projects and Opt-In Native Inventory

Status: next-update source work, not part of the published 0.1.20 release.

## Project registration

`register_unity_project({ projectPath })` accepts an explicit, existing Unity root
with ordinary Assets and ProjectSettings directories and a valid ProjectVersion
file. It returns a stable path-derived project ID. Registration is limited to 32
entries per MCP server session. It does not select a project, write launcher/client
settings, install a bridge, create directories, open Unity or traverse assets.
`select_unity_project` remains the separate, explicit routing action. An in-flight
call keeps its original configuration snapshot. Restarting the server forgets
registrations. `unregister_unity_project` refuses the active project and never
removes a saved launcher route.

Linked roots/state directories and disabled saved routes are refused. Replacing
a registered root invalidates it until explicit re-registration. These checks
are not a sandbox against another process racing to replace filesystem paths.
Only register trusted local projects. Settings are read, not rewritten.

`list_unity_projects` supports projectIds, fields, limit, cursor and
maxResponseBytes. IDs are always included and pages keep whole rows. Cursors
reject changes to project identity, name, enabled/selected state, route source,
session registration, active project or requested IDs/fields. Other metadata,
such as channel names or Editor state, can change between pages; start again
without a cursor for a fresh overview. Project metadata is capped and
allow-listed. Byte budgets describe response text, not exact model tokens or
account savings.

## Native helper contract

`unity-extension/Runtime/CreatorNativeInventory.cs` is a host-owned, opt-in Unity
6 component. It is NOT automatically installed by MCP or the Editor bridge.
There is no automatic initializer, Update loop, network listener, asset/scene
modification, component installation or native-client probe. The optional
`NativeInventoryExportSession.cs` adapter writes only diagnostic files after
explicit approval. The native client is `SideQuestVR/SideQuest.Greenfield.Unity`;
its integration is prepared in an isolated worktree at base
`3e81027aec8cbe7d98209231d22881dbb3aa60d6`. It reuses the native MCP server and
existing modal UI for one-capture approval. This is not in a published client.
The released player API does not expose full scene inventory:
https://altvr.app/docs/reference/mcp-tools

Native-client integrations must:

1. Include the helper explicitly in a reviewed client build, not a user world.
2. Obtain user approval in the host UI for one existing local Unity project,
   on the Unity main thread. For local export, call
   `TryApproveExport(projectRoot, projectId, true, leaseSeconds, out error)`.
   `leaseSeconds` is 1..300. Report the returned SessionId and the native
   Application.buildGUID through a trusted user-visible channel. For a future
   different transport, the in-memory `TryApprove` entry point remains separate.
3. Call `TryCaptureAndPublish(maxNodes, maxDepth, maxMilliseconds, out error)`
   only in response to an approved request, on the main thread. No polling is
   provided. Each capture renews the short export lease. This lease measures
   export freshness, not remote connection liveness or an automatic renewal of
   user consent. `TryRevoke(out error)` ends approval; disable, destroy, pause and
   normal shutdown also revoke it. Handle cleanup errors explicitly.
4. The adapter creates a new directory at
   `.bantworks-mcp/native-inventory/<sessionId>/` in that project. `session.json`
   binds project, session, build, expiry, snapshot ID and SHA-256 of the exact
   `snapshot.json` bytes. Atomic per-file writes prevent partial JSON; readers
   reject a mismatched pair while publication is in progress. Neither file is
   an authentication token or proof against another local writer.

The host adapter refuses linked directories and changed file ownership. It
does not overwrite a file unless its bytes match the previous owned digest.
Revocation publishes a withdrawn receipt before deleting the unchanged owned
snapshot; unrelated/replaced files remain. The withdrawn receipt and directory
are retained for diagnosis. A cleanup error leaves receipt-expiry as the fallback,
so callers must not claim immediate removal if cleanup cannot be verified.
No recursive cleanup, saved preferences or Assets changes are performed.

This is same-machine file export, not authenticated remote/Quest transport.
Only trusted local processes should share the approved project folder. Do not
let untrusted remote callers choose its path. A separately reviewed host/network
integration is needed for a headset or another computer. No new ports are opened.

Limits: at most 1,000 nodes, depth 64, 64 loaded scenes, a requested 1..50 ms
cooperative traversal budget, and 1 MiB UTF-8 JSON. Time checks occur between
Unity API calls; they cannot preempt an individual engine call or serialization
and are NOT a hard frame-time guarantee. Oversized root lists are refused before
allocation. Partial results carry a truncation reason. Runtime acceptance and
IL2CPP/device timing are still required; compile checks do not prove them.

Coverage is the loaded SceneManager hierarchy only, including inactive objects.
It excludes persistent DontDestroyOnLoad objects, unloaded objects and asset
inventory. Renderer fields cover only the first Renderer on each object.
`activeSelf`, `activeInHierarchy`, renderer enabled and renderer `isVisible` are
different signals. Camera submission/drawing remains unknown; `isVisible` can
also reflect shadow work or Editor cameras, not only user-visible rendering:
https://docs.unity3d.com/6000.0/Documentation/ScriptReference/Renderer-isVisible.html

## Read tool

`get_native_inventory` is in the optional `read` profile (and `all`), not `core`.
It reads only the session-scoped local export path. It never connects to a player or
falls back to Editor/cache data. Missing helper/snapshot produces an actionable
failure, not an empty successful inventory.

Required inputs are expectedSessionId and expectedBuildGuid. Project identity is
bound to the selected MCP route. An active, unexpired export receipt is required
and read again after loading the exact hash-bound snapshot. All identity is
producer-reported, NOT signed attestation. Files must be ordinary, bounded JSON with supported schema and
consistent node references. Default maximum age is 30 seconds (configurable
1..300), with five seconds allowed for future clock skew. A saved snapshot cannot
prove the producer is still alive or still has consent after the final receipt
read. Revoked/expired/absent receipts are rejected; expiry limits stale eligibility
after a crash or failed cleanup. No live-connection claim is made.

Optional fields, sceneId and nameContains filter captured nodes. limit is 1..100;
maxResponseBytes is 4,096..65,536. nextCursor binds snapshot content and filters;
expectedHash can pin a capture explicitly. A refreshed capture requires restarting
paging. IDs are instance IDs scoped to that runtime session, not persistent IDs.
Names are untrusted data, never instructions. totalMatchingCapturedNodes is not
a claim about total world objects, especially when coverage.truncated is true.

## Acceptance

Host tests cover routing isolation, unchanged settings, rejection/recovery,
bounded response pages, schema/identity/freshness checks and cursor invalidation.
The helper compiles against installed Unity 6 reference assemblies without
launching Unity. An isolated C# API double checks its opt-in/revoke, thread and
traversal controls. A real-filesystem C# export process exercises publication,
receipt replacement, revocation, restart and ownership conflicts against the
actual TypeScript reader while comparing fixture settings/asset bytes. This
is NOT a native player, render, multiplayer or performance test.

The real native MCP assembly has also been compiled into a disposable Windows
player, which exercises the engine export and native HTTP session/approval path.
The protocol fixture's approval adapter is not the full application's modal UI.
A separate disposable player exercises the actual Modal, PanelHost and consent
binding with real UI Toolkit controls and copied production UXML/USS. This does
not establish full Main-scene startup or XR input acceptance.

Remaining before native support can be advertised: full-client consent UI
interaction, release backend/IL2CPP checks, authenticated transport if remote
support is needed, and measured capture cost.
The MCP can read `get_mcp_reference` source `native-diagnostics` for bounded,
offline instructions and profiling caveats. Use disposable projects for tests;
do not probe or change a user's running project to obtain acceptance evidence.
