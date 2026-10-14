# Mac Legacy Retirement Diagnostic

Scope: exact public Setup 0.3.7 and MCP 2.7.7 DMGs on disposable Intel and ARM
GitHub-hosted Macs. This is not a production removal helper, migration,
installer acceptance, or a release gate waiver.

The [passive audit](UNIX-LEGACY-GUI-RETIREMENT-AUDIT.md) and its exact package/member
pins remain the baseline. No old release bytes, signatures or metadata change.

## What The Probe Measures

- Fixed opt-in `validation/mac-legacy-retirement-014` branch and matching native
  architecture, before filesystem/process inspection. No arbitrary package or
  destination arguments. Refuse existing product apps in either application root.
- Read-only native DMG mount, exact package digest/size, fresh ordinary per-user
  `~/Applications` copy, full pinned file inventory, UID/link/dev/inode/hash facts,
  native plist, strict bundle signature, unchanged xattrs and Gatekeeper assessment.
- Exact directly owned GUI PID/parent/start time/kernel executable/native app
  identity. Standard AppKit Quit only after repeat identity and byte verification;
  the public tags guard `RunEvent::ExitRequested`. Report actual owned exit,
  rather than treating acceptance of Quit as proof of exit or external busy state.
- MCP's independently verified original `runtime/node` and `runtime/node.exe`,
  dependency layout, live newline stdio initialize/tools-list across normal GUI
  close, two original-path reconnects and ordinary EOF exit. No Unity tool call.
  The synthetic isolated server config is measured separately from real settings
  migration. All nine original resource paths and all other app files must match.
- Related LaunchServices registration paths are read-only observations, not
  authority to unregister an installed app.

## Historical GUI-Only Experiment

After the measured normal-close/stdio baseline, exercise **only MCP's GUI
executable**. A dedicated native NSAlert must first be cancelled, followed by a
whole-bundle byte/inode check and a live stdio check. A second fresh native alert
must be approved. The VM-only driver targets only the exact owned helper PID,
parent, kernel executable and hash, native modal window and enabled AX button;
it performs an actual AXPress, not a fabricated receipt or consent flag.

Keep both source/destination directory descriptors open. Write exclusive synced
intent/archived/restored records under this one experiment's folder. First prove
actual `RENAME_EXCL` collision refusal with an existing sentinel. Then archive
only `Contents/MacOS/creator-works-mcp-launcher` into that folder, without overwrite.
All nine original server/resource paths remain. Do not edit Info.plist, move the
app bundle or re-sign anything. [Apple's native rename flags](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/stdio.h)
provide the exclusive primitive; native execution must establish its actual result.

While it is absent, measure strict bundle signature, Gatekeeper assessment,
LaunchServices registration, an absolute-URL native launch attempt, the already
live stdio connection and reconnects through **both original Node aliases**.
Restore the exact archived inode with another exclusive rename and verify the
whole bundle and strict signature again. A barrier deadline restores only this
live experiment's verified before-image; journals never replay or grant authority.
This is not a generic recovery framework or a production retirement helper.

The workflow may pass for a complete, measured and restored experiment. Product
migration, permanent retirement, installer/update and release acceptance flags
stay false. Busy-workflow refusal, competing external installers and crash/power
loss recovery are not claimed. No user-PC application/settings change, credential
access, forced process stop or security bypass is involved.

## Baseline Already Captured

[Run 38632099882](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38632099882),
commit `47accf85f10aa70fc7e570d41c8a61aa8976acba`, completed both Intel and ARM
captures. Both pinned apps passed strict signature and normal Quit/exit 0, with
every original file unchanged. On each architecture the existing MCP stdio PID
returned 53 tools before and after GUI close; both original Node aliases
reconnected with 53 tools and exited normally on EOF. Synthetic isolated server
config bytes were unchanged. Gatekeeper assessment rejected all four old app
copies (exit 3); no bypass was attempted. That run intentionally stopped before
archival and returned failure. It is retained, not replaced by this experiment.

## Verification

Portable refusal/source tests:

`node --test scripts/native-macos-legacy-retirement-probe.test.cjs native/legacy-retirement-unix-proof.test.cjs`

Native workflow results and exact report facts will be appended after execution.

## Native Experiment Result

[Run 38633431819](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38633431819),
commit `2bbf8a67c512a1defa70e928aed48bcded9fffdf`, passed both native jobs.
The [compact measured evidence](evidence/macos-legacy-gui-archive-experiment-014.json)
binds the primary run/job/artifact metadata, independently verified original ZIP
size/digest and matching extracted report digest. Raw reports and original ZIPs
are retained locally under `artifacts/mac-legacy-retirement-38633431819`.

**One hypothesis proved, one disproved on both architectures:**

- **Proved:** actual native Cancel leaves every app member/inode unchanged;
  native Approve permits the one temporary GUI-executable move. Exclusive rename
  refuses the existing sentinel. All nine original MCP runtime/resources stay
  in place. The already live stdio PID still returns 53 tools while the GUI is
  archived; both original `node` and `node.exe` paths independently pass strict
  signature, reconnect with 53 tools and exit 0 on EOF. The exact GUI inode and
  whole bundle are restored; strict bundle signature passes again.
- **Disproved:** main-executable archival is clean Mac GUI retirement. The old
  app remains registered at `~/Applications/Creator Works MCP.app`.
  `codesign --verify --deep --strict` fails with exit 1, reporting
  `code object is not signed at all`. Gatekeeper rejects it with no usable
  signature. A real absolute-URL `NSWorkspace.openApplication` attempt returns
  **NSCocoaErrorDomain 259**, reporting the application is corrupt, and no app.

This is a concrete negative result, not missing hypothetical acceptance paperwork:
**do not wire the executable-only hollow-bundle technique into Root as clean
retirement.** It preserves runtime execution but leaves a corrupt, registered
legacy app. A different design must resolve that exact registration/signature
outcome while retaining original runtimes. No claim is made that all possible
Mac retirement designs are impossible. No production helper or generic recovery
framework was added; permanent retirement and release flags remain false.

Changed implementation paths are only the dedicated workflow and
`scripts/native-macos-legacy-retirement-probe.{cjs,swift,test.cjs}`. This document,
its compact evidence and the original audit's follow-up link record the result.
The 32 portable refusal/source checks passed before native execution. The later
evidence regression checks recorded results only; they do not rerun native code.

## Complete-Bundle Experiment Definition

This native run changes **one mutation variable**: instead of removing only
the executable, exclusively rename the complete pinned per-user MCP `.app` into
`~/Library/Application Support/CreatorHubLegacyRetirementProbe/<run>-<attempt>/`.
Reuse the same source, baselines, native Cancel/Approve, held directory descriptors,
collision refusal, three exclusive journal records and exact restoration.

Capture every file and directory inode/metadata before, at the archive and after
restoration; verify the complete archived bundle with native strict codesign.
Measure old-URL absence, LaunchServices URLs/existence and NSWorkspace's preferred
URL, plus an actual old-URL launch attempt. Keep the original stdio connection
alive and call `tools/list` and bounded `get_mcp_reference` before/while archived.
The public 2.7.7 reference implementation uses bundled constants only; use source
`workflows`, entry `networking`, limit 1, never Unity or project operations.

Actually attempt both old bundled-Node commands, capture their refusal, then
measure both new archive-path connections and read-only references. **Moving the
runtime changes its paths. This is not original-path preservation or client/settings
migration.** Existing unsupported or unmigrated clients must block eventual product
cleanup. Restore the exact bundle after the measurement, retaining any failure;
no new recovery framework, symlink, signing change, production deletion or Root
wiring is part of this experiment. No additional hypothesis/run loop is planned.

## Complete-Bundle Result And Handoff

[Run 38634969103](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38634969103)
at `75d728f3b327055fa24005169fe88294c40ca4d5` passed both Intel and ARM jobs.
[Pinned evidence](evidence/macos-legacy-whole-bundle-archive-experiment-014.json)
records primary artifact metadata and independently verified original ZIP/report
digests. Raw reports, native journal records and original ZIPs are retained at
`artifacts/mac-legacy-retirement-38634969103`; the earlier negative experiment
and baseline are untouched. No repeat run or second hypothesis was added.

| Observation | Both Architectures |
| --- | --- |
| Native Cancel/Approve; exclusive directory collision refusal | Passed |
| Complete bundle at owned Application Support backup | Same 13 file identities/bytes and 9 directory identities |
| Strict codesign at backup, then after exact restore | Exit 0 in both locations |
| Original Applications URL during archive | Absent; native launch returns not-found error 260, not corrupt-app error 259 |
| Already-live MCP connection during archive | `tools/list`: 53; bounded `get_mcp_reference`: same successful result/hash as before |
| Both original Node-path reconnect attempts | Refused before spawn with `ENOENT` |
| Both new archive-path reconnects | 53 tools, successful read-only reference, valid Node signature, ordinary EOF exit 0 |
| LaunchServices and NSWorkspace lookup | Resolve the valid archived app; resolve the original URL again after restore |

**Compatibility tradeoff:** whole-bundle archival is an intact backup/rollback
primitive, unlike the corrupt hollow bundle. It does **not** preserve runtime
paths or migrate clients, and it does **not** unregister the old product:
LaunchServices follows the valid bundle into the backup. These are the two
measured requirements still preventing relocation alone from being Hub-only
cleanup. The old live connection surviving read-only calls does not prove that
the next client restart/reconnect will work; both actual old-path attempts failed.
Gatekeeper assessment of the old ad-hoc app remains rejection, not consumer
notarization/signing acceptance. Setup was only the unchanged normal-close control;
this experiment did not archive Setup or migrate any real AI-app configuration.

**Smallest supported-client migration requirement before cleanup:** reuse the
existing reviewed adapter, not the backup path. Keep exact before-images; change
each recognized, approved Creator/Banter entry's executable and old server argument
to Hub's verified stable managed router (empty arguments, or `[router]` for
OpenCode). Preserve project/environment/options and unrelated entries. Prove an
initialize and safe reference call after the actual client restarts. Any unknown,
unsupported or unmigrated connection must stop cleanup. Source shape/refusal rules
are in `modules/mcp/launcher/src-tauri/src/client_migration.rs`; this experiment
does not establish that native client migration acceptance.

The separately measured registration-following behavior must also be resolved
before declaring the legacy GUI retired. No Root wiring, production deletion,
symlink, re-signing, security bypass or generic recovery framework was added.
All test state was restored on the disposable runners. Publication remains held.
