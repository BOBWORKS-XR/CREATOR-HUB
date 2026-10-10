# Windows Prerelease Evidence

## Alpha.6 Release (2026-09-13)

Source-clean [candidate run 34754280271](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34754280271)
passed for `a025a112519994670af8f48d848e408ec9dfa492`: 63 Rust unit tests,
two executable-identity tests, 57 UI tests, strict Clippy, portable ZIP,
installer guard and original licence notices for 299 dependencies. The seven
candidate file sizes and hashes were independently checked after downloading.

[Installed acceptance 34754654023](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34754654023)
passed all three public baselines: stable 0.2.2, alpha.1 and alpha.2. Each reused
the exact candidate, tested active owned-process refusal with unchanged snapshots,
cooperative exit, successful update, payload/notices/synthetic data preservation,
and real GUI startup and normal close. Source, version and hashes match in all
three receipts. This does not prove every historical or custom-path upgrade.

The [fresh prerequisite run](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34754298548)
and [paired Hub staged native matrix](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/34754847040)
also passed. Setup is published as a prerelease, not stable. Its 11 public files
were anonymously downloaded and compared to the accepted stage; descriptor,
installer, actual installed-EXE and tamper-rejection verification passed.
Hub's separate [public-feed retest](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/34756015590)
passed all three routes using the same installer without staging. See the
[alpha.6 release notes](RELEASE-0.3.0-alpha.6.md) for scope and limitations.

## Alpha.1 Historical Evidence

This records the preparation and acceptance history for the published
[Setup 0.3.0-alpha.1 prerelease](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/releases/tag/v0.3.0-alpha.1).
Stable 0.2.2 remains unchanged. Earlier local preparation results below are not
retroactive evidence for the final files.

The optional [Creator Hub 0.1.0-alpha.3 prerelease](https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/tag/v0.1.0-alpha.3)
provides the install-first route. Its
[native suite matrix](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/34536443333)
passed clean-install, older-app upgrade and MCP-only flows with the unchanged
published Setup/MCP files. MCP does not require Setup. Hosted-interface acceptance
does not establish persistent shortcut adoption, SDK migration, Hub self-update,
or unattended installation.

## Candidate Workflow

`Windows Candidate` runs tests and stages unsigned Windows x64 artifacts with
read-only repository permissions. It does not create tags/releases, upload release
assets, load signing keys, or execute the product installer/uninstaller.
Branch pushes to `hub-compatibility` can test it before merging. Manual dispatch
requires the workflow to exist on the default branch, per
[GitHub's workflow documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).
Only push this preparation branch within the coordinated test scope. A branch
push is not approval to merge, sign, tag, or publish a release.

Run locally from PowerShell 7 after installing the repository dependencies:

```powershell
$env:CARGO_TARGET_DIR = "$PWD\dist\prerelease-target"
git clone --no-checkout https://github.com/BOBWORKS-XR/CREATOR-HUB.git dist/notices-tool
git -C dist/notices-tool checkout --detach c1faf51ef6f9c0f1a056f59c1219214fee2bc44e
node --test scripts/verify-windows-candidate.test.cjs
cargo test --release --locked --manifest-path src-tauri/Cargo.toml
npx playwright test --output dist/candidate-ui-tests
./scripts/Build-WindowsCandidate.ps1
```

Use a dedicated target directory; do not reuse another task's active build.
The notice-tool clone step is only needed for a fresh checkout. Its revision is
pinned in `scripts/notices-tool.json` and the CI workflow. The common collector
uses original crate notices and version/commit/hash-pinned upstream supplements.
Release-only Tauri configuration packages the generated MIT app licence,
third-party texts, and inventory into `licenses/`; regular development does not
require generated release resources.
The build script saves the portable EXE **before** NSIS bundling. It then uses
7-Zip to extract the installed EXE, probes both with the exact metadata command,
checks rejection of unsupported Hub commands, and records all three hashes.
Tauri's packaging marker can make the portable and installed binaries different.
The descriptor must contain the extracted installed EXE hash, not the portable's.

Outputs under the fresh candidate directory:

- `Creator-Project-Setup-0.3.0-alpha.1-Windows-setup.exe`
- `Creator-Project-Setup-0.3.0-alpha.1-Windows.exe` (portable)
- `Creator-Project-Setup-0.3.0-alpha.1-Windows-portable.zip` (portable plus licences)
- `installed-payload/creator-project-setup.exe` (verification evidence)
- `creator-hub-windows-x86_64.UNSIGNED.json` (descriptor draft, not loadable release metadata)
- `candidate-report.json`, `guard-report.json`, and `SHA256SUMS.txt`

The report records the source revision and dirty-tree flag. Local dirty builds
are development evidence only. CI test logs accompany the candidate but are not
replaced by the artifact-check report. An incomplete or failed job is not a
candidate to distribute, even when diagnostic artifacts were uploaded.

Publish the portable ZIP, not a bare portable EXE without its notices. Extraction
checks compare all three notice files to the generator output in both installer
and ZIP, and compare the ZIP's executable to the tested portable. Installed
acceptance also compares the resulting installed notice hashes.

Source cleanliness is determined by actual Git-normalized HEAD/index content
differences and nonignored untracked files. Raw status is retained separately:
Windows build tools can rewrite line endings without a Git content difference.
Regression tests still reject staged, unstaged, deleted and untracked source.
Historical reports are not changed retroactively.

The licence-complete candidate from source
`4ba97911ce135faa2f1ea495dd01bf1ea0c1f55d` passed
[Windows Candidate run 34527681202](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34527681202).
Its report records `sourceDirty:false`, verified installer/portable ZIP notice
payloads (299 Rust dependencies), and successful native/browser/guard checks.
Installed acceptance reused that run without rebuilding and passed in
[run 34528338440](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34528338440).
The public 0.2.2 default per-user installation upgraded successfully after a
blocked attempt preserved byte-identical file/data/registry snapshots. The owned
process exited cooperatively; installed EXE/licence hashes, synthetic sentinels,
and real app-window startup/normal close passed. This approves only the guarded
default-path NSIS update route, not historical uninstallers or general migration.

Identity protocol 1 is derived only from the exact native metadata/rejection
checks. Lifecycle and installer protocols remain 0. Minimum planned Hub version
is `0.1.0-alpha.3`. The unsigned descriptor contains no hosting extension.
The coordinated Hub publisher may attest a narrowly tested installer route in
its signed descriptor after reviewing the exact acceptance receipt; this is
not blanket historical installer safety or general hosted/adoption support.
Signing remains the coordinated Hub release task's responsibility.

## Local Preparation Evidence (2026-09-10)

The dirty development checkout produced a Windows candidate successfully:
35 Rust tests passed (4 explicit live tests remained ignored), 32 browser tests
passed, and the packaged portable/extracted EXEs passed identity and argument
rejection checks. The no-install guard fixture returned 10 before the legacy
page while its fixture process and pre-existing Setup processes survived.

Local evidence is under `dist/windows-candidate-local-20260910/candidate/`.
Its report has `sourceDirty: true` and `publicationReady: false`. These hashes
identify that local build only; rebuild from the coordinated committed source
and repeat acceptance before distributing:

- Installer: `69e092389052ad0ba371d40a3989ba6b552653ec1f14d9c0591cd5e5b473de15`
- Portable: `c234d4f0c77548bb2154b3df3255d4cc59bb1ca6ab234b98e2b0b9a254930b3b`
- Extracted installed EXE: `94f800232aa308e115b1c7c1f5c26009110c6581a18e94aa16594dd4c2a3bfa8`

The new workflow passed Actionlint 1.7.12 locally. At this local checkpoint it
had not been pushed or run on GitHub. CI results are recorded separately in
GitHub Actions; a candidate build does not satisfy the installation gates below.

## Installed Upgrade Gate

`Windows Installed Acceptance` runs real installers **only on a disposable
GitHub-hosted Windows runner**. The script refuses local/self-hosted execution.
It reuses the successful candidate run and exact installer/payload hashes in
`scripts/installed-acceptance-pin.json`; it does not rebuild or alter that artifact.
Changing the pin is an explicit review step, not automatic selection of latest.
Final release acceptance requires source-clean and licence-complete candidate
evidence. The earlier development fixture remains historical evidence only.

The fixture downloads the hash-pinned public 0.2.2 NSIS installer, installs it in
the default per-user directory, snapshots files/data/registry values, and tests
the candidate with `/S /NS /UPDATE /D=<default path>`. A same-name, explicitly
owned keepalive process must cause exit 10 without changing the snapshots.
After a cooperative stop-file exit, the same update must succeed. Installed
version, metadata, extracted payload hash, sentinels, a real main window and
normal close are checked. No kill, Unity launch, project creation or repair occurs.

Preservation evidence is limited to synthetic sentinels in app-data/cache and
installation directories. It does **not** prove migration of real user preferences,
project receipts, interactive dialogs, busy creation, or historical uninstallers.
The report and before/after snapshots are diagnostic artifacts, not release assets.

Candidate run [34521606644](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34521606644)
passed artifact/native/browser/Clippy/build checks. Its report marks
`sourceDirty: true` without identifying the changed files, so clean provenance is
not established. The next candidate build captures status and generated-schema
diffs; do not silently reinterpret this existing artifact as clean.

The no-install NSIS fixture confirms early refusal before the legacy selection
page when a same-name process is running. It is **not** proof of an installed
upgrade, settings migration, or a historical uninstaller's behavior.

The guard harness records owned-dialog observations and process survival even on
failure. It acknowledges only the matched warning's actual OK control, using its
observed control ID and parent window. It does not assume IDOK=1: a captured
Windows MB_OK dialog exposed ID 2. This uses the standard
[WM_COMMAND control notification](https://learn.microsoft.com/en-us/windows/win32/menurc/wm-command)
without activation; [BM_CLICK can fail for inactive dialogs](https://learn.microsoft.com/en-us/windows/win32/controls/bm-click).
The old CI timeout did not retain sufficient dialog evidence to establish its
cause. Three local runs of the revised harness passed with refusal code 10 and
protected processes surviving; this is harness evidence, not a product change.

Before distributing the installer, use a disposable Windows VM/profile and the
exact public 0.2.2 installer, not a fabricated registry entry. Keep installer and
installed EXE hashes, OS/user scope, exit codes, logs, and before/after snapshots.

| Scenario | Required evidence | Current gate |
| --- | --- | --- |
| Fresh install and standalone launch | Installed identity matches extracted hash; normal GUI opens; uninstall registration correct | Standalone launch passed after upgrade; Hub native clean-install and hosted-interface route also passed |
| Closed 0.2.2 to candidate | Legitimate preferences and project receipts preserved; no duplicate installation | Default-path upgrade passed with synthetic sentinels; real preferences/receipts untested |
| Running 0.2.2 upgrade, GUI and silent | Refuses before invoking old uninstaller; old process survives; no changed files/registration | Owned same-name process refusal and unchanged snapshots passed; real busy app untested |
| Candidate busy creating/repairing | Upgrade and uninstall refuse; operation and Editor survive | Not run |
| Cancelled/failed upgrade | Prior app remains usable; no false success or deleted settings | Not run |
| Portable plus installed copies/custom location | Explicit selection; unrelated copies and content untouched | Not run |
| Reinstall and uninstall | Only owned installation removed; Unity projects and user settings retained as documented | Not run |
| Hub open/download/install/readback | Descriptor, approvals, version/hash readback, and refusal behavior agree | Native clean/older-app/MCP-only matrix passed; exact installed hashes, fixture preservation, consent, hosted state and busy-close refusal checked |

Run these on the packaged bits after all source changes land. A clean build,
metadata pass, or browser mock cannot promote `installerProtocol` to 1.
Do not run historical installers on the developer's active Windows profile.

macOS/Linux remain separate native acceptance gates. The existing tag workflow
can package them but does not establish that their Unity workflows work.
