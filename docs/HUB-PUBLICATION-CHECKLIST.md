# Required Hub Release Gates

Do not declare a release ready based only on unit tests, signed asset downloads
or silent installer upgrades. Hub 0.1.3's initial publication demonstrated that
those checks can pass while the installed 0.1.2 updater cannot discover it.

1. Build and test the exact installer against supported installation baselines.
   Keep installer/installed executable hashes and original reports. Do not
   overwrite an already published installer or signed descriptor.
2. Upload the reviewed files to a **draft**. Keep public notes short with links
   to full notes; bundle future diagnostic reports instead of multiplying assets.
   Each asset adds to the JSON response that existing clients must download.
3. Run `node scripts/check-release-feed.cjs VERSION --draft`. This reads the
   real draft and public GitHub API, projects the latest-ten release response,
   enforces the installed clients' 256 KiB limit, and requires 4 KiB spare room.
   Do not proceed on failure. Existing published clients cannot receive a fix
   through an update they are unable to discover.
4. Publish with `node scripts/publish-hub-draft.cjs VERSION`, not an unguarded
   `gh release edit --draft=false`. The command repeats that preflight before
   writing, verifies the public feed afterwards, and does not mark latest or
   report readiness. Failure is a release blocker, not permission to bypass it.
5. Update the source/target versions and exact hashes in
   `scripts/native-self-update-smoke.cjs`, then run **Public Hub self-update
   acceptance**. It must match the intended package version and the previous
   public stable. Test the actual old app's discovery, enabled Update Hub button,
   native cancellation, approved download/install, automatic restart, installed
   hash, footer/registry version and saved preference/content preservation.
6. Only after that exact run passes may the release be marked latest and
   announced ready. Store the run link/report in repository docs, not extra
   release attachments that could push the API over its limit after testing.

Not marking a release latest does **not** hide it from clients that enumerate
releases. The pre-publication budget check is essential; the post-publication
native test validates the final public route before claiming completion.

As of the 0.1.3 metadata repair, the current feed is 260,138 bytes, only 2,006
below the legacy ceiling. That repairs the installed updater but deliberately
does not satisfy the stricter future-publication headroom rule. The next draft
must reduce the projected response before publishing. Do not increase a new
binary's limit and assume already-installed older versions are repaired.
