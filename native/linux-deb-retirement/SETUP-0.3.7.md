# Experimental Setup 0.3.7 Helper

The exact public `Creator.Project.Setup_0.3.7_amd64.deb` is 5966970 bytes,
SHA-256 `be18f23450146e71a2960e2110474f6e0409a9521a3ced308b7fd6a6d584c63d`.
Passive archive inspection found only control/md5sums and five GUI files;
the complete original pins and controls are in `src/setup.rs` and fixtures.
No package or GUI was installed or executed.

The TEST ONLY contract is a higher-version, same-name, scriptless
package containing one fixed non-executable notice. It has no dependencies,
relationships, scripts, conffiles or user-data paths. It is not an accepted
native tombstone or production migration. Source/unit/cross-compile tests do
not establish native package behavior or user-data preservation.

Finite commands: `inspect-setup-0.3.7` independently recognizes exact absent,
original and compatibility states; `inspect-retained-setup-0.3.7` requires
compatibility. Both are read-only, ignore retry markers as state authority and
keep mutation/native flags false. Unknown/held/foreign/pending states refuse.
`retire-setup-0.3.7` is refused by default. Only `experimental-transaction`
admits the fixed installed helper, original five-file baseline and fresh stage.

Setup owns `/var/lib/creator-hub-deb-retirement-setup`, a distinct root-private
namespace. Fresh `setup-0.3.7-preparation-<32 lowercase hex>` stages contain
`gui-tombstone.deb` and protected dpkg logs. `transaction-attempted` is persisted
before handoff, retained after every attempted transaction, and refuses retry.
Neither namespace nor marker is shared with MCP. No old candidate is reused.
Pre-existing notice paths/ownership and unknown private members refuse.

Success uses `experimental-transaction-verified`, fixed package/version,
`retainedFilesVerified:0`, `omittedFilesVerified:5`, `tombstoneFilesVerified:1`,
`packageTransactionStarted:true`, `installationEnabled:false` and
`nativeAcceptance:false`. Failures retain the common refused/manual-review
schema, including unknown transaction state for an earlier attempt marker.
The exact five omissions and fixed notice are independently verified afterward.

Native diagnostic 38754932346 verified dpkg's unchanged minimized-Ubuntu
`path-exclude=/usr/share/doc/*` policy omitted the original notice destination
after an otherwise healthy transaction. Required transition state now lives at
`/usr/share/creator-project-setup/retired-by-creator-hub.txt`, not in optional
documentation. Its bytes, hash and mode are unchanged. No distro policy is
rewritten or overridden. Native run 38755581264 subsequently passed both MCP and
Setup transactions with the new destination, the same live SDK connection,
byte-identical settings sentinels and complete protected diagnostics. See
[the scoped receipt](../../docs/evidence/linux-deb-helper-mechanism-38755581264.json).
This is sudo mechanism proof, not Hub approval, polkit, GUI close or complete
migration acceptance. The earlier failed transaction remains retained with its
attempt marker; no failed transaction was repaired or replayed.

Next measured gate, after review: disposable positive MCP plus Setup with the
original public DEBs, both post-inspects and complete protected logs; negatives
for changed files/foreign ownership, pre-existing notice/user-data sentinel,
repeat and interruption. Capture settings/project/cache hashes before/after.
No native run or package installation was performed at the initial source-only
checkpoint. The later, explicitly scoped native result above supersedes that
checkpoint without qualifying the remaining negative/full-flow gates.

`inspect-retained-mcp-2.7.7` is a separate read-only postcheck: it independently
validates the existing fixed MCP compatibility state and paths, without using
or clearing the retry marker. It does not authorize installation or retry.
