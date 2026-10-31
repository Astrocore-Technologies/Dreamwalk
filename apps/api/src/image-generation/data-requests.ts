import type { PoolClient } from 'pg';
import { normalizeSafeImageDiagnostic } from './error-diagnostics';
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
  const campaignIds = (
    await c.query(
      `SELECT c.id FROM game_campaigns c
    WHERE c.owner_id=$1 OR EXISTS(SELECT 1 FROM game_members m WHERE m.campaign_id=c.id AND m.user_id=$1)
    OR EXISTS(SELECT 1 FROM game_playable_versions v JOIN adventures a ON a.id=v.adventure_id WHERE v.id=c.source_version_id AND a.owner_id=$1) ORDER BY c.id FOR UPDATE`,
      [userId],
    )
  ).rows.map((r) => r.id);
  const affected = (
    await c.query(
      `SELECT id,quarantine_filename,admitted_revision_id FROM image_generation_jobs
    WHERE actor_id=$1 OR input->'campaignContext'->>'campaignId'=ANY($2::text[]) FOR UPDATE`,
      [userId, campaignIds],
    )
  ).rows;
  const jobIds = affected.map((r) => r.id),
    revisionIds = affected.map((r) => r.admitted_revision_id).filter(Boolean);
  const files = affected
    .map((r) => r.quarantine_filename ?? `${r.id}.image-quarantine`)
    .filter(
      (s): s is string => typeof s === 'string' && /^[a-f0-9-]{36}\.image-quarantine$/.test(s),
    );
  const derivedRasterFilenames = (
    await c.query(
      `SELECT a.filename FROM assets a JOIN art_asset_revisions r ON r.upload_id=a.id WHERE r.id=ANY($1::uuid[])`,
      [revisionIds],
    )
  ).rows.map((r) => String(r.filename));
  await c.query(
    "INSERT INTO art_asset_takedowns(revision_id,reason_code) SELECT unnest($1::uuid[]),'erasure' ON CONFLICT DO NOTHING",
    [revisionIds],
  );
  await c.query(
    'UPDATE art_asset_revisions SET metadata=\'{"erased":true}\' WHERE id=ANY($1::uuid[])',
    [revisionIds],
  );
  for (const table of ['art_playable_pins', 'art_campaign_pins'])
    await c.query(
      `UPDATE ${table} SET rights_snapshot='{"erased":true}' WHERE revision_id=ANY($1::uuid[])`,
      [revisionIds],
    );
  await c.query(
    'UPDATE art_asset_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE revision_id=ANY($1::uuid[])',
    [revisionIds],
  );
  await c.query(
    `UPDATE art_asset_operations SET result='{"erased":true}',request_hash='erased'
    WHERE EXISTS(SELECT 1 FROM unnest($1::uuid[]) r WHERE strpos(result::text,r::text)>0)`,
    [revisionIds],
  );
  await c.query(
    'DELETE FROM assets WHERE id IN(SELECT upload_id FROM art_asset_revisions WHERE id=ANY($1::uuid[]))',
    [revisionIds],
  );
  await c.query(
    "UPDATE image_generation_jobs SET cancel_requested=true,quota_reserved_bytes=0,input='{}',reference_hashes='{}',request_hash='erased',provider_request_id=NULL,safe_diagnostic=NULL,quarantine_filename=NULL,quarantine_sha256=NULL,quarantine_mime=NULL,error_code='ERASED',updated_at=now() WHERE id=ANY($1::uuid[])",
    [jobIds],
  );
  await c.query(
    "UPDATE image_generation_quotes SET input='{}',reference_hashes='{}',request_hash='erased',expires_at=least(expires_at,now()) WHERE actor_id=$1 OR input->'campaignContext'->>'campaignId'=ANY($2::text[])",
    [userId, campaignIds],
  );
  await c.query(
    "UPDATE image_generation_attempts SET request_hash='erased',provider_request_id=NULL WHERE job_id=ANY($1::uuid[])",
    [jobIds],
  );
  // Liability, actual cost and unknown outcomes remain intact. Only the erased
  // person's ledger reference is detached, never another payer's accounting.
  await c.query('UPDATE generation_budget_reservations SET actor_id=NULL WHERE actor_id=$1', [
    userId,
  ]);
  await c.query('DELETE FROM image_generation_cleanup WHERE job_id=ANY($1::uuid[])', [jobIds]);

  return { quarantineFilenames: files, derivedRasterFilenames };
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
        'SELECT id,adventure_id,input,mode,status,upper_micros,actual_micros,admitted_revision_id,error_code,safe_diagnostic,created_at FROM image_generation_jobs WHERE actor_id=$1 ORDER BY created_at',
        [userId],
      )
    ).rows.map((row) => ({
      ...row,
      safe_diagnostic: normalizeSafeImageDiagnostic(row.safe_diagnostic) ?? null,
    })),
  };
}
