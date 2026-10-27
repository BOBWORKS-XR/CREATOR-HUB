# Refresh And Compilation Evidence

`wait_for_unity_compile` is an idle-state read. It does not refresh assets, start
compilation or cancel work. A previously completed compilation is not evidence
that newly written C# files were compiled.

After `refresh_unity_assets`, retain `commandId` and `refreshRequestedAt` from its
result. Use the returned `nextAction` to wait for that exact command. For C#
changes, also pass `sinceTimestamp` equal to `refreshRequestedAt`:

```json
{
  "afterCommandId": "the UUID from the refresh result",
  "sinceTimestamp": 1793088000000,
  "timeoutMs": 30000
}
```

The timestamp above is illustrative; use the actual returned value. A correlated
wait requires successful command completion and an Editor heartbeat at or after
completion. A time boundary additionally requires a completed compiler snapshot
at or after that boundary. Compiler errors still produce `success:false`, even
when compilation has finished. `compilationSinceVerified` describes the time
boundary, not error-free compilation or runtime/gameplay correctness.

Asset-only refreshes may not trigger compilation. Omit `sinceTimestamp` when only
command completion and idle Editor state are required. On timeout or unknown,
failed or foreign command evidence, do not resubmit automatically. Keep the
original ID and inspect it with `get_unity_command_status` for the same project.

These boundaries use the existing bridge evidence; they do not change Unity's
import or compilation scheduling. Synthetic protocol tests are distinct from
validation in a running Unity Editor, domain-reload and package-specific tests.
