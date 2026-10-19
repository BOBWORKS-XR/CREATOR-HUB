# Next Non-Mac Release

User request, 2026-10-19: remove Creator Plugins from the app and release Windows
and Linux, including Flatpak. macOS remains suspended. This is a release plan,
not approval of untested packages or a publication receipt.

## Product Change

- Plugins menu items, retirement pages, app help entries and catalogue asset
  loading are removed from Hub and both legacy module interfaces.
- The former website command permanently refuses; it does not depend on a clock
  or launch a browser. The obsolete Flatpak RPC route is removed.
- Existing Unity projects, imported assets, historical helper installations,
  import receipts and cancellation/recovery evidence are not deleted.
- Historical catalogue/adapter tests now use isolated test-only fixtures.
  The source gate rejects reintroducing the removed app interface.

## Version And Publication

- Public 0.1.14 remains unchanged. Its qualification is Windows-only and binds
  exact previously accepted B05 assets; it cannot approve new source or Linux.
- Never publish private 0.1.15 acceptance-fixture bytes. A fresh 0.1.16 is the
  proposed next public candidate, subject to checking version/tag availability
  and building/qualifying new bytes. No version bump or tag is made by this note.
- Extend finite production qualifications only from actual new evidence, with
  public Windows 0.1.14 as the incoming stable baseline. Do not repurpose the old
  receipt, relabel a test package or bypass the guarded publisher/feed budget.

## Outstanding Platform Gates

1. Windows: exact direct-page installer, migration/retirement, signed incoming
   update and automatic restart against the final new candidate. Local read-only
   page tests do not replace these release gates.
2. Linux DEB: actual system cancellation, authorized signed installation,
   automatic restart and preservation; production legacy-app retirement remains
   experimental/default-refused. RPM/AppImage automatic replacement remains
   unsupported and must not be advertised as accepted.
3. Flatpak: qualify disclosure Cancel, owned warm/cold activation, host version
   binding, signed update/reactivation and safe removal. The native-window
   launcher currently depends on a DEB-installed host, not a self-contained
   SteamOS package. The tested Deck lacks required WebKit libraries.
4. Publish all requested non-Mac platforms only after their final exact bytes
   pass. Preserve original failed reports and historical release assets.

## Linux Harness Diagnosis

Run 39139434211 failed before approving the Hub update: its generic bitmap helper
refused the legitimate main window plus update confirmation, both owned by the
same Hub PID. Later broker cleanup masked this as Owned process is not live.
This establishes a harness error, not a product crash. Modal-specific capture,
bounded authentication-window capture and original-error retention now pass
38 pure regression tests. Native repetition is still required; the existing
capture-only workflow does not approve system authentication or install updates.

Flatpak run 39138975316 stopped at AT-SPI/launcher PID provenance before disclosure
input. Corrected bus-peer/namespace observations pass 35 pure regressions, but
are not accepted activation and do not resolve the separate missing SteamOS
host dependency/packaging implementation.

The first source CI run after Plugins removal exposed two prerequisite gaps:
the Unix writer fixture did not include the real integration-context module,
and the frontend job had not built the refusal-only helper needed by its Node
tests. Both have explicit source/workflow regressions. Superseded hosted-app
Unix packaging is disabled while direct integration is required; Linux source
checks remain active and Mac jobs remain disabled.
