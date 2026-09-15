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

[Hub candidate and staged native acceptance](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/34754847040)
passed from source `cfa2fa5c1e6848082f01b6724b7400e47ba40360`: 78 UI tests,
54 Rust tests, 11 Node tests, strict release Clippy, installer guard and installed
acceptance. Five explicit live Rust tests were not part of the unit count.
All three native lanes passed: clean installation, both-app upgrade and MCP-only
upgrade. Hub upgrades used public alpha.5 and alpha.3 baselines. Checks included
active-process refusal, cooperative fixture exit, exact installed hashes/notices,
saved MCP selection and a restored preference, native consent, real folder-picker
close protection, both hosted interfaces and scoped normal backend exit.

The staged suite used the signed Setup cache, not public Setup discovery. Its
`unityProjectCreated` and `selfUpdateTested` fields remain false.
[Public native acceptance](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/34756015590)
then passed all three lanes with staging disabled and the exact same Hub candidate
from run 34754847040, without rebuilding. Clean and both-app upgrade lanes used
the actual public signed Setup and MCP releases; the MCP-only lane left Setup
uninstalled. All 22 public Hub assets were subsequently downloaded without
authentication, byte-matched to the reviewed release and passed the compiled-key
signature, updater and tamper verification. The tag remains on the actual product
source above; subsequent documentation edits do not replace its installer.

Exact Hub installer SHA-256:
`107ad181baced72dc8f6e107c04b96e9c8c9447b023407be4e441867560c048d`.
Installed EXE and installer preflight payload SHA-256:
`8c07418efee8f474eaf32d6d5dbd3f6ccabccd23fbcaf33520e9cc25b510a1eb`.
The signed metadata, installer updater signature, actual payload and tamper
rejection passed the compiled-key verifier. These checks do not prove a full
in-app self-update and restart.

The paired Setup candidate is from source `a025a112519994670af8f48d848e408ec9dfa492`
and [candidate run 34754280271](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34754280271).
[Installed acceptance 34754654023](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34754654023)
passed upgrades from public 0.2.2, alpha.1 and alpha.2, including active-app
refusal, preserved snapshots, cooperative fixture exit, exact installed payload
and notices, synthetic sentinels, and normal GUI startup/close. The exact installed
EXE pin is `ace1fa411559e84a10cc0bc7884a14aa427ae4f3fba197cc87b2b4b3cc02d800`.
Setup's signed descriptor requires Hub alpha.6. These checks are not proof of
real-user migration across every installer type.

[Fresh Setup prerequisite acceptance](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/actions/runs/34754298548)
passed on a clean disposable Windows runner from the same Setup source. It
installed and checked Unity 6000.3.21f1 requirements, exercised cancellation and
reuse, repaired a missing JDK and executed Java, javac, ADB and NDK clang. It
captured real download byte/rate progress. No Unity account was used; license
activation and project creation were not tested by that run. All 11 public Setup
release assets were separately downloaded without authentication, matched to the
reviewed files and passed signature and tamper verification.

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
- The clean-runner prerequisite test is not every fresh computer. Unity
  sign-in/licensing, custom Unity Hub locations, historical MSI/BANTWORKS
  migrations and headset behavior need separate coverage. A successful Unity
  validation is not a VR performance test.
- Persistent adoption, replacing app shortcuts and taking over already-open
  apps are not included. Standalone tools remain independent.
