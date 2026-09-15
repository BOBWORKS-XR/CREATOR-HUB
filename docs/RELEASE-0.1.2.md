# Creator Hub 0.1.2

- Fixes a startup conflict where scanning Unity projects could leave MCP and
  Project Setup unavailable and prevent Hub's own update check.
- Shows the installed Hub version correctly. The 0.1.1 footer mistakenly said
  0.1.0; this release reads the version from the executable.
- Shows discovery errors with a Retry app discovery button on the current page.
- Keeps Hub update checks available if companion app discovery fails. Last-known
  app details remain visible, but stale update actions stay disabled until retry.

MCP 2.7.0 and Project Setup 0.3.0 are unchanged. Update them from Hub's Apps page.
Active apps and MCP connections remain protected; nothing is force-closed.

**Updating from 0.1.1:** open Apps and choose Check for updates. If startup
discovery failed, retry that check after the project scan finishes. Alternatively,
save work, close Hub and run `Creator-Hub-0.1.2-Windows-setup.exe` from this page.
There is no need to uninstall Hub or your companion apps first.

Windows x64. The installer is not Authenticode-signed, so Windows may show an
unknown-publisher warning. Signed update metadata and checksums verify artifact
integrity; they are not a claim that community package code is safe.

## Acceptance

Release candidate acceptance is pending. Publication requires passing UI, Rust,
script, lint, packaged startup, clean-install and native upgrade checks against
the exact installer. The full in-app Hub self-update/restart is a separate test
and is not claimed by installer upgrade acceptance.
