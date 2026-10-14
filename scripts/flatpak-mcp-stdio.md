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
replacementStage], replace, env)`. It has no CLI, workflow, hardcoded product pins,
build, deploy, route-activation or host-settings writer. Nothing invokes it
automatically. Parent coordination and new independently reviewed products are
required before executing it. Do not reuse old evidence as acceptance of this recipe.

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
node --test scripts/flatpak-package.test.cjs scripts/flatpak-mcp-stdio-probe.test.cjs scripts/flatpak-retention.test.cjs scripts/flatpak-replacement-source.test.cjs scripts/flatpak-gui-probe.test.cjs scripts/module-archive.test.cjs
```

Review recheck on Windows, Node `v22.22.2`: **83 passed, 1 Linux-only mode test
skipped, 0 failed**. `git diff --check` passed. No native build, dispatch, product
download, deployment, index writes, commit or push was performed for this revision.

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
