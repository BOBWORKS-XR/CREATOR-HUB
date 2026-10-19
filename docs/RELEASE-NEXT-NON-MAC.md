# Next Non-Mac Release

User request, 2026-10-19: remove Creator Plugins from the app and release Windows
and Linux, including Flatpak. macOS remains suspended. This is a release plan,
not approval of untested packages or a publication receipt.

## Product Change

- Plugins menu items, retirement pages, app help entries and catalogue asset
  loading are removed from Hub and both legacy module interfaces.
- The former website command permanently refuses; it does not depend on a clock
  or launch a browser. The obsolete Flatpak RPC route is removed.
- Existing Unity projects, imported assets, historical helper installations,
  import receipts and cancellation/recovery evidence are not deleted.
- Historical catalogue/adapter tests now use isolated test-only fixtures.
  The source gate rejects reintroducing the removed app interface.

## Version And Publication

- Public 0.1.14 remains unchanged. Its qualification is Windows-only and binds
  exact previously accepted B05 assets; it cannot approve new source or Linux.
- Never publish private 0.1.15 acceptance-fixture bytes. 0.1.16 is the next source
  candidate; its release and tag were absent when checked on 2026-10-19. The
  version bump does not qualify package bytes. No release tag is created yet.
- Extend finite production qualifications only from actual new evidence, with
  public Windows 0.1.14 as the incoming stable baseline. Do not repurpose the old
  receipt, relabel a test package or bypass the guarded publisher/feed budget.

## Outstanding Platform Gates

1. Windows: exact direct-page installer, migration/retirement, signed incoming
   update and automatic restart against the final new candidate. Local read-only
   page tests do not replace these release gates.
2. Linux DEB: actual system cancellation, authorized signed installation,
   automatic restart and preservation; production legacy-app retirement remains
   experimental/default-refused. RPM/AppImage automatic replacement remains
   unsupported and must not be advertised as accepted.
3. Flatpak: qualify disclosure Cancel, owned warm/cold activation, host version
   binding, signed update/reactivation and safe removal. The native-window
   launcher currently depends on a DEB-installed host, not a self-contained
   SteamOS package. The tested Deck lacks required WebKit libraries.
4. Publish all requested non-Mac platforms only after their final exact bytes
   pass. Preserve original failed reports and historical release assets.

## Source Validation

The 0.1.16 source candidate passed 375 browser tests, 950 script tests
(135 skipped), 412 integrated Hub Rust tests (14 ignored), and
304 MCP internal-service Rust tests (9 ignored) on Windows. Strict Clippy passed
for integrated Hub and all release targets of MCP and Project Setup. Logs are in
`artifacts/plugins-removal-20261019`. These checks do not qualify an installer,
signed update, automatic restart, or production Flatpak integration.

The Flatpak launcher version now follows the source candidate. Historical
Windows 0.1.14 qualification tests use explicit 0.1.14 fixtures, and reject a
different source version rather than authorizing new bytes with the old receipt.
Clean Windows CI also caught an unused lifecycle idle query in its isolated
native fixture. The fixture now checks active-workflow and completed-work idle
states; strict release Clippy passes without suppressing the warning.

A separate fresh Windows CRLF checkout passed 928 script tests (132 skipped).
Five explicit LF attributes protect exact Unix protocol/source contracts. The
installed-candidate compatibility workflow now builds its refusal-only helper
before script assertions. The pure archive fixture uses Python's canonical path
spelling, retains inode/device checks, and still proves redirected paths are
refused. These are checkout/test corrections, not Mac platform enablement.

The public Windows baseline registry now includes 0.1.14's published installer
and executable hashes, verified against the release API and descriptor. Newer
targets select 0.1.14; historical 0.1.12 transport and 0.1.14-to-test-only-0.1.15
contracts retain their original explicit scopes. This does not supply the new
candidate's signed-update acceptance.

## Linux Harness Diagnosis

Run 39139434211 failed before approving the Hub update: its generic bitmap helper
refused the legitimate main window plus update confirmation, both owned by the
same Hub PID. Later broker cleanup masked this as Owned process is not live.
This establishes a harness error, not a product crash. Modal-specific capture,
bounded authentication-window capture and original-error retention now pass
38 pure regression tests. Native repetition is still required; the existing
capture-only workflow does not approve system authentication or install updates.

The separate frozen-input full-flow controller now admits system Cancel and one
synthetic approval on disposable GitHub Linux runners. Its 76 pure tests and
workflow/script parse checks pass. Scoped acceptance requires actual package and
executable replacement, product-initiated restart, fresh UI ownership, unchanged
settings/selection and unrelated synthetic runtime, and normal close. Native
execution remains required; its private 0.1.15 fixture cannot qualify or publish
the new source candidate.

Run 39257702384 passed preflight and signed input staging but stopped in the
fixture broker before Hub launch. Read-only diagnostic run 39258494136 confirmed
the GitHub runner's root-owned `/opt` is mode 0777. The exact disposable-runner
ancestry setup now secures that measured directory, preserving owner/inode
checks and the original application's ownership requirements. Native repetition
is still required. Earlier preflight/input failures remain recorded: missing
frozen history in shallow checkout, and a private draft exceeding an obsolete
32-asset count cap. Exact frozen-source fetch and a 256 KiB private metadata
budget replace those assumptions without changing selected signed asset pins.

Flatpak run 39138975316 stopped at AT-SPI/launcher PID provenance before disclosure
input. Corrected bus-peer/namespace observations pass 35 pure regressions, but
are not accepted activation and do not resolve the separate missing SteamOS
host dependency/packaging implementation.

The first source CI run after Plugins removal exposed two prerequisite gaps:
the Unix writer fixture did not include the real integration-context module,
and the frontend job had not built the refusal-only helper needed by its Node
tests. Both have explicit source/workflow regressions. Superseded hosted-app
Unix packaging is disabled while direct integration is required; Linux source
checks remain active and Mac jobs remain disabled.
