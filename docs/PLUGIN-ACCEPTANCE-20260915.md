# Plugin acceptance - 2026-09-15

Public import enablement remains off pending packaged desktop acceptance.
The Windows helper-publication failure below has now been captured and addressed
with bounded recovery; see [the follow-up report](WINDOWS-HELPER-PUBLICATION-20260915.md).
Browsing and verified downloads are available; no new public Hub/Setup/MCP release
was made by this acceptance pass.

## Confirmed Passing

- Hub: 109 Playwright tests, including four viewport sizes, visible project
  loading, cancellation, stale metadata and category/scope route rejection.
- Setup: 59 Playwright tests. Final shared native community suite: 27 passed,
  four explicit acceptance/fixture tests ignored, including the separately run
  filesystem stress diagnostic described below.
- Hub release harness: 11 Node tests. Strict production Clippy passed.
- Native archive review: supplied Start Location bytes parsed as five assets,
  two code files and one scene. No extraction into a user project.
- Harmless native-writer-to-Unity import acceptance passed in both versions:

| Unity | Frozen fixture | Cancel | Text | C# reload |
| --- | --- | --- | --- | --- |
| 6000.3.21f1 | plugins-native-TEKXhF | passed | passed | passed |
| 2022.3.39f1 | plugins-native-YneS7F | passed | passed | passed |

Fixtures are under
`C:\Users\bobman\creator-works-mcp-community\launcher\artifacts`.
Each `interactive-result.json` records `passed: true`, statuses
`cancelled/imported/imported`, compiled type/value verification and an assembly
reload after the third import started. The test verified the cancelled file is
absent, text is exact, the C# constant is 42, and no active review remains.
Both were closed with the fixture's normal Verify and close action. No receipt
was edited and no failed/old fixture was reset or replayed.

These frozen fixtures contain helper SHA-256
`bd2790ca3ef332924d918111925cf07277ef26fee63c51e736b5ecbed7fa52db`.
They prove the write-once receipt and import-routing baseline, not the later
selected-assets organizer or a newly packaged desktop installer.

## Captured Failure Before Recovery Fix

The full Hub native run returned 84 passed, one failed, eight ignored. Failure:
`community_project::tests::status_derives_review_without_writes_and_prefers_immutable_final_receipt`
failed while installing the helper, before receipt assertions.

Previously the installation message omitted the operating-system error. The
diagnostic now preserves it. A bounded four-worker/100-install stress run
reproduced one publication failure:

`Could not add the Unity helper: Access is denied. (os error 5). Existing files were not replaced.`

The failed disposable root was retained at
`C:\Users\bobman\AppData\Local\Temp\.tmp0PNGm7`.
No production retry, overwrite fallback or security-setting change was added.
The next useful diagnostic is a bounded filesystem trace around the staging
directory rename. Whether sharing, ACLs or a filesystem filter is responsible
is unknown; do not label this an antivirus problem without capture.

## Package Compatibility Finding

Read-only inspection by the MCP task found that the bundled SpaceSettings graph
references external GUID `453c62796946b9a459a4de35eaac2306`, absent from the archive
and both inspected project asset/package caches. Its serialized graph matches
the installed SDK samples, so this is not evidence of an importer namespace bug.

Lookout currently has Creator SDK 3.2.17, Unity 6000.3.21f1 and URP 17.3.0;
the SDK declares URP 17.4.0. Burger/Blamb has Banter 3.1.2 and Unity 2022.3.39f1.
Nothing was upgraded to make a test pass. The archive's 4.0.14 sample folder name
does not establish compatibility. Its graph was not adopted into either scene.

## Still Required

- Verify the import-enabled packaged desktop workflow before enabling the
  public desktop install/import controls. The source-level Windows publication
  fix passed the follow-up native and stress tests linked above.
- Exact final packaged-app acceptance and installed upgrade testing. Earlier
  installers and earlier passing runs do not cover changed source hashes.
- A complete dependency review before claiming Start Location works in Banter
  or Creator SDK projects; headset/gameplay behaviour remains untested.
- Real macOS/Linux acceptance. Windows tests do not establish those platforms.

## Selected Asset Organization

Batch-tested organizer helper SHA-256:
`863e87dcfe1fceb3ed6ed235c770ef5bb7e60585e81a2a2b0aed7ba378437f71`.
This revision was shared by Hub, Setup and MCP. The receipt/import implementation
is unchanged from the frozen interactive baseline; the organizer is separate.

Actual Unity batch results each passed 31 checks, under the MCP worktree's
`artifacts/plugins-organization-6a15d5c1` (2022.3.39f1) and
`artifacts/plugins-organization-34a759ff` (6000.3.21f1).

Checked default folder creation and reuse of Assets/VS, ScriptGraph/StateGraph
and prefab GUID/reference preservation, collisions, stale GUID/destination,
no writes during preview, preservation of a dirty scene and unchanged receipts.
The dangling-metadata-link test could not create an OS symlink and explicitly
reports `danglingMetadataLinkTested: false`. Do not count that branch as tested.

Organization is an explicit Project-window selection followed by a move preview.
It does not identify or move an entire imported dependency tree. Scripts,
scenes, sub-assets, folders and Package Manager content are rejected. If a move
fails partway, the count is reported without an automatic retry or rollback.

### Final Preview Acceptance

The first actual preview was too tall and partly outside the main Unity window.
A geometry-only change now centers a bounded window within Unity's main window,
including a main window on a monitor with a negative desktop origin.

Final shared helper SHA-256:
`d7ebb4482f1194a51ad85789f11b60e9525a310b3d3b3893d9624bd22b4aa85a`.
Both Unity reference compilations and the 93 pure protocol/policy checks passed
for this revision. The 31-check-per-version batch results above predate this
geometry-only change; they are not relabelled as tests of a different hash.

Actual Unity 6000.3.21f1 UI review used a fresh isolated fixture:
`artifacts/plugins-organization-ui-20260915-r2` in the Hub worktree.
The source/destination preview, warning and both action buttons were fully
visible within the main window. Clicking Cancel followed by the fixture's
verification action produced `ui-cancel-result.json` with `passed: true`:
the graph stayed at its original path with its original GUID, and the proposed
Visual Scripting folder was not created. The fixture closed normally.
No user project was changed by this test.

### Incorporation Guidance

Every listing's details now include category-specific incorporation steps in
addition to its author's usage instructions. Graphs and prefabs use explicit
selected-asset organization; scripts, scenes and dependencies keep their package
layout. Editor tools preserve Editor/assembly boundaries. Recipes, MCP tools and
AI skills use instructions for their intended environment, not Unity Assets.
There is no automatic AI-client configuration or third-party code execution.

The final community JS, CSS, Rust modules and Unity helper were hash-compared
and match across Hub, Setup and MCP. The native archive inspector SHA-256 is
`a39f81d0ef1f99325f1d62f8bed6a22d6820445312fc5ab9d65892de1ac557dd`.

## Local Candidate Only

The final Hub installer was built with the final helper above at:
`dist/Creator-Hub-0.1.0-alpha.7-Plugin-Review-20260915-R2`.
The existing reviewed hosted-app pins were retained. Public project-write
controls remain disabled. Setup and MCP installers were not rebuilt in this
final packaging step, and no installed app or public release was overwritten.

- Installer SHA-256:
  `4d545dbe7b0e5bcab79d982a7fd2da5d62bfc483bf3f1fb248e3c009f695044e`.
- Actual executable extracted from that installer and its packaged preflight
  executable both have SHA-256:
  `edc576e6efb0ee4b8b650386790034d7e2f8f7762d0088e1c75bb6e951e6e47f`.
- The separate raw executable has a different hash because it is not the
  extracted NSIS payload; it is not substituted for installer verification.
- `artifacts/installer-guard-9ee73954ad284274970d679884b83150/report.json`
  records `passed: true`, exit 10, no install section reached, existing processes
  preserved, and `/UPDATE` refused while Hub was running. The owned fixture
  exited cooperatively with exit 0.
- `updateAcceptedAfterExit` is null because an existing Hub was running. This
  refusal test is not successful-upgrade or full installed-app acceptance.

At the R2 checkpoint a scoped filesystem trace was awaiting approval. The later
approved trace, recovery implementation and R3 local build are recorded in the
follow-up report. No Windows security setting was changed.
