# Unix MCP Execution: Experimental Native Work

Production Unix writable hosting is still refused. `experimental-unix-hosting`
is a **disposable native test feature**, off by default. It is not a readiness
label, migration approval or permission to include it in a release.
The Windows inherited-pipe, native-consent, deny-write/delete handle and job
contracts are unchanged. GUI settings ownership remains exclusive on Unix too.

## Payload Use

`Store::resolve()` captures and hashes the exact descriptor-authorized bytes.
Unix `Runtime::run()` consumes those buffers, not a second unbound pathname read.
It requires a single-threaded headless caller, never the Hub GUI.

- Linux creates an executable memfd, copies the verified Node bytes, requires
  write/grow/shrink/seal seals, then uses `execveat(AT_EMPTY_PATH)` on that fd.
  `MFD_EXEC` is explicit on supporting kernels; only unknown-flag `EINVAL` uses
  the older API. Kernel/policy refusal has no mutable-file fallback.
- macOS parses the verified native thin Mach-O's SHA-256 CodeDirectories and
  checks every covered code page. The supervisor requests inherited hard/kill
  enforcement on its own exec, spawns Node with `START_SUSPENDED`, and queries
  the child's kernel CDHash/status before `SIGCONT`. Missing/foreign/unsupported
  identities, missing enforcement, and debugged code refuse and reap the child.
  SHA-1-only, FAT/Rosetta and extended/scatter coverage currently refuse.
- The server source crosses a dedicated fd, separate from MCP stdin. A native
  inline Node synchronous loader checks its digest and returns that exact buffer
  under the original file URL. `import.meta.url`, the server's argv[1], and MCP
  stdio are preserved. Linux exposes its sealed fd through process.execPath for
  owned Node helpers; it does not advertise the mutable original Node pathname.
  Node must support `module.registerHooks` (the pinned 24.17.0 runtime does).
  Node and dynamic-loader override variables are removed before the child exec.

This is file-use binding, not protection against root, process-memory compromise,
same-user ptrace/signal manipulation, hostile OS libraries or arbitrary commands
intentionally launched by authorized server code. CDHash is integrity identity,
not publisher/notarization proof. Publisher authority remains the signed descriptor.

Primary contracts checked during implementation:
[Linux sealing](https://man7.org/linux/man-pages/man2/F_ADD_SEALS.2const.html),
[fd-bound exec](https://man7.org/linux/man-pages/man2/execveat.2.html),
[memfd execution policy](https://docs.kernel.org/userspace-api/mfd_noexec.html),
[XNU suspended spawn/enforcement inheritance](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_exec.c),
[XNU kernel CDHash/status and self-only flag changes](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_proc.c),
[XNU invalid-page enforcement](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_cs.c),
[Node synchronous loader](https://nodejs.org/download/release/v24.17.0/docs/api/module.html).

## Owned Cleanup

A private supervisor monitors an EOF lifeline whose only writer is the router.
It kills the Node process group after EOF/router loss or Node completion and
forwards the actual Node wait status only after cleanup. `WNOWAIT` retains the
direct child's identity until the group kill, avoiding recycled PID/group kills.
Linux additionally uses a dedicated subreaper and kills/reaps only its adopted
direct children, recursively including detached helpers. It never scans/kills
by process name or adopts the AI client/Hub/Unity process.

macOS group cleanup does **not** guarantee termination of deliberately detached
descendants. There is no claim of Windows job-object parity for that case.
Native macOS tests and a decision on detached-helper requirements are blockers.
Kernel-uninterruptible tasks and killing the supervisor itself are outside the
normal router-loss guarantee. Primary contracts:
[wait identity retention](https://man7.org/linux/man-pages/man2/waitid.2.html),
[Linux subreaper](https://man7.org/linux/man-pages/man2/PR_SET_CHILD_SUBREAPER.2const.html).

## Hosted API Handoff

`Root::verified(PathBuf) -> Result<Root, String>` binds the build's four required
hosted files to verified buffers on Unix. `Root.0` remains metadata for routing;
it is **not** immutable resource-use authority. Consume with:

```rust
root.read_verified("unity-extension/Editor/BanterMCPBridge.cs")?;
root.copy_verified("unity-extension/Editor/BanterMCPBridge.cs", &temporary_bridge)?;
root.copy_verified("unity-extension/Editor/CreatorWorksMCPLogo.png", &temporary_logo)?;
```

Parent-owned `main.rs` must route hosted bridge status/installation reads through
these helpers, preserving standalone behavior and existing backup/publication
logic. It must not point new Unix AI-client entries at the direct mutable Node
path; use the reviewed signed managed route. The feature stays off until this
integration, packaged payload execution, native consent/decline, competing GUI
ownership, bridge exact-byte consumption, client reconnect, and cleanup pass.

## Native Commands

From the exact checkout, on Linux x64, macOS Intel and macOS Apple silicon:

```sh
cargo test --release --locked --manifest-path native/mcp-router/Cargo.toml
cargo clippy --locked --manifest-path native/mcp-router/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path native/mcp-router/tests/hosted-payload/Cargo.toml
node native/mcp-router/tests/unix-execution.cjs /absolute/path/to/pinned/native/node
```

The native script builds only disposable examples, creates a new isolated profile
and route, uses an ephemeral in-memory test signer, and retains the result under
`artifacts/unix-native-results/` as well as its printed temporary payload path.
On Mac it ad-hoc signs only those test
binaries without an account/private key. It tests source write/replacement after
resolve, Node write/replacement after resolve, exact one-byte pre-resolve tamper,
stdio, module URL/argv, actual exit code, EOF, router SIGKILL, owned helper cleanup
and unrelated Node survival. If the real server/SDK dependency has been built,
it also exercises official SDK initialize/listTools/ping/EOF against the exact
real server bytes and proves removal of Node injection overrides. The report
explicitly records when this optional real-server check could not run.
Linux helpers deliberately detach; Mac helpers stay
in their owned group. This is component transport/binding acceptance, **not** a
signed updater, installed AI-client or writable GUI acceptance test.

Optional WSL x64 runner stages verified tools entirely in a newly created /var/tmp
directory without changing the shell profile or live apps:

```sh
bash native/mcp-router/tests/run-isolated-linux.sh "$PWD"
```

After building the real module release payload and installing runner-only Tauri
dependencies, the parent can test the experimental GUI compilation/guards with:

```sh
cargo test --release --locked --manifest-path modules/mcp/launcher/src-tauri/Cargo.toml --features experimental-unix-hosting
```

Linux x64 WSL native runs passed 21 router tests, two exact-byte hosted-payload
tests, transport/replacement/cleanup fixtures and the real-server official SDK
check. The retained passing report is
`artifacts/unix-native-results/linux-x86_64-a37813f6-5985-420c-b859-a55740355ed2.json`.
The earlier expanded report remains a failure: its test checked transport.pid
after SDK close had cleared it. That harness-only correction was rerun; it did
not change runtime behavior or retroactively relabel the failed report.

No native Mac run has been established in this task. Cross-target `cargo check`
and Clippy, portable parser tests, and Windows regressions do not lift the block.
