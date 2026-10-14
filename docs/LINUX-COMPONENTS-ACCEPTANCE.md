# Native Linux Components Experiment

This is a bounded component GUI experiment, not migration, retirement, signed
update, Unity project creation, AI connection, Flatpak host integration or release
acceptance. Those gates remain false even if every component action passes.
Linux retirement/integration work is parent-owned. No Mac lane is included.

## Immutable Product

- Product source `5bb05a21d73c0fc3b2839cbcbd4322832b24aead`, tree
  `f91c61a8e29da84e0dbdbfa642d201cd4c6a3279`, successful assembly
  `38630742955`, attempt 1, Linux job `116081506373`.
- Original artifact `11927495507`, `signed-unix-hub-linux-38630742955-1`,
  386824719 bytes, SHA-256
  `42c5e1a95605158ab084c4cad1db1a6fb5b49f6fe225db9cea868148cccda725`.
- Actual DEB `Creator Hub_0.1.14_amd64.deb`, 62780196 bytes, SHA-256
  `f0297e74c6ce918b54c248b222af7ac64c3c96c270d281a17a017fb90a7714ec`.
- Actual installed `/usr/bin/creator-hub`, SHA-256
  `efca8d6ca5949e787f10c124e26b91202587b34803f65c7cc5c3e9ffb93fdbf9`;
  resources at `/usr/lib/Creator Hub/modules.tar.gz`, SHA-256
  `c2cffb6f886225d8c841e78497e92c6ede96896e0c5a28c89346254e5fc4a77a`.
- Private payload source `a3118106086516751b78a58b5dbd684cff4c63a7`, unchanged
  MCP 2.7.7 and Setup 0.3.7, writable mode, original signed assembly receipts.
  No application rebuild, byte change or version relabel is permitted here.

The original artifact/run/source/tree, original receipts, all archive resource
hashes and modes, native package control metadata, actual dpkg install and kernel
image are checked independently. Test source/run is recorded separately in
`components-report.json`; the product source does not follow current HEAD.
Later parent production convergence changes are not tested by this old DEB.

## Native Action Boundary

Reuse the exact Root probe accepted in run `38639742819` at test source
`058516dfc9e7d12c38c9be039ae52a318e2c512e`: Root PID/start/UID/kernel image,
XRes window, one exact native direct-child WebKit process and canonical AT-SPI
bus-owner/object references. Its source SHA-256 is pinned in this experiment.
The generic native helper is unchanged. No arbitrary UI selector is accepted.

The new local component walk permits WebKit semantic parents only when their
canonical references occur in the same fully verified Root frame subtree.
Foreign windows, additional renderer PIDs, parent escapes, changed kernel images,
UID changes, PID reuse and duplicate wire references still refuse. A fixed WebKit
button needs the expected role, context, one `press`, two full walks and identical
canonical identity immediately before its single effect. No uncertain action is
retried. The native GTK consent path retains the existing stricter single-PID
helper and exact title/button allowlist.

Backend authority comes from the Root's actual direct children, matching signed
manifest hash/size, complete anonymous executable seals and UID/start/PPID, then
the helper's held/current kernel-FD rechecks. A generated test receipt alone
cannot grant ownership. No saved source pathname substitutes for the memfd image.

Planned actual sequence:

1. Native Root terms checkbox and acceptance, actual persisted acknowledgement.
2. If required, normal `Continue for now` on the convergence review. No prepare,
   migration or retirement action; fixtures and absent migration record checked.
3. Select Setup, native `Not now`, observe decline and reaped backend, normal
   `Retry opening`, native approval. Require actual rendered Linux requirements
   and exact approved recipe, then `Check requirements again` and real result.
4. Select MCP, native `Not now`, observe decline/reap, normal retry and native
   `Enable MCP controls`. Managed routing, if requested by the real product, is
   approved only through its exact native Root dialog; no client file is changed
   by the test. Require real module initialization/connection-guide surface.
5. Native `Use existing controls` saves the single connection-guide preference.
   Require all other fixture configuration fields unchanged, empty channels,
   no active project, auto-start false, custom server/editor-root bytes unchanged,
   absent client/legacy configuration and migration journal. No project, client,
   server or Unity operation is selected. Module legal terms are not seeded; the
   product may propagate the Root's real native acceptance through its own bridge.
6. Root-window-only nonblank PNG, normal owned WM close, parent-reaped Root exit
   zero and bounded stdout/stderr EOF. Require all observed backend PID/start
   identities absent and saved acknowledgement/preference retained after exit.

The product wait thread does not expose backend exit status. Backend absence is
reported as absence, **not an invented backend exit zero**. The Root is actually
reaped by this probe. Unexpected module legal controls or admission failures
stop this lane with the exact owned tree/error for parent production review.

## Execution And Evidence

Owned files: `scripts/native-linux-components-probe.py`, its focused test, this
document and `.github/workflows/native-linux-components-014.yml`. The dedicated
validation branch is `validation/linux-components-014`. All installation and GUI
actions run only on the opted-in disposable Ubuntu 22.04 runner, inside private
HOME/XDG/tmp and a private dbus/Xvfb/Openbox session. No user PC app/config reads,
credentials, real projects, injected replies/DOM/storage or process-kill fallback.

Preflight commands:

```text
python3 -B scripts/native-linux-root-probe.test.py
python3 -B scripts/native-linux-components-probe.test.py
```

The workflow stages and installs using the existing immutable DEB verifier, then
runs `native-linux-components-probe.py probe`. It preserves original input ZIP,
source binding, receipts, all bounded worker stdout/stderr, owned snapshots,
refusals and PNG even on failure. Original failed runs are never overwritten.

Initial pre-dispatch classification: implementation prepared; native component result pending.
Only an actual report with every required action/result/retention gate can change
this component classification. Packaging and Root terms proof alone cannot.

Local pre-dispatch verification: new focused suite 18 passed / 1 native-mode
fixture skipped on Windows; unchanged Root suite 75 passed / 1 skipped. Workflow
YAML and embedded GitHub-script JavaScript syntax parsed. These are harness
contracts, not native component acceptance.

## First Actual Component Run

Run `38644484142`, source `22838a5630f2e6456c223713d4e6c105a68b2948`,
job `116127860015`: original artifact/source/resource/DEB checks and actual install
passed. Linux preflight passed 76 Root and 19 component tests. Actual native Root
terms/save, convergence `Continue for now` and one Setup navigation press passed.
The Setup consent worker reached its unchanged 20-second readiness deadline;
no consent input occurred. Cleanup normally reaped Root exit 0 with output EOF.
No Setup/MCP operation or preference acceptance is claimed.

Original result artifact `11931861904`, 386621915 bytes, SHA-256
`19c4ff9e4e987d210d78d4a0d4707842f66cb2d569f1ee4dafeeb9f20424c666`,
is retained under `artifacts/native-linux-components-38644484142`. Root stderr
was empty. The first harness did not retain a post-failure Root tree or child
inventory, so **product admission versus dialog discovery remains unknown**.

The minimal diagnostic follow-up adds only failure-time owned tree/PNG and exact
Root direct-child/kernel-image/window metadata; no deadline, payload, environment,
permission or input change. Nameless WebKit paragraph/text nodes observed in the
actual tree use the bounded, read-only native Text interface (2048 characters per
node, 16384 UTF-8 bytes aggregate), never EditableText. Primary API contracts:
[Text.get_text](https://docs.gtk.org/atspi2/method.Text.get_text.html) and
[Text.get_character_count](https://docs.gtk.org/atspi2/method.Text.get_character_count.html).
Failure diagnostics never authorize another input or override the original error.

## Second Run: Exact Refusal And Contract Gaps

Run `38645211366`, test source `b8b3037d0c8f41805640472feb42ce264b13c5dd`,
job `116130248902`, same unchanged product: all input/install gates and 76 Root /
21 component Linux tests passed. Failure remained at `open-setup`, consent
readiness deadline, no consent input. Root terms acknowledgement was saved and
normal cleanup reaped Root exit 0. This is **not** a component suite pass.

The exact owned PNG was viewed. It shows `Could not open Project Setup` and
`Opening Setup in Hub was declined. Standalone Setup is unchanged.` The native
Root frame (PID 3332/start 44045, XRes window 4194307) was bound; the deadline
inventory contained only its two system WebKit children, no matching Setup
backend. That inventory cannot exclude a short-lived backend before sampling.
The screenshot SHA-256 is
`d6d8ee9913e40f643f7f854b6551408139a39a34b50695ecb9befdc62dd30fc8`.
The owned AX tree independently shows `Retry opening`, but its paragraph Text
interfaces yielded empty text; PNG evidence, not invented AX text, supplies the
exact displayed refusal.

Original result artifact `11931638467`, 386652442 bytes, SHA-256
`dfdc597245cf8812602d2ba7e09bb7309d0fa1e8ca5ef1fd2957caecf66db86f`,
is verified and retained under `artifacts/native-linux-components-38645211366`.
Both original failed artifacts remain unchanged.

Classification:

- **Confirmed product surface failure:** Setup returned the declined result
  without this probe pressing either permission button. It did not reach its
  embedded operation. The message alone does not prove deliberate cancellation,
  dependency absence, backend admission denial or the underlying OS error.
- **Confirmed source/runtime dependency gap:** private source `a311810...` selects
  Linux `tauri-plugin-dialog` 2.7.3 with `default-features = false` and
  `xdg-portal`; its locked `rfd` is 0.16.0. That backend implements message
  questions by spawning `zenity`, not an in-process GTK message window. A launch
  error becomes `MessageDialogResult::Cancel`; the plugin maps that to false,
  and Setup maps false to the exact displayed declined message. The actual DEB
  declares only `libwebkit2gtk-4.1-0, libgtk-3-0`, not Zenity. The test provisioning
  also did not explicitly provide or inventory Zenity. Primary pinned contracts:
  [rfd XDG backend](https://github.com/PolyMeilex/rfd/blob/0.16.0/src/backend/xdg_desktop_portal.rs),
  [Zenity question spawning](https://github.com/PolyMeilex/rfd/blob/0.16.0/src/backend/linux/zenity.rs),
  [documented Linux prerequisites](https://github.com/PolyMeilex/rfd/blob/0.16.0/src/lib.rs).
  Read-only inspection of the actual original archive's Setup ELF independently
  matched its 20868880-byte manifest hash and found the compiled Zenity error,
  command and `--question` strings. No app was executed for that inspection.
- **Likely, not proven runtime cause:** missing/failed Zenity is consistent with
  the immediate declined surface. No captured binary-presence/exec-status proof
  establishes its availability or original launch error on this runner.
- **Confirmed harness contract gaps:** the probe expects consent on the sealed
  module PID, whereas this backend's window belongs to its spawned Zenity child.
  It also originally selected companion `Open in Hub` for retry; that selector
  is now corrected with a focused regression to the actual built-in source/PNG
  label `Retry opening`. The paragraph Text gap means
  the planned recipe/status predicates are not yet experimentally verified.

Historical proposed next step (superseded by the GTK3 checkpoint below): parent review of this exact
dialog/dependency contract; bounded read-only inventory of the runner's resolved
Zenity binary/package/hash and backend launch outcome. Any native action would
need an explicitly reviewed Root -> sealed Setup -> exact system Zenity chain,
UID/start/kernel-image/XRes binding and rechecks, not a foreign-PID guard bypass.
Production package/dependency/error-reporting changes remain parent-owned. No
dependency, sandbox, payload, environment or deadline has been changed here.

Future workflow captures upload a small `native-linux-components-capture-*`
artifact **first**, containing all JSON/reports, stdout/stderr, owned PNG and
session log but no original input ZIP. `native-linux-components-source-*` retains
the original immutable ZIP/binding/receipts separately. Diagnose the compact
artifact; do not download another 386 MB source ZIP to inspect a refusal.
No additional run or product repin was dispatched after this classification.

Final local verification for the compact-first workflow and observed built-in
retry correction: 22 focused tests passed, 1 Linux-only fixture skipped; unchanged
Root tests 75 passed, 1 skipped. Workflow YAML, upload ordering and embedded native
GitHub-script syntax parsed. These changes are not a third native run or a suite
acceptance claim.

## Source Checkpoint: GTK3 Candidate Required

Parent commit `77367ae881413d6868e484f77e12a48c5aa58b00` selects
`tauri-plugin-dialog`'s `gtk3` feature for Linux Setup instead of `xdg-portal`,
with a mechanical lockfile prune. The committed Linux-only selection was read
directly and `node --test scripts/linux-dialog-backend.test.cjs` passed all three
source/preflight guards locally. Hub and MCP keep their existing default GTK3
selection. The producer preflight also checks the actual locked Linux `rfd`
feature graph; that Linux graph command was not rerun on this Windows host.

This source change requires a **fresh built and signed private Setup payload**;
the old `5bb05a2` DEB still contains the original XDG/Zenity-backed Setup ELF.
No old artifact, manifest hash, signature, report or helper pin is relabeled to
represent the GTK3 candidate. Parent owns producer/build/signing and subsequent
Root assembly. The separately verified `9894b1c` Root package still has the old
private Setup payload and is not evidence for this new dialog backend.

All old `5bb` native dispatches are stopped. No Zenity-child driver, native
Zenity-chain input, dependency provision or counterfactual run was performed.
The interrupted draft consists only of 48 uncommitted lines in
`scripts/native-linux-components-probe.py`: read-only inventory helpers plus
their import/constants. They remain preserved, unwired, unexecuted and untested;
they are not a runtime authority or an accepted part of the flow.

The existing strict in-process, manifest-sealed backend PID/start/UID/kernel
image/XRes/GTK dialog scope is the intended driver for a new candidate. It must
still pass actual decline, reaped backend, retry, approval and module operation
tests after independent new source/artifact/receipt/hash/signature binding.
No runtime fix, component-suite pass or release readiness is claimed here.
Actual GTK FileChooserNative/portal behavior remains a separate Flatpak test
gate; selecting GTK3 does not establish that gate by itself.

Compact-first capture and separate original-source uploads are committed in
`4459e615ab68a5cbfa8a17eae3e25f6b16489d51`. The validation branch is not pushed
again merely to exercise uploads: doing so would dispatch the obsolete pinned
DEB. Next diagnostics should download the compact capture only; original source
bytes and both failed-run artifacts remain retained separately. No active
commands remain at this checkpoint.
