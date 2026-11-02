import type { PoolClient } from 'pg';

/** Read under the shared admission fence for mutations. No row locks or ledger rewrites:
 * callers already own their actor scope, so locking a foreign provider here would invert
 * NPC settlement's provider → authorization/scope → fence order.
 * Legacy provider counters survive erased jobs; only proven coverage is subtracted.
 */
export async function aggregateGenerationExposure(c: Pick<PoolClient, 'query'>) {
  const row = (
    await c.query(`WITH candidate_links AS (
    SELECT j.id AS job_id,r.id AS reservation_id
    FROM npc_ai_jobs j JOIN generation_budget_reservations r ON r.id=j.generation_reservation_id
    JOIN live_test_sessions s ON s.id=j.generation_authorization_id
      AND s.scope_id=r.scope_id AND s.owner_id=r.actor_id AND s.owner_id=j.payer_user_id
    UNION
    SELECT j.id,r.id FROM npc_ai_jobs j
    JOIN live_test_text_permits p ON (p.job_id=j.id OR p.request_id::text=j.request_meta->>'runtimeRequestId')
      AND p.campaign_id=j.campaign_id
    JOIN generation_budget_reservations r ON r.id=p.reservation_id
    JOIN live_test_sessions s ON s.id=p.session_id AND s.scope_id=r.scope_id AND s.owner_id=r.actor_id
    WHERE j.payer_user_id IS NULL OR j.payer_user_id=s.owner_id
  ), single_job_links AS (
    SELECT job_id,min(reservation_id::text)::uuid AS reservation_id FROM candidate_links
    GROUP BY job_id HAVING count(*)=1
  ), unique_links AS (
    SELECT l.* FROM single_job_links l WHERE NOT EXISTS(
      SELECT 1 FROM candidate_links other WHERE other.reservation_id=l.reservation_id AND other.job_id<>l.job_id
    )
  ), coverage AS (
    SELECT j.*,r.status AS shared_status,r.upper_micros AS shared_upper,r.actual_micros AS shared_actual
    FROM npc_ai_jobs j LEFT JOIN unique_links l ON l.job_id=j.id
    LEFT JOIN generation_budget_reservations r ON r.id=l.reservation_id
  ), accounted AS (
    SELECT provider_id,
      COALESCE(sum(CASE WHEN provider_budget_status='reserved' AND
        (provider_external IS FALSE OR (shared_status='held' AND shared_upper>=provider_upper_micros)
          OR (shared_status='settled' AND shared_actual>=provider_upper_micros))
        THEN provider_upper_micros ELSE 0 END),0) AS reserved,
      COALESCE(sum(CASE WHEN provider_budget_status='unknown' AND
        (provider_external IS FALSE OR (shared_status='held' AND shared_upper>=provider_upper_micros)
          OR (shared_status='settled' AND shared_actual>=provider_upper_micros))
        THEN provider_upper_micros ELSE 0 END),0) AS unknown,
      COALESCE(sum(CASE WHEN provider_budget_status='spent' AND
        (provider_external IS FALSE OR (shared_status='settled' AND shared_actual>=provider_actual_micros))
        THEN LEAST(COALESCE(provider_actual_micros,0),provider_upper_micros) ELSE 0 END),0) AS spent,
      COALESCE(sum(CASE WHEN provider_actual_micros>provider_upper_micros AND
        (provider_external IS FALSE OR (shared_status='settled' AND shared_actual>=provider_actual_micros)
          OR (shared_status='held' AND shared_upper>=provider_actual_micros))
        THEN provider_actual_micros-provider_upper_micros ELSE 0 END),0) AS overrun
    FROM coverage GROUP BY provider_id
  ), legacy AS (
    SELECT COALESCE(sum(
      GREATEST(0,b.reserved_micros-COALESCE(a.reserved,0))+
      GREATEST(0,b.spent_micros-COALESCE(a.spent,0))+
      GREATEST(0,b.unknown_micros-COALESCE(a.unknown,0))+
      GREATEST(0,b.overrun_micros-COALESCE(a.overrun,0))
    ),0) AS micros FROM npc_ai_provider_budgets b LEFT JOIN accounted a ON a.provider_id=b.provider_id
  ), shared AS (
    SELECT COALESCE(sum(CASE WHEN status='held' THEN upper_micros
      WHEN status='settled' THEN COALESCE(actual_micros,upper_micros) ELSE 0 END),0) AS micros
    FROM generation_budget_reservations
  ) SELECT shared.micros AS shared_micros,legacy.micros AS legacy_npc_micros FROM shared,legacy`)
  ).rows[0];
  const sharedMicros = BigInt(row.shared_micros);
  const legacyNpcMicros = BigInt(row.legacy_npc_micros);
  return { sharedMicros, legacyNpcMicros, totalMicros: sharedMicros + legacyNpcMicros };
}
