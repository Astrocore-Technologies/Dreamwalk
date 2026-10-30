# Backup and restore (operator procedure)

This is a local platform candidate, not an approved public deployment. Do not expose the development server or its database to the Internet.

## What must be preserved

- PostgreSQL: all platform tables, migration history, published versions, ledger and audit.
- Asset directory configured by `ASSET_DIR` (default depends on API working directory).
- Server-only configuration and secrets in a separate encrypted operational backup; never Git.
- Bundled demo assets and source are versioned in Git and should not replace private uploads.

## Logical backup with an external PostgreSQL toolchain

Use tools matching your PostgreSQL major version. In a shell with the database URL already set (never paste it in chat), run:

```sh
umask 077
pg_dump --format=custom --file=backup.dump "$DATABASE_URL"
tar -czf private-assets.tar.gz -- "$ASSET_DIR"
```

Keep backups outside the web root, encrypted and access-controlled. Stop writes or use a consistent snapshot procedure when correlating database and file storage. Do not copy live PostgreSQL data files as an improvised backup.

## Restore drill

1. Provision an isolated fresh database, never overwrite the only live copy.
2. Restore with `pg_restore --no-owner --dbname "$RESTORE_DATABASE_URL" backup.dump`.
3. Restore assets to a non-public directory, preserve ownership, set `ASSET_DIR`.
4. Run migrations using the restored database URL; do not run demo seed in production.
5. Check health, counts, content ownership/private asset access, published versions, and `wallet.balance = SUM(ledger.amount)`.
6. Only switch application configuration after verification and an approved recovery window.

The application integration suite validates fresh migrations and invariants. The isolated synthetic logical restore drill below has been executed; no production operator recovery drill is claimed. Public release requires retention, deletion, backup schedule, restore objectives and actual recovery evidence.

## Executed isolated logical restore drill

`node scripts/backup-restore-drill.mjs` is an executable acceptance test, not an operator
restore command for an existing database. It refuses `DATABASE_URL` and production mode,
creates a uniquely named local PostgreSQL cluster on port 55439, and creates a second,
initially empty `dreamwalk_restored` database. It never reads the preview or production
cluster. The test API binds only `127.0.0.1:4019`; no browser, external provider or payment
service is used.

Requirements: Node 24, `npm ci`, and `pg_dump`/`pg_restore` matching PostgreSQL major 17.
The embedded development PostgreSQL package supplies the server, but not these two clients.
Use installed PostgreSQL clients, or set `PG_CLIENT_BIN` to their trusted installation folder.
The script does not download binaries or change the system package configuration.

```sh
# From the repository root, with PostgreSQL 17 clients on PATH:
env -u DATABASE_URL NODE_ENV=test node scripts/backup-restore-drill.mjs

# With a separately installed client toolchain:
env -u DATABASE_URL NODE_ENV=test PG_CLIENT_BIN=/absolute/path/to/postgresql/17/bin \
  node scripts/backup-restore-drill.mjs
```

The workflow builds API/contracts, applies migrations and seed, and uses real API calls to
create only synthetic accounts, a private story with an accepted invitation and uploaded
raster, a published story with an immutable version, and a demo credit entry. It stops API
writes before `pg_dump --format=custom`, copies the synthetic private assets, then executes
`pg_restore --exit-on-error --single-transaction --no-owner` into the empty target database.
Connection credentials are child-process environment variables, not command-line arguments
or printed URLs. Dump, assets and evidence remain in ignored, private `.local/restore-drill-*`.

### Evidence: 2026-10-30 12:47:59 UTC

The drill completed successfully with **11 checks**, using PostgreSQL server 17.10 and
`pg_dump`/`pg_restore` 17.11 from the official Debian repository. Client packages were extracted
into an ignored workspace directory; no system packages were installed. PostgreSQL shut down
cleanly at 12:48:00 UTC. The managed application preview remained running independently.

Verified:

- All 20 public-schema tables had identical sorted row-content SHA-256 hashes and row counts
  immediately after restore, before any verification requests updated session timestamps.
- Reapplying migrations preserved the restored table hashes and migration checksums.
- Restored asset bytes matched the database SHA-256 values.
- Every wallet balance equalled the sum of its restored integer ledger entries.
- Database triggers still rejected ledger and published-version mutation.
- Both an existing session and a fresh password login authenticated successfully.
- Private stories remained hidden from anonymous users and unrelated authenticated users;
  accepted invitees could read, but not edit, and did not receive NPC secrets.
- Private asset delivery enforced the same owner/invitee boundary after restore.
- Public story snapshots and the author's immutable version history were unchanged.
- Revoking the restored invitation immediately denied story and asset access.

Representative pre-backup counts were 4 users, 6 adventures, 5 adventure versions, 3 sessions,
1 ledger entry, 1 asset and 6 migration records. Machine-readable evidence is retained privately
at `.local/restore-drill-1793364465110/evidence.json`; no backup contents or credentials belong
in Git or published artifacts. This closes the **local synthetic logical backup/restore drill**,
not production recovery operations, encryption/key-management testing or agreed RPO/RTO targets.

### Final-schema rerun: 2026-10-30 13:07:29 UTC

The unchanged drill passed all **11 checks** again after migrations 007–009 (mail token schema,
NPC metadata localization and localized tags). Exact row hashes/counts matched across **22
public-schema tables**, with 9 migration records. The two mail token/cooldown tables were
present and empty; this drill does not claim SMTP delivery coverage. The synthetic entity
counts otherwise remained the same. PostgreSQL completed a clean shutdown at 13:07:29 UTC.
Final private evidence: `.local/restore-drill-1793365634525/evidence.json`.
