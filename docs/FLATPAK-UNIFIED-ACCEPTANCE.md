# Unified Linux And Flatpak Acceptance

## 18 October Host Helper Decision

The user approved a one-time native host-helper installation, with one visible
Hub window. Linux remains held until native and Flatpak install, migration,
signed update and restart pass together. Windows assets and installations must
remain unchanged. The older offline fixtures below are not production support.

The implementation direction is a sandboxed Hub presentation and a native Core
using the existing host XDG stores, typed Hub handlers, signed module routing,
backup checks and consent. A narrow session-service bootstrap may start only
the known Core/GUI pair; it must accept no paths, commands or settings data.
Do not grant general home access or host command execution to the Flatpak UI.
Core must admit the actual owned GUI image and deployment before exposing any
operation. A version mismatch or lost channel must not reset settings or retry
an operation whose outcome is unknown.

Current progress, not release acceptance:

- Installed fixed-echo lifecycle run `39115354308` at `dd57bb9` passed four tests
  and preserved all four isolated settings sentinels at ten checkpoints.
  [Receipt](evidence/flatpak-installed-lifecycle-39115354308.json). This does not
  authenticate the actual Hub GUI or expose any host operations.
- `src-tauri/src/flatpak_rpc.rs` adds an explicit typed route for all 36 active
  shell commands and six existing event names. It calls existing handlers, not
  a reflective shell/file API. Six local tests and strict Clippy pass; the full
  local Root suite passes 364 tests, with 13 existing explicit tests ignored.
  The module is inactive in production builds and is not a transport authority.
- Real GUI admission, bootstrap installation, event/command wiring, native
  settings retention, paired update/restart and full product operation are
  still pending. Keep their acceptance flags false until actual tests pass.

Audit: 2026-10-14, Hub 0.1.14; checkout HEAD
`cc2c2836da79afb9ef4a02ebbdcd47ab502a295d`, with concurrent uncommitted
coordinator changes. This is a source/fixture audit, not a frozen payload binding.
The initial audit was read-only. Subsequent disposable packaging and native
Root GUI results are separately bound below; none ran on the user's PC or read
real credentials/projects. All readiness and migration acceptance remain false.

2026-10-15 packaging correction: the historical three-input writable replacement
plan is no longer executable by the current seven-file packager. A read-only
`node scripts/flatpak-replacement-source.cjs --preflight` now refuses it with
`ERR_FLATPAK_RAW_ROUTER_PIN_REQUIRED`, before artifact API calls/downloads,
runner-temp access or staging writes. The Flatpak package workflow runs this
check immediately after checkout, using existing Node, before Node/Rust setup,
`npm ci`, native helper compilation or Flatpak provisioning. Both inputs are
checked before either is used; direct download/staging entrypoints recheck too.
This is an early refusal, not repaired packaging or host acceptance. Original
historical pins, assembly identities, receipts and results below are unchanged;
no fourth raw-router pin is inferred or added to those old assemblies.
Focused local verification: replacement-source regressions pass 14/14; the
replacement-source, package, retention and seeded-run fixture files together
pass 72 tests with one existing Linux-only mode test skipped on Windows.
Node syntax, workflow YAML/order and its unchanged embedded Python parse pass.
The actual local read-only CLI exits 1 with the expected refusal. No native
build, product download, dispatch, signature, deployment or commit occurred.

## Findings And Classification

| Classification | Current evidence | Consequence |
| --- | --- | --- |
| Correct as-is | `scripts/build-unified.cjs:97-112` defines `copy` before `executable`, but invokes it only after the same-scope `const executable` is initialized. `scripts/unix-managed-payload.test.cjs` executes this preparation branch with mocked native tools on Linux x86_64/aarch64 and both Mac architectures. | No unbound reference or temporal-dead-zone failure; no builder patch warranted. Passing a synthetic fixture is not a fresh native Rust payload. |
| Correct as-is | `scripts/unix-managed-payload.cjs` requires clean, source/run-bound disposable native preparation; it emits unsigned inputs, not Hub/signing authority/acceptance. `scripts/assemble-unix-payload.cjs` verifies the signed handoff and private-source equivalence before building the outer Hub. | Preserve these gates. Do not relabel stale artifacts as current 0.1.14. |
| Confirmed incompatible with a Flatpak acceptance claim | `scripts/native-unix-hosted-acceptance.cjs:35` and `scripts/native-unix-window.py:ensure_runner` explicitly refuse Flatpak. `scripts/native-builtin-smoke.cjs` requires Windows and WebView2 CDP. | None is an existing full Flatpak or native Linux built-in migration driver. These refusals are intentional, not defects. |
| Confirmed missing integration | `native/mcp-router/src/lib.rs:Store::installed`, `src-tauri/src/builtin.rs:generations`, and MCP settings derive XDG locations. Flatpak redirects XDG config/data to its own app-private directories. | An unchanged sandbox build would select different product/route stores; it cannot claim retention of the native host stores. |
| Confirmed missing integration | MCP `hosted_unix.rs:parent_host` requires private inherited FIFOs and the direct Creator Hub parent; `hosted.rs:run` locks the parent image. Unix writable admission also requires a signed managed route and current settings ownership. | A D-Bus proxy, `flatpak-spawn`, environment flag or copied receipt does not satisfy the existing hosting contract. |
| Likely wrong, not runtime-proven | Repacking Ubuntu-built GUI/backend ELFs into an unrelated GNOME runtime, or executing a Flatpak-built backend on the host. | ELF dependencies, symbol versions, WebKitGTK, resources and execution policy require actual tests on each side; file hashes alone do not establish ABI compatibility. |
| Confirmed native Root component only | Exact installed 0.1.14 DEB, Root/WebKit ownership, native terms acceptance/save, nonblank window-only capture and parent-reaped normal Root exit pass in `38639742819`. | See Native Root Terms Checkpoint below. No module, MCP connection, migration or Flatpak GUI acceptance follows. |
| Unknown / needs capture | Actual built-in module operations, writable migration, product-settings retention/reconnect, Wayland, and Flatpak caller/portal admission. | Keep native Linux, component fixtures and Flatpak acceptance separate. |

Flatpak's app-private XDG locations are documented in
[Flatpak conventions](https://docs.flatpak.org/en/latest/conventions.html).
Native defaults below mean independently derived host XDG directories, not
hardcoded paths when a user has configured other XDG roots.

## Implemented Offline Recipe

`packaging/flatpak/com.creatorworks.hub.json` is an actual local-directory
`flatpak-builder` recipe, not a Flathub submission or production migration
package. Its ref is `app/com.creatorworks.hub/x86_64/flatpak-test`, command
`creator-hub`, Platform/SDK `org.gnome.Platform`/`org.gnome.Sdk`, branch `50`.
Branch 50 is a candidate informed by GNOME's
[build-output documentation](https://gnome.pages.gitlab.gnome.org/gnome-build-meta/docs/ci-outputs.html),
not an ABI, availability or lifetime acceptance claim. The experiment records
the actual installed Platform/SDK commits; unavailable refs block it.

Only four static grants exist: `--socket=wayland`, `--socket=fallback-x11`,
`--device=dri`, `--share=ipc`. There is **no network, filesystem, broker,
session/system-bus, host-command, devel or extra PID visibility grant**.
The earlier hypothetical broker permission has been removed. No broker exists.
Network omission also excludes catalogue/download/update functionality; this
is intentionally an offline package experiment, not a usable replacement for
all native functionality. See [the permission contract](https://docs.flatpak.org/en/latest/sandbox-permissions.html).

The six base payload destinations are:

```text
/app/bin/creator-hub
/app/lib/Creator Hub/modules.tar.gz
/app/share/applications/com.creatorworks.hub.desktop
/app/share/icons/hicolor/128x128/apps/com.creatorworks.hub.png
/app/share/appdata/com.creatorworks.hub.appdata.xml
/app/share/licenses/com.creatorworks.hub/LICENSE
```

Current read-only packages have exactly these six files. Current writable
managed-routing packages require a seventh, mode 0755:
`/app/libexec/creator-hub-mcp-router`. It comes from the original assembly's
`modules/routing/creator-hub-mcp-router`, with its own independently reviewed
fourth raw-input size/hash pin bound to the managed routing/archive descriptor.
The historical six-file writable packages below remain historical evidence;
their three-input pins are readable, but cannot stage or recheck a current
writable package. See [the seven-file contract](../scripts/flatpak-mcp-stdio.md#package-change).

The sixth file retains Hub's MIT license. The icon is the existing 128px Hub PNG.
Optional `appstream-compose` is false for this private offline experiment; the
unchanged metainfo XML is installed at builder 1.2.2's exact appdata destination.
This does not claim composed catalogue metadata or Flathub acceptance.
The archive stays opaque and unchanged, including Node/backend/router modes,
signed metadata and third-party license files. `strip:false` and
`no-debuginfo:true` avoid rewriting pinned ELFs. A local source, owned state dir,
offline download guard and sandboxed build follow the
[builder reference](https://docs.flatpak.org/en/latest/flatpak-builder-command-reference.html).

The resource destination is grounded in locked `tauri-utils` 2.9.3
`resource_dir_from`, which first tries the executable's existing
`../lib/<package_info.name>` on Linux. Actual Hub resource lookup remains
untested. [Tauri's guide](https://v2.tauri.app/distribute/flatpak/) supports this
packaging pattern, not ABI compatibility with this Ubuntu-built payload. Do not
copy host `.so` files, disable WebKit's sandbox or broaden permissions to conceal
a missing-library or renderer failure.

## Scripts And Proof Boundaries

`scripts/flatpak-package.cjs INPUT REVIEWED_PINS NEW_STAGE` reads exactly
`creator-hub`, `modules.tar.gz`, `builtin-manifest.json` from a verified outer
assembly for read-only inputs; writable managed-routing inputs additionally
require the separately pinned raw router at the fixed original path above.
It checks external byte/size pins, ELF64/x86_64 identity, exact embedded
descriptor bytes, known MCP 2.7.7/Setup 0.3.7 file maps, optional exact managed
routing map, archive binding and before/after input snapshots. It publishes a
new six-file read-only or seven-file writable stage; existing destinations, redirections, hard-linked inputs,
changed bytes and extra staged files refuse. It neither extracts nor executes
payloads. `archiveMembersVerified` stays false at this stage.

The pin schema deliberately includes source commit/tree, assembly run/attempt,
input artifact digest, Hub version and producer mode. **Pins are caller-reviewed
data, not a self-authenticating build receipt.** This lane does not independently
query GitHub, verify the artifact download, authenticate a source tree, or verify
routing signatures. Main must first bind the exact successful assembly artifact
and source, then supply independent expected pins. Never derive authorization
from arbitrary downloaded files or relabel 0.1.12/0.1.13 as 0.1.14.

`scripts/flatpak-disposable.cjs STAGE DECODER DECODER_SHA256 [SECOND_STAGE]`
requires native Linux x64, explicitly opted-in GitHub-hosted execution in the
exact repository, and no Flatpak/runtime-injection context. Its fresh
`RUNNER_TEMP/creator-flatpak-*` contains a separate HOME, XDG config/data/cache/
runtime, temp, empty GnuPG dir and `FLATPAK_USER_DIR`. Child environment is a
finite allowlist, not inherited auth, user configuration or injection variables.
The system Platform/SDK are inspected read-only; they must already exist.

The runner verifies members with the rechecked pinned shared native archive decoder,
builds/export locally with `--sandbox --disable-download`, compares packaged
and deployed bytes/executable modes for the six base files (also allowing the corresponding
write-bit-removed modes), rejects unexpected grants, creates a real unsigned
`.flatpak`, and installs only the exact test ref in the isolated user store.
It probes `/usr/bin/ldd` inside the **Platform** sandbox with `flatpak run
--sandbox --command=sh`; it does not use the SDK build shell as runtime proof.
The separate retention read uses **normal app-sandbox semantics**, not the extra
`--sandbox` restriction that intentionally omits app-private bindings. Before
and after that read, the runner rechecks the exact installed ref/commit/location,
manifest identity and four grants, effective permissions including overrides,
Platform commit, six deployed files and owned fixture bytes. Unknown bus/env/
filesystem/network grants refuse. This is grounded in Flatpak 1.12.7's
[effective-permission implementation](https://github.com/flatpak/flatpak/blob/1.12.7/app/flatpak-builtins-info.c#L380).
Only the command is overridden: a static shell prints the mapped
`XDG_CONFIG_HOME`, then `/usr/bin/sha256sum` reads the fixed fixture filename.
Both output lines must match the independently derived owned app-private path
and original hash. The existing 30-second/8,192-byte read bounds remain unchanged.
No permission, recipe, payload or child-environment broadening is included.
It never launches Hub, either GUI backend, Node or the router.
Its `verifyFiles` does not check the seventh libexec router. The separate seeded
stdio lane uses `verifySeven` for that additional deployed-byte/mode check;
neither lane establishes native host routing or settings retention.

With a second separately verified stage, it requires different Hub bytes and
deployment commit, performs an exact-ref local repository update, rechecks bytes,
and checks a synthetic app-private config fixture through both the host's owned
temp path and the sandbox's actual XDG config view. This proves only private
package replacement/fixture retention, **not native settings retention, approved
Hub updater/restart, legacy coexistence, or migration**. It does not uninstall,
kill processes or remove partial evidence. Failure reports preserve command
status/signal/error, elapsed time, stdout/stderr byte counts/hashes and bounded
failure tails. Artifact output and private stores remain for capture.

Even `suitePassed:true` cannot change these fields: `nativeLinuxAccepted`,
`flatpakGuiAccepted`, `hostIntegrationAccepted`, `mcpAccepted`,
`migrationAccepted`, `signedUpdateAccepted`, `releaseReady` are always false.
`signedRoutingVerifiedByThisLane` and `updateReady` are false. Linker success is not WebKit rendering,
resource lookup, backend ABI, portal consent or host MCP acceptance.

## Historical Disposable Invocation (Currently Blocked)

The three-input writable template and commands in this section are retained as
historical planning context, not a runnable current writable recipe. Run the
read-only `node scripts/flatpak-replacement-source.cjs --preflight` before any
downloads or dependency provisioning; the unchanged historical plan must exit 1
with `ERR_FLATPAK_RAW_ROUTER_PIN_REQUIRED: baseline`. Do not add a guessed fourth
pin, relabel an old assembly, or bypass that refusal.

Main owns the workflow, verified artifact staging and public dependency setup.
Nothing below is to run on the user's PC. Use a native hosted Linux x64 runner
with Node 22+ and the repository's Rust toolchain. The bounded public bootstrap
is based on [Flatpak's first-build guide](https://docs.flatpak.org/en/latest/first-build.html):

```sh
sudo apt-get update
sudo apt-get install -y --no-install-recommends flatpak flatpak-builder appstream desktop-file-utils
sudo flatpak remote-add --system --if-not-exists flathub https://dl.flathub.org/repo/flathub.flatpakrepo
sudo flatpak install --system --noninteractive --assumeyes --no-related flathub org.gnome.Platform/x86_64/50 org.gnome.Sdk/x86_64/50
```

This provisions only public runtime/build dependencies on that disposable host,
not signing keys or product/user configs. Retain bootstrap errors if refs,
namespaces or packages are unavailable; do not substitute another runtime or
turn off sandboxing without a separately reviewed experiment.

Place independent reviewed pins in `$RUNNER_TEMP/reviewed-flatpak-pins.json`:

```json
{
  "schemaVersion": 1,
  "version": "0.1.14",
  "platform": "linux",
  "arch": "x86_64",
  "mcpMode": "writable",
  "sourceCommit": "ASSEMBLY_COMMIT_40_HEX",
  "sourceTree": "ASSEMBLY_TREE_40_HEX",
  "runId": 38607998719,
  "runAttempt": 1,
  "inputArtifactSha256": "VERIFIED_ORIGINAL_ARTIFACT_DIGEST_64_HEX",
  "files": {
    "creator-hub": { "size": 0, "sha256": "REVIEWED_HUB_HASH_64_HEX" },
    "builtin-manifest.json": { "size": 0, "sha256": "REVIEWED_DESCRIPTOR_HASH_64_HEX" },
    "modules.tar.gz": { "size": 0, "sha256": "REVIEWED_ARCHIVE_HASH_64_HEX" }
  }
}
```

This template is deliberately invalid until all placeholders, sizes and actual
run attempt are reviewed. Run `38607998719`/short source `7eb00ad` passing was
reported by main, not independently verified by this packaging task. The local
checkout currently has no `artifacts/unified/ci-signed-unix-hub` to stage. Its
Linux assembly has no installer; that is acceptable for this experiment.

```sh
node --test scripts/flatpak-package.test.cjs
INPUT="$GITHUB_WORKSPACE/artifacts/unified/ci-signed-unix-hub"
STAGE="$RUNNER_TEMP/flatpak-stage"
node scripts/flatpak-package.cjs "$INPUT" "$RUNNER_TEMP/reviewed-flatpak-pins.json" "$STAGE"
cargo build --locked --release --manifest-path native/module-archive/Cargo.toml --target-dir "$RUNNER_TEMP/flatpak-decoder-target"
DECODER="$RUNNER_TEMP/flatpak-decoder-target/release/creator-hub-module-archive"
DECODER_SHA256="$(sha256sum "$DECODER" | cut -d ' ' -f1)"
CREATOR_FLATPAK_PACKAGE_TEST=1 node scripts/flatpak-disposable.cjs "$STAGE" "$DECODER" "$DECODER_SHA256"
```

The decoder hash above is computed only for a tool freshly compiled from the
trusted consumer checkout with its locked dependency graph, not an arbitrary
downloaded executable. Alternatively use an independently pinned decoder from
the verified assembly. Keep the consumer source identity with the report.
For a second verified outer build, stage it in a different fresh directory with
its own reviewed pins, then append that directory as `SECOND_STAGE` to the
disposable command. One input cannot prove an update by rebuilding unchanged
bytes. Capture `creator-flatpak-*/flatpak-report.json`, `.flatpak` bundles, local
repository, build dirs and resolved `/app/manifest.json` even when linkage fails.

`FLATPAK_USER_DIR`, exact-ref operations and the bundle interface are documented
in the [Flatpak command reference](https://docs.flatpak.org/en/latest/flatpak-command-reference.html).
The test remote is unsigned and private, not a publication or update trust model.

`validatePins` and `verifyRemoteInput` retain historical schema/provenance reading;
those lower-level checks are not execution eligibility or staging authority.

## Same-Version Replacement Input Plan

`packaging/flatpak/replacement-014-inputs.json` proposes independently reviewed
baseline/replacement pins for **older actual 0.1.14 -> current actual 0.1.14**.
It is not a 0.1.15 fixture or signed in-app update. The JSON is planning data,
not self-authenticating authorization: main must recheck primary run/source/job/
artifact identity, ZIP bytes and exact receipt bodies before using either stage.

The [older assembly run 38481240964](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38481240964)
succeeded, attempt 1, Linux assembly job `115584153665`, source
`216273ac80d1674ef5986f2d60b2650b33f48544`, tree
`6a99de4973f05dbe767cbadf4cc20c15a16995e4`. Its source `package.json` and
`src-tauri/tauri.conf.json` both say `0.1.14`; native build logs agree. Original
artifact `11857940858`, `signed-unix-hub-linux-38481240964-1`, is 119,406,235
bytes; downloaded ZIP SHA-256 matches primary API digest
`8c433ed0501512ef90f027b500a71530c16043686b49501e8582e98ea7eca141`.
The byte-bound 875-byte assembly receipt says `hubVersion=0.1.14`,
`mcpMode=writable`, exact assembly commit, private producer run `38478429870`,
and no native GUI/release acceptance. Receipt SHA-256 and all three payload
byte/size pins are in the reviewed pair file. Nothing was rebuilt or relabeled.

The [current assembly run 38607998719](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38607998719)
and artifact `11916403015` were independently rechecked and downloaded again:
119,481,169 bytes, SHA-256
`e875b1cd071a42f9c264295b05425708df2e0d4574aa0d88e9136e919ce6f780`.
Its exact source versions and receipt also say writable `0.1.14`. Actual Hub
ELFs differ: old 21,038,512 bytes / `e20d2ef60514b6eb3db4e561846336f59223dcc365c80865eab010a4f5cb4bff`;
current 21,352,568 bytes / `1ba7eabe233e9cce35b480b8651abb8b0496a519e55e13613b67720b406e54d9`.
Both pass ELF64/x86_64 shape and exact embedded descriptor checks. Their known
module/routing maps and outer archive bindings validate; archive member proof
remains the disposable native decoder's job, not a staging claim.

Two real source stages were prepared without executing either ELF:
`artifacts/flatpak-replacement-38481240964/stage-baseline` and `stage-current`.
Original ZIPs, three-file inputs and original assembly receipts remain alongside
them. The pair's regression checks exact source/artifact/Hub identities, equal
real version 14, writable mode, different payload hashes and false acceptance.
It is source/template proof, not installed replacement or retention acceptance.

After independently verifying both inputs, main can extract each `pins` object
into its separately named reviewed pin file and stage in fresh runner directories:

```sh
node scripts/flatpak-package.cjs "$BASELINE_INPUT" "$BASELINE_PINS" "$BASELINE_STAGE"
node scripts/flatpak-package.cjs "$CURRENT_INPUT" "$CURRENT_PINS" "$CURRENT_STAGE"
CREATOR_FLATPAK_PACKAGE_TEST=1 node scripts/flatpak-disposable.cjs "$BASELINE_STAGE" "$DECODER" "$DECODER_SHA256" "$CURRENT_STAGE"
```

The intended evidence is a different deployed OSTree commit, exact current
payload bytes and preservation of a synthetic app-private config fixture.
[Flatpak's update contract](https://docs.flatpak.org/en/latest/flatpak-command-reference.html#flatpak-update)
addresses the exact ref/commit, not a fabricated Hub version increment.
Run `38619251453` below proves that the former extra-restricted retention probe
omitted app-private data. The reviewed continuation now uses the normal app
sandbox only for that bounded read, after installed/effective permission checks;
the linker remains extra-restricted. The captured failure stays immutable.
Normal-context private-fixture retention and both static linkage probes now pass
in run `38624468436`, recorded below. This is not real product-settings retention
or GUI/backend execution acceptance.
No native Hub/backend launch, settings migration, host MCP broker, signed update
or `updateReady` acceptance is supplied.

## Historical Two-Input Workflow

At the original six-file checkpoint, `scripts/flatpak-replacement-source.cjs`
and the Flatpak-only workflow verified both reviewed assemblies before staging.
Each must have the exact successful
run/attempt, repository, workflow, source SHA/tree, unique successful Linux
assembly job, artifact ID/name/size/digest and original ZIP bytes. Both original
source `package.json` and `src-tauri/tauri.conf.json` are fetched at that exact
commit and independently checked as Root `0.1.14`, before either ZIP download.
The extractor reads only the three exact payload files and the original assembly
receipt, with expected size/hash, duplicate-name, entry-count, type and encryption
guards. The receipt is separately byte-pinned and checked against those source
bindings, real version 14, Linux x86_64, writable mode and false acceptance.

Both unchanged inputs are staged, not recompiled. The native runner requires
the exact reviewed baseline/replacement provenance and original receipt bytes,
then installs older 14 and replaces its exact ref with current 14. Different
Hub bytes and deployment commits are required; before/after normal-context
reads must preserve the same synthetic app-private config. Its report scope is
`same-version-flatpak-package-replacement-only`. Partial failures remain failed,
with owned stores/bundles preserved; no uninstall or global process operation.

The workflow retains both original ZIPs, API/source bindings, reviewed pins,
original assembly receipts (source and stage copies), reviewed pair document,
both generated bundles, resolved metadata and the actual report. No signing key,
app bytes, public release, runtime branch, recipe permission or timeout changed.
The archive decoder alone is freshly compiled from the consumer source.

Local source verification: 36 focused tests pass. The regression includes the
captured 115-byte `--sandbox` failure and refuses even a matching hash read from
the host XDG directory rather than the app-private directory. Mocked API tests
refuse source/version/tree/job/artifact/receipt mismatches and cover Octokit
Buffer/ArrayBuffer responses. Both actual retained 875-byte receipts and existing
source stages also pass the new byte/source/version/mode checks locally. The
workflow's exact extraction block passes Python syntax validation.

The initial implementation checkpoint had no normal-context native result.
Main subsequently reviewed and committed exactly the eight scoped Flatpak paths
as `9d015402bbbcb9b6c584cedd88815a4867d7739a` on
`validation/flatpak-package-014`. Run `38624468436` is independently bound to
that exact source; its actual result is below. Former failed reports remain
immutable, rather than being relabeled by this later pass.

## Current Results And Stop Conditions

- Windows source/temp-fixture tests: 36 passed, zero skipped, no native app children.
- Related archive/package source suites: combined 55 passed, one existing Unix
  mode test skipped on Windows; no native Linux/Flatpak execution implied.
- Local Windows runner inventory: no `flatpak`, `flatpak-builder`, Docker or
  Podman. Actual native execution below occurred only on the source-bound
  disposable hosted runner. User WSL/SSH or user Flatpak provisioning is excluded.
- Actual disposable run `38612495075` reached Flatpak 1.12.7/builder 1.2.2,
  resolved GNOME 50 Platform/SDK commits and verified the native archive. Its six
  install commands passed; cleanup then exited 1 in 1,425 ms because the SDK
  sandbox lacked `appstream-compose`. Stdout/stderr were 1,235/132 bytes. No
  bundle, app installation, Platform linkage, renderer or migration was tested.
  Original report: `artifacts/flatpak-package-38612495075/flatpak-package-38612495075-1/creator-flatpak-JCLdAZ/flatpak-report.json`.
  The narrow recipe correction disables only optional composition and retains
  exact XML bytes at the builder's observed appdata path. Primary
  [builder 1.2.2 cleanup source](https://github.com/flatpak/flatpak-builder/blob/1.2.2/src/builder-manifest.c#L2364)
  proves the unconditional relocation and separate optional composition guard.
  The regression failed before the correction and passes afterward. The later
  native build-command success below does not establish full package/linkage
  acceptance; no app rebuild is needed.
- Actual run `38615166143`: `build-0` returned 0 in 5,697 ms, with 1,615 stdout
  bytes and no stderr. Our post-build verifier then falsely rejected generated
  `sockets=x11;wayland;fallback-x11;`. Retained `build-0/metadata` is 195 bytes,
  SHA-256 `5d3028ba3e3a7273d57680b9c8531e17dacb82099d0ba7767941df69b3edd707`.
  `build-0/files/manifest.json` retains the exact four recipe finish arguments
  and the report's Platform/SDK commits. Both are under
  `artifacts/flatpak-package-38615166143/flatpak-package-38615166143-1/creator-flatpak-WG2Pan/`.
  Flatpak 1.12.7's [socket parser](https://github.com/flatpak/flatpak/blob/1.12.7/common/flatpak-context.c#L1002)
  adds the X11 bit for fallback; its [execution contract](https://github.com/flatpak/flatpak/blob/1.12.7/common/flatpak-run.c#L1623)
  still permits X11 only when Wayland is unavailable. The verifier now normalizes
  only the exact three-token `x11`/`wayland`/`fallback-x11` set for comparison,
  retaining the original metadata. Unconditional X11, duplicates and additional
  bus/environment grants still refuse; recipe bytes and permissions are unchanged.
  The hash-pinned capture regression failed before this verifier-only correction
  and passes afterward, including the original three refusal controls. No native
  rerun was started. Packaged-byte verification, bundle/install/update, ABI,
  renderer and host/MCP/migration acceptance remain untested or false.
- Actual [run 38617207622, job 116035251224](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38617207622/job/116035251224),
  source `6b370f1ec0a87c2e75b8eff900f966020e1d8a75`: build, exact packaged/deployed
  byte checks, bundle creation, isolated installation and permission checks
  reached the Platform probe. `platform-linkage-0` exited 0 in 129 ms with 11,429
  stdout bytes and no stderr; stdout SHA-256 is
  `dfc43bd2b4ac88e435e2259415743eb8d187ef489d25c723096045d75b75ea00`.
  **Confirmed broken verifier, not a demonstrated ABI failure:** the substring
  `error` matched the successfully resolved `libgpg-error.so.0`. All 137 retained
  trace rows have success format; there are no missing-library or diagnostic rows.
  GTK3, WebKit4.1, JavaScriptCore4.1 and OpenSSL resolve to the recorded Platform's
  `/usr/lib/x86_64-linux-gnu` paths. The narrow verifier correction accepts only
  resolved-library, vDSO and absolute native-loader success rows, grounded in the
  [glibc trace-output source](https://raw.githubusercontent.com/bminor/glibc/master/elf/rtld.c).
  Unknown rows, actual loader errors, missing libraries/symbol versions, malformed
  rows and missing loader proof refuse. Reports now include bounded selected-library
  paths and diagnostic-row summaries from the same output; no extra command runs.
  The seven-row capture regression (579 bytes, SHA-256
  `abb34ddf5c86516edda132a79d5eb643bb4887528a6c98c68347b7d51f871156`) failed
  before the correction and passes afterward. Offline re-evaluation of the full
  retained trace passes; it does not rewrite the original `suitePassed:false` or
  `runtimeLinkProbePassed:false`. Original report and trace remain at
  `artifacts/flatpak-package-38617207622/flatpak-package-38617207622-1/creator-flatpak-xniNE7/flatpak-report.json`.
  Artifact `11920068187` was independently downloaded and checked: 60,194,476
  bytes, SHA-256 `f84076b60f12abcb0cc45299bf32541d8779369808958e712e6f5dd87337f50c`.
  Its actual `creator-hub-0.flatpak` is 60,177,040 bytes, verified SHA-256
  `fdf6d4bbb03037ac581cc520a99447da4657144f30061208d1c141a81784a7c2`.
  Recipe SHA-256 remains
  `4f900874409f7096705338ad54e635a93d0e9d37029a7a9a95a75eef05ed8fe0`;
  all four grants, three socket-refusal controls, runtime, process environment,
  deadlines and output limits are unchanged. No app rebuild or native rerun was
  performed. Private-fixture probing was not reached; update/replacement, actual
  ELF execution/relocations, GTK/WebKit rendering, resources, backend ABI and
  host/MCP/migration acceptance remain untested or false. This is static outer-Hub
  dependency resolution and package-install evidence only, not full runtime acceptance.
- Actual [run 38619251453, job 116042177053](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38619251453/job/116042177053),
  source `c9c394d39a2d6c115a128be9819d0c509e6ac42a`: build/bundle/install,
  deployed-byte/permission checks and Platform linkage pass. The linker command
  exits 0 in 131 ms, 11,429 stdout bytes, no stderr, 137 recognized rows and no
  diagnostics. The next `private-fixture-0` exits 1 in 114 ms, no stdout, 115
  stderr bytes: `sha256sum` cannot find the owned host `config/retention-fixture.json`.
  **Confirmed broken harness expectation, not demonstrated product/ABI failure:**
  the fixture was written under owned `HOME/.var/app/com.creatorworks.hub/config`,
  but Flatpak 1.12.7 [run source](https://github.com/flatpak/flatpak/blob/1.12.7/common/flatpak-run.c#L3993)
  deliberately leaves `app_id_dir` unset with `--sandbox`; the
  [filesystem/environment contract](https://github.com/flatpak/flatpak/blob/1.12.7/common/flatpak-context.c#L2484)
  only binds/re-writes app-private XDG locations when that directory is supplied.
  A path-only patch cannot validate app-private retention in this context.
  No guard, timeout, environment, runtime, recipe or payload change was made.
  Do not remove `--sandbox`, grant filesystem access or mark the failed probe
  passed to conceal this scope mismatch. A separately reviewed retention probe
  contract is required; app-native GUI controls are a further separate gate.
  Original report/tails remain at
  `artifacts/flatpak-package-38619251453/flatpak-package-38619251453-1/creator-flatpak-qqmjjs/flatpak-report.json`.
  Original artifact `11920967817` is 60,194,486 bytes; downloaded SHA-256
  `40071a6a198192ce0dbfe85bb2f6dcd66888ef362da48436d30f9d92432b30e7`
  matches the primary API. `suitePassed:false`, `runtimeLinkProbePassed:true`,
  `appPrivateFixtureRetained:false`; replacement/GUI/host/MCP/migration remain
  false. No rerun or app rebuild was performed here.
- Actual [run 38624468436/1, job 116059992516](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38624468436/job/116059992516)
  completed **success** at source `9d015402bbbcb9b6c584cedd88815a4867d7739a`,
  source tree `127a53c3b8854407e27c74a60d3303662e16df33`. Steps 6-12 pass:
  contract tests, both independent assembly/source downloads, exact bounded
  extraction, staging/decoder, dependency provisioning, actual replacement/
  private-retention harness and evidence upload. All 47 recorded native commands
  exit 0, with no signal/error code and no stderr. Build 0/1 take 5,288/5,227 ms;
  isolated install/update take 362/365 ms. Both archive-member verifications pass.
  Linkage probes take 135/137 ms, each with 137 recognized rows and zero diagnostics.
  Normal app-private reads take 126/127 ms, each returning 267 stdout bytes and no
  stderr. Both independently checked ref/commit/metadata/effective-permission/
  payload/fixture before and after the read.
  Deployed OSTree commit changes from
  `6474ae07f803a688b86d83dc480d49205c5fad229830605bd8b79bfe8e714429` to
  `32745d5e9f4d01e0c732272b3c02d5d9c11cb462677d5c52c2d0417192464d5c`.
  The actual mapped `HOME/.var/app/com.creatorworks.hub/config` path and synthetic
  fixture SHA-256 `8c51417574244aa107841e1001c85d7f92c1a68780055e370da27fdee1381910`
  stay identical across deployment replacement. Both manifest/effective-permission
  hashes match across states; resolved manifests retain all four exact grants
  and the same recorded Platform/SDK commits. The two original 875-byte receipts
  retain their reviewed hashes, source versions and writable-mode bindings;
  source/stage copies are byte-identical.
  Consumer artifact `11923252154` is 358,586,204 bytes, downloaded and independently
  checked against primary API SHA-256
  `d0826ea15fa19d3d4745aa75f8ae5ef781c082434a008b57e4a97929bac63e46`.
  Both original ZIPs inside it retain their reviewed `8c433ed0...`/`e875b1cd...`
  digests and exact sizes. Actual generated bundle 0: 60,115,384 bytes, SHA-256
  `e5b0ce2c0dfa5b83d9db5943e0cab52d19c2c83279b690cce2522c9388ec3a10`;
  bundle 1: 60,176,800 bytes, SHA-256
  `09582f687b5bc0c84f370f122b949a7adf2112910bd64f23287c205ea66fb976`.
  All four embedded input/bundle hashes were streamed and rechecked locally;
  no package or ELF was executed on the user's PC.
  Report/metadata/bindings/receipts are retained under
  `artifacts/flatpak-package-38624468436/flatpak-package-38624468436-1/`;
  the complete original ZIP retains both bundles and original assembly ZIPs.
  `flatpak-report.json`: 47,303 bytes, SHA-256
  `2b531e19f085377eb28eda25a1d881d2edf5a85566f9a42c6466b2f57344d79b`.
  **Verified scope only:** same-version 0.1.14 package replacement, exact payload
  deployment, static outer-Hub dependency resolution and synthetic app-private
  fixture retention. `suitePassed`, `packageReplacementVerified`,
  `appPrivateFixtureRetained` and `runtimeLinkProbePassed` are true. All GUI,
  native-Linux product, host/MCP, migration, signed/future update and readiness
  fields remain false. No recipe, app bytes, runtime, permissions, environment,
  timeout or production code change followed this result. All original failures
  remain preserved as their actual failed runs.
- Existing inspected Linux package receipts label 0.1.12/0.1.13. They were not
  relabeled. Fresh current14 assembly acceptance is main's independently verified
  prerequisite, not replaced by fixture hashes.

Stop on any pinned-input, decoder, tool, runtime, permission, byte-preservation,
linkage or private-fixture mismatch; preserve the first failure report. No timing,
library-copy, permission or sandbox workaround is included. The two-input package
fixture now has actual bounded native evidence; repeating it unchanged does not
close GUI, host-broker, native settings migration or future public update gaps.
Actual unified native install/update/migration remains a separate gap.

## Host MCP Broker Boundary

Proposed transport: session D-Bus name `com.creatorworks.hub.HostMcp1`, object
`/com/creatorworks/hub/HostMcp1`, interface `com.creatorworks.hub.HostMcp1`.
These names are a design proposal, not implemented interfaces.

1. Install the native, signed host broker/router through a separately reviewed
   native user installation. The Flatpak manifest must not bootstrap arbitrary
   host executables. Missing/unsupported broker means blocked host operations,
   no migration, no fallback to `flatpak-spawn --host` or generic command launch.
2. Start with only `GetStatus` and `InspectMigration`. Return bounded, redacted
   status, stable client IDs and a broker-owned plan ID/digest. Never accept a
   config path, executable, argv, environment, installer URL or script from the
   UI. Even inspection requires narrowly scoped caller admission and must not
   return entire AI configs or secret values.
3. A later `RequestConsent(planId)` uses the native host's own dialog. A separate
   `ApplyMigration(planId, reviewedDigest)` consumes a one-use broker-owned
   approval bound to caller identity, exact before-images, settings ownership
   and selected actions. Neither a frontend boolean nor a journal receipt grants
   authority. Recheck immediately before mutation; changed/missing/foreign
   entries refuse. Recovery is separately inspected and explicitly reviewed.
4. Authenticate the live bus sender, not claimed `FLATPAK_ID`/PID/app ID. D-Bus
   provides connection credentials; libflatpak exposes running app/arch/commit
   and sandbox/main-process PIDs, but warns that lifecycle tracking is racy.
   Require independently trusted deployment/payload binding, UID, live process
   start/image/namespace identity, bounded protocol version and a session nonce.
   Recheck bus owner/process/deployment drift. A nonce or same-UID match alone
   proves neither app ownership nor approval. Actual filtered-bus/proxy-to-app
   credential mapping remains an implementation blocker; do not equate a proxy
   PID or instance-list entry to the UI process.
5. Keep native MCP runtime execution on the host. The host router's normal stdio
   remains the AI client's entrypoint and selects signed host generations.
   Never write `/app/...`, sandbox `/run/user/.../doc/...`, Flatpak-internal Node,
   or a raw mutable legacy Node target into native client routing. GUI closure,
   sandbox exit and Flatpak uninstall must not terminate those server runtimes.
6. Reuse native settings transactions, parser-preserving client adapters and
   signed activation machinery, not generic file RPC. A broker process is not
   the current direct Hub parent; add an explicitly reviewed admission adapter
   rather than weakening checks or renaming an unrelated executable to Hub.
   Host payload dependencies need their own native ABI proof.

The credential primitives are described by the
[D-Bus specification source](https://raw.githubusercontent.com/d-bus/dbus/master/doc/dbus-specification.xml)
and [libflatpak instance API](https://docs.flatpak.org/en/latest/libflatpak-api-reference.html).
They do not establish that a complete secure broker implementation exists here.

Canonical product settings stay host-owned:
`<host config>/creator-works-mcp/launcher-config.json`, with read/review retention
of `<host config>/banter-mcp/launcher-config.json`. Existing `product_settings.rs`
explicitly protects this shared store rather than introducing another Hub copy.
Canonical routes/generations stay under `<host data>/creator-hub`, scoped by
`linux-x86_64` or `linux-aarch64`. Sandbox config/data holds only sandbox UI state;
do not silently import or overwrite the host settings with a sandbox-default copy.
Preserve unknown JSON fields, legacy server folders, projects and exact foreign
client entries. Client paths are derived by host adapters (for example
`~/.claude.json`, `~/.codex/config.toml`, `~/.gemini/config/mcp_config.json`,
`<host config>/opencode/opencode.jsonc`), never selected by RPC. No auth files
are part of this inventory.

Keep Setup host launch/install/restart operations blocked in the first increment.
Current Setup probes host Unity Hub config and launches native tools; these are
not ordinary sandbox reads. A subsequent project operation must use an explicit
host-owned project grant. Document portal `GetHostPaths` exists from interface
version 5, but a returned path is not host write/execution consent. Prove grant
identity, canonical project root, revocation and host/sandbox path equivalence;
otherwise refuse. See the [Documents portal contract](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Documents.html).

### Proposed Read-Only Filtered-Bus Capture

Design only, not implemented or run. The question is which live process the
filtered connection's bus credentials identify, and whether it can be correlated
to the exact owned Flatpak instance. It does not create broker authority.
The [proxy manual](https://raw.githubusercontent.com/flatpak/xdg-dbus-proxy/main/xdg-dbus-proxy.xml)
explicitly says the proxy sends its own credentials during authentication.
Therefore a bus PID is not automatically the UI PID. The
[D-Bus specification](https://raw.githubusercontent.com/d-bus/dbus/master/doc/dbus-specification.xml)
defines `GetConnectionCredentials`, `Hello` and a separate monitor connection;
credentials can be omitted. The
[instance API](https://docs.flatpak.org/en/latest/libflatpak-api-reference.html#flatpak-instance-get-pid)
distinguishes the outer babysitter PID from the application PID and warns that
process lifecycle tracking is racy. These primitives do not prove a secure caller map.

1. Require a separately authorized disposable capture owner and its verified
   Flatpak ref, app/Platform commits, deployment path, payload hashes and effective
   four-grant metadata. That owner supplies the actual Root PID/start/UID/image
   after launch and owns normal close. Use only its private session bus and synthetic
   HOME/XDG. Do not launch/relaunch through a new driver, modify the app command,
   or use the user's desktop bus. Missing expected inputs stop before observation;
   missing live ownership records prevent successful attribution.
2. Before that owner's one launch, open two host-only bus connections: an observer
   and a credential reader. The observer uses `BecomeMonitor(rules, 0)` with only
   these three rules, never an empty rule array or all-bus dump:

   ```text
   type='method_call',destination='org.freedesktop.DBus',path='/org/freedesktop/DBus',interface='org.freedesktop.DBus',member='Hello'
   type='method_return',sender='org.freedesktop.DBus'
   type='signal',sender='org.freedesktop.DBus',path='/org/freedesktop/DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged'
   ```

   Retain headers only, plus the unique-name string from a serial-correlated
   `Hello` reply and lifecycle names for those selected connections. Ignore other
   reply bodies. No app RPC, portal operation, service activation, `RequestName`,
   broker method, consent prompt or sandbox-side helper is introduced.
3. For each selected live unique name, the separate reader calls the bus daemon's
   `GetConnectionCredentials(name)`, with 2-second deadlines and no interactive
   authorization/auto-start. Keep only `UnixUserID`, `ProcessID`, and a hash of
   `LinuxSecurityLabel` when supplied; missing fields remain explicitly missing.
   Recheck the same unique name and credentials before the owner's normal close.
4. Independently recheck the selected libflatpak instance's app/arch/branch/app
   commit/runtime commit and both PIDs. For only the known Root and returned
   credential PID, retain start time, UID tuple, executable hash, PID/mount/user
   namespace identities and a bounded `/proc/PID/root/.flatpak-info` hash plus
   allowlisted identity fields. Classify `credentialRole=app|proxy|unresolved`.
   A shared UID, app ID, instance label, namespace or metadata match alone is
   correlation, not proof of the individual originating UI process.
5. Bound observation to 30 seconds, 32 unique names, 16 KiB per credential reply
   and 64 KiB total report. Reject drift, foreign processes, ambiguous mapping,
   overflow or denied inspection; preserve the original bounded failure. No
   matching live connection is inconclusive, not a reason to retry, inject a call,
   add grants, enable tracing privileges or relax the bus policy.
6. Output only `busPeerObserved`, `credentialRole`, `instanceCorrelation` and
   `mappingUnresolvedReason`, plus bound source/session/process/deployment records.
   `uiCallerAuthenticated`, `hostIntegrationAccepted`, migration/update/readiness
   remain false. If only the proxy can be established, the next review must define
   a separately proven per-connection app-peer binding; this capture cannot admit
   `GetStatus`, `InspectMigration` or any host writer. Settings, projects, routes,
   permissions, services and product bytes are never changed; only owned capture
   evidence may be written by a future authorized harness.

## Reusable Native Linux Route

Use native Linux first; it cannot confer Flatpak acceptance.

| Existing route | Exact useful contract | Limit |
| --- | --- | --- |
| `.github/workflows/unix-managed-payload.yml`, `platform=linux`, Ubuntu 22.04 | `npm run build:unified -- ci-unsigned-unix-payload --managed --experimental-unix --experimental-unix-writable --prepare-managed-unix`; then native `unix-transfer pack/verify`. Produces unsigned modules/router, canonical modes, exact commit/tree/run binding. | No outer Hub, key, GUI or migration acceptance. Push admission is restricted to `validation/unix-payload-014` and the workflow path; source changes alone do not automatically refresh this lane. |
| `.github/workflows/unix-managed-assembly.yml` | Main supplies exact independently reviewed signed input pins; builds the outer Hub plus verification/archive tools, and Linux DEB/RPM/AppImage when `--installer` is selected. The original `5bb05a2` packages are bound below. | Compilation/container verification is not native GUI acceptance. Existing default artifact IDs/hashes are not proof of freshness. |
| `.github/workflows/native-gui-helpers.yml`, Linux job | Existing executable `scripts/native-unix-window.py`: PID/start/image hash + XRes owner + same-PID AT-SPI window; `snapshot`, allowlisted native-dialog `click`, and normal `close`. Sealed backends use live parent/FD/seals identity, not a receipt alone. | Synthetic GTK fixture and kernel/helper primitives only; no real packaged-Hub migration/update driver. Helper normal-close receipts deliberately cannot claim a reaped successful exit. |
| `.github/workflows/native-linux-root-probe-014.yml` | Exact original DEB/source/receipts; actual `dpkg` installation, Root plus one native WebKit child bound by PID/start/UID/image, XRes and canonical AX bus owner/path. Two fixed terms actions, saved acknowledgement and one normal Root close/reap. | Actual native component result `38639742819`, harness `058516d`, product `5bb05a2`. Generic helper/production unchanged. No module/connection/migration acceptance. |
| `.github/workflows/unified-unix-candidate.yml` | Experimental native DEB/RPM/AppImage compilation and payload/container integrity. | Default read-only packaging, not signed writable migration acceptance. |
| `.github/workflows/unix-hosted-acceptance.yml` | Metadata/container prerequisite report from the read-only candidate lane. | Deliberately fails/blocks full acceptance; rejects Flatpak and is not the signed writable carrier consumer. |

The reusable GUI environment is the helper workflow's disposable local X11
session: Python GI/GTK3/AT-SPI, libX11/libXres, D-Bus, Xvfb and Openbox;
`CREATOR_UNIX_WINDOW_TEST=1`, `GDK_BACKEND=x11`, `NO_AT_BRIDGE=0`, private
`XDG_RUNTIME_DIR`, `dbus-run-session -- xvfb-run ...`. Never spoof GitHub runner
admission on the user's PC. Reuse only an explicitly owned session/window.

There is no complete current Linux equivalent of the Windows CDP smoke harness
in the inspected scripts. Main needs a current-payload launcher and bounded Hub
navigation/review driver, plus the existing native helper for dialogs. Current
native helper clicks are limited to the three existing hosted/routing dialogs;
Convergence and product/client review controls require separately reviewed
coverage. No global keyboard/mouse tool, unrestricted AT-SPI traversal, injected
consent or live-client auth is a substitute. Wayland is a separate test route.

Refresh rule after Rust changes: fixture tests rerun current JavaScript, not Rust
compilation. Changes in assembly `PRIVATE_SOURCE_PATHS` (MCP, Setup, router,
shared parent/retirement code, module archive/key) require fresh unsigned native
preparation and reviewed signing. Root-only Rust changes outside that set can
reuse proven equivalent private inputs but still require a fresh outer assembly,
Hub hash/embedded descriptor and actual GUI run. No preparation or assembly was
performed in this audit, and no current native bytes were relabeled.

## Required Acceptance Tests

Run only in an explicitly disposable native Linux/Flatpak account and owned
session; seed synthetic app/client/project fixtures, never real auth. Keep
immutable before-images and report failed cleanup separately from original failure.

| Gate | Smallest exact positive/negative evidence |
| --- | --- |
| Native current14 baseline | Bind source/tree/run/attempt, Hub hash, private input hashes/modes and signed descriptors. Exercise actual Hub terms, Convergence deferral, hosted decline/retry/status/recipe and parent-reaped normal closure. Component scope must report migration skipped, never full flow. |
| Flatpak ABI/resources | Build/export the exact six-file read-only or seven-file writable recipe; retain resolved manifest, app/Platform/SDK commits and arch. Check all applicable deployed files/modes, ELF interpreter/NEEDED/symbol versions, real nonblank WebKit rendering, resource lookup and archive bytes/modes. Repacking alone does not pass. |
| No broker / foreign peer | Missing broker, wrong version/app/deployment, proxy/PID ambiguity, reused PID, changed bus owner, oversized/unknown method/field, replay/expired nonce and arbitrary path/argv/env must refuse without host writes or process launch. |
| No-consent retention | Preview, Later/Keep existing, cancel, read-only launch and failed admission leave exact host/sandbox settings, legacy registrations/desktop files, client entries, projects and active route unchanged, including absence. Run without broad home/host permissions. |
| Reviewed migration | Known exact legacy client entries in JSON/JSONC/TOML convert only after native review; preserve unrelated bytes/options/unknown fields. Current-vs-legacy product conflicts and custom server selection stay explicit. Concurrent standalone owner or changed before-image refuses. |
| Interrupted recovery | Interrupt each staged transaction boundary; inspect partial state and rederive destinations independently. Resume/rollback only exact recognized snapshots; substituted files, journal-selected paths, missing backup or changed namespace refuse. No phantom success. |
| Retained runtime | Existing connection continues on old signed host generation; new connection uses approved new generation. Close sandbox UI, replace/rollback Flatpak, then reconnect actual host stdio command and enumerate tools. Preserve unrelated Node/Unity/client processes; cleanup only exact owned children. |
| Portal / Setup | Explicit owned project grant works with real host and sandbox path identity; revoked/foreign/document-only aliases refuse. Host install/restart and project writes remain blocked until separate consent/dependency/closed-editor proof. |
| Flatpak lifecycle | Fresh install and native-legacy coexistence; update/cancel/rollback/uninstall preserve host runtime/settings/projects and sandbox state unless separately approved data deletion. Flatpak owns outer updates; native Tauri installer/update/removal commands must not operate on the sandbox deployment. |
| Real user workflow | Actual configured host AI connection and Unity workflow remain a separate authorized acceptance gate. Helper events, metadata receipts and SDK fixture connections do not manufacture that proof. |

## Prior Audit Verification

Initial read-only source audit plus disposable fixtures on Windows, 2026-10-14,
before the packaging continuation above. These retain that earlier test scope:

| Command | Result | Scope |
| --- | --- | --- |
| `node --test scripts/unix-managed-payload.test.cjs` | 14 passed | Current `copy`/preparation branch, mocked compiler/tools, owned temporary files. |
| `node --test scripts/build-unified.test.cjs scripts/native-unix-hosted-acceptance.test.cjs` | 58 passed | Modes/bindings/refusals; synthetic package extraction and blocked receipts. |
| `node --test scripts/unix-package-payload.test.cjs` | 15 passed, 1 skipped | Payload/mode/package policy; Unix mode/link test skipped on Windows. |
| `python -B scripts/native-unix-window.test.py` | 36 passed, 2 skipped | Mocked owned-window/identity controls; Linux private receipt/kernel cases not run. |
| `python -B scripts/native-unix-window-fixture.test.py` | 8 passed | Pure driver regressions, no GTK/X11/proc/live-app reads. |

The remaining native Linux follow-up is actual module/connection UI operation,
not another unchanged Root-only capture. It is separate from the disposable
Flatpak package experiment above. Root-only product changes require their own
fresh artifact binding before this evidence can be applied to them. Flatpak remains
blocked on reviewed UI/broker admission, caller mapping, native host packaging,
runtime ABI, portal grant handling and actual sandbox migration/lifecycle tests.
This document does not authorize production changes or publication.

## Native Root Terms Checkpoint

Actual [run 38639742819/1, job 116111923246](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38639742819/job/116111923246)
passes at test commit `058516dfc9e7d12c38c9be039ae52a318e2c512e`.
Scope is exactly `native-deb-root-terms-and-normal-close-only`.
The immutable product remains assembly `38630742955/1`, source
`5bb05a21d73c0fc3b2839cbcbd4322832b24aead`, tree
`f91c61a8e29da84e0dbdbfa642d201cd4c6a3279`, artifact `11927495507`.
This is an actual disposable DEB install, not a manually staged prefix.
No product bytes were rebuilt for these harness corrections.

| Pinned item | Bytes | SHA-256 |
| --- | ---: | --- |
| Original assembly ZIP | 386824719 | `42c5e1a95605158ab084c4cad1db1a6fb5b49f6fe225db9cea868148cccda725` |
| `Creator Hub_0.1.14_amd64.deb` | 62780196 | `f0297e74c6ce918b54c248b222af7ac64c3c96c270d281a17a017fb90a7714ec` |
| Original unbundled Root ELF | 21364752 | `2a09016d9721157afc62ea7163979c75b0c986b05cf0264afda97291b51b3689` |
| Installed `/usr/bin/creator-hub` | 21364752 | `efca8d6ca5949e787f10c124e26b91202587b34803f65c7cc5c3e9ffb93fdbf9` |
| `modules.tar.gz` | 56842646 | `c2cffb6f886225d8c841e78497e92c6ede96896e0c5a28c89346254e5fc4a77a` |
| `builtin-manifest.json` | 3663 | `44de6e0e25890ac2cb20f7f2b16eb3ac151e6b4edb1104c974a9544f291f6fd7` |
| Original assembly receipt | 888 | `a58370b7a92e4e5ab3400be3765ea289a6a52538d3c4bedb9de98e92b01007a0` |
| Native saved acknowledgement | 80 | `b1af0762115111f77c97093da5b7e28f662d3bdec3653c1190ebc958bf8fa9b5` |
| Window-only PNG | 87808 | `0e72d011384bb4ba95ceb4a567097ee3ca64808f30d660d7a8b288fd7956432f` |

The unchanged signed private payload is bound to source
`a3118106086516751b78a58b5dbd684cff4c63a7`, preparation `38621563945/1`,
and handoff `77bf64dcf8c82d4e9ad5e4112445a59639425e6315d4723f910bd8058c9a1a62`.
Writable-mode metadata is not a writable-operation acceptance result.

- Root PID `3404`, start `14007`, direct parent `3386`, all four UIDs `1001`.
  XID `6291459`, XRes client `6291456` belongs to that Root.
- WebKit PID `3435`, start `14131`, direct parent Root `3404`, all UIDs `1001`.
  Its resolved system executable is
  `/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/WebKitWebProcess`, 14408 bytes,
  SHA-256 `5375925828be8acc2c0e905cae0d4654da0519ce1b83f2f724a43eae346bd78e`,
  attributed to `libwebkit2gtk-4.1-0:amd64` `2.50.4-0ubuntu0.22.04.1`.
- Root/renderer kernel identities, UID tuples, XRes ownership and AX bus
  owner/PID/UID/path are rechecked. WebKit's well-known and unique bus aliases
  resolve to the same unique owner; same PID/role alone is insufficient.
- The actual 940x580 Root-only PNG is nonblank and shows the terms modal.
  Acknowledgement is absent before input. Exactly one native `check` and one
  `press` action run (870/906 ms), against the observed exact checkbox/button.
- The product writes schema `1`, policy `2026-09-28-v1`, accepted timestamp
  `1792012999783` to the private runner's
  `XDG_DATA_HOME/CreatorHub/consent/hub-usage-terms.json`. No acknowledgement,
  browser state or IPC response is seeded. The retained 80-byte copy matches
  the actual saved bytes and remains identical after Root exit.
- One normal EWMH close request uses the verified Root window and advertised
  `WM_DELETE_WINDOW` protocol (1186 ms). The parent reaps Root exit `0`;
  stdout/stderr are both zero bytes, EOF true, no truncation. Terms are no longer
  visible. No signal, kill fallback or user/global desktop operation is used.
- Terms actions retain strict reverse-parent checks. WM close instead verifies
  every returned AX parent belongs to the same fully verified Root subtree:
  41 parents, including 30 differing semantic parent edges. Foreign peers,
  outside parents and nested AX windows remain refused. The generic helper is
  unchanged; this is not a same-name or all-child-process exemption.
- Focused suite: 76/76 on Linux; local Windows 75 passed, one POSIX-only skip.
  The unchanged generic-helper suites also passed locally (36+8, two POSIX skips).

Earlier failures remain failures: `38633338721` installer PATH;
`38634063716` strict single-PID AX guard; `38637030998`/`38637638644`
AX reverse-parent refusals; `38638382883`/`38638768876` AX name-bound diagnostics;
`38639092559` terms/save passed but close refused on immediate semantic parents.
The later pass does not relabel these reports.

Result artifact `11929453661`, 386702956 bytes, SHA-256
`5a34844f2341f20d28426bbf279421212e43d5e873a40f8cb97ba7e32d7a0c5f`,
was downloaded, hash-checked and inspected under
`artifacts/native-linux-root-38639742819/linux-root-probe/` (`report.json`,
`native-terms-acknowledgement.json`, `root-window.png`, ownership and worker records).
All original assembly evidence stays in the retained ZIP.
Current harness files match tested `058516d`:

```text
scripts/native-linux-root-probe.py         81e30d24b9a5aa28fb525a8785b949f09f79cdf94d8365171f429f516faf1df7
scripts/native-linux-root-probe.test.py    99d7dfe5a5b65dfcce19fc6b8d34337b9f838c7afc9ed7da1594eb077fcc5730
.github/workflows/native-linux-root-probe-014.yml 431f2a2fd18cbf4224e043a9159038973a1c76e32945f715a6ef29171bc96967
```

This does not cover parent commit `e60db6f5b937ef3036cec8fcf44240ee93787495`
(Linux no-legacy finish/process discovery). Its new Root assembly must receive
independent successful run/package/source pins before any repin. It does not
cover modules, MCP stdio/client connections, product-settings retention,
standalone retirement, migration, outgoing/signed updates or Flatpak GUI/host
operations. All broad acceptance flags, including `releaseReady`, remain false.
Linux retirement/product changes, `linux-deb-retention*` and `flatpak-gui-probe*`
remain separately owned; this checkpoint does not modify or accept them.
