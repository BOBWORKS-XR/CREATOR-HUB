# Local User Test

This is a portable development preview, not an installer/adoption test.
It uses the real Setup interface and a deliberately read-only MCP interface.
Do not replace your working MCP installation with the candidate installers yet.

1. Finish any active Setup work and close the older Creator Hub normally.
   Leave your installed MCP, AI clients and Unity projects unchanged.
2. Run `dist/Creator-Hub-Lifecycle-Test/creator-hub.exe` from this checkout.
   Keep Setup beside it and the MCP file under `apps/mcp`; do not move one EXE
   out of this paired folder. Hub checks their exact approved hashes.
3. Select Project Setup, click **Open hosted Setup preview**, then confirm
   **Open in Hub** in the native prompt.
4. Create a new project named `Hub_User_Test_01` under `E:\UnityTest`, or choose
   another unused name. Never use an existing project folder for this test.
5. While creation runs, switch to MCP and back. Open its read-only preview and
   try Refresh/Browse. Setup progress and entered details should remain intact;
   there should be no separate Setup or MCP application window. Native pickers
   and consent dialogs are expected. MCP setup/update controls remain disabled.
6. Once Setup says Ready, open the new project. Note any compilation error or
   Visual Scripting initialization dialog. The receipt should show Android and
   Windows support; this does not prove an APK/player build or headset behavior.
7. Close the hosted MCP view and confirm the Setup result remains available.

If you test normal Hub close during active work, it should refuse. Do not end
its process in Task Manager. If it appears stalled, keep the app open and report
the displayed stage and elapsed time rather than retrying project creation.

Useful feedback: exact action, expected/actual behavior, screenshot, project
path, and `.creator-project-setup` logs from the disposable project. Never send
AI-client credentials or account files. Stop if an existing project is targeted.

Already tested by automation: real Setup creation/reopen, isolated repair,
native MCP read-only operation in both protocols, native picker/busy-close,
normal shutdown, unchanged MCP config metadata/hashes and repeated Hub launches.
The simultaneous real Setup+MCP session is still pending closure of the older
user-owned Setup session; this manual run would add useful coverage.

This preview does NOT prove installation, upgrading old BANTWORKS/MCP versions,
automatic adoption, writable MCP hosting, standalone shortcut handoff or Hub
uninstall recovery. See INSTALL-UPGRADE-MATRIX.md for those separate gates.
# Projects Preview Addendum

New local build: `dist/Creator-Hub-Projects-Test/creator-hub.exe`. Finish any
active Setup operation and close the older Hub normally before opening it.
Use Hub's Projects tab to inspect/search/filter known Creator SDK and Banter
projects. No project edits occur while browsing. New folder additions are saved
only in Hub's list, and removing a saved entry never deletes project content.

The Windows preview currently reuses Project Setup's already-cached, hash-pinned
Unity helper. If missing, it reports the limitation rather than downloading or
executing an arbitrary CLI. Opening requires the exact installed project Editor
version. Existing Unity locks are refused, never removed automatically.

Automated native discovery/filter/permission checks passed; opening a valid
project and native add/remove still need their dedicated acceptance tests. For a
manual launch test, use a saved disposable project, not one with unsaved work.
Expect one correct-version Unity Editor, no version-upgrade prompt, and no
project package or scene changes requested by Hub. Report any unexpected prompt.
