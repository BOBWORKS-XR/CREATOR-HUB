# Build From Source

Windows x64 is the maintained binary release target. Official Linux binaries
are discontinued and new macOS builds are suspended. Source and historical
downloads remain available; this does not establish current Unix parity.

Use a separate checkout for development. Do not point test installers at a
working installation or use existing Unity projects as disposable fixtures.
Keep settings, active MCP routes and retained runtime generations intact.

## Dependencies And Tests

Use the compiler pinned in `rust-toolchain.toml` (Rust 1.99.0 in this source),
Node 24 and the committed npm/Cargo lockfiles. Native compilation also needs
the platform's Tauri build prerequisites; Windows uses the MSVC toolchain.

From the repository root:

```sh
npm ci
npm --prefix modules/mcp ci
npm --prefix modules/project-setup ci
npm --prefix modules/mcp test
npm --prefix modules/project-setup run test:scripts
```

Root-only shell development is available through `npm run dev`. That shell
without a built-in payload is not the complete packaged integrated product.

The integrated native tests need generated MCP release resources first:

```sh
npm --prefix modules/mcp run release:launcher
npm run test:integration:native
```

These commands build/test development source; they do not install, migrate,
activate a managed runtime, sign an official update or publish a release.
The generated resources include a downloaded, version-pinned Node runtime.
Review any platform-specific failures instead of weakening guards or limits.

## Managed Windows Packaging

The existing Windows packaging entry point is:

```sh
npm run build:unified -- UNIQUE-BUILD-NAME --installer --managed --integrated-features
```

This requires the approved release-signing environment, including an existing
signing key outside the repository. Do not commit keys or credentials, generate
replacement production keys, or change the trusted public key to make a local
build appear official. The tool refuses an existing output name. Its immutable
output is under `artifacts/unified/UNIQUE-BUILD-NAME`.

Build/signature success is not installation, migration, update/restart or real
client acceptance. Official publication remains subject to the exact-artifact
qualification and legacy-client feed-size gate.

## Unix Contributions

See [experimental Unix packaging](EXPERIMENTAL-UNIX-PACKAGING.md) for the retained
native-host build API and limitations. Its base package path is read-only MCP,
not a supported replacement for the Windows integrated workflow. Experienced
maintainers can use these sources to investigate native dependencies, host
integration and packaging; no current official Unix installer is promised.
