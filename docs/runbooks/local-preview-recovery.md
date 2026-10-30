# Local managed-preview PostgreSQL recovery

This is a development-only incident procedure, not production backup/restore guidance.
The managed preview owns the application and PostgreSQL process namespace. Shell invocations
may use different namespaces, so a failed loopback connection alone does not prove that a
server is stopped. Keep the same `.local/preview-live` data directory; never replace it with
an empty cluster to make startup succeed.

## Normal restart

1. Stop through `sites-preview stop`, then check `sites-preview status`.
2. Wait for PostgreSQL's clean shutdown log and disappearance of `postmaster.pid`.
3. Start through `sites-preview start <absolute-checkout-path>`.
4. Verify the browser URL, session, saved private stories, published versions and notifications.

The launcher deliberately refuses a pre-existing lock. Do not delete a PID file blindly.

## Abrupt-stop incident observed 2026-10-30

The managed daemon reported stopped, but the PostgreSQL log contained no shutdown record and
its PID file remained. The preview launcher refused to continue. The bundled `pg_ctl status`
reported no server running; that result was considered alongside daemon status, not alone.
A private full copy of the stopped cluster and its configuration was taken before recovery
(ignored `.local/recovery`, permission 0600). No live data-directory copy was claimed as a
consistent backup, and no database reset, manual lock deletion or shared-memory removal occurred.

The existing PostgreSQL 17 executable was started against the **same** data directory in one
bounded shell invocation, with the existing TCP-only localhost configuration. PostgreSQL itself
performed its stale-lock/shared-memory checks, detected an interrupted shutdown and replayed
WAL. If it had reported a live process or resource conflict, the procedure would have stopped;
never force past that protection. After readiness, a connection using the private local
configuration verified that the pre-existing user, adventure and session counts were preserved. A fast SIGINT shutdown was awaited
until the child exited and the PID file disappeared. Only then was normal managed preview
startup resumed to apply migration 005 and the idempotent curated-metadata seed upgrade.

Recovery logs and the pre-recovery copy remain private, excluded from Git/artifacts. Browser
verification confirmed authenticated language preference and both authored stories survived.
The normal launcher guard remains unchanged; recovery is not an automatic stale-lock bypass.

Reference: [PostgreSQL 17 server startup and lock protection](https://www.postgresql.org/docs/17/server-start.html).
