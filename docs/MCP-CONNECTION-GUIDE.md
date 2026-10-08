# MCP Connection Guide

Candidate functionality on `feature/unified-creator-hub`, not a published or
accepted unified migration release.

## Behaviour

- First runs and upgrades without `connection_guide_version = 1` see the guide.
  Opening, checking, closing or cancelling it changes no connection.
- Use existing controls explicitly saves that guide preference. A failed save
  stays visible and recoverable. The guide can always be reopened.
- Guided setup reuses the existing project/client controls. A review lists the
  project, clients, tool group, script/test settings and CLI choice before setup.
  It never closes AI clients automatically.
- Runtime readiness, Unity bridge readiness, saved client configuration and a
  successful AI tool call are separate checks. Restart changed clients and ask
  the AI to call `get_bridge_status`; saved settings do not prove a connection.

## Claude Desktop

Desktop is separate from Claude Code and the Claude website. Local Desktop
configuration is offered on Windows/macOS, not Linux. Install and open it once
first. Detection uses its settings directory, not proof of an installed executable.

The adapter retains exact before-images and unrelated servers/preferences,
refuses malformed/oversized files and rejects different `creator-works` or legacy
`banter` entries rather than duplicating them. It rechecks the snapshot before
atomic publication. This is not an exclusive cross-process transaction with
Desktop. Concurrent external writers and multi-file migration require separate
acceptance. Manual apply/remove controls remain available. Removing Creator Works
does not remove the separate optional Unity CLI server.

Contracts: [MCP local servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
and [Claude Desktop local MCP](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).

## Optional Unity CLI

Detection never enables it. An unchecked agreement explicitly warns that support
is experimental in both Creator Hub and Unity; native setup requires the current
consent version too. Only Project Setup's reviewed CLI pin is detected by full
size/hash without execution or installation. Unity 6 and an existing
`com.unity.pipeline` dependency are required. No package is installed by this
option; ordinary Creator Works remains available without it.

Adds a separate `creator-unity-cli` stdio server to selected clients. Does not
replace Creator Works, run `unity mcp configure`, weaken sandbox/approval policy,
change models or start an Editor. Open Unity before restarting clients. Current
pin: `1.0.0-beta.9`; later binaries are not implicitly trusted. Official release
notes record an Editor-after-server tool-discovery correction in beta.10, so
startup order matters for this pin. Full CLI-to-Editor acceptance remains pending.

A saved CLI preference cannot block ordinary MCP configuration when a new project
lacks optional requirements. Only owned optional entries in selected clients are
removed; unselected clients stay unchanged. Known direct Unity CLI entries are
not duplicated. Wrapper-script entries may need manual review. Turning the option
off is applied on the reviewed setup action, not by checking status.

Contracts: [CLI reference](https://docs.unity.com/en-us/unity-cli/unity-cli-reference),
[Pipeline requirements](https://docs.unity.com/en-us/unity-cli/unity-pipeline/unity-pipeline-package),
[release notes](https://docs.unity.com/en-us/unity-cli/release-notes).

## Audit 1: Safety

- Tested exact backups, stale/malformed refusal and unrelated configuration
  preservation. No live client settings were used as fixtures.
- Tested native consent, missing requirements, duplicate detection with global
  arguments, JSONC comments and inline/quoted/dotted TOML round trips.
- Tested cancellation, workflow locking, busy refusal and hosted disconnection.
  Added commands use existing guarded hosted allowlists.
- Setup is multi-step, not rollback-atomic. Review/errors explicitly warn that
  earlier completed steps may remain after a later failure.

## Audit 2: Usability And Integration

- Tested first-run/upgrade, skip/retry, failed preference save, unsupported
  Desktop, unavailable CLI, and manual Desktop configure/disconnect controls.
- Tested the actual frontend hosted in Hub, no-write checks and disconnect
  recovery. Inspected 1080px/320px screenshots for centering and containment.
- Reviewed Hub PR 10: its full-width switcher rule and rendered-width regression
  are already present. No duplicate merge was performed.
- Plugins retirement documentation is in
  [Creator Community PR 16](https://github.com/SideQuestVR/Creator-Community/pull/16).

## Remaining Acceptance

Fixtures/units do not prove live Claude Desktop tool calls, Unity CLI Editor
control, stable client routing, conflict-aware legacy migration, full writable
macOS/Linux built-ins or signed updater/restart/reconnection. Keep the release
refusal until [Unified Creator Hub](UNIFIED-CREATOR-HUB.md) and the
[publication checklist](HUB-PUBLICATION-CHECKLIST.md) pass on exact builds.
