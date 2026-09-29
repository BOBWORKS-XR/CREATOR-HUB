# Creator Hub 0.1.10 release evidence

- Public stable release: https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/tag/v0.1.10
- Tagged package build (Windows, Linux, macOS Apple Silicon and Intel): https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/36557994660
- Exact tagged Windows installer matrix (clean, legacy, MCP-only and previous Hub): https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/36559775649
- Unmodified public 0.1.8 to signed 0.1.10 update, cancel/install/restart and preserved settings: https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/36561630864
- Outgoing updater with real hosted Setup and MCP views, native cancel/install/restart and automatic view restoration: https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/36566479191

The hosted-view run uses a **test-only, version-only 0.1.8 runtime fixture** built from the 0.1.10 source. It proves the new outgoing updater behavior, not the behavior of the unmodified public 0.1.8 binary. The separate public-stable run above proves the real incoming update path. Neither fixture bytes nor its installer were published.

The released Windows installer SHA-256 is `f65616e41ddf6dfabf4b2d89aa3379da5a8c42cf6d283219017800d772764943`; its installed executable SHA-256 is `8587ecf5316cf5eb6fdadbd3d97d91a13db73d43429f25ea73f2fb840a1fa6a2`. Signed metadata, installed executable and installer were verified before publication. The public release-feed check passed within the legacy client response limit. Native macOS/Linux Unity workflows still require user validation; macOS packages are ad-hoc signed, not notarized.
