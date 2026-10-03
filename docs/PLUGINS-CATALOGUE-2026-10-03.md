# Plugins catalogue investigation

## Confirmed failures

- Desktop transfers selected a catalogue entry with a 180-second native freshness limit. The project-dialog refresh only called `community_projects`, so it did not renew the catalogue. The new UI preflight fetches the catalogue before sending/downloading, verifies the selected entry has not changed, and the explicit project refresh also checks the catalogue. Native checksum, project identity, consent and queue guards remain intact.
- The current Unity helper reproduced only 11 of the 13 public index entries. Both `optic.warehouse-loft` and `firerat.shader` failed with `Invalid package size or checksum`. Their base listings omit `download`; Unity JsonUtility created an empty nested download object, which validation rejected before the supplemental download index could be applied.
- Unity and Hub already use the same public `SideQuestVR/Creator-Community/main/index.json`. There was no second manually maintained catalogue to merge.
- Returning focus to Hub cleared the pending-import message while leaving Send disabled. A browser regression reproduced this before the change; project refresh now restores the queued outcome and retains project warnings alongside it.
- Native approval could outlast the 180-second catalogue freshness limit and reject an unchanged package after approval. The backend now refreshes and validates the listing after approval rather than relying on the expired snapshot.

## Changes

- Preserve absent/null download semantics using the standard .NET JSON reader before validating Unity's parsed listing. Explicit malformed/duplicate download entries still fail. Supplemental downloads and paid-product metadata remain separately validated.
- Emit per-listing Unity warnings instead of silently counting rejected entries.
- Helper package version is 0.1.3. Preserve the exact v0.1.11 helper as a fixture and recognized upgrade baseline; the upgrade must back it up and must reject user-modified files.
- Add a disposable live Unity catalogue test and parser edge cases, plus browser freshness/retry regression cases.
- Compare the complete refreshed listing before queueing, including instructions and licence. Stale, removed or changed listings stop the transfer without publishing a request; cancelled approval still returns immediately.

## Evidence

- `npx playwright test tests/community.spec.js`: 65 passed.
- `cargo test --release --manifest-path src-tauri/Cargo.toml community_project::tests`: 35 passed, 3 intentionally ignored integration/stress tests.
- Final native regression run: `cargo test --release --manifest-path src-tauri/Cargo.toml community`: 60 passed, 6 intentionally ignored acceptance/integration/stress tests.
- Final targeted browser regression run: 10 passed, covering pending status after focus, catalogue refresh, changed/removed listings and retry. The earlier full 65-test run predates the additional focus regression.
- Release preflight: all 200 Hub UI tests and 127 Hub native tests passed; companion native suites passed (MCP 124; Setup 128 plus 2 identity tests). MCP's 256 server tests passed and its Hono 4.13.7 lockfile audit reported zero vulnerabilities.
- `scripts/Test-PluginsPresentation.ps1`: 73 checks passed on each of Unity 2022.3.39f1 and 6000.3.21f1, including cancellation/retry, receipt, streaming and path/checksum guards. These use disposable fixtures and callbacks, not a physically operated real-package import dialog.
- Presentation results: `artifacts/plugins-media-2022.3.39f1-70a1dd5b/presentation-result.json` and `artifacts/plugins-media-6000.3.21f1-d68ccfca/presentation-result.json`.
- `scripts/Test-UnityCatalogue.ps1`: Unity 6000.3.21f1 loaded all 13 listings with zero warnings; Loft was importable after loading supplemental metadata.
- `scripts/Test-UnityCatalogue.ps1 -EditorVersion 2022.3.39f1`: same result.
- Original failure: `artifacts/plugins-catalogue-350019fdfe704f92a3bbf86bf6e712ee/catalogue-result.json`.
- Rejection diagnostics: `artifacts/plugins-catalogue-1af34aafde8440efa0ab80b2548793dd/batch.log`.
- Passing Unity 6: `artifacts/plugins-catalogue-22b34d008d71487e8b95941a5ea396e6/catalogue-result.json`.
- Passing Unity 2022: `artifacts/plugins-catalogue-98158dba48bb405e9bcc4f488251726d/catalogue-result.json`.

## Remaining scope

Release source is committed; companion PRs are #47 (MCP) and #8 (Setup). Changes have not been released or installed into real user projects. The desktop freshness test uses mocked native responses. Real catalogue tests read metadata only and do not download/import Loft. Exact release installer acceptance remains a publication gate.

The actual Unity 6 native import test passed in `artifacts/plugins-import-e51e6b5255774be38b956a07bec28c88/import-result.json`: export a harmless text asset, remove it, queue the real archive, invoke the native dialog's cancellation action, queue a fresh retry, invoke its import action, verify exact restored bytes and a durable imported receipt, and confirm no scene save. Native actions are automated through the editor's own wizard, not physically clicked. The first fixture run failed on Unity's normal ExitGUI exception; the harness now handles that signal only. Original evidence remains in `artifacts/plugins-import-1eee901d7e3342a7adfab163c6176f36`.

Unity 2022.3.39f1 passed the same actual-package cancellation/retry checks in `artifacts/plugins-import-df3330938f134876bdbfa3fe34e4d0f0/import-result.json`. Its wizard uses DoNextStep rather than Unity 6's DoImportStep; the harness follows the published version-specific editor contract. The initial unsupported-method attempt is preserved in `artifacts/plugins-import-bc89143b7c894a4081eb0ae679ac4092`.

The report's intermittent visual distortion and incomplete "Visual Scripting scene variables" comment remain unclassified without a screenshot or exact reproduction. Post-approval revalidation has automated coverage, but a physically operated approval lasting more than three minutes has not been tested. No published files, installed applications, or real Unity projects were changed.
