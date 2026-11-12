# Windows Update Recovery

Source changes for the unpublished 0.1.23 candidate. Native acceptance must bind
the final rebuilt installer; previous installer results do not qualify new bytes.

- Updates already stage a verified installer and target the existing installation
  folder. Settings remain outside that folder; a duplicate installed Hub would
  share those stores, not make them safer. No second installation is introduced.
- The installer safety-check refusal now offers Retry or Cancel. Retry runs the
  same preflight again; only status zero continues. Silent installation defaults
  to Cancel and exit 10. No process is force-closed or settings removed.
- A blocked Windows update offers Get official installer. Only an explicit click
  opens the exact allowlisted official release page. It does not download or run
  an installer or bypass an ambiguous installation record. Other platforms do
  not get a Windows-installer action.
- Failed/cancelled update commands hide stale active progress and show their
  terminal error. Successful completion messages remain visible.

Focused evidence: installer recovery contract tests and real NSIS guard-fixture
compilation passed; Hub browser regressions cover terminal progress, explicit
fallback clicks, blocked updates, platform differences and 320/940px layouts.
Independent source review found no remaining preflight-loop issue. Interactive
installer Retry and mid-write rollback are not established by those checks.

The previous private installer remains preserved. The published 0.1.22 release,
installed user settings, projects and active MCP clients are unchanged by these
source changes. Do not publish until the new exact candidate passes its gates.
