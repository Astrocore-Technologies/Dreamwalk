# Server PostgreSQL transport and roles

The API, migration runner and explicit seed command share `postgresConnectionConfig`.
These settings are server-only. Never place database URLs, passwords or CA material
in browser configuration or logs.

- `DATABASE_URL`: runtime connection using the application's least-privileged role.
- `DATABASE_MIGRATION_URL`: optional separate owner/migrator connection, selected
  **only** by the migration runner. If absent, migration uses `DATABASE_URL`.
  Seed and the normal API do not select this privileged URL. If Railway supplies
  both URLs as variables of the same service, both secrets are still accessible to
  that service's runtime process. Role selection is not full credential isolation;
  a separate migration execution environment/secret scope is needed for that.
- `DATABASE_SSL=true`: require TLS with certificate-chain and hostname validation
  (`rejectUnauthorized: true`). Without this setting, or with explicit `false`,
  the legacy local/private non-TLS behavior remains; TLS is not silently inferred.
- `DATABASE_SSL_CA`: optional PEM certificate/CA chain for the verified database
  endpoint. Requires TLS, accepts at most 16 certificates / 128 KiB. Use the actual
  provider-issued certificate material, not a guessed certificate or a disabled
  verification workaround. If omitted, Node's configured trust roots apply.

TLS URL options (`ssl`, `sslmode`, `sslrootcert`, `sslcert`, `sslkey`, and other
`ssl*` parameters) and `uselibpqcompat` are rejected: node-postgres can otherwise
replace an explicit TLS policy while parsing the connection URL. Remove those
parameters and set the server variables above. Query host overrides are likewise
rejected so the URL's hostname is the peer being verified. Normal non-TLS query
settings such as `application_name` are retained.

Use a direct PostgreSQL endpoint (production: Railway private network, no TLS,
`DATABASE_SSL=false`) or a **session-mode** pooler verified by the operator. Do not use a transaction-mode pooler for migrations: the runner uses a
session advisory lock. Current role/search-path decisions must be configured on
the database role, not simulated by changing application authorization. The
runtime remains Nest-owned and uses the application's existing cookie sessions
and server ACLs.

`npm run db:migrate:production` explicitly enables production safeguards even if
`NODE_ENV` was omitted. Before schema DDL, it reads whether pgcrypto is installed
and `digest(text,text)` resolves in the current search path. Both must succeed.
A missing extension or invisible function fails closed and requires the database
operator to fix setup. Existing historical SQL files and checksums are unchanged;
only the exact already-reviewed extension-install statement in migration 001 is
omitted from the executed production SQL. No extension installation is performed.

Role setup, schema isolation, extension placement, CA/host selection, provider
limits, and real connection/restore checks belong to the deployment runbook.
This configuration change does not provision a database, grant roles, run seeds,
perform migrations, or establish that a remote database connection works.

References:

- https://node-postgres.com/features/ssl

Ancillary operator scripts (for example account grants or backup/restore helpers)
may construct their own PostgreSQL connections and do not automatically inherit
this helper. Review/adapt those tools before using them against a TLS-only host;
do not disable verification or run an unreviewed seed as a shortcut.
