# Linux DEB Runtime Retention Experiment

Bounded standalone validation for unified 0.1.14, 2026-10-14. Not production
integration, a release, client migration, Flatpak acceptance, or macOS work.
Only new `scripts/linux-deb-retention-*`, this document, its new evidence file,
and `.github/workflows/linux-deb-retention-014.yml` belong to this task.

## Finding And Candidate

- Correct as-is: production non-Windows retirement refusal remains unchanged.
- Confirmed incompatible with retention: removing the whole MCP DEB also removes
  its original runtime. Direct system-file deletion, dpkg database modification,
  and remove-then-restore are excluded.
- Unknown before native capture: a same-package, higher-version runtime-only
  update preserving live and fresh original-path connections.

The exact public package is `creator-works-mcp` 2.7.7, amd64, 96,666,824 bytes,
SHA-256 `db47aed5f5acd4e00e8e0782361444de228c4181eeea4970f90116f1f16cf10b`.
The existing [public audit](UNIX-LEGACY-GUI-RETIREMENT-AUDIT.md) and
[pins](evidence/legacy-unix-public-package-pins-014.json) are inputs, not changed.
Its control archive has only `control` and `md5sums`: no maintainer scripts or
conffiles. Original control: package/version/architecture above, Maintainer
`Creator Works`, Priority `optional`, Installed-Size `263030`, Depends
`libwebkit2gtk-4.1-0, libgtk-3-0`.

The test candidate is the **same** package and architecture, version
`2.7.7-1+hub.retention014.1`. This is a validation-only version, not a proposed
published version. It contains exactly the original nine resources at
`/usr/lib/Creator Works MCP/server`, including both `runtime/node` and
`runtime/node.exe`, unchanged in bytes and modes. GUI, desktop entry, and all
three package icons are omitted. No scripts, conffiles, diversion, alternate
root, force option, package removal, or manual package-database write is used.
GUI dependencies are deliberately retained to change only the payload/version;
minimal runtime dependencies and autoremove behavior are not tested.

## Debian Contract

Current primary docs checked 2026-10-14:

- [Debian Policy 6.6](https://www.debian.org/doc/debian-policy/ch-maintainerscripts.html#details-of-unpack-phase-of-installation-or-upgrade):
  unpack replaces package files; step 6 removes files present only in the old
  version; step 7 replaces the file list. Error unwinds have points of no return,
  so normal success does not establish interruption or recovery safety.
- [Control fields and version ordering](https://www.debian.org/doc/debian-policy/ch-controlfields.html#version):
  a Debian revision can distinguish this same-upstream compatibility package.
  The actual runner also requires `dpkg --compare-versions NEW gt OLD`.
- [dpkg](https://manpages.debian.org/trixie/dpkg/dpkg.1.en.html):
  `--install` unpacks/configures; `--verify` checks available package metadata,
  not publisher trust. Separate SHA-256, mode, UID/GID and ownership checks apply.
- [dpkg-deb](https://manpages.debian.org/trixie/dpkg/dpkg-deb.1.en.html):
  build a normal package using `--root-owner-group`; extraction alone is not an
  installation. Both archive streams are inspected before baseline installation.
- [dpkg-query](https://manpages.debian.org/trixie/dpkg/dpkg-query.1.en.html):
  `-L` reports installed file lists and `-S` package ownership; these alone do not
  inventory arbitrary maintainer-script output or alternatives.
- [Gio application enumeration](https://docs.gtk.org/gio/type_func.AppInfo.get_all.html)
  lists registered applications without constructing a missing desktop object.
  [DesktopAppInfo.new](https://docs.gtk.org/gio-unix/ctor.DesktopAppInfo.new.html)
  may return NULL when the desktop ID no longer exists.

Inference to test, not an atomicity guarantee: an existing Node process should
continue while normal unpack replaces its on-disk image, and unchanged files at
the same paths should allow new SDK connections.

## One Native Transaction

The push-only, branch-bound workflow has one Ubuntu 22.04 x64 job, no matrix,
no credentials passed to the probe, and read-only repository permissions.
Portable tests run before downloads/installations. The official MCP SDK 1.29.0
is installed from the existing lockfile without build/lifecycle scripts.

1. Download and hash-check the original public DEB; verify both control pins,
   all 14 file MD5s, selected SHA-256 pins, types, modes, root ownership and no
   links/extra files. Build and re-inspect the nine-file candidate.
2. Refuse a pre-existing installation; install the original via normal apt.
   No legacy GUI is launched. Seed eight synthetic settings/client/project/cache
   sentinels under an isolated runner-temp HOME, not the runner's real HOME.
3. Keep one official-SDK connection from original `runtime/node` alive. Verify
   tools/list and a bounded bundled-only `get_mcp_reference` call. Fresh-connect
   both original Node aliases before the update. Capture package ownership,
   all installed file hashes/modes/UID/GID, clean dpkg verification and desktop
   discovery through a fresh Gio process.
4. Run exactly one `sudo -n dpkg --install CANDIDATE.deb`, while the SDK connection
   stays open. This fresh-runner harness never launches the GUI; it does not
   inspect or establish GUI idleness on an existing user installation.
5. Recheck the same PID/start time and reference response, then fresh-connect
   both original aliases again. Verify all nine original runtime resources and
   ownership remain exact, all five omitted GUI/desktop/icon paths and ownership
   are absent, and fresh Gio desktop discovery returns none. Verify all settings
   sentinels unchanged. Close only SDK-owned transports.

This does not prove GUI idle/close or native consent on a real installation.
It tests synthetic settings preservation, not all real user settings schemas.
Native cancellation, tamper, recovery, GUI-close, Setup, production integration,
Flatpak, signed-update and release gates must remain **false**. Setup 0.3.7 was
inspected passively but is deferred to keep this one concrete MCP transaction.
Do not install this candidate on a user machine or publish it as a product.

## Verification And Outcome

Local portable commands (no native package/runtime execution):

```text
python -B scripts/linux-deb-retention-probe.test.py
node --check scripts/linux-deb-retention-sdk.cjs
node --test scripts/linux-deb-retention-sdk.test.cjs
```

### First Run: Confirmed Probe Failure

[38642404016](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38642404016),
source `a0297d5622681b633ce6364d9b97244ffe892416` (parent
`058516dfc9e7d12c38c9be039ae52a318e2c512e`), failed overall. Its dpkg update
completed and package status was `install ok installed` at the higher version.
Already-live PID 3375/start time 77239 answered 53 tools and the same bounded
reference hash before/after. Both original aliases reconnected on both sides.
The after-snapshot completed package/hash/ownership/absence/verification checks,
then its desktop-observer constructor raised `TypeError: constructor returned
NULL`. This is a **confirmed harness defect**, not a package/runtime failure.
Settings-after and overall acceptance were not recorded; all gates stayed false.

The minimal regression reproduces the missing constructor's exception and checks
enumeration with present, absent and duplicate IDs. The corrected capture uses
fresh-process Gio enumeration. No product behavior changes. The rerun downloads
the first run's immutable artifact `11929999662` (ZIP SHA-256
`fed96cd27ab4245e61ac91fd1fe3010e70cdb2192dbc4250786c1ed15f3d6d9e`)
and reuses the exact original/candidate DEBs. Candidate: 69,843,476 bytes, SHA-256
`0f3c7ade0eba54b8d44a8ea5e71d33da0938f96f6c3f4b68502e937532eccd19`.
The native guard and archive checks still apply; package bytes are not rebuilt.

### Corrected Native Outcome

[38643248531](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38643248531)
passed on one disposable Ubuntu 22.04 x64 runner. Exact test source:
`be8fb61d9bd8428fe02ca3c91d1bef7e3eac693f`; package-build source remains
`a0297d5622681b633ce6364d9b97244ffe892416`. No package bytes were rebuilt.
The 11 focused portable tests passed before downloading the immutable input.

The normal same-package `dpkg --install` upgrade retained all nine runtime
resources at their original paths with matching SHA-256/MD5, mode, root UID/GID
and package ownership. The existing SDK connection survived (PID 3234, process
start time 27314), both original Node aliases reconnected before/after, and all
checks returned 53 tools and the same bounded reference SHA-256. Normal dpkg
replacement changed the live process's `/proc/PID/exe` suffix to `(deleted)`;
fresh connections used the installed image at the unchanged original path,
not a relocated cache or alias.
All five GUI/desktop/icon files and their package ownership were absent afterward;
fresh-process Gio enumeration no longer listed the desktop ID. Both dpkg
verification captures were clean. All eight synthetic settings/client/project/
cache sentinels retained their exact bytes.

**Accepted only:** this package transaction's runtime retention and package-level
GUI retirement. It does not prove refresh of an already-running desktop shell.
Native cancellation, tamper, recovery, GUI idle/close, Setup transition, production
integration, client migration, Flatpak, signed-update and release gates remain
**false**. This is a real package-manager-supported compatibility mechanism on
the tested Ubuntu baseline, not authorization to ship or install it elsewhere.

Original/candidate DEBs, command exits/stdout/stderr, before/after captures and
`report.json` are retained for seven days in artifact `11930573482`, ZIP SHA-256
`335b3d39fa7c8dbf4fa5ed6337da6de6ef1158c56c1d9abd947d7f6077265dcd`.
The [permanent evidence summary](evidence/linux-deb-retention-014.json) preserves
both the failed first capture and the corrected result. Full local captures:

```text
C:\Users\bobman\AppData\Local\Temp\creator-hub-linux-deb-retention-014-38642404016
C:\Users\bobman\AppData\Local\Temp\creator-hub-linux-deb-retention-014-38643248531
```

All commits are independent on `validation/linux-deb-retention-014`, based on
`058516d`, without switching/updating the shared feature branch or its index.
The owned new files intentionally remain untracked in that shared checkout;
unrelated human/agent changes are preserved. No Mac, production, publication,
auth-file, UI/broker/agent-source, or live user installation work was performed.

## Parent Handoff

No new Setup or production task is started. Preserve the seven untracked mirror
files below until the parent reviews/integrates the independent branch. The
accepted executable test source is `be8fb61`, not the later evidence-only tip.

### Minimum Proven Inputs

- Public source/tag: MCP 2.7.7, target
  `9cd12e28d1dd05057b84166d4718a5d6369eff93`; launcher path/config contracts
  are linked in the original audit. The DEB bytes, not the version label alone,
  establish this experiment's payload identity.
- Original `control`: 297 bytes, SHA-256
  `1b5ab5aa32886336f2eec3e48690c09286715e7438448813dcaa070c73111213`.
  Original `md5sums`: 1,265 bytes, SHA-256
  `556261ac6789876557ddbff925a8652f94ca8649ad251acac64a07f501b1208f`.
  Exactly these two control members; no maintainer scripts or conffiles. Exact
  package name/version/architecture, dependencies and descriptions are in
  `plan.json`; full original controls are retained in the capture.
- Retain exactly nine files below `/usr/lib/Creator Works MCP/server`, including
  both native Node names, the executable `.mjs`, both licenses, notices, runtime
  version, bridge and logo. The permanent evidence gives each original path,
  byte count, SHA-256 and mode. Installed UID/GID stay 0/0, owned by
  `creator-works-mcp`. Do not substitute a cache, rename, or copy-back transaction.
- Candidate control keeps `Package: creator-works-mcp`, `Architecture: amd64`,
  uses `Version: 2.7.7-1+hub.retention014.1`, and deliberately retains the old
  dependencies. Only validation metadata/payload changes; no production signing
  or trust decision has been established for this synthetic package.

### Required Production Boundary: Not Implemented

The disposable proof used `sudo dpkg --install` on its runner-local test DEB.
**Do not ship that caller-controlled package-path pattern.** The parent's next
integration must invoke a fixed, trusted privileged helper through the fixed
system `pkexec`, not elevate an unprivileged/mutable local package handed to Root.
No helper, polkit policy, or privileged-source contract is implemented or accepted
here. The trusted helper must itself acquire/verify a trusted package into a
protected namespace and bind the verified bytes to the actual dpkg input;
reopening a mutable caller pathname after hashing is not sufficient. UI metadata,
unprivileged manifests, a version string, or a journal are not install authority.

Minimum proposed version/state policy for that separate implementation:

- Upgrade only the exact approved `creator-works-mcp:amd64` baseline, healthy
  `install ok installed` at 2.7.7, with expected complete original ownership and
  file pins. Admit no implicit fresh install, other version/architecture, hold,
  partial/unpacked/half-configured state, foreign ownership, changed payload,
  diverted or redirected namespace. These production refusals are not tested.
- Require an explicitly approved compatibility package identity and strictly
  greater Debian version, exact retained resource/control allowlists, no hidden
  scripts or relationship fields, and privileged revalidation before the one
  normal package transaction. The fixture version is not approved for shipment.
  No force/downgrade, remove/purge/autoremove, manual dpkg DB mutation, or
  remove-then-restore fallback.
- Native review/approval/cancel, real legacy-GUI idle/normal-close, competing
  package/process changes, tamper refusal and recovery remain acceptance gates.
  Preserve already-live SDK connections and prove original-path reconnect again
  through the actual shipped helper/coordinator. The current proof does not lift
  signed-update, unified-product, client migration, or Flatpak gates.

### Owned File Manifest

```text
.github/workflows/linux-deb-retention-014.yml
scripts/linux-deb-retention-probe.py
scripts/linux-deb-retention-probe.test.py
scripts/linux-deb-retention-sdk.cjs
scripts/linux-deb-retention-sdk.test.cjs
docs/LINUX-DEB-RETENTION-014.md
docs/evidence/linux-deb-retention-014.json
```
