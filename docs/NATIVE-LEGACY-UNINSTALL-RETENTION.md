# Disposable Legacy Uninstall Retention

This fixture installs the exact public Windows MCP 2.7.7 or Setup 0.3.7 installer,
seeds synthetic persistent data, and tests the real generated uninstaller. It
does not build a new product or implement Hub's migration/install coordinator.
`releaseReady`, `productAccepted` and `migrationAccepted` remain false. A passed
retention receipt is not full single-installation-flow acceptance or permission
to uninstall an arbitrary app on the user's PC.

## Pinned Provenance

Primary release metadata, tag references and actual downloaded bytes must all
match; filenames, registry labels and publisher strings alone are not proof.

| Product | Public Source | Release / Asset IDs | Installer Bytes |
| --- | --- | --- | --- |
| MCP 2.7.7 | `9cd12e28d1dd05057b84166d4718a5d6369eff93` | `402569194` / `608030196` | `27059109` |
| Setup 0.3.7 | `4a76945272560f9e0d2b93296a5223bf3e891eb2` | `402568854` / `608029072` | `2961298` |

Exact SHA256 values, independently checked against fetched bytes in memory:

~~~text
MCP:   fa0b0ebc39043bf276de73763d380c001c84d1efd24dca9f9c2427b120a5afe0
Setup: 223bbc00bf7f861efe1760310a4be4cbedfc9829c4d3841fae0a84038bc7e47b
~~~

The source pins and values are enforced against current primary
[MCP release](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/releases/tag/v2.7.7),
[Setup release](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/releases/tag/v0.3.7)
and GitHub's [release asset API](https://docs.github.com/en/rest/releases/assets).
Drafts, prereleases, moved tags, changed asset IDs/URLs/digests/sizes, duplicate
matching assets and a different repository refuse. No source/hash override flag
or private signing credential is admitted.

## Source Contract

The retained MCP Windows acceptance workflow pins Tauri CLI 2.9.6; Setup's lock
pins 2.11.4. The exact CLI used for every published MCP package is not established
by that acceptance workflow alone. Both reviewed
[2.9.6](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.9.6/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)
and [2.11.4](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi)
templates delete bundle-ID app data only when the confirm-page checkbox is
selected. NSIS [silent-mode callbacks](https://nsis.sourceforge.io/Docs/Chapter4.html#silent)
skip page callbacks, so source predicts retention under `/S`; the actual native
fixture must demonstrate it. The pinned Creator hooks replace the default
running-app force-kill path with refusal. Older unreviewed uninstallers are not
covered by these source claims or this finite test.

Source app identities are `com.creatorworks.unitymcp.preview` and
`com.creatorworks.projectsetup`. Current-user installation defaults to
`%LOCALAPPDATA%\Creator Works MCP` / `Creator Project Setup`, with generated
`uninstall.exe` and product-named HKCU uninstall registration. The test checks
both registry views and rejects machine registrations; identical HKCU read-view
aliases are accepted only with the exact version/publisher/location/uninstall
path, after both views were absent before this job's installation.

## Native Test Scope

Admission requires live Windows X64/PowerShell 7+, GitHub-hosted runner context,
repository `BOBWORKS-XR/CREATOR-HUB`, dedicated validation branch and explicit
`CREATOR_LEGACY_RETENTION_EXPERIMENT=1`, before profile/registry/process inspection.
Output must be new and strictly under canonical `RUNNER_TEMP`. Local/self-hosted
operation refuses; never fake the environment to operate a real PC installation.
There is no production native-context injection or test bypass CLI.

The test refuses any existing target install root, product/manufacturer registry
record, selected store or running target app. It installs only the pinned old
installer with `/S`, without launching its GUI. Existing runner tools `gh`,
`7z.exe`, Node and PowerShell are used; no SDK, compiler, dependency install or
rebuild is needed. The launcher is extracted separately and must hash-match the
installed launcher. Installer/uninstaller child environments are rebuilt from a
finite Windows/profile allowlist, without workflow tokens, signing variables,
Node overrides or inherited PATH/PowerShell-module overrides. Only `gh` gets
the short-lived read-only workflow token, with a new empty config directory.

After the verified install, the generated uninstaller's exact path, SHA256,
length/timestamps, PE version fields (which may be empty) and exact registered
product version are captured. Its original bytes and complete installed file
inventory are retained before removal. This binds the uninstaller to a controlled
fresh installation in this job, not a pre-existing local registry entry.

Synthetic stores, required to be absent before installation and seeding:

- MCP: `%APPDATA%\creator-works-mcp`, `%APPDATA%\banter-mcp`,
  `%LOCALAPPDATA%\creator-works-mcp`, and both Roaming/Local bundle-ID stores.
- Setup: `%LOCALAPPDATA%\CreatorProjectSetup` and both bundle-ID stores.

These custom paths come from pinned MCP `main.rs` config/persistent-server
resolution and Setup `bootstrap.rs` Editor-roots/log resolution. Nested opaque
fixture bytes and JSON are synthetic, not real browser data, Editor installs,
AI accounts, private configuration or actual SDK acceptance. Only those created
fixture stores are inventoried/copied, never the full home/profile.

The uninstaller path is fixed to that captured installation. The process API
executes it directly with **raw** `/S _?=EXACT_DIR`, without shell execution or
using the registry command. `_?=` is last and unquoted even with spaces, as
[NSIS specifies](https://nsis.sourceforge.io/Docs/Chapter3.html#installerusage).
It prevents the usual temporary-copy handoff, making normal exit waiting valid.
ArgumentList autoquoting is deliberately not used for this one command. No
`/UPDATE`, data-removal flag, `/NCRC`, retry or process kill is added.

Success requires normal process exit zero with fully drained logs, absent app
registration/executable and absent known installed payload files. A residual
`uninstall.exe` is removed only after immediate canonical-path, original root
owner/creation identity and complete original file-proof rechecks. Only that
literal file may be deleted, followed by its original root **if empty**. Changed
files, redirected roots or other remaining entries fail; no recursive or forced
cleanup is permitted. NSIS itself is the only source of registry changes.

Directory mtime is intentionally not an identity field: deleting children
changes it. Original directory creation time/owner and seeded file
creation/last-write times and bytes are independently checked. This is a
controlled, newly owned runner fixture, not an adversarial-filesystem lock or
production uninstaller authorization based only on timestamps.

All synthetic store paths/bytes/file timestamps and root identities are checked
in `finally`. Retention failures override apparent success and retain the
original error. Tool timeouts record the exact owned PID and possible surviving
process, fail without signalling/retrying, and rely on disposable job lifetime
teardown. Stores, downloaded originals, before-images, logs and partial state
are retained, including after failure. The workflow uploads only the new output
scope, never source credentials or unrelated profile data.

## Review And Execution

Dedicated workflow: `.github/workflows/native-legacy-uninstall-retention.yml`,
Windows 2025 matrix `mcp` / `setup`. Push admission is limited to
`validation/legacy-retention-014` and changing the exact new workflow path.
Manual dispatch also requires that branch. No default-branch merge, new PR or
product build is required. Main reviews and dispatches; nothing was dispatched
by this implementation.

Workflow-native command (not for the user's PC):

~~~powershell
$env:CREATOR_LEGACY_RETENTION_EXPERIMENT = '1'
# GH_TOKEN comes from github.token in the workflow step only.
./scripts/native-legacy-uninstall-retention.ps1 -Product mcp -OutputDirectory (Join-Path $env:RUNNER_TEMP 'legacy-retention-mcp')
~~~

Local pure unit/structural checks:

~~~sh
node --test scripts/native-legacy-uninstall-retention.test.cjs
~~~

Local fixtures use only newly owned temporary files and pure injected metadata;
they never install/uninstall an app or access the real registry. Native retention
proof is pending the disposable workflow. Root still needs native end-to-end
transfer validation, backups/recovery and client/runtime reference checks before
removing old applications: retaining settings alone does not keep deleted old
installed server paths working. Main owns that product integration and admission.

The focused suite has 16 tests, including original-error/preservation-failure
precedence, nonzero/hang/log-drain refusal, canonical residual cleanup plans and
the directory-mtime versus creation/owner contract. These checks do not produce
native uninstaller pins; those come only from the retained workflow receipts.
Pure unit PowerShell spawns have a 60-second deadline to tolerate parallel-suite
load. This does not change the actual native tool waits (120 seconds normally,
180 seconds for each installer/uninstaller) or the 15-minute disposable job limit.

First native run `38485572714` (source `75bd47ef9eb80e0c8da22ee4ec06594a95c899f7`)
failed the same unit filesystem fixture in both jobs, before any installer step:
13/14 passed, with `Path must remain strictly inside its exact canonical fixture
root`. Original job logs are preserved in
`artifacts/legacy-retention-failure-38485572714/115598272679.log` and
`115598272910.log`. This is a fixture failure, not product-retention evidence.
The fixture had used Node `realpath` to establish a path spelling checked by
.NET `Path.GetFullPath`. The unit temp parent now uses the latter contract before
creating its owned directory; a noncanonical-spelling regression verifies that
the production guard still refuses the raw alias. The original logs do not
record the actual temp-path spelling, so a specific 8.3 alias is not confirmed.
Microsoft documents short-name expansion in
[Path.GetFullPath](https://learn.microsoft.com/en-us/dotnet/api/system.io.path.getfullpath).
No production path/reparse/ownership guard or native timeout was relaxed.

Second native run `38486711648` (source `2a190311299c32ad5ab18b0a2086789b49f17e94`)
passed both pure suites and executed both exact published installers with exit
zero. Neither uninstaller ran and no persistent store was seeded: registration
collection failed while casting an ordered dictionary containing the unnamed
registry value (`''`) into a PSCustomObject. PowerShell rejects an empty property
name. The collector still reads `GetValue('')` unchanged and now maps only that
report key to `defaultValue` before conversion. Named values remain unchanged;
field collisions refuse rather than dropping either value. A populated pure
dictionary regression covers both a real default-value string and an absent
value without accessing the PC registry. Original reports remain under
`artifacts/legacy-retention-38486711648/`. This failure is harness serialization,
not evidence of uninstall failure or retention acceptance.

## Accepted Windows Retention Scope

[Run 38487590987](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38487590987)
at source `3209e54` passed both disposable native jobs. Each exact published
installer ran, then its generated uninstaller exited normally. App registrations,
executables and known installed payloads were absent afterward. Exact synthetic
before-images and metadata were retained in five MCP stores and three Setup
stores. The residual uninstaller/empty install root were removed only after
their exact scoped identity checks.

Generated uninstaller proofs from that run:

| Product | Bytes | SHA256 |
| --- | ---: | --- |
| MCP 2.7.7 | 70977 | `8ab62d3fac6dffd9234e5f54bbc19b7388fe84a341aceae086d9dca87afb8114` |
| Setup 0.3.7 | 67714 | `f8070d8e017032bcca3f91b3b0aa451780583dc7ab7503c16f7f7a3dee1e82b5` |

Local reports: `artifacts/legacy-retention-38487590987/`. This proves only the
tested published Windows uninstallers' retention procedure. It does not prove
Hub migration, live AI-client reconnection, safe removal of modified/custom
installations, Mac/Linux cleanup or release readiness. Product/migration/release
acceptance flags remain false. The user's installed applications were untouched.
