/** Local operator only. No root .env, provider key loader, runtime bootstrap or seed. */
import { readFile, lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parseEnv } from 'node:util';
import { createConnection } from 'node:net';
import { createRequire } from 'node:module';
import pg from 'pg';
const { convertSavedCampaignToTurns } = createRequire(import.meta.url)(
  '../apps/api/dist/game/turn-conversion.js',
);
const accepted = new Set([
  '--database-env-file',
  '--campaign',
  '--owner-handle',
  '--expected-revision',
  '--operation-id',
  '--backup-file',
]);
const flags = new Map();
let apply = false;
const fail = (code) => {
  throw new Error(code);
};
async function runtimeListening() {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port: 4000 });
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
try {
  if (process.env.NODE_ENV === 'production') fail('LOCAL_CONVERSION_ONLY');
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--apply') {
      if (apply) fail('INVALID_ARGUMENTS');
      apply = true;
      continue;
    }
    if (
      !accepted.has(flag) ||
      flags.has(flag) ||
      !args[index + 1] ||
      args[index + 1].startsWith('--')
    )
      fail('INVALID_ARGUMENTS');
    flags.set(flag, args[++index]);
  }
  const file = flags.get('--database-env-file'),
    id = flags.get('--campaign'),
    owner = flags.get('--owner-handle');
  if (
    !file ||
    !isAbsolute(file) ||
    !/^[a-f0-9-]{36}$/.test(id ?? '') ||
    !/^[a-z0-9_]{3,30}$/.test(owner ?? '')
  )
    fail('INVALID_ARGUMENTS');
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
    fail('DATABASE_CONFIGURATION_INVALID');
  const env = parseEnv(await readFile(file, 'utf8'));
  if (Object.keys(env).length !== 1 || !env.DATABASE_URL) fail('DATABASE_CONFIGURATION_INVALID');
  const uri = new URL(env.DATABASE_URL);
  if (
    !['postgresql:', 'postgres:'].includes(uri.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(uri.hostname)
  )
    fail('LOCAL_DATABASE_REQUIRED');
  if (apply && (await runtimeListening())) fail('TURN_CONVERSION_RUNTIME_RUNNING');
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5000 });
  const client = await pool.connect();
  try {
    await client.query(apply ? 'BEGIN' : 'BEGIN READ ONLY');
    const row = (
      await client.query(
        "SELECT c.revision,c.event_seq,c.updated_at,c.runtime_clock->>'paused' AS paused,c.state ? 'turnController' AS turn_based FROM game_campaigns c JOIN users u ON u.id=c.owner_id WHERE c.id=$1 AND lower(u.handle)=lower($2) AND u.deleted_at IS NULL",
        [id, owner],
      )
    ).rows[0];
    if (!row) fail('TURN_CONVERSION_OWNER_REQUIRED');
    if (apply) {
      const backup = flags.get('--backup-file');
      if (!backup || !isAbsolute(backup) || !backup.endsWith('.dump.dpapi'))
        fail('FRESH_BACKUP_REQUIRED');
      const stat = await lstat(backup);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size < 100 ||
        stat.mtimeMs < new Date(row.updated_at).getTime()
      )
        fail('FRESH_BACKUP_REQUIRED');
      const revision = Number(flags.get('--expected-revision'));
      if (
        !Number.isSafeInteger(revision) ||
        revision < 0 ||
        !flags.has('--expected-revision') ||
        !flags.has('--operation-id')
      )
        fail('INVALID_ARGUMENTS');
      const result = await convertSavedCampaignToTurns(client, {
        campaignId: id,
        ownerHandle: owner,
        expectedRevision: revision,
        operationId: flags.get('--operation-id'),
      });
      await client.query('COMMIT');
      console.log(JSON.stringify(result));
    } else {
      await client.query('COMMIT');
      console.log(
        JSON.stringify({
          status: 'plan',
          campaignId: id,
          revision: Number(row.revision),
          sequence: Number(row.event_seq),
          paused: row.paused === 'true',
          turnBased: row.turn_based,
        }),
      );
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
} catch (error) {
  const code = typeof error?.code === 'string' ? error.code : error?.message;
  const safe =
    /^(?:TURN_[A-Z_]+|STALE_STATE|RECOVERY_REQUIRED|IDEMPOTENCY_CONFLICT|INVALID_ARGUMENTS|LOCAL_[A-Z_]+|DATABASE_CONFIGURATION_INVALID|FRESH_BACKUP_REQUIRED)$/.test(
      code ?? '',
    )
      ? code
      : 'TURN_CONVERSION_FAILED';
  console.error(safe);
  process.exitCode = 1;
}
