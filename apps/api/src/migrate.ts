import { Pool } from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
async function main() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
  const p = new Pool({ connectionString: process.env.DATABASE_URL });
  const c = await p.connect();
  try {
    await c.query('SELECT pg_advisory_lock(7781801)');
    await c.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const directory = resolve(
      process.cwd().endsWith('/apps/api')
        ? '../../packages/db/migrations'
        : 'packages/db/migrations',
    );
    for (const name of (await readdir(directory)).filter((n) => n.endsWith('.sql')).sort()) {
      const sql = await readFile(resolve(directory, name), 'utf8'),
        hash = createHash('sha256').update(sql).digest('hex');
      const old = (await c.query('SELECT sha256 FROM schema_migrations WHERE name=$1', [name]))
        .rows[0];
      if (old) {
        if (old.sha256 !== hash) throw new Error(`Migration checksum changed: ${name}`);
        continue;
      }
      await c.query('BEGIN');
      try {
        await c.query(sql);
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
