# Release Work

- Read `docs/RELEASE-GATES.md` and `docs/HUB-PUBLICATION-CHECKLIST.md` before any
  release work. Prior permission to publish one version is not standing authority
  to publish future versions.
- Publish Hub drafts through `scripts/publish-hub-draft.cjs`. Do not bypass its
  old-client response-size gate with a direct GitHub publish command.
- Do not declare a release ready until the exact previous stable app has passed
  public discovery, native cancellation, approved in-app update, automatic
  restart, version/hash checks and preference/content preservation. A silent
  installer test, source tests or working download URLs alone are insufficient.
- Keep old published installer bytes and signed metadata immutable. Compact
  release-page text and link full notes; bundle future evidence to avoid bloating
  the GitHub release-list response consumed by older installed clients.
- Preserve original failure reports and state the tested scope. Use disposable
  runners for installation tests; do not modify the user's live app or projects
  just to obtain release acceptance.
