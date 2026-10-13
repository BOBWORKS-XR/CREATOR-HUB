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
