# Retained MCP Runtime Routing

## Implemented Component

`native/mcp-router` implements a headless, single-connection runtime dispatcher
and a reviewed-snapshot activation library. It is not yet installed, called by
the Hub updater, or used by the AI-client configuration writers. The published
apps and local built-in candidates still use their existing direct runtime paths.
Do not describe this component's tests as completed migration or update acceptance.

The production executable takes no arguments or environment-supplied key/path
overrides. It discovers `creator-hub/mcp-route-v1/<os-arch>/active.json` in local
app data. The receipt contains only a schema version, descriptor digest and
generation digest. It cannot supply arbitrary commands or filesystem paths.

Authority comes from a separately signed, bounded runtime descriptor, verified
with Hub's existing compiled-in catalogue public key. The descriptor binds the
MCP runtime product identity, Hub version, module version, native architecture,
platform and the exact nine-file module payload. Its module digest uses the same
ordered serialization as Hub's existing retained-generation store. All required
file bytes must match before execution. Recomputing an editable receipt checksum
does not authorize modified metadata or an unsigned runtime.

The router holds read handles denying write/delete sharing on all nine Windows
payload files throughout the connection. It forwards actual stdio unchanged and
removes `NODE_OPTIONS` and `NODE_PATH` before starting the private Node runtime.
It does not load a replacement Node runtime from PATH or a developer checkout.

Before spawning Node, the headless router joins its own unnamed, kill-on-close
Windows job. Children inherit that job, and membership is checked before waiting.
The non-inherited job handle lives until router process exit, allowing the router
to forward the child's exit status before Windows closes the handle and cleans
its owned descendants. No AI client, Unity app or unrelated Node process is added.
This follows the [Windows job-object inheritance and close contract](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).
Only the headless executable may call this process-lifetime execution adapter;
the Hub GUI must launch the router, not call it inside its own process.

Unix descriptor/activation tests compile and run, but execution explicitly refuses.
An advisory file lock does not stop non-cooperating replacement of a verified
executable. Full Unix payload-use binding remains an implementation and native
acceptance gate, not an inferred property of the Windows implementation.

## Activation Contract

- Activation is an internal library operation, not an unrestricted user CLI.
  Its future Hub caller must obtain review/approval first and use the exact
  snapshot that was reviewed. The library does not manufacture user consent.
- Verify signature, identity and the entire target payload before creating a route.
- Serialize writers with an exclusive activation lock. Refuse stale snapshots.
- Reject downgrades and different runtime bytes claiming the same Hub version.
- Retain the signed descriptor/signature as a complete immutable directory pair.
- Retain the exact previous receipt by content digest; never overwrite a changed
  backup, corrupt generation or active payload.
- Flush the staged receipt and replace the active receipt as one publication.
  A connection resolves the whole old or new generation, never a partial payload.
- After a failure, inspect the actual active receipt before retrying. A failure
  after commit can leave a complete new route active; it must not be reported as
  a guaranteed rollback or retried with a stale approval.
- Keep old verified generations and active sessions. Reconnection reads the
  new receipt; existing sessions do not switch midway through their work.

Fault-injection tests cover descriptor, backup, pre-commit and post-commit
boundaries. These are not physical power-cut durability tests. Windows directory
durability and signed installer/restart acceptance remain separate gates.
The signature prevents unauthorized runtime bytes, not a same-user attacker from
running another executable or selecting an already-signed retained old receipt.
The activation API's downgrade guard does not claim an external anti-rollback
counter or publisher notarization.

## Checks

```powershell
cargo test --release --locked --manifest-path native/mcp-router/Cargo.toml
cargo clippy --locked --manifest-path native/mcp-router/Cargo.toml --all-targets -- -D warnings
node scripts/native-router-smoke.cjs artifacts/unified/UNIQUE-CANDIDATE
```

The native smoke script creates only new isolated storage and user-profile paths.
It copies the candidate's verified Node/server/module bytes, adds test-only stderr
generation markers and an owned child process, and signs those disposable fixtures
with an ephemeral key held in memory. No production private key is used or saved.
The separate `fixture-driver` example accepts a test key solely for this harness;
it must never be included in an installer. The production executable's argument
rejection and release-key refusal are tested separately from fixture activation.

Actual SDK checks cover old-session survival, new-connection activation, EOF,
forced router exit, descendant cleanup, unrelated Node preservation, signed wrong
product refusal, downgrade refusal and tampered payload refusal. Windows runs
these against the built-in CI candidate. The library also has native test lanes
for Linux, Intel macOS and Apple silicon macOS; those lanes do not enable Unix
runtime execution.

## Remaining Integration

1. Package and verify the retained stable router itself; never point client
   configs at a replaceable Hub GUI executable or a test fixture driver.
2. Have the established signing workflow sign the exact runtime descriptor and
   bind its metadata to the reviewed Hub package. Never accept an unsigned local
   descriptor as proof of publisher authorization.
3. Add the approval-backed migration adapter and formatting-preserving owned
   client-entry conversion. Unmarked/conflicting entries require visible review.
4. Integrate activation with installation completion and startup/recovery, with
   compatible router/schema/key handling across real Hub updates.
5. Complete Unix payload binding and the unified installer/package distribution.
6. Run the exact signed previous-stable discovery, cancellation, migration,
   restart and reconnect matrix on disposable installations. Verify usable old
   state on failure before offering legacy removal.

The source-phase publication guard stays unchanged until these gates are accepted.
