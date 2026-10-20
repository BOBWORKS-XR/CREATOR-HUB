# Known Release Regressions

Required checks for Windows and Linux/Flatpak. macOS is suspended by the user's
2026-10-14 decision. Preserve its old source, downloads and evidence; do not run
Mac work as a release gate without a new request.

This list is based on reported failures and captured regressions, not a promise
of defect-free releases. Source tests do not replace the installed checks below.

| Earlier failure | Existing automated regression | Required installed evidence |
| --- | --- | --- |
| Indefinite Checking, misleading Needs attention, wrong platform label or missing Install action | `tests/startup.spec.js`, `tests/hub.spec.js` | Fresh profile with neither companion installed; explicit installed/not-installed/error states, correct platform, actionable retry |
| A startup recovery-state read fails, then Check for updates never resumes preferences, migration or feature startup after the read succeeds | `tests/portable-update.spec.js`: successful retry, repeated refusal, retained update and concurrent retry | Packaged recovery read failure followed by an explicit retry; resume startup once only after a safe state, keep retained updates blocked and do not replay installation |
| Squashed or partial menu highlights; misplaced terms/help/AI warnings | `tests/hub.spec.js`, `tests/usage-terms.spec.js`, `tests/hosted.spec.js` | Narrow/wide packaged view; original icons/font; centered, usable dialogs; acknowledgement actually saved and retained after restart |
| Known project cannot open without a separately cached Unity helper; the same warning appears twice | Root project/helper admission tests, `tests/projects.spec.js` | Fresh profile: explicit approved helper preparation, verified identity, exact Editor/project arguments; cancellation preserves files, background discovery does not download |
| Direct project selection loses active-project, SDK or per-project bridge indicators; Home retains stale badges after a change | `tests/native-pages.spec.js`, `tests/projects.spec.js` | Actual packaged rows show verified bridge states/current selection; changes preserve preferences and projects; Home refreshes after completion, including a concurrent older read, without polling or automatic failure retries |
| Consolidation requires a chain of import/migrate/finish prompts | `tests/convergence.spec.js`, native convergence snapshot/consent and recovery tests | One guide/action for the ordinary flow; backup-before-write, no duplicate projects, current preferences retained, explicit unsafe-case review and verified standalone cleanup; no replay of uncertain outcomes |
| Downloaded version opens an old executable or cannot discover an update | `scripts/check-release-feed.test.cjs`, `scripts/self-update-baselines.test.cjs`, `scripts/native-self-update-lab.test.cjs` | Exact previous stable app discovers the target; Cancel changes nothing; approved signed install restarts to the expected installed hash/version |
| Old clients cannot read the growing GitHub release response | `scripts/check-release-feed.cjs VERSION --draft`, guarded `scripts/publish-hub-draft.cjs` | Real projected feed below 256 KiB with at least 4 KiB spare; preserve published installer/signature bytes; verify public discovery before latest/announcement |
| MCP update is blocked by Node processes; user has to kill unrelated apps | `scripts/hosted-release-contract.test.cjs`, native process/routing fixtures | Existing live MCP connection survives approved GUI retirement/update; new connection works; unrelated Node/AI/Unity processes remain untouched |
| Embedded apps disappear or stop opening after update | `tests/hosted.spec.js`, `scripts/native-self-update-smoke.cjs` | Both real app views open before update; native Cancel preserves them; approval closes only owned views and restores them according to the saved preference |
| Existing settings conflict, get overwritten, or vanish during consolidation | Root convergence tests, module product-settings tests, native migration lane | Exact before-images/backups, preserved unknown client entries/project/options, explicit conflict refusal, approved retirement, repeat launch and old/new transport reconnect |
| Equivalent signed runtime metadata is rejected after re-signing | `native/mcp-router` activation signature tests (`b154e36`) | Final packaged candidate repeats install/activation with retained routing metadata; valid signatures may differ, invalid signatures still refuse; no silent repair |
| Linux Setup consent depends on undeclared Zenity | `scripts/linux-dialog-backend.test.cjs`; Linux-only GTK feature selection | Actual package's native decline/retry/approve, embedded requirements and saved controls; dependency/source checks alone are not acceptance |
| Adding Creator SDK to an existing URP project skips its nodes or loses custom Visual Scripting selections | Setup repair first-SDK tests, emitted validator contract and opt-in `unity_existing_urp_first_sdk_add_audit` | New disposable SDK-free URP project, existing VS database/custom selections, first approved repair, exact backups/content preservation and reopened validation; unit planning is not Editor acceptance |
| A Unity test uses `GREENFIELD_PROJECT` as a general SDK-startup suppression flag | Ordinary seed rejects that symbol; invalid controlled experiment/source/logs retained locally | Do not enable SDK-internal GraphEdit code requiring a patched Visual Scripting runtime or call that failure a normal package defect; test ordinary SDK startup with explicitly protected cache state |
| An SDK acceptance test changes a shared EditorPrefs cache value or reports success without running its selected test | Explicit ordinary-fixture opt-in, exact before-marker equality and retained cache-wrapper refusal mocks | Close other Editors; durably back up/read back only the named raw cache value before launch; never write on pre-launch refusal; restore only the expected SDK transition with exact readback; require exactly one passing test and independently verify project backups/content |
| Repair overwrites a late manifest edit or deletes unowned temporary metadata | Setup held-manifest/temporary-identity tests and explicit pre-Unity race probes | Exact backup retained; changed manifest or raced temporary targets refuse before launch; cleanup never adopts a same-content replacement; Unix advisory locks do not claim arbitrary-writer CAS |
| Setup displays another project's successful report, stale requirements or an earlier download's progress | `tests/native-pages.spec.js` Setup regressions | Change inspected project, install-then-fail creation, and start each operation before its first event; old paths cleared, one requirements refresh, original errors retained and no operation replay |
| A native test misses a backend spawned by a worker thread | `scripts/native-linux-components-probe.test.py` (`fefc528`) | Actual same-package retry with exact kernel image/parent/UID/start/seals and XRes/AX ownership; inventory alone never authorizes input |
| Linux WebKit paragraph roles differ from the AT-SPI client enum, hiding available text from tests | Independent producer/client enum fixtures in `scripts/native-linux-components-probe.test.py` (`f8b6e7f`) | Same-package exact decline text, Retry/approval, real Setup operation and MCP preference save; counts or screenshots alone do not authorize further input |
| A stale Flatpak writable plan fails only after expensive setup/downloads | `scripts/flatpak-replacement-source.test.cjs` (`2bc364d`) | Both input plans pass capability/provenance checks before setup; historical three-input pins remain unchanged and refuse the current writable packager |
| The Linux verifier mistakes dpkg's default Multi-Arch=no for changed package metadata | `dpkg_showformat_requires_default_multiarch_no_not_an_empty_field`, exact native query captures (`5fc08dd`) | Native baseline and compatibility metadata accepted without ignoring other fields; live MCP identity/reconnect and settings/file preservation through the package transaction |
| Container test evidence disappears because upload paths use host runner namespaces | `scripts/linux-deb-helper-transaction.test.py` (`1600b08`) | Complete preflight and transaction logs under the verified container temp path; missing evidence leaves outcome unknown, never safely failed or accepted |
| Native harness errors trigger repeated expensive rebuilds | Focused changed-harness tests, Python/script/YAML preflight | Bind test source separately from product source; reuse immutable original installers for test-only corrections; retain first failure and compact captures |
| A connection-reset event is counted as a rejected updater request | `scripts/self-update-lab-feed.test.cjs` reset/non-reset/secret-bound diagnostics | Retain bounded reset-event counts separately; all actual policy refusals and non-reset parser/TLS errors still fail. Native incoming16 run `39326247460` served all five routes with zero refusals; this is controlled discovery, not public-feed acceptance |
| Retirement fixtures miss the real Hub/Setup/MCP stores or omit preservation checks after failure | `scripts/linux-deb-retention-sdk.test.cjs`, `scripts/linux-deb-helper-transaction-sdk.test.cjs` | Eleven actual/legacy/unknown-file sentinels with exact bytes, inode, permissions and ownership, checked after success, refusal and owned-client close. Native mechanism evidence is still required |
| A portable host profile is attached to an older Root without its startup checks | `scripts/build-unified.test.cjs`, `scripts/linux-016-portable-package.test.cjs` | Actual compiled features, locked package version, source tree, ELF bytes and final AppDir inventory must bind; no profile from an older package, and no installation/Flatpak claim from packaging alone |
| Fresh Windows checkout changes exact Unix protocol/source bytes, or runs CLI tests before their binary exists | `scripts/checkout-contracts.test.cjs`, `scripts/linux-deb-helper.test.cjs`; five explicit LF attributes | A fresh CRLF checkout passes the script suite; build the refusal-only helper before assertions, without enabling transaction features |
| Frozen-source tests pass locally but fail on shallow Actions history; private fixture metadata outgrows a file-count assumption | `scripts/native-linux-update-flow.test.py` | Fetch only the exact frozen source before fixture tests; bound private metadata bytes while preserving exact selected asset IDs, hashes and signatures; native outcomes remain separately required |
| Disposable Linux fixture source sits beneath a world-writable runner ancestor | Exact public path/UID/GID/mode refusal and measured-ancestry workflow regression | Record original metadata before changes; secure only enumerated root-owned runner fixture/policy ancestors and recheck inode/ownership; do not relax the application guard or modify user machines |

Native preflight also checks these captured boundaries:

- GTK message X titles are not necessarily AX names. Bind the captured role,
  exact context and native frame; never select a generic `Information` dialog.
- Cargo may hard-link final build output. Stage a fresh verified copy before
  strict installed-image checks; do not weaken package/resource link checks.
- Read the workflow's actual event/branch before pushing a validation ref, then
  verify the resulting run's source. A push alone is not a dispatched test.
- Keep historical transport baselines explicit when the public registry advances.
  New Windows targets after 0.1.14 use its published pins; the historical public12
  and B05-to-private15 labs retain their original scope and cannot qualify 0.1.16.
- After an update, bind the new kernel process and XRes owner, not numerical XID
  uniqueness. Start a new accessibility reference scope, bind its canonical frame
  before component walks, and keep semantic parents within that owned frame.
- Once the stock authentication agent is bound, recheck its exact unique bus
  owner/PID/UID and root authority. Do not enumerate unrelated transient bus
  callers while observing dismissal. A lost bound agent still refuses.
- Preserve unrelated dpkg diversions/statoverrides. The experimental helper's
  target-scoped parser and protected-parent snapshot are implemented but not
  natively accepted. Run the unprivileged metadata gate before packages or
  privilege. Capture failed parent type/UID/mode before diagnosing; do not clear
  system records or relax permissions checks to make a runner pass.

## Still Open

- Linux native cancellation and synthetic approval passed in run 39294045915
  on frozen 0.1.14 to private 0.1.15: exact package, automatic restart, visible
  version, settings/selection preservation and normal close were verified.
  These bounded older-package results do not accept final 0.1.16 or Flatpak.
  See [the current release gates](RELEASE-NEXT-NON-MAC.md) and the historical
  [source audit](LINUX-UPDATE-AUDIT-014.md).
- Linux legacy retirement helper is nondefault experimental source, not enabled
  production migration. Setup and other package formats need their own contracts.
- Flatpak package/GUI/stdio fixtures do not prove access to existing host settings,
  AI configuration, Unity projects, migration or a supported update remote.
- New product bytes must repeat relevant native acceptance. Passed older packages
  cannot be relabelled as acceptance of newer code.

Follow [the current integration evidence](UNIFIED-UPDATE-INTEGRATION.md) and
[the publication checklist](HUB-PUBLICATION-CHECKLIST.md). Do not clear a release
blocker merely by changing a readiness field or narrowing an assertion.
