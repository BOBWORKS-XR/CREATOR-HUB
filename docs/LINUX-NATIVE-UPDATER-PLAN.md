# Native Linux Updater Acceptance Plan

## 2026-10-18 Progress

Full in-app acceptance is still **not passed**. The original prerequisite list
below is retained as a historical checkpoint, not the current build status.

- Current-source14 assembly39042746816 and actual fresh/manual12 upgrade
  run39105776879 passed. Product source534465a, private sourcef66d37f and exact
  package/image pins are recorded in LINUX-RELEASE-STATUS.md and its receipts.
- Outer-only15 run39105404389 passed without rebuilding/re-signing private
  binaries. Target DEB SHA256 is
  `98aa9750cecf387a960f994d24726e5ca09100a5ce3723607939eeaa08d80796`;
  installed ELF SHA256 is
  `7629379fbd3d0b7db0a996d727aa166750e08165478d622fe0d7c5047f2d50fe`.
- `verify-linux-update-fixture` imports the actual catalog/target source and
  verifies those signed local inputs plus changed-descriptor, foreign-Windows
  and changed-installer refusal. Its cross-platform offline pass is not Linux
  installation, discovery, authentication or restart acceptance.
- `linux-update-lab-feed.cjs` passed22 tests, including real loopback CONNECT/TLS
  routing and rejection controls. It serves only exact pinned GitHub paths and
  does not forward requests or install a CA. Native-session trust/bootstrap and
  the real Hub discovery/dialog capture are being integrated separately.
- Current-package component run39106806681 accepted terms and native component
  permission boundaries but stopped before operation input. The read-only
  geometry diagnostic must compare GTK's outer frame with the existing EWMH
  frame contract, not require it to fit inside its undecorated client rectangle.
  Semantic-Parent/action authority is not relaxed by that diagnostic correction.

All0.1.15 fixtures and the private v0.1.13-validation release remain forbidden
publication inputs. Windows bytes and public update metadata remain unchanged.

## Original Prerequisites

2026-10-17. Full in-app signed-update acceptance is **blocked**, not implemented
or passed. This task owns only `scripts/native-linux-update-acceptance.py`, its
matching `.test.py`, and this plan. No existing probe, package helper, workflow,
Windows file or production gate is changed. No commit, dispatch, local Hub run,
installation, user setting or authentication material is involved.

## Current Evidence

| Classification | Evidence and boundary |
| --- | --- |
| Correct as-is | `v0.1.12:src-tauri/src/self_update.rs::installed_location` refuses when `managed_installs_supported()` is false, with `Hub updates currently support Windows x64.` Linux12 needs an explicitly separate, one-time manual package migration. Do not count 12 -> 14 as an in-app update. |
| Correct as-is | Current `self_update.rs::install_hub_update` confirms natively, verifies catalog-bound bytes and a separate installer signature, records/suspends views, calls `linux_update::install`, handles system cancellation without restart, then requests restart on success. These are source contracts, not runtime acceptance. |
| Confirmed broken | Retained `artifacts/linux-components-38767944392/linux-root-probe/components-report.json` has `phase=mcp-operation`, `componentsAccepted=false`, and `Component AX parent escaped bound subtree`. The same report has `normalExitVerified=true`, `rootExitCode=0`. Normal EWMH close does not establish strict embedded control ownership. |
| Correct as-is | Existing Root pins select outer `4f3744d5707ed5cd26c2e5a1b10a7d45a5e8d10b`, private `77367ae881413d6868e484f77e12a48c5aa58b00`. `git show 4f3744d:src-tauri/src/self_update.rs` still calls `update.install(bytes)` on Linux, not the later sealed-input installer. Reusing these bytes cannot test the current outgoing updater. |
| Likely wrong but not proven | Assuming the captured Setup GTK `Information`/`ALERT` dialog contract also describes updater confirmation or a polkit agent. No such native capture was inspected here; do not add those names to the generic helper's allowlist. |
| Unknown / needs capture | The user identifies producer `39041386789` from `f66d37fae372ad975daaae4ef392089c6d8f784b` as pending. This probe has not fetched/reverified that run or its outputs. The parent owns producer completion, signing/outer assembly pins, package-helper/auth policy review and native dispatch. |

No production finding is patched by this task. All migration, signed update,
restart, restored-view and release acceptance gates remain false.

## Implemented Prerequisites

`python -B scripts/native-linux-update-acceptance.py prerequisites` reports the
seven concrete missing prerequisites and exits **2**, never green acceptance.
There is no `probe`, install, sign, launcher or policy-writing command.

`verifier-source` emits a complete Rust example for a disposable checkout's
`src-tauri/examples/native-linux-update-input.rs`. It imports the **actual**
`catalog.rs`, `update_target.rs` and embedded public trust key. It uses the
existing Root Cargo manifest/lock rather than a replacement validator crate.
It checks the Linux DEB descriptor/platform key, trusted descriptor signature,
exact package name/size/hash, extracted executable hash, separate installer
signature, exact production release URL and guarded installer protocol. It
admits only a source package version 14 and signed target 15/minimum14.
Changed descriptor/package and foreign-target checks use those same real APIs.
Its successful output means `releaseInputsVerified`, **not** native acceptance.
It does not authenticate artifact provenance or prove dpkg installed those bytes;
independent reviewed artifact/source pins remain required.

Parent-only next source test, in an isolated Linux checkout, after exclusively
creating that new example from `verifier-source` (never overwrite an example):

```sh
cargo run --release --locked --manifest-path src-tauri/Cargo.toml \
  --example native-linux-update-input -- SIGNED_DIRECTORY DEB EXTRACTED_EXECUTABLE
```

This example has been syntax-parsed with `rustfmt`, **not compiled or executed**
with authentic target15 inputs here. Existing Windows-only `verify-release.rs`
uses `verify_signed_id` and `windows-x86_64`; it is not a Linux verification gate.

`press_update_control` provides only the two source-named Root controls:
`Check for updates` and `Update Hub`, in the `Creator Hub update` heading context.
It reuses the existing component `own_tree`, Root/window/renderer binding, two
complete strict walks, same canonical node identity, ready state, exact single
WebKit `press`, and final ownership recheck. An uncertain action is not retried.
No entry point currently launches a worker or uses these helpers on a desktop.
The existing strict-parent failure still prevents input. No semantic-parent
repair, cache override, coordinate action or generic selector is added.

`preservation_snapshot` / `require_preserved` reuse Root `ordinary`/`file_record`
on the admitted isolated component fixture. They require the MCP config, Setup
editor roots, persisted Hub preferences/terms, inert server sentinel, and a
nonempty bounded backup directory. Backup names/content hashes must match the
actual `settings_backup.rs` format `launcher-config.json.<sha256>.bak`; file
hashes, sizes, modes and identity must remain exact. Capture **after** the native
preference save and before updating. Snapshot helpers do not create or prove
that native save. The restore ticket is excluded from preservation because the
real updater must create/consume it; do not seed one as restoration evidence.

## Minimal Fixture Design

1. Freeze the parent-reviewed successful fresh private14/handoff/outer14 source,
   run/attempt/artifact digest, DEB, raw/installed Hub and complete private-file
   hashes. Keep product source distinct from test source. Native terms acceptance,
   strict component operations/preference save and normal close remain necessary.
2. In an exclusive disposable source export of that same outer source, change
   only Root version fields in `package.json`, `src-tauri/tauri.conf.json`,
   `src-tauri/Cargo.toml`, and Root's `Cargo.lock` entry from 14 to 15. Compare all
   other tracked source bytes to the export. Do not reuse the Windows builder's
   hardcoded B05 inputs, NSIS output or release metadata builder.
3. Reuse the exact compiled MCP/Setup/server/Node/router binaries. Regenerate and
   separately sign only the version-bound runtime metadata using the existing
   `mcp-runtime-descriptor.cjs` / managed-router signer in the parent's signing
   environment. Verify every unchanged binary hash. Runtime metadata contains
   `hubVersion`; an unchanged whole14 archive is not automatically a valid15
   payload. Repack/rebind generated resources and rebuild only outer Hub15/DEB.
   Current Unix handoff/assembly explicitly require14: do not relabel a14 handoff
   or weaken its validation to manufacture15 authority.
4. Obtain acceptance-only Linux DEB descriptor/minisig and `latest.json` with
   `linux-x86_64-deb`, exact extracted15 executable hash, target version15,
   minimum14 and installerProtocol1. Parent authorization to sign this fixture
   is separate from this plan. Freeze every resulting byte; never publish it.
5. Run the actual-source input verifier and negative controls against those
   immutable signed inputs. Supply a reviewed disposable acceptance transport
   for actual catalog discovery and exact `github.com`/`api.github.com` routes.
   No catalog-cache seeding, app JS, endpoint flags, TLS-disable options or
   permissive polkit action is an alternative. Existing feed lab contracts and
   Root `child_env` do not currently admit this Linux flow unchanged.

## Required Native Flow

Stop before input whenever the next ownership/readiness prerequisite fails.
Capture original failure evidence; do not substitute a successful diagnostic.

1. Launch installed reviewed14 on a disposable Linux session, accept terms
   natively, establish both real views and the native preference-save backup.
   Capture exact settings/backup baselines and unrelated-runtime identities.
2. Discover signed15 through Hub's normal check. Capture the exact updater
   confirmation Root PID/start/UID/image/XRes, AX/native-frame correspondence,
   text/role and button contract. Select `Not now`; prove unchanged live backend
   identities/forms, no install/restart and preserved settings/backups. Disable
   automatic downloads through its native preference if asserting no download;
   do not confuse background prefetch with confirmation cancellation.
3. Approve Hub, capture the real system agent's independent PID/start/UID/image,
   XRes and exact AX control ownership, then exercise native system Cancel. The
   agent is not a Root renderer and cannot be authorized by title or Root PPID.
   Prove no package change, fallback prompt or automatic restart. Source closes
   views before system authentication; do not require them to remain open at
   this later boundary. Reopen through the real controls and prove retention.
4. Use a genuinely authorized disposable authentication session, with no real
   user credentials or secret logging. Approve once, prove the signed package
   reached the installed14 entry point and installed15, and capture automatic
   restart at the same exact protected installed path/image. Do not manually
   relaunch and call it automatic restart. Observe old owned backend exit and
   unrelated-runtime survival independently of Root exit.
5. Accept actual post-restart component permissions and verify both restored
   views/operations, consumed restore ticket, exact installed version/image and
   preserved settings/backups. Keep public discovery, manual12 migration, live
   AI connections and production readiness separate even after outgoing14->15
   succeeds. Missing-agent/install-failure boundaries still require their own
   narrowly captured tests, not permissive authorization or forced repair.

Local verification: **18 source/isolated-fixture tests passed**, including the
generated example's Rust syntax parse. Existing Root tests: 83 run, one native-only
skip; component tests: 80 run, one native-only skip; Linux updater source tests:
three passed. These suites did not run Hub or a native installer. Reproduce with:

```sh
python -B scripts/native-linux-update-acceptance.test.py
python -B scripts/native-linux-root-probe.test.py
python -B scripts/native-linux-components-probe.test.py
node --test scripts/linux-update.test.cjs
```

No native acceptance is claimed.
