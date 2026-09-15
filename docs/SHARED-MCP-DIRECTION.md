# Shared MCP Direction

User clarification: 2026-09-14. This records the next packaging direction, not
an implemented or released capability.

- Creator Works MCP remains usable standalone.
- Creator Hub and Creator Project Setup also provide MCP access, along with
  their shared Plugins page. Plugins is not a separate app.
- Recommended implementation: one managed MCP installation, one settings store
  and the same reusable MCP interface/backend contract. Do not silently start
  duplicate MCP servers or copy AI client configurations between applications.
- A fresh installation can obtain the shared component through an approved
  install flow. Existing installations must be discovered and reused or
  explicitly upgraded; never assume that identical branding means compatibility.
- Keep version checks, signed artifact verification, active-operation guards
  and migration tests. A common component simplifies the upgrade matrix but
  does not eliminate it. Preserve older standalone users' settings and projects.
- Installing or removing one interface must not remove a shared MCP component
  still used by another app or by an AI client.

The project import/menu work is independent of this packaging decision and can
be tested now. Full Hub screens inside standalone apps, shared component
ownership, installation/adoption and uninstall behavior remain implementation
and native acceptance work. Do not describe today's local candidate as that
completed architecture.
