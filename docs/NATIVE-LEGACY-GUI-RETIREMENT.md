# Legacy GUI Retirement

This is a Windows native leaf under test, not completed convergence or release
acceptance. The production guide does not invoke it yet.

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
- The older complete-uninstaller acceptance remains preserved at run 38542947181;
  it does not establish this separate compatibility-retirement operation.
- Production coordinator/native consent, GUI quiescence, signed-router reconnect,
  next Hub update/uninstall survival, live AI-client acceptance, and independent
  macOS/Linux layouts remain gates. Flatpak host integration remains unaccepted.

Native rename contract: [FILE_RENAME_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_rename_info)
and [SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle).
