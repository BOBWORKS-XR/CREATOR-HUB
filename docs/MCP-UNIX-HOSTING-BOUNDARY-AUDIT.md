# Unix Hosting Boundary Audit And Native Publication

2026-10-13. Started at 7edf6fb; continued on dc60489 plus concurrent main/Pauli
changes. No commit, workflow dispatch, release, AI-client installation/login or
live client/settings/project mutation. Production Unix writable hosting remains
off; read-only packages and release/readiness guards are unchanged.

## Implemented Native Publication

`modules/mcp/launcher/src-tauri/src/unix_publication.rs` is now used by
`client_migration::recovery::Transaction::publish` on Linux and macOS. Existing
`prepare`, `open`, `inspect`, `resume` and approval APIs are retained. The pending,
intent, native-result and outcome record schemas remain unchanged. `FileReport`
adds `stage`, since that file can hold actual displaced data after a partial swap.

- Prepare a verified after-image beside the target, inside its private capture
  directory. Require bounded, owned, single-link regular files and same device;
  preserve the reviewed target's Unix mode bits. No original file is chmodded.
- Pin both parent directories and the proposed file. Before native publication,
  recheck named directory/stage identities and the exact proposed SHA-256.
- After durable intent, use Linux `renameat2(RENAME_EXCHANGE)` or macOS
  `renameatx_np(RENAME_SWAP)`, the dirfd-relative member of the `renamex_np` family.
  These are native swaps, not ordinary overwrite renames or filesystem CAS.
- Stage now names the actual displaced object, including an external replacement.
  Move it to `displaced.bin` with native no-replace (`RENAME_NOREPLACE`/`RENAME_EXCL`),
  then flush both directories. Keep every file on failure; never swap back.
- An interruption between swap and capture leaves `stage` intact and is Unknown.
  Failed native/capture/flush outcomes do not authorize another publication.
  Changed actual displaced bytes produce PublicationConflict and stop the batch.
- Reuse exact before/after images, retained backups, sealing, scoped recovery and
  historical-completion semantics. Only proven matching evidence completes a file.

Primary contracts: [Linux rename API](https://man7.org/linux/man-pages/man2/rename.2.html)
and [Apple XNU rename implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/vfs/vfs_syscalls.c).
The implementation uses the existing pinned libc API; unsupported native flags,
filesystems and cross-volume operations have no copy/overwrite fallback.

Ordinary built-in Unix client setup now uses this same reviewed transaction for
existing files instead of ignoring its parsed before-image. New files use the
existing durable create-if-absent link/unlink primitive, not an overwriting rename.
A newly appeared file is not adopted even when it equals the proposed bytes.
Standalone setup keeps its existing route. Unix protected reads add NOFOLLOW,
NONBLOCK and CLOEXEC so special/redirected captures are not followed or blocked on.

This does not provide immutable Unix files, deny active writers, copy ACLs/xattrs,
prove arbitrary power-loss durability, or establish installed client acceptance.
An active writer can still mutate a displaced inode; recovery checks its evidence
again and refuses success when it no longer matches. Hostile ancestor replacement
and process-memory compromise are not covered by a CAS claim.

## GUI Admission Changes

- Experimental writable initialization must request the signed managed route;
  omission refuses before prompting/binding, avoiding direct mutable Node targets.
- Recheck the Unix GUI ownership marker after consent and before managed binding,
  after busy-event delivery and before journal acceptance/command dispatch.
- Bind the direct parent PID across native consent/outcome-review dialogs and
  recheck parent/pipe admission before acknowledgement or granting authority.
- Linux inherited pipes now become CLOEXEC before Tauri starts, matching the Mac
  adapter's existing child-inheritance boundary. This is routing/stream admission,
  not publisher authentication. [Descriptor flags](https://man7.org/linux/man-pages/man2/F_GETFD.2const.html).
- Windows image locks, consent, ownership, publication and job semantics stay in
  their existing branches; this worker did not alter their native calls.

## Exact Tests

Windows, installed Rust 1.99.0, `CREATOR_HUB_INTERNAL_MODULE=1`, locked/offline,
launcher feature `experimental-unix-hosting`:

- `cargo test ... hosted::tests -- --test-threads=1`: 15 passed.
- `cargo test ... client_ -- --test-threads=1`: 56 passed.
- `cargo test ... settings_backup:: -- --test-threads=1`: 13 passed.
- `cargo test ... gui_owner:: -- --test-threads=1`: 3 passed; subprocess fixture
  marked ignored is invoked by the cross-process test.
- `cargo clippy ... --all-targets --features experimental-unix-hosting -- -D warnings`:
  passed. All use `modules/mcp/launcher/src-tauri/Cargo.toml`.

Native WSL Linux x64, existing isolated Rust 1.92.0, locked/offline:

```sh
CREATOR_HUB_INTERNAL_MODULE=1 cargo test --locked --offline \
  --manifest-path native/mcp-router/tests/hosted-boundary/Cargo.toml
```

Final result: 64 passed, zero failures, two ignored subprocess fixtures that the
native parent test invokes. Includes real kernel swaps, actual path/in-place
writers, actual held-file mutation after swap, real cross-device refusal, mode
preservation, exact Codex/Claude Code/Claude Desktop source review/publication,
stale/noop/idempotent behavior, new-file collision, and every journal boundary.
One existing standalone-only test returns early in built-in mode; a separate
fixture invariant asserts built-in mode so the new publication tests cannot skip.
The headless crate refuses live settings-root resolution; its publication paths
are explicit disposable fixtures. It does not load Tauri or exercise GUI consent.

Two earlier expanded Linux runs failed only the cross-device fixture's expected
errno (63 passed, one failed). Canonicalizing alone did not resolve it; that
hypothesis was disproved. The fixture needed a private capture directory before
it could reach EXDEV. No runtime checks were weakened to make the test pass.

Existing Windows `stable` Rust 1.92 cross-target Clippy with warnings denied
passed the headless crate on Linux x64, Mac Intel and Mac ARM. These are portable
compile/lint results, not pinned 1.99 or native Mac execution. An attempted named
`+1.92.0` cross-check auto-started a compiler download; the owned process was
stopped and that toolchain was not installed. No further tool installs were used.

Packaging unit regressions: 18 passed, one Windows-owned Unix-permissions skip.
Container/signing fixtures are mocked. Native packaging remains main-owned.
`node --check native/mcp-router/tests/unix-execution.cjs` passed; new report fields
explicitly distinguish group-only Mac cleanup from Linux detached subreaping and
keep writableGuiAccepted/releaseReady false. Historical reports were not rewritten.

## Remaining Native Acceptance

Run the headless command above with the repository's pinned Rust 1.99 on Linux
and both Macs in CI. No workflow was changed or dispatched by this worker.
Run the complete launcher tests on each native runner with built-in mode and the
experimental feature, then test actual consent/decline, competing standalone GUI,
owner replacement during event delivery, bridge exact-byte consumption and EOF.

Confirmed remaining GUI binding gap: Hub `src-tauri/src/hosted.rs` hashes/retains
an ordinary Unix file, then uses `Command::new(path).spawn()`. Unlike the Windows
deny-write/delete handle, that Unix file does not bind loaded GUI code. The
single-threaded headless Node router is not an implementation of this Tauri GUI
launch boundary. Root hosted-payload snapshots do correctly bind later bridge/
logo reads; they do not authenticate code already executing in the backend.

Mac cleanup decision: do not waive arbitrary detached-helper parity on the basis
of passing group tests. The shipped server source and exact current release
bundle (SHA-256 260f221b3cae45700e08180cccb762f0802a3e143f051f0dcf10d5dd6ca1d5e3)
contain no child_process/spawn/detached helper call. That bounds this inspected
server, not every future helper or authorized extension. Current Mac fixtures
deliberately keep helpers in their group. Preserve the documented group-only
contract; require either an explicitly approved non-detaching helper policy or
proven stronger containment before claiming Windows-job parity.
[Pinned Node detached semantics](https://nodejs.org/download/release/v24.17.0/docs/api/child_process.html#optionsdetached).

The previously passed native router run is 38324292628 (four router jobs, not the
whole run). Its retained reports are under artifacts/unix-ci-7edf6fb-20261013 and
do not test this new publisher. Installed authenticated clients, fresh/upgrade
reconnect, disposable live Editor and signed update acceptance remain separate.
Only installed Codex, Claude Code and Claude Desktop are required. No missing
OpenCode/Antigravity installation or client-auth bypass is proposed.
