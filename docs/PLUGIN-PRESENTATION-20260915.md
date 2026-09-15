# Plugin presentation and import follow-up

Source-only work on 2026-09-15. Installed Hub alpha.8 and the user's open Unity
project were not replaced. No installer, tag, push or release was produced.
Publication remains on hold pending the user's alpha.8 feedback and approval.

## Changes

- Normal Hub launch and the Creator Hub drawer entry open Projects. Apps and
  direct MCP/Setup destinations remain available.
- Plugins uses a gray Hub cube with a cyan/red puzzle overlay in the shared app
  navigation. The source SVG is `src/icons/creator-plugins.svg`.
- The Unity catalogue shows a thumbnail, name, contributor and short description
  without opening Details. Thumbnail downloads/cache are bounded and independent
  of the package action request.
- Import into project downloads/verifies the package and opens Unity's normal
  file-selection dialog directly. No extra community review modal. An inline
  code/import notice remains visible on both tabs; checksums are not a malware
  verdict. Unity file-selection consent and no automatic scene saves remain.
- Cancellation promptly refreshes the receipt and offers Try import again in the
  same window. Retry uses a new request identity and preserves the old receipt.
- Retry refuses withdrawn, changed or instructions-only listings, including those
  whose download metadata has been removed. Cached bytes are verified again.

Final shared helper SHA-256:
`a4bfcccab06cf0df0ba1dac389158bf15d13e4ead9aff17f086f013d82669b22`.

The Hub and Setup source copies match this hash. The BANTWORKS MCP task also
verified and synchronized this exact helper and the shared icon into MCP source,
with 26 focused source/contract/chrome tests and 22 headless browser groups
passing. Its report is `artifacts/plugins-source-review-20260915/README.md` in
the MCP checkout. No installed MCP server is changed by this work.

## Automated evidence

- Hub full Playwright suite: 112 tests passed, using the real local Setup and MCP
  frontend sources through `CREATOR_SETUP_SOURCE` and `CREATOR_MCP_SOURCE`.
  `test-results/.last-run.json` records passed with no failed tests. This includes
  icon pixel checks, responsive layouts and Projects-default routing.
- Setup full Playwright suite: 59 tests passed; its last-run record is also passed.
- Hub `cargo test --release --manifest-path src-tauri/Cargo.toml`: 93 passed,
  0 failed, 9 explicitly ignored network/live/opt-in acceptance tests.
- Final helper: 34 checks passed in each installed Unity version, using
  `scripts/Test-UnityPresentation.ps1 -EditorVersion <version>`:
  - `artifacts/plugins-presentation-6000.3.21f1-56061fff/presentation-result.json`
  - `artifacts/plugins-presentation-2022.3.39f1-c238ac7a/presentation-result.json`

Unity checks cover bounded summaries/thumbnails, image cleanup, catalogue
revalidation and withdrawal, null-download retries, cancellation receipt cleanup,
immediate completion refresh, fresh retry identities, preserved receipts and
corrupt-cache rejection. Callback-state assertions alone are not native-dialog
interaction proof.

## Actual Unity interaction

With the user's permission, a separate disposable Unity 6000.3.21f1 window used:
`artifacts/plugins-presentation-ui-c7dd5664`.

The fixture displayed Egon's credited preview metadata but imported only a
locally generated harmless text file, not the community package or third-party
code. The actual card opened Unity's standard import dialog. Clicking Cancel
immediately showed the cancelled state and Try import again. Clicking that action
reopened the dialog without reopening Creator Plugins; clicking Import succeeded.
The original cancellation receipt remained intact. At approximately 422px window
width the image, title, author and short description fitted without overlap.

`interactive-result.json` records `passed: true`, statuses `cancelled` and
`imported`, `textMatches: true`, and `noActiveImport: true`. The test window then
exited normally through its fixture-only exit marker. The user's original Unity
project remained open and unchanged.

This physical test used helper hash
`83c30dc489f758f68f9869b11deb66f729d7d3ead7899a67be14b47d2dfe850b`.
The final helper adds only the null-download eligibility guard and the always
visible code/import notice; those changes passed the 34-check reruns above.
The final notice's native layout was not separately recaptured. C# domain reload,
Unity 2022 native dialogs, macOS/Linux and a new installer upgrade were not
retested in this follow-up.

## Before the next release

- Existing Unity projects retain the old helper until explicitly updated. The
  current native installer correctly refuses to overwrite different helper
  files. Add a reviewed known-version upgrade/backup path, retaining protection
  for locally modified or unknown files, before promising seamless helper updates.
- The Unity-side queue writer has no 100-entry capacity guard, while its reader
  stops after 100 and the native desktop queue already enforces that limit.
  Repeated cancelled/retried requests can reach this pre-existing limit. Add a
  bounded writer and deliberate receipt-retention/cleanup flow; never silently
  delete history or write an unobservable 101st request.
- Preserve a separate release acceptance gate for the exact packaged helper,
  installer upgrades and C# reload behavior. Old alpha.8 acceptance is not proof
  for these changed bytes.
- Pre-publication scanning is a proposal only; no files were sent to scanners.
  See [publication checks](PLUGIN-PUBLICATION-CHECKS.md).
- Moving Project Setup into Hub is next-phase planning only. See
  [Project Setup in Hub](PROJECT-SETUP-IN-HUB.md).
