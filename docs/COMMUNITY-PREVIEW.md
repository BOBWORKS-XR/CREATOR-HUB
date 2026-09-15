# Community Catalogue Preview

This is a page in Creator Hub and both standalone apps, not a fourth app.
The shared source is `src/community.js`, `src/community.css`,
`src-tauri/src/community.rs`, `src-tauri/src/community_package.rs` and
`src-tauri/src/community_project.rs`, plus the
four files in `unity/com.creatorworks.plugins`. Keep these byte-identical
across the apps. Each app owns its native wrappers and lifecycle guards.

## Data

Fixed feed: `https://raw.githubusercontent.com/SideQuestVR/Creator-Community/main/index.json`.
Entries are paths to versioned `packages/<id>/<version>/listing.json` files in
that repository. No user-supplied feed URLs, executable commands or install
scripts are accepted. This community feed is distinct from the signed app feed.

Search matches name, description and author. Type filters cover Visual Scripting,
prefabs, plugins, Editor tools, recipes, MCP tools (`mcp-tool`) and AI skills
(`ai-skill`). The same category IDs are accepted by the native catalogue reader,
Unity menu and contribution schema. MCP/skill listings use contributor setup
instructions or verified ZIP downloads; no AI-client configuration or automatic
tool/skill installation is performed. ZIPs and instructions-only entries never
offer Unity import. Screenshots are optional and use
the SideQuest CDN or this community repository. Broken images have a fallback.
Compatibility arrays contain actual tested versions; empty means unverified.

The public Start Location entry credits Mr. E / egon.gb and was approved for
listing by the maintainer on 2026-09-15. Its package contains two C# files and a
scene as well as graphs. The reported open licence is not a named MIT grant.
The local pending test fixture is not silently substituted for the public feed.

## Downloads

Only `reviewStatus: listed` enables the native save action. The exact catalogue
entry is resolved again natively; the renderer supplies an ID, never a file URL.
A native dialog selects the destination. The size and SHA-256 must match before
an atomic no-clobber save. Downloads are limited to 32 MiB in this first pass.
Never run a downloaded file or automatically import it into Unity.

## Add To Project

The alpha.8 candidate enables experimental project integration. The native
capability and catalogue flag share one setting; the UI defaults to disabled
unless the native response explicitly enables it. Publication still requires
acceptance of the exact packaged build. Project consent, catalogue authority,
archive checks and Unity's interactive import review remain mandatory.

The development page offers an explicit project selector and native folder
picker. Opening the selector does not change a project. Targets are inspected
natively; renderer commands supply a cached project ID, never an arbitrary
project path. Unity 2022.3 or newer is required. Missing SDKs are identified,
not treated as evidence that a community package is compatible.

`Add Unity menu` installs an Editor-only embedded package after native consent
and only while the selected project's Editor is closed. Existing different
helper files are never replaced. The manifest and scenes are not rewritten.
The menu is `Creator Plugins > Browse`; it needs neither MCP nor an SDK.

`Add to project` rechecks a listed, current catalogue entry and its exact bytes,
then asks for native consent and queues it outside `Assets`. In Unity, the user
chooses `Review import` and sees the ordinary interactive package import dialog.
Unity import itself can add code or replace selected assets; this is why it is
reviewed, never silently executed. A checksum is not a code-safety guarantee.

Desktop preflight uses bounded gzip/tar readers without extracting files. It
rejects unsafe destinations, links, duplicate paths, invalid GUID records and
oversized metadata. The approval shows actual paths, code/scenes and existing
destination counts. Existing GUIDs elsewhere in a project remain Unity's
responsibility; this is not a complete dependency or compatibility analysis.
Only graph/prefab/plugin/Editor-tool asset packages with a Unity scope can enter
this route. AI skills, MCP tools, recipes and instructions-only entries cannot,
even if their filename ends in .unitypackage.

Each category includes incorporation steps, alongside the author's usage notes.
Asset organization belongs inside Unity after import, not in the archive or an
external filesystem move. See PLUGIN-HANDLING-PLAN.md for acceptance status.

Requests and receipts live in `.creator-plugins`. Desktop operations use an
exclusive cross-app lock. Queue status is not success: `queued`, `review`,
`imported`, `cancelled` and `failed` are distinct. Import is recorded only from
the matching Unity callback, including across script reload. It does not prove
compilation, gameplay or headset behavior. No automatic retry or scene saving.

Queued requests and the validated `active-review.json` marker provide the first
two states without repeatedly writing receipt files. A final receipt is created
once and takes precedence if the active marker remains after a reload. Malformed
or mismatched tracking files fail visibly. Intermediate receipts from older local
previews are preserved and require inspection; they are never overwritten or
used as permission to repeat an import.

Current preview limits are 32 MiB per package, 100 retained inbox requests per
project, and exact-match helper reuse. Automatic history cleanup, helper upgrades
and bulk imports are not implemented. Full or changed queues fail visibly.

Image and payload hosts, redirects, paths, schema version, item counts and
metadata sizes are bounded. Text is rendered as text, not HTML. Catalogue state
is cached in memory for three minutes; failed refreshes retain a marked stale
view with downloads disabled. No accounts, usage telemetry or new backend.

Hosted apps do not expose community commands over their RPC allowlists. Hub
provides the shared page; standalone navigation preserves existing project forms.

## Verify

- `npx playwright test` covers the page, navigation, states and responsive images.
- `cargo test --release --manifest-path src-tauri/Cargo.toml` covers native guards,
  parsing, URL/path rejection and download integrity.
- `node scripts/preview-community.cjs` opens a local browser preview on port 4190.
  It uses the explicit local fixture and cannot install or import anything.

This local Hub candidate also includes the reviewed hosted-pipe drain change
from `92e3ef9`. New app hashes must be reviewed and coordinated before shipping
a matched suite update. No installed apps or public releases were updated.
