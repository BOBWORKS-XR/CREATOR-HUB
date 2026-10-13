# Creator Project Setup 0.3.0

The coordinated Windows release with Creator Hub 0.1.0 and Creator Works MCP 2.7.0.
Use Project Setup inside Hub or independently with the installer or portable ZIP.

## Setup And Recovery

- **Set up and create project** checks requirements, previews the downloads and
  installs missing supported tools after your licence and installation approval.
- Pinned recipe: Unity 6000.3.21f1, Creator SDK 4.0.14, URP 17.3.0 and Input 1.20.0.
  Android SDK/NDK/OpenJDK and Windows build support are required.
- Package import/compilation, Visual Scripting configuration and a second Unity
  validation session are separate visible progress stages.
- Download size, received bytes and speed are shown when measurable. Installed
  requirements are refreshed instead of retaining a stale Missing label.
- Failures show the actual error, recovery guidance and local report paths.
  Failed project folders are preserved; logs are never uploaded automatically.
- Existing-project inspection and reviewed, backed-up repairs remain available.

## Creator Plugins

The built-in catalogue includes images, descriptions, credit and category filters.
Add its Editor-only menu to a selected project, or queue eligible packages for
Unity's import selection. The menu supports thumbnail cards, direct Import and
Cancel/retry without reopening. Known old helpers update with a retained backup;
unknown edits are preserved. MCP tools and AI skills have their own categories,
without automatic AI-client configuration.

## Important Limits

Windows x64. Unity sign-in/licence activation and administrator prompts still need
the user; this app cannot bypass them. An old Unity Hub is not silently upgraded.
Automatic Hub project registration requires Hub 3.21.1 or newer and may need an
approved restart. macOS/Linux automatic prerequisite installation is not available.

Windows binaries are not Authenticode signed. Signed Hub download metadata is a
separate integrity check. Attached acceptance reports identify the exact release
artifacts and tested upgrades; they do not prove every previous installation,
every project, player builds, hosted spaces or headset behavior. Review package
file selections and logs before importing or sharing them.

Reporting: https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/blob/master/docs/REPORTING.md

## Release Evidence

- [Final Windows build and source checks](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/35003479084).
- [Installed upgrades from 0.2.2, alpha.1, alpha.2 and alpha.6](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/35004470795), preserving synthetic settings and refusing replacement while active.
- The actual installed app refused close while its folder chooser was active,
  returned safely on Cancel and exited normally when idle. Its approved Plugins
  icon was verified inside the packaged frontend.

Installer SHA-256: `1cb72e2ea31345a4679aabf2b0756e847b10b68bc2043988147c2449584e02f2`.
App source: `f8d5423df9a477ceb65ec62a00358c7900703b66`.
Later acceptance/history commits do not alter the application source or artifact.
