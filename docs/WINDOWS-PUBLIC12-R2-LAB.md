# Public 0.1.12 To R2 Controlled-Feed Lab

This is a disposable Windows test lane, not a release, migration, public
discovery or general old-client acceptance. No descriptor signature or native
acceptance exists merely because these scripts and tests pass.

The already-registered `windows-016-input` workflow stages the fixed R2
installer from the private validation draft plus independently identified
descriptor, descriptor signature and Tauri manifest assets. The `signed012`
mode of the already-registered `windows-incoming-016` workflow requires an
independent five-hash signed-pins object and
checks exact content before staging the pinned public 0.1.12 baseline or
changing runner trust. It uses the generic public12 five-route transport and
the original baseline installer and installed executable hashes. The modified
driver's explicit test-only branch checks ownership of the CDP process tree
before and after connection. The disposable lifecycle owns and removes its
proxy, certificates and policy changes.

## Test Descriptor Prerequisites

After independent signing review and authorization, create a separate private,
test-only descriptor with the exact R2 release fields and only
`minHubVersion` changed from `0.1.14` to `0.1.12`. Retain R2's exact installer
SHA-256 `7326d054ac23b7ac560e2c3488933203a33f0033586b1c33988ce7f316e4c51a`
and extracted executable SHA-256
`fac846563720eb4dae665a814ea28d0556800ebaf75aba7e8ee0be7f1979a5cd`.
Keep identity/lifecycle protocol 0 and installer protocol 1. Sign the descriptor
with the trusted catalog key using the reviewed isolated signer boundary; this
is real production-key authority even though the artifact is test-only. Do not
replace or publish existing signed release metadata. Verify descriptor signature
with the 0.1.12 trust key, and independently verify the existing R2 Tauri updater
manifest/installer signature with the 0.1.12 updater key and exact installer.
Record the exact signed bytes, digests, verifier and signing provenance. The
JavaScript transport checks hashes and signature envelopes, not cryptographic
authenticity; the actual installed updater must perform signature verification.

After reviewed test-only assets are available in the existing private validation
draft, independently record names, asset IDs, byte lengths and digests for the
descriptor, its detached signature, and `latest.json`. Supply all twelve
metadata name/ID/byte/hash inputs to the registered `windows-016-input` stager.
After verifying its completed run, artifact ID and archive digest, supply those
identities to the `signed012` mode and separate `signed_pins` JSON with exact `descriptor`, `descriptorSignature`,
`installer`, `manifest`, and `executable` SHA-256 values. No placeholder pins,
version-masquerade fixture, forged success receipt or signature bypass is used.

Only after reviewing and explicitly dispatching the workflow, a fresh runner
must verify public12 installer and executable, exercise actual UI discovery,
cancel, exact R2 update, automatic restart and direct MCP/Setup operations,
and preserve settings. The checked receipt and TLS/proxy cleanup evidence are
lab-only. A passing lab is not public discovery, migration, or release approval.
