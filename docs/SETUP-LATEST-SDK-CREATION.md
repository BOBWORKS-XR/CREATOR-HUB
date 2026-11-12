# Latest Stable SDK Creation

## Status: 2026-11-11

Implemented locally; not published. Final-source native creation passed with
SDK 4.0.25. Final preference verification remains pending because a separate
Unity Editor reopened before the guard could capture its after-image.

The Hub new-project page checks the stable SDK, records an exact selection and
re-verifies its metadata before prerequisites or project writes. An unavailable
lookup offers Retry or an explicit tested fallback. No fallback is automatic.
The chosen SDK and Visual Scripting versions are pinned in the new manifest and
verified after Unity reopens. Existing-project repair is not rerouted through
this code. The existing Unity/build-tool recipe remains fixed.

Missing or non-exact required dependency metadata is refused. Newer required
tool versions are refused before project creation, except the documented
Unity 6000.3.21f1 / declared URP 17.4.0 / selected URP 17.3.0 combination. That is
a per-new-project validation trial, not SDK-wide compatibility approval. The
Hub shows the difference and success requires compilation, the SDK's readiness
check, valid Creator node payloads and a second-process validation.

## Checks

- Setup Rust suite: 244 passed, 20 opt-in runtime tests not run by that suite.
- Integrated Hub feature-routing tests: 7 passed.
- Integrated Hub release-profile cargo check: passed.
- Direct Setup UI: 62 passed; inherited integration subset: 49 passed.
- Desktop and mobile SDK-selection/URP-note layouts reviewed.
- Final-source real Unity creation, package import, registration and reopen: passed.
- Reopened SDK readiness was Done; all 52,183 node payloads validated, including
  190 Creator nodes. SDK 4.0.25 and Visual Scripting 1.9.1 were pinned and read back.
- The preceding successful run verified exact unchanged shared preferences.
  The final run's preference verification is not yet complete; no restoration
  was attempted while the other Editor was open.

The first two native runs failed because URP's startup material-upgrade dialog
was invoked in batch mode. The correction runs the real package upgrader/save
before Visual Scripting, checks errors before saving its completion state and
afterward, and checks the persisted upgrade on reopen. No upgrade marker is
manually fabricated and no error is filtered out.

Retained evidence:
- First failure: `%TEMP%/creator-latest-sdk-creation-jXl2C3`
- Diagnostic failure: `%TEMP%/creator-latest-sdk-creation-a1A1IQ`
- Successful intermediate run and exact preference check:
  `%TEMP%/creator-latest-sdk-creation-MP9m1w`
- Final-source successful flow, source hashes and pending preference check:
  `%TEMP%/creator-latest-sdk-creation-xzNrmk`

## Native Acceptance

Do not close another person's Editor. Save and close all Unity Editors before
running the preference-guarded test, including the Backrooms editors identified
in this chat. The guard refuses to start or restore while any Editor is running.

```powershell
node scripts/test-latest-sdk-creation.cjs --approved-vs-preferences-restore
```

This creates a new temporary project through the production creation path. It
does not install missing Unity prerequisites, reuse an existing project folder,
or publish a release. It verifies exact SDK versions, both Unity passes, receipt
and Unity Hub registration. The new test project is retained and may appear in
Unity Hub. Before/after snapshots and logs are retained beside it; the guard
restores only the exact approved Visual Scripting preference values and refuses
unexpected drift. It never resets entire settings folders or kills Editors.

Do not claim native acceptance from mocked UI tests or package compilation.
The production release and installed Hub are unchanged by this work.
