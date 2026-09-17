# Community Preview Galleries

The optional root `media.json` sidecar maps listing IDs to up to eight ordered
PNG/JPEG, GIF or WebM items. `listing.json` is unchanged because older released
Rust clients reject unknown fields. The original `previewImage` remains the
cover and fallback. An exact matching gallery URL avoids duplicating the cover.

Static images and GIFs are bounded to 2 MiB; WebM to 16 MiB. Animated entries
require a static PNG/JPEG poster. Desktop playback is explicit, not automatic.
WebM needs browser/WebView codec support. Unity displays static images/posters,
not animated media. Media does not change package download or import authority.

Sidecar JSON is bounded to 256 KiB, 50 unique galleries and approved hosts.
Desktop gallery requests omit credentials and refuse redirects; switching or
closing aborts unfinished requests, stops video and releases object URLs.
Unity retains at most fifty 320px thumbnails and uses bounded downloads.
Invalid or missing media does not hide the original listing or block imports.

Unity menu version 0.1.1 recognizes the exact previous alpha.8, stable 0.1.0 and
grid helper files. Explicit updates preserve a full backup and Unity metadata;
modified helpers remain protected. Existing projects are not silently updated.

## Source Validation

- Hub: 176 Playwright UI tests; 113 Rust tests; 30 release/tooling tests; strict
  Clippy. Nine opt-in Rust tests are not included in the passed count.
- Plugins-specific browser coverage includes six-image navigation at 940/320px,
  legacy one-image listings, GIF decode, real WebM playback, explicit poster
  switching, oversized retry and rejected hosts. Screenshots inspected.
- Unity 2022.3.39f1 and 6000.3.21f1: reference compilation plus 97 offline
  protocol checks each, and 52 checks each in new disposable Editor projects.
  The Editor checks cover gallery parsing, static posters, fallback, existing
  import cancellation/receipt behavior, and preservation. No user projects used.
- MCP and Setup use the same media JS, Rust policy and Unity source; only their
  existing suite-shell CSS rule differs. Setup: 110 Rust + 2 metadata tests;
  MCP: 111 Rust tests. Opt-in tests remain separately labelled.

These are source checks, not proof of published installers. Release candidates
must additionally pass installed acceptance, including the packaged WebView
gallery fixture in `scripts/verify-community-media.cjs`, hosted apps and the
previous stable Hub's signed update/restart route.

The 32 MiB package limit remains unchanged. Large ZIP submissions require a
separate manual route or a separately tested streaming package implementation.
