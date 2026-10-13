# Maintenance 0.1.13 Release Gates

## Scope and Baseline

- 0.1.13 remains the separate-app product line. Hub, Creator Works MCP and
  Creator Project Setup retain independent installs and settings. Unification is
  deferred to 0.1.14 or later, not authorized by this port.
- Maintenance baseline: public v0.1.12 source
  `35a16a45814d821d65b5d203628478449174cd55`.
- Reference only: canonical unification source
  `0e5da253c7530fbc6c92d1b0b8fd54311474582c`.
- The maintenance branch ports package-specific Hub updater validation, startup
  installation identity and atomic macOS archive replacement. It adds the native
  descriptor producer and wires the exact public Windows baseline into both the
  smoke harness and fixture workflow. Package versions are consistently 0.1.13.
- Flatpak packaging is an x86_64 experiment with a separate updater/UI refusal
  path; it cannot invoke a DEB/RPM updater inside its sandbox. See [Flatpak gates](FLATPAK.md).
- No feeds, historical assets or installed apps were changed. Exact native
  install/GUI/update acceptance remains pending. Source and packaging tests do
  not establish release readiness or complete companion management.

## Descriptor and Receipt Contract

`scripts/native-hub-descriptor.cjs` admits stable `0.1.13` only. Its native
targets are macOS x86_64/aarch64 `.app.tar.gz`, and Linux x86_64 AppImage, DEB
and RPM. DMG installation media, Windows NSIS, Linux ARM and Flatpak are not
native updater targets in this producer.

Native metadata retains the existing schema and checks `appId=creator-hub`,
version, platform, architecture, package type, asset name, package length,
package SHA-256 and exact installed-executable SHA-256. A matching MCP/Setup
receipt cannot turn that product into Hub. Target-specific descriptor filenames
and updater keys cannot be substituted. The legacy Windows descriptor remains
`creator-hub-windows-x86_64.json` and its key remains `windows-x86_64`; the
existing Windows producer is untouched.

Each reviewed receipt must supply:

- `schemaVersion: 1`, `releaseLine: "separate-apps"`, `approvedForStable: true`;
- the exact descriptor artifact fields listed above (asset naming is checked
  by the producer; the canonical receipt match covers both hashes and length);
- `installerProtocol: 1` and target-specific
  `installerScope: "native-<target>-signed-update-restart"`;
- valid `identityProtocol`, `lifecycleProtocol` and `minHubVersion`;
- true `checks.discovery`, `cancelPreserves`, `installRestart`, `installedHash`,
  `settingsPreserved`, `connectionsPreserved`, and `companionInstallsPreserved`;
- reviewed Hub acceptance-run URLs under
  `https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/<id>`.

The separate-app marker is receipt admission, not an added signed-schema field
or a new consumer capability. Exact hashes bind it to the reviewed distribution.
Package integrity, ad-hoc signatures, source tests and an unsigned installer run
are NOT accepted signed-update/restart proof. Receipt declarations and URLs must
be reviewed against actual reports; this producer does not fetch/validate runs.
Unified Windows run `38384922196` binds a different installer and cannot authorize
maintenance bytes or a native package. No built-in-source release admission is
required, imported, invoked or relaxed by this separate-app producer.

Signing remains a future explicit CLI action through the existing Tauri signer
and external-key convention. Module import, receipt preparation and these tests
do not access signing keys or sign. The CLI validates the receipt before key
access, stages an exclusive copy, rechecks its bytes and refuses replacement of
output files. Native platform entries require later reviewed assembly; they do
not replace the published Windows entry or any historical asset.

## Baseline Selector

`scripts/self-update-baselines.cjs` preserves canonical public Windows 0.1.11
and 0.1.12 installer/executable pins. Explicit target `0.1.13` selects `0.1.12`.
Returned fixture copies cannot change those frozen pins. The no-argument CLI
follows the checked-out 0.1.13 package version and now also selects
0.1.12. The smoke harness selects from its validated target version and refuses
a live feed whose previous stable differs from that selected baseline.

The workflow validates the requested target against the checked-out version
before selecting the same baseline. Fresh fixture construction and reused-fixture
scope validation both use that selected version instead of stale 0.1.10. The
test-only marker, from/to equality, hash validation, source-revision/diff checks,
disposable Windows restriction, publication checksum/preflight comparison and
public feed validation remain intact. Fixture hash overrides affect only a
fresh baseline copy and remain labelled as not unmodified-public-stable proof.
No unified routing, lab feed or built-in acceptance path was imported.

These Windows pins and unit-tested wiring are not Mac/Linux baseline identities,
public discovery proof, native update execution or release authorization. The
workflow was not dispatched and the actual installed-update harness was not run.

## Remaining Native and Companion Gates

1. Validate the main owner's native Hub updater adaptation against exact
   installed packages: signature/product/target validation, cache separation,
   startup installation identity, platform handoff, cancellation, automatic
   restart and hosted-view restore. Existing Windows/writable/signing/ownership
   guards stay intact; this port made no source consumer edits.
2. Build exact separate Mac/Linux candidates. Verify both Mac architectures,
   package signatures, Gatekeeper/notarization status and declared minimum OS.
   Check MCP's actual private Node runtime and metadata in its separate package;
   do not inherit a unified Hub minimum merely because unified Hub bundled Node.
3. Run disposable previous-stable-to-exact-candidate preservation and update
   lanes. Distinguish manual native installer migration from old-app in-app
   update support; a version-only fixture is not unmodified-old-app evidence.
   Compare Hub preferences/adoption/projects, MCP settings/current and legacy
   paths, client entries, Setup caches/receipts, unmanaged files and both separate
   companion installs. Capture consent decline, busy refusal, retry and reconnect.
4. Companion Mac/Linux inventory, signed product/platform/architecture/package
   descriptors, native download/install/open paths, accepted hash pins and
   hosted direct-parent/private-pipe ownership are NOT DONE. Hub-only descriptors
   do not implement or authorize MCP/Setup updates or writable Unix hosting.
5. Kant is generating Flatpak packaging; host-versus-sandbox IPC acceptance
   remains separate. Packaging is not native package/update acceptance. Prove
   the host process/pipe identity, permission denial, data-path mapping and
   package-manager update ownership; do not bypass direct-parent/consent guards
   or route Flatpak through AppImage/DEB/RPM installation.
6. Follow `HUB-PUBLICATION-CHECKLIST.md` and `RELEASE-GATES.md` for exact artifact,
   legacy feed-size, draft/public discovery and signed installed-update gates.
   Publication remains unauthorized by this bounded implementation.

## Local Verification

Executed on Windows with Node `v22.22.2` on 2026-10-13:

```powershell
$env:NODE_PATH='C:\Users\bobman\creator-hub-platform-review\node_modules'
node --test scripts/native-hub-descriptor.test.cjs scripts/self-update-baselines.test.cjs scripts/release-descriptor.test.cjs
```

Result: **21 passed, 0 failed, 0 skipped**. This includes 17 new producer/baseline
tests and four unchanged Windows descriptor regressions. The baseline selector
matches canonical `0e5da25` exactly. Existing canonical dependencies were used
read-only through process-local `NODE_PATH`; no dependency installation occurred.
Tests use disposable temporary fixture files, never native installers, real
keys, client profiles or live app data. Fixture signatures are dummy format
strings, not signed release evidence. The producer's signing path was not run.

Verification covers exact target/product/version discrimination, every native
receipt check, separate companion preservation, package-integrity/unified/NSIS
receipt refusal, byte tampering, immutable staging, Windows naming/key retention,
frozen historical pins and explicit 0.1.13-to-0.1.12 baseline selection. It does
not prove Mac/Linux self-update, public feed discovery or release readiness.

Other runtime/UI and Flatpak work appeared concurrently in the checkout; none
was edited, staged or reverted by this bounded port. No signing, key access,
native installation, workflow dispatch, push or commit was performed.

### Baseline Wiring Follow-Up

Executed with the same Node version and process-local dependency path:

```powershell
node --test --test-reporter=spec scripts/native-hub-descriptor.test.cjs scripts/self-update-baselines.test.cjs scripts/release-descriptor.test.cjs scripts/check-release-feed.test.cjs
```

Result: **34 passed, 0 failed, 0 skipped**. This includes the prior 21 tests,
five new wiring/preflight regressions and eight existing release-feed/harness
guards. New regressions execute only the real harness's baseline/fixture preflight
in an isolated VM with native actions disabled, and exercise actual early refusal
on local, self-hosted and non-Windows environments. Workflow checks are structural
tests, not a dispatched runner. The harness diff changes only selector import,
baseline selection and the shared previous-stable assertion; fixture, native
consent, cancel, exact installed-hash, restart and preservation code is unchanged.

### Main-Owner Evidence

Local Windows verification on 2026-10-13: 139 main Rust tests passed (11 explicit
live tests ignored), plus 31 verifier-example tests, 201 browser tests against
the pinned separate-app source revisions, and strict all-target Clippy. The final
script suite passed 99 tests with one Linux/WSL opt-in test skipped; a separate
Flatpak run exercised all 32 tests, including real synthetic-DEB parsing and
metadata validation. These are component checks, not installed update proof.

Local logs are retained under ignored `artifacts/maintenance-*-20261013.log`.
Independent read-only review found no unresolved concrete regression in this
bounded updater port. Python 3.11+ is required by the payload verifier; CI now
explicitly provisions Python 3.12 before script tests rather than depending on
the runner's default. Native companion management, exact native installation,
GUI, signed update/restart and Flatpak host integration remain unaccepted.
Unification remains deferred to 0.1.14 or later.

### First Native CI Findings

Run `38392823489` at `ef254db` passed frontend/script checks but Linux and
Apple Silicon stopped on the existing Unix `while let` iterator loop under
Rust 1.99 Clippy. The original failed logs are retained; this is not native
update acceptance. Replace it with the equivalent borrowed `for` iterator and
test repeated enumeration, skipped unreadable/non-PID entries and exhaustion.
Pin Rust 1.99.0 in the repository and CI so the local and runner lint versions
match instead of silently following different `stable` installations. Neither
lint warnings nor install/process guards are disabled. The follow-up native
matrix must pass before its package artifacts can be assessed further.

## Files Written by This Port

- `scripts/native-hub-descriptor.cjs`
- `scripts/native-hub-descriptor.test.cjs`
- `scripts/self-update-baselines.cjs`
- `scripts/self-update-baselines.test.cjs`
- `scripts/native-self-update-smoke.cjs` (baseline wiring only)
- `.github/workflows/self-update-acceptance.yml` (baseline/fixture wiring only)
- `docs/MAINTENANCE-0.1.13-GATES.md`
