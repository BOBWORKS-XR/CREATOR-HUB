# Hub 0.1.2 to 0.1.3 Update Discovery Repair

## Confirmed Failure

The original public `releases?per_page=10` response was 263,624 UTF-8 bytes.
Installed Hub 0.1.2 refuses responses above 262,144 bytes. Publishing 0.1.3's
notes and attachments pushed the release list beyond this limit. The signed
descriptor and installer were valid; the earlier public-download verification
did not exercise the release-list request that comes before them.

## Repair and Evidence

Only the GitHub release **body text** for 0.1.2 and 0.1.3 was shortened. Full notes
remain in their linked repository documents. All 148 assets across eight Hub
releases retained the same IDs, names, lengths and hashes. No installer, signed
metadata, checksum, existing tag or user installation was replaced.

The response is now 260,138 bytes. The before/after captures reproduce failure
and success at the old limit. `verify-discovery` executes the same catalog code
as 0.1.2 (no diff) and finds signed compatible 0.1.3 in both stable/preview modes.

[Native acceptance run 35079200231](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35079200231)
passed on a disposable Windows runner using unmodified public installers:

- Actual installed 0.1.2 discovers public 0.1.3 and enables Update Hub.
- Native Not now preserves the running app and its existing files.
- Actual Update Hub consent exits 0.1.2, installs exact 0.1.3 and automatically
  restarts it, with no manual launch by the harness.
- The restarted footer and uninstall registry show 0.1.3; saved browser storage
  and an unmanaged installation file survive. Test-only browser policy is removed.

This closes the previously untested **0.1.2 -> 0.1.3** in-app self-update path;
it does not prove all historical versions, operating systems or client policies.
The user's local app/settings/projects were not changed by this test.

Evidence is under `artifacts/release-feed-0.1.3`; the native report and screenshots
are also attached to the linked CI run. Future publication must
follow [Required Hub Release Gates](RELEASE-GATES.md), including the new
pre-publication response-size/headroom check and real old-client restart test.
