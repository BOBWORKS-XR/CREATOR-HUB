# Adoption Contract Review

2026-09-10, proposed next contract. Not implemented or a claimed capability.
Coordinate with the MCP owner before enabling writable hosted operations.

## Verified Current Boundary

- Hub has per-app native sessions, command allowlists, decoded packaged UI,
  sandboxed persistent views and command-scoped native operation guards.
- Hub now accepts only no args or `--open-app mcp|setup`. These select a view
  and focus the existing Hub. They never grant installation or mutation rights.
- Setup hosting calls the same native implementations as standalone. MCP's
  current preview remains read-only and can coexist with the installed GUI.
- Release descriptors authenticate exact installer and launcher hashes, but
  do not yet advertise a production hosting/adoption protocol.

## Proposed Compatibility and Consent

1. Extend the signed release descriptor with an explicit hosting revision and
   mode. Missing means unsupported, never inferred from a version or file name.
   Read-only preview capability must not satisfy full-adoption requirements.
2. Detect installed apps through existing verified inventory. Consent shows
   exact app, current version and any compatibility update needed. Unknown
   copies remain untrusted until selected and verified; never overwrite them.
3. Update only selected apps using the existing verified installer pipeline.
   Required client/GUI quiescence must be checked before the old uninstaller.
   A download or a successful installer exit is not completed adoption.
4. Start the verified app, await the real UI-ready handshake and current native
   state. Commit adoption only after successful initialization and consent.
   Failed, declined or incomplete updates leave standalone routing unchanged.
5. Persistent adoption records refer to one app installation and one settings
   location. They contain no AI-client auth, project contents or copied settings.
6. Standalone shortcut routing must verify Hub's release identity and actual
   executable before using its path. A writable receipt alone cannot authorize
   launching an arbitrary executable. Missing/unverifiable Hub falls back to
   standalone, with a clear recovery message rather than a launch loop.

## Mutable MCP Lifecycle Gate

Hub's current Manager guard covers one native command, not the gaps between an
app's `begin_ui_operation` and `finish_ui_operation`. Enabling the whole MCP
allowlist without addressing this would leave a possible close/update gap.

- App UI-operation leases must be tracked in the owning native hosted session.
  Hub close/update/handoff remains blocked across the complete UI operation,
  including awaited multi-command sequences and native dialogs.
- Client-owned MCP stdio servers remain independent. Showing/switching the MCP
  view never recreates or terminates those servers or changes Unity bridges.
- A writable hosted MCP GUI cannot coexist with another writable GUI for the
  same settings. Read-only coexistence is not proof of writable safety.
- EOF/disconnection is not cancellation. Complete any in-flight native work,
  record its actual outcome, and release only this hosted session's GUI leases
  when safe. Do not strand a backend with an unfinishable GUI lease, force-kill
  the process, or replay a mutating command automatically.
- Persisted form/result handoff needs a bounded, versioned app-owned schema.
  New hosting must be ready before retiring an existing idle presentation.
  Hiding a window, saving config alone, or resetting the form is not state transfer.

## Required Acceptance Before Publication

No apps, compatible app, older app, mixed versions, declined consent, cancelled
download, failed installer, changed executable, missing Hub and offline start.
Also test two simultaneous launches, long operation plus shortcut/view switch,
backend failure between UI-operation commands, stale result/consent receipts,
normal Hub removal and preserved standalone behavior/settings.

Use owned disposable fixtures and package snapshots. Native in-headset Unity
behavior is outside desktop installation acceptance and must not be implied.

## Owner Review

MCP owner reviewed and agreed to these gates on 2026-09-10 against its source.
Next MCP-owned slice is exclusive writable-GUI ownership, session-owned workflow
leases and safe disconnect draining/result recording. The mutable allowlist
stays disabled until both sides enforce the same contract and acceptance passes.
`finish_ui_operation` is MCP's existing command name. Current read-only behavior
is not a defect; the missing writable lifecycle must not be bypassed.

Agreed next transport shape, not yet enabled:

- `initialize.args` adds `hostingRevision: 2` and
  `requestedMode: "read-only" | "writable"`; reply echoes `hostingRevision` and
  `effectiveMode`. Existing MCP preview protocol 1 `initialize {}` stays read-only.
- Signed release capability proposal: `hosting: { revision: 2, modes: [...] }`.
  Missing, unsupported, duplicate or unknown modes confer no authority. Do not
  publish a writable capability before that mode passes its acceptance gates.
- Native event envelope: `type: "event"`, `name: "creator-mcp-lifecycle"`,
  `session`, and `payload: { revision: 1, sequence, state, workflowActive,
  commandsInFlight }`. State is `idle`, `busy` or `draining`; sequence is a
  monotonic uint53, count is uint32, total frame is at most 512 bytes. No paths,
  client configuration or project contents belong in these notifications.
- Hub reserves its operation guard before forwarding `begin_ui_operation` and
  retains it across command gaps. Matching finish and drained native work are
  required; an idle event alone never unlocks the host or authorizes mutation.
