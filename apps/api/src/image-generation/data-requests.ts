import type { PoolClient } from 'pg';
export async function eraseImageGeneration(c: PoolClient, userId: string) {
  if (
    !(
      await c.query(
        "SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NOT NULL AND current_setting('dreamwalk.erasure',true)='confirmed'",
        [userId],
      )
    ).rowCount
  )
    throw new Error('CONFIRMED_ERASURE_REQUIRED');
  const files = (
    await c.query(
      'SELECT id,quarantine_filename FROM image_generation_jobs WHERE actor_id=$1 FOR UPDATE',
      [userId],
    )
  ).rows
    .map((r) => r.quarantine_filename ?? `${r.id}.image-quarantine`)
    .filter(
      (s): s is string => typeof s === 'string' && /^[a-f0-9-]{36}\.image-quarantine$/.test(s),
    );
  await c.query(
    "UPDATE image_generation_jobs SET cancel_requested=true,quota_reserved_bytes=0,input='{}',reference_hashes='{}',request_hash='erased',provider_request_id=NULL,quarantine_filename=NULL,quarantine_sha256=NULL,quarantine_mime=NULL,error_code='ERASED',updated_at=now() WHERE actor_id=$1",
    [userId],
  );
  await c.query(
    "UPDATE image_generation_quotes SET input='{}',reference_hashes='{}',request_hash='erased' WHERE actor_id=$1",
    [userId],
  );
  await c.query(
    "UPDATE image_generation_attempts SET request_hash='erased',provider_request_id=NULL WHERE job_id IN (SELECT id FROM image_generation_jobs WHERE actor_id=$1)",
    [userId],
  );
  await c.query('UPDATE generation_budget_reservations SET actor_id=NULL WHERE actor_id=$1', [
    userId,
  ]);
  await c.query(
    'DELETE FROM image_generation_cleanup WHERE job_id IN (SELECT id FROM image_generation_jobs WHERE actor_id=$1)',
    [userId],
  );
  return { quarantineFilenames: files };
}
export async function exportImageGeneration(c: PoolClient, userId: string) {
  return {
    quotes: (
      await c.query(
        `SELECT q.id,q.adventure_id,q.input,q.mode,q.upper_micros,q.expires_at,q.created_at,
       EXISTS(SELECT 1 FROM image_generation_jobs j WHERE j.quote_id=q.id) AS consumed
       FROM image_generation_quotes q WHERE q.actor_id=$1 ORDER BY q.created_at`,
        [userId],
      )
    ).rows,
    jobs: (
      await c.query(
        'SELECT id,adventure_id,input,mode,status,upper_micros,actual_micros,admitted_revision_id,error_code,created_at FROM image_generation_jobs WHERE actor_id=$1 ORDER BY created_at',
        [userId],
      )
    ).rows,
  };
}
