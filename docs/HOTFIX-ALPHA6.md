# Setup Progress and Requirements Preview

Creator Hub `0.1.0-alpha.6` pairs with Creator Project Setup `0.3.0-alpha.6` and
the unchanged Creator Works MCP `2.7.0-alpha.1`. These are Windows prereleases,
not stable releases. Existing public installers are not replaced.

## What You Get

- See Project Setup requirement checks and download progress inside Hub.
- Switch views while Setup works; its next progress stage is not lost.
- The matching Setup refreshes detected requirements after checks and creation,
  and can show download size and transfer rate when that information is available.
- Keep newest-first project sorting, optional A-Z sorting and existing MCP settings.
- Keep standalone app windows as an alternative to hosting inside Hub.

Update Hub first, then choose **Update app** on Project Setup with **Include
prereleases** enabled. Save your work and close affected apps normally before
approving installation. If an AI connection is still running, follow Hub's
identified-client guidance and use **Check again**. Uninstalling is not required
just to close a connection. Downloads never authorize installation on their own.

## Scope and Safety

Hub forwards only the reviewed Setup progress names for the matching session.
Bounded, per-event throttling preserves transitions without creating an unbounded
queue. Progress is informational: it cannot finish commands, authorize installation
or give Setup access to MCP commands. The launcher still locks and verifies the
exact accepted executable before starting a hosted app.

MCP's runtime, installed settings and Unity bridge payload are unchanged. No new
MCP release is needed for this Hub/Setup update. No Unity project is scanned or
changed merely to check updates. Signed release metadata is not Windows
Authenticode signing; Windows may still show an unsigned-publisher warning.

## Evidence

Release preparation is in progress. Publish only after exact CI installer and
native suite evidence is recorded; a local build or version label is not enough.

The paired Setup candidate is from source `a025a112519994670af8f48d848e408ec9dfa492`
and [candidate run 34754280271](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34754280271).
[Installed acceptance 34754654023](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34754654023)
passed upgrades from public 0.2.2, alpha.1 and alpha.2, including active-app
refusal, preserved snapshots, cooperative fixture exit, exact installed payload
and notices, synthetic sentinels, and normal GUI startup/close. The exact installed
EXE pin is `ace1fa411559e84a10cc0bc7884a14aa427ae4f3fba197cc87b2b4b3cc02d800`.
Setup's signed descriptor requires Hub alpha.6. These checks are not the paired
Hub suite or proof of real-user migration across every installer type.

The earlier local matched candidate created and reopened a fresh Creator SDK
project through Hub. Requirements stayed ready, both progress types reached the
view, and normal Close Setup exited its backend. The observer-assisted test is
not a fully unattended pass, nor proof of the later CI-built release bytes.
Original installed applications and settings were restored after that local test.

## Known Limits

- An abnormal test-runner teardown left a completed, headless Setup process in
  one local run. Its shutdown cause is unresolved. Normal close passed in the
  repeat run; this does not prove abrupt-disconnect recovery. Avoid forcibly
  ending Hub during project work and report any leftover process with its error.
- The complete signed Hub self-update/restart flow remains untested. Use the
  versioned Hub installer when testing that route is not appropriate.
- Fresh-computer prerequisite downloads, Unity sign-in/licensing, custom Unity
  Hub locations, historical MSI/BANTWORKS migrations and headset behavior need
  separate coverage. A successful Unity validation is not a VR performance test.
- Persistent adoption, replacing app shortcuts and taking over already-open
  apps are not included. Standalone tools remain independent.
