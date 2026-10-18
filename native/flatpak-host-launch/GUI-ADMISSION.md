# Production GUI Channel Prerequisite

Source/API work only. No installed Root GUI, host-operation, migration, update,
publisher or release acceptance is implied. The fixed echo CLI/API stays separate.

## Build And Admission

Build the Flatpak GUI first, then compile the native Core/library with
`CREATOR_FLATPAK_GUI_SHA256` set to that exact GUI ELF's SHA-256. This is a compile
input, never a renderer value or launch-time option. Missing pins refuse before
installation inspection. Do not compile the Core's own hash back into the GUI.

The production profile supports Linux x86_64 with working kernel
SO_PASSPIDFD/SCM_PIDFD and close_range CLOEXEC, upstream Linux 6.5+; there is no
PID-only fallback. Required same-user procfs inspection must also work.
The OS `/usr/bin/flatpak` must be a root-owned ordinary ELF behind protected
root-owned parents. The native CLI must report Flatpak 1.18.4 or newer. This is
an admission minimum, not a compatibility claim for every later Flatpak build.

Only `app/com.creatorworks.hub/x86_64/stable` and GNOME Platform x86_64/50 are
selected. Native HOME/XDG_DATA_HOME select the normal per-user installation;
the default system installation is `/var/lib/flatpak`. Alternate installations,
injected Flatpak environment overrides and caller-selected paths are unsupported.
User app installation takes precedence; a user app may use its user runtime or
the default system runtime. A system app uses the default system runtime.

The running GUI must be the exact installed `/app/bin/creator-hub` inode and
compiled hash. Admission performs the full hash once and retains that ELF FD plus
app/runtime directory FDs. Every packet reopens the process image and installed
image/roots and compares them to the held dev/inode/size/owner/mode/link-count/
ctime-nanoseconds/mtime stamps. Any drift refuses; pins are never renewed or
rehashes silently accepted. atime is intentionally excluded. There is no full
GUI hash on idle polls or packet chunks; this is a source-level I/O contract,
not a measured throughput claim. Every incoming packet reuses kernel PIDFD/UID/start/ancestry,
mounted deployment, runtime, image and effective-grant checks. The production
grant profile is IPC/network, Wayland/fallback-X11, DRI and exactly
`com.creatorworks.hub.Host=talk`. No filesystem, host-spawn, unrestricted bus or
environment override grants are accepted. Runtime/app commits are selected by
native inspection and pinned for the live session, not supplied over the wire.

## Core API

`GuiSession::launch_installed()` owns the actual unreaped Flatpak child. There is
no constructor from a descriptor, path, expected runtime hash or trust Boolean.

- `poll_request(Instant) -> Result<Option<GuiRequest>, GuiError>`
- `send_response(GuiRequest, &[u8], Instant) -> Result<(), GuiError>`
- `send_event(&[u8], Instant) -> Result<(), GuiError>`
- `revalidate() -> Result<(), GuiError>`
- `finish(Instant) -> Result<(), GuiError>`

`GuiRequest::id()` and `payload()` are read-only. Retain the original token with
each dispatched worker and return it with the result; tokens bind the session
as well as the request ID. Up to 32 requests may be in flight, and responses may
complete out of order. This permits cancellation/control calls while another
worker is active. Core must decode its own finite typed command enum before any
host operation. The transport itself has no host-operation dispatcher.

One I/O thread owns the session. Feed it bounded worker-result/event queues and
poll it with, for example, a 100 ms deadline. No public raw FD, shared reader or
socket cloning is exposed. A poll timeout before a first packet returns None;
partial-message timeouts permanently fail the channel. Each message exchange has
its own maximum 30-second deadline, not a 30-second session lifetime.

Payloads are opaque structured application envelopes. Requests are at most
64 KiB; responses/events at most 2 MiB. Versioned binary framing limits every
SEQPACKET datagram, including its header, to 16 KiB. Exact request IDs, session,
chunk count/order/total/payload lengths are checked before delivering a body.
No packet or operation is automatically retried. Event envelopes must be the
Core's finite event enum, not arbitrary renderer-selected event names.

## GUI API And Shutdown

Call `GuiPeer::from_inherited()` once, before Tauri/WebKit spawns children. It
borrows/shape-checks FD 3 before adopting it, sets CLOEXEC, enables kernel
credentials and pins the Core's fresh challenge for the session. This inherited
connection is not a separate publisher-signature or mutual-image assertion.

- `send_request(&[u8], Instant) -> Result<u64, GuiError>`
- `poll_message(Instant) -> Result<Option<GuiMessage>, GuiError>`
- `GuiMessage::Response { id, payload }`, `Event { payload }`, `Closed`

The GUI also uses one I/O owner and bounded queues; responses correlate with the
32 pending IDs while events have a separate ordered sequence. After Closed,
Root must perform its normal window/application shutdown so Core can reap its
owned child. Closing over pending work is refused. On disconnect, the Core must
keep existing backend operation guards until accepted work drains; the channel
cannot establish whether a lost response's operation completed. Consult
`GuiError::outcome_unknown()`. Cleanup only closes/reaps the exact owned Flatpak
child, never a Node/Unity/AI process or a process group.

## Verification Boundary

Portable framing/state tests and Linux cross-target checks do not prove actual
Root GUI startup, native service activation, one visible window, finite backend
operations or retained host settings. Those are the next installed-product
tests, not further echo-only acceptance. No dispatch belongs to this source phase.
