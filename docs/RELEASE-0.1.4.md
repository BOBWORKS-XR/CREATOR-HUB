# Creator Hub 0.1.4

- **Disconnect and update:** the main MCP update button now asks permission to
  stop MCP's own private runtimes, rechecks them, and continues to installation
  confirmation. No separate text link to hunt for.
- **Clear controls:** the separate Disconnect MCP only action has a visible
  button border and icon. It never installs anything.
- **Protected updates:** cancelling disconnect leaves connections running.
  Unrelated Node processes, AI apps and Unity remain open. A reconnecting client,
  changed installation or failed check stops the update with an explanation.
- MCP remains **2.7.1** and Project Setup **0.3.0**. No new companion release or
  changes to existing Unity projects are needed for this Hub interface fix.

Use **Check for updates**, then **Update Hub**. Alternatively, close Hub and run
the 0.1.4 Windows installer. Keep the default installation folder; do not uninstall
or delete settings. Finish active AI work before approving MCP disconnection.

Windows x64. The installer is not Authenticode-signed. Signed update metadata
and SHA-256 checks verify published bytes, not community plugin code safety.

## Verification

Exact product source: `3e24d87a513305f4b93339754c8ef67a4c53d9cd`.
[Packaged Windows acceptance](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35085595417)
passed all four installation/upgrade lanes, 159 UI tests, 107 Rust tests
(9 opt-in diagnostics skipped), 27 script checks and strict Rust lint.
Native disconnect and installation cancellation/retry preserved unrelated Node,
settings, project selection and unmanaged files. See [full scope](MCP-UPDATE-UX.md).

Installer size: 5,997,095 bytes. SHA-256:
`9eab81b86a291fa70ca3a9d3cb0f6c71a76bd4b527aa88aca387abb210375ea8`.

Installed executable SHA-256:
`68aa863c53798d03e4ac9eab75b6f6e22ca13f7517e976e9a04e2cf176e17cfa`.

Public 0.1.3-to-0.1.4 self-update/restart acceptance is pending. Do not treat the
installer-upgrade test as proof of the final public update route or mark this
release latest until that check passes. Older release-page notes are archived
verbatim so the release-list response stays within older clients' limits; all
previous downloadable assets remain unchanged.
