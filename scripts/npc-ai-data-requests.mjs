/** AI data-request extension. Caller owns the same confirmed erasure transaction and campaign locks. */
export async function exportNpcAiData(client, userId) {
  return (
    await client.query(
      `SELECT id,campaign_id,purpose,status,credits,reservation_status,result_code,created_at,completed_at
    FROM npc_ai_jobs WHERE requester_user_id=$1 OR payer_user_id=$1 ORDER BY created_at`,
      [userId],
    )
  ).rows;
}
export async function purgeNpcAiData(client, userId, campaigns) {
  const ids = campaigns.map((c) => c.id);
  const jobs = (
    await client.query(
      'SELECT * FROM npc_ai_jobs WHERE campaign_id=ANY($1::uuid[]) OR requester_user_id=$2 OR payer_user_id=$2 ORDER BY id FOR UPDATE',
      [ids, userId],
    )
  ).rows;
  const affectedIds = [...new Set([...ids, ...jobs.map((j) => j.campaign_id)])];
  for (const j of jobs) {
    const dispatched = j.status === 'running' || j.status === 'reconciling';
    if (j.provider_budget_status === 'reserved') {
      // A timeout/erasure is not evidence that the provider did not perform a billable request.
      await client.query(
        'UPDATE npc_ai_provider_budgets SET reserved_micros=reserved_micros-$2,unknown_micros=unknown_micros+$3 WHERE provider_id=$1',
        [j.provider_id, j.provider_upper_micros, dispatched ? j.provider_upper_micros : 0],
      );
    }
    await client.query(
      `UPDATE npc_ai_jobs SET context='{}',context_hash='erased',proposal=NULL,request_meta='{}',quote_id=NULL,npc_id='erased-npc',
      cancel_requested=true,result_code='DATA_ERASED',status=CASE WHEN status='committed' THEN status ELSE 'cancelled' END,
      reservation_status=CASE WHEN reservation_status='held' THEN 'released' ELSE reservation_status END,
      provider_budget_status=CASE WHEN provider_budget_status='reserved' THEN $2 ELSE provider_budget_status END,
      origin=CASE WHEN requester_user_id=$3 THEN 'system' ELSE origin END,
      requester_user_id=CASE WHEN requester_user_id=$3 THEN NULL ELSE requester_user_id END,
      credits=CASE WHEN payer_user_id=$3 THEN 0 ELSE credits END,
      payer_user_id=CASE WHEN payer_user_id=$3 THEN NULL ELSE payer_user_id END,completed_at=COALESCE(completed_at,now()) WHERE id=$1`,
      [j.id, dispatched ? 'unknown' : 'released', userId],
    );
  }
  await client.query('DELETE FROM npc_ai_cache WHERE campaign_id=ANY($1::uuid[])', [affectedIds]);
  await client.query(
    'DELETE FROM npc_ai_quotes q WHERE (campaign_id=ANY($1::uuid[]) OR user_id=$2) AND NOT EXISTS (SELECT 1 FROM npc_ai_jobs j WHERE j.quote_id=q.id)',
    [affectedIds, userId],
  );
}
