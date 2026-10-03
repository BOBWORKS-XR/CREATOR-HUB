# Reporting a Setup Failure

Setup does not upload logs or collect reports automatically. Sharing is optional.

## Files to Keep

Inside the selected project's `.creator-project-setup` folder:

- `setup-receipt.json`: creation outcome, Setup version, recording time, platform,
  Unity/SDK recipe, summarized error on failure, and paths of existing Unity logs.
- `unity-setup.log`: Unity's first configuration/import session.
- `unity-reopen-validation.log`: second-session verification, if it was reached.

Starting with 0.3.0-alpha.2, creation receipts include `setupVersion` and
`recordedAtUnixMs` (milliseconds since the Unix epoch in UTC). Existing receipts
are not rewritten by installing an update. Earlier failures, before the project
folder is created, may have no receipt; include the screenshot and app version.
Existing-project repair/validation reports and logs remain inside the operation's
`.creator-project-setup/backups/` folder; include the app version separately.

## Review Before Sharing

In 0.3.0 and its prerequisite-installation previews, failures before
project creation also write local reports under
`%LOCALAPPDATA%\CreatorProjectSetup\logs\requirements-<id>\`. Keep
`requirements-receipt.json` and the relevant installer log. The error displays
the report path. Raw CLI environment and licence-query responses are not saved.
This does not make the remaining installer logs safe to publish unreviewed.

Review both receipts and raw logs. They can contain local paths, project names,
machine/session identifiers, licensing details or package URLs. Redact personal
paths and identifiers, credentials, tokens and private registry URLs. Start with
the summarized error or a short relevant excerpt, not a full project archive.
Send raw diagnostics privately only when needed. Nothing in this release makes
unreviewed logs safe to post publicly.

Use a private support conversation or open a
[GitHub issue](https://github.com/BOBWORKS-XR/CREATOR-PROJECT-SETUP/issues/new?template=setup-failure.md)
with reviewed/redacted information:

```text
Setup version:
Standalone or Creator Hub (include Hub version):
Windows version:
Action: install requirements / new project / existing-project validation / repair
Unity version:
SDK recipe shown:
Exact error:
Steps before the failure:
Does it repeat? If retried, what changed?
Last stage shown (include elapsed time for downloads/installations):
Reviewed attachments: screenshot / receipt / relevant installer or Unity log excerpt
```

Keep the original files locally. Do not delete a failed project, reset Library,
disable security software, or overwrite existing content just to make a report.
For the reported package-download reset and partial-project recovery limits,
see [Repair and recovery](REPAIR-RECOVERY.md#new-project-package-download-failure).
