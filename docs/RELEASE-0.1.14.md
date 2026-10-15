# Creator Hub 0.1.14: Windows

Publication candidate. Do not announce readiness until the public update run
below has passed and the exact release has been promoted.

## Package

- Product source: `db862739d01088ba9be335d0522f8f129222a48b`.
- Installer: `Creator.Hub_0.1.14_x64-setup.exe`, 36,511,040 bytes.
- Installer SHA-256: `284820f92de487e8a0f1bb5b3b99cafe5e073f0402a9350a2ea6e76fa9543157`.
- Installed Hub SHA-256: `cd5e3fd2829727d06444c0f3266b178798d1b55c63df651be12eb38ac4523a86`.
- Windows x64 only. Linux/Flatpak remain unpublished development work; macOS
  support is suspended. Historical downloads are unchanged.
- Update descriptors and installer signatures are verified using the existing
  keys. This is not Windows Authenticode publisher signing.

## Native Evidence

| Check | Actual result |
| --- | --- |
| Fresh packaged built-ins, no companion installation | Passed in [38658790977](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38658790977), attempt 1 |
| Public Hub 0.1.12 / MCP 2.7.7 / Setup 0.3.7 migration | Passed in the same run: backup cancellation, changed-data refusal, three-client reviewed routing, approved GUI retirement, retained runtimes and restart |
| Guarded public 0.1.12 installer upgrade | Passed in the same run: real `/UPDATE /S /NS`, exact installed image and retained settings/unmanaged bytes |
| Signed 0.1.12 to 0.1.14 in-app update | Passed in [38659795657](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38659795657), attempt 1: native cancellation, approved installation, automatic restart, both built-ins and SDK reconnect. Controlled feed, not public discovery |
| New updater with both built-in views open | Passed in [38660387465](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/38660387465), attempt 1: native Cancel preserves drafts/processes; approval installs the exact signed target and restarts automatically; both views reopen, settings survive, the old SDK connection survives and the new router reconnects twice. The 0.1.15 target is an acceptance-only fixture, never a public release |
| Previous stable discovers and installs the final public release | Pending publication and public self-update acceptance |

The immutable qualification receipt binds original reports, successful jobs,
source trees, artifact digests and the exact six release assets. Unit tests and
silent installation alone are not treated as full update acceptance.

## Migration And Limits

MCP and Project Setup are internal Hub modules with one installer/update stream.
Existing settings stay in their established data locations, with verified
before-images. Unity projects are not moved. First launch detects recognized
standalone installations and asks for backup, connection review and GUI-removal
approval. Declining leaves the old installation available.

The accepted standalone baselines are Windows MCP 2.7.7 and Project Setup 0.3.7.
Unknown, modified, custom or conflicting installations can require manual review;
they are not silently removed. Existing MCP Node/server resources remain at
their original paths for active and old connections. Unrelated Node processes,
Unity and AI clients are not force-closed.

Standalone-only users install Hub and follow that review. Their historical
updater feeds are not silently redirected to a different product. Old repositories,
installers and signed metadata remain available.

The disposable native runs use the official MCP SDK. They are not tests of model
quality, every live AI application, every historical configuration, Unity project
creation or headset behavior. Optional Unity CLI remains experimental and opt-in.
