# Updater Target Safety Port

2026-10-13. Unified 0.1.14 is authoritative; there is no 0.1.13 release.
This note records a bounded safety port, not release or installed acceptance.
No version field was changed by this port.

## Ownership and Inputs

- Canonical checkout: `creator-hub-platform-review`; starting HEAD
  `db6a2420ef2a08a04079f45d7df49d422db38b60`.
- Read-only reference: `creator-hub-maintenance-013`, specifically
  `src-tauri/src/update_target.rs` and the Linux target-admission callsite in
  `src-tauri/src/self_update.rs`.
- Only this note, `update_target.rs` and that narrow `self_update.rs` callsite
  were edited. Existing concurrent version/product-settings/module/harness work
  was neither edited nor reverted. `main.rs`, scripts and workflows are untouched.

## Confirmed Broken Before the Port

The canonical AppImage helper returned an inherited outer pathname after checking
only absolute paths, executable-prefix membership, location outside APPDIR and
the `.AppImage` suffix. None establishes that the file backs the running mount.
Two new rejection tests were added before any production change:

- `inherited_appimage_and_appdir_cannot_authorize_an_unrelated_outer_file`
- `inherited_appdir_cannot_claim_an_extracted_hub_is_a_running_container`

```powershell
cargo test --offline --locked --release --manifest-path src-tauri/Cargo.toml --bin creator-hub update_target::tests::inherited_ -- --nocapture
```

Original result: **0 passed, 2 failed**. Both failed their `is_err()` assertion
because the canonical helper accepted the unbound outer pathname. Tests used
fresh temporary fixture files, not a live AppImage, installed Hub or user data.
The original failure remains in the chat tool transcript; it is not relabelled
as a passing native-install test.

Pinned local dependency contracts were also inspected: Tauri 2.11.5
`src/process.rs::current_binary` returns `Env.appimage` on Linux when present;
tauri-utils 2.9.3 `Env::default` warns about a non-mount-shaped executable but
retains these inherited fields. Hub's startup identity checks the running inner
executable, not the relationship between a FUSE mount and the claimed outer file.
This traces the restart risk; no live DEB/RPM exploit was executed.

## Ported Guards

1. `appimage_location` retains malformed-path rejection, then refuses even
   plausible inherited APPIMAGE/APPDIR combinations until the running container
   can be independently bound. The former positive pathname-only test now expects
   refusal. Unrelated fixture bytes remain unchanged.
2. `Target::native` refuses Linux native installer admission when `FLATPAK_ID`
   is present or `/.flatpak-info` is a file. Repacked DEB/RPM identity is not
   authority to update inside Flatpak. Windows and macOS ignore these markers.
   This is the maintenance detection contract, not Flatpak runtime acceptance.
3. Linux `raw_installed_location` obtains Tauri's actual restart selection,
   rejects links and requires `verify_restart_target(installed, restart)` before
   accepting the update target. Existing startup and pre-install rechecks reuse
   this admission path. A different inherited AppImage restart path refuses;
   an identical DEB/RPM path remains eligible for the existing guarded flow.

Windows NSIS naming/keys, registration checks, installer arguments and restart
behavior are unchanged. Mac application-location and replacement behavior are
unchanged. Package selection, signed descriptor discrimination, native consent,
signature checks, hosted drain and retained runtime/settings protections remain.

## Local Verification

Rust toolchain: pinned 1.99.0, Windows x86_64. Each command used `--offline
--locked --release --manifest-path src-tauri/Cargo.toml`:

- `cargo test ... --bin creator-hub update_target::tests -- --nocapture`:
  **8 passed**, including both previously failing regressions, Flatpak marker
  policy, restart mismatch, Windows descriptor/key and Mac location checks.
- `cargo test ... --bin creator-hub self_update::tests -- --nocapture`:
  **4 passed**, retaining signed identity/target/protocol and consent-notice tests.
- `cargo test ... --bin creator-hub mac_update::tests -- --nocapture`:
  **3 passed**, archive staging/refusal tests; not native Mac replacement.
- `cargo test ... --bin creator-hub installation_identity::tests -- --nocapture`:
  **2 passed**, unchanged target/pathname and in-place tamper refusal.
- `cargo clippy ... --all-targets -- -D warnings`: **passed**.
- `rustfmt --check --edition 2021 --config skip_children=true` on the two owned
  Rust files and scoped `git diff --check`: **passed**.

Total executed focused tests: **17 passed, 0 failed** after the fix. The added
Linux-only `tauri_inherited_restart_selection_is_refused_for_system_packages`
test uses a synthetic Env without changing process-global variables. It is not
executed by Windows and needs the native Linux owner's focused run. Linux-only
runtime callsites, actual Flatpak sandbox detection, Mac native replacement and
exact signed install/update/restart acceptance remain unaccepted by this port.
No signing, live installation, dispatch, commit, push or release was performed.

## AppImage Binding Design Only

Automatic AppImage updating remains disabled. APPIMAGE/APPDIR strings, canonical
paths, filename suffixes, a mount-shaped directory and an already fingerprinted
inner executable cannot substitute for outer-container identity.

Primary context: [AppImage architecture](https://docs.appimage.org/reference/architecture.html)
describes runtime/FUSE mounting followed by AppRun execution. The
[kernel proc contract](https://www.kernel.org/doc/html/latest/filesystems/proc.html)
exposes process executable/file descriptors and mount identifiers; it does not
establish an authenticated outer-container handoff to Hub by itself.

**Candidate design, an inference requiring native proof:** an approved runtime
or bootstrap pins its actual outer executable/container through a kernel file
descriptor before mounting, binds the mounted payload to those verified bytes,
and hands that descriptor plus mount identity to Hub over an authenticated private
channel. Hub verifies the peer/runtime, full container hash, inner mounted image
and original outer path/device/inode, retaining the established recheck and
replacement protections. A passed descriptor alone is not proof of mount backing.
Content mutation must be detected or prevented; an ordinary open Unix file handle
does not make the container immutable.

The smallest proving harness must reject a second unrelated image, forged env,
extracted/manual mounts, false peers, PID/mount reuse, deleted or renamed outer
files, in-place edits and same-path replacement without changing either original.
It must separately demonstrate a valid outer/mount binding and guarded restart.
Whether the exact packaged runtime exposes sufficient evidence without a new
bootstrap is unknown and needs capture. No such adapter or fallback is enabled
here; this design would require its own reviewed packaging/native acceptance work.
