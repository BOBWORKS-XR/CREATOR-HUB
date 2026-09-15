# Coordinated stable release status

2026-09-15. The user explicitly authorized stable releases for all three apps.
This supersedes older alpha.8 publication holds. No stable release has been
published by this pass yet. Publishing remains conditional on exact-binary checks.

## Versions and ownership

- Hub 0.1.0: this checkout; known-helper update/backup, shared native queue/history,
  Projects-first navigation, plugin cards/icon, stable descriptor approval.
- Project Setup 0.3.0: sibling `creator-setup-community`; same native/helper/UI
  changes, existing setup/repair behavior, stable metadata and README.
- MCP 2.7.0: BANTWORKS MCP task, sibling `creator-works-mcp-community`; owns its
  C# queue changes and release preparation. Shared native/frontend port reviewed.
- Project Setup's merge into Hub remains a separate future phase.

## Shared behavior

Known old helper is the exact four-file alpha.8 baseline from commit
`4ab615c9ccd6ac9fff49f55e298ac06e12d46fde`, frozen in
`tests/fixtures/helper-alpha8`. Unknown/edited files are not overwritten.
Update requires a closed Editor, rechecks state, retains a complete backup,
preserves `.meta` files and restores on failed publication without replacing a
raced destination. Staged contents are checked again after Windows reader waits.

The shared queue uses `.creator-plugins/desktop.lock` for short nonblocking native
and Unity operations. At explicit enqueue/retry, terminal requests move without
replacement to `history/requests`; immutable final receipts remain in `receipts`.
The entire bounded inbox and receipts are validated before archival. There is a
100 unresolved-request limit and a 1000-entry recovery scan limit. No history or
user assets are deleted. Status resolves active/history identity under the lock.

Final C# source received from MCP:
`eb62f266835bf42814c3decc224197cb74842fc316428390645d314ca28243a7`.
MCP reported 193 queue/source checks plus 10 restart/callback checks on each
Unity 2022.3.39f1 and 6000.3.21f1, and 101 offline checks per Mono version,
including Rust/C# cross-process lock exclusion. These are not native import-dialog
or exact packaged acceptance by themselves.

## Current evidence

- Hub: final native suite 103 passed, 9 opt-in tests ignored; 114 UI tests and
  13 script tests passed; all-target Clippy passed. The legacy test module was
  moved below runtime items solely to satisfy the all-target ordering lint.
- Setup: 107 native tests plus 2 binary-metadata tests, 59 UI tests, 11 artifact
  checks and all-target Clippy passed. Candidate run 34999682775 failed because
  the no-install guard fixture did not exit; no guard dialog was captured.
  Run 35000700601 (22d3334) adds owned process-tree diagnostics only.
- Final helper presentation smoke: 35 checks each in Unity 2022.3.39f1 and
  6000.3.21f1. Real Unity 6 text Cancel -> retry -> Import passed at
  `artifacts/plugins-presentation-ui-274723ab/interactive-result.json`, preserving
  cancelled/imported receipts, matching text and no active import marker.
- MCP task real C# imports passed compile/reload/reopen in both Unity versions:
  `artifacts/plugins-real-csharp-711a79e8` (6) and `plugins-real-csharp-5f1a75fc`
  (2022) in its checkout. Real ImportPackage(false), not native dialog clicks.
  Its stable candidate run 34999537564 passed upgrades from 2.6 and alpha.1;
  alpha.2 baseline installation failed before candidate installation. Diagnostics
  and exact-binary lifecycle acceptance remain pending; no MCP publication yet.
- Stable descriptor tests: 4 passed. Stable protocol claims require a separate
  `approvedForStable` receipt tied to exact size, installer hash, executable hash
  and GitHub acceptance runs. Prerelease receipts cannot promote stable claims.
- READMEs rewritten for the coordinated versions; old text retained as dated
  history. Windows x64 scope and unsigned publisher status remain explicit.

## Remaining work

1. Resolve the Setup guard-test and MCP alpha.2 baseline failures from diagnostics.
2. Download verified candidates and run installed upgrade matrices against public
   baselines, without touching installed personal apps or active MCP servers.
3. Bind Hub hosting pins to the accepted companion artifacts; build/test Hub.
4. Exercise exact packaged helper installation/old-helper update through the Hub
   native suite. Real Unity cancellation/retry/C# reload passed above.
5. Sign catalog/update metadata using the existing private key outside the repos,
   never exposing key contents. Publish exact accepted artifacts, not rebuilds.
6. Verify public asset hashes, update discovery and release/tag/source alignment.

No macOS/Linux physical Unity acceptance, unattended arbitrary-project upgrade,
malware-scanning service or headset acceptance is implied.
