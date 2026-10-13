# Experimental Unix Candidate Packaging

This is a CI/disposable-machine packaging API, not writable GUI, installation,
migration, updater, native runtime or release acceptance. The default builder
still refuses Unix. No release/readiness guard or Rust/client state is changed.

## Native API

Run on the matching native host, after the existing root/module npm dependency
setup and Tauri runner prerequisites:

```sh
npm run build:unified -- UNIQUE-NAME --experimental-unix --installer
```

- Linux x64/ARM64: AppImage, DEB and RPM. `NO_STRIP=1` is supplied; integrity
  validation still refuses any changed module bytes regardless of that setting.
  Modules are transported in a precompile hash-bound `modules.tar.gz`, not raw
  ELF resources. The package verifier and Hub share the bounded Rust TAR/gzip
  decoder; original raw module/signature hashes and execute modes remain bound.
  Inventory is read-only. Opening restores a complete verified generation;
  existing corrupt generations are refused rather than overwritten.
- macOS Intel/Apple silicon: `.app` and DMG with existing ad-hoc app signing.
  Hub and its MCP backend now declare macOS 13.5 minimum, matching the pinned
  [Node 24.17.0 runtime requirements](https://github.com/nodejs/node/blob/v24.17.0/BUILDING.md#platform-list).
  The earlier native candidate's Info.plist incorrectly declared 10.13 on both
  architectures. This correction does not prove the reported Apple-silicon
  launch problem's cause or replace native GUI acceptance.
- Without `--installer`, only the staged backends/resources and raw Hub are
  produced. This is not a complete runnable native package/layout claim.
- Without `--experimental-unix`, Unix refuses before building or selecting a key.
  The flag on Windows refuses. Existing Windows `--installer`/NSIS behavior stays
  unchanged. Unsupported/duplicate switches refuse before any build/key access.
- `--managed` remains optional and uses the **unchanged** explicit signer/key
  contract in managed-router-package.cjs. Nothing synthesizes a production key,
  changes its password handling or makes a test signature publisher authority.
  An unsigned experimental candidate does not need a signing key.
- All Unix Hub builds force `CREATOR_MCP_HOST_WRITABLE=0` and read-only revision-2
  events, even if the invoking environment requested writable mode. No
  experimental-unix-hosting Rust feature is enabled. Packaged managed resources
  are dormant in this read-only GUI; they do not activate a route or edit clients.
- Native Rust targets are explicit for both backends, Hub and optional router:
  x86_64/aarch64-unknown-linux-gnu or x86_64/aarch64-apple-darwin. No cross-host or
  universal-Mac package is inferred from this flag.

Programmatic entry point:

```js
require('./scripts/build-unified.cjs').build('UNIQUE-NAME', {
  experimentalUnix: true, installer: true, managed: false
});
```

The existing npm_execpath requirement still applies. Unique immutable outputs
are under artifacts/unified/UNIQUE-NAME. Unix Hub targets default to that output's
hub-target directory; an explicit CARGO_TARGET_DIR must not already contain a
bundle directory. Existing bundles are refused, not deleted or reused.
Module/router cache overrides retain their existing names. Unix release paths
now include the explicit Rust target triple.

Native output API:

- native-packages/: exact retained `.deb`, `.rpm`, `.AppImage`, `.app` or `.dmg`.
- unix-package-integrity.json: container hashes, packaged Hub hashes and every
  expected module/managed-resource hash, plus integrityPassed or failure details.
- experimental-unix.json: target and format/mode description after success.
  Both reports keep writableGuiAccepted=false and releaseReady=false even when
  packaging integrity passes.
- package-extracted-FORMAT/: retained extracted evidence. No installation or
  package maintainer scripts run. AppImage uses only its extraction-mode runtime
  for this just-built local artifact; it is not a general untrusted-file scanner.

Linux validation needs dpkg-deb and bsdtar (libarchive-tools). AppImage
extraction needs no FUSE installation. Mac uses a unique read-only/no-open DMG
mount, copies its app, attempts owned detach even after partial attach failure,
and verifies app code signatures without a signing identity/keychain lookup.
These extraction steps are for CI/disposable packages, never a live installation.
Experimental Unix builds refuse inherited APPLE_* or TAURI_SIGNING_* environment
variables to prevent Tauri's automatic credential import/notarization/RPM signing.
The explicit CREATOR_HUB_SIGNING_* managed signer contract is left intact.

## Mac Signing Finding

The installed CLI pin is 2.11.4. Its [app bundler source](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/macos/app.rs)
copies Resources, then signs explicit main/external binary/framework targets and
the outer app. Resources/modules are not added to that signing target list.
The [sign implementation](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-macos-sign/src/keychain.rs)
does not pass --deep while signing. This is source evidence about the pinned
bundler, not a native experiment or a guarantee for future CLI versions.

Confirmed source-order defect in the previously unreachable Unix builder:
copying runtime/node applied codesign --force --sign - **after** the MCP backend's
build.rs had hashed its original archive bytes. A replacement signature cannot
be assumed to preserve those hashes or the Node entitlements.
The builder now leaves pinned Node bytes/signature intact. Rust backend copies
are ad-hoc signed before their manifest hashes; an optional Mac router copy is
signed before the existing managed signer binds it. Four source digests are
checked before/after backend compilation and against staged bytes. The manifest
is never rewritten to conceal a signing-induced difference after Hub compilation.

No Tauri --no-sign, hardenedRuntime, signingIdentity or outer-app signing flags
were changed. Mac `.app` and DMG resource hashes must match the original bound
manifest after packaging/signing, and DMG Hub bytes must equal the verified app's
Hub bytes. A native discrepancy fails packaging and preserves evidence; it is
not repaired by recalculating descriptors or toggling signing policy.

Linux permits only the exact UNK-to-DEB/RPM/APP main-Hub marker substitution
documented in pinned [bundle.rs](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle.rs).
The raw Hub is restored between package types. Any other difference refuses.
Module bytes must be completely unchanged in every package, including mode and
redirect/unlisted-file checks. Layout follows the pinned
[DEB generator](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/linux/debian.rs),
[RPM generator](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/linux/rpm.rs) and
[AppImage generator](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/linux/appimage/linuxdeploy.rs).

The failed native AppImage was retained and its four ELF changes were reproduced
exactly with the bundled patchelf. `NO_STRIP` did not prevent RUNPATH changes.
The archive keeps module ELFs opaque to linuxdeploy; Hub links with the exact
AppImage RUNPATH in advance. The strict marker-only comparison still refuses
any other Hub difference. No packaged manifest is re-hashed to hide mutations.
The retained original payload passed the native archive/extraction pipe with
all ten raw hashes unchanged and private Node 24.17.0 runnable. Fresh complete
Linux packages remain required; that pipe is not AppImage acceptance.

The first full archive build (38331254224) refused the JavaScript server's
inherited executable mode before Hub compilation. Linux staging now explicitly
sets executable copies to 0755 and data copies to 0644; source files and raw
content hashes are unchanged. The native pipe regression starts data at 0755
and checks the real staging policy before archive creation. Windows/Mac policy
is unchanged. The original failed log is retained, not relabeled as passing.

## Checks And Scope

```sh
node --test scripts/unix-package-payload.test.cjs scripts/build-unified.test.cjs scripts/managed-router-package.test.cjs scripts/installer-payload.test.cjs scripts/macos-signing.test.cjs
```

Tests cover opt-in/default refusal, native target/mode selection, credential
refusal, compile-bound Node re-signing mismatch, one-byte tamper and pathname
replacement, missing/unlisted/redirected files, execute mode, documented Linux
marker-only changes, failure evidence, report readiness flags and owned DMG cleanup.
Container extraction/signing calls in unit fixtures are mocked. They are not
native package evidence. Full native candidates have not been built in this
bounded worker; CI must run the commands above on each native host and inspect
the actual integrity report. No native Mac signing stability is claimed yet.

Only scripts/build-unified.cjs, the new unix-package-payload.cjs/helper tests and
this document belong to this worker. Parent-owned Rust, clients, CI workflows,
updater/signing helper code and pre-existing builder changes remain untouched.
