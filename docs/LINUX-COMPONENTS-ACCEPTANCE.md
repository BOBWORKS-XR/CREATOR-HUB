# Native Linux Components Experiment

This is a bounded component GUI experiment, not migration, retirement, signed
update, Unity project creation, AI connection, Flatpak host integration or release
acceptance. Those gates remain false even if every component action passes.
Linux retirement/integration work is parent-owned. No Mac lane is included.

## Immutable Product

- Product source `5bb05a21d73c0fc3b2839cbcbd4322832b24aead`, tree
  `f91c61a8e29da84e0dbdbfa642d201cd4c6a3279`, successful assembly
  `38630742955`, attempt 1, Linux job `116081506373`.
- Original artifact `11927495507`, `signed-unix-hub-linux-38630742955-1`,
  386824719 bytes, SHA-256
  `42c5e1a95605158ab084c4cad1db1a6fb5b49f6fe225db9cea868148cccda725`.
- Actual DEB `Creator Hub_0.1.14_amd64.deb`, 62780196 bytes, SHA-256
  `f0297e74c6ce918b54c248b222af7ac64c3c96c270d281a17a017fb90a7714ec`.
- Actual installed `/usr/bin/creator-hub`, SHA-256
  `efca8d6ca5949e787f10c124e26b91202587b34803f65c7cc5c3e9ffb93fdbf9`;
  resources at `/usr/lib/Creator Hub/modules.tar.gz`, SHA-256
  `c2cffb6f886225d8c841e78497e92c6ede96896e0c5a28c89346254e5fc4a77a`.
- Private payload source `a3118106086516751b78a58b5dbd684cff4c63a7`, unchanged
  MCP 2.7.7 and Setup 0.3.7, writable mode, original signed assembly receipts.
  No application rebuild, byte change or version relabel is permitted here.

The original artifact/run/source/tree, original receipts, all archive resource
hashes and modes, native package control metadata, actual dpkg install and kernel
image are checked independently. Test source/run is recorded separately in
`components-report.json`; the product source does not follow current HEAD.
Later parent production convergence changes are not tested by this old DEB.

## Native Action Boundary

Reuse the exact Root probe accepted in run `38639742819` at test source
`058516dfc9e7d12c38c9be039ae52a318e2c512e`: Root PID/start/UID/kernel image,
XRes window, one exact native direct-child WebKit process and canonical AT-SPI
bus-owner/object references. Its source SHA-256 is pinned in this experiment.
The generic native helper is unchanged. No arbitrary UI selector is accepted.

The new local component walk permits WebKit semantic parents only when their
canonical references occur in the same fully verified Root frame subtree.
Foreign windows, additional renderer PIDs, parent escapes, changed kernel images,
UID changes, PID reuse and duplicate wire references still refuse. A fixed WebKit
button needs the expected role, context, one `press`, two full walks and identical
canonical identity immediately before its single effect. No uncertain action is
retried. The native GTK consent path retains the existing stricter single-PID
helper and exact title/button allowlist.

Backend authority comes from the Root's actual direct children, matching signed
manifest hash/size, complete anonymous executable seals and UID/start/PPID, then
the helper's held/current kernel-FD rechecks. A generated test receipt alone
cannot grant ownership. No saved source pathname substitutes for the memfd image.

Planned actual sequence:

1. Native Root terms checkbox and acceptance, actual persisted acknowledgement.
2. If required, normal `Continue for now` on the convergence review. No prepare,
   migration or retirement action; fixtures and absent migration record checked.
3. Select Setup, native `Not now`, observe decline and reaped backend, normal
   `Open in Hub` retry, native approval. Require actual rendered Linux requirements
   and exact approved recipe, then `Check requirements again` and real result.
4. Select MCP, native `Not now`, observe decline/reap, normal retry and native
   `Enable MCP controls`. Managed routing, if requested by the real product, is
   approved only through its exact native Root dialog; no client file is changed
   by the test. Require real module initialization/connection-guide surface.
5. Native `Use existing controls` saves the single connection-guide preference.
   Require all other fixture configuration fields unchanged, empty channels,
   no active project, auto-start false, custom server/editor-root bytes unchanged,
   absent client/legacy configuration and migration journal. No project, client,
   server or Unity operation is selected. Module legal terms are not seeded; the
   product may propagate the Root's real native acceptance through its own bridge.
6. Root-window-only nonblank PNG, normal owned WM close, parent-reaped Root exit
   zero and bounded stdout/stderr EOF. Require all observed backend PID/start
   identities absent and saved acknowledgement/preference retained after exit.

The product wait thread does not expose backend exit status. Backend absence is
reported as absence, **not an invented backend exit zero**. The Root is actually
reaped by this probe. Unexpected module legal controls or admission failures
stop this lane with the exact owned tree/error for parent production review.

## Execution And Evidence

Owned files: `scripts/native-linux-components-probe.py`, its focused test, this
document and `.github/workflows/native-linux-components-014.yml`. The dedicated
validation branch is `validation/linux-components-014`. All installation and GUI
actions run only on the opted-in disposable Ubuntu 22.04 runner, inside private
HOME/XDG/tmp and a private dbus/Xvfb/Openbox session. No user PC app/config reads,
credentials, real projects, injected replies/DOM/storage or process-kill fallback.

Preflight commands:

```text
python3 -B scripts/native-linux-root-probe.test.py
python3 -B scripts/native-linux-components-probe.test.py
```

The workflow stages and installs using the existing immutable DEB verifier, then
runs `native-linux-components-probe.py probe`. It preserves original input ZIP,
source binding, receipts, all bounded worker stdout/stderr, owned snapshots,
refusals and PNG even on failure. Original failed runs are never overwritten.

Current classification: implementation prepared; native component result pending.
Only an actual report with every required action/result/retention gate can change
this component classification. Packaging and Root terms proof alone cannot.

Local pre-dispatch verification: new focused suite 18 passed / 1 native-mode
fixture skipped on Windows; unchanged Root suite 75 passed / 1 skipped. Workflow
YAML and embedded GitHub-script JavaScript syntax parsed. These are harness
contracts, not native component acceptance.
