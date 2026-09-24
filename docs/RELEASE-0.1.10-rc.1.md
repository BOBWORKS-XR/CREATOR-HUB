# Creator Hub 0.1.10-rc.1

Platform-testing candidate. Not yet accepted as a public update.

## Changes

- Apps now state whether MCP and Project Setup are installed, need an update,
  or are unavailable; verified downloads remain separate from installation.
- The app switcher shows installed/update status and offers a download shortcut
  where managed app downloads are supported.
- The platform label reports Windows, macOS or Linux instead of hard-coding Windows.
- Apps and Projects actions share the tab toolbar; duplicate page headings and
  excess top spacing are removed. Existing fonts and app/plugin artwork remain.
- Project discovery errors and unsupported app management stay explicit rather
  than leaving users on an indefinite Checking state.

## Platform Scope

This candidate packages Hub for Windows x64, Linux x64, macOS Apple silicon and
macOS Intel. In-Hub managed installation/update of companion apps remains
Windows-only. MCP 2.7.4 and Project Setup 0.3.4 are unchanged; their existing
Linux builds remain available. The current MCP release does not include an Intel
Mac package.

Installer, update-discovery and platform acceptance are still pending for this
candidate. Keep the existing stable Hub installer available for rollback.
