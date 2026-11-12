# Windows 0.1.22 Qualification

Product commit: `8f7916161e993d8cfc3c200e98895dda865819c4`. Tree: `78f73b22cbccf28c9ec8b6907de733e6343390e2`.

Installer SHA-256: `2bd535e7f3ea90821bb97878e5d97bfa06a90ff0127bef28f8d8a64f2eb7deea`. Installed EXE SHA-256: `73a2afa5cb2ff4fbfbb1d6458efa6d179441cb9336803228ffbc910ee3f94245`.

## Evidence

- Local R4 build log: 246 Setup tests passed (20 explicitly opt-in tests ignored), 2 packaged-metadata checks passed, 265 UI tests passed and 10 bundle tests passed. Parent also reports 5 updater-identity regressions passed. These local counts are separate from CI/native acceptance.
- Source CI [43223131122](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/43223131122): 467 tests, 466 passed, one existing optional Unity-reference compile skip; bundle 10/10. Skip: `Set CREATOR_UNITY_REFERENCE_EDITOR for the native Unity API compile check.` No failure, cancellation or todo.
- Prior disposable SDK 4.0.25 creation is reused after a scoped R4 input review, not claimed as a fresh R4 creation run. Three inputs are byte-identical: creation_sdk.rs, lib.rs and sdk_requirements.rs. ProjectSetupValidator.cs matches after CRLF/LF normalization. The only substantive logic.rs delta is the Windows project-open lock guard and its two tests; the creation path is unchanged. The original outer failure is retained; its deferred comparison subsequently matched all 38 preference values with no writes.
- Actual installed Codex read-only reference after an observed normal local restart passed. Target-generation routing and unrelated configuration preservation were checked. Personal paths, project identities, private configuration and event-stream contents are not published.
- Private native [43224351044](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/43224351044), harness `d168a8ad3cf23e1cf576e80e8ab06f6825fa47a3`, passed mcp-restore, setup-restore and setup-no-restore against the exact 0.1.21 baseline and R4 target. Report/binding/lifecycle bytes and archive membership are bound in windows-022-evidence.json. This is lab discovery, not public discovery.
- Public draft ID 442967050: six assets with independently read-back IDs, sizes and hashes. Manifest SHA-256: `0deb98984f136cf530e3d87df17f2d23f004b521329ab78b63f825fff59b99b3`. Previous latest remains the staged receipt's 0.1.21 baseline.

## Remaining Gates

Independent parent review of this metadata-only association and full inherited no-rebuild tests; current remote association/draft/feed-budget verification; explicit guarded publication; then actual anonymous 0.1.21-to-0.1.22 public discovery, cancellation, update, automatic restart and preservation across all three cases before latest promotion. No global compatibility or new live-AI coverage is inferred.

The local projection records 38 matching preference values; it does not expose the underlying private state. This metadata does not claim public acceptance or release readiness.
