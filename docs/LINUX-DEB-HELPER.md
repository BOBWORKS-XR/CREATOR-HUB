# Linux DEB Helper Prerequisite

2026-10-15. Bounded MCP 2.7.7 amd64 prerequisite, **not production retirement**.
Default Cargo features are empty: `INSTALL_REFUSAL` remains unconditional in
the default build. A separate **nondefault `experimental-transaction` feature**
implements the normal dpkg frontend-lock handoff. It is source/type-checked,
not natively accepted. Preparation remains separate from that transaction.
There is no policy installation, coordinator wiring, workflow dispatch,
publication, user-app build or user-PC transaction in this task.
Assembly 38648562557 belongs to the parent and is not touched here. Mac remains
suspended; Setup, Flatpak, RPM, AppImage and other distro work are excluded.

## Evidence And Classification

- **Confirmed missing integration:** `src-tauri/src/convergence.rs` still refuses
  when standalone Linux apps exist. No existing coordinator/build/module files
  were edited. This is unfinished feature work, not a failing build.
- **Correct as-is:** preserve production/default-build refusal until native
  acceptance. Enabling the experimental feature is not a release approval.
- **Known prior proof:** [run 38643248531](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38643248531)
  retained nine original runtime files/paths, the live official SDK connection,
  both Node reconnects and synthetic user data, while normal same-package dpkg
  upgrade removed five GUI assets. It did not execute this helper.
- **Unknown / needs capture:** actual installed-baseline admission and privileged
  preparation by this binary, busy-lock behavior on the selected distro,
  transaction handoff and cooperating direct-dpkg contention, GUI close, native approval,
  cancellation, interruption and recovery. No inference here is acceptance.
- **Likely wrong but not proven:** treating a prior hash check or a free lock
  observed before launching dpkg as sufficient transaction authority. The new
  experimental path holds the frontend lock throughout instead.

## Threat Boundary

The boundary is an unprivileged caller and **cooperating package managers** using
the documented frontend protocol. System dpkg/tool configuration and the fixed
installed helper are trusted Root-managed inputs. A malicious Root writer,
including one falsely asserting `DPKG_FRONTEND_LOCKED` without owning that lock,
is outside this guarantee; Root can replace the helper or payload itself. This
is a documented limit, not a requirement to prove exclusion against malicious
Root before testing the cooperating protocol. SIGKILL, power loss and forced
parent death are interruption cases, not an atomicity guarantee.

Inputs: [retention proof](LINUX-DEB-RETENTION-014.md), its permanent evidence and
the exact local run's `plan.json`, `before-file-list.stdout` and original control
tar. Those captures were read, not changed. The original package is 96,666,824
bytes, SHA-256 `db47aed5f5acd4e00e8e0782361444de228c4181eeea4970f90116f1f16cf10b`.
The crate compiles all fourteen measured path/size/SHA-256/mode/MD5 pins, including
the three icon hashes from `plan.json`. Runtime trust does not come from a
version string, external manifest, downloaded package or caller pathname.

## Finite Interface

| Argument | Behavior |
| --- | --- |
| none, or `inspect` | Read-only installed baseline inspection; never creates a stage or locks. A matching snapshot is explicitly nonauthoritative for installation. |
| `prepare-mcp-2.7.7` | Explicit real/effective root:root only, fixed installed executable only; prepare and re-inspect a root-private DEB, **never install it**. |
| `retire-mcp-2.7.7` | Default: unconditional `INSTALL_REFUSAL`. Experimental Linux build only: require the fixed trusted root image, prepare a fresh candidate, then one normal same-package dpkg upgrade and postchecks. |
| Anything else/additional arguments | Refuse. No paths, package URLs, arbitrary versions, roots, shell commands or Setup action. |

Outputs are one JSON object; refusal exits 2. Inspection/preparation report
`inspected-read-only` or `prepared-not-installed`, with no transaction started.
Experimental success is `experimental-transaction-verified`, not native/release
acceptance. `installationEnabled:false` continues to mean production installation
is not enabled; `experimentalTransactionCompiled` explicitly identifies the build.
After an attempted transaction, errors use `manual-repair-required` and retain
an accurate started flag (null for an earlier attempt of unknown outcome), never
reporting an ambiguous attempt as a clean preflight refusal.
Non-Linux inspection/preparation/experimental retirement refuse. Mutation requires
`/usr/libexec/creator-hub-deb-retirement-helper`, root:root 0755, not setuid;
every ancestor must be protected. No binary/polkit policy is installed here.
The parent must establish trusted installation and native review before using
the fixed system pkexec; this binary does not elevate itself or call pkexec.

## Protected Preparation

1. Open existing `/var/lib/dpkg/lock-frontend`, then `/var/lib/dpkg/lock`, without
   creation/truncation/unlinking. Nonblocking whole-file POSIX `F_SETLK` locks;
   any failure refuses. Both FDs stay held until preparation/revalidation ends.
   No `flock`, stale-lock deletion, package-manager killing or wait/retry loop.
2. Require exact `creator-works-mcp`, 2.7.7, amd64, `install ok installed`, original
   control fields, no hold/reinstreq/pending triggers/extra relationships,
   a clean read-only audit/verification, strictly increasing Debian version,
   exact complete package file list and exclusive ownership for all 14 files.
   Only original `.list` and `.md5sums` package info members are admitted, and
   original md5sums bytes must match the compiled SHA-256.
3. Refuse pending dpkg update files, nonempty diversions or statoverride files,
   links/special files, multiply linked files, non-root ownership, writable or
   redirected ancestors, changed modes/sizes/hashes and extra entries in the
   product-owned `/usr/lib/Creator Works MCP` tree. The global diversion and
   statoverride refusal is intentionally conservative: even unrelated entries
   currently refuse. Shared `/usr` directories are not recursively inventoried.
4. Only after validation, create/use root:root 0700
   `/var/lib/creator-hub-deb-retirement`. Create a fresh root-private
   `mcp-2.7.7-preparation-<128-bit random hex>` directory. Old/expired preparations
   are never read as sources, overwritten or installed. Their age does not grant
   authority. Each call revalidates the installed original baseline under both
   locks and constructs/re-inspects new bytes. Only protected recognized stage
   directories are tolerated; cap four stages, then require administrator space
   review. A prior `transaction-attempted` marker blocks all mutation/retry.
   No cleanup, rollback, remove/copy-back or recovery journal framework.
5. Read each retained installed file through a no-follow directory-FD walk;
   check regular type, root ownership, single link, mode, length and SHA-256 on
   that open descriptor. Stream into newly created private files, checking
   before/after descriptor metadata. Preparation never writes/deletes originals.
   Both `runtime/node` and `runtime/node.exe` remain at their original package
   paths, not aliases/cache replacements. Nothing reads or edits client data,
   settings, projects, caches or live Node processes in the helper.
6. Generate only compiled `control` and the nine-file `md5sums`, no maintainer
   scripts/conffiles/relationship additions. Run fixed protected system
   `/usr/bin/dpkg-deb --root-owner-group -Zgzip -z1 --build` with argument vectors,
   cleared environment, fixed PATH/locale and private TMPDIR. No shell parsing.
   Re-read control/data tar streams with the Cargo `tar` parser, raw headers,
   allowlists and resource hashes; reject hidden/link/PAX/duplicate/extra members.
   Revalidate the installed baseline with both locks still held.
7. Return `prepared-not-installed` and the protected candidate path. The stage
   is a prerequisite artifact, **not authority to install it later**. No API
   accepts this path for elevation. Experimental retirement does not reuse it;
   it acquires locks and constructs/revalidates its own fresh candidate.

The candidate uses the already documented **TEST ONLY** version
`2.7.7-1+hub.retention014.1`, same package/architecture and unchanged GUI
dependencies. It is not an approved shipping version; gzip-produced bytes are
not claimed identical to the prior xz fixture. Failure can leave private staging
files; the preparation action never initiates a transaction. A restrictive umask or uncommon
system layout may refuse rather than be repaired. Preparation is not yet natively
accepted and must not be run on the user's PC.

## Experimental Transaction

Compile explicitly with `--features experimental-transaction`; no default,
coordinator or packaging feature enables it. Only `retire-mcp-2.7.7` reaches it,
and the same real/effective root:root and fixed root-owned 0755 image gate applies.
Native approval and GUI close remain the parent's Root-coordinator responsibility,
outside this crate. Do not ship an experimental image before those gates pass.

1. Acquire frontend then database locks. Keep the frontend FD/lock in the parent
   for the entire operation, through child wait, database reacquisition and all
   postchecks. Neither lock file is created, truncated or unlinked by the helper.
2. Refuse any earlier attempt marker. Admit only the exact original MCP baseline,
   prepare fresh bytes as above, and re-inspect the actual protected candidate.
   A caller never supplies the dpkg package pathname. Trusted private parents
   bind those verified bytes to the pathname dpkg opens against unprivileged
   replacement; no promise is made against malicious Root replacement.
3. Create/fsync a root-private, create-new `transaction-attempted` file and fsync
   its directory **before** releasing the database lock. Its presence is a
   conservative retry barrier, not installation authority or a replay journal.
4. Unlock only the existing database FD using `F_SETLK/F_UNLCK`; never close or
   reopen the parent's frontend FD. Spawn fixed protected `/usr/bin/dpkg` with
   `--install` and only the newly generated private candidate. Cleared finite
   environment includes `DPKG_FRONTEND_LOCKED=1`, empty `DPKG_FORCE`, fixed
   PATH/locale/HOME and private TMPDIR. No force/remove/purge/downgrade flags.
5. Wait for dpkg without an installation timeout or forced kill. Root-private
   stdout/stderr logs are retained. SIGINT/TERM/HUP/QUIT set a helper flag rather
   than abandoning the child; after child exit they require manual review.
   A signaled/nonzero dpkg exit is a manual-repair result. Node is never signaled.
6. Reacquire the database lock on the **same FD**, including child spawn/failure
   paths, before returning. Reacquisition failure is manual-repair, not success.
7. With both locks still held, require exact healthy compatibility version,
   control/relationships, complete nine-resource package file list (including
   dpkg's measured `/.` root entry), md5sums, hashes, modes, Root ownership and
   exclusive package ownership; check all five GUI paths and ownership absent,
   no extra product-tree files, clean dpkg audit/verification/update state.

Any error after recording the attempt requires manual repair/review and refuses
automatic retry. The marker is retained even on verified success, so a second
retirement cannot silently repeat the upgrade. There is no helper command to
clear it, no automatic rollback, system-file deletion, package-DB edit or copy-back.
After SIGKILL/power loss the next invocation sees either this barrier or refuses
the changed/unhealthy baseline. Full crash/power-loss durability and recovery
remain unaccepted; normal dpkg unpack is not atomic. Prepared stage files and
logs remain available for explicit administrator review.

## Current Primary Lock Contract

Checked 2026-10-15 against upstream main
`d0dbbb454332e57c4e713d2a4a61b547a0f9232c` (read-only `git ls-remote`):

- [dpkg frontend API](https://github.com/guillemj/dpkg/blob/d0dbbb454332e57c4e713d2a4a61b547a0f9232c/doc/spec/frontend-api.txt):
  acquire frontend then database POSIX record locks over the entire files.
  A frontend retaining its frontend lock sets `DPKG_FRONTEND_LOCKED` for dpkg,
  releases its database lock and lets dpkg acquire that database lock. Its
  exclusion guarantee is explicitly for other frontends following the protocol.
- [dpkg lock implementation](https://github.com/guillemj/dpkg/blob/d0dbbb454332e57c4e713d2a4a61b547a0f9232c/lib/dpkg/dbmodify.c):
  `modstatdb_can_lock` opens the frontend lock unless the environment variable
  is present; `modstatdb_lock` locks frontend then database. Therefore current
  ordinary direct dpkg also requests the frontend lock. This source observation
  is not native proof for Ubuntu 22.04's installed dpkg or every Debian version.
- [dpkg manual](https://manpages.debian.org/trixie/dpkg/dpkg.1.en.html):
  `DPKG_FRONTEND_LOCKED` means the frontend is responsible for that lock; it is
  not a general authorization or an inherited database lock.
- [Linux fcntl locking](https://man7.org/linux/man-pages/man2/fcntl_locking.2.html):
  record locks are process-associated, not inherited by fork; closing any FD
  for that file releases that process's locks. Exec preservation does not prove
  a safe dpkg-specific exec handoff; none is implemented.
- [Debian Policy unpack](https://www.debian.org/doc/debian-policy/ch-maintainerscripts.html#details-of-unpack-phase-of-installation-or-upgrade):
  normal upgrade removes old-only files and replaces the package list, with
  irreversible error-unwind boundaries. Do not claim atomicity or automatic
  recovery. [dpkg-deb](https://manpages.debian.org/trixie/dpkg/dpkg-deb.1.en.html)
  builds archives; it does not install them or authenticate their publisher.

The nondefault implementation now follows the documented cooperating-frontend
protocol. The default build still refuses every transaction. Retaining the
database lock in a parent while starting child dpkg would block the child;
releasing both locks would lose frontend exclusion. Neither is done. A malicious
Root protocol bypass is outside the stated boundary, not a new release gate.
No native acceptance is inferred from matching source or descriptor fixtures.

## Smallest Next Native Proof

After parent review, first run only the prepared unprivileged disposable-native
fixture script. Both feature configurations are covered. Separate-process tests
on temporary files check frontend exclusion before/during/after database handoff,
CLOEXEC descriptors, child database acquisition, and parent reacquisition after
success, spawn failure or child failure. A feature-only signal fixture checks
the parent's interrupted flag. Another fixture builds/parses a tiny synthetic
DEB with dpkg-deb. No package install, alternate
system root, policy install or user app is involved. Capture exact OS/dpkg/helper
versions, source SHA, exits and output. It is **not yet dispatched/run**.

Before integrating/enabling the feature in packaging, a separately reviewed disposable Ubuntu
22.04 x64 probe must test the implementation with the actual system
dpkg: contention on each lock before preparation must refuse without a stage;
a normal direct-dpkg competitor and a second compliant frontend must not cross
the held frontend lock; helper/child termination must release locks without
unlinking them. A deliberately malicious Root protocol bypass is excluded, not
required. Only a new unprivileged fixture workflow is prepared; no workflow is
dispatched by this task.

Only after that contract is accepted: one normal same-package upgrade through
the reviewed helper route, with the existing live-SDK/both-original-path probes,
all nine hashes/ownership, five omissions, and unchanged settings. This actual
transaction is **prepared as the native test plan only, not executed here**. Interruptions
before/during unpack and stale stage/changed package state must have an explicit
refusal/manual-recovery outcome before retries can be enabled. No rollback,
power-loss or recovery acceptance is inherited from run 38643248531.

The actual-transaction lane is deliberately a reviewed plan, not an installed
helper, policy or dispatched workflow. On that disposable runner only, the parent
can build just this crate with `cargo build --locked --release --features
experimental-transaction --manifest-path native/linux-deb-retirement/Cargo.toml`,
record its hash and arrange the fixed protected image. Do not build Root for
helper iterations. Given the pinned original package already installed and the
live SDK/sentinel probes running, the only privileged helper argument is
`retire-mcp-2.7.7`. A previous prepare path is not an argument and is not reused.
Afterward capture the JSON, protected dpkg logs, attempt marker, all post-state
checks and a second-call refusal; do not clear the marker or retry an interrupted
upgrade to obtain a passing test. The parent's native approval/policy/packaging
integration remains separate and is not installed by this task.

## Verification Checkpoint

Local Windows commands, this crate only (no user-app build):

```text
cargo test --locked --manifest-path native/linux-deb-retirement/Cargo.toml
cargo test --locked --features experimental-transaction --target-dir native/linux-deb-retirement/target/experimental --manifest-path native/linux-deb-retirement/Cargo.toml
cargo build --locked --manifest-path native/linux-deb-retirement/Cargo.toml
cargo clippy --locked --all-targets --manifest-path native/linux-deb-retirement/Cargo.toml -- -D warnings
node --test scripts/linux-deb-helper.test.cjs
cargo +stable check --locked --target x86_64-unknown-linux-gnu --tests --manifest-path native/linux-deb-retirement/Cargo.toml
cargo +stable clippy --locked --target x86_64-unknown-linux-gnu --all-targets --manifest-path native/linux-deb-retirement/Cargo.toml -- -D warnings
cargo +stable clippy --locked --target x86_64-unknown-linux-gnu --all-targets --features experimental-transaction --manifest-path native/linux-deb-retirement/Cargo.toml -- -D warnings
```

The initial Windows tests/build used Rust 1.92; the parent subsequently changed
the repository toolchain to 1.99.0. The prepared fixture capture records the
actual checked-out `rust-toolchain.toml` and verbose Rust/Cargo versions, not an
assumed historical version. Linux cross-checks used an already-installed stable
Linux target (no toolchain/target installation). Cross-checking is not
Linux linking or execution. Focused CLI tests execute only hard refusals here.
No production/native acceptance gate is lifted by source, parser or CLI tests.
The native script's fixture body is not executed; it is unprivileged/hosted/
opt-in guarded. Bash syntax and its early opt-out refusal are checked locally.
A new fixture-only workflow is now prepared below, not dispatched here.

Results: **15 Rust tests passed in each feature configuration** (same portable
coverage, not 30 unique tests); helper-only default build and both Linux-target
strict-Clippy/test compilation checks passed. Linux-only descriptor, signal and
dpkg-deb fixtures are prepared/type-checked but **not executed**. Node's source
assertion initially failed on rustfmt's multiline method chain; the assertion
now allows whitespace; the initial four Node tests passed, including shell syntax
and early opt-out refusal. No native acceptance or actual transaction is claimed.

## Prepared Fixture Workflow

New `.github/workflows/linux-deb-helper-fixtures-014.yml` has exactly one Ubuntu
22.04 job. Its sole trigger is a push changing that workflow path on
`validation/linux-deb-helper-fixtures-014`. Repository `BOBWORKS-XR/CREATOR-HUB`,
id `1364807512`, branch and push event are checked at job, capture-driver and
native-script boundaries. Permissions are contents-read only; checkout does not
persist credentials. No schedule, manual dispatch trigger, matrix, privilege
command, OS package installation, actual helper transaction or product build.

`scripts/linux-deb-helper-fixtures-probe.py` first parses its Python inputs,
checks Bash/Node syntax and runs four pure capture/admission tests. Only after
these succeed does it bind the checkout HEAD to `GITHUB_SHA`, capture OS/kernel,
UID, dpkg, Rust, Cargo, Node and Python versions, then invoke
`scripts/linux-deb-helper-native-check.sh` unprivileged. That script builds/tests
only this helper crate, including temporary lock/descriptor/signal/tiny-DEB
fixtures and the default executable's refusal tests, not Root or modules.

An always-run upload retains only `result.json` and unmodified stdout/stderr
files in the `linux-deb-helper-fixtures-<run>-<attempt>` artifact for seven days.
Command argv/exits and original failure logs are preserved. `fixtureChecksPassed`
may become true, but all sixteen production/native-transaction/approval/recovery/
retention/migration/update/release gates stay false. No compiled binary, package,
source archive, credential or user content is uploaded.

Local preparation verification: **four pure Python tests and five Node tests
pass**, YAML parsed/one-job guards checked, Bash syntax checked. The native
fixture body is still **not run**; no workflow dispatch, commit or push by this
task. This new workflow/capture driver does not alter the parent's separate
sealed-stdin probe or its workflow.

## Exact Owned Files

```text
native/linux-deb-retirement/.gitattributes
native/linux-deb-retirement/.gitignore
native/linux-deb-retirement/Cargo.toml
native/linux-deb-retirement/Cargo.lock
native/linux-deb-retirement/src/archive.rs
native/linux-deb-retirement/src/lib.rs
native/linux-deb-retirement/src/linux.rs
native/linux-deb-retirement/src/linux/handoff.rs
native/linux-deb-retirement/src/linux/transaction.rs
native/linux-deb-retirement/src/main.rs
native/linux-deb-retirement/src/pins.rs
native/linux-deb-retirement/tests/baseline.rs
native/linux-deb-retirement/tests/cli.rs
native/linux-deb-retirement/tests/fixtures/baseline.control
native/linux-deb-retirement/tests/fixtures/baseline.list
native/linux-deb-retirement/tests/fixtures/baseline.md5sums
native/linux-deb-retirement/tests/fixtures/compatibility.list
scripts/linux-deb-helper-native-check.sh
scripts/linux-deb-helper.test.cjs
scripts/linux-deb-helper-fixtures-probe.py
scripts/linux-deb-helper-fixtures.test.py
.github/workflows/linux-deb-helper-fixtures-014.yml
docs/LINUX-DEB-HELPER.md
```

Generated crate `target/` is locally ignored. Working files remain visible;
no shared-index changes, commit, branch move, push or unrelated-dirt cleanup.
