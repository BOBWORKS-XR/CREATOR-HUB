# Alpha.4 Hotfix Candidate

Status: local candidate, not published or installed on the user's machine.
The public alpha.3 release is unchanged. MCP and Project Setup payloads and
their accepted hashes are unchanged.

## Changes

- Projects default to Recently modified, with Name A-Z as another sort option.
- Search, SDK filters, explicit launch IDs and busy-operation protections remain.
- Modification dates use saved source metadata, excluding generated Unity
  folders. Windows enumeration supplies cached file metadata rather than an
  extra filesystem query for every asset. Limits remain: 200,000 entries and
  500 ms per project, 2,000,000 entries and 5 seconds total. Checks run in the
  existing discovery worker, on demand only; these cooperative time budgets
  cannot interrupt a stalled operating-system filesystem call.
- Missing, unreadable or incomplete dates are labelled unavailable and sort last;
  no root-folder date is substituted for a nested scene edit.
- Upgrade blockers include process IDs, executable paths and the observed
  starting process when identifiable. No command lines or credentials are
  exposed. A parent that started after its child is not attributed to it.
  Existing heuristic command matches are labelled Possible MCP connection,
  not presented as proven ownership. They still block installation.
- The app offers Check again without starting downloads, installers or closing
  processes. The normal Update action still needs a separate user click.
- Native install checks run before download, after download and immediately
  before installation. Installer file-lock safeguards remain enabled.

## Evidence and Limits

The user reported an upgrade blocked by two processes they recalled as Codex
processes. The original process snapshot/error is unavailable. A later read-only
snapshot found two MCP private-runtime Node processes parented by codex.exe;
that does not establish that the earlier processes were orphaned or idle.

Independent source probes showed idle MCP exits on stdin EOF and ordinary parent
exit with the tested Node 22 runtime. The SDK does not propagate stdin EOF into
server.close/active request cancellation, which is a separate follow-up. There
is no proven universal idle orphan leak, and this hotfix does not claim one.
Old or active MCP connections are not force-killed, and clients remain independent.

Read-only project inventory: 62 projects, 51 valid projects with complete dates,
11 unavailable projects; measured 1.06 seconds on the development machine.
This is one local timing sample, not a cross-machine performance guarantee.

Final automated test results and candidate hashes are recorded in the local
hotfix build receipt. New exact-installer Windows acceptance and a user upgrade
retry are still needed before calling the reported installation problem fixed.
No Unity scene, headset, account-usage or token-saving claim is made.
