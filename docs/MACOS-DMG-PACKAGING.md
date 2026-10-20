# Headless Experimental Mac DMG Repack

`scripts/macos-dmg.cjs` packages an **already signed** app without rebuilding,
signing, Finder, AppleScript or custom layout. Its current scope is the
experimental **read-only 0.1.14 packaging regression**, not final Managed 14 or
native hosting, migration, installation, notarization or release acceptance.
All receipts retain `releaseReady=false`, `productAccepted=false`,
`managedGuiAccepted=false` and `notarizationVerified=false`.

## Retained Failure

The supplied Intel failure is run `38469742692`, job `115545435770`:
`hdiutil detach disk2` reported `Resource busy` after the existing layout path.
The busy detach is confirmed in the supplied evidence; Finder causing the lock
is **not proven**. This alternative removes the layout path, not an identified
locker. It has not yet been run natively and is not a demonstrated fix.

Keep the original failed run and artifact `11853171218` unchanged. Its supplied
SHA256 is `234b8d395ae3bc22a2d3e19e0be6a8a8e22e13adc636414a12589ba8e88ecad2`.
It retains the signed pre-DMG app archive and `bundle_dmg.sh`. The base worker
does not download/extract archives or establish GitHub provenance. The dedicated
`macos-dmg-repack.cjs` wrapper below supplies those checks without reconstructing
missing descriptor bytes or rebuilding the app.
Missing original descriptor/preservation evidence is a prerequisite failure,
not permission to regenerate a descriptor or re-sign code.

## Dedicated Retained-Input Repack

`.github/workflows/macos-dmg-repack.yml` triggers only on a push to
`validation/mac-dmg-repack-014` changing that exact new workflow path. It has
read-only `contents`/`actions` permissions and a single `macos-15-intel` matrix
entry. There is deliberately no ARM entry: this retained app is x64, not an
ARM test input. The workflow installs root JS test dependencies only; it does
not invoke the product builder, managed assembler, signer, or application.

The wrapper's `PIN` binds repository `BOBWORKS-XR/CREATOR-HUB`/ID `1364807512`,
run `38469742692` attempt `1`, workflow `unified-unix-candidate.yml`, Intel job
`115545435770`, and artifact `11853171218`. Run/job conclusions must be the
original **failure**, with the exact failed build and successful input-retention
steps. That condition admits diagnostic input provenance only, never a package.
Artifact creation must fall within the Intel job interval.

The immutable source graph is:

```text
head   edc59c55f336cda496c373f2475e94becf9e797e
merge  64d8bf746ae48ca6c3709554d23bee9d2f8cb595
base   35a16a45814d821d65b5d203628478449174cd55
tree   516200e15ea2ecf7c11d3a9f0e93e5d8bc5b78ef
```

Both head and merge trees must equal the pinned tree, and merge parents must
equal `[base, head]`. Artifact names are merge-labelled, not head-labelled.
Present historical PR metadata must match PR 21 and both repository IDs; absent
PR metadata does not substitute for or relax these immutable graph checks.

Actual ZIP bytes must be `54307809` and match the supplied SHA256 above before
any extraction. Selected member pins are:

```text
builtin-manifest.json: 1457 bytes
6315d6444a933e34074ff67c9e37fac691804fcfdcf0a3a8e516867c4b0dfe0f
signed-app-before-dmg.tar.gz: 54843140 bytes
b4f17dca258794290801effbafb38beba1ca526a11c2eb8f2ab4176534a72a26
```

Read-only, in-memory inspection of this pinned ZIP confirmed exactly three
regular ZIP entries (manifest, retained script, app TAR). The decompressed TAR
is `171824128` bytes with 26 entries: 14 regular files and 12 directories, no
links or PAX extensions. The wrapper validates every physical TAR header with
Python's standard parser, an exact path/type/mode whitelist, checksums and
bounded sizes before writing only the manifest and TAR into a fresh runner
input directory. Unknown entries, links, hardlinks, extensions, special modes,
file/directory substitution, duplicates and trailing data refuse; there is no
general-purpose `extractall`. BSD tar then preserves original modes/mtimes
under a new owned app directory; archive UID/GID metadata is recorded, while
extracted files belong to the disposable runner UID (`--no-same-owner`).

Before invoking the worker, the wrapper verifies the original resources, exact
embedded manifest, root bundle identity/version and `codesign --verify --deep
--strict`. It captures the signed Hub checksum and complete app inventory once,
along with 12 protected original descriptor/Hub/module files (bounded to 16).
The archive has no independently supplied old signed-Hub/app-map baseline, so
`diagnostic-original-pins.json` explicitly labels this capture as a diagnostic
baseline from verified failed-CI bytes, **not** prior acceptance. Mismatches
never cause pins to be recomputed or signatures to be changed.

Only in the workflow's disposable Intel Mac environment:

```sh
export CREATOR_MACOS_DMG_EXPERIMENT=1 CREATOR_MACOS_DMG_REPACK=1
# GH_TOKEN is the workflow's short-lived read-only github.token, not a private key.
temp=$(/usr/bin/python3 -c 'import os; print(os.path.realpath(os.environ["RUNNER_TEMP"]))')
node scripts/macos-dmg-repack.cjs --target macos-intel --output "$temp/macos-dmg-repack"
```

The output must be new, canonical and under `RUNNER_TEMP`; source/run/hash
override arguments are not accepted. Local/self-hosted/non-Mac/ARM invocations
refuse before input inspection. Native dependencies are existing runner tools:
`gh`, Python stdlib, BSD tar, `plutil`, `codesign`, `ditto` and `hdiutil`.

The new DMG is independently mounted read-only/nobrowse/noautoopen through the
existing Unix package extractor. Its copied app must match the original whole
inventory, Hub checksum, exact manifest and module resources and pass codesign
verification, with normal owned-mount detach exit zero. No force/retry/UI action
or process signal is used. Wrapper synchronous tools have file-backed logs and
no hidden Node timeout/maxBuffer termination; the disposable 20-minute job
lifetime bounds hangs. Source before-images and original ZIP/TAR hashes are
rechecked even after failure. Preservation or detach failures override a pass.

All input bytes, partial/new images, hidden worker logs and failure reports are
retained only beneath the new output scope and uploaded as a diagnostic artifact.
`releaseReady`, `productAccepted`, `sourcePackageAdmitted`, `nativeGuiAccepted`,
`managedGuiAccepted`, `migrationAccepted` and `updateAccepted` stay false even
when the container checks pass. Original failure evidence remains unchanged.
Actual native headless repack proof is still pending the dedicated workflow run.

## Main's API

Exports:

- `assertNativeRunner(experimental, context = {})`: no filesystem/tool access;
  validates explicit native disposable-runner opt-in.
- `appInventory(absoluteApp, { uid } = {})`: pure bounded file inventory, available
  for caller before-images and unit fixtures. It does not authenticate a build.
- `await createDmg(options)`: production entry point. Use the default context;
  injected `execute`/platform/UID contexts are pure unit fixtures, not native proof.

Required native context: macOS, Node x64/arm64, `GITHUB_ACTIONS=true`,
`RUNNER_ENVIRONMENT=github-hosted`, `RUNNER_OS=macOS`, matching `RUNNER_ARCH`,
`CREATOR_MACOS_DMG_EXPERIMENT=1`, and `experimental: true`. Local/self-hosted or
other-platform creation refuses before input inspection. Apple/Tauri automatic
signing credential environments and `DYLD_*`/`DITTO*` overrides refuse; values
are never logged or inspected as files. No credentials/private keys are needed.
This environment gate is a test restriction, not runner authentication.

Inside Main's async job/wrapper (the helper has no standalone CLI):

```js
const { createDmg } = require('./scripts/macos-dmg.cjs');
const receipt = await createDmg({
  experimental: true,
  mcpMode: 'read-only', // writable mode is refused by this worker
  sourceApp: verifiedSignedAppAbsolutePath,
  destination: freshAbsoluteDmgPath,
  metadataNeverIndex: false,
  dataScope: {
    root: approvedImmutableCandidateInputRoot,
    manifestFile: originalBuiltinManifestAbsolutePath,
    manifestSha256: originalDescriptorChecksum,
    hubSha256: originalAlreadySignedAppHubChecksum,
    appTreeSha256: reviewedSignedAppInventoryChecksum,
    preservedFiles: originalCoreMacDataManifestFiles,
    // [{ path: exactAbsoluteRootOrModuleFile, sha256: ORIGINAL_CHECKSUM }, ...]
  },
});
```

All source paths must be existing, absolute, canonical, owned by the current UID,
and unredirected. App and descriptor must be strictly within `dataScope.root`.
Only declared app/descriptor/protected files are inspected; the helper does not
scan the rest of that root. Use approved candidate inputs, never HOME, keys,
accounts, a live app, or an arbitrary workspace as the input scope.

`preservedFiles` accepts at most 16 exact regular code/data file paths within the
scope, with old SHA256 pins. Main should pass its original Root/H/S/module/Node
before-images from `coreMacDataManifest` here and keep its existing root checks.
Undeclared files are neither read nor written and are not claimed as verified.
The `hubSha256` is the **signed app's** `Contents/MacOS/creator-hub`, not its
possibly different unsigned pre-Tauri image. Never recompute old checksums after
a mismatch to make the attempt pass.

The app-tree pin should be captured by Main from the independently verified
signed archive before this attempt; `appInventory(...).sha256` is the tree-hash
format. It is not the archive SHA256. The worker compares that pin and a second
whole-tree inventory before/after processing. Descriptors are read as exact
original bytes, matched to the caller checksum, parsed, and required to occur
unchanged in the pinned signed Hub image. Current `unix-package-payload.cjs`
`verifyResources`/`build-unified.cjs` checks enforce the exact module inventory,
compiled Node/backend hashes, and executable modes. No manifest is rewritten.

Destination parent must already exist as an owned canonical directory beneath
canonical `RUNNER_TEMP`, **outside** immutable inputs. The destination must be
new and end in `.dmg`; existing files, including symlinks, refuse. Source modes,
bytes and symlink targets must be safe and stable. Absolute/escaping/dangling
app symlinks, hardlinks, special files, foreign owners and special permission
bits refuse. Relative internal framework links can be preserved. Inventories
are bounded to 20,000 entries, depth 64, 512 MiB per file and 4 GiB total app
bytes; descriptor/Hub/DMG file proofs also use the 512 MiB file bound.

## Native Operations

The helper creates one new private `.creator-hub-dmg-*` work directory beside
the destination. Its staging root contains only the signed app, an exact
`Applications -> /Applications` drop link, and optionally an empty sibling
`.metadata_never_index`. That marker is never written inside the sealed app and
does not change global Spotlight settings.

Only these fixed system tools run, with a narrow noncredential environment:

```text
/usr/bin/codesign --verify --deep --strict SOURCE_APP
/usr/bin/ditto --rsrc --extattr --acl SOURCE_APP STAGED_APP
/usr/bin/codesign --verify --deep --strict STAGED_APP
/usr/bin/hdiutil create -srcfolder STAGING -volname PRODUCT -fs HFS+ -format UDZO -o WORKING_IMAGE
/usr/bin/hdiutil verify WORKING_IMAGE
/usr/bin/codesign --verify --deep --strict STAGED_APP
```

No signing, recompilation, layout, explicit attach/detach, force/overwrite flags,
process signals, security settings, or source permission repairs occur. Ditto
preserves Mac metadata; the inventory explicitly compares file bytes/modes and
link targets, not every ACL/xattr. Source identity metadata is also rechecked.
This is bounded evidence in a caller-owned disposable filesystem, not a lock
against a concurrent malicious filesystem writer. `hdiutil create` may use
internal working mounts; the helper never forcibly cleans them up.

The complete staged bundle must match the original tree before/after image
creation and final verification. Source/descriptor/protected-file preservation
failures override apparent success and retain the original failure. Only after
successful checks is the working image copied with `COPYFILE_EXCL` to the final
destination, with size/hash comparison; a competing destination is not replaced.

Per-tool file-backed stdout/stderr, the original source inventory, partial
working image/staging, and `report.json` are retained in the work directory.
No directory or file is deleted, including on failure. Rejections after work
creation throw an error with `reportFile`; invalid-scope/runner errors occur
before work creation and must be retained in Main's job logs.

Tools have bounded wait deadlines, **without kill/terminate/retry**. A deadline
records `toolMayStillRun=true` and the owned tool PID, unrefs it, fails the call,
and retains evidence. Main must stop that job's packaging path and rely on
disposable runner lifetime teardown, not continue or upload a growing partial
image as a successful package. Main owns workflow cleanup/artifact retention.

Successful creation/`hdiutil verify` does not prove mounted filesystem contents,
notarization, Gatekeeper, installer behavior, native GUI, ownership, preferences,
hosting or migration acceptance. Main must still run existing native package
extraction/resource/codesign checks and product acceptance. Do not dispatch,
sign or publish based on this helper's receipt.

## Primary Contracts And Tests

The installed Tauri CLI pin is `2.11.4`. Its pinned
[DMG bundler](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/macos/dmg/mod.rs)
invokes the retained script with layout arguments; its
[bundle_dmg source](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/macos/dmg/bundle_dmg)
contains the hdiutil/Finder/layout path and UDZO default. These sources do not
identify the process holding disk2 in the failed job.

Apple's [packaging guidance](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)
describes a source directory populated with `ditto` and `hdiutil create
-srcFolder ... -o ...`. This worker uses that headless shape, not the article's
subsequent signing/notarization steps. On the disposable Mac runner, retain
`/usr/bin/hdiutil create -help`, `/usr/bin/hdiutil verify -help`, and
`/usr/bin/ditto --help` with the repack evidence for the actual installed tool
contract. No Mac toolchain was installed or run on the local Windows PC.

```sh
npm ci
node --test scripts/macos-dmg.test.cjs scripts/unix-package-payload.test.cjs scripts/macos-signing.test.cjs
```

Local Windows result: 18 worker tests passed; combined 35 tests, 34 passed and
one existing Unix-mode-only skip. Tool execution and Windows drop-link semantics
are injected pure fixtures (`nativeToolsUsed=false`). These are not native Mac
or DMG tests. The wrapper adds eight focused tests (26 wrapper/worker tests total)
covering bindings/admission, strict real-parser archive fixtures and independent
payload drift. Original ZIP bytes were fetched only into memory for bounded
hash/header inspection; no original app was unpacked or operated on locally.
No failed artifact was changed or relabeled; the first actual headless repack
remains Main's disposable native check.

The wrapper follows GitHub's primary
[artifact metadata/download API](https://docs.github.com/en/rest/actions/artifacts?apiVersion=2022-11-28)
and Python's standard [ZIP](https://docs.python.org/3.12/library/zipfile.html)
and [TAR parsers](https://docs.python.org/3.12/library/tarfile.html); extension
and link refusal is deliberately stricter than generic archive extraction.
