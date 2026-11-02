import { Pool } from 'pg';
import {
  productionMigrationSql,
  assertProductionDatabasePrerequisites,
} from './production-migrations';
import { postgresConnectionConfig } from './postgres-connection';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  canonicalMigrationSql,
  migrationChecksum,
  matchesMigrationChecksum,
} from './migration-checksum';
async function main() {
  const p = new Pool(postgresConnectionConfig(process.env, 'migration'));
  const c = await p.connect();
  try {
    const production =
      process.argv.includes('--production') || process.env.NODE_ENV === 'production';
    if (production) {
      const prerequisites = await c.query(
        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname='pgcrypto') AS installed, to_regprocedure('digest(text,text)') IS NOT NULL AS digest_visible",
      );
      assertProductionDatabasePrerequisites(prerequisites.rows[0]);
    }
    await c.query('SELECT pg_advisory_lock(7781801)');
    await c.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    // Anchor to this module; Windows workspace cwd uses backslashes.
    const directory = resolve(__dirname, '../../../packages/db/migrations');
    for (const name of (await readdir(directory)).filter((n) => n.endsWith('.sql')).sort()) {
      const originalSql = await readFile(resolve(directory, name), 'utf8');
      const sql = canonicalMigrationSql(originalSql),
        hash = migrationChecksum(sql);
      const old = (await c.query('SELECT sha256 FROM schema_migrations WHERE name=$1', [name]))
        .rows[0];
      if (old) {
        if (!matchesMigrationChecksum(originalSql, old.sha256))
          throw new Error(`Migration checksum changed: ${name}`);
        continue;
      }
      await c.query('BEGIN');
      try {
        await c.query(production ? productionMigrationSql(name, sql, true) : sql);
        await c.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)', [name, hash]);
        await c.query('COMMIT');
        console.log(`Applied ${name}`);
      } catch (e) {
        await c.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    await c.query('SELECT pg_advisory_unlock(7781801)');
    c.release();
    await p.end();
  }
}
void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
