# Unified Update Integration - 2026-10-13

This is development integration, not a release or installed update acceptance.
PR21 and the source publication guard remain held.

## Implemented Boundaries

- Optional managed Windows candidates package signed runtime and router
  descriptors. The retained protocol-1 entry point stays stable across compatible
  Hub updates; changed retained bytes refuse activation rather than self-repair.
- The private MCP handshake binds managed routing only after writable native
  approval. Routed client entries have zero arguments, and launcher settings
  retain the physical server path rather than the empty-argument sentinel.
- Selected existing clients can be reviewed together. Exact before/after images,
  native displacement evidence, interruption classifications and local backups
  are retained. Unknown/conflicting outcomes never trigger blind rollback.
- Recovery is visible in MCP. Paths are independently derived from supported
  clients; the journal cannot authorize a different settings path. Adjacent
  single-client journals remain inspectable alongside the new shared batch root.
- Ordinary built-in Windows client setup uses its exact parsed snapshot too.
  Existing files use the reviewed-write journal; new-file publication refuses
  replacement. Completed history is distinguished from current completion, so
  later approved setup does not become a false interrupted-migration warning.
  Unfinished adjacent journals block new central setup. This admission is not
  a global atomic reservation against concurrent independent writers.
- Hosted bridge status and installation consume build-verified resource buffers.
  Unix pathname mutation cannot replace the consumed bridge/logo snapshots.
- Convergence restores old standalone-backed Hub views using the new verified
  built-ins. Saved paths still grant no executable authority.

## Native Updater Work

Windows keeps its published NSIS descriptor/key and guarded per-user registered
installation path. Companion NSIS management has not been enabled on Unix.

Hub has package-specific native descriptor and updater keys for Apple silicon
and Intel macOS app archives, Linux AppImage, DEB and RPM. A package cannot select
another architecture or installer type. Native descriptors require separate,
exact signed-discovery/cancel/install/restart/preservation acceptance receipts;
a Windows receipt cannot authorize them.

AppImage replacement targets the outer original file, not the read-only mounted
binary. Mac replacement stages beside Applications, rejects other bundle roots,
links, special files, duplicate/traversal entries and oversized archives, checks
the signed executable hash and native code signature, then atomically exchanges
the complete directories. The old app is retained. Failed extraction/signature
checks occur before publication; an uncertain post-swap flush outcome requests
manual restart and is not reported as untouched installation.

Unix startup fingerprints and before-install rechecks refuse observed moved,
replaced or in-place-modified installations. These are not filesystem CAS or
protection against malicious ancestor replacement, prelaunch environment
substitution, process-memory compromise or arbitrary storage cache loss.
Native Mac/Linux target replacement and full installed update tests remain
required. System security/licensing prompts are never bypassed.

Native and Windows Hub descriptor producers verify their copied signing input
against the exact reviewed package hash/size before signing. A changed source
package cannot produce a success report with a mismatched signed descriptor.

## Actual Client Evidence

Only installed clients are required: Codex, Claude Code and Claude Desktop.
Missing OpenCode/Antigravity remain format-test coverage, not a release blocker.

Codex CLI 0.162.0-alpha.17.2 reached the MCP server but initially refused its
read-only health tool as approval-required. `get_bridge_status` lacked its
read-only annotation. After adding that annotation, the actual client completed
the call with the exact disposable project path and expected `ready=false`.
No authoring tool was relabeled read-only and no global permissions were weakened.

Evidence is retained in `artifacts/live-clients-20261013-01`, `-02` and `-03`.
The passing call used a rebuilt source bundle and the candidate's private Node,
temporary client overrides and an ephemeral read-only session. It was not an
installed stable-router/signed-update or live Unity Editor acceptance test.

Claude Code connected to the candidate server, but its existing OAuth session
expired before a model/tool call. Claude Desktop opens at sign-in. User login
is required; credentials were not read, copied, transferred or automated.

## Remaining Release Gates

- Full accepted product-settings convergence and conflict review, without legacy
  uninstall/data loss. The current modules still use existing settings locations.
- Actual signed previous-stable discovery, refusal, update, restart, restored
  views and client reconnect against the exact packaged candidate.
- Writable Unix native GUI operation/consent/ownership and distribution acceptance;
  production Unix writable mode remains off. See MCP-UNIX-EXECUTION.md.
- Native Mac runtime identity/enforcement, resource/package integrity and cleanup
  acceptance on both architectures. Cross-compilation is not this evidence.
- Experimental native packages now have an explicit builder/CI path with MCP
  forced read-only and releaseReady=false. Node is not re-signed after its
  backend build-time hash; packaged resource bytes must still match the bound
  manifest. See EXPERIMENTAL-UNIX-PACKAGING.md.
- Authenticated actual Codex/Claude Code/Claude Desktop calls after fresh setup
  and upgrade, including a live disposable Editor project.
- Legacy removal and final migration helpers only after these checks. Historical
  repositories, release assets, signatures and updater files remain untouched.
