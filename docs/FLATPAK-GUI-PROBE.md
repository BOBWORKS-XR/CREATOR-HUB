# Pinned Flatpak GUI Probe

This is one disposable Linux x64/X11 launch of the **existing** current bundle
from package-replacement run [38624468436/1](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38624468436).
It is not native-Linux product, host integration, MCP, migration, update, release,
Wayland or real-device acceptance. Windows and Linux/Flatpak are the active targets;
Mac is suspended and is neither run nor modified here.

## Current Capture

**Actual launch obtained; original automation result remains failed.**
[Run 38643675124/1, job 116125161574](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38643675124/job/116125161574)
uses test source `563887dccfa0f3cf404ff6753c2c19d787061c85` and the unchanged
product/bundle pins below. Exactly **one** Hub launch occurred across these
three attempts; both earlier attempts stopped before launching the app.

- Confirmed: exact current bundle installation, six deployed byte/mode checks,
  live Hub ELF/deployed-inode and process-ancestry binding, all 15 archive members,
  resource-path/hash read in the normal sandbox, unchanged metadata/effective
  permissions and pinned Platform before/after. All 21 recorded commands exit 0.
- Confirmed: XRes host PID `3466`, start `149117`, XID `6291458`, exact Hub title;
  its ELF hash is `1ba7eabe...06e54d9`. The actual 940x580 client screenshot has
  829 sampled colors. Direct visual inspection shows the terms heading, policy
  version, unchecked checkbox and disabled **Accept and continue** button. The
  parent subsequently opened this exact retained owned PNG and explicitly
  confirmed that the heading, version and accept button are visibly clear. This
  is a separate **manual parent visual inspection**, not an automated OCR pass.
- Confirmed: normal EWMH close requested after ownership/protocol rechecks;
  owned Flatpak parent reaped with exit 0. `normalCloseReaped:true`,
  `leftRunningAtReport:false`. No terms input/acceptance/navigation/force-close occurred.
- Confirmed harness limitation: Tesseract exits 0 but its 972-byte text omits the
  visible heading/version/button. The parser correctly refuses insufficient OCR.
  `suitePassed:false` and the original error `Rendered terms not proven by OCR`
  remain immutable. This is not a blank/render failure. No fourth run, OCR flag
  tuning, grant change or product workaround was performed.
- Unknown: live Hub archive consumption and backend execution/ABI beyond the outer
  GUI. Stderr contains only one 187-byte AT-SPI `ServiceUnknown` warning. That is
  observed context, not evidence that it caused the OCR miss or a product failure.
  Every broad acceptance/readiness field remains false.

Exact OCR/source classification: the pinned product HTML says **Terms of use and
risk acknowledgement**, **Creator Suite Terms v2026-09-28**, and **Accept and
continue**. The parser requires the normalized heading, `creator suite terms`
prefix and button label. None occurs in the captured normalized OCR text; those
image regions became gibberish while substantial body text was recognized. This
is an OCR recognition limitation, not a source-label mismatch or evidence that
the product is blank. The string parser is correct as-is: accepting this text
would manufacture missing label evidence. No parser relaxation, timer, OCR flag
change or additional dispatch is justified by this capture.

Cleanup is retained evidence, not a new action: the original report already says
`normalCloseRequested:true`, `normalCloseReaped:true`, `launchExitStatus:0`, and
`leftRunningAtReport:false`; the parent can independently verify these unchanged
fields against the report hash below. No further close was attempted. The missing
host bridge is not supplied by this probe; no host/MCP/migration acceptance follows.

Capture retained at `artifacts/flatpak-gui-capture-38643675124/`:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `terms-window.png` | 86323 | `3a26a4f14b64cc5d25f3f84a915e4e51d607bf990fd844438b52a20819580d38` |
| `gui-report.json` | 42533 | `7c2a45c3f63d00e0a5cdcb14f7db970016301b0a060d519b77d216e67d80f8cb` |
| `terms-ocr.stdout` | 972 | `d18c49b12d119c0fb4b34f725ede7fc2f89752aecfb153ded763e52329b25954` |

The compact artifact `11931950290` is 101,990 bytes (API digest
`1037cf20d8c8094005d0519943de1c57ba67d4158eac37976f00c2fda346047f`).
Full evidence, original ZIP and source proof remain in artifact `11931711358`,
419,017,592 bytes (API digest
`7f1ca81fe574867698c472824e9b4a19ce5bb0919e2d24ab4e75c0297472007c`).
Local extracted screenshot/report/OCR bytes were hashed directly; artifact digests
above are primary API values, not locally rehashed artifact ZIP claims.

The new hash-bound OCR fixture preserves this exact false-negative text and tests
that it continues to refuse. Final local checks: **49 Node tests + 15 Python
fixtures pass**, zero skipped; Python AST and workflow YAML parse. This offline
fixture/documentation commit does not rerun the application or turn the failed job
green. A future automatic OCR correction needs separate offline proof against this
image before any separately authorized native test.

### Scoped File List

```text
.github/workflows/flatpak-gui-probe-014.yml
docs/FLATPAK-GUI-PROBE.md
scripts/flatpak-gui-probe-pins.json
scripts/flatpak-gui-probe.cjs
scripts/flatpak-gui-probe.py
scripts/flatpak-gui-probe.test.cjs
scripts/flatpak-gui-probe.test.py
scripts/flatpak-gui-probe-ocr-38643675124.json
```

Independent validation commits, in application order, based on
`e60db6f5b937ef3036cec8fcf44240ee93787495`:

```text
e292c4caa16ff766074e27f2f95cafdbde90ed98 initial probe
3b92a936a96ebc18168e1bc6fbfa182eba6ea388 capped logging
563887dccfa0f3cf404ff6753c2c19d787061c85 setup-node path; actual launch source
6c21f0cf525d569d742299cf3790add781216c65 retained evidence and OCR refusal fixture
```

The final manual-parent-inspection prose commit is returned in the chat handoff.
This task did not switch, stage, commit or push the shared feature checkout/index.
No other owner's source/evidence was edited. Its eight scoped files remain
untracked there until the parent integrates the independent validation commits.

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
The downloaded original report confirms install status **-25 (SIGXFSZ)** after
981 ms, with 56 stdout bytes and zero stderr. Report hash is
`3e7b9560816dfe31c87762fe39d00ae1a35c430aa0a43a2c80918593be45c250`.
Its retained input ZIP and bundle were rehashed locally and still match the pins.

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
