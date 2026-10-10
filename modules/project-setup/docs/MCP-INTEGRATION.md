# Optional Creator Works MCP Companion

Status: superseded as the primary direction by the approved optional Creator Hub
approach. These companion notes remain useful constraints, but first-launch
assistance should live in the Hub rather than be duplicated in every tool.
The Windows Setup app remains independent. Hub compatibility belongs to the
next version; the published 0.2.2 files remain unchanged. The governing plan and
shared metadata contract are in [CREATOR-HUB-PLAN.md](CREATOR-HUB-PLAN.md).

## First Pass

- A genuinely new MCP launcher setup can ask, once: "Need help setting up Unity
  and the Creator SDK?" Offer Open Setup and Not now without blocking the normal
  project picker. Keep a permanent Unity & Creator SDK Setup action for later.
- Persist dismissal/opening. Existing current or migrated legacy users should
  not receive a new first-run prompt merely because they update or disconnect.
- Launch the companion only after a user click, with normal permissions.
  Installation, repair approval, licensing and Hub restart stay explicit actions
  in Setup. Do not bundle the Unity Editor or install a second MCP.
- Initially launch the portable GUI without arguments. The user browses the
  resulting project back into MCP Quick Setup. Do not interpret GUI exit as
  validation success or automatically change the active MCP project, inject a
  bridge, or rewrite AI client settings. MCP's existing connection action stays
  separate.

## Distribution Boundary

The owner approved public distribution of this repository and the 0.2.2 Windows
release. Public release downloads must work without GitHub accounts or access
tokens. Never embed a token in a Hub or installer. A manually selected portable
helper remains a useful offline option.

Prefer a verified on-demand download after a user chooses Install.
Pin exact platform/version/size/hash in the MCP release initially. A future
mutable manifest needs independent authentication with a pinned signing key;
fetching an EXE and its checksum from the same mutable location alone does not
authenticate its publisher. Bound downloads/extraction, reject path traversal
and links, publish the cache atomically, reverify before reuse, and never launch
or replace it silently. Offline, cancellation and verification failures must
leave the normal MCP workflow usable. Keep preview and stable channels distinct.

The 0.2.2 Windows x64 portable EXE is 11,522,560 bytes; its ZIP is 3,717,304 bytes.
The ZIP executable path is
`Creator-Project-Setup-0.2.2-Windows-portable/Creator-Project-Setup-0.2.2-Windows.exe`.
Release assets include checksums, instructions and an MIT source license. The
EXE is unsigned and needs the installed WebView2 runtime; the optional NSIS
installer handles that prerequisite. Unity and Creator SDK are not bundled.
There is no single-instance guarantee or integration argument contract yet;
avoid duplicate companion processes owned by the MCP launcher. Closing during
validation is not a tested cancellation contract.

## Later, Only If Needed

A versioned request/result file can replace manual project selection. Use a
bounded, per-user session directory and matching random request ID. The request
may suggest a user-selected path but must not convey installation or repair
approval. Setup can atomically return completed/cancelled/failed status, its
version, canonical project path, profile and observed validation warnings.

MCP must independently validate that advisory result before offering the project
to the user. Reject stale, malformed, mismatched or unknown schemas without
changing settings. No localhost listener, deep-link registration or automatic
bridge connection is needed. Setup owns versioned recipe pins rather than
hard-coding them indefinitely in MCP.

Acceptance should cover fresh install, upgrades without prompts, dismissal,
manual reopening, offline/cancel, bad hashes, partial extraction, cached older
versions, helper already running, paths with spaces, and return to an already
configured MCP project without changing its route or client configuration.
