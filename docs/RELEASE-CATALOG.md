# Release Catalog and Installation Contract

Hub initially trusts the exact published Setup 0.2.2 and MCP 2.6.0 Windows
installer hashes embedded in `catalog.rs`. Launcher hashes must come from the
corresponding verified installer payload, not a developer's installed copy.

Future releases attach `creator-hub-windows-x86_64.json` and
`creator-hub-windows-x86_64.json.minisig` to the same public GitHub release as
the installer. Hub discovers version tags only in the two allowlisted personal
organization repositories, verifies the descriptor with its embedded Minisign
public key, checks SemVer/channel/platform/minimum Hub version, then downloads
the named asset. Metadata, redirects, bytes and hashes are bounded and checked.
Unknown schemas and invalid signatures are never executable authority.

The catalog key is separate from Windows Authenticode and macOS notarization.
Minisign verification uses Frank Denis's MIT-licensed `minisign-verify` crate;
signing uses Tauri's official CLI, Apache-2.0 OR MIT. No custom cryptography.

## Publishing

Use `scripts/release-descriptor.cjs` with a release installer and its extracted
launcher. Set `CREATOR_HUB_SIGNING_KEY_PATH` to the private key outside the
checkout, and optionally `CREATOR_HUB_SIGNING_PASSWORD`. The local development
key is in the current user's LocalAppData/CreatorHubReleaseKeys with restricted
ACLs. Never commit, log or upload that private key. Keep an offline backup before
shipping the trust anchor publicly. The public key alone belongs in Hub.

The script creates the descriptor and standard Minisign signature. Its extra
Tauri `.sig` output is not required in the release. Verify both output artifacts
against the embedded key before publication. No release upload is automated by
the signing script. Existing stable release assets must not be replaced.

Descriptor protocol fields default to zero. They must not be promoted on the
basis of source tests alone:

- `identityProtocol: 1`: exact read-only `--creator-hub-info` acceptance.
- `lifecycleProtocol: 1`: tested native guarded close and busy/closing behavior.
- `installerProtocol: 1`: no forced process termination in installer AND prior
  uninstaller path. Legacy NSIS uninstallers prevent assuming this property.

Release `lifecycleProtocol: 1` can expose the common advisory Windows properties
`CreatorSuite.LifecycleProtocol`, `CreatorSuite.LauncherBusy`, and
`CreatorSuite.Closing`. Hub verifies the executable identity, checks the owning
window process again, requests normal close only with user approval, and waits
for process exit. Properties are not leases. MCP client-owned servers are
checked separately; unknown or active connections block installation.

## Legacy Installation

Old Tauri NSIS silent modes can kill a running launcher. Hub does NOT pass `/S`
or `/P` to those installers or pretend they support seamless restart. It opens
their normal installer after download/hash verification. A native installer or
Windows security prompt may still require clicks. It never invokes arbitrary
commands from a release descriptor or force-closes Unity or AI clients.

Installed launcher hashes are rechecked before opening. Existing native,
legacy, missing, custom, duplicated or unrecognized copies block automatic
replacement instead of silently creating a second app. Download-only is still
available. The file picker can adopt a recognized standalone executable.

Successful process exit is NOT sufficient install proof: the expected installed
launcher hash must match. Failed native installs are not transactional rollback;
Hub reports failure and retains cached installers rather than attempting an
unapproved downgrade. App settings remain owned by the respective installer.

## Remaining Release Gates

- Fresh Windows VM install and upgrade with no installed apps/configs at risk.
- Full native GUI close/busy/reopen tests, not just browser mocks.
- Signed descriptor publication in BOTH app release pipelines.
- Catalog key offline backup/recovery procedure; key rotation currently needs a
  reviewed Hub update. No automatic key replacement is accepted from the feed.
- macOS/Linux packaging and lifecycle implementation and native acceptance.

This development build is not yet a public seamless-update release.
