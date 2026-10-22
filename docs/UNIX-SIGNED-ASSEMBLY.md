# Signed Unix Assembly Candidate

This is a build-input lane, not publication, migration, or GUI acceptance.

`build-unified.cjs --signed-unix-input ABS_DIRECTORY` requires `--managed`,
`--experimental-unix`, and `--experimental-unix-writable`. The existing unsigned
preparation lane remains separate. Assembly requires an explicit native,
GitHub-hosted `unix-managed-assembly.yml` run, a clean checkout, and an independent
`CREATOR_UNIX_HANDOFF_SHA256` pin. Signing credentials and runtime injection
variables are refused.

The input contains exactly nine files: the original three-file transfer,
four signed router/runtime metadata files, and `handoff.json` with its detached
signature. The source-controlled offline verifier checks the compiled production
public key before the handoff is interpreted. Target, version, native source/API
binding, original carrier bytes, and all fifteen final payload records must match.
The shared Rust transfer consumer verifies and restores the native archive and
modes. Private module/router source must not have changed between preparation and
assembly commits.

Assembly copies the original native backend, Node and router bytes. It neither
recompiles nor re-signs them. Mac code signatures are verified, not replaced.
Only verification tools, Linux's archive decoder, and the outer Hub are compiled.
Linux's final runtime archive is derived from the verified fifteen-file payload.
The original pre-wrapper manifest is retained alongside the final Hub manifest.

Current tests cover handoff target/source/attempt, failed jobs, extra fields,
carrier/routing/Setup tampering, mode mismatches, credential refusal, and exact
input inventory. They do **not** establish native writable GUI operation,
migration, AI-client reconnect, package installation, updater restart or release
readiness. A successful assembly receipt keeps those acceptance flags false.

## Linux Root Dependency Cache

Signed Linux x86_64 assembly can explicitly select `--linux-root-cache`.
Only this lane uses `<checkout>/artifacts/linux-root-target` for the outer Hub's
Cargo target. The fixed location is outside `artifacts/unified/<build-name>`;
inherited `CARGO_TARGET_DIR` still cannot select the signed Root target. Omitting
the option preserves the existing fresh `<output>/hub-target` behavior. Other
platforms, unsigned preparation and the private update-fixture lane reject it.

The assembly workflow opts Linux in and maps
`src-tauri -> ../artifacts/linux-root-target` in its existing Rust cache step.
The transfer/verifier mappings and failure-cache setting remain unchanged.
The action retains dependency build artifacts rather than packaged outputs
([cache contract](https://github.com/Swatinem/rust-cache/blob/v2/README.md),
[cleanup implementation](https://github.com/Swatinem/rust-cache/blob/v2/src/cleanup.ts)).
Changing the cache path set may require a first cold restore; no old cache is
deleted by this change. Future performance must be measured on equivalent native
runs, not inferred from these routing tests.

Cache admission is read-only and runs again immediately before Root compilation.
It refuses redirected ancestors, symlinks, hardlinks, nonregular files, overlap
with signed input/output, or an existing Root executable/bundle in either release
profile. Nothing is automatically deleted. If a same-workspace retry encounters
retained output from an earlier attempt, keep that evidence and omit the option
with a new build label; a fresh CI workspace may restore the dependency cache.
Use only trusted CI caches: path checks cannot authenticate arbitrary compiler
artifacts supplied by someone else. Do not import a user-supplied target archive.

Cache hits do not skip locked compilation, trusted handoff extraction, source
equality, the final module checks, package validation or byte-bound receipts.
Assembly output must still be new. Private module/router bytes and signatures
are not changed, and no cache receipt can assert installation or release
acceptance. Root's build script continues tracking the built-in manifest path
and content; integrated MCP also tracks the staged payload inputs.

Local regression coverage exercises cache miss/hit routing, preserved dependency
bytes, rejected leftovers/links/unsupported lanes, and actual workflow argument
mapping with stubbed build commands. It does not perform packaging, prove a
native cache speedup, or replace Linux install/update/restart acceptance.
