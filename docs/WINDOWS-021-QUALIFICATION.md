# Windows 0.1.21 Qualification

This association reuses the tested installer. It does not rebuild product code.

- Product source: `35411a704707cba5915f77d51bf156e4ec8ce251`.
- Product tree: `4f80b815406aedf577a3f9cb78c1f7fd6caf968b`.
- Installer SHA-256: `09dd6563e5e93a533f7ddedc600c785f56d123f55d1e29a8eada6ab3941cf2b3`.
- Installed executable SHA-256: `b29fe05699196383bbd376f23af934fe9f603761c3de285f16e6c4a3095222f5`.
- MCP bundle SHA-256: `115adb67aedce3f88ae798872f1c269d992cf410b50755138033eda6484b8d29`.

[Source checks](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/42293366877)
passed 466 tests and 10 bundled-protocol tests. One Unity-reference test was
explicitly skipped on the CI machine without Unity; native reference compilation
and disposable IL2CPP operation were checked separately.

[Private native update acceptance](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/42295894387)
passed MCP restore, Setup restore and Setup without restore. Each used actual
0.1.20 and 0.1.21 artifacts and checked cancellation, settings preservation,
automatic process replacement, resource hashes and old/new MCP generations.

The descriptor and installer signatures, all 15 packaged resources and eight
tamper controls passed. The descriptor minimum remains Hub 0.1.19. The native
inventory consumer passed approved-read and revoked-read checks against the
exact packaged MCP bundle.

These are not public-feed acceptance or new live AI-account tests. Public
acceptance is required separately by the guarded latest-promotion command.
Historical client acceptance is inherited from the unchanged client-routing
and setup implementation; no new Claude Code account success is claimed.
