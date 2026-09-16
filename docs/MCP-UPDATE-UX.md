# MCP Update Controls

Status: Hub 0.1.4 is public stable and latest (2026-09-16), after packaged
acceptance and the exact public 0.1.3-to-0.1.4 self-update/restart test. See
[release verification and audit](RELEASE-0.1.4.md).

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

## Packaged Acceptance

[Windows candidate run 35085595417](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35085595417)
passed all four native lanes against product source
`3e24d87a513305f4b93339754c8ef67a4c53d9cd` on the test branch
`test/mcp-disconnect-update-0.1.4`. Nothing was published at that candidate
checkpoint; the same accepted bytes were subsequently released.

- Clean Hub, MCP 2.7.1 and Setup 0.3.0 installation with real hosted interfaces.
- Hub alpha.5 plus legacy MCP 2.6.0 and Setup 0.2.2 upgrades.
- Hub alpha.3 plus MCP-only upgrade; Setup remains uninstalled.
- Public Hub 0.1.3 installer upgrade to this exact 0.1.4 candidate.
- Both MCP upgrade lanes: primary button opens native disconnect consent;
  Cancel leaves both private runtime fixtures running. Approval stops both and
  continues to native install consent. Cancelling installation preserves files
  and settings; retry installs exact public MCP 2.7.1. Unrelated Node survives.
- Preserved project selection, unmanaged files, hosted state, and normal scoped
  close behavior. Runner-only browser test policy restored in every lane.

CI also passed 159 UI tests, 107 Rust tests (9 opt-in tests skipped), 27 script
checks and strict Rust lint. Downloaded candidate bytes were independently
hashed and its executable version checked locally without installing it.

| Artifact | Value |
| --- | --- |
| Version | 0.1.4 |
| Installer bytes | 5997095 |
| Installer SHA-256 | `9eab81b86a291fa70ca3a9d3cb0f6c71a76bd4b527aa88aca387abb210375ea8` |
| Installed EXE SHA-256 | `68aa863c53798d03e4ac9eab75b6f6e22ca13f7517e976e9a04e2cf176e17cfa` |

Local receipts and the exact installer are under
`artifacts/mcp-update-ux-0.1.4/`; they are not committed. No user installation,
AI session or Unity project was changed. This does not claim all historical
MCP versions or other platforms. Publication was explicitly approved and the
release-feed budget gate passed. Public self-update run 35088525701 then passed
native cancellation, exact 0.1.3-to-0.1.4 update, automatic restart and state
preservation before latest promotion. Preserve these released bytes; do not
substitute a rebuild's hashes. MCP remains 2.7.1 and Setup remains 0.3.0.
