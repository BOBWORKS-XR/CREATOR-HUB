# Linux Portable Deployment Primitive

This isolated library verifies a complete signed AppDir, stages a content-addressed
generation and switches a private selection record. It does not execute any
payload, create an activation service, install dependencies, open an app, select
host settings, migrate data, sign anything or claim release readiness. Nothing
calls it from Hub, the updater or Flatpak. The existing DEB and frozen14/15
contracts are unchanged.

## Public Boundary

- `Expected::linux_x86_64(version)` fixes the target and exact canonical stable
  version. No caller-selected platform, architecture, executable or public key.
- `verify(manifest, plain_minisig, archive_path, expected)` verifies with the
  existing `src-tauri/src/catalog-key.pub` compiled into the library, then checks
  the entire archive. The manifest signature binds the compressed archive hash
  and every deployed file; an independent archive signature is not required.
  The private `VerifiedPackage` cannot be constructed by callers.
- `Store::create(new_dedicated_directory)` refuses existing directories.
  `Store::open(directory)` requires the exact store marker, private ownership and
  layout. Public store admission is unprivileged Linux x86_64 only. There is no
  default HOME/XDG path and no adoption of an existing settings/runtime store.
- `stage(package, cancelled)` writes only new staging/generation paths, verifies
  the complete on-disk tree and publishes by same-filesystem rename. It does not
  select the generation. Existing generations are reverified, never repaired.
- `snapshot()` returns a validated signed current generation. `activate` takes
  that exact reviewed snapshot (or explicit `None` for a new installation),
  refuses stale review, downgrade and same-version different bytes, and uses the
  existing runtime-store pattern: exclusive lock, retained prior record, flushed
  journal, flushed temporary record and atomic current-record replacement.
- `recovery()` distinguishes a prepared transaction retaining the old selection
  from a committed new selection. `acknowledge_recovery(reviewed)` rechecks the
  observed state and removes only its exact pending marker. It never chooses the
  target, executes it, rolls back, discards prior history or reports app success.

Before commit, cancellation/interruption leaves the prior selection readable.
After commit, cancellation cannot undo the switch: a flush/cleanup failure is
`OutcomeUnknown`, with retained transition/history for explicit inspection.
Malformed, foreign, redirected or changed records refuse without fallback.
Pending transactions block another activation until explicitly reviewed.

## Package Contract And Provisional Bounds

The signed camelCase JSON manifest has exactly these fields:
`schemaVersion: 1`, `appId: creator-hub`, `platform: linux`,
`architecture: x86_64`, `version`, `sourceCommit`, `sourceTree`,
`format: appdir-tar-gzip-v1`, `entrypoint: usr/bin/creator-hub`,
`archive: {size, sha256, unpackedSize}`, and `entries`.

Each unique `entries` key is a canonical relative ASCII path. Its value is
either `{kind: directory, mode: 493}` or
`{kind: file, size, sha256, mode: 420|493}`. Every parent directory must be listed.
Duplicate/unknown JSON fields, case collisions, traversal, backslashes, device
names, control characters and ambiguous trailing dot/space spellings refuse.
The fixed entrypoint must be an x86_64 little-endian ELF.

Limits are deliberately provisional: 2 MiB manifest, 4 KiB signature, 256 MiB
compressed archive, 512 MiB total file bytes, 256 MiB per file, 8192 total entries,
240-byte paths, 100-byte components and 32 path components. Measure the real
Hub16 AppDir before production enablement. These bounds are not evidence that
GTK/WebKit and all runtime resources currently fit or run on SteamOS.
The verifier currently retains the compressed archive, decompressed TAR and file
contents in memory; peak usage can exceed 1 GiB at these limits. Measure peak
memory with the real AppDir before selecting production bounds or enabling it.

The archive contract follows the shared module reader's raw USTAR, single gzip,
exact header sizes/modes, hash and zero-padding checks. This crate additionally
accepts explicitly listed directories and USTAR prefixes. It never calls TAR
`unpack`. Links (even internal links), devices, FIFOs, sparse/GNU/PAX extensions,
duplicate/missing/extra members, trailing gzip members and hidden TAR data refuse.
Packaging must flatten only independently verified internal AppDir links upstream.

Generation layout is `generations/<manifest-sha256>/{manifest.json,manifest.minisig,AppDir/}`.
Archive files are 0644/0755 and directories 0755. Published files remove write
bits (0444/0555); all published directories are 0555. Each later read validates
these derived modes, owner, single-link regular files, full inventory and hashes.
Immutability means no API overwrites and read-only Unix permissions, not protection
against malicious same-UID processes or root, which can change their own modes.
Foreign-writable ancestors refuse except root-owned sticky temporary directories.
There is no hostile-same-UID race-proof openat sandbox or filesystem immutability
claim. Cancellation can leave verified, unselected generations or private staging
orphans. There is deliberately no automatic pruning/removal of generations.

## Verification And Remaining Work

```sh
cargo fmt --manifest-path native/linux-portable-deployment/Cargo.toml --check
cargo test --locked --manifest-path native/linux-portable-deployment/Cargo.toml
cargo clippy --locked --manifest-path native/linux-portable-deployment/Cargo.toml --all-targets -- -D warnings
```

Tests use a private verifier seam to reach staging/recovery with synthetic
manifests, plus a known public Minisign fixture to exercise real cryptography and
prove that the production key rejects that unrelated key. No private key is
created/read and no runtime verifier/key override is exposed. Windows tests can
exercise archive and transaction logic but do not validate Unix modes, ownership,
links/FIFOs or directory fsync. The separate `linux-portable-deployment.yml`
workflow runs only this crate on its finite validation branch; it does not build
or launch Hub, change existing workflows or qualify a package.

Local checkpoint: 36 Windows tests pass, formatting passes, and strict Clippy
passes for Windows and the Linux x86_64 target, including four additional Unix
tests compiled but not executed. The actual workflow YAML and both embedded Bash
scripts parse; its repository/ref guards and read-only permissions were checked.
No Linux workflow has been dispatched by this work. On the finite
`validation/linux-portable-deployment` branch, an unprivileged Linux run must pass
all 40 tests using the checked-in workflow command:

```sh
cargo test --locked --manifest-path native/linux-portable-deployment/Cargo.toml -- --test-threads=1
```

The audit capped generation-root enumeration at the first four names (only three
are permitted). Tests cover bounded decompression/truncated gzip, all precommit
checkpoints and postcommit cancellation/failure classification. Injected failures
are not power-loss testing. Filesystem identity rechecks and no-follow leaf opens
do not replace the documented same-UID race limitation. Cancellation is
cooperative; a complete file read/hash can finish before the next check.

Still required: real signed complete portable inputs and measured bounds;
dependency/ABI and SteamOS tests; deployment-to-running-image binding; stable
native activation/launcher integration; consent and removal UX; signed updater
and restart wiring; actual settings/migration/runtime preservation acceptance.
This crate alone supplies none of those product acceptance results.
