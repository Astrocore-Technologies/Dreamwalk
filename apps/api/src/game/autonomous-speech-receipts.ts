import type { PoolClient, QueryResultRow } from 'pg';
import type { AutonomousSpeechReceipt, AutonomousSpeechSkip } from '@dreamwalk/contracts';
import { heldFunding } from '../generation/currency-funding';
/** Only persisted own-account amounts. Never reprice historical usage or expose speech/audience/context. */
export function autonomousSpeechReceipt(row: QueryResultRow): AutonomousSpeechReceipt | undefined {
  const integer = (value: unknown): value is string =>
    typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
  if (
    !integer(row.reserved_subunits) ||
    (row.sparks_reserved_subunits != null &&
      (!integer(row.sparks_reserved_subunits) ||
        BigInt(row.sparks_reserved_subunits) > BigInt(row.reserved_subunits)))
  )
    return;
  const createdAt = new Date(row.created_at);
  if (!Number.isFinite(createdAt.getTime())) return;
  const terminal = ['settled', 'released'].includes(row.hold_status);
  if (
    terminal &&
    (!integer(row.captured_subunits) ||
      BigInt(row.captured_subunits) > BigInt(row.reserved_subunits))
  )
    return;
  const status =
    row.hold_status === 'pending' || row.job_status === 'reconciling'
      ? 'unknown'
      : terminal
        ? (row.hold_status as 'settled' | 'released')
        : 'held';
  const capturedSubunits = terminal ? String(row.captured_subunits) : null;
  return {
    id: String(row.id),
    createdAt: createdAt.toISOString(),
    status,
    outcome:
      row.job_status === 'committed'
        ? row.has_delivery === true
          ? 'delivered'
          : 'silent'
        : ['stale', 'failed', 'cancelled'].includes(row.job_status)
          ? 'failed'
          : 'pending',
    reservedSubunits: row.reserved_subunits,
    capturedSubunits,
    funding: heldFunding({
      reserved_subunits: row.reserved_subunits,
      sparks_reserved_subunits: row.sparks_reserved_subunits,
      captured_subunits: capturedSubunits,
    }),
  };
}
/** Caller first verifies live campaign owner/source access. Both legacy exact and optional child consent are supported. */
export async function readAutonomousSpeechReceipts(
  c: Pick<PoolClient, 'query'>,
  campaignId: string,
  ownerId: string,
  before?: string,
) {
  const rows = (
    await c.query(
      `SELECT j.id,j.created_at,j.status AS job_status,h.status AS hold_status,
    h.reserved_subunits,h.captured_subunits,h.sparks_reserved_subunits,
    EXISTS(SELECT 1 FROM game_story_feed f WHERE f.npc_job_id=j.id AND f.npc_request_id=r.id AND f.campaign_id=r.campaign_id) AS has_delivery
    FROM game_npc_decision_requests r
    JOIN npc_ai_jobs j ON j.id=r.job_id AND j.campaign_id=r.campaign_id AND j.npc_id=r.npc_id
      AND j.purpose='speech' AND j.context_hash<>'erased' AND j.result_code IS DISTINCT FROM 'DATA_ERASED' AND j.request_meta->>'runtimeRequestId'=r.id::text
    JOIN npc_ai_quotes native ON native.id=j.quote_id AND native.campaign_id=j.campaign_id AND native.npc_id=j.npc_id
      AND native.purpose='speech' AND native.user_id=$2
    JOIN spark_quotes q ON q.id=j.spark_hold_id AND q.id=native.spark_quote_id AND q.owner_id=$2
      AND q.source_kind='npc' AND q.source_id=native.id::text
    JOIN spark_holds h ON h.id=q.id AND h.owner_id=$2 AND h.source_kind='npc' AND h.source_id=native.id::text
    JOIN game_world_generation_batches b ON b.id::text=j.request_meta->>'acceptedWorldBatchId'
      AND b.campaign_id=r.campaign_id AND b.owner_id=$2 AND b.accepted_at IS NOT NULL
    WHERE r.campaign_id=$1 AND r.requester_user_id=$2 AND j.requester_user_id=$2 AND j.payer_user_id=$2
      AND r.purpose='speech' AND r.context ? 'worldPlanCommunication'
      AND (b.entries @> jsonb_build_array(jsonb_build_object('requestId',r.id::text,'quote',jsonb_build_object('id',native.id::text)))
        OR EXISTS(SELECT 1 FROM game_autonomous_speech_bindings child WHERE child.batch_id=b.id AND child.request_id=r.id AND child.native_quote_id=native.id))
      AND ($3::uuid IS NULL OR (j.created_at,j.id)<(SELECT cursor.created_at,cursor.id FROM npc_ai_jobs cursor
        WHERE cursor.id=$3 AND cursor.campaign_id=$1 AND cursor.requester_user_id=$2 AND cursor.payer_user_id=$2))
    ORDER BY j.created_at DESC,j.id DESC LIMIT 21`,
      [campaignId, ownerId, before ?? null],
    )
  ).rows;
  return {
    speechReceipts: rows.slice(0, 20).flatMap((row) => {
      const receipt = autonomousSpeechReceipt(row);
      return receipt ? [receipt] : [];
    }),
    ...(rows.length > 20 ? { speechReceiptNext: String(rows[19].id) } : {}),
  };
}

/** No native job means no receipt: expose bounded safe skip metadata separately. */
export async function readAutonomousSpeechSkips(
  c: Pick<PoolClient, 'query'>,
  campaignId: string,
  ownerId: string,
): Promise<AutonomousSpeechSkip[]> {
  const rows = (
    await c.query(
      `SELECT r.id,r.created_at,r.result_code FROM game_npc_decision_requests r
    WHERE r.campaign_id=$1 AND r.purpose='speech' AND r.status='failed' AND r.job_id IS NULL
    AND r.context ? 'worldPlanCommunication'
    AND NOT EXISTS(SELECT 1 FROM npc_ai_jobs j WHERE j.operation_id=r.id OR j.request_meta->>'runtimeRequestId'=r.id::text)
    AND NOT EXISTS(SELECT 1 FROM live_test_text_permits p WHERE p.request_id=r.id)
    AND NOT EXISTS(SELECT 1 FROM generation_budget_reservations pending WHERE pending.operation_key='manual-text:'||r.id::text)
    AND NOT EXISTS(SELECT 1 FROM spark_holds h WHERE h.source_id=r.id::text)
    AND ((r.requester_user_id=$2 AND r.result_code IN ('AUTONOMOUS_SPEECH_LEGACY_UNCOVERED','AUTONOMOUS_SPEECH_ALLOWANCE_UNAVAILABLE')) OR EXISTS(SELECT 1 FROM game_world_generation_batches b WHERE b.campaign_id=r.campaign_id
      AND b.owner_id=$2 AND b.accepted_at IS NOT NULL AND b.quote->>'autonomousSpeechPolicy'='bounded-npc-speech-v1'
      AND b.autonomous_speech_entries @> jsonb_build_array(jsonb_build_object('envelope',jsonb_build_object('sourceRequestId',r.context->'worldPlanCommunication'->>'sourceRequestId')))))
    ORDER BY r.created_at DESC,r.id DESC LIMIT 20`,
      [campaignId, ownerId],
    )
  ).rows;
  return rows.map((row) => ({
    id: String(row.id),
    createdAt: new Date(row.created_at).toISOString(),
    reason:
      row.result_code === 'AUTONOMOUS_SPEECH_ALLOWANCE_EXHAUSTED'
        ? 'allowance_exhausted'
        : row.result_code === 'AUTONOMOUS_SPEECH_LEGACY_UNCOVERED'
          ? 'legacy_uncovered'
          : 'allowance_unavailable',
  }));
}
