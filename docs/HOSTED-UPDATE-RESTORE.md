# Hosted Views Across Hub Updates

Candidate 0.1.6; not published. User report: installed 0.1.4 refuses a Hub update
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

Local baseline: 168 UI tests and 111 Rust tests passed, with nine opt-in Rust tests
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

The signed public self-update gate must be repeated before any release is called
ready. Older installed binaries do not gain this behavior retroactively: their
current update still uses their own close-view requirement. No released bytes,
user installations, AI settings or Unity projects were changed by this work.
