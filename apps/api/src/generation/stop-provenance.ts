import type { PoolClient } from 'pg';

export type GenerationStopSource = {
  authorizationId?: string;
  sourceKind: 'image' | 'count' | 'permit' | 'authoring' | 'npc' | 'reservation' | 'policy';
  sourceId: string;
  reason: string;
  causeCode?: string;
  stopClass?: 'request' | 'authorization';
  providerId?: string;
  scopeId?: string;
  recoverable?: boolean;
};
/** Scope/session/provider triggers append every assignment, including true -> true.
 * Context is transaction-local and restored before any unrelated operation. Missing
 * context is a permanent veto, never inferred to be a recoverable uncertainty. */
export async function withGenerationStop<T>(
  c: PoolClient,
  source: GenerationStopSource,
  action: () => Promise<T>,
): Promise<T> {
  const previous =
    (await c.query("SELECT current_setting('dreamwalk.generation_stop_context',true) AS value"))
      .rows[0]?.value ?? '';
  await c.query("SELECT set_config('dreamwalk.generation_stop_context',$1,true)", [
    JSON.stringify(source),
  ]);
  try {
    return await action();
  } finally {
    await c.query("SELECT set_config('dreamwalk.generation_stop_context',$1,true)", [previous]);
  }
}

/** Caller holds the normal authorization -> scope locks; no financial proof here. */
export async function stopGenerationAuthorization(c: PoolClient, source: GenerationStopSource) {
  if (!source.authorizationId) throw new Error('STOP_AUTHORIZATION_REQUIRED');
  return withGenerationStop(c, source, async () => {
    await c.query(
      "UPDATE live_test_sessions SET state='stopped',stop_code=COALESCE(stop_code,$2) WHERE id=$1",
      [source.authorizationId, source.reason],
    );
    await c.query(
      'UPDATE generation_budget_scopes SET blocked=true WHERE id=(SELECT scope_id FROM live_test_sessions WHERE id=$1)',
      [source.authorizationId],
    );
  });
}

/** Resolve exact native source without guessing from an operation-key prefix. */
export async function stopGenerationReservation(
  c: PoolClient,
  authorizationId: string,
  reservationId: string,
  reason: string,
) {
  const sources = (
    await c.query(
      `SELECT 'image' kind,id::text FROM image_generation_jobs WHERE reservation_id=$1
     UNION ALL SELECT 'count',id::text FROM generation_text_counts WHERE reservation_id=$1
     UNION ALL SELECT 'permit',id::text FROM live_test_text_permits WHERE reservation_id=$1
     UNION ALL SELECT 'authoring',id::text FROM live_authoring_text_jobs WHERE reservation_id=$1
     UNION ALL SELECT 'npc',id::text FROM npc_ai_jobs WHERE generation_reservation_id=$1 AND spark_hold_id IS NOT NULL`,
      [reservationId],
    )
  ).rows;
  const source = sources.length === 1 ? sources[0] : undefined;
  await stopGenerationAuthorization(c, {
    authorizationId,
    sourceKind: source?.kind ?? 'reservation',
    sourceId: source?.id ?? reservationId,
    ...nativeRequestStop(reason),
    recoverable: !!source && nativeRequestStop(reason).recoverable,
  });
}

/** Do not collapse credential/HTTP/schema errors into recoverable transport uncertainty. */
export function countFailureCode(error: unknown) {
  const code = error instanceof Error ? error.message : '';
  return [
    'TEXT_COUNT_OUTCOME_UNKNOWN',
    'TEXT_COUNT_CREDENTIAL_REQUIRED',
    'TEXT_COUNT_HTTP_ERROR',
    'TEXT_COUNT_INVALID_RESPONSE',
    'PROVIDER_HTTP_403',
  ].includes(code)
    ? code
    : 'UNATTRIBUTED_TEXT_COUNT_FAILURE';
}

/** Only call with a server-identified native job/count/permit and its original
 * authorization. Original cause remains durable; no mutable error reclassification. */
export function nativeRequestStop(causeCode: string) {
  let reason = causeCode;
  if (
    [
      'IMAGE_PROVIDER_DEADLINE_EXCEEDED',
      'PROVIDER_DEADLINE_EXCEEDED',
      'TEXT_COUNT_DEADLINE_EXCEEDED',
      'PROVIDER_RESERVATION_EXPIRED',
    ].includes(causeCode)
  )
    reason = 'REQUEST_DEADLINE_EXCEEDED';
  else if (causeCode === 'PROVIDER_TIMEOUT') reason = 'REQUEST_TIMEOUT';
  else if (['PROVIDER_CANCELLED_IN_FLIGHT', 'PROVIDER_FINALIZED_IN_FLIGHT'].includes(causeCode))
    reason = 'JOB_CANCELLED_UNKNOWN';
  const recoverable = [
    'IMAGE_RESULT_UNKNOWN',
    'PROVIDER_OUTCOME_UNKNOWN',
    'TEXT_COUNT_OUTCOME_UNKNOWN',
    'REQUEST_TIMEOUT',
    'REQUEST_DEADLINE_EXCEEDED',
    'JOB_CANCELLED_UNKNOWN',
  ].includes(reason);
  return {
    reason,
    causeCode,
    stopClass: recoverable ? ('request' as const) : ('authorization' as const),
    recoverable,
  };
}
