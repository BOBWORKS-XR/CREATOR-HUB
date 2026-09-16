# Creator Plugins Icon

The user approved the three-puzzle-face direction on 2026-09-15 and requested
the larger, lower piece with an indented outside edge. Hub 0.1.5 uses that revised
artwork in `src/icons/creator-plugins.png`. Published Setup 0.3.0 and MCP 2.7.1
retain the earlier transparent icon; this Hub hotfix does not rebuild them.

- Artwork generated with the built-in image tool, not the fallback API/CLI.
- Gray Hub cube with a detached cyan/red corner made from three puzzle faces.
- Original concept: `outputs/plugins-logo-options/03-puzzle-faces-concept.png`
  in the author's local workspace; not a runtime dependency.
- Full prompt: [03-prompt.md](../outputs/plugins-logo-options/03-prompt.md).
- Revised opaque source: `05-enlarged-notch-draft.png`, SHA-256
  `5c3b586a8b2589219ce39f28e00bf9e12be06aec5e86a1d59caed4decc585f0c`.
- The image tool returned another opaque RGB checkerboard on 2026-09-16. Local
  exterior-connected neutral-background removal preserved the original coloured
  artwork and removed 683,737 of 1,572,516 background pixels without repainting
  the shape. The 1254px transparent export is `06-transparent-notch.png`, SHA-256
  `02f68ef9514f873a23e5e28db79dacbe6bdfd9b77cf5b08510c7abc5905926ba`.
- Runtime asset: transparent 256px PNG, SHA-256
  `ebb367878996c5a6af4225d2105a6e29711fd54d50d965e5e18571426eedae02`.

The export uses `node scripts/prepare-plugins-icon.cjs <approved-source.png>`.
It refuses opaque sources before overwriting the asset and preserves composition
and alpha while scaling the selected artwork.
`tests/plugins-icon.spec.js` verifies actual image decoding, cyan/red/gray and
transparent pixels, the 34px menu size, the active-page icon at desktop/mobile
widths, and saves menu/detail screenshots. Packaged tests compare the actual
decoded pixels with the hash-pinned source and check alpha and the transparent
border without weakening the production content-security policy.

Earlier SVG proposals are not shipped. This mark is not a Unity or Lucide asset.
