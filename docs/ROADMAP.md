# Creator Hub Roadmap

## Now: One Hub Window with Hosted Apps

Follow the [corrected hosted-app plan](HOSTED-APPS.md). Adopt compatible existing
apps and show their real interfaces inside one Hub window, without duplicated
navigation or a second settings copy. Existing shortcuts route to the hosted
app. Without Hub, the same apps remain independently usable.

Prove Project Setup hosting first, then use the same contract for MCP. Retain
verified downloads, catalog, inventory and update protection as supporting work.
Never force-close Unity or replace a busy tool. Windows first; native macOS/Linux
acceptance remains separate. Hub setup detects existing Creator apps and offers
"Update and add to Hub". No apps found or "Not now" means Hub-only installation,
with existing apps untouched.

The Setup-first local preview now passes real Windows hosting, requirement
detection, persistent view/form and native folder-dialog close-guard tests.
The next local preview also passes actual read-only MCP hosting, own resources,
native picker/close protection and unchanged config hashes. Both frontends pass
persistent-view browser tests; the simultaneous native Setup/MCP test awaits the
user closing an earlier Setup session. See [protocol and evidence](HOSTING-PROTOCOL-PREVIEW.md).
Saved adoption/compatibility updates, full hosted MCP mutation lifecycle, shortcut
routing, live state transfer and cross-platform acceptance remain pending.

## Next: Projects

A Hub Projects view reads known Unity Hub and MCP locations, with explicit local
folder additions, search and Creator SDK/Banter filters. SDK badges reflect
package declarations, not runtime or build validation. It never scans every drive
or rewrites project files. Exact-version Editor opening is a separate user action.
The first Windows pass reuses Project Setup's verified cached Unity CLI for the
current Hub registry; missing/changed helpers produce a warning and no download.
Standalone helper provisioning and native non-Windows acceptance remain future work.

Next requested project-management capability: an **Updates** action for SDK and
Unity versions, using an approved compatibility matrix and a reviewed
**Upgrade a copy** flow. Project Setup owns the operation; Hub selects and shows
the project. Separate SDK-family/pipeline conversion from routine updates, retain
the original, and validate the upgraded copy before offering it. See the
[project update design](PROJECT-UPDATES.md). No upgrade command is enabled yet.

## Creator Converter

SideQuest's Creator Converter remains Coming soon until its owner publishes a
public testing release. Use the official white SideQuest mark on black, with
a separate C badge. No guessed repository or download URL.

## Future: Creator Plugins

A community directory, not a paid store. Creators can share Unity/Creator SDK
packages, plugins and tools by linking their GitHub repository or website.
Creator Hub takes no fee or commission. No payment or subscription work is
planned. Submitted projects retain their own licenses.

Hosting is undecided: a small reviewed GitHub Pages index, Bonto integration,
or an owner-operated server are candidates, not current dependencies. Start
with links before taking on package storage. Optional SideQuest account linking
needs SideQuest's supported authentication contract and approval; it must not
be invented or promised as available.

Before public submissions: define moderation, abuse reporting and takedown,
license attribution, compatibility metadata and package provenance. Browsing
a community listing must never authorize downloading or executing its code.
Keep community submissions separate from the first-party signed app catalog.

Use the [community index proposal](COMMUNITY-INDEX.md): reviewed JSON listings
through GitHub PRs, optional description/icon overrides, and a static index.
Packages and **Community Tools** are separate sections. Useful MCP-generated
scripts can stay as local feedback drafts, or become an explicitly approved
source contribution/repository listing with license and test notes. Never publish
or execute collected feedback automatically. Bonto is a future adapter to assess,
not an assumed service dependency.

No submissions, hosting, sign-in or plugin installation is implemented now.
