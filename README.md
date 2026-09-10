# Creator Hub

Lightweight Windows app manager for Creator Works MCP and Creator Project Setup.
Local development preview `0.1.0-alpha.1`; not a public seamless-update release.
Both tools remain usable independently.

## Current Implementation

- In-app verified download, install, open, installed-app reuse and update checks.
- Available/installed versions, download progress, cancellation and visible errors.
- Prereleases and background update downloads are separate opt-ins. Installation
  always requires approval; a download never authorizes execution by itself.
- Pinned hashes for current public releases; signed Minisign descriptors for
  future releases. Bounded metadata/downloads and Semantic Version comparison.
- Running-app/server checks, no forced Unity or AI client closure, no automatic
  downgrade, and no silent duplicate installation over unknown/legacy copies.
- Legacy NSIS releases use their normal installer window. Their silent path can
  force-close apps, so this build does not promise zero-click legacy upgrades.
  Native security/installer prompts may require interaction.
- Compact shared interface, morphing logo drawer, keyboard/reduced-motion support,
  gray Hub cube and official white SideQuest mark for Creator Converter.
- Creator Converter and Creator Plugins are Coming soon. Plugins is planned as
  a no-fee community directory, not a payment or subscription service.

Hub does not modify Unity projects, bridges or AI settings as an inventory action.
Installers retain ownership of their own settings and migrations. No accounts,
telemetry, community hosting, hosted tool UI or arbitrary install URLs are added.

## Development

```powershell
npm ci
npm run test:ui
npm run check
npm run build -- --no-bundle
```

Windows x64 is implemented. macOS/Linux native install and lifecycle support is
not implemented or tested. The unsigned EXE requires the normal system WebView2
runtime. Native builds use Tauri/Rust; no Unity Editor is bundled.

## Validation and Limits

Browser tests exercise app states, install routing, progress/cancellation,
opt-ins, Plugins, responsive layout, drawer behavior and image rendering.
Rust tests cover catalog/signature/hash rejection, cancellation, disk failures,
atomic local record replacement and close-state protection. Separate opt-in
network tests download the real pinned installers without executing them; real
Windows inventory tests do not launch or replace apps.

Signed descriptor publication in both app release pipelines, clean-VM native
install/upgrade acceptance and guarded GUI restart acceptance remain release
gates. A successful installer exit is not enough: its installed launcher must
match the signed/pinned hash. Failed native installers are not assumed to be
transactional; Hub reports failure and retains cached installers.

See [Roadmap](docs/ROADMAP.md) and [release catalog contract](docs/RELEASE-CATALOG.md).

## Assets and License

MIT. Original Creator Works artwork; Hub's gray backplate is original geometry,
not Unity artwork. SideQuest's unmodified logo remains its property and is not
relicensed under MIT. See [third-party assets](docs/THIRD-PARTY-ASSETS.md).
Selected Lucide SVGs keep their upstream license. Minisign verification uses
Frank Denis's MIT-licensed `minisign-verify`; signing uses Tauri's official CLI.
