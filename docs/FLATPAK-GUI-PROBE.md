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

Pre-dispatch verification: 49 Node tests and initially 11 Python fixtures pass; Python AST
and the single-job workflow YAML parse. Actual original-ZIP staging and all 15
current module members (164,641,396 unpacked bytes) pass offline hash/mode checks.
The actual pinned product source independently passes the close-route preflight.
No product executable was run locally.

Run [38642550553/1](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38642550553),
test source `e292c4caa16ff766074e27f2f95cafdbde90ed98`, failed at installation;
`launchCount:0`. All tests, primary bindings, original-ZIP staging and public
prerequisite provisioning passed. The failed run is not GUI or ABI evidence.
Its original artifact is `11930707276`, 418,915,929 bytes, API SHA-256
`54bf8eea2ffb933fec28d2721273b43f29a3b54352c36c2c159824e5c8eb031a`.

The first harness incorrectly inherited a log-oriented file-size limit into
OSTree installation. The corrected harness drains stdout/stderr into capped
host-side logs instead, retaining full-stream byte counts/hashes and bounded
tails; it does not restrict the child's filesystem writes or kill timed-out
processes. Two regressions check truncation and a 131,072-byte owned synthetic
installer write under a 32-byte log cap. There are now 13 passing Python fixtures.
This changes only test logging, not package bytes, runtime or app grants. A small
capture artifact precedes full evidence upload for bounded failure diagnosis.

Actual Flatpak GUI remains untested at this checkpoint. The bounded job may expose
missing ABI, desktop or nested WebKit sandbox prerequisites; no workaround is
authorized. Retain the original failure, screenshot (desktop-only if no owned
window), stdout/stderr, source binding and bounded `gui-report.json`. All broad
acceptance fields remain false even if this narrow capture suite passes.

### Second Prelaunch Failure

[38643108880/1](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38643108880),
test source `3b92a936a96ebc18168e1bc6fbfa182eba6ea388`, is **confirmed harness
failure**, not product failure or demonstrated ABI incompatibility. Installation
now returns 0 in 2,723 ms, with 56 stdout bytes and no stderr. Exact ref/deployment,
Platform commit, metadata and effective-permission reads all return 0. Then the
host verifier cannot start: `ENOENT: /usr/bin/node`. `launchCount` remains zero.
The retained PNG is a blank desktop diagnostic, **not Hub render evidence**.

Source/context contract: `actions/setup-node@v6` is configured for Node 24.17.0;
its actual run log confirms `node: v24.17.0`, but it does not install a system
`/usr/bin/node`. The [setup-node v6 implementation](https://github.com/actions/setup-node/blob/v6/src/distributions/base-distribution.ts)
uses the version/architecture tool cache and adds its `bin` to PATH;
[Node's process.execPath contract](https://nodejs.org/api/process.html#processexecpath)
returns the absolute running executable. The correction passes that path to the **host
verifier only**, requires its ordinary exact setup-node tool-cache path and checks
`--version` before installation. That environment variable is not in the Flatpak
child allowlist. No sleeps, app launch arguments, package, runtime, permissions,
WebKit behavior or product source changes. A regression refuses missing, system
and wrong-version paths; there are now 14 passing Python fixtures plus 49 Node tests.

Compact capture artifact `11930663137` is 5,463 bytes (API SHA-256
`5f0acb9351b9b5c745558ce9d5868cb710db9481a20aa15fc6cac3f9503091a8`),
downloaded to `artifacts/flatpak-gui-capture-38643108880/`. Full preserved evidence
artifact `11931198007` is 418,919,912 bytes (API SHA-256
`7d98ec6595e5024d1a7d22fa4352d93dfc411b62c7c2e03f358208ab52757e22`).
These API digests are not claims that the download CLI retained original artifact
ZIP bytes for local digest verification; the package-input ZIP is independently pinned.
