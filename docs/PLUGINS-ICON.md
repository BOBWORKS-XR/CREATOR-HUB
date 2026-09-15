# Creator Plugins Icon

The user approved the three-puzzle-face direction on 2026-09-15. The production
asset is `src/icons/creator-plugins.png`, shared byte-for-byte with Setup and MCP.

- Generated with the built-in image tool, not the fallback API/CLI.
- Gray Hub cube with a detached cyan/red corner made from three puzzle faces.
- Original concept: `outputs/plugins-logo-options/03-puzzle-faces-concept.png`
  in the author's local workspace; not a runtime dependency.
- Full prompt: [03-prompt.md](../outputs/plugins-logo-options/03-prompt.md).
- Runtime asset: transparent 256px PNG, SHA-256
  `ff107f1c0bca0380f35f25754fd023d60311fa4457f6fd84255a8f41f78fee6d`.

The export uses `node scripts/prepare-plugins-icon.cjs <approved-source.png>`.
It preserves the composition and alpha, only scaling the selected artwork.
`tests/plugins-icon.spec.js` verifies actual image decoding, cyan/red/gray and
transparent pixels, the 34px menu size, and saves menu/detail screenshots.

Earlier SVG proposals are not shipped. This mark is not a Unity or Lucide asset.
