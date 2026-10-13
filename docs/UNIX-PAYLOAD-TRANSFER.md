# Build-Only Unsigned Unix Payload Transfer

`native/unix-transfer` reuses `src-tauri/src/module_archive.rs` directly, not the
Linux-only archive CLI. It does not relabel Mac receipts, edit production
admission, inspect keys, verify signatures, run payloads, or activate routing.
An unsigned consistency check is not GitHub provenance or publication authority.

## Commands

Build with the repository toolchain and lockfile:

```sh
cargo build --release --locked --manifest-path native/unix-transfer/Cargo.toml
creator-hub-unix-transfer pack ABS_PREPARED_DIR ABS_NEW_TRANSFER_DIR
creator-hub-unix-transfer verify ABS_ARCHIVE ABS_PREPARED_JSON ABS_BINDING_JSON
creator-hub-unix-transfer extract ABS_ARCHIVE ABS_PREPARED_JSON ABS_BINDING_JSON ABS_NEW_RAW_DIR
```

Packing requires Unix and validates actual source modes. Windows packing refuses
before inspection: Windows modes cannot prove native POSIX permissions. Windows
can verify and extract a Linux or Mac declared target without executing its bytes.

`pack` creates a new directory containing `modules.tar.gz`,
`transfer-binding.json`, and a byte-identical `prepared-unix.json`. The archive
contains exactly the 13 raw members listed by `finishPreparation`, not the
receipt itself. Its binding uses the existing generic schema: archive SHA-256,
compressed/unpacked sizes, and exact member sizes/modes. The binding's historical
`modules.tar.gz` filename does not change the receipt's Linux/Mac platform.

The receipt is strictly typed with unknown/duplicate fields refused. It admits
the current preparation schema, known target triples, explicit experimental
flags, repository/workflow/source/run identities, and fixed unsigned/no-key/
no-acceptance claims. `push` and `workflow_dispatch` match the producer schema;
this tool does not independently prove the validation branch or GitHub event.
Fresh GitHub API proof remains mandatory in the separate signing stage.

## Bounds and File Handling

Metadata is limited to 128 KiB, each member/archive to 256 MiB, and total raw
members to 512 MiB. Packing inventories only known paths and refuses extra,
missing or orphan files/directories before reading unlisted contents. It captures
regular single-link files, exact hashes/sizes and canonical 0644/0755 modes.
Metadata, archive and source paths reject symlinks/reparse ancestors. Held file
identities are rechecked; Windows read handles deny write/delete sharing, and
Unix opens use no-follow/nonblocking/close-on-exec flags.

Verification compares all binding sizes/modes with the prepared records, then
calls the shared decoder's `read`. That decoder enforces exact raw hashes,
canonical ustar records, zero UID/GID, regular member types, unique known names,
padding/terminators and bounded gzip data. Duplicate/traversal/link members,
unknown trailing TAR members and trailing compressed data refuse even when the
outer archive digest is recomputed.

Extraction verifies everything before creating the output. It requires a new
unredirected directory and writes through `Snapshot::write`, including a copied
receipt. Existing output is never replaced or repaired. Unix extraction restores
the verified native modes; Windows preserves verified bytes, while POSIX mode
evidence remains in the separately retained receipt/binding/archive. A native
assembler must consume that evidence, not infer modes from Windows files.

New output is owned by the invoking account; Unix roots use mode 0700. Partial
output on an I/O failure stays failed and is not deleted or reused. These checks
are not protection from a privileged or actively malicious same-user process
replacing directories at individual filesystem-call boundaries.

## Integration and Tests

The local signer must first bind the independently pinned GitHub artifact ZIP
and exact transfer/receipt/binding bytes to API source/run/artifact proof. It must
then use the existing signer and offline production-key verifier for the signed
handoff. The transfer tool does neither operation and cannot authorize assembly.
All 0.1.14 native GUI, consent, migration, update/restart and release gates remain
outstanding.

```sh
cargo test --locked --manifest-path native/unix-transfer/Cargo.toml
cargo clippy --locked --manifest-path native/unix-transfer/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path native/unix-transfer/Cargo.toml --check
```

Synthetic Linux and Mac target fixtures exercise cross-platform verify/extract,
strict metadata, exact records, duplicate/extra/traversal/link/trailing archive
refusals, hard links, redirected ancestors, bounded reads and immutable outputs.
Windows tests do not prove native Unix packing, native compilation of the Hub,
or any GUI/installation acceptance. Actual Unix packing/mode tests run only on
Unix hosts; no production parser or admission tests are skipped or weakened.
