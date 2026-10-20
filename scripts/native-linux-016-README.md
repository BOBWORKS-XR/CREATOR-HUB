# Finite 016 Native DEB Lane

Prepared harness, not native acceptance or release qualification. No historical
014/015 probe, workflow or product is changed. Parent owns staging and dispatch.

## Dispatch Contract

- Workflow: `.github/workflows/native-linux-016-pages.yml`.
- Ref: `validation/native-linux-016`. Manual dispatch only, input `profile`.
- A push trigger on that exact branch registers the new workflow. Its sole
  native job still requires `workflow_dispatch`, so a registration push skips
  every job: no checkout, downloads, apt, installation or native execution.
- Exact JSON shape: `scripts/native-linux-016-input.schema.json`; no extra fields,
  paths, URLs or execution flags. Maximum supplied text: 16 KiB.
- Modes: `pages` or `migration-cancel`. `migration-approve` is refused before API
  access. Run each separately with identical product pins.
- `assembly` binds the actual successful Linux assembly run, attempt, source,
  job, artifact ID, original artifact ZIP size and SHA-256. API repository, ref,
  workflow, job timestamps, artifact metadata and bytes must all agree.
- Private payload is fixed to run 39326776585 attempt 1, source
  `52e3a537c9d323c81ab259cb82b44bbe0828b414`. Its PRIVATE_SOURCE_PATHS Git identities
  must equal assembly source. Later Root/docs/harness changes do not require a
  private rebuild if these identities remain equal.

`pins` are independently approved raw byte `{size, sha256}` records:

| Key | Exact selected archive or installed DEB member |
| --- | --- |
| deb | `native-packages/Creator Hub_0.1.16_amd64.deb` |
| manifest | `builtin-manifest.json` |
| modulesArchive | `modules.tar.gz`, also `usr/lib/Creator Hub/modules.tar.gz` |
| assemblyReceipt | `signed-unix-assembly.json` |
| packageIntegrity | `unix-package-integrity.json` |
| hub | `usr/bin/creator-hub` in the DEB, not the pre-packaging raw ELF |
| helper | `usr/libexec/creator-hub-deb-retirement-helper` |
| policy | `usr/share/polkit-1/actions/com.creatorworks.hub.deb-retirement.policy` |
| service | `usr/share/dbus-1/services/com.creatorworks.hub.Host.service` |

Do not dispatch until these actual upcoming assembly IDs/hashes are known and
reviewed. Unknown pins fail closed; this harness does not discover and approve
its own expected product identity. Selected receipts must describe 0.1.16,
integrated features, experimental Linux migration/host and false acceptance.
Package/resource inspection precedes installation and all native execution.

## Bounded Native Checks

The disposable Ubuntu runner installs the exact original MCP 2.7.7 and Setup
0.3.7 DEBs and bound Hub DEB. It builds only pinned tauri-driver 2.1.0, not Hub
or either module. Existing frozen controller code supplies transport and
process/window capture primitives only; obsolete selectors, admission and
fixtures are never called.

Both modes exercise the current single `Move to Hub` guide, click `Not now`
once, check protected settings/client/project fingerprints and installed package
integrity, then normal close and manual reopen. `migration-cancel` includes a
unique missing legacy project and different legacy preference. It does not test
native confirmation-dialog cancellation after clicking Move. `pages` additionally
checks Projects home, one Hub updater, selected-project/bridge labels and both
direct Ready pages, without feature documents or module GUI processes. Terms
consent and reminder persistence are checked without resetting either store.
The reopened guide is expected to stay hidden only after Projects has populated,
not merely before asynchronous convergence status has returned. A second offer
is a failed persistence check, not silently deferred again.

The application reminder is keyed localStorage (`src/convergence.js`), not
sessionStorage. Locked Tauri 2.11.5 resolves Linux web data under
`XDG_DATA_HOME/com.creatorworks.hub`; runtime-wry 2.11.4 / Wry 0.55.1 use that
directory without incognito by default. tauri-driver 2.1.0 maps only binary/args
and enables automation; it adds no fresh profile option. This supports the
expected persistence contract, but does not replace the pending native test.
The same isolated HOME/XDG directories are retained across both app processes.

Driver readiness has identity/socket checks before and after GET /status. The
actual native driver's image/process/socket are bound before POST /session.
Callbacks use only log/proc/socket/X11 reads; no callback recursively calls the
WebDriver or invokes product commands.

Only the owned first/reopened driver.stdout and driver.stderr files are uploaded.
The reused Capture primitive retains at most 256 KiB per stream; reports include
observed bytes, retained bytes, EOF/overflow flags and each file's stat and
SHA-256. Overflow fails the run and retains the explicitly marked bounded log;
it is never silently treated as complete. These are isolated fixture process
logs, not unrelated workstation or system logs.

There is no approval, backup/import/route change, retirement, live reconnect,
signed update, automatic restart or Flatpak operation in this lane. Their flags
and releaseReady stay false. Full migration approval remains unfinished and
must use a separate reviewed extension; do not repurpose cancellation as proof.

## Focused Local Preflight

```text
node --check scripts/native-linux-016-input.cjs
node --test scripts/native-linux-016-input.test.cjs
python -B scripts/native-linux-016.test.py
```

These tests use mocks and synthetic archives, never installed apps, a device,
network, package transactions or product builds. Parse workflow YAML, each Bash
body, embedded Python AST and github-script JavaScript before parent dispatch.
Pre-apt tests check current UI IDs/labels, neutral helper method signatures and
the canonical producer SDK lock. Its SHA-256 is
`ded7a99b78aca304253d5287cc1b884a845afde083eb32d1a2abecd14468ba60`;
Windows CRLF working-copy bytes differ, so source preflight normalizes line
endings only for this source-text check. No downloaded package/resource hash is
ever normalized.
