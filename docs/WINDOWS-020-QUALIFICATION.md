# Windows 0.1.20 Qualification Scope

Product source: `9b65dd7aedc2eb224755db3d733a7fb19e8e8f62`.
Installer SHA-256: `2915ffac9b1c39f5facbd4030eb6addf837e0d414b96835e0f0be1564577666b`.
Installed executable SHA-256: `06908120c81f471e9774edbe5a2d09fa3c985357eea373e29e75404d1f133cf5`.

## Evidence

- [Source and bundled-server tests](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/42024389253):
  438 source tests and nine bundled-server tests passed.
- [Private signed-update tests](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/42025914021):
  three exact 0.1.19-to-0.1.20 cases passed, including cancellation, preserved
  settings, automatic restart, old connection survival and new MCP connection.
- Disposable Unity reference/graph tests passed 25 cases each on Visual Scripting
  1.9.9 and 1.9.12. Scoped shared preferences were restored exactly.
- Actual Codex and Claude Desktop each called bridge status and the bounded
  graph-performance reference. The test project's missing bridge was expected.
  Desktop configuration and all seven watched settings/app files were unchanged
  after restoration.
- Claude Code connected, but the account's quota prevented model-driven calls.
  This additional check is explicitly deferred by the release owner, not passed.

Root and Project Setup source are inherited from the qualified 0.1.19 product,
apart from the Hub version metadata. Historical migration qualification is
inherited, not described as a fresh test of every old installation on 0.1.20.
The signed descriptor requires Hub 0.1.19; earlier installations should update
to 0.1.19 first. The source, signatures, six uploaded assets and metadata-only
release association must all pass the finite 0.1.20 reader.

## Publication

The release owner approved Windows-only staged publication on 5 November 2026.
The release is first published without becoming latest. Public 0.1.19 discovery,
cancellation, signed installation, automatic restart and settings preservation
must then pass in disposable Windows CI. Only that evidence permits promotion.
Private-feed tests are not substituted for this public test.

No Forest or other user Unity project is modified. No new Mac/Linux binaries
are included. Source tests, graph validation and release checks do not establish
multiplayer correctness or headset performance.
