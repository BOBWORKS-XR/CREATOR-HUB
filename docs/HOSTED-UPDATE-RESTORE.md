# Hosted Views Across Hub Updates

0.1.6 is published as stable/latest after signed-update acceptance. User report:
installed 0.1.4 refuses a Hub update
while idle MCP/Setup views are open. The earlier public self-update test had no
hosted views, so it did not cover this case.

## Behavior

- One native Update Hub confirmation names the views that will close/reopen and
  warns that unsaved form entries are discarded. Cancel changes no view.
- The native Manager lease and hosted workflow checks prevent closing active
  work. Downloads and signature verification finish before views close.
- Hub records only its open app IDs and original verified executable paths,
  closes their input pipes, and waits for actual owned-process exit. A timeout
  aborts the update; it never kills Unity, AI clients or unrelated processes.
- The bounded, version-bound, 24-hour restoration record is claimed once. After
  restart, the usual executable hash/process checks apply to reopening each view.
  Existing app-native permissions remain required; this does not bypass consent.
- Installer launch failure restores the views in the running Hub. A failed or
  declined reopen has an explicit retry; successful views are not reopened twice.
- Notifications use old session identities so delayed closes cannot remove new
  views. Apps remains the default; restored views are available from the menu.

## Evidence and Limits

Current source: 169 UI tests and 111 Rust tests passed, with nine opt-in Rust tests
excluded. Native Rust fixtures verify EOF-driven child exit and no forced kill
on timeout. UI tests include cancel/form preservation, busy refusal, restart
restoration of one/two views, failure/retry, and delayed close events.

The packaged CI suite additionally seeds a restoration record on disposable
Windows runners and exercises the real installed MCP/Setup backends, all-accept
and decline/retry paths. This tests the recovery half, not a signed installer
handoff or automatic restart across two releases. Run 35094977239 caught a real
startup race: transport-ready arrived before Setup's first requirements scan or
MCP's initial workflow released the shared native operation lease. Starting the
next view or inventory then failed. That candidate is not publishable.

Restoration now waits for the pinned companion's initial probe/workflow completion
before proceeding. A controlled-delay regression covers both apps and asserts
that neither the next app nor inventory runs early. The original four failing
native reports remain preserved; a rebuilt candidate must repeat acceptance.
Background hosted status reads and native restoration now also use the existing
discovery queue. A failing-then-passing regression proves they cannot contend for
the shared lease; mutations and workflow release are not queued behind reads.

The rebuilt installer passed all four native lanes in
[35097259476](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35097259476):
clean installation and upgrades from alpha.3, alpha.5 and stable 0.1.5, real
MCP/Setup views, seeded-record reopening, decline/retry, scoped backend exit and
settings preservation. The exact six public files were anonymously downloaded,
byte-matched and signature-verified. The public release-list response is 234,895
bytes, 27,249 below the old-client ceiling.

Separate final gates passed: [unmodified public 0.1.5 -> 0.1.6](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35099272105),
and [the new outgoing updater with both views open](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35100145403).
The latter uses current runtime source with version-only 0.1.5 metadata on a
disposable runner, never published; it updates to the exact signed public 0.1.6.
It is not labelled public 0.1.5 evidence. Native Cancel preserved both backends
and the unsaved form; approval drained old backends, automatically restarted
Hub, and reopened both real app views after permission. MCP configuration and
an unrelated Node runtime survived. Latest promotion followed both passes.

These gates must be repeated for future relevant releases. Older installed
binaries do not gain this behavior retroactively: their
current update still uses their own close-view requirement. No old release bytes,
user installations, AI settings or Unity projects were changed by this work.
