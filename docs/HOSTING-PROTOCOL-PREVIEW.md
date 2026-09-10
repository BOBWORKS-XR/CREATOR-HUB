# Hosted App Protocol: Development Preview

## Optional Read-Only Lifecycle Preview

Explicit paired builds can add `-McpLifecyclePreview` to
`scripts/Build-HostedPreview.ps1`, together with the exact MCP EXE and SHA-256.
This compiles a test-only opt-in into Hub. MCP initialization then requests
`{ hostingRevision: 2, requestedMode: "read-only" }` and requires that exact
revision/mode in the reply. It never requests or enables writable operation.
Without the switch, the original empty initializer and reply shape remain.

The native receiver accepts only `creator-mcp-lifecycle` events for that session,
with at most 512 actual wire bytes including newline, strict fields, valid
state/count types and a monotonic uint53 sequence starting at zero. These are
advisory events. Hub retains its own native operation guard until the command
finishes; a child idle event cannot authorize writes, close, install or update.

Actual read-only reports passed: `hosted-native-1789058480012` (revision 2,
ordered events, real picker busy/idle, final draining and normal exit) and
`hosted-native-1789058550242` (original initializer, no events). Both retain
config metadata/hashes, deny mutations and show no standalone MCP window.
Exact hashes are in DEVELOPMENT-HANDOFF.md. These tests explicitly skip Setup
while the user's older Setup backend is open. Mutable sessions, durable result
recovery and adoption remain unimplemented release gates.

## Per-App Extension

The Hub now keeps a distinct native session and persistent sandboxed iframe per
app. Native commands are `start_hosted_app`, `hosted_app_call`,
`stop_hosted_app`, and `abort_hosted_app`. Only startup accepts an app ID; all
subsequent authority comes from the native session's stored app identity.
Events are `hosted-app-event` and `hosted-app-disconnected`, scoped by session.
Closing one session does not close another. A single native operation lease
still serializes filesystem actions and protects Hub shutdown.

MCP initialization uses appId `creator-works-mcp`; its own executable/resources
remain separate. It supports only `get_hosted_snapshot`, `pick_project_folder`
and fixed-link `open_official_url`; no events. Initialization does not load or
migrate configuration. Snapshot reads current config or legacy fallback without
writes. Installed MCP GUI and client-owned stdio processes remain untouched.

Both app frontends pass 32 combined Hub browser tests. Earlier native MCP evidence is
`artifacts/hosted-native-1789054948122/report.json`, including own resources,
read-only state, native cross-app command rejection, picker/close guard and
unchanged current/legacy config hashes/size/mtime. Two-backend native acceptance
on the new pair is pending; the user has an older hosted Setup session open.
The new pair correctly refuses a duplicate Setup backend. Exact build hashes
and the remaining adoption gates are in DEVELOPMENT-HANDOFF.md.

## Original Setup Contract and Evidence

Development contract, 2026-09-10. Windows x64 feasibility is demonstrated; this
is not a stable public adoption/update protocol. Hosted UI is the same Setup
HTML/CSS/JS and command implementation used standalone.

## Trust and Ownership

- Hub verifies the selected Setup EXE against a SHA-256 pin compiled into Hub.
  It holds the executable open against writes/deletion throughout the session.
- The EXE supplies embedded UI assets. Tauri's `Assets::get` decodes them;
  `Assets::iter` alone returns compressed data in release builds.
- Setup runs with its own Tauri AppHandle, resources and working directory.
  Its context creates no WebView/window in hosted mode; native dialogs still work.
- Setup requires anonymous inherited stdin/stdout pipes, checks its actual
  parent path and asks native consent before initialization. The parent filename
  check is a routing check, NOT publisher authentication. This local preview does
  not claim code signing or persisted trusted-host enrollment.
- No TCP listener, arbitrary shell command, Unity project path or user credential
  is accepted as startup authority. Only the exact `--creator-hub-host` switch is
  recognized. Metadata queries stay side-effect-free and do not advertise a
  production hosting capability yet.
- Setup stdio handles are non-inheritable. Its Unity/browser/Hub child launches
  use explicit null or file stdio, not the private hosting connection.

## Native Pipe Protocol

Hub starts the verified EXE with private pipes and a fresh random 32-byte session
identity represented as 64 hexadecimal characters. JSON frames end in newline.

Request fields: `protocol: 1`, `session`, increasing integer `id`, `command`,
`args` object. Unknown envelope fields, bad sessions, reused IDs, incomplete
frames and requests above 64 KiB fail closed. Initialization uses ID 0,
`command: initialize`, `args: {}`. Consent precedes the successful reply.

Result fields: `session`, matching `id`, `ok`, and either `result` or `error`.
Initialization result contains `appId: creator-project-setup`, compiled `version`,
`protocol: 1`, and `files` mapping relative asset names to base64 bytes.
Hub bounds response frames to 2 MiB and the reply queue to four frames.
Diagnostics are drained separately, not parsed as protocol or retained without
bounds. Progress is rate-limited at the native Hub receiver.

Events: `session`, `type: event`, `name`, `payload`. Setup currently emits only
`setup-progress` and `existing-progress`. Hub forwards only these scoped names.

Commands: `get_recipe`, `probe_environment`, `pick_parent_folder`,
`create_project`, `open_project`, `launch_hub`, `restart_hub`, `register_project`,
`inspect_project`, `run_existing_project`, `open_official_url`. Dispatch calls the
existing standalone functions, retaining native lifecycle guards, approval,
path/recipe/URL validation, backups and inspection fingerprints.

One request runs at a time. The Hub operation lease covers the entire actual
response wait, not just enqueueing. No timeout or view switch replays a command.
EOF does not kill a Unity mutation: Setup finishes the active command before
stopping. Lost response means unknown outcome, not cancellation. Crash/recovery
and durable result journals need additional acceptance before automatic adoption.

## Frontend Boundary

The installed interface runs in a persistent `sandbox="allow-scripts"` iframe:
opaque origin, no parent DOM, popups, top navigation, forms or downloads. Its
CSP disallows network connections and permits only the supplied data assets.
The parent alone transfers a MessagePort after frame load. Setup's `runtime.js`
uses that port when hosted; otherwise it delegates to standalone Tauri APIs.
No duplicated business UI or fake `window.__TAURI__` replacement is maintained.

Hub validates command names, argument shape/size, monotonic IDs and concurrent
calls before native dispatch. Renderer-supplied app IDs cannot choose authority:
the native session is bound to the verified Setup process. Old sessions/events
are ignored. Unexpected frame navigation disables the channel.

Hub custom commands also require an independent per-process shell key injected
only into the top-level page, removed from globals and retained in its adapter.
The iframe never receives this key. An explicit Tauri AppManifest/capability
list limits custom commands and grants only the event APIs needed by the shell.
This native restriction remains necessary even if iframe Tauri globals exist.

## Acceptance Evidence

Native report: `artifacts/hosted-native-1789053161217/report.json` (local artifact).
Exact build pair in that report:

- Hub: `31dd6deae8708df8c928446e0d8eaf83e6c4b5b30d0d83ba827fdeecc23c90cd`
- Setup: `13434c168d64cd0ba3327e55598ecf4c2cebc90337c94ac625c8dacbb14e3bf8`

Passed with the real Windows EXEs: native consent/initialization, real installed
requirements, no standalone Setup window, form retention across Hub views,
native folder dialog, busy WM_CLOSE refusal, clean idle shutdown and no normal
JavaScript errors. Parent raw custom invokes without the shell key are explicitly
rejected. Child parent-DOM/key access is denied; raw child IPC fetch is blocked by
CSP. Its fallback produced no response in the bounded test, which is NOT itself
proof of a returned native denial. Wider raw-frame/adversarial tests remain a gate.

Browser tests use real Setup source assets with mocked native results: 10 hosted
cases cover layouts 940/720/560/390, retained state, progress while hidden,
reviewed repair, denied commands, stale sessions, disconnect and declined close.
Existing standalone browser tests also pass. Mocked creation/repair is not proof
of a real Unity build through the hosted path.

That separate native long-operation test subsequently passed in
`artifacts/hosted-native-1789053314825/report.json`, using the same binary hashes.
It created only `E:/UnityTest/CreatorHostedSmoke-1789053322524` through the hosted
UI, compiled/reopened Unity 6000.3.21f1 with Creator SDK 4.0.14, URP 17.3.0 and
Input 1.20.0, and validated Android plus Windows support. The persisted validation
reported 31,818 Visual Scripting nodes, including 172 Creator nodes, initialized
SDK settings and no validation error. Progress continued with the view hidden;
WM_CLOSE was refused during real Unity creation, then idle shutdown succeeded.
Unity Hub registry registration passed but a running Hub's visible list may
still need its existing explicit refresh/restart flow. No existing user project
was edited. Hosted repairs and backend-crash recovery remain separate tests.

## Next Ownership

Hub/Setup task owns this transport, Hub native authority, app manager, shared
navigation, Setup backend and eventual adoption transaction/shortcut routing.
MCP task owns only its own UI/runtime/backend adapter. Its first independent
slice should wrap existing `core.invoke`, `dialog.open`, `shell.open` and
`event.listen` usage without changing standalone behavior. Then adapt a bounded
read-only native hosted slice using its own AppHandle; do not call migrating
configuration loaders during handshake or touch client-owned MCP stdio servers.

Before production: consent-driven discovery/update/adoption, stable signed
descriptor capabilities, single-instance/shortcut routing, live standalone
state transfer, serialized quiesce/shutdown, backend crash recovery, updater
interaction, further native failure/repair acceptance, and macOS/Linux-specific isolation.
No foreign-window reparenting or permanent bundling of every tool into Hub.

## Primary References

- [Tauri capabilities](https://v2.tauri.app/security/capabilities/)
- [Tauri Context and assets](https://docs.rs/tauri/latest/tauri/struct.Context.html)
- [Windows redirected child-process pipes](https://learn.microsoft.com/en-us/windows/win32/procthread/creating-a-child-process-with-redirected-input-and-output)

API references informed the boundary. The protocol and application code were
implemented here; no third-party Unity/MCP implementation was copied.
