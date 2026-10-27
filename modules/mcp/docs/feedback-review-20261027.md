# Feedback Review: 27 October 2026

## Included Source Changes

- **Confirmed missing preflight:** `set_object_reference` requires a GameObject
  owner in both its advertised schema and Unity implementation, but direct tool
  calls could bypass the schema and queue a component-ID-only request. The server
  now rejects a missing/blank owner before dispatch and explains the requirement.
  No component-ID-only resolution or Unity mutation semantics were added.
- **Correct schema; incomplete guidance:** diagnostic `maxResponseBytes` already
  enforces 16384-4194304 bytes, default65536. The shared public description now
  repeats those bounds and explains that the budget is a ceiling, not a minimum
  response size. No limit was reduced or diagnostic omission hidden.
- **Confirmed evidence gap:** an idle heartbeat and previous compiler result do
  not establish that a queued refresh/new C# change finished. Explicit
  `afterCommandId` and `sinceTimestamp` boundaries now reject pending commands,
  stale compiler evidence, missing completion timestamps, failed commands and
  foreign project/Editor evidence. Refresh returns its original ID, request time
  and a follow-up action. Bare waits retain their old idle-read semantics; there
  is no automatic refresh, compiler trigger, request resubmission or Unity code
  change. See [compile-waits.md](compile-waits.md).

## Recorded But Separate

- **Observed cost; proposed feature:** repeated unchanged compiler warnings in
  Editor-menu results merit an explicit compact/changes-only diagnostic option.
  Do not silently truncate mutation receipts or hide error counts. No default
  response-format change or token/account-saving claim is included here.
- **Proposals needing native qualification:** bounded runtime Visual Scripting
  variable/native-sync inspection, structured custom-helper assertion receipts,
  desktop/XR test preflight and climbable-ledge authoring remain separate features.
  Custom menu execution is not proof its assertions, uploads or room joins passed.
- **Project/SDK, not generic MCP repairs:** cooked animation compatibility,
  local-head camera references and the SDK upload timeout text belong to their
  owning projects/SDK. Their reported local results do not establish multiplayer,
  headset or general conversion acceptance. No user projects were modified here.

## Test And Release Boundaries

The new explicit compiler-boundary regression failed against the prior built
JavaScript and passed after the source correction. Focused Node tests cover
pending/old/failed/foreign results, successful boundaries, preserved errors,
unchanged queued commands and diagnostic/owner contracts. Native Unity acceptance
is still separate. Do not promote these checks to gameplay or domain-reload proof.

The already tested Windows V5 installer is immutable and does not contain these
later MCP changes. They require a newly source-bound server payload and Linux
candidate, followed by platform-specific install/migration/update/restart tests.
Published and installed Windows applications are unchanged; no Mac work.
