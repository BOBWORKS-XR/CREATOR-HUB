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
   The tagged-release workflow now runs this same check after packaging and
   checksum assembly, so a green package matrix cannot be mistaken for a
   discoverable in-app update.
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
6. When changing outgoing update/hosted-view behavior, also exercise that new
   code with real app views open: native Cancel preserves forms/processes;
   approval closes only owned backends; the signed target installs and restarts;
   saved views reopen and settings/unrelated runtimes survive. A clearly labelled
   version-only disposable fixture may exercise new outgoing code before a later
   release exists. Never publish its bytes or call it unmodified-old-app evidence;
   it does not replace step 5. Seeded recovery records alone are insufficient.
7. Only after those exact runs pass may the release be marked latest and
   announced ready. Store the run link/report in repository docs, not extra
   release attachments that could push the API over its limit after testing.

Not marking a release latest does **not** hide it from clients that enumerate
releases. The pre-publication budget check is essential; the post-publication
native test validates the final public route before claiming completion.

After the 0.1.5 publication, the feed is 251,681 bytes, 10,463 below the legacy
ceiling. Eleven 0.1.3 diagnostic attachments were consolidated into one
byte-verified ZIP before publishing; installers, signatures and updater metadata
remain unchanged. All 144 retained historical assets matched the pre-publication
snapshot. This is not a permanent budget: the next draft must pass its own
projected-response check before publishing. Do not increase a new binary's limit
and assume already-installed older versions are repaired. See
[0.1.5 acceptance and original failures](RELEASE-0.1.5.md).

After 0.1.6, the latest-ten response is 234,895 bytes (27,249 headroom). The
publication used six assets and did not alter historical files. Both the exact
previous stable upgrade and the new updater with real hosted views passed;
see [0.1.6 evidence and fixture distinction](RELEASE-0.1.6.md). Future releases
still require their own budget and installed-path checks.
