# Project Setup In Hub

User direction, 2026-09-15. Next phase only; no migration is implemented here.

- Make Project Setup a permanent built-in part of Creator Hub, with its source,
  tests and packaging maintained in the Hub repository.
- Preserve new-project creation, requirements installation, existing-project
  validation/repair, progress, saved settings and diagnostic logs.
- Provide an explicit migration path for existing standalone Setup users.
  Do not remove their installation, settings or project data silently.
- Retire/archive the separate Setup repository only after the integrated
  replacement and migration have passed acceptance. Keep historical releases
  and a redirect/readme for existing links and users.
- Creator Works MCP remains separate. This decision does not merge its server,
  alter its installation or change the planned Creator Converter.

Current small change: normal Hub launch and the Creator Hub menu entry open
Projects. Apps remains available as a tab; MCP/Setup shortcuts retain their
explicit destinations.

Publication is on hold until the user finishes testing installed alpha.8 and
explicitly approves release. Do not replace that installed build during their
test or describe this source-only navigation change as already installed.
