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

Native dispatch and exact outcome are pending. A green portable preflight is
not native acceptance. Original/candidate DEBs, command exits/stdout/stderr,
before/after package captures and `report.json` are retained for seven days by
the single workflow. A compact permanent evidence record will identify the run,
source, package hashes and measured outcome without lifting other gates.
