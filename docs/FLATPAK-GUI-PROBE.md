# Pinned Flatpak GUI Probe

This is one disposable Linux x64/X11 launch of the **existing** current bundle
from package-replacement run [38624468436/1](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38624468436).
It is not native-Linux product, host integration, MCP, migration, update, release,
Wayland or real-device acceptance. Windows and Linux/Flatpak are the active targets;
Mac is suspended and is neither run nor modified here.

## Immutable Input

- Producer source `9d015402bbbcb9b6c584cedd88815a4867d7739a`, tree
  `127a53c3b8854407e27c74a60d3303662e16df33`, successful job `116059992516`.
- Artifact `11923252154`, `flatpak-package-38624468436-1`, 358,586,204 bytes,
  SHA-256 `d0826ea15fa19d3d4745aa75f8ae5ef781c082434a008b57e4a97929bac63e46`.
- Exact original ZIP member `creator-flatpak-YBM5PV/creator-hub-1.flatpak`,
  60,176,800 bytes, SHA-256
  `09582f687b5bc0c84f370f122b949a7adf2112910bd64f23287c205ea66fb976`.
- App commit `32745d5e9f4d01e0c732272b3c02d5d9c11cb462677d5c52c2d0417192464d5c`;
  Platform commit `0bd5091046708e64bc882e8349877cfbae713f6a1e2d0487a5f10af820a2d792`.
- Product source is separately bound to assembly `38607998719/1`, commit
  `7eb00ad8a61db307c71bb95459ac85b7a957088d`, tree
  `c2a7f1e3e6e4af03b05634dba98654bb27325eae`.
  The current Hub ELF is 21,352,568 bytes, SHA-256
  `1ba7eabe233e9cce35b480b8651abb8b0496a519e55e13613b67720b406e54d9`.

The original ZIP was read locally and its full hash matched before implementation.
GitHub run/job/artifact metadata were independently checked. These are not runtime
results. Parser/source/fixture tests must pass before the validation branch push.

## Contract

Only new `scripts/flatpak-gui-probe*`, this document and
`.github/workflows/flatpak-gui-probe-014.yml` are owned by this task. The native
Linux probe, unified acceptance document and production files are untouched.

The consumer rechecks primary API run/job/tree/artifact identity, original ZIP,
original report, exact bundle, original assembly ZIP, descriptor and receipt.
It installs without dependencies into a fresh `FLATPAK_USER_DIR` under runner temp.
No app is rebuilt. Public GNOME Platform 50 provisioning is host-only; the installed
commit must equal the original report, otherwise the probe stops without launch.

Before/after deployment checks reuse the existing strict four-grant and effective
permission parser, six-file byte/mode checks, ELF and embedded descriptor checks.
All 15 archive members are independently read and checked by hash/size/mode/type
without extraction or execution. `readelf` retains interpreter, NEEDED and symbol
version diagnostics; these are not a backend ABI execution claim.

A normal app-sandbox shell canonicalizes `/app/bin/../lib/Creator Hub` and reads
the exact archive hash. Locked `tauri-utils` 2.9.3 `resource_dir_from` uses this
existing executable-relative directory. This establishes the source-derived path
and resource readability in the real sandbox, **not observed Hub consumption of
the archive**. Terms capture does not invoke built-in backend startup; the report
keeps `liveHubArchiveConsumptionObserved:false`.

The sole real launch is `flatpak run --user app/com.creatorworks.hub/x86_64/flatpak-test`.
There is no `--sandbox` extra restriction, command override on Hub launch, devel,
runtime injection, devtools, library copy or WebKit sandbox disable. Grants remain
exactly Wayland, fallback-X11, DRI and IPC; no network, host/home or broad D-Bus grant.
The child environment is a finite allowlist and receives only the private local
Xvfb/auth/session-bus endpoints, not CI auth or caller renderer overrides.

The exact title is only discovery. Authorization additionally requires XRes's
local socket-client host PID, live ancestry to the owned Flatpak launcher, process
start time, exact pinned ELF hash and deployed inode, and archive hash through the
process's actual `/proc/PID/root/app` namespace. Screenshot/close recheck identity.
The actual client-window PNG must be nonblank, and bounded host OCR must find the
terms heading, terms-version label and continue button. OCR is capture evidence,
not native consent. No input is sent and no terms acknowledgement is seeded.

The pinned product `main.rs` handles `CloseRequested` and `ExitRequested`, delegating
to `Manager::allow_close`. Normal EWMH close requires both the owned window and its
WM_DELETE_WINDOW protocol. There is no kill fallback. The parent waits up to 15s
and reports the actual Flatpak exit status. Missing ownership/protocol, nonzero
exit or a live child makes the result incomplete. The report is saved before
disposal of this job's private desktop services; teardown is never reported as
normal Hub closure. See [EWMH close](https://specifications.freedesktop.org/wm/latest/ar01s04.html)
and [Flatpak's command contract](https://docs.flatpak.org/en/latest/flatpak-command-reference.html).

## Verification And Result

Local commands (no native application):

```text
node --test scripts/flatpak-gui-probe.test.cjs scripts/flatpak-package.test.cjs scripts/flatpak-retention.test.cjs
python -B scripts/flatpak-gui-probe.test.py
```

Pre-dispatch verification: 49 Node tests and 11 Python fixtures pass; Python AST
and the single-job workflow YAML parse. Actual original-ZIP staging and all 15
current module members (164,641,396 unpacked bytes) pass offline hash/mode checks.
The actual pinned product source independently passes the close-route preflight.
No product executable was run locally.

Initial checkpoint: actual Flatpak GUI remains untested. The bounded job may expose
missing ABI, desktop or nested WebKit sandbox prerequisites; no workaround is
authorized. Retain the original failure, screenshot (desktop-only if no owned
window), stdout/stderr, source binding and bounded `gui-report.json`. All broad
acceptance fields remain false even if this narrow capture suite passes.
