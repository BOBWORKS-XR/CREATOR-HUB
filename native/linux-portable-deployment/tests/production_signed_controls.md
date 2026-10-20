# Signed-Input Filesystem Controls

Test-only integration target, default-off with the existing `experimental-restart`
feature. No library, selector CLI, Root, module, signing, or workflow changes.
The fixed cohort is **reviewed 4d9 016 -> private source75 017**, not the newer
product candidate. This is mechanism evidence, not GUI or release acceptance.

## Inputs

Set `CREATOR_SIGNED_CONTROLS_INPUT_ROOT` to an absolute repository-shaped input
root containing these **seven original files**. All sizes and SHA256 values are
compiled into the test; all six package files were independently rehashed during
implementation. No version/key/profile override exists.

- `artifacts/release-016-updater-20261019/reviewed016-update-portable-39435741602-profile.candidate.json`
- Under `artifacts/signed-reviewed016-portable-39435741602/`:
  `creator-hub-linux-x86_64-0.1.16.portable-manifest.json`, its `.minisig`,
  and `creator-hub-linux-x86_64-0.1.16.appdir.tar.gz`.
- Under `artifacts/signed-private-portable017-39358518825/`:
  the corresponding three `0.1.17` files.

The profile SHA256 is
`1412daac05451789cbd99a400fa9fbd0a67f4c44f888844c0855112103b70325`.
It binds the retained producer/API/original-ZIP/member/delivery proof. The fixture
does **not** query fresh APIs or convert that retained proof into eligibility.
The old `final016-update-portable-profile.candidate.json` (ff cohort) is refused.
Do not substitute signed carrier ZIPs for AppDir archives or unsigned manifests
for the required detached signature files.

## Commands

From the repository, ordinary pure tests (use a separate build directory):

```sh
CARGO_TARGET_DIR=/absolute/private-build cargo test --offline --locked --manifest-path native/linux-portable-deployment/Cargo.toml --features experimental-restart --test production_signed_controls
```

Explicit read-only validation of actual signatures, full archive decoding and
both one-byte tamper refusals (works on Windows as well as Linux):

```sh
CREATOR_SIGNED_CONTROLS_INPUT_ROOT=/absolute/input-root CARGO_TARGET_DIR=/absolute/private-build cargo test --offline --locked --manifest-path native/linux-portable-deployment/Cargo.toml --features experimental-restart --test production_signed_controls -- --exact verify_fixed_signed_inputs --ignored --nocapture --test-threads=1
```

Only on Linux x86_64, unprivileged and outside Flatpak, explicitly run the three
filesystem controls. `OUTPUT` must be an **absent absolute path** under existing
safe native deployment ancestry; never an existing home/store. Do not normalize
permissions on an unsafe ancestor. The test creates only this fresh output and
its dedicated private HOME/XDG store, and never deletes it automatically.

```sh
CREATOR_SIGNED_CONTROLS_INPUT_ROOT=/absolute/input-root CREATOR_SIGNED_CONTROLS_OUTPUT=/tmp/signed-controls-UNIQUE CARGO_TARGET_DIR=/absolute/private-build cargo test --release --offline --locked --manifest-path native/linux-portable-deployment/Cargo.toml --features experimental-restart --test production_signed_controls -- --exact signed_input_filesystem_controls --ignored --nocapture --test-threads=1
```

The parent validates all seven input hashes and production signatures before
creating output. It starts only its own test executable in a cleared environment
with private HOME/XDG paths and no display/session bus. Child-only 180-second
alarm and 185-second parent observation bound apply; no Root/selector is launched,
signalled, attached, or adopted. Failure/unknown retains evidence and is not a
reason to automatically rerun. Input handles/identities/hashes are checked again
after controls. Existing product ancestry/owner/mode/refusal checks stay intact.

## Evidence And Limits

Retain `run.json`, `child.log`, and numbered `01-inputs.json` through
`05-complete.json`, plus the original input proof. Receipts bind the exact compiled
test/library source bytes, package pins, child PID, test-executable hash, actual
exit code, old selection bytes hash and operation refusals. The integration test
is compiled without `cfg(test)` in the library and calls the fixed production
verifier, not private synthetic test verifiers.
Build against frozen source. These included source hashes do not replace an
independent original CI/API/source binding for any later qualification consumer.

Signature controls change one manifest byte and one signature byte **in memory**
and require the production signature-verification refusal with unchanged store
control state. Staging uses the real signed 017 package and preserves exact 016
selection bytes. The stale control deliberately advances this private fixture
via public `Store::activate`, then requires stale restart-review and stale CAS
refusals with unchanged selection/history/generation inventory. That fixture CAS
is **not** proof of normal old-Root exit or authenticated selector readiness.

No qualification booleans are promoted automatically. Whole GUI, normal/abnormal
packaged-Root lifecycle, authenticated readiness, MCP continuity, recovery UI,
new-source acceptance, publication and release readiness remain unproven/false.

Next abnormal-Root control is **plan only**: retain a real packaged old Root under
the existing owned coordinator, authenticate the actual prepare/exit-authorized
sequence, make the owned process exit abnormally without replay, and prove exact
old selection retained plus pending/lease outcome from the original source-bound
receipt. A test executable supplied exit status is not that proof. Do not add or
execute this lifecycle control as part of the present batch.
