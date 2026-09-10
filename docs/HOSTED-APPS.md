# Creator Hub: One Window, Installed Apps Inside

User clarification, 2026-09-10. This supersedes the launcher-first product
direction. Hosted apps are the core Hub experience, not an optional later extra.

## Required Experience

- Without Creator Hub, each Creator app remains fully usable standalone, with
  its own Creator menu button.
- During Hub setup, detect existing Creator apps and offer "Update and add to
  Hub". Show the detected apps and required compatibility updates before asking.
  Accepting updates them in place only where needed, then adopts them with their
  existing settings. Do not copy settings, delete files or create a second app.
- If no Creator apps are found, install only Creator Hub. Do not automatically
  install MCP, Project Setup, Converter, Plugins or Unity.
- "Not now" installs Hub alone and leaves detected apps unchanged in standalone
  mode. Keep the option to update and add them later; declining must not change
  their shortcuts, launch routing, settings or running processes.
- Compatible apps that need no update can be added without reinstalling them,
  following the same explicit adoption choice. Apps discovered after Hub setup
  get the same detection and consent flow, not silent absorption.
- Selecting MCP or Project Setup in Hub displays the actual working app UI in
  Hub's content area, not an information page followed by a separate window.
- Hub supplies the shared navigation and window chrome. A hosted app does not
  display its own duplicate Creator menu or top-level app window.
- Opening an adopted app's existing shortcut routes to that app inside the
  existing Hub window, starting Hub if necessary. It must not open two windows.
- An app that is already open moves to the hosted presentation only when idle,
  with its current project selection, form state and results preserved. Busy
  operations must finish before handoff; no forced shutdown or lost work.
- Removing Hub, or failing a supported handoff, leaves the original app usable
  standalone. Hub is optional; the app's functionality must not depend on it.

"Adopt" changes the presentation and opening route. It does not absorb or
uninstall the app's files. Unity Editors, Unity Hub, user projects and AI client
connections are not absorbed or restarted as part of this transition.

## Implementation Boundary

Keep one implementation of each app's interface and operations, with standalone
and hosted adapters. Hub remains a lightweight shell and app manager; installed
tools supply their own UI and backend. Do not bundle every tool into the base
Hub executable or maintain a separate imitation UI in Hub.

An app backend may continue in a separate process without a separate visible
window. Hosting must use an explicit, verified native contract. A URL parameter,
the mere presence of a Hub folder, or an unverified executable is not permission
to enter hosted mode, execute commands or hide standalone navigation.

Do not reparent foreign executable windows, fake embedding with screenshots, or
hide a working app before the hosted interface is ready. Existing released EXEs
without hosting support need a compatible app update; they cannot be advertised
as absorbed by discovery alone. Distinguish Installed, Needs compatibility update
and Ready in Hub.

## Next Implementation Order

1. Define the minimum trusted shell/UI/backend handoff using the existing Tauri
   and vanilla frontend code. Verify a native feasibility slice before finalizing
   the transport or expanding the release descriptor protocol.
2. Host Project Setup end-to-end first: real requirements, existing/new project
   views, native picker, operation progress and native close protection in the
   one Hub window. Share the existing implementation, not just its appearance.
3. Route Setup's standalone shortcut into Hub after verified adoption. Test
   running-app handoff, selection/form/result retention and standalone fallback.
4. Apply the same contract to MCP with its owning task. Keep client-owned stdio
   servers and Unity bridge connections independent of view switching.
5. Integrate existing download/update verification with hosted-module versions,
   app-busy protection and restoration of the selected view after an update.

Creator Converter follows when its owner supplies a compatible public release.
Creator Plugins remains a future community directory, not an arbitrary-code
module loader or a bypass around trusted installation.

## Acceptance

Fresh Hub plus an already installed app must produce one usable window and one
settings location. Test shortcut launches, concurrent opens, switching views
during long operations, busy handoff refusal, backend failure, offline startup,
upgrades, Hub removal and standalone fallback. Repeated navigation must not
repeat setup, reset project selection, recreate a project or reconnect MCP
clients unnecessarily. Preserve manual Unity edits and active client sessions.

Test Hub setup with zero apps, compatible apps, older apps requiring an update,
mixed versions, declined consent, and a failed/cancelled compatibility update.
Hub-only installation must always remain available. Failed updates must not
mark adoption complete, hide a standalone interface or redirect its shortcut.
Only approved apps are updated or adopted; retry must not duplicate installations.

The original App Manager Preview remains launcher-only. The newer
[Hosted Setup Preview](HOSTED-PREVIEW.md) now proves the first real app inside
Hub, using its own embedded UI and native backend. See
[protocol and acceptance](HOSTING-PROTOCOL-PREVIEW.md) for its exact limits.
Persistent adoption and shortcut/state-transfer behavior are still pending.
