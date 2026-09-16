# Creator Hub 0.1.5

Published stable and marked latest on 2026-09-16 after exact public self-update
acceptance. [Download 0.1.5](https://github.com/BOBWORKS-XR/CREATOR-HUB/releases/tag/v0.1.5).

- Updated Creator Plugins icon: larger, lower puzzle corner, indented outer
  edge and real transparency. Used in Apps, the app menu and Plugins page button.
- Hub opens **Apps** by default. Selecting Creator Hub in the menu returns to
  Apps; Projects remains one tab away and retains its filters.
- No MCP, Setup, Unity helper or project content changes. MCP remains 2.7.1;
  Setup remains 0.3.0.

## Verification

- [Build 35090029622](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35090029622):
  161 UI, 107 Rust and 28 script tests passed, strict Clippy, installer guard and
  clean installed acceptance. Nine opt-in Rust tests were not run.
- [Native replay 35091512400](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35091512400):
  all four lanes passed against the same installer: clean, Hub 0.1.4, legacy
  Hub alpha.5 with companion apps, and Hub alpha.3 with MCP only. These include
  Apps-first startup, exact decoded icon pixels/transparency, scoped MCP update
  cancellation/retry, unrelated Node survival, and settings preservation.
- The first run's native icon test attempted a fetch forbidden by the app's
  content security policy. The test was corrected to compare decoded pixels
  against the hash-pinned source. Production code, CSP and installer bytes were
  not changed. The original failed reports remain in the first run.
- Signed descriptor, installer and executable hashes, and tamper rejection
  passed locally. The Windows installer is 6,021,869 bytes.

Product source: `288dbe5c4cf0c6d3e28e4088b44019ea37c69331`.
Native test source: `9f2393e59ccdc6be6be76d66b97c2106c37733e4`.

| Artifact | SHA-256 |
| --- | --- |
| Windows installer | `79f3a6a2851ec25d1d533eff85c0bc09764a3f1175c1928662c6915697495f5b` |
| Installed executable | `4c350035598e596dfcd351d83bd406e88b864c6e8485b914254fb57324b00594` |
| Plugins PNG | `ebb367878996c5a6af4225d2105a6e29711fd54d50d965e5e18571426eedae02` |

## Public Update Acceptance

[Run 35092200617](https://github.com/BOBWORKS-XR/CREATOR-HUB/actions/runs/35092200617)
passed the actual public 0.1.4-to-0.1.5 flow on a disposable Windows runner:

- Unmodified 0.1.4 discovered the signed 0.1.5 update and enabled Update Hub.
- Native **Not now** left the running app and settings intact.
- Approved **Update Hub** downloaded/verified, installed and automatically
  restarted into the exact accepted executable, without manually launching it.
- Footer and uninstall registry show 0.1.5. Browser preference and unmanaged
  installation content survived; test-only WebView policy was restored.
- Restart opened Apps. The Plugins image exactly matched the hash-pinned
  source's decoded pixels: 27,747 fully transparent pixels and a clear border.

All six anonymous public downloads matched the accepted signed files and passed
the application's signature/hash/tamper checks. Latest was promoted only after
the native test; the anonymous latest-download manifest matches the signed file.

The guarded publisher's immediate post-publication feed read did not yet see
the new release. Publication was not repeated: its public state was inspected,
then the anonymous legacy endpoint passed at 251,681 bytes, 10,463 below the
262,144-byte limit. This passed again after latest promotion. Before publication,
eleven 0.1.3 diagnostic reports were archived byte-for-byte in one verified ZIP;
all installers, signatures and updater metadata were retained unchanged. See
[0.1.3 report archive](RELEASE-0.1.3.md). All 144 retained historical assets matched
their pre-publication IDs, names, sizes and digests.

No user installation, AI configuration or Unity project was modified. This is
Windows NSIS acceptance, not historical MSI migration or native macOS/Linux proof.
See [icon provenance](PLUGINS-ICON.md) and [release gates](HUB-PUBLICATION-CHECKLIST.md).

Windows x64; the installer is not Authenticode-signed. Signed updater metadata
and checksums validate the published download, not arbitrary plugin code.
