# Disposable Flatpak Native Validation

Experimental sidecar for `allplatformmaintenance0.1.13`, separate applications.
`releaseReady=false` is unconditional, including a completely green probe run.
Main owns the native Linux signed updater and final product review; macOS is a
separate lane. Consolidation remains deferred to 0.1.14 or later. This sidecar
does not edit application source, the package generator, packaging assets,
existing workflows, release feeds or signing inputs.

## Exact Reviewed Inputs

| Identity | Value |
| --- | --- |
| Repository / source PR | `BOBWORKS-XR/CREATOR-HUB`, PR22 |
| Successful CI run / attempt | `38423134520` / `2` |
| Source head | `288d3d60a8108d6ff41729b63705af3598721f60` |
| CI artifact build / PR merge | `da87dfb1f815653f23737a98766b5eaa8a525dc4` |
| Source and merge tree | `52ebe386502913c583cb897f00e2d83c9703b404` |
| Linux artifact ID | `11827776708` |
| Artifact name | `hub-development-Linux-X64-da87dfb1f815653f23737a98766b5eaa8a525dc4` |
| Artifact ZIP bytes | `97015435` |
| Artifact ZIP SHA256 | `5de4080ab8be4b46ef053af21e6d9985adbf77533b89f4d91d2e4d27bbc2e39e` |
| Native DEB | `Creator Hub_0.1.13_amd64.deb` |
| Native DEB bytes | `6004284` |
| Native DEB SHA256 | `b95d71ab62ae75b38d2e653eee3d21eacba4869027d2c1fa01495065c429b3e0` |

The user supplied the reviewed tuple. Live API checks on 2026-10-13 confirmed
run success on attempt 2, all five successful attempt-2 jobs, repository,
artifact ID/digest/size, merge parents and equal source/merge trees. The existing
local DEB under `artifacts/native-288-Linux-38423134520` independently matched
the reviewed byte count and SHA256. ZIP metadata is not local byte verification;
the workflow must download and hash it again. No native installation, Flatpak
build or remote workflow dispatch was performed locally. The XRes probe below
captured these bytes but did not pass complete GUI acceptance; the earlier run
used a different candidate.
This dated table is not proof that an artifact remains available indefinitely.
See [the exact CI run](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38423134520).

## Before-Merge Execution

The current workflow uses explicit `workflow_dispatch` instead of repeating
expensive installation runs on every PR push. Its reviewed defaults above are
not a latest-success lookup. Explicit inputs select another separately reviewed
PR22 run/head/artifact/ZIP hash+size/DEB hash+size. Main owns commits and dispatch;
this sidecar does neither. Before-merge workflow availability must be checked,
not solved by an early product merge.

Checkout uses the harness PR head, not its merge ref. Before provisioning:

1. Fetch the exact candidate source commit from the public repository.
2. Check actual `HEAD^{commit}` against the workflow's requested harness ref.
3. Diff that source against harness HEAD with renames disabled. Accept only the
   finite reviewed test-only exclusions below, including coexisting platform
   probes and the Windows baseline acceptance edits. The runner-only XRes helper
   is one explicit filename, not a new directory exemption.
4. Refuse a dirty checkout, ref mismatch or any difference outside those exact
   paths. Product/resource/packaging/runtime changes and existing build CI changes
   still fail. Newer harness source is not silently treated as the binary's source.
5. Require the requested successful PR22 CI run, its successful Linux job in the
   same attempt, repository IDs, source head, exact artifact ID/name/digest/size,
   merge second-parent/source relationship and equal source/merge product tree.

An expired artifact or mismatched ref stops the run. Update the reviewed pins
explicitly; do not fall back to another release, run, artifact or renamed DEB.
The artifact label is deliberately **not** equated with the run's head SHA.

`PROBE_FILES` contains the four original Flatpak paths plus exactly
`scripts/flatpak-xres-window-pid.c`. `REVIEWED_TEST_ONLY_FILES` adds
exactly these twenty-one paths to the frozen `TREE_EXCLUSIONS`, with no directory
or filename-pattern exemptions:

- `scripts/native-linux-maintenance-smoke.cjs`
- `scripts/native-linux-maintenance-smoke.test.cjs`
- `scripts/native-linux-window.py`
- `.github/workflows/linux-maintenance-validation.yml`
- `scripts/native-mac-maintenance-smoke.cjs`
- `scripts/native-mac-maintenance-smoke.test.cjs`
- `scripts/native-mac-window.swift`
- `.github/workflows/mac-maintenance-validation.yml`
- `docs/MAC-MAINTENANCE-VALIDATION.md`
- `.github/workflows/windows-candidate.yml`
- `scripts/Test-InstalledCandidate.ps1`
- `scripts/self-update-baselines.test.cjs`
- `scripts/native-self-update-lab.ps1`
- `scripts/native-self-update-lab.test.cjs`
- `scripts/native-self-update-smoke.cjs`
- `scripts/maintenance-signed-update.test.cjs`
- `.github/workflows/maintenance-signed-update-lab.yml`
- `tests/fixtures/maintenance-signed-update/README.md`
- `tests/fixtures/maintenance-signed-update/creator-hub-windows-x86_64.json`
- `tests/fixtures/maintenance-signed-update/creator-hub-windows-x86_64.json.minisig`
- `tests/fixtures/maintenance-signed-update/latest.json`

The regression fixture accepts all twenty-six reviewed paths against source
`288d3d60a8108d6ff41729b63705af3598721f60`, then rejects product code/resources,
package inputs, runtime evidence, build CI, and unreviewed probe paths when each
is added to that same coexistence fixture. Dirty checkout and exact-ref refusal
are retained. These exclusions authorize test coexistence, not new product bytes.
The Windows fixture exclusions cover public test-signature fixtures only, not
any signing key or issuer change. Neighboring and nested fixture paths remain
rejected. New native candidate pins require main's completed exact artifact
tuple; a building/retried run does not replace the reviewed defaults.

## Runner Scope

Only `ubuntu-24.04` GitHub-hosted Linux x86_64 in the exact repository is accepted.
The CLI refuses Windows, local Linux/WSL, macOS, ARM, self-hosted runners and
arbitrary roots. Tool/package provisioning exists only in that disposable job.
No local PC/WSL installation commands are part of validation instructions.

All Flatpak operations use a fresh user installation under
`RUNNER_TEMP/creator-flatpak-validation/home`, a separate system-directory
placeholder, fresh XDG roots, a synthetic D-Bus session and an Xvfb X11 display.
The native DEB is installed on the disposable runner to take a coexisting native
beforeimage; it is not launched concurrently or accepted as a native GUI test.
Only package-owned regular files and explicitly generated synthetic settings,
AI-client, Unity-project and Flatpak-data sentinel files are hashed. No home
scan, credential file, production signing key or existing project is read.

The GitHub action uses its ordinary read-only Actions/Contents token for API
downloads; no secrets context, credential file, token dump or write permission
is used. ZIP bytes are hash/size checked before bounded structural parsing.
Traversal, duplicates, links, special modes/files, unexpected file extensions,
excess members/expanded bytes and multiple DEBs are refused. Only the DEB is
extracted. The existing generator independently checks its exact hash,
`creator-hub` / `0.1.13` / `amd64`, ELF identity, resources and modes, and emits
the immutable SHA-pinned Flatpak inputs.

## Concrete Trial

- Provision Flatpak/builder/OSTree/GPG and GUI capture tools using the runner's
  package manager. Add the official HTTPS Flathub `.flatpakrepo` in the isolated
  user installation, require `gpg-verify=true`, and perform ordinary verified
  GNOME50 Platform/SDK installs. Record actual installed commits, EOL/rebase
  metadata, runtime manifest and WebKitGTK/JavaScriptCore 4.1 library paths.
- Build the exact generator manifest, export its actual app commit, sign it and
  the local repository summary using a fresh one-day **test-only** GPG identity
  generated inside this runner. Import only that public key into the local test
  remote. No production issuer identity or private-key export is involved.
- Install that exported commit and verify original executable/resource bytes
  and Unix modes against the native inventory. Structurally parse installed
  permissions: exactly GUI sockets, IPC, DRI and network, with no additional
  filesystem, full bus, environment or host-spawn grants.
- Flatpak `1.14.6-1ubuntu0.1` in actual run `38417415256` serialized the existing
  Wayland/fallback manifest as `sockets=x11;wayland;fallback-x11;`. Upstream
  [option parsing](https://github.com/flatpak/flatpak/blob/1.14.6/common/flatpak-context.c#L999-L1016)
  adds the X11 bit for `fallback-x11`;
  [metadata serialization](https://github.com/flatpak/flatpak/blob/1.14.6/common/flatpak-context.c#L1782-L1805)
  saves that socket mask. The
  [runtime selection](https://github.com/flatpak/flatpak/blob/1.14.6/common/flatpak-run.c#L1657-L1667)
  lets fallback mode govern X11 availability; the
  [official permission contract](https://docs.flatpak.org/en/latest/sandbox-permissions.html)
  confirms this overrides ordinary X11 permission. The validator accepts only
  the original two-socket set or that exact three-socket serialization, retaining
  raw metadata as evidence. Standalone X11, X11/Wayland without fallback, missing
  Wayland, extra sockets, filesystem/bus/environment grants remain rejected. The
  manifest is unchanged. The old failed report is preserved; sandbox, GUI and
  local update phases from that run were not reached and still require a rerun.
- Capture actual `/.flatpak-info`, sandbox XDG paths, denied native-data/project
  paths, hidden host sentinel process, and `ldd` results inside GNOME50. Missing
  dependencies are blockers, not authorization to copy guessed libraries.
- Launch the actual packaged native WebKit window. Bind its X11 resource ID via
  local XRes socket credentials to the exact owned instance and executable using
  the checks below. Capture window pixels,
  dimensions/color variance, OCR, launch diagnostics and namespace context.
  Require native `0.1.13`, rendered Flatpak-managed update/refusal text, and the
  completed explicit Linux-unsupported management state, not forever checking.
- If terms appear, click only the unique visible checkbox label under the exact
  title/revision. Submit with one Tab and one Return only after the current-run
  WebKit keyboard-contract receipt below passes. This is a synthetic VM acknowledgement,
  **not real user terms consent**. No storage seeding, DOM injection, parent-key
  change, private authority override or disabled WebKit sandbox is used.
- Make a second deployment from the finished candidate tree, retaining its
  original native executable, resources, XML and version. Add only a test marker
  bound to candidate commit, source, DEB hash and generation. Select an explicitly
  labelled local `50-validation-fixture` runtime derived from the authenticated
  GNOME50 commit. Export/sign a different app commit and use actual scoped
  `flatpak update` to deploy it, then verify the marker, original inventory and
  another native GUI capture.
- Create a second signed commit of that local runtime with identical payload,
  update only that runtime ref, verify both generation hashes and unchanged
  official Platform/SDK and app commits, require empty actual OSTree filesystem
  diffs for original-to-fixture and fixture-to-next-generation, and repeat native
  GUI capture.
- In `finally`, compare all protected before/after hashes, sizes and modes and
  host-sentinel survival, including on earlier failures. Stop only the uniquely
  identified experimental instance and the harness-owned sentinel/GPG agent.

This is a **same-version OSTree generation update**. Artifact and current source
version stay `0.1.13`. It is not a new-version binary, changed-footer update,
native14 fixture, GNOME ABI upgrade, unification, publisher-authenticated update
service or full product acceptance. Nothing in the test repository is published
or uploaded. GUI diagnostic failures are retained while the independent
integrity-bound local update trial may continue; the final job still fails for
failed checks.

## Evidence And Remaining Gates

### Actual Run 38419016632

[The failed rerun](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38419016632)
used harness `1e85a70b8de38541afe09bff483025ca9401ad1d` with source
`b4a0cd874b2ad1fd53f0c24db8c0d7aec0bb2e8e`, run `38407664529`, artifact
`11820885281`, not the new defaults above. Its original evidence is retained locally under
`artifacts/flatpak-run-38419016632`; earlier failure evidence is unchanged.
Binding, native inventory/beforeimage, GPG-verified GNOME50 provisioning,
build/export, installed permissions/resources, sandbox path/process isolation,
resolved libraries, actual same-version app update and preservation passed.
This is partial experiment evidence, not GUI or product acceptance.

- **Confirmed broken, harness parser:** non-interactive `flatpak ps` emitted
  literal TSV with empty application cells for runtime-only sandboxes. Whitespace
  splitting collapsed those cells and failed before candidate launch. The parser
  now preserves all four fields and still rejects malformed columns. See the
  [Flatpak table printer](https://github.com/flatpak/flatpak/blob/1.14.6/app/flatpak-table-printer.c#L642-L661)
  and [nullable application contract](https://github.com/flatpak/flatpak/blob/1.14.6/common/flatpak-instance.c#L122-L139).
- **Confirmed broken, runtime-history proof:** the second scoped runtime update
  succeeded and exact installed/runtime/app/official-ref checks passed, but the
  old installed commit was absent when diffing. Flatpak
  [prunes during update](https://github.com/flatpak/flatpak/blob/1.14.6/common/flatpak-transaction.c#L4830-L4834).
  The historical diff now uses those same verified hashes in the harness-owned
  export repository, which is not pruned. Installed deployment checks remain
  mandatory; an empty filesystem diff still must pass. This change awaits a
  disposable rerun and is not new runtime-payload acceptance.
- **Correct as-is, GTK; unknown identity capture contract:** a visible fixture
  window lacked `_NET_WM_PID`. GTK
  [deliberately omits that hint in a sandbox](https://github.com/GNOME/gtk/blob/gtk-3-24/gdk/x11/gdkwindow-x11.c#L885-L896)
  because namespace PIDs would mislead the window manager. That run failed before
  pixel/consent capture; the new XRes contract below is ready for a disposable
  rerun, not retroactive acceptance. No guessed PID mapping, extra bus/home
  permission or disabled WebKit sandbox is introduced. Retained launch
  warnings concern AT-SPI and DRI3; they do not prove a WebKit security denial.

Neither GUI capture passed; visible updater/management/consent and direct trusted
updater-command refusal remain unaccepted. Fixture cleanup confirmed launcher
exit and instance disappearance. Overall status remains failed and
`releaseReady=false`. Tests exercise these failures without installing anything.
The new defaults bind source `288`, which includes the reviewed native-consent
product changes. Any newer product changes still require another separately
reviewed matching artifact; testing-path exclusions cannot admit them.

### Actual Run 38428685642

[Run 38428685642](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38428685642)
used harness `d4654f3da961089c3c3eee703ece82bfe596f66e` and the source-288 tuple
above. Original artifact `11829913045` is retained locally under
`artifacts/flatpak-run-38428685642`; earlier reports are unchanged.

- **Correct as-is / actual partial proof:** the C helper compiled, and its real
  XRes 1.2 missing/forged-hint/destroyed-window self-test passed. Fixture GUI
  identity passed 81 rechecks; runtime-generation GUI identity passed 79. Both
  bound the owned outer process, immediate reaper child, PID/mount namespaces,
  running metadata and exact native executable SHA256
  `de680b633fafed5ab6f3f56c320d1c1c2bfa7d129b63fcf096ce709bae8e92c0`.
  Both retained images are 1100x890, with 797 measured colors and RGB standard
  deviations above 29. Read-only image inspection found the visible unchecked
  terms dialog, not accepted updater/management content. Both cleanup receipts
  confirmed launcher exit and instance disappearance with no cleanup errors.
- **Confirmed broken, immediate preflight assumption:** candidate capture never
  launched because `ps` still listed six Hub-labelled tool records after the
  successful sandbox probe. A later snapshot was empty. Flatpak's
  [normal instance GC](https://github.com/flatpak/flatpak/blob/1.14.6/common/flatpak-instance.c#L1016-L1036)
  deliberately retains unused records until their lock files are older than
  three seconds. Preflight now polls for at most ten seconds and still requires
  no Hub records before launch. It does not ignore, adopt or kill any existing
  record; persistence, malformed output or command failure still fails.
- **Confirmed broken, exact OCR glyph mismatch:** retained OCR read the native
  checkbox label as `| have read and agree to these terms, ...`, not `I have ...`.
  There were zero click commands. Both later GUI phases therefore timed out at
  the terms modal, not a demonstrated updater or WebKit sandbox failure. The
  harness now recognizes only that captured `I`/`|` first-glyph alternative,
  requiring the exact terms title/revision and unique checkbox label.
  XRes identity is still rechecked before each visible synthetic consent click;
  no storage, native-consent or parent-policy override is used.

Binding, authenticated runtime, build/export, install/resource/permission,
sandbox and preservation phases passed. Actual same-version app update passed;
the second runtime update retained exact installed-ref checks and an empty
filesystem diff in the export repository. Its overall phase still failed at GUI
acceptance. Native updater refusal, completed unsupported management and real
terms persistence remain unaccepted. The failed report stays failed with
`releaseReady=false`; the two new harness fixes require a disposable rerun.

### Actual Run 38432096221

[Run 38432096221](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38432096221)
used harness `8da7c3db7b3277052a3b3783e15291f267c85cac` and the same source-288
package. Original evidence remains in `artifacts/flatpak-run-38432096221`.
Candidate preflight passed after 33 snapshots. All three GUI cases had six
successful XRes identity rechecks and passed owned-instance cleanup.

**Confirmed broken, submit OCR:** the single checkbox-label click succeeded;
the retained PNG shows a checked checkbox and enabled Continue button. The
post-click TSV contains a high-confidence blank token for the button region,
not an `Accept and continue` label. The harness refused ambiguous targeting and
sent no submit click. No native terms-write error was rendered; this run never
exercised native acceptance, persistence or post-terms updater refusal. The
failed report remains failed. No further OCR/threshold tuning is authorized.

### Runner-Only Keyboard Contract

The existing test file contains an opt-in diagnostic guarded by `hostedRoot`
before imports, outputs or server/browser launch. The disposable workflow alone
sets `FLATPAK_WEBKIT_CONTRACT=1`, after source/artifact binding. It uses `npm ci
--ignore-scripts` and the installed Playwright **1.63.0** CLI to install only
WebKit plus its system dependencies. No local browser/SDK installation or test
launch is needed. The [official browser installation contract](https://playwright.dev/docs/browsers#install-system-dependencies)
supports browser-specific CI provisioning; browser binaries are version-bound.

The test serves the exact source page/module using the existing static server
and a fresh browser context per case. Only the native bridge is a synthetic
fixture, as in the existing terms UI tests; storage and focus are never seeded
or forced. Each case sends exactly one Tab and one Return, without input retries:

- Enabled: one actual pointer click inside the unique label must check and focus
  the checkbox, enabling the only dialog button. Tab must focus Continue; Return
  must cause exactly one native-bridge acceptance with the exact policy/arguments,
  close the modal and allow app startup.
- Disabled: the modal's initially focused copy panel must tab to the unchecked
  checkbox. Return must leave Continue disabled, make zero native accept calls,
  and keep the dialog and application lock intact.
- Native-write failure: the same checked/focused/enabled sequence makes exactly
  one native call which fails. The exact visible storage error, open modal,
  inert application and absence of app startup are mandatory. No retry follows.

`terms-keyboard-contract.json` records cases, focus/input observations, engine
version, run/harness/source binding, and SHA256 of `index.html`/`usage-terms.js`.
Any case or browser/server cleanup failure prevents a passed receipt; original
errors are retained. Native input requires the complete same-run receipt with
unchanged source hashes. Before and after each native key, XRes/process/start-time/
executable/deployment identity is rechecked and `xdotool getwindowfocus` must be
the exact owned window. Focus is never activated or forced; input is focused
XTEST, not `--window` XSendEvent. A foreign window, command timeout/nonzero exit,
or attempted extra key fails without a Return retry.

The HTML standard makes [click focus UA-dependent](https://html.spec.whatwg.org/multipage/interaction.html#click-focusable).
Playwright WebKit is **not the pinned actual GNOME50 WebKitGTK runtime**. Passing
this diagnostic is only permission to attempt the bounded native sequence,
not proof of native focus, saving, consent or product acceptance. The real GUI
must still pass terms disappearance, same-profile relaunch persistence, pixels,
version, unsupported management, native updater-refusal, ownership and protected
data checks. `init` refuses an existing root and creates an empty isolated home;
the five beforeimage fixtures seed only preservation/project/AI sentinels, not
valid terms records. Therefore the first candidate must visibly present terms;
absence fails before any input. `syntheticTermsFixture` is true only for a case
that actually observed terms, sent the bounded submission and removed the dialog.
Later phases must retain candidate acknowledgement without another terms prompt.
`releaseReady=false` remains unconditional. Actual keyboard-contract
and native GNOME results are pending the next main-owned disposable run.

### XRes Window Ownership Contract

XRes 1.2's [protocol specification](https://sources.debian.org/src/xorgproto/2025.1-1/resproto.txt/)
allows selecting a client by its window resource ID and requesting its local
PID. Missing identification is permitted by the protocol, so absence is a
blocker, not a zero/default PID. GNOME's
[PID-namespace fix](https://lists.gnome.org/archives/commits-list/2022-March/msg10404.html)
uses `XResQueryClientIds` / `XResGetClientPid` for this purpose. The X server's
[client identification](https://github.com/XQuartz/xorg-server/blob/master/os/client.c#L89-L106)
and [Linux socket credentials](https://github.com/XQuartz/xorg-server/blob/master/os/access.c#L1171-L1180)
trace that PID to `SO_PEERCRED`, not a writable window property.

The runner compiles the single-purpose C helper with `libxres-dev`, `libx11-dev`
and ordinary C tooling, only after source/artifact binding. No local SDK/tool
installation is authorized. The helper requires a local Unix-socket display,
XRes version 1.2 or later within major version 1, a live window before/after the
query, and exactly one PID result. It queries one resource, never all clients,
and does not read `_NET_WM_PID` as authority. Its runner-only self-test creates
its own window, checks the actual process PID with missing and forged PID hints,
then requires refusal after destroying that window. Compilation or self-test
failure fails the workflow and is retained by normal report finalization.

Before pixels or synthetic consent input, the harness requires:

- No preexisting Hub instance, one new exact instance, and its outer PID equal
  to the owned non-background launcher's PID with unchanged host `/proc` start
  time. [Flatpak's launch implementation](https://github.com/flatpak/flatpak/blob/1.14.6/common/flatpak-run.c#L4377-L4394)
  preserves this PID when executing bubblewrap.
- The XRes host client PID is exactly `flatpak ps`'s `child-pid`, or its immediate
  child. This bounded alternative handles bubblewrap's
  [namespace reaper](https://github.com/containers/bubblewrap/blob/v0.9.0/bubblewrap.c#L3080-L3110).
  It is not guessed namespace-PID arithmetic, an arbitrary descendant walk or
  kill authority. The child must belong to the exact outer process; both sandbox
  and X client must share PID and mount namespace identities.
- The client's `/proc/PID/root/.flatpak-info`, parsed with strict ConfigParser,
  matches the exact instance ID, app name, architecture, branch, installed app
  path and pinned app/runtime commits. No process environment or command-line
  dump is collected.
- A held `/proc/PID/exe` descriptor has the same device/inode/size as both the
  installed inventory executable and that process's `/app/bin/creator-hub`.
  Its bounded SHA256 must match the native inventory. Host process start times
  and namespace identities must remain stable across this proof.
- The entire binding is rechecked before and after each window import, before
  each consent click and before acceptance; the installed app/runtime refs are
  rechecked at completion. Changed identity, vanished processes/windows,
  inaccessible host `/proc`, missing XRes or timeout refuses acceptance. There
  is no title-only, PID-hint, namespace-guess, extra-permission or sandbox bypass
  fallback. Only the already owned experimental sandbox is a cleanup target.

Bounded `report.guiIdentity` records the initial/last proof, recheck count,
last XRes receipt and any failure; `commands.json` retains helper status/stderr.
`report.xresTool` binds the source/helper hashes and real self-test receipt.
Local tests use synthetic process/filesystem fixtures, including PID reuse,
foreign processes, changed namespace/hash/deployment, missing/invalid XRes,
timeout, drift after image capture and drift before consent. Real C/XRes,
Flatpak `/proc` access and owned nonblank pixels now have the partial actual
evidence above, but complete native GUI acceptance remains failed. Local tests
do not replace the required rerun. `releaseReady=false` and direct trusted
updater IPC remain separate.

`evidence/report.json` exists before provisioning. `finally` and workflow
`always()` finalization retain original phase errors, label unreached phases
blocked and force `releaseReady=false`. Download/tool failures, GUI crashes,
timeouts, permission/path failures and incomplete runs are not success. An
abrupt VM termination can prevent any upload; `always()` is not a promise to
survive loss of the runner. Evidence upload is an explicit file allowlist,
excluding packages, repositories, profiles, archives and all signing keys.
Command output has bounded retained tails; parsers receive complete bounded
output. Launch logs retain at most their final 64 KiB.

| Classification | Finding / scope |
| --- | --- |
| Correct as-is | This source has `supported:false` Linux MCP/Setup management. Explicit unsupported UI is the expected result, not fake Linux management acceptance. |
| Unknown / needs capture | Visible Flatpak refusal is native GUI evidence, not a direct trusted-IPC test of `download_hub_update` / `install_hub_update` refusal or disabled-button state. |
| Unknown / needs capture | No Linux host broker, reviewed Unity/helper/AI-client/companion artifacts or full process-ownership/consent harness were supplied. Capture path/PID namespace barriers, not full-host support. |
| Unknown / needs capture | Native and sandbox XDG data diverge. Opaque sentinel preservation proves neither migration nor rollback nor actual preference/content semantics. |
| Unknown / needs capture | Original resource inventory plus rendered Hub pixels do not accept every real hosted view, project operation or embedded asset. |

Before implementing any second native UI driver, ask main for its reusable
Linux harness **artifact contract**: exact run/source/artifact/hash, entry point,
WebKit/driver versions, Flatpak launch/instance handle, normal trusted-shell IPC
access, synthetic-consent procedure and report schema. Required evidence must
bind the installed app/runtime commits and executable hash and cover raw-command
denial, legitimate updater state, direct download/install refusal, disabled
Update Hub, rendered resources, completed unsupported management and retained
preferences. This sidecar supplies only bounded pixel/namespace capture, not a
duplicate of main's signed-updater/product UI suite. Main must review complete
product acceptance separately; no passed sidecar receipt authorizes publication.

During implementation, concurrent `scripts/native-linux-maintenance-smoke.cjs`
and `scripts/native-linux-window.py` appeared and were read, not edited or run.
The window driver currently takes `ACTION PID EXPECTED_EXE_SHA256`, verifies
`/proc/PID/exe` and uses the host AT-SPI application PID. That is not yet a
reviewed Flatpak instance/PID-namespace or trusted updater-command contract.
No additional accessibility-bus grant or weakened ownership check was added
to force reuse. Obtain main's reviewed artifact contract before replacing this
bounded capture or adding product-command acceptance.

## Local Tests And Primary Sources

Local non-installing checks:

```sh
node --check scripts/flatpak-native-smoke.cjs
node --test scripts/flatpak-native-smoke.test.cjs scripts/flatpak-package.test.cjs
```

On Windows the generator's real Linux/WSL integration test remains skipped;
do not set its optional WSL installation/validation variables for this task.
No Flatpak/native installation acceptance is claimed from these tests.

Primary references checked for the runtime/toolchain design:

- [Flatpak command reference](https://docs.flatpak.org/en/latest/flatpak-command-reference.html): per-user installs, export/signing, local repository updates, `build-commit-from`, scoped update flags and namespace/process inspection.
- [Flatpak builder command reference](https://docs.flatpak.org/en/latest/flatpak-builder-command-reference.html): actual manifest builds and export options.
- [Flatpak sandbox permissions](https://docs.flatpak.org/en/latest/sandbox-permissions.html): filtered bus, XDG isolation, process/filesystem boundaries and minimal GUI/network grants.
- [Flathub installation](https://docs.flathub.org/docs/for-users/installation): official HTTPS repository setup with its public GPG trust material.
- [Available runtimes](https://docs.flatpak.org/en/latest/available-runtimes.html) and [GNOME50 developer notes](https://release.gnome.org/50/developers/): runtime selection; installed commit/content/EOL checks remain mandatory.
- [GitHub workflow runs API](https://docs.github.com/en/rest/actions/workflow-runs) and [artifact API](https://docs.github.com/en/rest/actions/artifacts): run/source/attempt metadata, immutable artifact IDs, archive digests and temporary download redirects.
- [OSTree diff reference](https://manpages.debian.org/bookworm/ostree/ostree-diff.1.en.html): compare real revisions for added, modified or deleted filesystem entries before claiming unchanged runtime payload.

Earlier runtime source/remote metadata evidence remains in
`packaging/flatpak/runtime-50-evidence.json`; it is not substituted for this
experiment's authenticated installation and native execution capture.
