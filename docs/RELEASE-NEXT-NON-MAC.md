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
synthetic approval on disposable GitHub Linux runners. Its 104 pure tests and
workflow/script parse checks pass. Scoped acceptance requires actual package and
executable replacement, product-initiated restart, fresh UI ownership, unchanged
settings/selection and unrelated synthetic runtime, and normal close. Native
complete-flow acceptance remains required; its private 0.1.15 fixture cannot qualify or publish
the new source candidate.

Capture run 39259885862 and native system-Cancel run 39260331976 passed their
finite scopes. Cancel retained the original package, live Hub, settings, selected
project and unrelated synthetic runtime. Approval runs, including 39272042921,
verified the exact private 0.1.15 package/ELF, clean `dpkg --verify`, original
Hub exit zero and a genuinely automatic new Hub process. They have not yet
passed the remaining visible-version, preservation and normal-close obligations.

Post-restart harness corrections retain the exact process/hash/UID/parent,
D-Bus, XRes and renderer checks. X11 may reuse an old numerical window ID; the
new process must independently own it. Accessibility reads use the established
same-frame semantic-parent walker, with an initial canonical frame binding.
The already-bound authentication-agent endpoint is rechecked directly instead
of enumerating unrelated system-bus connections that may close after approval.
Dead processes are never admitted as Hub and no manual restart substitutes for
the application's automatic restart. Original failure reports are retained.

Full source CI 39259888960 and direct Linux library checks 39260921684 passed
at source 69cb13a; macOS was skipped. Subsequent controller-only corrections
reuse the immutable signed product inputs rather than rebuilding those apps.
None of these older-package results qualifies a final 0.1.16 installer.

Run 39273696186 verified the replacement and automatic restart, dismissed the
expected migration offer once, and scrolled the owned footer control into view
without opening its link. It still refused visible-version acceptance because
the current accessibility text reader returned no version text. A bounded,
failure-only interface capture is the next diagnostic; it cannot substitute for
readiness or erase the original refusal. No complete approval pass is claimed.

## Windows Candidate Checkpoint

The local 0.1.16 direct-feature candidate built successfully at
`artifacts/unified/windows-016-20261019`. Installer extraction verified the raw
and packaged Hub executable; PE ProductVersion is 0.1.16.

- Installer SHA-256: `7229cfcf919dc3a9e27a459fd482cbbe059fd54caa9ad379b2a75c8baa113a20`.
- Hub SHA-256: `7ef27351edefe4545d3e530e8d5c51e7eb3092e7cc7b20498591bfe7456c2389`.
- Both managed runtime/router signatures passed offline production-key checks,
  including rejection of altered metadata. This is not installer acceptance.
- The installed local app was not replaced and remains at its original hash.
- The Windows smoke now has an exact source-bound 0.1.16 direct-page branch;
  historical hosted assertions remain. The focused combined suite passed 55
  tests. Native-HTTP catalogue capture and actual install/update execution are
  still required. Renderer request/resource checks do not claim native-HTTP proof.
- The historical controlled-lab feed/workflow still selects 0.1.12/0.1.14 and
  cannot be used unchanged for an incoming public 0.1.14-to-0.1.16 test. A new
  finite lab contract must preserve those original fixtures and bind this exact
  new installer before native execution.

No 0.1.16 release/draft/tag was created, public assets were unchanged, and no
local installer was run. Linux/Flatpak production gates remain open.

## Earlier Fixture Diagnoses

Run 39257702384 passed preflight and signed input staging but stopped in the
fixture broker before Hub launch. Read-only diagnostic run 39258494136 confirmed
the GitHub runner's root-owned `/opt` is mode 0777. The exact disposable-runner
ancestry setup now secures that measured directory, preserving owner/inode
checks and the original application's ownership requirements. Native repetition
is still required. Earlier preflight/input failures remain recorded: missing
frozen history in shallow checkout, and a private draft exceeding an obsolete
32-asset count cap. Exact frozen-source fetch and a 256 KiB private metadata
budget replace those assumptions without changing selected signed asset pins.

Run 39258879815 then passed fixture protection and launched Hub; the terms
acknowledgement was verified. It stopped at the navigation worker because the
Root child environment intentionally strips the component-probe opt-in. The
controller now creates a separate worker-only environment with that exact flag;
a regression exercises the real frozen admission contract and proves the Root
environment is unchanged. This remains a harness correction, not update or
authentication acceptance.

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
