/** Cross-platform PostgreSQL WAL ledger for the isolated live evaluation only. */
import { LIMITS, createDurableStoryGuard } from './guard.mjs';
export const LEDGER_ID = 'approved-text-evaluation-20261031';
export async function createPgStoryGuard(connectionString, transport, { initialize = false } = {}) {
  const url = new URL(connectionString);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    throw Error('ISOLATED_LOCAL_LEDGER_REQUIRED');
  const { Client } = await import('pg');
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
    statement_timeout: 5000,
  });
  let healthy = true,
    closed = false;
  client.on('error', () => {
    healthy = false;
  });
  const close = async () => {
    if (!closed) {
      closed = true;
      healthy = false;
      await client.end();
    }
  };
  try {
    await client.connect();
    await client.query("SET synchronous_commit='on'");
    const flags = (
      await client.query(
        "SELECT current_setting('fsync') AS fsync,current_setting('full_page_writes') AS full_page_writes,current_setting('synchronous_commit') AS synchronous_commit",
      )
    ).rows[0];
    if (Object.values(flags).some((v) => v !== 'on')) throw Error('DURABLE_POSTGRES_REQUIRED');
    const locked = (
      await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [
        LEDGER_ID,
      ])
    ).rows[0].acquired;
    if (!locked) throw Error('EVALUATION_ALREADY_RUNNING');
    const exists = (
      await client.query("SELECT to_regclass('public.live_story_evaluation_ledger') AS ledger")
    ).rows[0].ledger;
    if (!exists && !initialize) throw Error('EXISTING_EVALUATION_LEDGER_MISSING');
    if (!exists) {
      await client.query(
        'CREATE TABLE live_story_evaluation_ledger (id text PRIMARY KEY,state jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now())',
      );
      await client.query('INSERT INTO live_story_evaluation_ledger(id,state) VALUES($1,$2)', [
        LEDGER_ID,
        { version: 1, limits: LIMITS, attempts: [] },
      ]);
    }
    const state = (
      await client.query('SELECT state FROM live_story_evaluation_ledger WHERE id=$1', [LEDGER_ID])
    ).rows[0]?.state;
    if (!state) throw Error('EXISTING_EVALUATION_LEDGER_MISSING');
    return createDurableStoryGuard(
      state,
      async (value) => {
        if (!healthy || closed) throw Error('LEDGER_CONNECTION_LOST');
        // Autocommit + synchronous_commit=on acknowledges only the durable WAL commit.
        const saved = await client.query(
          'UPDATE live_story_evaluation_ledger SET state=$2,updated_at=now() WHERE id=$1',
          [LEDGER_ID, value],
        );
        if (saved.rowCount !== 1) throw Error('LEDGER_MISSING');
      },
      close,
      transport,
    );
  } catch (e) {
    await close();
    throw e;
  }
}
export async function readPgStoryLedger(connectionString) {
  const { Client } = await import('pg');
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
    statement_timeout: 5000,
  });
  await client.connect();
  try {
    return (
      await client.query('SELECT state FROM live_story_evaluation_ledger WHERE id=$1', [LEDGER_ID])
    ).rows[0]?.state;
  } finally {
    await client.end();
  }
}
