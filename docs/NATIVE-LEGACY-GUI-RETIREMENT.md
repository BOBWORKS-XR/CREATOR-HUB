# Legacy GUI Retirement

The Windows native leaf has passed official-installer fixtures. The production
guide now invokes it after backups, reviewed connections, snapshot freshness and
separate native approval. Its packaged end-to-end acceptance remains pending;
the leaf result is not completed convergence or release acceptance.

## Scope

- Accept only the independently pinned default per-user MCP 2.7.7 and Setup 0.3.7
  installations. Custom, older, machine-scoped or changed installations refuse.
- Never invoke their uninstallers in this operation. Keep all nine pinned MCP
  `server/` files at their original paths, including both Node executable names.
- Keep all existing settings and data stores in their established locations.
- Retire the exact destructive uninstaller first, then the GUI and source-proven
  default user shortcuts. Preserve those files through handle-based rename into
  Hub's local convergence before-images. Existing Node connections are not stopped.
- Preserve all raw product/uninstall registry values before deleting the exact
  native-derived keys. Distinct registry views, subkeys and stale values refuse.
- Require independently verified shortcut target, no arguments, and default or
  empty working directory. Routing alone is not publisher/installer provenance.
  Missing shortcut snapshots must remain missing; changed/foreign shortcuts stay.
- Metadata now uses typed in-process `IShellLinkW`, read-only `IPersistFile::Load`
  and `SLGP_RAWPATH`. No WScript/PowerShell process, Resolve, Save, target launch
  or environment expansion is used in production. Unsupported COM apartment,
  malformed input, invalid Unicode, empty target or truncated buffers refuse.

## Interruption And Concurrency

The bounded `before.json` stores logical file/shortcut identities and raw registry
before-images, not arbitrary filesystem mutation paths. Native paths and release
pins are re-derived on resume. There is no automatic replay: the coordinator must
perform fresh native review and retained-settings/client checks.

Each exact GUI/shortcut handle denies read/write/delete sharing through its move;
runtime handles allow reads but deny write/delete. Native file ID, volume,
timestamps, size and SHA are checked. Directory handles deny replacement while
allowing child-file moves. Destinations never replace existing files. A replaced
GUI path, changed journal, ambiguous source/archive state or unknown policy pauses.

The final receipt explicitly means `guiRetiredCompatibilityRetained`, not full
runtime removal. Unknown client contexts never authorize deleting that runtime.
Arbitrary wrappers relying on the removed GUI or registrations remain outside
the compatibility guarantee and require review before production retirement.

## Evidence And Remaining Gates

- Local Windows: five handle/journal/reservation regressions and seventeen
  shortcut inspector regressions pass (eighteen after the generated-path
  regression). Root suite before that additional regression: 313 passed, twelve ignored,
  one native-retirement test separately excluded; strict Clippy passes.
- The disposable official-installer workflow now exercises interrupted retirement,
  native resume and idempotence, exact runtime/store retention, and existing
  legacy stdio plus same-path reconnection. Run 38561260878 refused both products
  before mutation: the shortcut reader generated a PowerShell path containing
  forward slashes, rejected by its exact-path guard. Original reports remain in
  `artifacts/legacy-retirement-38561260878/`. Component-wise joins now pass a new
  no-spawn native-command regression; the corrected native run remains pending.
- Run 38562397580 refuses before mutation with a ten-second shortcut probe
  timeout on both products. Original evidence is retained separately. An actual
  local temporary ShellLink fixture passes with both absent and present targets
  while its read-only reservation stays held (308/292 ms, exit zero, both EOFs).
  The runner cause is unknown. Deadline diagnostics now include exact child
  status, stdout/stderr sizes, EOF states and elapsed/spawn times, without raw
  environment or output values. No deadline/ownership guard is relaxed.
- Run 38565677434 at `cc34ff6` catches the timeout in the new temporary native
  COM fixture before any installer starts. At the deadline the child is still
  running, stdout/stderr are both empty, neither EOF is observed, and spawn
  took 2 ms. This is not an EOF-after-exit failure. System-environment versus
  COM/startup phase remains unverified; a controlled comparison is pending.
- The controlled comparison in run 38568393682 at `770492d` reaches
  `before-new-object` and stalls at `New-Object -ComObject WScript.Shell` with
  minimal, accepted OS allowlist and repeated minimal contexts. No installer
  starts. This does not establish whether cmdlet loading or WScript activation
  is responsible. The scripting dependency has been removed rather than its
  deadline extended. Nine real native extractor tests and seventeen snapshot
  tests pass locally; native hosted/official-installer acceptance is pending.
- Run 38572696237 at `dff82df` passes both exact official-installer fixtures.
  GUI/uninstaller/default shortcuts and their registrations are retired;
  all nine MCP compatibility resources and all eight synthetic persistent
  stores remain unchanged. Existing MCP stdio survives interrupted retirement,
  resumes after native re-review, reconnects at the same old paths and exits
  normally on EOF. Idempotent repeat and unknown-journal refusal pass. Local
  reports are `artifacts/legacy-retirement-38572696237/`. Root 322 tests and strict
  Clippy pass. This is leaf acceptance, not production coordinator or release
  acceptance; no user-PC app was changed.
- The older complete-uninstaller acceptance remains preserved at run 38542947181;
  it does not establish this separate compatibility-retirement operation.
- Production coordinator/native consent, GUI quiescence, signed-router reconnect,
  next Hub update/uninstall survival, live AI-client acceptance, and independent
  macOS/Linux layouts remain gates. Flatpak host integration remains unaccepted.

Source integration on 2026-10-14 adds explicit retirement/refresh phases, native
cooperative GUI close and startup inspection of unfinished journals even when
the original GUI is absent. Per-app inspection no longer requires an unrelated
product's already-retired GUI to remain installed. Full-directory removal keeps
its original unknown-scope refusal; the separate GUI-file negative check retains
unknown diagnostics and requires custom-GUI risk approval. Source tests pass;
these changes still need a new current-payload native acceptance run.

Native rename contract: [FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info)
and [SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle).
