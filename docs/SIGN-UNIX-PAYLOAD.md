# Local Unix Payload Signing Handoff

`scripts/sign-unix-payload.cjs` signs build input, not a release or native
acceptance receipt. It does not compile Hub/modules/Node, re-sign native code,
repack TARs, run payloads, activate routing, install applications, grant OS trust,
or modify the keystore. Final native assembly remains a separate closed gate.

## Explicit Inputs

The production acquisition path requires local Windows and six canonical,
absolute paths:

```text
node scripts/sign-unix-payload.cjs PINS_JSON ORIGINAL_ZIP STAGED_PREPARED_JSON NEW_OUTPUT TRANSFER_EXE VERIFIER_EXE
```

Pins use the existing independent schema: target, version, sourceCommit, runId,
runAttempt, artifactId and zipSha256. They must not be inside extracted candidate
input. ZIP, staged preparation and new output stay under this checkout's
`artifacts` directory, without redirected ancestors. Existing output refuses.

Trusted tools must be the fixed, reviewed cargo-built Windows paths:

- `native/unix-transfer/target/release/creator-hub-unix-transfer.exe`
- `src-tauri/target/release/examples/verify-package-input.exe`

Build/review those tools separately. The helper does not download executables,
accept a public-key override, or infer compiler trust from a filename. Tool bytes
are hashed and rechecked around each invocation; this is stability evidence,
not a signature or build attestation for the tool itself.
The two fixed Cargo executable outputs may have Cargo-created hard links (both
local builds demonstrably have two links). Candidate files, signing metadata and
the PowerShell extractor still require single-link regular files.

## Before Key Selection

The helper calls the existing `collect()` with fresh API requests, validates its
exact source/run/attempt/artifact/job proof, and hashes the actual ZIP against
API size/digest plus independent pins. It invokes the existing bounded
`extract-unix-transfer.ps1` into a new owned scratch directory. That extractor
requires exactly the original three members. The acquired receipt must match the
already staged receipt byte-for-byte.

The Rust transfer tool verifies then extracts the original archive. Every raw
member is rechecked against the preparation hashes/sizes. Source manifest,
Setup/MCP module identities and the exact runtime body/version/target are checked
before any key selection. Original inputs, extracted data and trusted tools are
rechecked; bad proof, ZIP, receipt, TAR or metadata cannot reach the signer.

## Signing and Output

Only approved `signingKey`/`signDetached` helpers select and use the existing
external private key. This script never opens or prints its contents. Signer
inputs and encoded `.sig` side effects remain in separate owned scratch, not the
output. `routing.prepare` operates on temporary verified module copies. The
native router was finalized upstream and is never executed or re-signed.
Each signing callback accepts only the exact expected router, original runtime,
or generated handoff bytes; a changed body/target cannot become a new signature.

The new immutable output contains exactly nine files:

- Original `modules.tar.gz`, `prepared-unix.json`, `transfer-binding.json`, unchanged.
- `routing/router.json`, `router.minisig`, `runtime.json`, `runtime.minisig`.
- `handoff.json`, `handoff.minisig`.

All produced signatures are checked by the offline verifier containing the
production public key, including a final readback of published metadata. Its
existing changed-byte negative control remains required. No installed Store or
activation APIs are used.

The signed envelope binds original transfer hashes/sizes, the four new metadata
hashes/sizes, the exact pre-wrapper built-in manifest and its complete 15-file
payload map including Setup and router, target/version/experimental flags,
source and compact fresh API proof. `privateKeyIncluded=false`,
`nativeGuiAccepted=false`, and `releaseReady=false` are unconditional.

Native member modes come from the verified original TAR/preparation, not Windows
filesystem attributes. New JSON/signature records bind canonical installation
mode 0644. Windows does not prove POSIX execute permissions. A future Linux
assembler may only derive wrapper binding after verifying those exact 15 files;
there is no second transport TAR or authorization to refresh changed hashes.

Signing failure retains partial output and owned scratch for diagnosis; it never
reuses or repairs them. A signature file alone is not success: every bound file
must still match, and native assembly must independently pin/verify the complete
handoff. Scratch retains only public metadata/signatures and disposable payload
copies, never key contents. Same-user/privileged concurrent directory replacement
is not made impossible by these path and hash checks.

## Required Native Assembly Contract

The assembler is not implemented by this helper. It must refuse before Hub
compilation unless all of the following independent checks succeed:

1. Use independently approved handoff/signature hashes and source/target/version
   pins, not pins read out of the candidate. Verify `handoff.json` with the
   compiled production public key. Admit only the known envelope schema and
   exact nine-file input set; all three acceptance/key flags must remain false.
2. Check every original transfer and new routing metadata hash/size against the
   signed envelope. Revalidate its compact API proof using the unchanged
   `prepared-unix.json`; bind the assembly checkout to that authorized source
   tree. A signed historical API receipt is not fresh API availability evidence.
3. Verify/extract the original TAR with the generic shared Rust decoder into a
   new owned, unredirected directory. The original native member modes are the
   authority; signer-host filesystem modes are not. Never execute extracted
   modules during admission.
4. Map the ten `modules/` members without changing their bytes. Map the original
   `router-for-package` to `routing/creator-hub-mcp-router`, preserving its hash,
   size and 0755 mode. Add only the four signed routing metadata files, at 0644.
   Verify router/runtime signatures and their exact target, router hash and
   runtime descriptor against the bound module manifest and Hub version.
5. Read back all 15 final payload records and require exact hash/size/mode and
   file-set equality with `payloadFiles`. Require the same hashes in
   `builtinManifest.modules` and `managedRouting`; Setup is not optional. Reject
   extras, missing members, redirected paths or any mutation without refreshing
   signed hashes.
6. Only then derive a Linux wrapper binding if needed. It may add a transport
   wrapper descriptor but must preserve every signed pre-wrapper manifest field
   and raw member. Compile only Hub and required verification/decoder tools;
   never rebuild MCP, Setup, Node or the router, or re-sign inner Mac binaries.
   Recheck the resulting package's inner bytes before reporting assembly proof.

The preparation/workflow, trusted verifier and native packing/assembly evidence
must be reviewed separately. No aggregate all-platform packing success follows
from one successful target or mocked signing tests. Native acceptance and release
gates stay closed even after a valid build-input signature.

## Tests and Remaining Gates

```sh
node --test scripts/sign-unix-payload.test.cjs
```

Tests use mocked API/native/signing processes and nonexistent private-key
placeholders. They check acquisition-before-key ordering, original carrier and
Setup preservation, exact file maps, body/target drift, failed signatures and
post-sign tampering, source/attempt ambiguity, tool drift and redirected input.
The serialized compact proof is revalidated before key selection and tested for
all three targets. No actual private signing occurs in these tests. Mock hooks
are JavaScript test dependencies, not production CLI arguments.

Actual local production-key signing, all-platform native assembly/GUI/consent,
migration, updates/restart, OS trust and release acceptance remain unproven.
