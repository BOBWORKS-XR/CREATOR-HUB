# MCP Update Controls

Status: source change tested locally, not packaged or released (2026-09-16).

The user did not recognise the text-only disconnect link as a button. Hub 0.1.3
disabled Update app when private MCP runtimes were running, requiring this
separate action. This report does not establish a process-cleanup failure.

- Apps and MCP detail now offer Disconnect and update when all blockers are
  positively identified private MCP runtimes in a verified installation.
- The existing native disconnect confirmation remains mandatory. Cancel does
  not proceed to installation. The separate Disconnect MCP only action is now
  a bordered, icon-labelled button and still never starts an installation.
- After disconnect, a fresh inventory must confirm the same eligible release
  and no blockers before the existing installation confirmation. Reconnection,
  changed/unverified installations, and failed scans stop the flow. No repeated
  termination loop or expanded process ownership rules were added.
- Controls remain locked throughout disconnect and recheck. Row updates retain
  their separate close/reopen choices; hosted-view close consent is unchanged.

Validation: 159 Playwright UI tests, 27 Node script checks, and both targeted
Rust mcp_runtime tests passed. The latter uses isolated temporary Node copies
and checks cancel, multiple owned runtimes, unrelated process/file preservation
and reconnection. Desktop and 320px screenshots inspected. The installed apps,
real AI clients and Unity projects were not modified or terminated.

The disposable native suite now exercises this primary-button flow, including
disconnect cancellation and subsequent installation cancellation. This updated
packaged test has NOT been run yet. Follow the publication checklist with a new
version and exact candidate bytes before announcing or publishing this change;
the earlier 0.1.3 native acceptance is not acceptance for this changed UI.
