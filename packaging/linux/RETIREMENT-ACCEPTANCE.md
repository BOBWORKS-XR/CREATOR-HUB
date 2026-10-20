# Native DEB Development Candidate

This recipe is opt-in, disposable acceptance support only. Do not publish or
distribute its TEST ONLY helper, policy or DEB. All production defaults and
release, migration, authentication and update acceptance gates remain closed.

Use the existing private `unix-managed-assembly.yml` workflow with the reviewed
signed native inputs and `linux_retirement_test_candidate: true`. Its default
is false. No private modules or signed routing inputs are rebuilt or resigned.
The corresponding builder option is `--linux-retirement-test-candidate`, in
addition to the existing installer, managed and experimental Unix options and
the signed input path. This route refuses Windows, Mac, ARM, unsigned module
preparation and non-installer builds before staging anything.

The current-source helper is compiled with `experimental-transaction`; Root is
compiled with `experimental-linux-migration`. The resulting native package is
DEB only. Its ordinary installer payload, not a `sudo cp` or maintainer script,
owns these exact files:

- `/usr/libexec/creator-hub-deb-retirement-helper`: numeric owner/group `0:0`,
  mode `0755`, regular native x86_64 ELF, no setuid/setgid bits.
- `/usr/share/polkit-1/actions/com.creatorworks.hub.deb-retirement.policy`:
  numeric owner/group `0:0`, mode `0644`.

The policy has one action bound to the fixed helper path and requires
`auth_admin` in every context. Polkit does not filter the arguments: the helper
itself admits only its compiled finite MCP 2.7.7/Setup 0.3.7 commands and refuses
arbitrary paths, package names and options. There is no `yes`, retained
authorization, blanket rule or GUI environment forwarding. Root still uses `--disable-internal-agent`; no
password or terminal fallback is added. System administrator policy can still
affect polkit decisions; actual native authentication/Cancel must be tested.

The builder checks the DEB's data/control tar headers, hashes, protected parent
directories, native dependencies and policy semantics without executing an
installer or helper. No maintainer scripts, triggers, conffiles or system policy
overrides are admitted. Separate immutable stage/package receipts retain false
acceptance flags. The existing module/archive/Hub integrity checks still apply.

After review, the native acceptance owner must install this exact retained DEB
through the system installer on a disposable machine and independently check
installed ownership, modes, package ownership and polkit action discovery before
testing Root consent, cancellation, GUI-reopen races, package transitions and
signed update/restart. Archive integrity does not prove installed state,
authentication or preservation of user settings. This recipe does not implement
Flatpak host authorization or native host operations inside a sandbox.

## Polkit 0.105 Contract

Upstream [0.105 pkexec.c](https://github.com/polkit-org/polkit/blob/0.105/src/programs/pkexec.c#L217-L270)
selects the first action whose `org.freedesktop.policykit.exec.path` matches;
it does not read `exec.argv1`. Two same-path actions would therefore be ambiguous,
not per-product authorization. The one shared action preserves mandatory,
uncached administrator authentication while the helper enforces command admission.

The official Ubuntu [0.105-33ubuntu0.2 source patch archive](https://archive.ubuntu.com/ubuntu/pool/main/p/policykit-1/policykit-1_0.105-33ubuntu0.2.debian.tar.xz)
was inspected without installation: 79,160 bytes, SHA256
`4811ed40c1c5ed9185c90a309594b293a4fe72760ad0840ef9abf52c29d6a689`.
Its patch series contains no argv1 backport. This source check does not replace
installed action discovery or actual authentication/Cancel on the native runner.
