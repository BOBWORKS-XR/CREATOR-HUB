# Native Host Settings Reader Prerequisite

Implemented scope: `native/flatpak-host-reader` is a private Linux library plus
the local `creator-hub-flatpak-host-inspect` diagnostic executable for read-only
inspection by the current native account. It includes the existing
`native/flatpak-host-paths.rs` model and supplies its concrete `SettingsReader`.
It is not a broker, external caller admission, Flatpak integration, migration,
router activation or production-ready distribution. The recipe and all Root,
router and module sources are unchanged. Windows remains unsupported by this
library; Mac is suspended. No host settings have been read in this work session.

## Exact API And Admission

```rust
use creator_hub_flatpak_host_reader::{NativeHostSettings, paths::Setting};

let mut local = NativeHostSettings::current_user()?;
let result = local.inspect_status(Setting::CreatorMcp);
```

This example is for a future authorized native caller, not an instruction to
inspect the user's installed settings now. There is no listener, service,
socket, D-Bus name or sandbox-facing RPC. Only an in-process caller of `inspect`
can receive raw bytes; `inspect_status` returns only presence and byte length.
No path, executable, peer PID, claimed app ID, boolean consent or client-provided
environment can be submitted to this API.

The executable accepts exactly `inspect-local`, with no additional arguments.
Missing/unknown/extra arguments exit 64 before admission or account/settings I/O.
Native eligibility failure exits 77 without an inventory. Output contains only
the five fixed setting IDs with present/absent/unavailable and optional byte
length, never config bytes, config keys, paths or hashes. Any unavailable entry
exits 2; all entries inspected as present/absent exits 0. Output is below 2 KiB.
`externalCallerAuthenticated` and `hostIntegrationAccepted` are always false.
The command is explicit native self-inspection, not Root or Flatpak admission.
No installed-settings invocation was run here; CLI tests inject synthetic states.

Construction captures actual Linux real/effective/saved UIDs and GIDs plus PID.
Root, mismatched IDs, known Flatpak context (`FLATPAK_ID` or any `/.flatpak-info`
entry) and inaccessible context checks refuse before account/settings inspection.
Every inspection rechecks the same process identity/context. These are native
process eligibility checks, not publisher authentication or proof against an
adversarial mount/user namespace. Same UID never authenticates a remote UI.

The home is obtained through `getpwuid_r` for the captured UID, with a 64-KiB
account-record bound. Neither `HOME` nor `HOST_XDG_*` supplies a home or grants
access. Optional `XDG_CONFIG_HOME`/`XDG_DATA_HOME` come only from this native
process at construction; they are layout hints, not external caller authority.
Unset values use the account home's `.config` and `.local/share`. Custom roots
are honored, never silently replaced with defaults. Empty/relative, redundant,
control-character, oversized or sandbox-private roots refuse. Empty/invalid
values deliberately refuse more strictly than the XDG specification's fallback.

The five existing settings remain the complete allowlist: OpenCode JSON/JSONC,
Creator MCP settings, legacy MCP settings, and Setup editor roots. No auth file,
project, Unity executable or client-selected pathname is opened. Roots are
derived from this native account, not Flatpak's redirected XDG directories.

## Protected Reads

- Open every absolute-path component with directory `O_PATH`, `O_NOFOLLOW` and
  `O_CLOEXEC`. Reject foreign-user or group/other-writable/special-mode ancestors;
  root-owned ancestors are allowed, but the exact settings parent must belong
  to the current user. No directory is created, repaired, chmodded or adopted.
- Bind the full directory chain by device/inode/owner/group/mode/link count/size/
  mtime/ctime. Reopen and compare it before and after each read. A changed chain
  stays unavailable for that reader; a new native inspection is explicit.
- Pin the leaf with `O_PATH|O_NOFOLLOW` before any data I/O. Require a regular,
  current-user-owned, single-link, nonexecutable file without group/other write
  or special bits. A FIFO, device, directory or symlink never becomes a data FD.
- Reopen only that still-live, validated file descriptor through the process's
  descriptor directory, independently checked as procfs with `fstatfs`. This is
  the sole intentional kernel-magic-link follow; no caller-selected symlink is
  followed. Recheck reopened, pinned and named identities and full metadata.
- The data FD is read-only, close-on-exec, nonblocking and `O_NOATIME`; there is
  no fallback that changes access policy. Read at most the setting's limit plus
  one byte (2 MiB, 256 KiB or 16 KiB depending on the fixed setting). Empty files
  are present. Oversize, type/permission changes and replaced files refuse.
- A missing leaf is absent only while its admitted parent chain remains stable.
  Missing, denied, replaced or unbound parents are unavailable, never absent or
  default settings. `DeclaredGrants` remains a declaration, not OS permission;
  actual descriptor/owner checks and kernel access are required too.

This supplies protected observations, not a multi-file atomic snapshot or
hostile same-user immutability. Metadata rechecks cannot establish publisher
identity, detect every transient ABA change, or guarantee I/O deadlines on all
filesystems/NSS backends. There is no host write/rollback path.

Native diagnostic `38749794146` directly observed a six-byte fixture overwrite
before its first data read with identical size, mtime and ctime on both sides:
`1792073780.006846746`. The reader returned the new fixture bytes. The prior test
incorrectly assumed a write necessarily advances the observable stamp. Its
observable-change regression now explicitly changes mtime and asserts that the
fixture changed before testing rejection; no production guard or timing delay
was added. This does **not** prove detection of unchanged-stamp edits, atomic
snapshots or safe writes. Future migration writers must retain and independently
recheck full byte before-images under their own ownership/transaction contract;
these metadata observations never grant write authority.

## Tests And Verification

`src/linux/tests.rs` adds 15 owned-fixture tests for all five positive reads, empty
and exact limits, oversize, stable absence, missing parent, symlinks at the leaf
and above the settings parent, hardlinks, FIFO/directory leaves, foreign owner
checks, unsafe modes, foreign typed paths/wrong limits, in-place/file/parent
replacement, changed process identity and descriptor flags. Admission and
layout cases are also tested. Tests write only fresh `.flatpak-host-fixture-*`
directories in the disposable test checkout and verify their ownership before
cleanup; they never select installed user settings. Run as a non-root user in
a checkout with non-writable-by-others ancestors, not under shared `/tmp`.

Completed checks:

```text
node --test scripts/flatpak-host-reader.test.cjs
cargo metadata --locked --offline --no-deps --format-version 1 --manifest-path native/flatpak-host-reader/Cargo.toml
cargo clippy --locked --offline --all-targets --target x86_64-unknown-linux-gnu --manifest-path native/flatpak-host-reader/Cargo.toml --target-dir <owned-temp> -- -D warnings
cargo test --locked --offline --all-targets --manifest-path native/flatpak-host-reader/Cargo.toml --target-dir <owned-temp>
```

All five Node source/manifest checks pass. After explicit authorization, Linux
cross-target Clippy passes for the library, executable and test targets with
warnings denied. Portable Windows Rust tests pass 19/19: 14 shared model plus
five CLI invocation/admission/JSON-redaction/bounds tests. Their inspectors are
synthetic; no account settings reader is constructed. The 15 Linux syscall tests
were initially typechecked only. An existing Windows compiler
was used and its missing Linux standard-library target was downloaded/installed;
the crate's libc lockfile/dependency resolve is offline.

Build/check artifacts are confined to
`C:\Users\bobman\AppData\Local\Temp\creator-flatpak-host-reader-check-2e0bed54c9124198998d30a90306a216`.
No real settings reads, product installation, workflow changes, native dispatch,
packaging, publication or commits occurred.

Native Ubuntu 22.04 run
[38750164868](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38750164868)
at `0feae0c35e28d95208d301875ac5518ba15ae998` subsequently passed all 14 shared
model, 15 Linux filesystem and five CLI tests, plus warnings-denied Clippy.
Its [receipt](../docs/evidence/linux-migration-preflight-38750164868.json) keeps
all Flatpak host-integration and release flags false. No installed user settings
were selected. Earlier native diagnostic failures are retained, not rerun claims.

The source/owned-fixture-only Linux execution command is:

```sh
cargo test --locked --offline --all-targets --manifest-path native/flatpak-host-reader/Cargo.toml --target-dir "$RUNNER_TEMP/flatpak-host-reader-target"
```

This includes 14 shared model, 15 Linux implementation and five CLI tests.
No new Root artifact was required for that fixture job.
Passing it proves only this bounded native reader, not Flatpak
caller identity, real settings migration, Unity, update origin or acceptance.

## Remaining Integration Dependency

Read-only source review of Flatpak 1.18.4 established a possible next bounded
transport experiment: a native foreground launcher can pass private inherited
file descriptors through `flatpak run`, selecting exact installed app/runtime
commits and an explicit installation. There is no `flatpak run --forward-fd`
option; that belongs to `flatpak-spawn`. See upstream's
[FD passthrough test](https://github.com/flatpak/flatpak/blob/a02d0ba48abe9aacc377de15699e5d8c024b5669/tests/test-run.sh#L98)
and [launch implementation](https://github.com/flatpak/flatpak/blob/a02d0ba48abe9aacc377de15699e5d8c024b5669/common/flatpak-run.c#L4055).

That is not caller authentication. A socketpair's initial `SO_PEERCRED` identifies
its creator, not a later sandbox writer. A synthetic-only next proof should bind
per-message kernel credentials, the owned launch tree, live process identity,
deployment/runtime and effective permissions before any settings observation is
exposed. The instance ID arrives before app execution and is not readiness.
Read-only `/app` and a commit label also do not attest immutable bytes against
host-side tampering. Actual Hub inherited-FD handling and single-instance
redirection remain untested. No bootstrap, transport, permissions or reader
exposure was added by this review.

Parent review must choose an authenticated native bootstrap/transport and
independently bind the actual live sandbox caller before settings data or even
this diagnostic inventory is exposed to Flatpak. The filtered-bus proxy PID,
same UID, nonce, instance label,
`HOST_XDG_*` or a declared grant is not that proof. No broker `GetStatus` or
`InspectMigration` endpoint is implemented or authorized here. Root's native
migration and future transactional ownership remain the parent's work.
Commit `321e6d8` supplies a finite native DEB-helper client/coordinator, not a
Flatpak credential. Its receipts are neither consumed nor promoted to authority
by this component. No existing Root, router, module or helper source was changed.

Primary contracts checked for this implementation:
[Linux open/openat](https://man7.org/linux/man-pages/man2/open.2.html),
[account lookup](https://man7.org/linux/man-pages/man3/getpwuid.3.html),
[file metadata](https://man7.org/linux/man-pages/man2/stat.2.html),
[kernel user identities](https://man7.org/linux/man-pages/man2/getresuid.2.html),
[XDG paths](https://specifications.freedesktop.org/basedir/latest/), and
[Flatpak permissions](https://docs.flatpak.org/en/latest/sandbox-permissions.html).
