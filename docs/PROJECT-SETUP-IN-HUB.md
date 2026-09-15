# Project Setup In Hub

User direction, revised 2026-09-15. Next phase only; no packaging migration is
implemented here. This supersedes the earlier proposal to retire Setup's repo.

- Make Project Setup a permanent built-in part of Creator Hub, while keeping
  its existing GitHub repository as the canonical source and release history.
- Hub should consume a pinned, tested Setup component from that source, not a
  separately edited copy. Carry Setup updates into the Hub distribution through
  an explicit compatibility and packaging check.
- Allow Hub's shell to update independently of the Setup component. Record both
  component versions and keep their update state distinct.
- Preserve new-project creation, requirements installation, existing-project
  validation/repair, progress, saved settings and diagnostic logs.
- Provide an explicit migration path for existing standalone Setup users.
  Do not remove their installation, settings or project data silently.
- Do not retire or archive the Setup repository. Keep its standalone releases
  and existing links available while supporting the built-in Hub distribution.
- Creator Works MCP remains separate. This decision does not merge its server,
  alter its installation or change the planned Creator Converter.

Current small change: normal Hub launch and the Creator Hub menu entry open
Projects. Apps remains available as a tab; MCP/Setup shortcuts retain their
explicit destinations.

Hub 0.1.0, Setup 0.3.0 and MCP 2.7.0 were published separately; this future
packaging plan is not part of those binaries. The current post-release UI work
adds Grid defaults and direct Apps-row updates without merging repositories.
