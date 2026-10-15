# Native Linux Components Experiment

This is a bounded component GUI experiment, not migration, retirement, signed
update, Unity project creation, AI connection, Flatpak host integration or release
acceptance. Those gates remain false even if every component action passes.
Linux retirement/integration work is parent-owned. No Mac lane is included.

## Original Immutable Product

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

## Pending GTK3 Assembly Pins

The unpublished 48-line Zenity inventory draft was removed, and only that draft
was removed. No Zenity code was executed, installed or granted native input
authority. Original failure ZIPs/reports/PNG remain unchanged.

The Root helper now preserves its original complete `5bb05a2` authority in
`ORIGINAL_REVIEWED_PINS`. A separate fixed selector `setup-gtk3-77367ae` can only
activate `GTK3_REVIEWED_PINS` after the complete outer-assembly record is present
and valid. That record is deliberately `None` while assembly evidence is pending.
Unknown selectors, paths/URLs, partial records, mixed private sources, original
product relabeling and switching candidates within a process refuse. All
existing archive, file mode/hash, receipt, actual package and kernel-image checks
still run against the selected exact authority; none fall back to another one.

The reviewed preparation block independently records source/build
`77367ae881413d6868e484f77e12a48c5aa58b00`, source tree
`013e360eccb7474744f5e6cd0a6b719748d867e5`, preparation `38647206970` attempt 1,
and handoff SHA-256
`75cab0f78bb373c0a6d65a13b3c145b168e1b05439fd257e76991ad14d7295ae`.
The actual `artifacts/unix-payload-38647206970/transfer/prepared-unix.json` was
read: new Setup is 16554072 bytes, SHA-256
`c960edfdd2f86d1ef994ef639b0d3e1b35041acb78935bf5d61dd7f69f32978c`,
mode 0755; MCP's original 17328424-byte image/hash is unchanged. Parent reports
the original preparation artifact and signed upload verified; these are not
substitutes for outer assembly acceptance. The signed upload is private asset
`641883669`, 53946597 bytes, SHA-256
`28887d8d783468e04583d75905ca732237986f90110dea1d4929a103e37c6eb5`.

Parent is producing outer assembly `38648562557` at source
`4f3744d5707ed5cd26c2e5a1b10a7d45a5e8d10b`. Before activating the new selector,
review its completed-success API/job/source-tree binding, original artifact
ID/name/size/ZIP digest, raw Root/native DEB/installed Root hashes, and exact
manifest/archive/assembly-receipt/package-integrity file sizes/hashes/modes.
No such missing value is guessed or inherited from the original assembly.

The component CLI holds the old candidate and refuses the new candidate before
any temp-path, artifact, installer or native-process operation while its complete
outer pins are absent. The workflow uses `candidate-pins` before its first API
download; only that source-constant export supplies run/artifact/job/ZIP pins.
The primary API checks remain exact, and the exported Root helper self-hash is
checked again. After final reviewed constants are populated, recompute and
propagate the helper hash to `ROOT_SHA` and rerun both focused suites plus YAML/
JavaScript parsing before any authorized native dispatch. Worker candidate labels
are derived from the selected authority, not copied from an untrusted override.

The generic `native-unix-window.py` and sealed in-process GTK consent guard are
unchanged. No child-dialog exception, arbitrary input, runtime injection variable,
deadline change or sandbox broadening was added. Compact capture still uploads before separate
original source evidence. No old-product or new-candidate native run was started.

Pending-pin preflight: Root suite 80 passed / 1 skipped; component suite 25 passed /
1 skipped on Windows. Existing single-process helper suite 36 passed / 2 skipped;
native fixture source suite 8 passed. YAML, compact-first ordering and the
embedded GitHub script parsed. Tests include unknown/missing/mixed candidate
refusals, original source binding preservation, detached complete candidate
selection, worker-label propagation, early old-component dispatch hold and
helper self-hash consistency. No test fixture is a real new assembly pin.

## Activated 4f GTK3 Baseline

The complete candidate block is now populated from the reviewed successful
assembly `38648562557`, attempt 1, source
`4f3744d5707ed5cd26c2e5a1b10a7d45a5e8d10b`, tree
`cfda3105bfa144c05e7b68ccb92a7aa738ee6e52`, Linux job `116141491681`.
Primary API success/source/job/artifact metadata was independently read; parent
verified the complete original ZIP and independently rehashed all native packages.
`artifacts/linux-assembly-38648562557/review/pins-review.json` was read directly.

- Original artifact `11934297227`, `signed-unix-hub-linux-38648562557-1`,
  380463271 bytes, SHA-256
  `ce7d02ecd5e72cbce9a0343003726601ab82a103e8e25348cac771d78f0ac881`.
- Raw Root 21411480 bytes, SHA-256
  `b40b823f7e41e8d62b50246053d4887409e18c5daf5db370731c219bcd04f76d`.
- Native DEB 61510742 bytes, SHA-256
  `f95718e41af6b05f3206af503f310a57b300fafe4b9e7da5d48ae050a9a2a6d7`.
- Actual extracted DEB `/usr/bin/creator-hub` 21411480 bytes, mode 0755,
  independently BSD-tar hashed by parent:
  `524e7bc9505f7de4f22e29818ad6ba59b1fb4decf3b7bb2655b362f9240ba968`.
- Manifest 3663 bytes, SHA-256
  `802b5604e9a8446c96adb73a4408b5bd2c90c0e2303f67c191e0e28332793ff2`.
- Payload archive 55567186 bytes, SHA-256
  `7892f8256102bbfb995852a154fe0350a71642965a2f7f6642f8031cc92ac983`.
- Original assembly receipt 875 bytes, SHA-256
  `b930d76288f00fbd9694f0437852857e9dd77cca5c4371a987463992a47a421b`.
- Native package integrity receipt 6026 bytes, SHA-256
  `3d68a010025156d5a20eda862360acb09b7b3c19cb1693c36433ecd74a6f88f4`.

The Root helper self-hash was refreshed to
`d2848cd8110015982b9becee81aa259e333e6e0a9878bb152e2ae015f1e282f6`;
the component loader, export and workflow recheck it. The original candidate is
not overwritten and remains prohibited for component CLI dispatch. The new
candidate's metadata is independently checked before any native package launch.

This is the **4f GTK3 baseline only**, private source 773, unchanged MCP and the
old retained router image. It **does not include router fix `b154e36`** or any
newer working-tree production change. Product and test source stay separate in
the actual report. No Root/private build, Mac lane, Zenity provisioning/input,
seeded legal acceptance, migration, signed-update or final-release claim is part
of this run. Original failure cases and artifacts remain preserved. Actual
component operation remains pending the authorized native report.

Activation preflight passed: Root 81 / 1 skipped, components 26 / 1 skipped,
unchanged helper 36 / 2 skipped, native fixture source tests 8, dialog/source
preflight 4: 155 passed and 4 skipped in total on Windows. YAML/embedded script
syntax and compact-first upload ordering parsed. Read-only local verification
also rehashed the original ZIP, checked all six fixed members' hashes/sizes/
Unix modes, verified the complete payload inventory and native integrity receipt,
and matched the exact raw-to-DEB Tauri marker transform to the installed hash.
No application or installer was executed for that local verification.

## Actual 4f GTK3 Run: Consent Discovery Unverified

Run `38651341483`, test source
`64c89e92f86ee91187d16ea90399859e77b593f0`, job `116150612796`, failed at
`open-setup`: `Exact native component consent readiness deadline: setup-decline`.
The worker exited after 20484 ms. Exact upstream source/artifact/ZIP, resource
hash/mode/receipt, actual DEB install and Root ownership checks passed. Root
terms acceptance/save, convergence `Continue for now` and one native
`View Creator Project Setup` press passed. No Setup consent input occurred;
neither module operation nor preference-save acceptance was reached.

Compact artifact `11934663714`, `native-linux-components-capture-38651341483-1`,
40763 bytes, SHA-256
`33048b32ca33d25d5091f1df9474c8848a43caeddcd9bdd21107b24fd7a4bc63`,
was downloaded and rehashed independently. Original ZIP and bounded extracted
reports are retained under `artifacts/native-linux-components-38651341483`.
The original product remains the exact 4f assembly/ZIP/DEB/installed-image pins
above, not current HEAD or the newer router fix. No product rebuild is required
for this harness correction, and no original failure evidence is overwritten.

Actual captured process/window evidence:

- Root PID 3391/start 12714, UID 1001, installed kernel-image SHA-256
  `524e7bc9505f7de4f22e29818ad6ba59b1fb4decf3b7bb2655b362f9240ba968`;
  XRes Root window 4194307/client 4194304, exact Root title.
- The child observation recorded only system `WebKitNetworkProcess` PID
  3415/start 12741 and `WebKitWebProcess` PID 3419/start 12742, both direct
  children with UID 1001 and recorded kernel-image hashes. `matchedBackend` is
  null: no actual Setup image, native Setup window or Setup exit status was bound.
- The owned Root AX snapshot shows the Setup opening surface, not a recorded
  declined result. Bitmap capture correctly refused `Other managed windows
  present`; the capture does not record that other window's owner. Its existence
  does not prove a Setup dialog or authorize any input.
- One owned Root `WM_DELETE_WINDOW` was sent. Root was not reaped as zero:
  `rootExitCode` is null, output EOF is false, `normalExitVerified` is false,
  and disposable session teardown was required. No signal/force-kill was sent.

Classification: **confirmed harness inventory defect; actual product cause
unverified**. The previous `/proc/PID/task/PID/children` read covers only the
leader task. It can miss a child spawned by another Root thread. The primary
[proc children contract](https://man7.org/linux/man-pages/man5/proc_tid_children.5.html)
states that this list is per-task and may omit live children during exits;
[kernel proc documentation](https://docs.kernel.org/filesystems/proc.html)
defines the per-thread task directory and native parent/UID fields. Neither an
empty list nor this capture establishes process absence. Early Setup exit versus
an undiscovered live child/window therefore remains **unknown**, not a proven
product refusal or a proven GTK dialog.

A failing-first pure regression reproduces leader children empty while worker
thread children contain the backend PID. The minimal fix inventories at most
256 Root tasks, reads at most 4096 bytes per task and retains at most 32 distinct
child PIDs. Invalid/symlink task entries, a missing leader, oversized/ambiguous
lists and aggregate overflow refuse. A worker disappearing during the read is
not absence proof. Inventory is not authority: exact native PPID/UID/start,
manifest hash/size, executable seals, held/current image, XRes and strict
single-process GTK title/button checks remain unchanged. Read-only observed-child
diagnostics never authorize input. No titles, deadlines, environment, sandbox,
ownership allowlist or payload bytes changed; no automatic repeat is dispatched.

Correction preflight on Windows: components 28 passed / 1 skipped, Root 81 /
1 skipped, unchanged native helper 36 / 2 skipped, fixture source 8 passed,
dialog/source 4 passed: **157 passed / 4 skipped**. Python ASTs, workflow YAML
and its embedded GitHub script parsed. The Root helper self-hash is unchanged.
This proves the narrow source/test contracts only. The capture cannot identify
the other managed window retrospectively; that missing native evidence is still
required before classifying Setup as a product failure or accepting this flow.

## Corrected Inventory Retry: Strict AX Selection Refused

The one authorized retry was run `38652376421`, attempt 1, test source
`fefc5288256bee4c4c839381543f324b98efe0de`, job `116154004367`.
The native step failed at `open-setup`; `setup-decline` exited 1 after 2774 ms:
`Exact owned accessibility window is missing or ambiguous`. This is a different
failure from the previous readiness deadline. Upstream bindings, immutable
4f product/resource/DEB checks and install passed again. Root terms acceptance
was saved, convergence was skipped normally, and the Setup navigation press
completed. No native Setup consent input occurred.

Only compact artifact `11935336380`,
`native-linux-components-capture-38652376421-1`, was downloaded: 40064 bytes,
SHA-256 `3a30081f9334a8136bb97476387a61530478163a35d77d1964af1175e53a75b7`.
Its original ZIP and bounded members are retained under
`artifacts/native-linux-components-38652376421`. The separate original-source
artifact `11935321543` remains on CI; its 380231296-byte ZIP was not downloaded
again. Product source is still 4f, private source 773, not current HEAD or b154.

Evidence versus inference:

- **Captured:** Root PID 3461/start 36789/UID 1001, exact installed kernel-image
  SHA-256 `524e7bc9505f7de4f22e29818ad6ba59b1fb4decf3b7bb2655b362f9240ba968`,
  Root XRes window 4194307/client 4194304. Root stdout/stderr stayed empty;
  bitmap capture again refused another managed window. Normal Root close was
  sent but exit zero/reap/EOF was not verified; no signal was sent.
- **Control-flow proof, not a retained backend receipt:** this exact error is
  thrown inside the first strict `snapshot` after `direct_backend`, manifest
  hash/size/seals, held/current `KernelBinding`, backend UID, exact native XRes
  PID/title and one matching AX application have passed. The AX top-level
  name-plus-`DIALOG` filter did not return exactly one window. Thus discovery
  advanced beyond the old thread-inventory deadline; this is not evidence of
  an immediate backend exit before discovery.
- **Confirmed capture gap:** an exception from that first snapshot escaped
  before the successful-consent or deadline-only observation writes. No backend
  PID/start/kernel-FD/XID receipt, backend AX tree or exit status survives in
  this artifact. Those missing values cannot be manufactured retrospectively.
- **Still unknown:** wrong AX role/name, duplicate candidate or not-yet-registered
  AX top-level window. A backend exit during that interval is not excluded.
  No observed `ALERT`, exact AX name or product failure is claimed.

Primary source narrows the next capture, not the input authority:
[rfd 0.16 GTK message dialog](https://github.com/PolyMeilex/rfd/blob/0.16.0/src/backend/gtk3/message_dialog.rs)
constructs `GtkMessageDialog`, supplies its window title and custom buttons.
[GTK 3.24.33 message dialog source](https://github.com/GNOME/gtk/blob/3.24.33/gtk/gtkmessagedialog.c)
sets the accessible role to `ATK_ROLE_ALERT`; message type can set an accessible
name such as `Information` independently of the window title. This is a source
contract, not a captured claim about this runner's actual AX role/name or GTK
patch version. The generic helper already supports strict `ALERT`; it is
unchanged. Changing the requested role alone would not prove the title contract.

A failing-first regression reproduced zero diagnostic saves when the strict
snapshot raises. The failure-only correction writes the already-bound native
backend/image/receipt/XRes identity **before** that snapshot. On refusal it
retains bounded AX application counts and only the same sealed backend's
top-level names/roles and tree. Zero AX applications, ambiguous applications,
foreign nodes, native identity/window drift and size bounds are recorded/refused.
Native Root/backend and held image identities are rechecked around the read.
The diagnostic is explicitly post-failure, read-only, zero-action and not
authorization; same-PID AX candidates are not invented AX-to-XID associations.
Capture refusal does not replace the original strict snapshot error.

Input still requests the same exact `DIALOG`/title/button, with no fallback or
retry on this failure. No role/title/timeout/environment/payload/permission
change, product rebuild, Zenity input or further native run was performed.

Failure-capture preflight: components 32 passed / 1 skipped, Root 81 / 1 skipped,
unchanged helper 36 / 2 skipped, fixture source 8 passed, dialog/source 4 passed:
**161 passed / 4 skipped** on Windows. Python ASTs, workflow YAML and embedded
GitHub script parsed. These are source/fixture results only; no native role/name
capture or component operation has been accepted. The generic helper, reviewed
Root self-hash, workflow and immutable product pins are unchanged.

## One Capture-Only Follow-up

The authorized diagnostic follow-up reuses the 1455b6a failure capture and exact
4f product. An explicit `capture-only` entry point and fixed `setup-capture`
worker stop before any component permission input even if the strict snapshot
unexpectedly succeeds. Root terms, convergence skip and Setup navigation are
still real native actions. A strict snapshot refusal retains its original error;
a successful snapshot is saved with the bounded read-only AX observation and
then intentionally refuses further input. Neither path can fall through to the
full component loop or managed-routing approval. The workflow's native command
is temporarily capture-only; no product, system environment, timeout, title,
requested `DIALOG` role, generic helper or immutable input pin is changed.

A failing-first regression covers capture-only behavior, including the case
where strict snapshot succeeds. Preflight: components 34 passed / 1 skipped,
Root 81 / 1 skipped, unchanged helper 36 / 2 skipped, fixture source 8 and dialog
source 4 passed: **163 passed / 4 skipped**, plus Python/YAML/JavaScript syntax.
The dedicated validation branch is authorized for one such native run, not an
automatic repeat or a product rebuild. Actual AX evidence must precede any
role/name input-contract correction; this checkpoint contains no new native
result or component acceptance.

## Captured And Coupled GTK Contracts
Run `38653904385`, test `8f46524b357c90192abdda08be1412a50068b007`, unchanged 4f product.
Compact artifact `11935468678`, 41774 bytes; SHA-256 `1a4b3c44ae933e794530c1ebba43a3d87d4df3965cdc32862ab02141dc9f9224`.
Evidence: `artifacts/native-linux-components-38653904385/linux-root-probe/setup-capture-backend-{window,ax-refusal}.json`.
Setup PID 3525/start 128979, PPID 3440, UID 1001; sealed image 16554072 bytes, seals 15.
Image SHA-256 `c960edfdd2f86d1ef994ef639b0d3e1b35041acb78935bf5d61dd7f69f32978c`; XID 12582920/client 12582912.
Native title `Open Setup in Creator Hub?`; one AX `ALERT`/`Information`, 11 same-PID nodes, exact title/body and two buttons.
Identity rechecks passed; no consent input, backend exit status unavailable, Root normal reap/EOF not verified, no signals.
| Dialog | Pinned Source Contract | Native AX Evidence |
| --- | --- | --- |
| Setup | 773 `hosted.rs`: explicit Info, Open in Hub/Not now | Confirmed above |
| Root managed routing | 4f `builtin.rs`: default Info, Enable managed routing/Not now | Not observed; exact runtime gate required |
| MCP writable permission | 773 `hosted.rs`: explicit Info, Enable MCP controls/Not now, exact host/hash/body | Not observed; exact runtime gate required |
Root plugin 2.7.3 default Info verified from the crate matching 4f lock SHA `61854a36651aa48381e5e209f69a01273b77f3f9f91f0c430b1b98d33bd47229`; three cached source files matched the archive.
Opt-in `gtk_message_info_frame` uses only these exact title/ALERT/Information/context/button profiles; ordinary routing vs sealed modules remain distinct; old API defaults unchanged.
Geometry is exact AX SCREEN extents vs translated X client plus WM frame borders: [GTK](https://github.com/GNOME/gtk/blob/3.24.33/gtk/a11y/gtkwindowaccessible.c), [EWMH](https://specifications.freedesktop.org/wm/latest/ar01s05.html).
Source/fixture-tested geometry is NOT native-accepted. Root/MCP role/name association and later nameless-paragraph readiness remain unverified.
Read-only MCP, warning/unknown dialogs, altered host/hash/body, extra/nested/foreign windows, geometry or image drift refuse; no guessed input.
Captured-tree failing-first regression now passes; focused preflight 173 passed / 4 skipped, plus Python/YAML/JS syntax checks.
Six owned harness paths staged for parent review; prepared workflow is full `probe`, but no dispatch/push/product rebuild or full-flow acceptance.

## Nameless Paragraph Diagnostic Checkpoint
Run `38656402069`, test `3505a33`, unchanged 4f product: `open-setup` / `setup-declined` readiness refused.
Root terms saved; exactly one sealed Setup `Not now` click; no approval/retry/MCP action. Root reaped exit 0, both EOFs verified.
Retained `setup-declined-unready.json` has three showing Paragraph (72) nodes, all names/text empty; the owned PNG shows the exact decline reason.
This does NOT prove every paragraph type inaccessible: the old capture conflates absent Text with a zero count and omits child/interface metadata.
[Matching WebKit 2.50.4 source](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebCore/accessibility/atspi/AccessibilityObjectAtspi.cpp) explicitly gives Paragraph Text support.
[Text implementation](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebCore/accessibility/atspi/AccessibilityObjectTextAtspi.cpp) reads stringValue or descendant text; source expectations are not captured runtime proof.
Failure-only diagnostics now retain interface names, bounded attributes, Text availability/count/value/count recheck, Hypertext availability/link count, states and already-owned child indices.
The original failure UI snapshot is saved first; extra diagnostics never feed `shown_names`, readiness or input authority, and never follow hyperlinks.
Bounds: 64 nodes, 32 KiB diagnostic JSON, 2048 Text characters, 5-second diagnostic budget within the unchanged worker limit; partial/error results are explicitly unverified.
Root/renderer/native-window identities and AX wire membership remain checked; foreign/out-of-tree children, drift and oversized results refuse, not authorize.
Smallest pending capture: the existing post-failure snapshot plus `failure-text-interfaces.json` and owned PNG on the same immutable product; no extra consent action.
Decision after capture: only exact decline text from a proven owned Text/child path can justify a collector correction; Retry/generic error is insufficient.
No product a11y correction is established; if owned Text paths remain empty, assess the existing status/detail region's genuine accessible-name contract against native capture.
[WAI-ARIA status naming](https://www.w3.org/TR/wai-aria-1.2/#status) supports author naming; no production markup change or demonstrated runtime fix is claimed.
Focused component tests: 46 passed / 1 skipped, including nine diagnostic regressions. No native dispatch, rebuild, permission/timeout/selector change or readiness weakening.

## Parent Review: One Diagnostic Follow-up

Disk evidence rechecked: `38656402069` / `3505a33`, product `4f3744d`, private
`77367ae`. Confirmed failure: `setup-declined` readiness timed out after one
sealed `Not now` click. Owned PNG shows the exact decline message; three showing
Paragraph nodes have empty names/text. Root normal close, exit 0 and both EOFs
passed. No Retry, approval or MCP action occurred in that run.

Classification: confirmed harness observation gap; collector defect versus
product accessibility defect is **unknown / needs capture**, not proven broken
product UI. Exact-message readiness and identity/permission guards are correct
as-is. No speculative Root label or readiness correction is justified.

Prepared workflow delta is only a diagnostic step label/comment, leaving the
existing `probe` entry point, pins, environment and deadlines unchanged. Parent
must approve and selectively commit these four owned paths before one push to
`validation/linux-components-014`; no dispatch or push was performed here.
The checked local workflow has a branch filter, not a `paths` filter; its explicit
workflow-file delta also satisfies the parent's workflow-only change selection.

New hypothesis: the original snapshot omitted Text availability/count and owned
child/interface evidence that could distinguish unavailable Text, empty Text and
text on another already-owned node. Inspect `failure-ui-snapshot.json`,
`failure-text-interfaces.json`, `setup-declined-unready.json` and the owned PNG.
Unavailable/empty/errored/partial diagnostics do not authorize input; only an
exact decline message on a proven owned path can justify a later collector fix.
No automatic rerun. This is the existing full probe with failure-only diagnostics,
not a new capture-only stop: if readiness unexpectedly passes, the unchanged
probe can proceed to Retry/approval/MCP. Parent approval must cover that scope.

Fresh Windows preflight: components 46 passed / 1 skipped; Root 81 / 1;
native-window contracts 43 / 2; fixture contracts 8 passed; dialog backend 4
passed. Total **182 passed / 4 skipped**. Python AST, workflow YAML, embedded
JavaScript and Bash syntax, actionlint (without shellcheck/pyflakes), and scoped
`git diff --check` passed. Skipped native checks and this new Text/interface
observation remain unverified on Linux. No commit, stage, push, dispatch, package
rebuild/re-sign/repin or unrelated-file edit was performed.

## Diagnostic Result: 38711448824

Parent push `57ef78a623f7fed5317c9de773eb68041925b9b6`, attempt 1, completed
failure at `open-setup` / `setup-declined`. Product/private sources remain exact
`4f3744d` / `77367ae`; assembly run `38648562557` and original ZIP hash
`ce7d02ecd5e72cbce9a0343003726601ab82a103e8e25348cac771d78f0ac881` matched.
Only compact artifact `11961400532` was downloaded: 84298 bytes, SHA-256
`413e4e87f06b18808f5880d01dfd00bf619185ff01d35e61a461f572db22133b` verified.
Evidence: `artifacts/native-linux-components-38711448824/linux-root-probe/`.

Confirmed: one sealed Setup `Not now` input, no Retry/approval/MCP, owned PNG
shows the exact decline message. Root normal close, exit 0 and both EOFs passed.
Failure-only observation completed with `verified=true`, `authorization=false`
and zero actions across 26 owned nodes. `builtin-status` and `builtin-detail`
both expose Text, stable counts 28 and 65 respectively, zero children/links,
empty names and `readinessTextRole=false`. Text values were **not read**, not
proven empty. The original unready snapshot still records empty text.

Confirmed role-contract incompatibility explains the collector short-circuit:
[pinned WebKit enum](https://github.com/WebKit/WebKit/blob/webkitgtk-2.50.4/Source/WebCore/accessibility/atspi/AccessibilityAtspiEnums.h)
assigns Paragraph 72, Heading 82, Section 84;
[AT-SPI client enum](https://docs.gtk.org/atspi2/enum.Role.html) defines Paragraph
73, Heading 83, Section 85. Captured computed-role/id attributes independently
identify the affected nodes. Existing fixtures incorrectly supplied Paragraph
72 on both producer and client sides. A no-file-change local reproduction with
client Paragraph 73 and captured node role 72 returned empty `node_text`, zero
`get_text` calls, and the same diagnostic false role/nonzero count combination.

Classification: collector incompatibility and fixture coverage gap confirmed;
unavailable Text interfaces or zero character counts are ruled out for these
nodes. Actual returned Text values and a corrected collector's native behavior
remain unknown. No Root markup/labels, role/input authority, readiness rule,
product bytes or pins were changed. Next review should cover a failing fixture
using independent producer/client enums and source-bound read-only collection;
do not authorize Retry from counts, computed-role alone, or the PNG.

GitHub also showed earlier branch-advance run `38711395251` (`f7e9845`) executing
its native step, contrary to the initial no-native-job assumption. It was not
dispatched, rerun, cancelled, or downloaded here. No additional native run or
commit was made; this checkpoint changes documentation only.

## Paragraph Collector Regression

The parent reproduced the captured mismatch with independent enum values: client
Paragraph 73, producer role 72. The new exact-decline test failed before the
collector change. It now passes with the existing character/byte/drift bounds.
Only role 72 on the already package/image-bound WebKit 2.50.4 may use the
compatibility path, and only with `tag=p`, `computed-role=paragraph`,
`toolkit=WebKitGTK` and a noneditable state. The same attributes on an unknown
role, a numeric role alone, a foreign toolkit, hidden or editable content do not
enable a read. Standard client roles are unchanged. No enum translation is
applied to buttons, windows, actions or consent authority.

Fixtures now use the AT-SPI client values independently of producer observations.
The full local component suite passes 48 tests with one native-only skip. These
are collector regressions, not native component or release acceptance. A single
follow-up may reuse the unchanged signed assembly and original readiness/input
checks to verify actual returned text, Setup operations and MCP preference save.

## Native Follow-Up: 38713353372

Source `f8b6e7f8438f1adc66b8238394ebb6eb5dad7064`, same original signed GTK
assembly. The compact 110,167-byte artifact was hash-verified and retained under
`artifacts/native-linux-components-38713353372/`. Exact Setup decline text,
Retry and native approval passed. The owned bitmap shows embedded Setup with
the Linux platform label and actual requirements. This verifies the paragraph
collector correction against the real producer, not just a mock.

The run still failed at `setup-operation`, worker `component-11-setup-ready`:
`Component AX parent escaped bound subtree`. Cleanup also refused a stale AX
object path. Normal exit, Setup operation, MCP operation and component acceptance
are not established. The bitmap is rendering evidence, not action authority.

Failure-only capture now retains the original refusing walk's bounded node,
semantic-parent and GetChildren-parent canonical references, PID/role metadata
and truncated collected-reference inventory. It records at most eight missing
edges, 32 collected references and 32 KiB. Existing native ownership checks run
before collection; unknown/foreign parents still refuse without this capture.
No external-parent traversal, text collection, cache change, repair, retry or
action is added. Saving the capture cannot replace the original failure.
Local component regressions pass 51 tests with one native-only skip. The next
same-package run collects the missing topology evidence; it does not presume a
cache defect or relax containment to reach green.

## Client Cache Diagnostic

Run `38714806792`, source `da6274f`, again passed decline/Retry/approval, then
failed at Setup readiness with a stale AT-SPI object path. The containment
failure-only capture did not trigger: this error occurred before that final
check. Cleanup had the same stale-object refusal. Compact artifact `11962726216`
was downloaded with `gh run download` (no separate local ZIP-digest check);
its API-reported size is 110,145 bytes and digest is
`3c370ebc798594ac52fed7b8782cf3c08b3168ebae37bd30eed633dc5aca508c`.

Hypothesis, not a product fix: client caching may return a retired reference
during the embedded-view transition. The next same-package diagnostic sets
`ATSPI_NO_CACHE=1` only in the spawned collector workers, after Hub has already
been launched with its unchanged environment. This is supported by the
[at-spi2-core 2.44.1 initialization contract](https://github.com/GNOME/at-spi2-core/blob/AT_SPI2_CORE_2_44_1/atspi/atspi-misc.c#L871).
There is no extra action/retry, longer timeout, changed readiness/ownership rule,
product environment change, package rebuild or production acceptance. Local
component preflight passes 52 tests with one native-only skip. A failure will
disprove this as a sufficient correction; do not stack timing or selector changes.
