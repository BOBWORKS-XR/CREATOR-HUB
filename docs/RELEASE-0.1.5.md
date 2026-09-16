# Creator Hub 0.1.5

Candidate accepted. Public self-update acceptance and latest promotion pending.

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

The actual public 0.1.4-to-0.1.5 self-update/restart must pass before latest promotion.
See [icon provenance](PLUGINS-ICON.md) and [release gates](HUB-PUBLICATION-CHECKLIST.md).

Windows x64; the installer is not Authenticode-signed. Signed updater metadata
and checksums validate the published download, not arbitrary plugin code.
