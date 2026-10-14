# Flatpak MCP Stdio Packaging Prerequisite

Scope: package identity and a prepared disposable SDK probe, not native host
integration, configuration migration, Unity/project operations or release acceptance.
No native build, dispatch, installation or SDK-to-Flatpak connection was run here.
This uses the existing Node 22 environment and adds no dependency or `zlib.crc32`
requirement. The duplicate JavaScript archive decoder and its TAR fixture were removed.

## Fixed Command

```text
/usr/bin/flatpak run --command=/app/libexec/creator-hub-mcp-router com.creatorworks.hub
```

The [official run contract](https://docs.flatpak.org/en/latest/flatpak-command-reference.html#flatpak-run)
states that `--command` replaces the metadata command; additional positional
arguments go to that command. This command passes none. It supplies no config,
environment, installation, runtime, filesystem, network, bus or devel override.
The native router's existing `main.rs` rejects arguments, then calls
`Store::installed().resolve().run()`. There is no Root CLI or host launcher here.

## Package Change

For managed-routing inputs only, `flatpak-package.cjs` adds a seventh staged file:
`libexec/creator-hub-mcp-router`, installed mode 0755 at the fixed path above.
The original six `OUTPUTS` remain unchanged so existing six-file consumers and
read-only packages retain their contract. The fixed recipe conditionally installs
the seventh file; a writable stage cannot pass verification with that file absent.
The four original graphics/IPC grants are unchanged.

Writable packaging requires a fourth input at the fixed original assembly path
`modules/routing/creator-hub-mcp-router`, plus an independently reviewed
`pins.files["modules/routing/creator-hub-mcp-router"]` size/SHA-256 record.
`scripts/assemble-unix-payload.cjs` already verifies the signed routing identity,
raw payload hashes and modes before placing this file there. The assembly workflow
already retains `modules/` in the artifact. Supply the original verified assembly
directory as `INPUT`; do not select a router from another build or infer its
authorization only from the candidate's own manifest.

The fourth input's pin must equal the digest in `managedRouting.files` and the size
in `payloadArchive.files` for `routing/creator-hub-mcp-router`. The existing shared
archive binding validator requires its 0755 mode. The packager checks bounded
ordinary single-link input bytes, ELF64/little-endian/x86_64, and original input
hashes again after staging. Every stage recheck binds the libexec copy to both the
independent fourth pin and manifest, even if someone edits the staged-file receipt.
The archive is kept opaque, byte-identical and unexecuted. No TAR implementation,
extractor build/invocation, signature change or public-key change was added.

Historical three-file writable pin records remain readable by `validatePins`
for existing artifact/source checks, but **cannot** authorize `prepare` or
`verifyStage` without the reviewed fourth pin. Read-only inputs still use exactly
three pins and six outputs, and refuse a router pin. Existing historical replacement
plans were not silently repinned. Parent must provide new independently verified
four-input pin records before integrating a writable package.

Independent reviewed input pins and the parent's verified signed assembly are
still required. These checks do **not** authenticate a signature or source/run by
themselves. `archiveMembersVerified` remains false until the existing shared
native decoder verifies the archive in the disposable runner. All acceptance
fields remain false. A synthetic test ELF is not a signed/native runtime test.
The parent identified outer assembly `38648562557`; this task did not independently
verify that run's source/artifact/receipt or derive any product pins from it.

## Prepared Probe

`flatpak-mcp-stdio-probe.cjs` exports `probe(work, [baselineStage,
replacementStage], replace, env)`. The probe itself has no CLI, workflow, hardcoded product pins,
build, deploy, route-activation or host-settings writer. Nothing invokes it
automatically. Parent coordination and independently reviewed products are
required before executing it. The new prepared runner below supplies the exact
pair and an explicitly seeded fixture, not production consent or integration.

Prerequisites on an explicitly opted-in GitHub-hosted Linux x64 disposable runner:

1. Set the existing `CREATOR_FLATPAK_PACKAGE_TEST=1` and
   `CREATOR_FLATPAK_MCP_STDIO_PROBE=1`. Use an already created owned
   `RUNNER_TEMP/creator-flatpak-*` context with the existing isolated HOME, XDG,
   empty GnuPG and Flatpak installation directories. Never spoof runner admission
   on the user's machine.
2. Parent verifies both signed source/run/artifact pin sets and stages them with
   this packager. The Hub hashes/deployment commits must differ, but the signed
   MCP module and `routing/runtime.json` SHA-256 must be equal for this narrow
   replacement test. Package `runtime.minisig` hashes may differ after re-signing.
   Build/export both packages beforehand without new permissions. Install baseline
   only in that private installation. Record Platform/SDK/app commits and originals.
3. Parent establishes the approved signed route in that app-private fixture using
   the real product path or a separately reviewed disposable setup. The probe only
   reads it, never manufactures consent or activates a route. An absent route is
   a prerequisite refusal, not a reason to point at host data or override XDG.
4. Supply one synchronous **bounded** `replace` callback for the parent's exact-ref
   local deployment replacement in the same owned context. It must not rebuild,
   change Platform, modify the route, dispatch a workflow or touch a live profile.
   Keep it within the probe's 120-second session lifetime.

The probe rechecks stage identity, the selected installed ref/location, metadata,
effective permissions, all seven deployed files/modes, the Platform commit, the
private active receipt, original signed descriptor/signature hashes, and retained
runtime hashes. Both before and after replacement, the retained descriptor and
signature are checked against the **baseline** manifest pins, never the replacement
package's new signature pin. Each package's own staged/deployed bytes remain
independently checked against its own manifest/pins; parent assembly trust is
still required. No route or signature is rewritten and no key check is bypassed.

Parent-supplied signing-output evidence, not independently reverified by this task:

```text
runtime.json (both): fe4d3fc0bca53e54188d41c6a2d37494c151fdff4b9a7ba1c424ce3e97ffa872
baseline minisig:    9139ebb3e4c0eaf0b276e14c6321cf290db9ff132a3ae0f6731cbb9dda4d390b
replacement minisig: 1f71b6aae35009e07fffb614f485f429782dd84b58045e0540b153a2f05b8930
```

It opens official SDK connection A using only the fixed command,
enumerates tools, invokes the parent replacement once, opens B, enumerates both,
then closes its own SDK transports and checks the context again. RPCs have a
10-second bound; inspections have 30-second/64-KiB bounds; sessions have a
120-second lifetime and 64-KiB stderr budget. Parsed tool results are capped at
256 KiB and 1,024 tools without pagination. SDK internal stdout buffering is not
an independently measured memory bound. No tool is called or project modified.

The existing `flatpak-disposable.cjs` still checks only the original six deployed
files; its success alone does not prove the new libexec copy or stdio works.
The new probe supplies that check but has only been fixture-tested here. A real
missing-route/no-argument refusal capture, SDK stdio connection, old-session
retention, deployment replacement, native process reaping and actual configured
host client/Unity acceptance remain separate unrun gates. No migration, host
integration, signed updater or release-ready field becomes true on probe success.

## Local Verification

```sh
node --test scripts/flatpak-mcp-stdio-run.test.cjs scripts/flatpak-package.test.cjs scripts/flatpak-mcp-stdio-probe.test.cjs scripts/flatpak-retention.test.cjs scripts/flatpak-replacement-source.test.cjs scripts/flatpak-gui-probe.test.cjs scripts/module-archive.test.cjs
```

Review recheck on Windows, Node `v22.22.2`: **101 passed, 1 Linux-only mode test
skipped, 0 failed**. `git diff --check` passed. No native build, dispatch, product
download, deployment, index writes, commit or push was performed for this revision.
The workflow's narrower preflight is **83 passed / 1 skipped (84 total)**;
the new runner contributes **18 passed / 0 skipped**. Embedded Python and YAML
parsed, and every workflow `run` body passed local `bash -n`.

Local fixtures use synthetic ELF bytes and a deliberately opaque non-TAR archive.
Tests cover the fourth pin and its manifest binding, original/staged byte tampering,
missing/extra/redirected files, post-copy input drift, unchanged six-file retention
contracts and bounded probe sequencing/refusals/cleanup. Archive parsing/mode/member
verification remains exclusively with the existing shared native decoder.
Linux executable-mode checks require Linux and are skipped on Windows.
Signature retention regressions use synthetic bytes to cover same descriptor with
different package signatures, changed descriptor refusal, and retained-signature
tampering/substitution refusal. SDK fixtures cover initialize/tool timeout catches,
cleanup error preservation, stderr overflow, and late initialize completion after
session expiry. The latter failed before adding the immediate post-connect expiry
check, then passed; no native connection or cryptographic signature was tested here.

## Prepared Seeded SDK Replacement Lane

New source: `.github/workflows/flatpak-mcp-stdio-014.yml`,
`scripts/flatpak-mcp-stdio-run.cjs`, `scripts/flatpak-mcp-stdio-run.test.cjs`.
Only those files and this handoff belong to this follow-through. Existing package,
disposable/probe modules, native code and other agents' helpers are not changed.
There has been **no push, dispatch, native compilation, installation or SDK run**.

The workflow follows the existing scoped-push pattern, **not** `workflow_dispatch`.
Both job and admission require repository `BOBWORKS-XR/CREATOR-HUB`, repository ID
`1364807512`, event `push` and exact ref
`refs/heads/validation/flatpak-mcp-stdio-014`. The trigger watches only its workflow
file. Parent review must precede any push that would trigger it. Admission also
requires the packaging/probe opt-ins plus the distinct
`CREATOR_FLATPAK_MCP_STDIO_SEEDED_ROUTE=1` authorization for disposable seeding.

### Immutable Pair

| Role | Product Source | Assembly / Attempt | Artifact ID | Original ZIP Bytes |
| --- | --- | --- | --- | --- |
| Baseline | `9894b1cd5387bcd6fec2d652f99a7913224e2cc7` | `38643118508 / 1` | `11931797416` | `386830987` |
| Replacement | `4f3744d5707ed5cd26c2e5a1b10a7d45a5e8d10b` | `38648562557 / 1` | `11934297227` | `380463271` |

```text
baseline ZIP:    b28ad458fb2560cea7b436ef31ed6913104c88214c29888395a2fc62235a2d19
replacement ZIP: ce7d02ecd5e72cbce9a0343003726601ab82a103e8e25348cac771d78f0ac881
router (both):   3b0c316d0b62d970c951ff653913139c20505e1d808dab47343c3cb467e81c93 (786256 bytes)
production key:  23b3eee2d1c8cb7d705120953cda67ff94a722a207d5be1679c250be8ca90308
```

The runtime body and distinct signature hashes are recorded above. `plan()` pins
both source trees, assembly jobs, original receipts and all four raw inputs;
there is no argument/env override for those pins, the key or product selection.
The current four-input pins also match
`artifacts/linux-assembly-38648562557/flatpak-reviewed-pins.json`.

Local non-executing preflight rehashed **both** original ZIPs and checked the
existing `artifacts/flatpak-stdio-stage-4f3744d` seven-file stage/provenance. Both
source commits' public-key Git blobs also match the fixed key hash. The LF Git
blob is 119 bytes; the Windows checkout has CRLF (121 bytes). Production Linux
checks remain byte-exact against LF, with no key/signature normalization or
fallback. Synthetic Windows seed tests explicitly model those Linux source bytes.

### Execution And Evidence

1. Reuse the existing remote verifier for exact successful source/tree/run/attempt,
   repository/job/artifact/version proof and original ZIP digest/size. Check each
   original source's production public-key blob too. The standard-library bounded
   ZIP step selects only the four inputs plus the original assembly receipt,
   rechecks the ZIP and receipt, then invokes the existing seven-file packager.
2. Compile only the shared native archive decoder and the existing
   `--example fixture-driver` from the reviewed harness checkout. Hash/pin and
   recheck both tools before/after use. Do not compile Root, a private app, or the
   packaged production router; do not regenerate or re-sign any product payload.
3. Reuse GNOME Platform/SDK 50 and the original offline sandboxed builder recipe.
   All children use finite private HOME/XDG/temp/installation/empty-GnuPG paths,
   not GitHub auth, real AI-client settings, projects or desktop/bus environment.
   No network/home/host/broker/devel grant or GUI launch is added to the app.
4. The shared decoder verifies and extracts each original archive into a fresh
   owned directory. Recheck the exact output map, raw hashes, sizes and modes.
   Copy only the exact MCP generation into the disposable store. Invoke existing
   production `Store` through the fixture driver with the pinned production public
   key and original real descriptor/signature: **DISPOSABLE SEEDED ROUTE**, not
   UI approval, migration or evidence that a real user's route was established.
5. Seed the baseline app-private store once. Check the replacement's independently
   signed runtime in a **separate disposable verification store**. The retained
   baseline store is not reactivated or rewritten during replacement. Build and
   install baseline, then prebuild/export replacement before opening SDK A; only
   the bounded exact-ref update occurs while A is live. Existing probe opens B
   and rechecks both connections and retained baseline signature/body.
6. A separate fixed SDK connection calls only bundled `get_mcp_reference`,
   `source=workflows`, `entryId=networking`, `limit=1`. It has no project arguments.
   Bracket it with selected private ref/location, all seven deployed files/modes,
   metadata/effective-grant/Platform and retained-route checks; close owned SDK
   transports and preserve primary/cleanup errors. This is a tool-consumer test,
   never actual AI-app or Unity operation acceptance.

The compact report includes product vs harness source, helper/key hashes, seeded
status, bounded command failures, bundle hashes, SDK protocol/retention result and
all-false acceptance gates. `seededRoute=true` and
`toolConsumerProtocolRetentionPassed=true` are narrowly scoped result fields, not
consent or integration claims. `packagedRouterActivationFixIncluded=false` remains
explicit: both packages contain the old pinned router, not the parent's later fix.

Compact reports/bindings/stage metadata upload **first**, including failures.
The roughly 800 MB original ZIP pair and generated Flatpaks are not uploaded by
default. A separate large-evidence step requires successful compact capture and
explicit repository variable `CREATOR_FLATPAK_STDIO_UPLOAD_LARGE=1`. Original
artifact identities/digests stay independently bound regardless of that opt-in.

Prepared only. Real native SDK startup, Platform compatibility, replacement,
transport/process exit, production settings retention, GUI/consent, host AI-client
configuration, migration, Unity/project operations and the later router activation
fix remain unaccepted. Parent owns the GTK/component lane and the decision to run
this isolated protocol experiment after review. Missing refs, artifacts, tools,
namespaces or libraries must fail with evidence, never broaden permissions.
