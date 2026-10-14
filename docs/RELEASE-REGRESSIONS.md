# Known Release Regressions

Required checks for Windows and Linux/Flatpak. macOS is suspended by the user's
2026-10-14 decision. Preserve its old source, downloads and evidence; do not run
Mac work as a release gate without a new request.

This list is based on reported failures and captured regressions, not a promise
of defect-free releases. Source tests do not replace the installed checks below.

| Earlier failure | Existing automated regression | Required installed evidence |
| --- | --- | --- |
| Indefinite Checking, misleading Needs attention, wrong platform label or missing Install action | `tests/startup.spec.js`, `tests/hub.spec.js` | Fresh profile with neither companion installed; explicit installed/not-installed/error states, correct platform, actionable retry |
| Squashed or partial menu highlights; misplaced terms/help/AI warnings | `tests/hub.spec.js`, `tests/usage-terms.spec.js`, `tests/hosted.spec.js` | Narrow/wide packaged view; original icons/font; centered, usable dialogs; acknowledgement actually saved and retained after restart |
| Downloaded version opens an old executable or cannot discover an update | `scripts/check-release-feed.test.cjs`, `scripts/self-update-baselines.test.cjs`, `scripts/native-self-update-lab.test.cjs` | Exact previous stable app discovers the target; Cancel changes nothing; approved signed install restarts to the expected installed hash/version |
| Old clients cannot read the growing GitHub release response | `scripts/check-release-feed.cjs VERSION --draft`, guarded `scripts/publish-hub-draft.cjs` | Real projected feed below 256 KiB with at least 4 KiB spare; preserve published installer/signature bytes; verify public discovery before latest/announcement |
| MCP update is blocked by Node processes; user has to kill unrelated apps | `scripts/hosted-release-contract.test.cjs`, native process/routing fixtures | Existing live MCP connection survives approved GUI retirement/update; new connection works; unrelated Node/AI/Unity processes remain untouched |
| Embedded apps disappear or stop opening after update | `tests/hosted.spec.js`, `scripts/native-self-update-smoke.cjs` | Both real app views open before update; native Cancel preserves them; approval closes only owned views and restores them according to the saved preference |
| Existing settings conflict, get overwritten, or vanish during consolidation | Root convergence tests, module product-settings tests, native migration lane | Exact before-images/backups, preserved unknown client entries/project/options, explicit conflict refusal, approved retirement, repeat launch and old/new transport reconnect |
| Equivalent signed runtime metadata is rejected after re-signing | `native/mcp-router` activation signature tests (`b154e36`) | Final packaged candidate repeats install/activation with retained routing metadata; valid signatures may differ, invalid signatures still refuse; no silent repair |
| Linux Setup consent depends on undeclared Zenity | `scripts/linux-dialog-backend.test.cjs`; Linux-only GTK feature selection | Actual package's native decline/retry/approve, embedded requirements and saved controls; dependency/source checks alone are not acceptance |
| A native test misses a backend spawned by a worker thread | `scripts/native-linux-components-probe.test.py` (`fefc528`) | Actual same-package retry with exact kernel image/parent/UID/start/seals and XRes/AX ownership; inventory alone never authorizes input |
| Native harness errors trigger repeated expensive rebuilds | Focused changed-harness tests, Python/script/YAML preflight | Bind test source separately from product source; reuse immutable original installers for test-only corrections; retain first failure and compact captures |

Native preflight also checks these captured boundaries:

- GTK message X titles are not necessarily AX names. Bind the captured role,
  exact context and native frame; never select a generic `Information` dialog.
- Cargo may hard-link final build output. Stage a fresh verified copy before
  strict installed-image checks; do not weaken package/resource link checks.
- Read the workflow's actual event/branch before pushing a validation ref, then
  verify the resulting run's source. A push alone is not a dispatched test.
- Preserve unrelated dpkg diversions/statoverrides. The experimental helper's
  reject-any policy still needs a reviewed target-scoped contract before it can
  support normal hosts; do not clear global system records to make tests pass.

## Still Open

- Linux privileged update authentication/cancellation and exact installed restart
  are not accepted. See [the source audit](LINUX-UPDATE-AUDIT-014.md). A small
  sealed-input mechanism fixture is not user-authentication or signed-update proof.
- Linux legacy retirement helper is nondefault experimental source, not enabled
  production migration. Setup and other package formats need their own contracts.
- Flatpak package/GUI/stdio fixtures do not prove access to existing host settings,
  AI configuration, Unity projects, migration or a supported update remote.
- New product bytes must repeat relevant native acceptance. Passed older packages
  cannot be relabelled as acceptance of newer code.

Follow [the current integration evidence](UNIFIED-UPDATE-INTEGRATION.md) and
[the publication checklist](HUB-PUBLICATION-CHECKLIST.md). Do not clear a release
blocker merely by changing a readiness field or narrowing an assertion.
