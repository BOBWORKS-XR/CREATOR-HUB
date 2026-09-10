# Community Directory Proposal

Status: design only. No submission endpoint, hosted index, package download or
execution is enabled. This is separate from Hub's signed first-party app catalog.

## Two Sections

- **Packages:** Unity packages, Creator SDK/Banter extensions, assets and plugins.
- **Community Tools:** reusable Editor scripts, MCP-created utilities and small
  standalone apps. AI-assisted origin is metadata, not evidence of safety or quality.

Both use the same reviewed listing format. No fee or commission. No account,
payment, package storage or automatic code execution is needed for the first pass.

## Submission Flow

1. The author contributes one listing JSON file through a pull request. A later
   web form can create the same draft; maintainers still review it before publication.
2. Required: unique ID, category, name, description, public source URL, author,
   license, compatibility claims and test notes. An optional HTTPS index URL may
   point to the author's package feed; its exact format must be declared.
3. Optional description/icon overrides take precedence. Otherwise a reviewed
   snapshot of repository description and owner avatar may be suggested. The
   author confirms it. Empty descriptions block publication; missing icons use
   a bundled generic icon. Never scrape a README as executable HTML.
4. CI validates bounded JSON, duplicate IDs, fields, URLs and license metadata.
   Separate review checks ownership, provenance, compatibility, useful scope,
   suspicious behavior and attribution. CI must not build or execute submitted
   code, or run privileged pull_request_target jobs against PR content.
5. A merged listing can enter a static index published with GitHub Pages.
   Initial Hub integration browses reviewed metadata and opens source links only.
   Approval of a listing is not approval of every future upstream release.

GitHub does not require a universal packages/index.json convention. Our index
would be a documented Creator directory format. A Unity Git package uses a
package.json manifest; a UPM scoped registry is a different protocol. Do not
silently treat an arbitrary index URL as either of those.

## Preserve Useful MCP Work

Keep the local feedback loop distinct from public sharing. At a natural task
boundary, an AI may suggest retaining a reusable tool, at most once for that
artifact. The user chooses Keep local, Prepare contribution, or Skip. Nothing
is uploaded by default; declining must not reduce normal MCP functionality.

Two opt-in contribution paths:

- **Small source submission:** an explicitly reviewed .cs file and short metadata
  go into a local contribution draft. A feedback Markdown file may contain a
  bounded code sample, but larger source lives beside it with a hash and link.
  Before publication the author chooses a license and verifies ownership.
- **Repository submission:** the author owns a public repository. The listing
  links to a specific reviewed version/commit, with a README and license. An AI
  can prepare the repo contents or a PR only after the user asks it to share.

Record the problem solved, Unity/SDK versions tested, dependencies, limitations,
permissions and side effects, file hashes and whether human runtime testing
occurred. Strip private scene paths, credentials, client configs, proprietary
assets and unrelated project code. A reusable helper derived from purchased
assets is not automatically redistributable. A compilation result is not a
headset or multiplayer acceptance result.

Do not auto-promote C# from feedback into trusted tools, run it during indexing,
copy it into Assets, or compile it on another person's machine. Useful prototype
and reviewed release are separate states. A low-friction submission process is
compatible with a strict execution boundary.

## Future Installation Gate

Before enabling install: exact version and immutable artifact/hash, declared
Editor-only vs runtime scope, target-project confirmation, dependency/SDK checks,
reviewed file changes, backup/conflict handling and uninstall/rollback behavior.
Downloaded metadata, icons and nested feeds need byte/count/time/redirect limits;
reject file URLs, credentials, local/private network destinations and executable
HTML/SVG. Do not recursively trust linked indexes. Community signatures, if
introduced, use separate keys and cannot sign first-party Hub app releases.

## Hosting Choice

Start with GitHub PRs plus a static index. No separate server is required for
that design. Bonto is a possible later adapter, not a selected backend: obtain
its supported API, storage/moderation rules and authentication contract from
SideQuest before committing to integration. Do not invent SideQuest sign-in.

Primary references checked 2026-09-10:
- [GitHub Pages setup](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)
- [Unity Git package dependencies](https://docs.unity3d.com/6000.3/Documentation/Manual/upm-git.html)
- [Unity scoped registries](https://docs.unity3d.com/6000.3/Documentation/Manual/upm-scoped.html)

## Example Listing (Draft, Not Published)

```json
{
  "schemaVersion": 1,
  "id": "example.editor-placement-helper",
  "category": "community-tool",
  "name": "Editor Placement Helper",
  "description": "Places selected prefabs on a chosen surface.",
  "author": "Example author",
  "sourceUrl": "https://github.com/example/editor-placement-helper",
  "license": "MIT",
  "aiAssisted": true,
  "scope": "editor-only",
  "compatibility": {
    "unity": ["6000.3.21f1"],
    "sdk": ["unity-only"]
  },
  "testNotes": "Example only; not tested or available for installation."
}
```

No license is inferred from a public repository, no quality badge is inferred
from popularity, and descriptions supplied by authors remain untrusted text.
