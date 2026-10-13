# Reviewed MCP Migration Recovery

## Scope

Implemented in the MCP launcher migration/backup modules, with no changes to
router/bootstrap, packaging, handshake, main client builders, live client
settings, project content, credentials, installations or running processes.
`Plan::apply` now uses this journal instead of the general `atomic_write` helper.
Existing managed-router review, owned-legacy conversion, empty router arguments
and the router regression remain intact.

This is a reviewed file-migration component, not an installer transaction,
authenticated activation receipt, schema-conflict resolver, or actual-client
acceptance. The existing Codex, Claude Code and Claude Desktop are the required
live-client acceptance scope. Missing OpenCode/Antigravity do not prevent a batch;
their format regressions are not claims of actual-client acceptance.

## Integration API

`client_migration::recovery` is a child module, so main needs no new `mod` entry.

```rust
// Gather only eligible, existing clients with the existing review/review_router
// calls. None means no conversion, NOT permission to adopt a foreign entry.
let report = Plan::apply_reviewed(&plans, &journal_root, |plans| {
    // Native review of the complete selected list, including retained projects.
    approve_all_selected(plans)
})?;

// On restart: discover local operation directories without invoking resume.
// Scope MUST come from trusted client/product path discovery, not the journal.
let transaction = recovery::Transaction::open(&operation_directory, &expected_paths)?;
let report = transaction.inspect()?;
// Only after presenting the classifications and obtaining renewed approval:
let report = transaction.resume(|report| approve_recovery(report))?;
```

For a mixed client/product batch, obtain `plan.reviewed_write()` and combine it
with `ReviewedWrite::new(label, path, reviewed_before, proposed_after)` produced
by an explicit product-settings schema adapter. Obtain consent before
`Transaction::prepare(journal_root, writes)` and call `resume` with reviewed
consent. The raw byte adapter does not infer ownership, reconcile schemas, adopt
unknown entries, or authorize itself. It only replaces existing files. Product
settings adapters and their conflict UI still belong to integration.

Use one stable, private journal root and deterministic member order for the
approved product batch. The root must have an existing parent; it is created
after approval. All cooperating writers for that batch must use that root.
The compatibility `Plan::apply` uses `<config-parent>/.creator-hub-migrations`.
Integration must inspect these adjacent journals too before switching to a
central root. Overlap refusal and the advisory Hub lock are root-scoped, not
global filesystem reservations. Do not silently move/delete old journals.

Reports serialize labels, paths, statuses and image locations, not config
contents. Do not export the image files or environment values as telemetry.
An error includes the recovery directory after resume has started. Keep all
retained files and present the error; do not treat it as permission to rerun the
old writer. Cancellation before preparation creates no journal; declined resume
does not write configs, outcomes, or completion records.

## Evidence Layout

An operation ID is SHA-256 of the versioned manifest with ordered canonical
target paths, labels, and exact before/after image hashes. Retries of the same
reviewed operation reuse the same evidence; different bytes do not reuse its ID.

Under `<journal-root>/<operation-id>`:

- `N.before.bin` and `N.after.bin`: exact immutable reviewed byte images.
- `pending.json`: complete versioned manifest, published after every image.
- `N.intent.json`: durable publication intent, before the native call.
- `N.native.json`: native result/error if recording it was reached.
- `N.outcome.json`: immutable per-file applied/refused/quarantined outcome.
- `outcome-<hash>.json`: immutable snapshots of the batch classifications.
- `completed.json`: manifest recorded only after every member was observed
  applied and its publication evidence was flushed.

Reviewed before-images also retain the existing compatible backup name:
`<config-parent>/.creator-hub-settings-backups/<filename>.<before-hash>.bak`.
Retention copies the reviewed bytes, not a new pathname read. All retained
images are bounded to 2 MiB, verified on reuse, and never overwritten on mismatch.

Each config has same-volume capture storage beside it:
`.creator-hub-migration-<operation-id>-N/stage.bin` and `displaced.bin`.
`ReplaceFileW` puts the actual displaced file at `displaced.bin`. After flushing,
a non-replacing write-through move seals it as `retained.bin`. Reports give the
existing displaced location. Partial native errors, foreign/non-UTF-8 bytes,
and flush failures never trigger deletion, fallback rename, or automatic restore.
Oversized/busy displaced objects are kept even when they cannot be classified.

## Classification And Recovery

| Status | Evidence / permitted action |
| --- | --- |
| `Ready` | Exact reviewed before-image currently present; no intent or displacement. Renewed approval may publish. |
| `Applied` | Reviewed after-image currently present, intent present, actual displaced bytes match before, stage consumed, and no recorded native failure. Recovery may flush/seal evidence and record completion, without publishing again. |
| `ExternalChange` | Current bytes changed/missing before any intent, or changed after a proven applied outcome. Keep them; stop the batch. |
| `PublicationConflict` | Actual displaced bytes differ from the reviewed before-image. Retain them and stop. The migration bytes may already be at the target; this is not successful conversion. |
| `Unknown` | Intent without decisive displacement, native failure, missing/inconsistent evidence, a missing target after intent, or unreadable/busy paths. Never restore, recreate or republish automatically. |
| `Unsupported` | Non-Windows publication is not implemented. Preserve originals and refuse publication. |

Without intent/displaced evidence, matching after-bytes are NOT adopted as a
completed migration. A completion marker alone is insufficient. An intent
written just before interruption is deliberately ambiguous even if the target
still looks original. Corrupt/missing reviewed images and mismatched recovery
scope return an error without modifying configs or repairing the evidence.
Incomplete preparation can be finished only by the identical reviewed operation
while the originals still match; otherwise it requires manual review.

A partially applied batch is not rolled back. With renewed approval, untouched
`Ready` members can finish and proven `Applied` members are not republished.
Any conflict stops the rest of the batch. An unresolved overlapping journal in
the same root prevents bypass by a different operation ID. Ambiguous/conflicting
publication outcomes remain quarantined; there is no automatic quarantine-clear
or restore API. A human must reconcile the live config with the retained images
and explicitly review a next action, preserving the old evidence.

`Report.completed` describes file publication observed at the final checks, not
live-client reconnection or product convergence. Files are checked sequentially;
there is no atomic multi-file snapshot and external editors may change them
immediately afterwards. A later inspection reports such changes.

## Native Contract And Limits

Windows publication uses
[ReplaceFileW with a unique backup path](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew).
There is no compare-and-swap claim. A read handle sharing read/delete denies
writes to that specific original object but not replacement of its pathname.
The [sharing contract](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
is enforced by Windows, unlike the Hub advisory lock.

A noncooperating replacement can therefore be displaced by publication. Its
actual file is captured, compared and quarantined instead of silently discarding
it or reporting success. Automatic restoration would introduce a second
unchecked replacement race, so it is forbidden. A writer holding an open handle
to a newly displaced object can continue changing that object: its instantaneous
boundary contents cannot be promised immutable. Busy capture/flush refuses
completion and keeps the actual object for later inspection; this limit is
covered by a real threaded native test.

The documented ReplaceFile partial-failure states are not assumed unchanged.
There is no retry/rename fallback, and the unsupported `REPLACEFILE_WRITE_THROUGH`
flag is not used. Files are explicitly
[flushed through writable handles](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers);
immutable record publication and displacement sealing use
[MoveFileExW with WRITE_THROUGH and without REPLACE_EXISTING/COPY_ALLOWED](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw).
Capture is beside the target to enforce the same-volume replacement contract.
UNC targets are refused. Local NTFS is the tested filesystem, not arbitrary
network/filter/removable filesystems.

This is write-ahead recovery with conservative evidence checks, not a guarantee
against arbitrary storage-device cache loss. No Windows directory-fsync or
ReplaceFile write-through contract is invented. If rename/record evidence is
missing after power loss, recovery refuses rather than guessing. The fault
tests return errors at durable boundaries and reopen the journal; they are not
physical power-cut tests and do not terminate client processes.

Unix evidence retention uses private 0700 directories, 0600 images and directory
syncs; Unix config publication fails closed until its actual native replacement
contract is implemented/tested. Windows storage inherits the selected per-user
directory's ACL; this component does not create a custom DACL. Hashes are local
integrity evidence, not signatures or protection against an adversary with the
same user's write permissions. Ancestor paths/storage are trusted: link and
junction checks reject observed redirection but are not a race-proof defense
against malicious ancestor replacement.

## Verification

Run from the confirmed `BOBWORKS-XR/CREATOR-HUB` fork checkout on
`feature/unified-creator-hub`:

```powershell
cargo test --manifest-path modules/mcp/launcher/src-tauri/Cargo.toml client_migration -- --test-threads=1
cargo test --manifest-path modules/mcp/launcher/src-tauri/Cargo.toml settings_backup -- --test-threads=1
cargo test --manifest-path modules/mcp/launcher/src-tauri/Cargo.toml -- --test-threads=1
```

Local verification on 2026-10-13, Windows on observed C: NTFS, in the dirty shared
checkout starting at `bf1b204378875152696665940cf1a0768320e5e5`:

- `client_migration`: 33 passed, 0 failed, 0 ignored.
- `settings_backup`: 13 passed, 0 failed, 0 ignored.
- Full launcher: 201 passed, 0 failed, 7 existing opt-in tests ignored.
- Explicit-file `rustfmt --check` and scoped `git diff --check`: passed.
- No Unix build/run or physical power-cut acceptance was performed here.

SHA-256 of the tested files under `modules/mcp/launcher/src-tauri/src/`:

| File | SHA-256 |
| --- | --- |
| `client_migration.rs` | `0c2a12712a1166ac253b783307f520524f70e2e0e025af1790c76087e2498689` |
| `settings_backup.rs` | `0b9c0629f380d03b198062a130b733754f2fa98c23db77d2f0f18f1b20556cec` |
| `migration_recovery.rs` | `4e21b413098cddb00f8cae5ed4ccbefaf42399b2dd595c96f82d1571a9724f01` |
| `migration_recovery_tests.rs` | `fd546896386f01a70ad6a81a4c32529ea7669b298c71e073ca430f0d7006317a` |
| `client_migration_render_tests.rs` | `af675580e3cffa6f4555e772523c0b7a03917f63dc971c6ade87b76e6e7412eb` |

Focused coverage includes all retained-image/pending boundaries, stage, intent,
before/after actual publication, native-result recording, displacement sealing,
capture flush, outcome and completion; reopening, repeated recovery, partial
batches, scope/corruption/record-loss refusal, changed/missing settings, unknown
after-image refusal, retained binary bytes, backup corruption, failed native
replacement and no-overwrite storage collisions.

Real threaded Windows regressions use native ReplaceFileW replacement while the
Hub original-object handle is held, an in-place writer, and replacement with a
still-open writable handle. Additional checks cover post-publication edits and
edits to a later batch member. The observed MoveFileExW replacement attempt was
denied by the guard; the decisive replacement test uses ReplaceFileW, which
actually succeeded across that guard. The suite does not claim every editor or
filesystem has been tested.

Format tests preserve projects, custom environment, disabled state, other
servers and internal comments. Only command/arguments/owner additions are
edited. Comments inside removed legacy arguments stay at the changed argument
array; unrelated field/comment bytes stay in place apart from required commas.
Original before-images remain exact including CRLF/formatting. The three-client
batch test uses disposable fixtures, not the actual applications.

Remaining main integration: journal discovery/review UI, a stable shared root,
approved product-settings adapters/conflict handling, signed runtime/activation
binding, and disposable installed/update recovery plus actual Codex/Claude Code/
Claude Desktop reconnection acceptance. This work neither changes rollout gates
nor blocks on absent OpenCode/Antigravity installations.
