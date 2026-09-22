# Linux and macOS integration review

Date: 2026-09-22. Development work only; no merge, tag or release.

## Reviewed inputs

- Hub #3: f7e599643dfb5db30a621bdf9f1494df37e7c1b1.
- Setup #2: b249cb333804ac64c0390e3270207ce1ad4c702b.
- MCP #37: 769c569a4704959eb3c7d1d989577920b3643a08.

Local worktrees are C:/Users/bobman/creator-hub-platform-review,
C:/Users/bobman/creator-setup-platform-review and
C:/Users/bobman/creator-mcp-platform-review. Each uses its repository's
review/firerat-platforms branch. Existing working copies, installed apps and Unity
projects are untouched. Follow-up edits are uncommitted, on top of the PR heads.

## Findings

### Confirmed broken: must resolve before merge

1. **P1, Hub platform.rs, supported/window_action:** enabling all platforms also
   enables the Windows managed installer route. catalog.rs still selects
   creator-hub-windows-x86_64.json and validates Windows x64 descriptors;
   self_update.rs still expects Creator Hub/creator-hub.exe and NSIS. Separately,
   the new Unix window action falls back from an unreadable /proc/PID/exe to
   kill(PID, 0), which proves existence, not executable ownership. Its activation
   path reports success without activating a window, and SIGTERM bypasses the
   Windows busy/lifecycle protocol. Local follow-up separates managed-install
   capability, rejects unsupported Unix window actions without signalling, and
   makes Unix canonical path comparisons case-sensitive.

2. **P1, all three release workflows:** workflow_dispatch on a branch passes
   github.ref_name directly as tagName, permitting a branch-named release/tag.
   Local follow-ups require a v-prefixed tag for every packaging/checksum job,
   retain the existing protected-version exclusions and add source guard tests.
   This is not a complete immutable-release preflight: future publishing must
   also validate tag/source/package versions and refuse public-asset replacement.

3. **P1, Setup bootstrap.rs require_editor_closed:** the new macOS implementation
   always returns success; Linux returns success when /proc enumeration fails.
   Neither outcome proves the Editor is closed. Do not enable macOS module
   installation until ownership-aware process inspection is implemented. Local
   follow-up now rejects unsupported macOS inspection and Linux enumeration
   failure instead of returning success.

4. **P2, Setup hub_restart.rs:** the Unix restart function only gathers processes
   on Linux. On macOS it spawns another Hub without stopping or verifying the
   existing Hub, then claims success. Keep unsupported restart explicit until a
   real native restart contract exists; do not infer success from spawn alone.
   Local follow-up restricts this implementation to Linux and returns the manual
   restart guidance on macOS.

### Unknown / acceptance required

- Setup bootstrap.rs module_selection(None) requests Android only, while
  logic.rs requires WindowsStandaloneSupport on every host. The repair path
  treats Windows support as built-in and cannot add it. Inspect the pinned
  Unity release manifests for each OS/CPU and select supported target modules
  explicitly; prove clean installation and repair on each target before enabling.
- MCP and Setup use fs2/flock for Unix UnityLockfile probing. Their synthetic
  tests use the same lock implementation, not a real Unity Editor. Prove that
  supported Linux/macOS Editors hold the corresponding advisory lock before
  interpreting successful lock acquisition as permission to modify the project.
- Unix open file handles do not provide the Windows deny-write/deny-delete image
  lock guarantees. Review executable/payload verification and operation ownership
  before enabling writable hosted controls. MCP authorize still explicitly
  rejects writable hosting outside Windows; both companions reject macOS
  parent_host. Native binary paths and per-platform accepted hash pins are also
  needed; Windows hashes cannot authorize ELF/Mach-O executables.
- Mac system-root symlink exceptions need targeted fixtures, including nested
  user-controlled symlinks and canonical temporary directories.
- Linux AppImage, DEB and RPM installation identities differ from macOS .app/DMG
  and Windows NSIS. Packaging success alone does not establish discovery,
  installation, update, relaunch or uninstall support.

### Correct / useful foundation

- PRs retain Windows paths and introduce native build matrices, Linux UI fixes,
  Unix executable names and Linux parent-process checks.
- MCP CI run 35440120596 is green for Node 20/22/24 and Windows/Linux/macOS
  launchers at its reviewed head. This is CI build/test evidence, not physical
  Unity workflow acceptance. Hub and Setup PR check rollups were empty when read.

## Verification of local follow-ups

- Hub Windows release Rust tests: 120 passed, 11 deliberately ignored.
- Hub script tests: 34 passed, including release guard and checksum checks.
- Hub Playwright: 179 passed with both companions' PR frontend sources.
- Setup Windows release Rust tests: 118 unit tests and 2 integration tests
  passed; 12 deliberately ignored. This does not execute the Unix-only paths.
- Setup focused checksum/release guard checks: 3 passed.
- MCP release guard check: 1 passed.
- Initial script run failed because the new worktree had no npm dependencies;
  npm ci --ignore-scripts installed its lockfile dependencies and the rerun passed.
- Unix-only regression tests were added but NOT executed on Windows.
- Available WSL distro reports Linux x86_64 but lacks cargo/rustc/node/WebKit
  development prerequisites; it also reported a systemd user-session startup
  error. No packages or system configuration were changed to repurpose it.
- No physical Linux/macOS install, Unity lock, update or notarization acceptance
  was performed. No live processes were stopped.

## Implementation order

1. Finish PR safety corrections and integrate non-publishing build/test matrices:
   Windows x64, Linux x64, macOS arm64 and Intel. Keep FireRat's authorship.
2. Add per-platform app discovery, signed descriptor identity, package type,
   resource paths, ownership checks and hosted read/write capability negotiation.
   Preserve manual installation when a platform lacks an accepted update route.
3. Make Unity prerequisite planning manifest-driven for each supported host;
   add real Editor active/stale-lock and module-install protection tests.
4. Build native candidates and test clean install, previous-version upgrade,
   cancel/retry, open/busy companion views, restart/restore, unrelated processes,
   plugin queue/import and settings preservation. Only then prepare explicitly
   scoped preview releases, with macOS signing/notarization status stated.

## Workshop coordination before any version bump

User requested coordination with Build Creator Plugin Workshop on 2026-09-22.
That task confirmed by a fresh GitHub check that no newer paid schema or commerce
sidecar has been implemented. Catalogue PRs 13/14/15 publish the FireRatShader
(Paid) listing, artwork and description. The listing remains instructions-only
with no download object; GitHub is Source, and its README links to Patreon and
the product website. Current pricing is not verified and belongs on the author's
purchase page. The shader's commercial EULA is not the documentation's CC-BY-4.0
licence. No purchase, shader import or runtime acceptance was performed.

Next release scope, proposed rather than an established schema contract:

- Add an explicit Paid badge and purchase/product/docs actions in the shared
  desktop Plugins page and Unity window. External commercial listings must never
  imply ownership or offer automatic import of unpurchased files.
- Use separately validated HTTPS external actions. Do not loosen package/media
  download allowlists just to permit Patreon or the author's website.
- Consider an optional supplemental metadata file keyed by exact id and version.
  First prove old-client behavior: released strict listing parsers may reject
  additional fields. Preserve the current title, README, Source and version arrays
  as fallback; missing/malformed supplemental data must not hide legacy entries.
- Separate render pipeline, Unity/SDK version, host OS, build target and headset
  runtime. Record author-reported versus maintainer-tested evidence per claim;
  unknown is not incompatible. Existing desktop community.js and Unity
  CreatorPluginsWindow.cs label version arrays as 'tested', even when the strings
  are author-reported; update presentation with provenance rather than promoting
  those claims to verified compatibility.
- Test missing/malformed metadata, exact-version joins, unsafe URLs, commercial
  no-download entries, unknown compatibility and desktop/Unity consistency.

No app versions were changed, no catalogue schema was published, and no paid
product content was downloaded or redistributed during this coordination.

## Paid-listing implementation follow-up

Implemented locally in all three review worktrees after user approval:

- Optional products.json metadata joins only an exact listed id/version with
  instructions-only scope and no downloadable package. Missing or malformed
  metadata preserves legacy catalogue entries.
- Desktop and Unity show Paid, Purchase and Product website actions, plus
  compatibility dimensions with author-reported or maintainer-tested provenance.
  Legacy version arrays are no longer labelled as tested without evidence.
- External links have a separate bounded HTTPS allowlist. Credentials, query
  strings, fragments, explicit ports and backslash normalization are rejected.
  Package download permissions are unchanged; paid metadata grants no import.
- Unity helper version is locally 0.1.2. Exact released 0.1.1 helper bytes can be
  backed up and upgraded; edited copies are preserved and refused automatic
  replacement. Historical fixtures preserve their original byte hashes.
- The Workshop task supplied a provisional local FireRat products.json and
  validator, not a published catalogue change. Its eight validation tests pass.
  The actual candidate is captured in consumer fixtures, alongside the unchanged
  legacy listing, to test both contracts together.

Verification: 181 desktop UI tests passed against the companion PR frontends.
Full Windows Rust suites passed: Hub 124, Setup 122 unit plus 2 integration,
MCP 121 (intentional ignored tests remain). The subsequently added actual
Workshop candidate regression is checked separately in each consumer.
Unity presentation smokes passed on 2022.3.39f1 and 6000.3.21f1 in disposable
projects. Unity 6 includes the final strict raw-URL authority check; the earlier
2022 run predates that last hardening. MCP launcher bundle smoke also passed.

An initial historical fixture hash failure was resolved by restoring the exact
released LICENSE.md line endings, not by changing accepted hashes. Four UI
assertions were updated to the deliberately neutral compatibility wording.

No application version bump, commit, push, PR merge, installation or release was
performed. This work does not resolve the native-platform acceptance gaps above.
The optional metadata must be published separately before public clients can
display these new product details.
