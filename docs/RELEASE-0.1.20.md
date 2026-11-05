# Creator Hub 0.1.20 for Windows

This update includes Creator Works MCP 2.7.8. Project Setup remains 0.3.7.
Existing Hub, MCP and Project Setup settings are retained. No project upgrade
or automatic graph rewrite is performed by installing this release.
The in-app update is qualified from Hub 0.1.19; earlier versions should update
to [0.1.19](https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/tag/v0.1.19) first.

## MCP Changes

- Safer object and asset reference changes: explicit targets, type checks,
  readback and refusal before mutation in Play Mode.
- Stronger graph validation: malformed containers, reviewed ports, and native
  graph source hashes and node identities are checked.
- Clearer command recovery: an unknown result is not permission to repeat a
  possibly completed operation; malformed receipts remain available for review.
- Updated Creator SDK node catalogue and offline documentation. Live docs lookup
  remains bounded and on demand.
- Advisory graph-performance checks identify the graph, unit and suggested fix
  for repeating events, repeated/deep value chains and frame-driven movement.
  Timing examples are profiling starting points, not universal requirements.
  These warnings do not rewrite graphs or prove gameplay performance.
- Diagnostic URLs and authorization headers are redacted at capture/readout.

## Validation And Limits

The candidate passed 438 source tests, nine bundled-server tests, disposable
Unity reference/graph tests on Visual Scripting 1.9.9 and 1.9.12, and three private
signed-update/restart cases from 0.1.19. Codex and Claude Desktop each passed the
two read-only real-client calls. Claude Code connected, but an account limit
prevented its model-driven calls; that additional test is explicitly deferred.
The public 0.1.19 update path must pass before this release is marked latest.

Incremental inspect/edit graph transactions remain separate future work.
Validation is not multiplayer, headset or performance acceptance. No existing
Unity project was used for these disposable tests.

New binary releases are Windows-only. Historical Mac/Linux downloads remain
available; those platforms can build from source. Volunteer maintainers with
native packaging and testing experience are welcome.
