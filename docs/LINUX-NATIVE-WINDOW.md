# Disposable Linux Owned GUI Helper

`scripts/native-unix-window.py` performs an actual AT-SPI permission-button action
or sends a normal EWMH close request. It is not a hosted-acceptance reporter, a
parent impersonator, or a substitute for product/operation acceptance.

There are two explicit modes: the existing pathname-backed mode (such as Hub),
and a sealed-child mode requiring an independently pinned owned-launcher receipt.
Neither mode admits a backend, creates a product parent/private pipe, or bypasses
product consent. Real sealed-backend GUI/hosting acceptance is still unproven.

Linux `src-tauri/src/hosted.rs::spawn_linux_builtin` passes the verified snapshot
and approved SHA256 to `native/mcp-router/src/gui_exec_linux.rs::prepare`/`spawn`.
That code seals a 64-bit ELF, sets mode `0500`, and directly executes its descriptor
using `execveat(AT_EMPTY_PATH)`, with explicit environment and private pipes. The
child's `/proc/PID/exe` is not its original resource pathname. The new mode opens
that actual kernel executable and binds its dev/inode/bytes/seals to the caller's
receipt; it never reconstructs a pathname or treats the memfd name as authority.
Memfd names are debugging labels and need not be unique. See
[memfd_create](https://man7.org/linux/man-pages/man2/memfd_create.2.html) and
[execveat](https://man7.org/linux/man-pages/man2/execveat.2.html).

## CLI Contract

```sh
python3 scripts/native-unix-window.py ACTION PID START EXE SHA256 XID TITLE ROLE [BUTTON]
```

This pathname contract is unchanged and still refuses memfd/deleted images.
The sealed-child command is separate:

```sh
python3 scripts/native-unix-window.py --sealed-receipt FILE \
  PARENT_PID PARENT_START PARENT_SHA CHILD_SHA COMMIT RUN \
  ACTION XID TITLE ROLE [BUTTON]
```

`FILE` must be an absolute, unredirected file beneath `RUNNER_TEMP`, owned by the
helper's UID, regular, mode `0600`, single-link and at most 8192 bytes. It is read
from one stable descriptor. Duplicate JSON keys and all unexpected fields refuse.
The caller must independently supply its owned parent PID/start, approved running
launcher and backend SHA256, reviewed source commit and exact build run. Do not
derive these pins from the untrusted receipt or from whichever process is found.
The helper compares the pins, not GitHub API/package signatures; those proofs
remain prerequisites in the caller's source-bound native harness.

Version 1 receipt template (placeholders are not valid CLI pins):

```json
{
  "schemaVersion": 1,
  "kind": "creator-hub-owned-sealed-child",
  "source": {"commit": "<40 lowercase hex>", "runId": 9001},
  "parent": {
    "pid": 200,
    "startTime": "9999",
    "executable": "/exact/running/creator-hub",
    "sha256": "<independently reviewed launcher SHA256>"
  },
  "child": {
    "pid": 123,
    "startTime": "9876",
    "image": {
      "device": "1",
      "inode": "222",
      "size": 100,
      "sha256": "<independently reviewed backend SHA256>",
      "requiredSeals": 15
    }
  }
}
```

Start times are kernel clock-tick field 22 values, not wall-clock timestamps.
Device/inode are canonical decimal strings to preserve uint64 precision; size
and run ID are bounded integers. The child PID/start and image identity must come
from the caller's exact owned launch, not title/process-name discovery. No child
source path or memfd-name field is accepted. The parent remains pathname-backed;
a sealed parent requires a separate future contract, not a fabricated pathname.

Actions are exactly `snapshot`, `click`, `close`. In pathname mode, PID/start and the exact
absolute executable path/SHA256 must come from the caller's own launched child
and verified package, not a process-name/title search. XID is decimal or `0x` hex;
TITLE is the exact native X and accessibility title. ROLE is exactly `FRAME`,
`DIALOG` or `ALERT`; the caller must capture the real native role, not guess it.
`click` additionally requires one exact allowlisted title/button pair:

| Native Dialog Title | Buttons |
| --- | --- |
| Open MCP in Creator Hub? | Not now; Enable MCP controls; Open read-only preview |
| Open Setup in Creator Hub? | Not now; Open in Hub |
| Enable managed MCP routing | Not now; Enable managed routing |

These pairs are from the current native `hosted.rs` and `builtin.rs` dialogs.
There is no generic button, keyboard, coordinate, focus, settings, or migration
command. Approvals are disposable synthetic tests, not real-user consent.

Before argument parsing, GI import, library loading, `/proc`, or app inspection,
the CLI requires native Linux x86_64/aarch64, `GITHUB_ACTIONS=true`,
`RUNNER_ENVIRONMENT=github-hosted`, matching `RUNNER_OS`/`RUNNER_ARCH`, and explicit
`CREATOR_UNIX_WINDOW_TEST=1`. Flatpak is refused. The environment check is a test
execution restriction, not a security claim that environment strings authenticate
a runner. The caller must bind the actual GitHub job and use isolated profiles.

The runner needs Python/PyGObject, the AT-SPI 2 typelib/session bus/accessibility
bridge, `libX11.so.6`, `libXres.so.1`, a local Unix-socket X server with XRes 1.2,
and a normal owned WM session for `close`. No provisioning is performed by this
helper. Wayland-only, remote X, portal-owned dialogs, missing PID evidence,
ambiguous objects and unsupported action APIs refuse; there is no fallback.
No local installation, product GUI launch or native workflow was performed in
this task. The optional WSL kernel test below does not operate any GUI.

## Ownership And Effects

Pathname requests check `/proc/PID/stat` PID/start field 22, reject zombie/dead
processes, match the exact `/proc/PID/exe` path and hash its running image.
Path/start are checked again after hashing. Hashing is bounded to 256 MiB.
This is a live identity snapshot, not publisher authentication or a kernel lock.
Native parent/private-pipe/payload admission stays with the product/caller.

Sealed requests additionally verify the pinned running parent, live child
PID/start and direct PPID (field 4), then hold an open `/proc/child/exe` descriptor
throughout the request. Its actual dev/inode/size/SHA256 must match the receipt
and independent backend hash. It must be an anonymous regular 64-bit ELF,
single kernel image with link count zero, mode `0500` and size at most 256 MiB.
All `F_SEAL_WRITE | F_SEAL_GROW | F_SEAL_SHRINK | F_SEAL_SEAL` bits (`0x0f`) are
required; the full observed seal set must remain stable. See
[F_GET_SEALS](https://man7.org/linux/man-pages/man2/F_GET_SEALS.2const.html) and
[proc PID/start/PPID fields](https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html).

Each verification hashes the held FD and freshly reopens the child's current
`/proc/PID/exe`: a still-valid old descriptor cannot hide a subsequent `exec`.
Parent, child and current/held kernel-image identity are checked before GUI
inspection, immediately before input, and after input while the child remains
live. Terminal child absence/zombie still requires the pinned parent and held
image to verify; it is never a normal-exit receipt. Denied `/proc` access, seal
API absence, unsealed/nonmatching images, parent reuse, reparenting and descriptor
drift refuse. This is bounded live evidence, not an atomic process lock; resources,
dynamic libraries and in-process memory are outside the executable-byte binding.

The XID is bound to its actual local XRes socket-client PID; `_NET_WM_PID` is not
trusted. The window must be live, mapped, managed, and have the exact title.
The matching AT-SPI application PID, unique direct window child, exact role/title
and enabled/showing/sensitive states are required. Only that window's subtree is
traversed, with 512 nodes, 128 children, depth 32 and 192 KiB output limits.
Only other application PID metadata is inspected to select the owned root;
unowned application names/subtrees are neither read nor dumped. Snapshots contain
owned role/name/state data, not text-interface contents, accounts or environment.

For clicks, the one exact PUSH_BUTTON must expose one nonlocalized `click`
action. The real `get_action_name(0)` API is used, never Accessible's label-only
`get_name(0)`. Process, XRes/client/title, window and the uniquely selected live
control are rechecked immediately before the one `do_action(0)`. No retries,
forced focus, page JS, storage seeding, consent override or global settings occur.

Close requires a FRAME plus consistent `_NET_SUPPORTING_WM_CHECK`, advertised
`_NET_CLOSE_WINDOW` and the target's `WM_DELETE_WINDOW`. After the last XRes
identity recheck, one `_NET_CLOSE_WINDOW` message is sent to the normal WM.
Missing delete support refuses instead of triggering a kill fallback. The helper
never signals/kills a process or uses process-name matching.

A successful helper return means the request was invoked/sent, **not** that a
settings write, permission lifecycle or normal exit succeeded. The caller must
reap its exact owned child with exit0, verify owned descendants absent, preserve
before-images/unrelated Node, and check real operation/GUI state. A process that
disappears after a terminal action is labelled `absent-unverified-exit`; an owned
same-start zombie is `not-live-unverified-exit`. Neither is a successful exit
receipt. Post-action drift fails; errors after possible input
are marked `actionMayHaveRun=true`, so the caller must not automatically resend.
All responses retain `normalExitVerified=false` and `releaseReady=false`.
The caller must impose an overall helper deadline; AT-SPI calls also have a
three-second API timeout. Timeout/ambiguous completion is a failure, not a retry.

## Tests And Evidence

```sh
python scripts/native-unix-window.test.py
```

Cross-platform fixtures use standard-library, in-memory process/accessibility/X
adapters only.
The CLI has no injectable adapter, alternate `/proc`, action override or test
library-selection flag. It always constructs real GI/XRes/process implementations
after its runner guard. Those pure fixtures do not load GI/X11, inspect a live process,
start a GUI, or establish native acceptance. The two additional Linux-only cases
exercise private receipt-file rules and, with explicit opt-in, kernel identity:

```sh
CREATOR_UNIX_WINDOW_KERNEL_TEST=1 python3 scripts/native-unix-window.test.py
```

The opt-in test executes existing `/usr/bin/cat` bytes in its own sealed memfd,
uses an exact stdin/stdout readiness handshake, checks actual running
`/proc/child/exe` FD/dev/inode/hash/seals and direct PPID, then closes stdin and
waits for normal EOF exit0. It uses a Python test parent and synthetic source/run
pins, not Hub or a product launcher. It executes via `/proc/self/fd/N`, not the
product's Rust `execveat` implementation. It never sets fake GitHub runner flags,
loads GI/X11 or drives user GUI. This proves kernel mechanics only.

Current focused results: Windows 37 tests (35 passed, 2 Linux-only skips); existing
WSL `AndroidXR-Build`/Python 3.12.3 with kernel opt-in, 37 passed, no skips. No
dependencies were installed. WSL emitted a systemd user-session startup warning;
the kernel suite nevertheless exited zero. These results are not packaged-backend GUI proof.
The caller still needs an actual producer/owned-launch receipt and disposable
packaged Hub/backend run, including private-pipe admission, real dialogs,
decline/retry/operation evidence, preservation and exact normal exits.

The Python ctypes XRes/X11 ABI and actual GTK/AT-SPI/native-dialog roles still
need the first disposable native run.
Existing maintenance C/XRes and Linux preference helpers were read-only references;
neither their checkout nor any workflow, builder, app or hosting probe was edited.

Primary contracts: [AT-SPI action-name API](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/method.Action.get_action_name.html),
[GTK3 native button actions](https://github.com/GNOME/gtk/blob/gtk-3-24/gtk/a11y/gtkbuttonaccessible.c),
[XRes 1.2 protocol](https://sources.debian.org/src/xorgproto/2025.1-1/resproto.txt/),
and [normal EWMH close messages](https://specifications.freedesktop.org/wm/1.5/ar01s04.html).
