# Creator Hub: Hosted Apps Development Preview

This unsigned Windows x64 preview hosts Project Setup and, when supplied with
the approved MCP preview, a Creator Works MCP view. Read-only remains the
default build mode. A separately built writable candidate requires explicit
native consent and a matching server, private runtime and Unity bridge payload.
It is not an installer, public release, or completed adoption system.

1. Close standalone Creator Project Setup when it is idle. Do not close Unity
   or Unity Hub just for this preview.
2. Keep the directory layout intact and run `creator-hub.exe`. Setup sits beside
   Hub; the optional MCP backend sits in `apps/mcp` with its own resource directory.
3. Select Project Setup, then **Open hosted Setup preview**.
4. Confirm **Open in Hub** in Setup's native consent dialog.
5. In a read-only build, select MCP, then **Open hosted MCP preview** and confirm **Open read-only
   preview**. Its current saved project list is displayed without migrations or
   configuration writes. Refresh and Browse folder work; bridge/client setup is
   deliberately disabled in this integration preview.

In a writable candidate, close any standalone MCP GUI normally first. Leave
Unity and AI-owned MCP server processes running. The native confirmation names
the actual Hub executable and its SHA-256, and offers **Enable MCP controls**.
The fingerprint identifies that file, not a signed publisher. Approval is for
this session only. Normal startup can migrate launcher settings, just as the
standalone app does. Setup, client configuration, feedback preferences and bridge
updates use the existing MCP handlers and their existing user controls.

The backend locks the exact packaged runtime/server/bridge files for its session.
Missing or mismatched payloads cannot enable writes. Hub holds an operation guard
across the entire UI workflow, including command gaps and disconnect draining.
Local bounded outcome records contain command names and statuses, not arguments
or secrets. An unfinished record prompts for review at the next writable start;
it is not a rollback or proof of cancellation. No command is replayed automatically.

Setup's existing interface and operations run inside the Hub window. Switching
Hub views keeps the same form, result and backend process. Folder pickers remain
native dialogs. Close Setup asks before discarding the hosted form. A running
operation prevents normal Hub closure; hiding a view does not cancel work.

Both views retain their state when switching apps. Closing one view does not
close the other. MCP's existing installed GUI and AI-owned stdio servers are not
taken over or stopped by this read-only preview.

The host verifies each exact app EXE hash compiled into this build. Its UI is
embedded in that EXE, not read from an unverified web page or loose scripts.
Installing another Setup version requires a matching Hub preview at this stage.
The future signed release catalog will replace this development pairing.

No app is installed, adopted, upgraded or removed by opening this preview.
Existing shortcuts remain unchanged. Read-only mode leaves settings, Unity
projects and MCP clients unchanged. Writable mode permits normal MCP operations
after session consent; use disposable fixtures for native acceptance testing.
Project creation or repairs occur only when their corresponding Setup action is
requested. Repair retains its existing backup/approval and stale-plan checks.

Not implemented here: saved adoption consent, shortcut routing, transfer of an
already-open standalone form, macOS/Linux hosting, or a public Hub
installer. Standalone-to-hosted handoff remains a separate acceptance milestone.
Browser and protocol tests do not establish full native writable acceptance or
installed-upgrade safety. Neither mode is a production adoption capability.
Never interpret a disconnection or timeout as proof an operation was cancelled;
inspect its result/project logs before retrying a mutating action.
