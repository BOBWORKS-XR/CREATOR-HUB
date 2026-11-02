# Mixed public migration / controlled outgoing diagnostic

This is a diagnostic draft, not an isolation or release qualification. Do not
dispatch before independent review. Its separate job in the existing outgoing
workflow invokes the exact R2 migration before starting the controlled outgoing
TLS lifecycle. Public migration network access is allowed but unobserved;
whether public discovery occurred is unproven. The outgoing phase alone uses the pinned lab feed and
retains five-route/zero-rejection checks. No production release is changed.

The handoff binds the run, attempt, actor, source, profile paths, migration
report and 23 fixture file hashes. The outgoing process uses the migration's
owned WebView data directory, but the receipt deliberately does not claim
WebView continuity. The migration-era SDK client is closed by migration;
connection survival refers only to a connection opened in the outgoing phase.
The active route is checked after cancellation, and fixture verification is
latched through driver cleanup. The outer lifecycle separately requires a
successful driver report, process inventory, trust cleanup and explicit
successor cleanup verification. Timeout or driver death cannot yield a receipt.
If the outgoing driver started and successor cleanup was not verified, the
lifecycle records `hubCleanupState=unknown`, `hubCleanupUnknown=true` and
aggregate `cleanupVerified=false`, even when trust and proxy cleanup succeed.
The driver starts behind a bounded stdin gate. The lifecycle releases it only
after process identity capture and cleanup-watcher registration; if either
fails, the driver module is never loaded and cleanup remains unverified.
An initial root whose owned PID, parent, image and kernel identity cannot be
recovered is marked cleanup-unverified. If an update was approved but no
successor identity was captured, successor cleanup is unverified and no process
is killed by name. Such a successor may remain until the disposable runner ends.

Required dispatch inputs after review are `mixed_public_diagnostic=true`,
`migrated=false`, `mixed_expected_source` equal to the independently reviewed
workflow commit, and `mixed_expected_actor_id` equal to the intended actor's
numeric ID. The workflow's existing required outgoing artifact inputs must
also be supplied. Diagnostic opt-in excludes the ordinary acceptance job;
its existing branch and runner restrictions remain intact. Workflow
registration/input availability is not verified here.

The R2 migration input is bound to run 41446190810 and artifact 13141988162;
the outgoing fixture is bound to run 41458124135 and artifact 13147427412.
The diagnostic's separate review JSON, exact byte pins and fixed fixture checks
do not authorize production. No migration-era AI-client or physical-user
acceptance, network isolation, combined acceptance, or release readiness is
claimed. The original migrated acceptance gate remains closed.
