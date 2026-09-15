# Historical Catalogue-Only Handoff

Superseded for current work by [Plugins integration status](PLUGINS-INTEGRATION-STATUS.md).
The results and binaries below predate project selection/import integration.
They do not establish that the current Unity import flow is release-ready.

Verified 2026-09-14. This is a shared page in Hub, standalone Setup and standalone
MCP, not a fourth app. No release, installed application, Unity project or user
MCP configuration was changed. Local candidate versions still have baseline
labels and must not be distributed as the existing public release.

## Sources

- Hub: `C:\Users\bobman\creator-hub-community`, `feat/community-catalogue`, baseline `cfa2fa5`.
- Setup: `C:\Users\bobman\creator-setup-community`, `feat/community-catalogue`, baseline `a025a112519994670af8f48d848e408ec9dfa492`.
- MCP: `C:\Users\bobman\creator-works-mcp-community`, `feature/community-plugins`, baseline `478e241`.
- Catalogue: `C:\Users\bobman\creator-community-catalogue`, `feat/hub-catalogue`, baseline `be5771c`.

Shared JS, CSS and Rust are byte-identical in all three apps:

| File | SHA-256 |
| --- | --- |
| community.js | 060308b60d692be1c206d42b5697bc01a5e658ae256a862c6fdc7ebfa6591240 |
| community.css | 947687448c2bf91e1063d09bf68a450ba0c4f99f21439e08738c1ea927f5b07a |
| community.rs | 7d321afe8f4cf6637ef2e5e5f8dce5804a09de132cc72c7c89c9a3510f3ca93a |

## Evidence

- Hub: 90 Playwright tests passed, including both real feature-app interfaces in
  browser-hosted frames; 59 native tests passed, 6 explicitly skipped. Release
  build and strict production Clippy passed. All-target strict Clippy reports
  the unchanged baseline `platform.rs` items-after-test-module warning.
- Setup: 58 Playwright tests, 68 native tests and 2 binary metadata tests passed;
  7 explicitly skipped native acceptance tests. Strict all-target Clippy passed.
- MCP owner report: 226 Node tests, 18 standalone UI groups, 10 hosted fixture
  groups and 65 native tests passed; 2 native tests skipped. Release build and
  bundle smoke passed. Standard Clippy passed with the existing 8-argument
  `one_click_setup` warning, which blocks strict Clippy on that baseline.
- Explicit native network test fetched the fixed public index and supplied
  package, verifying its exact size and SHA-256 without saving or importing.
- AJV draft-2020 validation passed for the index and Start Location listing.
- The browser preview loaded the actual CDN graph image (526 pixels wide),
  rendered the Plugins page, and produced no page errors. Responsive image and
  overflow tests passed at 1100, 680, 390 and 320 pixels.
- Hash mismatch saves nothing; existing destinations are never overwritten.
  Stale/offline catalogues disable downloads. Navigation preserves forms and
  running workflows. Community commands remain excluded from hosted RPC.

## Local Preview And Binaries

`http://127.0.0.1:4190` is the explicit browser-only fixture preview. Node PID
53872 was started hidden; `scripts/preview-community.cjs` recreates it. It cannot
install apps, import packages or call native commands. The local fixture is not
substituted into the production feed. Screenshot: `artifacts/community-preview.png`.

Hub and Setup EXEs: `artifacts/community-candidates/` in the Hub worktree.

| Candidate | SHA-256 |
| --- | --- |
| creator-hub.exe | 14345e2cbf411e7deb568aa2bc52e8229517826792c4ca2738818d15b6be2fc7 |
| creator-project-setup.exe | d2962a58f7f8be6debe2e7a5676d12c6fd6ac369b19963855401560255f24ba8 |
| creator-works-mcp-launcher.exe | 114bcda14d9c3f4728ee2cf547d9ffedc0a4ea3f551c8f036bf9de16aca958d0 |

MCP's EXE and required server sidecars are together in its worktree at
`artifacts/community-candidate/`. Do not separate the launcher from those files.

## Remaining Release Gates

The Start Location author is credited as Mr. E / egon.gb. The user reported an
open licence; exact terms and bundled third-party content remain unverified.
The package includes two tutorial C# files and SDK sample content. Its listing
stays pending, with downloads disabled; no Unity compatibility is claimed.
`0.0.0-review.1` is a review identifier, not the author's release number.

Review the entry and exact licence; test it in an explicitly selected disposable
Unity project before recording compatibility. Publish the reviewed catalogue
and app changes only in an approved release. Update suite versions, signed
descriptors and reviewed binary hashes together, then test native hosting and
installation/upgrades. Browser-hosted tests are not native end-to-end proof.
macOS/Linux runtime acceptance has not been performed for this feature.

The separate hosted-pipe hotfix (`92e3ef9`) is deliberately excluded. Coordinate
that change separately before a suite release; do not silently include it here.
