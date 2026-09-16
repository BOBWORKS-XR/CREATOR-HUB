# Creator Plugins List/Grid Follow-Up

Status: Hub 0.1.1 published 2026-09-15. Earlier Hub 0.1.0, Setup 0.3.0 and MCP
2.7.0 binaries and tags are unchanged. Standalone grid updates remain local.

## Hub 0.1.1 Hotfix

The Hub-only release includes the grid, stable-helper migration and direct
Apps-row update controls below. The Plugins menu stays fixed while scrolling,
with a reserved content gutter. The heading, drawer brand and enlarged 40px
trigger mark switch to Creator Plugins on that page and restore Hub elsewhere.
The existing transparent PNG is used; later opaque logo drafts are not shipped.

Regression proof: the previous menu moved from y=13 to y=-1700 after scrolling;
the new tests preserve its viewport position in Grid/List at 940px and 320px.
All 137 Hub UI tests, 104 Rust tests (nine opt-in diagnostics ignored), 13 script
tests and strict release Clippy pass locally. Disposable native acceptance now
covers the published stable Hub 0.1.0 baseline, Apps-row update Cancel/retry and
both alpha.8 and stable Unity helper backup/update. Run 35017516816 passed all
four native routes. The exact installer, 17 release assets and five anonymous
re-downloads passed hash/signature verification. No local installed app or old
release asset changed. Standalone Setup and MCP
remain on their local feature branches; this hotfix does not publish them.

## Changes

- Shared desktop List/Grid buttons, responsive cards and locally persisted choice.
  Switching views preserves search, details and pending-operation state, without IPC.
- Unity List/Grid selector and persistent EditorPrefs choice. Every grid row uses
  its tallest card's measured height, with Import and Details anchored to the same
  bottom edge. Selected details use the full width below their row.
- Known stable Unity helper files can be upgraded with an exact backup. Modified
  or mixed-version helper files are refused. Existing metadata and content remain.
- Shared grid JS/C# files are in Hub, Setup and MCP. The MCP task verified the final
  Grid-default JS/C# hashes after porting.
  Hub's subsequent 0.1.1 candidate is recorded above; standalone packaging is pending.

Desktop preference: `creator-plugins.layout.v1`; Unity preference:
`CreatorWorks.Plugins.CatalogueLayout.v1`. Default is Grid; an explicit saved List
choice is respected. Desktop preferences
are per web origin/app, not a claimed cross-app synchronization service.

## Evidence

- Hub: 131 Playwright tests passed, including four grid widths (1100/680/390/320),
  long names, missing images, persisted selection, open details and pending actions.
- Setup: 61 Playwright tests passed, including grid at 980/390 and returning to Setup.
- Both apps: 31 focused Rust community-project tests passed; two explicit fixture
  diagnostics remain ignored. This includes exact stable-helper backup, metadata
  preservation and modified/mixed-file refusal.
- Both apps: all-target Clippy passed with warnings treated as errors.
- After row alignment and the Grid-default edit: 45 presentation/protocol checks passed in each of
  Unity 6000.3.21f1 and 2022.3.39f1. Fixtures:
  `artifacts/plugins-presentation-6000.3.21f1-2535c045` and
  `artifacts/plugins-presentation-2022.3.39f1-9d118688`.
- MCP task reports: 246 Node tests, 26 mocked desktop UI groups, 109 native tests
  (five intentionally ignored), and 45 presentation checks in each Unity version
  passed. Its strict Clippy run found the pre-existing `too_many_arguments` lint
  on unchanged `one_click_setup`; this is not recorded as a clean strict pass.
- The separate live Unity 6 fixture `artifacts/plugins-grid-visual-90e961d6`
  was reopened with the new helper. Its observed three-column row has aligned
  button baselines, contained long text and equal card borders. Imports are
  deliberately disabled in this visual-only fixture. No real user project changed.
- The 0.1.1 hotfix repeated packaged Windows installation acceptance, as recorded
  above. Real Unity package imports and non-Windows acceptance were not repeated.

Helper SHA-256 after alignment:
`506799fb7c9a3868d212c635217ba853084e20fc6b22c772b7565fb54ac8ab07`.

Desktop JS SHA-256 after making Grid the default:
`23916c9409318cbba59edba756e4ae0c69c74899cecae96f9625a86cbd83f164`.

The List/Grid icons are unmodified Lucide assets from its official repository;
the existing Lucide licence is retained.

## Other Pending Items

- User's alpha.8 installation detected stable releases but required Hub 0.1.0
  before updating MCP/Setup. The Hub self-update descriptor also specifies
  minimum Hub 0.1.0, so alpha.8 reports an intermediate-version block. Cache
  records and the minimum-version source check establish this circular upgrade
  requirement. The user subsequently installed Hub 0.1.0 (local installed file
  version checked). The published self-update path still needs correction and
  acceptance; do not silently change an already cached signed release descriptor.
- Direct MCP/Setup Update app buttons are now implemented on the Apps list.
  They retain the native install approval and minimum-version/busy protections.
  A currently hosted view uses the existing native-confirmed close path first;
  a declined close preserves its draft and starts no install. Successful closure
  triggers a fresh inventory check. Row updates remain on Apps and do not inherit
  hidden close/reopen options from another app's details. Desktop UI tests cover
  both rows at 940/390/320, blocked/untrusted versions and close consent outcomes.
  A running hosted Setup workflow refuses both close and install, then completes
  normally. Run 35017516816 subsequently passed actual Apps-row native Cancel/retry
  and installed updates for both companion apps.
- The left-edge puzzle notch and larger/lower piece now have a valid transparent
  export for Hub 0.1.5; see `PLUGINS-ICON.md`. Earlier opaque drafts and the
  released 0.1.4 asset are preserved. Published MCP/Setup assets remain unchanged.
- Two copy-ready stable-release Discord posts are in
  `DISCORD-STABLE-2026-09-15.md`. They do not advertise the unreleased grid view.
