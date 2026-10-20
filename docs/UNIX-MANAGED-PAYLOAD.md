# Experimental Unix Managed Payload Preparation

Only the unsigned preparation stage is implemented. This is not a complete
three-stage signed producer/assembler, native acceptance, or a release gate.
Windows/default Unix builders retain their previous path and policy.

## Native Preparation

The dedicated `.github/workflows/unix-managed-payload.yml` dispatch may run:

```sh
npm run build:unified -- unique-name --prepare-managed-unix --managed --experimental-unix --experimental-unix-writable
```

It requires the matching native Linux/macOS architecture, GitHub-hosted runner,
canonical repository identity, exact workflow dispatch (or the explicitly pushed
`validation/unix-payload-014` branch), positive run/attempt IDs,
`HEAD == GITHUB_SHA`, and a clean initial checkout including untracked source.
Signing credential environment variables refuse before Git inspection. These
are runner/environment guards, not cryptographic attestation. `--installer`
refuses. Existing dirty files are neither repaired nor removed.

The producer generates MCP's release payload, compiles the two private backends
and router with locked dependencies, and retains the existing Mac ad-hoc signing
order. It does not select a private key, create routing signatures, run the archive
decoder/wrapper, compile Hub, build installers, or change permissions/accounts.
Private Node is not re-signed. Ad-hoc signatures are not Apple trust/notarization.

Output under a fresh `artifacts/unified/unique-name/` contains:

- `modules/`: exact MCP/Setup staged files, with no routing activation metadata.
- `router-for-package`: finalized native router bytes, not routing authority.
- `builtin-manifest.json`: existing schema-1 module hashes, no archive/routing.
- `mcp-runtime.json`: deterministic existing runtime signing input.
- `prepared-unix.json`: bounded unsigned source/target/mode/file receipt.

The receipt includes Hub/module identities, source/build commit and source tree,
workflow/run/attempt, explicit compiled experimental flags, every file's SHA-256,
size and canonical 0644/0755 mode, including Setup and router. Captures reject
links/nonregular files, hard links, oversized files and identity/content drift.
MCP's compile-bound input check remains in place. Git commit/tree are rechecked
before the receipt; build-generated working-tree changes are not called a clean
final checkout or reproducible-build proof.

`unsigned=true`, `privateKeyIncluded=false`, `nativeGuiTested=false`,
`nativeConsentTested=false`, and `releaseReady=false` are fixed. A failed attempt
may leave partial evidence in its fresh output, but never a successful receipt.
Do not reuse that output name or promote a receipt into authorization.

## Remaining Signing and Assembly Blocker

`--signed-unix-input ABSOLUTE_DIRECTORY` deliberately refuses before input
inspection, key selection, output creation, or any build. There is no insecure
fallback to rebuilding or locally signing the input.

The existing `native/module-archive` CLI explicitly admits Linux manifests only.
Reusing it for Mac transfer by relabeling a manifest as Linux would erase the
target boundary. Its production admission was not changed. Raw GitHub artifact
transfer also does not establish that extracted files belong to the independently
pinned ZIP or preserve Unix filesystem modes on a Windows signing host.

The next narrowly reviewed stage must bind the actual bounded transfer contents
to fresh GitHub API proof: repository/workflow/run/attempt, artifact ID/name/size/
digest, source/build/tree and any supported exact merge-parent relationship.
Preparation currently supports no PR merge lane. A local signer must
verify that proof and raw hashes before invoking the existing `prepare` and
`signDetached`, then sign a separate envelope covering Setup, MCP, router,
metadata hashes, source, target, mode and `privateKeyIncluded=false`/
`releaseReady=false`. Do not add provenance fields to the strict runtime schema.

`scripts/unix-payload-binding.cjs` now validates supplied independent pins and
fresh API responses for this exact preparation workflow. It binds one successful
native job/attempt, artifact identity/digest/size/creation interval, source/tree,
target and the complete unsigned preparation map. Its 29 synthetic cases pass,
including stale-attempt, foreign-source, wrong-mode and missing-Setup refusal.
It neither fetches the API nor verifies/extracts a transfer, signs metadata,
activates a router or completes assembly. The caller must acquire fresh proof
and verify the actual downloaded bytes separately.

The native assembler must independently pin and verify that envelope with the
existing offline production-key CLI, not `Store::installed` or a key override:

```sh
verify-package-input HANDOFF_JSON HANDOFF_DETACHED_MINISIG
```

Use the cargo-built `src-tauri/examples/verify-package-input.rs` command. Its
bounded trusted verification and changed-byte negative control are not invoked
by the unsigned producer. Assembly must bind canonical native modes, stage exact
verified bytes, compile only Hub/verification tools, and check final packages.
It must never regenerate MCP/Node, recompile private modules/router, re-sign inner
Mac payloads, or repair changed bytes by refreshing hashes. Linux wrapping may
only derive an archive binding from the envelope's verified raw file map.

## Tests and Evidence

```sh
node --test scripts/unix-managed-payload.test.cjs scripts/build-unified.test.cjs scripts/unix-package-payload.test.cjs
```

Synthetic subprocess/file fixtures exercise Linux and both Mac architecture
plans, forbidden signer/Hub/decoder calls, initial source and runner refusals,
byte capture, and fail-closed signed-input assembly. Test dependencies are
injected only through the JavaScript API, never through native CLI fixture flags.
Windows fixture success is not native compilation, signing, GUI, consent,
migration, installed update/restart, cleanup, or release acceptance. All exact
0.1.14 native acceptance gates remain outstanding.
