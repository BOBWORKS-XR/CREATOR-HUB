# Unix Hosted Acceptance

This is a **blocked prerequisite probe and synthetic contract fixture**, not a
full native hosting test or release acceptance. Target versioning is owned by
the main integration task. Every report keeps `passed=false` and
`releaseReady=false`, including a successfully inspected native package.

## Current Source Contract

The relevant worktree is `creator-hub-platform-review`. The requested workflow
name `experimental-unix-packaging.yml` does not exist here; its actual counterpart
is `.github/workflows/unified-unix-candidate.yml`. The builder entry is
`scripts/build-unified.cjs`, using `--experimental-unix --installer`.

Confirmed intentional gates, not harness defects:

- The builder forces Unix MCP read-only and revision-2 events. Hub has no
  `experimental-unix-hosting` feature. The backend's same-named feature does not
  automatically enable the Hub or grant migration authority.
- `hosted_unix.rs::require_managed_route` rejects direct writable Node targets.
  Writable hosting requires the signed managed route and its verified payload.
- `main.rs::review_existing_client_connection` and
  `review_existing_client_connections` reject non-Windows, even with the backend
  experimental feature. Their internal module check remains mandatory.
- `product_settings.rs::native_review` also explicitly rejects Unix. No direct
  `Plan::apply`/settings-writer call may stand in for these native commands.
- The existing full `native-builtin-smoke.cjs` and `native-window.ps1` are
  Windows-only. There is no reusable Unix built-in GUI/native-dialog adapter in
  this worktree. The separate-app maintenance helpers are not a built-in driver.

## Delivered Probe

`unix-hosted-acceptance.yml` checks the fixture on finite four-file PR changes.
Only explicit manual inputs allow candidate inspection on disposable Linux x64,
Mac ARM64 or Mac Intel runners. No workflow was dispatched by this task.

The caller supplies reviewed run/artifact IDs, source and build commits, exact PR
base parent when applicable, and independently reviewed ZIP SHA256. The probe
checks repository identity, workflow path, successful native job/run attempt,
source/merge tree and ordered parents, artifact label/digest/size, then the actual
ZIP bytes. Nested live PR head metadata is not used as immutable source proof.
Changed compiled product/helper paths fail before extraction. Nothing defaults
to an old candidate, guesses a run, signs a package or searches for a key.

Only three metadata files and one DEB/DMG are extracted from the ZIP. Native
package extraction reuses `unix-package-payload.cjs`: no installer executes.
The exact Hub hash and embedded descriptor are checked. Linux raw archive hashes
are checked with the existing bounded Rust decoder; Mac resources and the actual
app code seal are verified, not re-signed. macOS uses the existing unique
read-only DMG mount/owned detach contract. Tools compile only on disposable CI.
The final receipt is blocked and exits nonzero. Earlier failures remain failed;
original receipts are never replaced. Only the bounded receipt is uploaded.

## Necessary Experimental Admission

Main must review feature-scoped Unix admission for **all three native review
commands**, not just MCP startup. Production/default builds must still refuse.
Keep native decline/approval, per-operation ownership, stale-snapshot refusal,
exact before-images, journals/recovery, signed retained routing, kernel-backed
payload use, direct-parent verification and private inherited pipes intact.
Do not introduce a test-parent, dialog auto-approval, direct mutable target,
production signing-key access or migration/storage injection to make CI pass.
The Unix Hub producer also needs a reviewed experimental hosting mode and a
package manifest/receipt that honestly distinguishes it from read-only output.

Before a full driver is implemented, agree a narrow native action/evidence
contract: exact owning PID/start time/executable hash, native dialog/window
identity before and after each action, one enabled exact control, completion
receipts, and normal close/exit with owned descendants absent. Linux can reuse
AT-SPI/X11 ownership primitives after adapting only the test driver; Mac needs
the equivalent AX permission and process-identity proof on disposable runners.
Failure to establish those identities must remain a refusal, not title matching.

The future native sequence is fresh plus upgrade/skip-version isolated profiles:
decline leaves backend exited, settings/client/project before-images unchanged
and retry enabled; retry obtains real native approval and opens MCP and Setup;
MCP `get_hosted_snapshot` and Setup `get_recipe` are harmless initial probes.
Native reviewed settings/client operations need separate decline, approval,
exact-backup, unrelated-entry, stale-file and idempotence cases. No AI account,
SDK/Editor download, paid call or actual Unity project is involved. An unrelated
synthetic Node process must retain PID/start/hash across normal owned closure.
All writes stay under isolated runner profiles/project fixtures; no live client
settings or home directories are copied. Never upload entire profiles.

The receipt fixture tests only this sequence's invariants. It cannot establish
native consent, execute a backend, activate a router or promote a release.
Full native GUI, migration, operation, process lifetime, signed update and product
acceptance remain uncaptured. The native feature and producer changes are main's
prerequisites, not part of these four test-only files.

## Checks

```sh
node --test scripts/native-unix-hosted-acceptance.test.cjs
```

Primary references: [GitHub artifact API](https://docs.github.com/en/rest/actions/artifacts),
[attempt-specific workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt),
and [Apple code-seal verification](https://developer.apple.com/library/archive/technotes/tn2206/_index.html).
These describe acquisition/verification contracts, not tested product support.
