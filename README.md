# Creator Hub

Local interface preview, `0.1.0-alpha.1`. Not published as an installer or stable
release. Creator Project Setup and Creator Works MCP remain independent apps.

## This Pass

- Compact shared Creator styling, original cube art, H/M/P corner badges.
- Left-edge logo tab and keyboard-accessible app switcher.
- Flat catalog and detail views for MCP and Project Setup.
- Native commands open a finite list of public release/source pages.
- URP Converter is Coming soon, with no install action.

No project scanning, application launching, install discovery, background
downloads, update checks, telemetry or mandatory onboarding is implemented.
The app does not claim another app is installed or hide its controls based on
query parameters. It accepts no command-line routes in this preview.

## Development

```powershell
npm ci
npm run test:ui
npm run check
npm run build -- --no-bundle
```

Native builds require the normal Tauri/Rust platform toolchain. Windows is the
current build target. macOS/Linux are not yet built or tested for this Hub.
The standalone Windows EXE uses the system WebView2 runtime; it is unsigned.

The initial local build reused the sibling Setup project's Cargo target cache
via `CARGO_TARGET_DIR`, then copied the Hub EXE to this project's `dist`. That
is a local build optimization, not a source or runtime dependency on Setup.

## Verification

- Eight Playwright tests: catalog routing, keyboard and outside dismissal,
  pinned resource IDs, link failures, and no false hosted/installation state.
- Screenshots checked at 940, 720, 560 and 390 pixels.
- Native resource allowlist unit test and strict Clippy checks.
- Windows release EXE built. Desktop automation failed before opening the native
  preview, so native visual acceptance remains pending.
- No live Unity project, installed MCP or stable release was changed.

## Next Gates

Follow the [approved Creator Hub plan](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/blob/master/docs/CREATOR-HUB-PLAN.md).
Next is an authenticated release catalog and deterministic version comparison,
then verified install/adoption, running-app protection, and explicit updates.
Keep portable/standalone tools independent. Hosted interfaces come later and
must reuse each tool's implementation rather than embed an EXE window.

## Assets And License

MIT. Creator Works cube artwork reused from the existing suite. Selected Lucide
icons retain their complete upstream license in `src/icons/LICENSE-lucide`.
Unity and SideQuest products and trademarks belong to their respective owners.
