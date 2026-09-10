# Local Development Handoff: 2026-09-10

## Current Request

Working in-app Hub downloads/install/open/update for MCP and Project Setup,
plus Creator Converter with official SideQuest branding. Latest addition:
Creator Plugins, a roadmap-only no-fee community directory. Hosting and optional
SideQuest account linking remain undecided. No account, marketplace backend or
package hosting was created.

## Checkouts

- Hub: `C:/Users/bobman/CREATOR-HUB`, local `ui-preview` branch, no public remote.
- Setup: `C:/Users/bobman/CREATOR-PROJECT-SETUP`, `hub-compatibility`.
- MCP: `C:/Users/bobman/creator-works-hub-compatibility`,
  `feature/creator-hub-compatibility`, coordinated MCP task, commit `14556ef`,
  draft PR33. No stable release or installed MCP was changed.

Hub uses the sibling Setup Cargo target directory only as a build cache:
`CARGO_TARGET_DIR=C:/Users/bobman/CREATOR-PROJECT-SETUP/src-tauri/target`.
Standalone output `creator-hub.exe` is therefore in that target/release folder.
Do not confuse earlier dist UI-only binaries with the new installer preview.

Latest Hub copy: `dist/Creator-Hub-0.1.0-alpha.1-App-Manager-Preview.exe`,
SHA256 `9887bc8d7194ffbea7a8c97cc6477549a00cc19650244ca6bc352f8bdd380f3a`.
Latest Setup copy: sibling `dist/Creator-Project-Setup-0.3.0-alpha.1-Hub-Preview.exe`.
Setup's new NSIS built with its non-killing hook. Neither installer was executed.

## Verified

- Hub: signed authentic descriptor positive test, wrong-app/tamper/invalid
  signature/metadata rejection, version comparison and hash/size checks.
  Final default Rust suite: 12 passing tests, two opt-in live tests run separately.
- Real pinned MCP 2.6.0 and Setup 0.2.2 installer downloads completed and matched
  approved hashes. They were NOT executed. Read-only real Windows inventory ran.
- Hub browser suite: 14 passing tests, desktop/mobile screenshots and logo pixels.
- Setup: 30 native unit tests plus two actual binary metadata tests, 32 browser
  tests. Four explicit Unity/Hub mutating tests remain ignored. New native
  operation/close race tests pass; full Setup native WM_CLOSE fixture still needed.
- Both native sources passed strict Clippy at the pre-packaging checkpoint.
- MCP task: 210 Node tests,32 Rust tests, browser layouts, real isolated Tauri
  lifecycle fixture, metadata checks; new NSIS built and not installed.

## Important Boundaries

Legacy Tauri silent/passive installers and old uninstallers can force-close an
app. Current public descriptors remain installerProtocol0 and lifecycleProtocol0.
Use normal installers for them. Newly guarded MCP lifecycle is close-only,
never server quiescence or an update lease. Hub cannot make an old uninstaller
transactional or retroactively remove its force-kill behavior.

Installed MCP and Node servers remain active locally. A legacy BANTWORKS entry
also exists: automatic replacement is blocked rather than consolidating copies.
An explicit verified app selection may be used for opening only; multi-copy
updates remain blocked. No Unity project, client config or bridge was changed.

Setup public NSIS payload EXE SHA256 is
`23006194bd8214b92c980dc1042466d598d6d1daaed26819ab697d67159db49b`.
Its separately published portable EXE is
`4f6e5d28df2c68eed6fe1193e52aae7a4aa26a215191a79fcabca0890896540c`.
They are not interchangeable installation receipts. MCP public payload pin is
`b712aadd91ac63ea64b5bbead28d7dc2fc83d4102f989999d7ea85b427649676`.

## Remaining Before Public Release

Clean-VM fresh install, adoption, upgrade, cancel/failed installer, actual busy
GUI close/refusal/reopen, repeated Open/startup races and independent MCP server
quiescence acceptance. Native Windows security/installer prompts may still need
user interaction. No full seamless-restart claim yet.

Signed descriptors must join future public releases in both app pipelines.
Catalog private key stays outside repos in LocalAppData/CreatorHubReleaseKeys;
only the public key is embedded. Back up the key before shipping. Key recovery/
rotation and macOS/Linux install backends remain release gates.

Artifact downloads now use cancellable asynchronous streaming. A bounded test
checks cancellation while a network future remains pending. Native installers
are not terminated on cancellation; their normal window remains authoritative.
