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

The application integration suite validates fresh migrations and invariants. A full operator backup/restore drill has not been claimed unless explicitly recorded in `docs/progress.md`. Public release requires retention, deletion, backup schedule, restore objectives and actual recovery evidence.
