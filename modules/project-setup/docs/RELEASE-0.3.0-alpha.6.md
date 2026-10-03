# Creator Project Setup 0.3.0-alpha.6

Windows prerequisite-installation prerelease. Stable 0.2.2 and earlier
prerelease assets remain unchanged.

## What Changed Since Alpha.2

- **Set up and create project** can install missing Windows requirements before
  creating a Creator SDK project. It previews the pinned Editor, required tools,
  locations and storage reserve, then asks for installation and licence approval.
- Downloads the pinned official Unity Hub installer when needed, verifies its
  hash and Windows signature, and uses the verified official Unity CLI to install
  the Editor and missing supported modules. Existing unrelated Editors remain intact.
- Checks the actual installation and active licence before creating a project.
  Missing sign-in or activation hands off to Unity Hub; no project is created
  until that check passes, and already installed requirements are retained.
- Download progress shows file size, received bytes and recent speed when
  measurable. Unity rates are labelled estimates from installer-file growth;
  unavailable measurements are not invented. This improves visibility, not speed.
- Refreshes the Requirements panel from native checks as project creation starts,
  so an installed Editor does not keep its startup Missing label during import.
- The Creator Hub menu entry opens the Hub releases page, not an old plan document.
- Retains detailed failure messages, versioned local receipts and reporting
  guidance. Logs stay local; nothing is automatically uploaded.

The recipe remains Unity 6000.3.21f1, Creator SDK 4.0.14, URP 17.3.0 and Input
System 1.20.0. Android SDK/NDK/OpenJDK and Windows support remain mandatory.
New projects are compiled, Visual Scripting is initialized, and configuration
is validated in a second Unity session. Existing-project repair remains preview.

## Install And Test

Use the Windows installer or portable ZIP; keep the included `licenses` folder.
Close Setup normally before upgrading. Both forms work standalone without Hub
or MCP. Windows binaries are not Authenticode signed; signed Hub download
metadata is a separate verification mechanism.
The footer retains `0.3.0-alpha.6 candidate`: these are the exact tested files,
not a cosmetically rebuilt installer.

For hosted use, the coordinated version is **Creator Hub 0.1.0-alpha.6**. Update
Hub first. Creator Works MCP **2.7.0-alpha.1** remains the matching unchanged
release; no MCP reinstall is needed just for this Setup update.

Use a new test project and review local logs before sharing them. Unity sign-in,
licence acceptance/activation and OS administrator prompts cannot be bypassed.
An old Unity Hub is not silently upgraded; automatic project registration needs
Hub 3.21.1 or newer. A running Hub may need the offered, approved restart before
its project list refreshes.

## Verification And Limits

[Clean candidate checks](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34754280271)
passed from source `a025a112519994670af8f48d848e408ec9dfa492`: 63 Rust unit tests,
two executable-identity tests, 57 browser tests, strict Clippy, complete original
notices, portable ZIP and installer guard checks. Six explicit live tests are
separate from that candidate run.

[Installed upgrade acceptance](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34754654023)
passed on three disposable Windows runners, from public stable 0.2.2, alpha.1
and alpha.2. All used the same exact candidate installer: active owned-process
refusal, unchanged refusal snapshots, cooperative exit, successful update,
installed executable/notices, synthetic preservation data, real GUI startup and
normal close passed. This does not prove arbitrary user-settings migration.

Earlier local alpha.6 testing is not evidence for a different CI executable:
it covered a real alpha.1 upgrade/refusal with restoration,
project compilation/Visual Scripting/reopen validation, and a matched hosted run
with normal close. The hosted retry required observer assistance with the test
harness. Fully unattended testing of that final harness remains separate.

[Fresh disposable Windows prerequisite acceptance](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34754298548)
passed on the same alpha.6 source. It installed and checked the real Hub, Editor
and Android tools, reused the install, repaired isolated OpenJDK damage, executed
Java/javac, ADB and NDK clang, and required the activation handoff without using
a Unity account. The native test took 1,437.87 seconds, excluding CI preparation.
Actual Hub HTTP transfers and Unity Editor/Android module downloads produced
byte and recent-rate measurements. Quick/cache-hit components can still have
no speed reading. These are observations, not an independent speed benchmark.
This test did not create a project or activate a licence. It and the separate
licensed-PC project tests do not prove the complete fresh-user flow.

[Paired Hub staged native acceptance](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/34754847040)
passed clean-install, older-app upgrade and MCP-only routes with the exact files.
It verified signed staged Setup metadata, approved installs, hosted views,
retained state and busy-close refusal. The MCP-only route leaves Setup uninstalled.
Hub's release records the separate public-feed retest; staged-cache acceptance
does not itself prove public discovery, Unity creation or Hub self-update.

Known limitations:

- Abnormal hosted-session termination left a completed Setup backend running
  in one local test. Normal close passed; abnormal-disconnect cleanup is unresolved.
- A reported missing-Hub label after completion was not reproduced in current
  tests. Custom Hub install paths may be undetected; capture the exact path and
  version if this occurs rather than reinstalling Unity blindly.
- Fresh-PC sign-in/UAC and the combined account-to-finished-project flow still
  need user testing. Actual download rates on other PCs are not benchmarked.
- Failed project folders are preserved, not automatically resumed or overwritten.
  Existing-project recovery is manual and backups are selective.
- No claim of every historical upgrade, real user-settings migration, Android
  APK/Windows player builds, hosted-space or headset behavior. macOS/Linux
  automatic prerequisite installation is not implemented.

See the [reporting guide](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/blob/hub-compatibility/docs/REPORTING.md)
for receipts, logs and privacy checks.
