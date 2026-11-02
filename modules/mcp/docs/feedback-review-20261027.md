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

## Later Feedback Intake

The separately developed optional ledge tool is not in frozen product085. Review
found a retained-result reader that accepted missing/non-boolean `success`.
A two-file strict-boolean follow-up reproduces six failures before the guard and
passes 11 focused tests afterward. Its patch and source receipts are under
`artifacts/feedback-linux-20261027/phase/ledge-retained-success-01`.
This is a prepared next-revision correction, not an installed or native-qualified
feature. The supplied native run also needs explicit run-to-bundle hash binding;
matching a bundle file alone does not establish which run used it. Integrate the
feature and correction together through normal bundle/Unity/Hub gates, not by
patching an immutable runtime or adding it silently to the signed candidate.

## Live Docs Relevance

Live qualification found a matching SetSpaceState section whose excerpt ended
before the match. A narrow source correction now relocates only non-hit-bearing
query excerpts toward the actual term, preserving real offsets, content hashes,
revision checks, Unicode and response limits. The two new rejection/regression
cases failed before the change;25isolated factory and37focused checks passed
afterward, including exact continuation. Whole MCP no-emit type checking passed.
Captured live responses were replayed without new requests. The correction is
source-only and is not in frozen085/dce or an installed/published application.

## Device Performance And Capture Boundaries

The newer Backrooms feedback reports low Quest FPS and high SDK/world logging.
No new MCP defect was source-proven. The Editor bridge retains incoming messages
and stacks; it cannot add missing scene/object or retry-target identities that
the SDK did not supply. Producer-side diagnostic improvements need the exact
emitter source, bounded summaries and tests that preserve failures.

`get_console_logs` reads a retained Editor snapshot, not a Quest FPS probe or
lossless event counter. The bridge keeps 500 entries; filtering and reply-byte
limits do not reduce SDK log production. Retained counts cannot prove a complete
log rate, and fewer returned bytes do not establish performance or token savings.

For a separately authorized performance-sensitive repair, compare short device
captures with the same client/world bytes, refresh mode, room/player state and
warm-up. Record actual duration, FPS and complete-log category rates; identify
sampling gaps and rejoin effects. Bind client build, world hash, resolved SDK
version and candidate revision. Headset performance, one-client movement,
multiplayer and install/update acceptance remain separate gates. No new device
run or performance acceptance is claimed here.

Use existing project-query projections and diagnostic filters where supported.
A desktop capture whose pixels disagree with the selected target must fail
closed before input. A Range request alone is not a download limit: a bounded
probe must stop reading and close even if the server ignores Range. These are
reported agent/capture boundaries, not reproduced MCP defects.

Exact entry/source identities and the read-only review are retained under
`artifacts/feedback-linux-20261027/phase/deb017-085-signer-01/backrooms-feedback-review-01`.
