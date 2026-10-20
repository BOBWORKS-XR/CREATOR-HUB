# Repair Preview and Recovery

Inspection is read-only. Repair and validation both launch Unity and can trigger
package imports, compilation, and package-owned Editor callbacks. The application
does not guarantee that third-party callbacks are read-only.

## Before Approving

- Close the selected project in Unity.
- Keep a full copy or version-control checkpoint for important content.
- Read the proposed changes. Untested versions and pipeline conversions are not
  silently accepted by this preview.

## Retained Evidence

Each approved operation creates a unique folder in
`.creator-project-setup/backups/` containing the reviewed plan, original package
manifests, project settings, generated Visual Scripting data where present, and
Unity logs/result. This is a selective settings backup, not an entire project copy.
An unsuccessful operation does not automatically roll back.

If Unity reports errors, keep the backup and logs. With Unity closed, compare the
backup with the current files before restoring anything; do not overwrite later
manual changes. Original files can be recovered from the matching relative paths
inside the operation's backup. Files newly introduced during repair have no
original counterpart, so blindly copying a backup over the project is not a full
rollback. Use the reviewed plan and version-control diff to review those additions.

If the application or computer stopped mid-operation, first confirm no Unity
process is still working on the selected project. The operation lock and temporary
validator/request may remain. Do not remove them while a process is active. Retain
the evidence and review the interrupted operation before cleaning up those files
and inspecting again. This preview deliberately refuses to guess whether it is
safe to resume an interrupted repair.

No automated project deletion, Library reset, material conversion, or scene
reconstruction is part of recovery.

## New Project Package Download Failure

A prerelease report on Unity 6000.3.21f1 ended with Package Manager failing to
download `com.unity.timeline` from `download.packages.unity.com` with `ECONNRESET`,
then Unity exiting with code 1. Earlier licensing errors recovered. The log also
contained a `.creator-project-setup` directory-name warning; that warning is not
established as the cause of the package-download failure.

The error establishes a connection reset, not whether a firewall, proxy, service
interruption, or another network issue caused it. Check connectivity to the host
reported by Unity. If it persists, use Unity's
[Package Manager network guidance](https://docs.unity3d.com/6000.3/Documentation/Manual/upm-config-network.html)
to check the required endpoints and any proxy configuration. Do not disable TLS
verification or broadly disable security software.

The 0.3.0-alpha.2 diagnostic change shows the package, host, connection error and exit
code when Unity's final package-resolution failure can be identified. It reads a
bounded log tail and retains the log locally, without uploading it. Unknown
failures still link to the log rather than guessing a cause.

Keep the failed project and its log. Once connectivity is restored, the current
new-project flow can make a fresh attempt with a **different project name**; it
cannot resume or overwrite the failed folder. A partial creation may still have
its temporary validator, which deliberately blocks the existing-project repair
flow until reviewed. Do not remove it or delete the project just to bypass that
check. Assisted recovery of that folder needs a separate inspection.

The regression fixture contains only the relevant, sanitized log shape. Raw user
logs can contain machine, session and licensing identifiers and should not be
attached to public issues or committed without review/redaction. Automated tests
of error handling do not prove the reporter's network or project now works.

For report details and a copy-ready template, see [Reporting a setup failure](REPORTING.md).
