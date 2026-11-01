/** Existing confirmed account-erasure transaction owns campaign locks. No external calls. */
export async function lockManualLiveData(client, userId, campaigns) {
  const campaignIds =
    campaigns?.map((c) => c.id) ??
    (
      await client.query(
        `SELECT c.id FROM game_campaigns c WHERE c.owner_id=$1 OR EXISTS(SELECT 1 FROM game_playable_versions v JOIN adventures a ON a.id=v.adventure_id WHERE v.id=c.source_version_id AND a.owner_id=$1) OR EXISTS(SELECT 1 FROM game_members m WHERE m.campaign_id=c.id AND m.user_id=$1) ORDER BY c.id`,
        [userId],
      )
    ).rows.map((c) => c.id);
  if (campaignIds.length)
    await client.query(
      'SELECT id FROM game_campaigns WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE NOWAIT',
      [campaignIds],
    );
  await client.query(
    'SELECT id FROM npc_ai_jobs WHERE campaign_id=ANY($1::uuid[]) OR requester_user_id=$2 OR payer_user_id=$2 ORDER BY id FOR UPDATE NOWAIT',
    [campaignIds, userId],
  );
  // Erasure later updates these provider aggregates. Preserve terminal receipt order:
  // job -> provider budget -> authorization/scope, retaining fail-fast operator semantics.
  await client.query(
    `SELECT b.provider_id FROM npc_ai_provider_budgets b
     WHERE EXISTS(SELECT 1 FROM npc_ai_jobs j WHERE j.provider_id=b.provider_id
       AND (j.campaign_id=ANY($1::uuid[]) OR j.requester_user_id=$2 OR j.payer_user_id=$2))
     ORDER BY b.provider_id FOR UPDATE OF b NOWAIT`,
    [campaignIds, userId],
  );
  const sessions = (
    await client.query(
      'SELECT s.id,s.scope_id,s.owner_id FROM live_test_sessions s WHERE s.owner_id=$1 OR EXISTS(SELECT 1 FROM live_test_text_permits p WHERE p.session_id=s.id AND p.campaign_id=ANY($2::uuid[])) ORDER BY s.id FOR UPDATE NOWAIT',
      [userId, campaignIds],
    )
  ).rows;
  const scopes = [...new Set(sessions.map((s) => s.scope_id))].sort();
  if (scopes.length)
    await client.query(
      'SELECT id FROM generation_budget_scopes WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE NOWAIT',
      [scopes],
    );
  return sessions;
}
export async function purgeManualLiveData(client, userId, campaigns) {
  const sessions = await lockManualLiveData(client, userId, campaigns);
  const campaignIds = campaigns.map((c) => c.id);
  for (const session of sessions) {
    await client.query('SELECT id FROM generation_budget_scopes WHERE id=$1 FOR UPDATE', [
      session.scope_id,
    ]);
    const permits = (
      await client.query(
        'SELECT * FROM live_test_text_permits WHERE session_id=$1 AND ($2::boolean OR campaign_id=ANY($3::uuid[])) ORDER BY id FOR UPDATE NOWAIT',
        [session.id, session.owner_id === userId, campaignIds],
      )
    ).rows;
    for (const p of permits) {
      if (p.state === 'authorized' && !p.dispatched_at)
        await client.query(
          "UPDATE generation_budget_reservations SET status='settled',actual_micros=0 WHERE id=$1 AND status='held'",
          [p.reservation_id],
        );
      await client.query(
        `UPDATE live_test_text_permits SET request_snapshot=CASE WHEN request_snapshot IS NULL THEN NULL ELSE (request_snapshot-'bodySha256'-'id'-'fingerprint')||'{"privateInputErased":true}'::jsonb END,request_id=NULL,context_hash='erased',round_id='erased',provider_request_id=NULL,state=CASE WHEN state='authorized' THEN 'cancelled' WHEN state='dispatched' THEN 'unknown' ELSE state END,result_code='DATA_ERASED' WHERE id=$1`,
        [p.id],
      );
    }
    if (
      (await client.query("SELECT to_regclass('generation_text_counts') AS present")).rows[0]
        .present
    )
      await client.query(
        `UPDATE generation_text_counts SET request_id=NULL,request_hash=NULL,source_hash=NULL,body_sha256=NULL,turn_fence='{}',status=CASE WHEN status='dispatched' THEN 'unknown' ELSE 'erased' END,result_code='DATA_ERASED' WHERE authorization_id=$1 AND ($2::boolean OR campaign_id=ANY($3::uuid[]))`,
        [session.id, session.owner_id === userId, campaignIds],
      );
    if (
      (await client.query("SELECT to_regclass('live_authoring_text_jobs') AS present")).rows[0]
        .present
    ) {
      const jobs = (
        await client.query(
          'SELECT * FROM live_authoring_text_jobs WHERE session_id=$1 AND actor_id=$2 ORDER BY id FOR UPDATE NOWAIT',
          [session.id, userId],
        )
      ).rows;
      for (const job of jobs) {
        if (job.status === 'queued' && !job.dispatched_at)
          await client.query(
            "UPDATE generation_budget_reservations SET status='settled',actual_micros=0 WHERE id=$1 AND status='held'",
            [job.reservation_id],
          );
        await client.query(
          `UPDATE live_authoring_text_jobs SET request_snapshot=CASE WHEN request_snapshot IS NULL THEN NULL ELSE (request_snapshot-'bodySha256'-'id'-'fingerprint')||'{"privateInputErased":true}'::jsonb END,context='{}',context_hash='erased',source_hash='erased',readset_hash='erased',proposal=NULL,result=NULL,provider_request_id=NULL,cancel_requested=true,status=CASE WHEN status='dispatched' THEN 'unknown' WHEN status IN ('queued','generated','committed') THEN 'cancelled' ELSE status END,error_code='DATA_ERASED',updated_at=now() WHERE id=$1`,
          [job.id],
        );
      }
      await client.query(
        `UPDATE live_authoring_text_quotes SET request_snapshot=CASE WHEN request_snapshot IS NULL THEN NULL ELSE (request_snapshot-'bodySha256'-'id'-'fingerprint')||'{"privateInputErased":true}'::jsonb END,context='{}',context_hash='erased',source_hash='erased',readset_hash='erased',request_hash='erased' WHERE session_id=$1 AND actor_id=$2`,
        [session.id, userId],
      );
    }
    await client.query(
      // Other owners' authorizations can be stopped by an affected campaign, but
      // their account identity is not part of this user's erasure. Manual rows
      // must retain NULL to satisfy their immutable authorization-mode constraint.
      "UPDATE live_test_sessions SET state='stopped',stop_code='DATA_ERASED',owner_handle=CASE WHEN owner_id=$2 AND mode='owner' THEN 'erased' ELSE owner_handle END WHERE id=$1",
      [session.id, userId],
    );
  }
}
export async function exportManualLiveData(client, userId) {
  const sessions = (
    await client.query(
      'SELECT id,scope_id,mode,owner_handle,config_hash,expires_at,cap_micros,text_cap_micros,image_cap_micros,state,stop_code,created_at FROM live_test_sessions WHERE owner_id=$1 ORDER BY created_at',
      [userId],
    )
  ).rows;
  const permits = (
    await client.query(
      'SELECT p.id,p.session_id,p.campaign_id,p.operation_id,p.state,p.dispatched_at,p.completed_at,p.result_code,p.reservation_id,p.request_snapshot,p.generation_policy_revision,p.generation_policy_hash FROM live_test_text_permits p JOIN live_test_sessions s ON s.id=p.session_id WHERE s.owner_id=$1 ORDER BY p.id',
      [userId],
    )
  ).rows;
  let authoring = [],
    authoringQuotes = [];
  if (
    (await client.query("SELECT to_regclass('live_authoring_text_jobs') AS present")).rows[0]
      .present
  ) {
    authoring = (
      await client.query(
        'SELECT id,project_id,status,actual_micros,error_code,created_at,completed_at,request_snapshot,generation_policy_revision,generation_policy_hash FROM live_authoring_text_jobs WHERE actor_id=$1 ORDER BY created_at',
        [userId],
      )
    ).rows;
    authoringQuotes = (
      await client.query(
        'SELECT id,project_id,upper_micros,expires_at,created_at,request_snapshot,generation_policy_revision,generation_policy_hash FROM live_authoring_text_quotes WHERE actor_id=$1 ORDER BY created_at',
        [userId],
      )
    ).rows;
  }
  // Immutable policy history contains public cost/model settings only. Account
  // ownership is resolved through the original authorization, never caller input.
  let policyRevisions = [];
  if (
    (await client.query("SELECT to_regclass('generation_policy_revisions') AS present")).rows[0]
      .present
  )
    policyRevisions = (
      await client.query(
        `SELECT r.id,r.authorization_id,r.scope_id,r.revision,r.profile_hash,r.config_fingerprint,
        r.previous_hash,r.profile_snapshot,r.operation_id,r.acknowledged_at
        FROM generation_policy_revisions r JOIN live_test_sessions s ON s.id=r.authorization_id
        WHERE s.owner_id=$1 ORDER BY r.authorization_id,r.revision`,
        [userId],
      )
    ).rows;
  const textCounts = (await client.query("SELECT to_regclass('generation_text_counts') AS present"))
    .rows[0].present
    ? (
        await client.query(
          'SELECT id,authorization_id,campaign_id,status,input_tokens,actual_micros,result_code,created_at,completed_at,pricing_snapshot,policy_revision,policy_hash FROM generation_text_counts WHERE actor_id=$1 ORDER BY created_at',
          [userId],
        )
      ).rows
    : [];
  return { sessions, permits, authoring, authoringQuotes, policyRevisions, textCounts };
}
