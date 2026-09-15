# Alpha.8 Release Status

Updated 2026-09-15. Not published. This supersedes the older alpha.7 blockers;
historical evidence remains unchanged.

## Passed Locally

- Hub: 93 native tests, 109 UI tests, strict production Clippy and the new
  main-window self-update permission regression test.
- Setup: 97 native tests, two binary metadata tests, 59 UI tests and strict
  all-target Clippy. Full NSIS and portable artifacts built and verified.
- Windows helper publication: 1,000 final stress installs; real reader
  contention, destination races, links, mutations and retry bounds covered.
- Actual Hub NSIS `/S /UPDATE`: installed alpha.7 to alpha.8, exit 0. Both
  executable and uninstall registration report alpha.8. Installed payload
  matches extraction; all five known JSON settings, other app payloads and
  running MCP Node processes were preserved. Start Menu target is correct.
- Installed GUI: both update preferences remain checked; native self-update
  discovery no longer fails with `hub_update_status not allowed by ACL`.
  Egon's live listing/image and all seven categories load. Project discovery
  displays its loading state and selects the exact disposable project.

## Exact Local Artifact

Candidate: `dist/Creator-Hub-0.1.0-alpha.8-Windows-Candidate-R2`.

- Installer SHA-256: `a1e0c6a5118167e001c562d7c4a563b97448cddca67ef5491f3808e440af2a5e`
- Installed/preflight EXE SHA-256: `0852a228c90644c953ddcf34900eb36ffbb2a93d962a9ea45b598809b3c599cb`
- Upgrade evidence: `artifacts/packaged-plugins-alpha8-20260915/upgrade-comparison.json`.
- Immediately before/after: `artifacts/upgrade-alpha8-immediate-before-20260915`
  and `artifacts/upgrade-alpha8-immediate-after-20260915`.
- This was the real installer, not a direct EXE replacement. In-app signed
  self-update/restart is a separate test and is not claimed here.

## Packaging Correction

Windows checkout conversion changed the embedded helper from 51,404 to 52,122
bytes. The verified C# hash is
`d7ebb4482f1194a51ad85789f11b60e9525a310b3d3b3893d9624bd22b4aa85a`;
the converted bytes hashed to
`b2596da2ab8e7c2a77734ea00ca805fe156fd2b9c0e38a1bb0340417b0097a34`.
All four embedded files now use `-text`, with the original licence bytes
explicitly committed. Working files and a simulated Windows checkout match
for Hub and Setup. This preserves the tested local helper; no code changed.

## Remaining Gates

- Packaged Add Unity menu and package import: the native confirmation is open
  for the disposable `artifacts/packaged-plugins-alpha8-20260915/UnityProject`.
  Action-time Windows UI installation approval was requested. No helper has
  been installed into this fixture yet. No user project was changed.
- Earlier real Unity 2022/6 text/cancel/script-reload acceptance is recorded in
  PLUGIN-ACCEPTANCE-20260915.md; it is not substituted for this packaged flow.
- Current Hub CI: run 34984714934, source
  `4ab615c9ccd6ac9fff49f55e298ac06e12d46fde`.
- Current Setup candidate CI: run 34984719527, source
  `b1993beed8b97640ab28dd5a9ecbd3ebc2a7acc1`.
- MCP is preparing a byte-stable candidate and installed acceptance from both
  2.6.0 and 2.7.0-alpha.1. Its active local servers are not being stopped.
- Superseded Hub runs 34983559173/34984504181 and Setup runs
  34984218235/34984513775 were cancelled after the packaging correction.
- Keep accepted Setup alpha.6/MCP alpha.1 hosting pins until exact new
  companion artifacts pass acceptance. Do not manufacture signing receipts
  or publish differently rebuilt bytes as the accepted artifact.

No macOS/Linux, gameplay, SDK compatibility or headset acceptance is claimed.
