# Contribution checks before publication

Proposed next phase, not a deployed scanner. No package has been uploaded to a
scanning provider by this work. A listing or matching checksum is not a malware
verdict, and no scanner proves that Unity editor code is harmless.

## Recommended flow

1. Receive submissions into private quarantine storage, not the public CDN.
2. Record SHA-256, size, author, licence, declared Unity/SDK versions and contents.
   Enforce archive size, expansion, member-count and path limits. Reject links,
   traversal, encrypted/unsupported members and partial scans.
3. Scan the original archive and safely extracted contents with an up-to-date
   ClamAV engine. Record engine/signature versions, timestamp and full results.
   Flag C#, assemblies, native binaries, editor callbacks and install scripts for
   code inspection. Graphs and prefabs can also reference executable behaviours.
4. After static/code review, import in a disposable Unity VM with no personal
   projects, credentials, shared folders or production access. Restrict network
   access, record compile/import results and destroy the VM after the test.
   Unity licensing and the actual test machine still need to be arranged.
5. A maintainer approves the exact hash and compatibility evidence. A separate
   trusted publication job copies those exact bytes to an immutable CDN URL and
   publishes the listing. Changed bytes require the checks again. Keep a way to
   withdraw a listing and invalidate cached catalogue data.

ClamAV supports archive scanning and archive-bomb limits. Scan errors or exceeded
limits must remain unverified, not be treated as clean:
[ClamAV documentation](https://docs.clamav.net/),
[scanning options](https://docs.clamav.net/manual/Usage/Scanning.html).

GitHub can coordinate submission validation, evidence and maintainer approval.
Do not run submitted scripts with publication credentials, or use privileged
`pull_request_target` / `workflow_run` execution for untrusted code:
[GitHub secure use guidance](https://docs.github.com/en/actions/reference/security/secure-use).

## Optional external scanning

VirusTotal can add a second signal, but its standard upload service is not private.
Confirm contributor permission before sending their files there. Its private
scanning product explicitly keeps uploads from third parties; that requires the
appropriate licence. Public API use also has restrictions, so do not assume that
the free endpoint is suitable for a product's automated workflow.

[VirusTotal private scanning](https://docs.virustotal.com/docs/private-scanning),
[API restrictions](https://docs.virustotal.com/docs/api-overview).

## User experience

Published Unity packages use **Import into project**, which downloads/verifies
the bytes and opens Unity's standard file selection window. This selection still
matters for collisions, scenes and scripts even after maintainer approval.
Cancellation must leave a retry action, reuse verified cached bytes, and preserve
the original receipt. No silent scene saves or automatic retries.

Show specific evidence such as scan date and tested Unity versions when available.
Do not show an unconditional "safe" or "verified compatible" badge without the
corresponding evidence.
