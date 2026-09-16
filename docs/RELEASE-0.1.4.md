# Creator Hub 0.1.4

Published stable and marked latest on 2026-09-16 after public self-update
acceptance. [Download](https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/tag/v0.1.4).

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

[Public self-update run 35088525701](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35088525701)
passed on a disposable Windows runner using the unchanged public installers:
0.1.3 discovered 0.1.4, native Not now preserved the old installation, and
approved Update Hub installed the exact hash above and restarted automatically.
Footer and uninstall registry reported 0.1.4. The browser preference and
unmanaged installation file survived; the test-only browser policy was restored.

All six public assets were independently downloaded and byte-matched. The
application trust key verified catalog/updater signatures and installer/EXE
binding, including tamper rejection. After latest promotion, the anonymous
latest-download feed matched the same signed 0.1.4 feed. The legacy release-list
response is 255,193 bytes, leaving 6,951 bytes below the shipped 256 KiB ceiling.
Six older release-page bodies were archived in the repository and replaced with
short links; all 148 previous downloadable assets remain unchanged.

## Publication Audit

- Guarded draft publication passed its projected feed-size check. Its immediate
  public read did not yet contain the expected signed files and correctly
  withheld readiness. Release state was inspected before any retry; subsequent
  anonymous reads passed. No installer or metadata was replaced. The cause of
  that initial missing-feed response was not established.
- Run 35088239465 hit a stale test assertion expecting 0.1.3 even though the
  actual UI correctly displayed "Version 0.1.4 is ready to install." The run was
  cancelled; its original failure report is retained. Harness-only commit
  ebfd622 derives assertions and report text from the release pins and adds a
  regression check. All 15 focused publication tests passed before the successful
  rerun. Product source, tag and accepted bytes did not change.
- Latest promotion followed the successful public native test, not just the
  installer test. No user installation, AI session or Unity project was changed.
  These checks do not establish every historical migration, every AI client's
  reconnect behavior, or native macOS/Linux acceptance.
