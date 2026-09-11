# Alpha.4 Hotfix

Status: Windows prerelease with installer and native acceptance completed.
The alpha.3 release is unchanged. MCP and Project Setup payloads and
their accepted hashes are unchanged.

## Changes

- Projects default to Recently modified, with Name A-Z as another sort option.
- Search, SDK filters, explicit launch IDs and busy-operation protections remain.
- Modification dates use saved source metadata, excluding generated Unity
  folders. Windows enumeration supplies cached file metadata rather than an
  extra filesystem query for every asset. Limits remain: 200,000 entries and
  500 ms per project, 2,000,000 entries and 5 seconds total. Checks run in the
  existing discovery worker, on demand only; these cooperative time budgets
  cannot interrupt a stalled operating-system filesystem call.
- Missing, unreadable or incomplete dates are labelled unavailable and sort last;
  no root-folder date is substituted for a nested scene edit.
- Upgrade blockers include process IDs, executable paths and the observed
  starting process when identifiable. No command lines or credentials are
  exposed. A parent that started after its child is not attributed to it.
  Existing heuristic command matches are labelled Possible MCP connection,
  not presented as proven ownership. They still block installation.
- The app offers Check again without starting downloads, installers or closing
  processes. The normal Update action still needs a separate user click.
- Native install checks run before download, after download and immediately
  before installation. Installer file-lock safeguards remain enabled.

## Evidence and Limits

The user reported an upgrade blocked by two processes they recalled as Codex
processes. The original process snapshot/error is unavailable. A later read-only
snapshot found two MCP private-runtime Node processes parented by codex.exe;
that does not establish that the earlier processes were orphaned or idle.

Independent source probes showed idle MCP exits on stdin EOF and ordinary parent
exit with the tested Node 22 runtime. The SDK does not propagate stdin EOF into
server.close/active request cancellation, which is a separate follow-up. There
is no proven universal idle orphan leak, and this hotfix does not claim one.
Old or active MCP connections are not force-killed, and clients remain independent.

Read-only project inventory: 62 projects, 51 valid projects with complete dates,
11 unavailable projects; measured 1.06 seconds on the development machine.
This is one local timing sample, not a cross-machine performance guarantee.

## Release Acceptance

- [Build job](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/34576073539):
  49 Rust tests passed, five explicit live tests ignored; 66 browser tests,
  strict Clippy, packaging checks, clean installation, same-version update,
  active-Hub refusal, exact installed hashes and GUI startup passed.
- The first native harness attempted to click a hidden navigation control.
  Correcting test navigation did not rebuild or alter the installer.
- [Final native acceptance](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/34576995054)
  passed all three clean, legacy and MCP-only paths using that exact installer.
  Legacy lanes include public Hub alpha.3-to-alpha.4 upgrades and preservation of
  existing files/settings. The private-runtime fixture verifies blocker display,
  persistent recheck, backend installation refusal, cooperative exit and then a
  separately approved MCP update. It is not a real in-flight MCP request test.
- Both installed companion apps passed native hosting, consent, retained forms,
  MCP preference round-trip, busy-close refusal and scoped backend exit.
- The accepted installer was also installed locally over alpha.3. Real project
  sorting, live blocker guidance/recheck and both hosted apps passed. Companion
  binaries, MCP configuration and Hub app selections were unchanged; the existing
  private-runtime processes remained alive. No Unity project was modified.

Installer SHA256:
`425f0e6d5399227f9e5e257ad2b5c2e9fc57b6e58ed27a56d1f13b29c93e67c9`

Actual installed EXE SHA256:
`b789ae255dd220a1ebe0493b7264f24846efb594c8b5bd8b85e5e891f22d9a4e`

The complete higher-version signed in-app Hub self-update/restart path remains
untested. This is not proof that every historical BANTWORKS/MSI migration or the
original user's unavailable process snapshot has been resolved. No Unity scene,
headset, account-usage or token-saving claim is made. Windows publisher signing
is absent; signed update metadata is a separate protection.
