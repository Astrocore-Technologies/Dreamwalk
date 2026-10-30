/** Explicit operator action on ONE request. Never drains queues implicitly. */
import pg from 'pg';
import { exportGameData, purgeGameData } from './game-data-requests.mjs';
import { readFile, unlink } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const id = arg('--request'),
  operator = arg('--operator');
if (
  !process.argv.includes('--request') ||
  !/^[0-9a-f-]{36}$/i.test(id ?? '') ||
  !process.argv.includes('--operator') ||
  !/^[a-zA-Z0-9._:@-]{3,100}$/.test(operator ?? '')
)
  throw new Error(
    'Usage: --request UUID --operator audited-reference [--confirm-purge UUID | --expire]',
  );
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL }),
  c = await pool.connect();
let locked = false;
const rows = async (sql, values = []) => (await c.query(sql, values)).rows;
const audit = async (action, user) =>
  c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES(NULL,$1,$2,$3)', [
    action,
    user,
    JSON.stringify({ requestId: id, operator }),
  ]);
const assetPath = (filename) => {
  if (basename(filename) !== filename || !/^[0-9a-f-]{36}\.webp$/i.test(filename))
    throw new Error('Unsafe stored asset filename');
  return resolve(process.env.ASSET_DIR || '.local/assets', filename);
};
try {
  await c.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`data-request:${id}`]);
  locked = true;
  const request = (await rows('SELECT * FROM data_requests WHERE id=$1', [id]))[0];
  if (!request) throw new Error('Request not found');
  if (process.argv.includes('--expire')) {
    if (
      request.kind !== 'export' ||
      !request.expires_at ||
      new Date(request.expires_at) > new Date()
    )
      throw new Error('Only an expired export may be removed');
    await c.query('BEGIN');
    await c.query("UPDATE data_requests SET artifact=NULL,status='expired' WHERE id=$1", [id]);
    await audit('operator.export_expired', request.user_id);
    await c.query('COMMIT');
  } else if (request.status === 'completed') {
    console.log('Request already completed; no changes.');
  } else {
    if (!['requested', 'processing', 'failed'].includes(request.status))
      throw new Error('Request is not processable');
    const user = (await rows('SELECT * FROM users WHERE id=$1', [request.user_id]))[0];
    if (
      request.kind === 'deletion' &&
      (!user.deleted_at ||
        arg('--confirm-purge') !== id ||
        !process.argv.includes('--confirm-purge'))
    )
      throw new Error(
        'Purge requires a deleted account and --confirm-purge matching the request UUID',
      );
    if (request.kind === 'export' && user.deleted_at)
      throw new Error('Deleted accounts cannot receive exports');
    await c.query('BEGIN');
    await c.query(
      "UPDATE data_requests SET status='processing',processing_started_at=now(),operator_reference=$2 WHERE id=$1",
      [id, operator],
    );
    await audit(`operator.${request.kind}_started`, user.id);
    await c.query('COMMIT');
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const current = (
      await rows('SELECT deleted_at FROM users WHERE id=$1 FOR UPDATE', [user.id])
    )[0];
    if (request.kind === 'export' && current.deleted_at) throw new Error('Account was deleted');
    const assets = await rows(
      'SELECT id,filename,mime,width,height,bytes,sha256,created_at FROM assets WHERE owner_id=$1',
      [user.id],
    );
    if (request.kind === 'export') {
      const profile = (
        await rows(
          'SELECT id,email,name,handle,bio,avatar_asset_id,settings,onboarded,created_at FROM users WHERE id=$1',
          [user.id],
        )
      )[0];
      const artifact = {
        format: 'dreamwalk-account-export-v1',
        generatedAt: new Date().toISOString(),
        profile,
        game: await exportGameData(c, user.id),
        heroes: await rows('SELECT id,data,created_at,updated_at FROM heroes WHERE owner_id=$1', [
          user.id,
        ]),
        npcs: await rows('SELECT id,data,created_at,updated_at FROM npcs WHERE owner_id=$1', [
          user.id,
        ]),
        adventures: await rows(
          'SELECT id,slug,title,synopsis,genre,status,visibility,version,data,created_at,updated_at FROM adventures WHERE owner_id=$1',
          [user.id],
        ),
        versions: await rows(
          'SELECT v.* FROM adventure_versions v JOIN adventures a ON a.id=v.adventure_id WHERE a.owner_id=$1',
          [user.id],
        ),
        favorites: await rows('SELECT adventure_id,created_at FROM favorites WHERE user_id=$1', [
          user.id,
        ]),
        sessions: await rows(
          'SELECT id,user_agent,created_at,last_seen_at,expires_at FROM sessions WHERE user_id=$1',
          [user.id],
        ),
        reports: await rows(
          'SELECT id,adventure_id,reason,status,created_at FROM reports WHERE reporter_id=$1',
          [user.id],
        ),
        notifications: await rows(
          'SELECT type,payload,read,created_at FROM notifications WHERE user_id=$1',
          [user.id],
        ),
        invitations: await rows(
          'SELECT id,adventure_id,owner_id,recipient_id,status,created_at,updated_at FROM adventure_invitations WHERE owner_id=$1 OR recipient_id=$1',
          [user.id],
        ),
        wallet: (await rows('SELECT balance FROM wallets WHERE user_id=$1', [user.id]))[0],
        ledger: await rows('SELECT id,amount,reason,created_at FROM ledger WHERE user_id=$1', [
          user.id,
        ]),
        assets: await Promise.all(
          assets.map(async ({ filename, ...asset }) => ({
            ...asset,
            base64: (await readFile(assetPath(filename))).toString('base64'),
          })),
        ),
      };
      await c.query(
        "UPDATE data_requests SET status='completed',artifact=$2,completed_at=now(),expires_at=now()+interval '7 days' WHERE id=$1",
        [id, JSON.stringify(artifact)],
      );
    } else {
      // Files first: missing files are safe on retries; DB rows remain until full completion.
      for (const asset of assets)
        try {
          await unlink(assetPath(asset.filename));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      await c.query("SET LOCAL dreamwalk.erasure='confirmed'");
      await purgeGameData(c, user.id);
      await c.query(
        `UPDATE adventure_versions v SET snapshot='{"erased":true}' WHERE EXISTS(SELECT 1 FROM adventures a WHERE a.id=v.adventure_id AND a.owner_id=$1)`,
        [user.id],
      );
      await c.query(
        `UPDATE audit SET details='{"erased":true}' WHERE actor_id=$1 OR target_id=$1::text OR target_id IN(SELECT id::text FROM adventures WHERE owner_id=$1)`,
        [user.id],
      );
      await c.query(
        "UPDATE ledger SET reason='Erased account',source_key='erased:'||id::text WHERE user_id=$1",
        [user.id],
      );
      await c.query('DELETE FROM adventure_invitations WHERE owner_id=$1 OR recipient_id=$1', [
        user.id,
      ]);
      await c.query(
        "DELETE FROM notifications WHERE user_id=$1 OR payload->>'adventureId' IN(SELECT id::text FROM adventures WHERE owner_id=$1)",
        [user.id],
      );
      await c.query(
        'DELETE FROM reports WHERE reporter_id=$1 OR adventure_id IN(SELECT id FROM adventures WHERE owner_id=$1)',
        [user.id],
      );
      await c.query(
        'DELETE FROM favorites WHERE user_id=$1 OR adventure_id IN(SELECT id FROM adventures WHERE owner_id=$1)',
        [user.id],
      );
      await c.query('DELETE FROM sessions WHERE user_id=$1', [user.id]);
      await c.query('DELETE FROM auth_email_tokens WHERE user_id=$1', [user.id]);
      await c.query('DELETE FROM heroes WHERE owner_id=$1', [user.id]);
      await c.query('DELETE FROM npcs WHERE owner_id=$1', [user.id]);
      await c.query(
        "UPDATE adventures SET slug='erased-'||id::text,title='Deleted content',synopsis='',genre='',data='{}',published_snapshot=NULL,status='archived',visibility='private' WHERE owner_id=$1",
        [user.id],
      );
      await c.query(
        'UPDATE users SET avatar_asset_id=NULL WHERE avatar_asset_id IN(SELECT id FROM assets WHERE owner_id=$1)',
        [user.id],
      );
      await c.query('DELETE FROM assets WHERE owner_id=$1', [user.id]);
      await c.query(
        "UPDATE data_requests SET artifact=NULL,status='expired' WHERE user_id=$1 AND kind='export'",
        [user.id],
      );
      await c.query("UPDATE data_requests SET status='completed',completed_at=now() WHERE id=$1", [
        id,
      ]);
    }
    await audit(`operator.${request.kind}_completed`, user.id);
    await c.query('COMMIT');
    console.log('Specified request completed; contents are not printed.');
  }
} catch (error) {
  await c.query('ROLLBACK');
  // No sensitive exception content persisted. The same explicit request can be retried.
  await c.query("UPDATE data_requests SET status='failed' WHERE id=$1 AND status='processing'", [
    id,
  ]);
  throw error;
} finally {
  if (locked)
    await c.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [`data-request:${id}`]);
  c.release();
  await pool.end();
}
