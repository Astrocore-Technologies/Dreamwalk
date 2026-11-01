/** Explicit one-off authoring allowance. Never repairs, zeroes or releases the historical request. */
import type { PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest } from '../ai/context';
import { fail } from '../errors';
import { fenceGenerationAdmission } from './scope-fence';
import { ownerPricingIsCurrent, type OwnerGenerationConfig } from './config';
import { safeOwnerProfile, appendPolicyRevision } from './policy-revisions';
import {
  defaultImagePolicy,
  type GenerationRequest,
  type ImagePolicy,
} from '../image-generation/contracts';

export const BOUNDED_TEST = Object.freeze({
  legacyAuthorizationId: 'fb62346b-85ad-42fe-a595-96207e4391ff',
  requestId: 'req_2b5f788574634d9e902d017aba193b57',
  model: 'gpt-image-2.5-sunburst-2026-09-08',
  retainedMicros: 66900,
  capMicros: 500000,
  approvedAt: '2026-11-01T18:16:15.000Z',
});
const inputSchema = z
  .object({
    operationId: z.uuid(),
    adventureId: z.uuid(),
    candidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    consent: z.literal(true),
    isolatedSyntheticStory: z.literal(true),
    lifetimeMinutes: z.number().int().min(1).max(120).default(120),
  })
  .strict();
export interface BoundedTest extends QueryResultRow {
  authorization_id: string;
  owner_id: string;
  adventure_id: string;
  legacy_authorization_id: string;
  retained_reservation_id: string;
  scope_id: string;
  config_hash: string;
  policy_hash: string;
  cap_micros: string;
  aggregate_cap_micros: string;
  baseline_spent_micros: string;
  expires_at: Date;
  request_hash: string;
  profile_snapshot: Record<string, unknown>;
}
export async function boundedTest(c: PoolClient, id: string | undefined) {
  if (!id) return undefined;
  return (
    await c.query<BoundedTest>('SELECT * FROM bounded_authoring_tests WHERE authorization_id=$1', [
      id,
    ])
  ).rows[0];
}
const n = (value: unknown) => {
  const x = BigInt(String(value));
  if (x < 0n || x > BigInt(Number.MAX_SAFE_INTEGER))
    fail(409, 'BUDGET_EVIDENCE_INVALID', 'BUDGET_EVIDENCE_INVALID');
  return x;
};
/** Includes every shared scope, plus residual legacy provider spend not already represented there.
 * Unknown/unattributed legacy budgets are rejected, not presumed zero or silently double counted. */
async function ledger(c: PoolClient, retained: string, childScope?: string) {
  const rows = (await c.query('SELECT * FROM generation_budget_reservations ORDER BY id')).rows;
  let spent = 0n,
    held = 0n,
    child = 0n,
    text = 0n,
    image = 0n;
  for (const row of rows) {
    if (row.status === 'settled' && row.actual_micros === null)
      fail(409, 'PRIOR_LIABILITY_UNRESOLVED', 'PRIOR_LIABILITY_UNRESOLVED');
    const cost =
      row.status === 'held'
        ? n(row.upper_micros)
        : row.status === 'settled'
          ? n(row.actual_micros)
          : 0n;
    if (row.status === 'released' && row.actual_micros !== null && n(row.actual_micros) > 0n)
      fail(409, 'PRIOR_LIABILITY_UNRESOLVED', 'PRIOR_LIABILITY_UNRESOLVED');
    if (row.status === 'held' && row.id !== retained && row.scope_id !== childScope)
      fail(409, 'PRIOR_LIABILITY_UNRESOLVED', 'PRIOR_LIABILITY_UNRESOLVED');
    if (row.status === 'settled') spent += cost;
    else held += cost;
    if (row.scope_id === childScope) child += cost;
    if (row.kind === 'text') text += cost;
    else image += cost;
  }
  // A residual provider aggregate cannot be called known spend without complete job evidence.
  const legacy = (
    await c.query(`SELECT b.*,COALESCE((SELECT sum(j.provider_actual_micros) FROM npc_ai_jobs j WHERE j.provider_id=b.provider_id AND j.provider_budget_status='spent'),0) job_spent,
 COALESCE((SELECT sum(j.provider_actual_micros) FROM npc_ai_jobs j WHERE j.provider_id=b.provider_id AND j.provider_budget_status='spent' AND (j.provider_external=false OR EXISTS(SELECT 1 FROM live_test_text_permits p JOIN generation_budget_reservations r ON r.id=p.reservation_id WHERE (p.job_id=j.id OR p.request_id::text=j.request_meta->>'runtimeRequestId') AND r.status='settled' AND r.actual_micros=j.provider_actual_micros))),0) accounted_spent,
 EXISTS(SELECT 1 FROM npc_ai_jobs j WHERE j.provider_id=b.provider_id) has_jobs, NOT EXISTS(SELECT 1 FROM npc_ai_jobs j WHERE j.provider_id=b.provider_id AND j.provider_external IS DISTINCT FROM false) only_mock FROM npc_ai_provider_budgets b`)
  ).rows;
  for (const b of legacy) {
    if (b.only_mock && b.has_jobs) continue;
    if (
      !b.has_jobs &&
      (n(b.spent_micros) > 0n ||
        n(b.reserved_micros) > 0n ||
        n(b.unknown_micros) > 0n ||
        n(b.overrun_micros) > 0n ||
        b.blocked)
    )
      fail(409, 'PRIOR_NPC_LIABILITY_UNRESOLVED', 'PRIOR_NPC_LIABILITY_UNRESOLVED');
    if (
      n(b.unknown_micros) > 0n ||
      n(b.reserved_micros) > 0n ||
      n(b.overrun_micros) > 0n ||
      b.blocked ||
      n(b.spent_micros) !== n(b.job_spent) ||
      n(b.accounted_spent) > n(b.spent_micros)
    )
      fail(409, 'PRIOR_NPC_LIABILITY_UNRESOLVED', 'PRIOR_NPC_LIABILITY_UNRESOLVED');
    spent += n(b.spent_micros) - n(b.accounted_spent);
    text += n(b.spent_micros) - n(b.accounted_spent);
  }
  const orphans = (
    await c.query(
      "SELECT 1 FROM npc_ai_jobs j WHERE j.provider_external IS DISTINCT FROM false AND (j.provider_budget_status='unknown' OR j.status IN ('running','reconciling') OR (j.provider_budget_status='spent' AND NOT EXISTS(SELECT 1 FROM npc_ai_provider_budgets b WHERE b.provider_id=j.provider_id))) LIMIT 1",
    )
  ).rowCount;
  if (orphans) fail(409, 'PRIOR_NPC_LIABILITY_UNRESOLVED', 'PRIOR_NPC_LIABILITY_UNRESOLVED');
  return { spent, held, child, text, image, total: spent + held };
}
async function legacyAnchor(c: PoolClient, ownerId: string) {
  const session = (
    await c.query(
      'SELECT s.*,b.blocked,b.approved FROM live_test_sessions s JOIN generation_budget_scopes b ON b.id=s.scope_id WHERE s.id=$1',
      [BOUNDED_TEST.legacyAuthorizationId],
    )
  ).rows[0];
  if (
    !session ||
    session.owner_id !== ownerId ||
    session.mode !== 'owner' ||
    session.state !== 'stopped' ||
    session.stop_code !== 'IMAGE_RESULT_UNKNOWN' ||
    !session.blocked ||
    !session.approved
  )
    fail(409, 'BOUNDED_LEGACY_ANCHOR_MISMATCH', 'BOUNDED_LEGACY_ANCHOR_MISMATCH');
  const rows = (
    await c.query(
      `SELECT r.id,r.upper_micros,r.actual_micros,j.actual_micros job_actual,a.actual_micros attempt_actual,a.result_received_at,j.safe_diagnostic,j.pricing_profile_snapshot FROM generation_budget_reservations r JOIN image_generation_jobs j ON j.reservation_id=r.id JOIN image_generation_attempts a ON a.job_id=j.id WHERE r.scope_id=$1 AND r.actor_id=$2 AND r.status='held' AND r.kind='image' AND j.mode='external' AND j.status='unknown' AND j.safe_diagnostic->>'requestId'=$3`,
      [session.scope_id, ownerId, BOUNDED_TEST.requestId],
    )
  ).rows;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    Number(row.upper_micros) !== BOUNDED_TEST.retainedMicros ||
    row.actual_micros !== null ||
    row.job_actual !== null ||
    row.attempt_actual !== null ||
    row.result_received_at !== null ||
    row.safe_diagnostic?.httpStatus !== 403 ||
    row.safe_diagnostic?.providerCode !== 'model_not_found' ||
    row.safe_diagnostic?.category !== 'model_access' ||
    row.pricing_profile_snapshot?.model !== BOUNDED_TEST.model
  )
    fail(409, 'BOUNDED_LEGACY_EVIDENCE_MISMATCH', 'BOUNDED_LEGACY_EVIDENCE_MISMATCH');
  return { session, reservationId: String(row.id) };
}
async function noOtherUnknown(c: PoolClient, retained: string, childScope?: string) {
  const bad = (
    await c.query(
      `SELECT 1 FROM image_generation_jobs j JOIN generation_budget_reservations r ON r.id=j.reservation_id WHERE r.id<>$1 AND j.mode='external' AND (j.status='unknown' OR (j.status='dispatched' AND j.dispatch_deadline<=clock_timestamp()))
 UNION ALL SELECT 1 FROM live_authoring_text_jobs WHERE status='unknown' OR (status='dispatched' AND deadline_at<=clock_timestamp())
 UNION ALL SELECT 1 FROM live_test_text_permits WHERE state='unknown' OR (state='dispatched' AND dispatched_at<=clock_timestamp()-interval '60 seconds')
 UNION ALL SELECT 1 FROM generation_text_counts WHERE status='unknown' OR (status='dispatched' AND deadline_at<=clock_timestamp())
 UNION ALL SELECT 1 FROM live_test_sessions WHERE state='stopped' AND id<>$3 AND scope_id<>$2 AND COALESCE(stop_code,'')<>'OWNER_GENERATION_MODE_ACTIVE'
 UNION ALL SELECT 1 FROM generation_budget_scopes WHERE blocked AND id<>$2 AND id<>(SELECT scope_id FROM generation_budget_reservations WHERE id=$1) AND EXISTS(SELECT 1 FROM generation_budget_reservations r WHERE r.scope_id=generation_budget_scopes.id AND (r.upper_micros>0 OR r.actual_micros>0)) LIMIT 1`,
      [retained, childScope ?? '', BOUNDED_TEST.legacyAuthorizationId],
    )
  ).rowCount;
  if (bad) fail(409, 'BOUNDED_OUTCOME_UNRESOLVED', 'BOUNDED_OUTCOME_UNRESOLVED');
}
export async function createBoundedTest(
  c: PoolClient,
  ownerId: string,
  input: unknown,
  config: OwnerGenerationConfig,
) {
  const v = inputSchema.parse(input),
    requestHash = digest(v);
  const user = (
    await c.query('SELECT id,handle FROM users WHERE id=$1 AND deleted_at IS NULL FOR SHARE', [
      ownerId,
    ])
  ).rows[0];
  if (!user || user.handle !== config.ownerHandle) fail(403, 'FORBIDDEN', 'FORBIDDEN');
  // Existing lock order: authorizations -> their scope -> global admission fence.
  await c.query(
    'SELECT id FROM live_test_sessions WHERE scope_id=(SELECT scope_id FROM live_test_sessions WHERE id=$1) ORDER BY id FOR NO KEY UPDATE',
    [BOUNDED_TEST.legacyAuthorizationId],
  );
  await c.query(
    'SELECT id FROM generation_budget_scopes WHERE id=(SELECT scope_id FROM live_test_sessions WHERE id=$1) FOR UPDATE',
    [BOUNDED_TEST.legacyAuthorizationId],
  );
  await fenceGenerationAdmission(c);
  const prior = (
    await c.query<BoundedTest>(
      'SELECT * FROM bounded_authoring_tests WHERE legacy_authorization_id=$1',
      [BOUNDED_TEST.legacyAuthorizationId],
    )
  ).rows[0];
  if (prior) {
    if (prior.owner_id !== ownerId || prior.request_hash !== requestHash)
      fail(409, 'IDEMPOTENCY_CONFLICT', 'IDEMPOTENCY_CONFLICT');
    return prior;
  }
  if (
    v.candidateFingerprint !== config.configFingerprint ||
    !ownerPricingIsCurrent(config.text.pricing) ||
    !ownerPricingIsCurrent(config.image.pricing)
  )
    fail(409, 'GENERATION_POLICY_CHANGED', 'GENERATION_POLICY_CHANGED');
  const story = (
    await c.query(
      "SELECT * FROM adventures WHERE id=$1 AND owner_id=$2 AND visibility='private' AND status='draft' AND published_snapshot IS NULL AND created_at>=$3",
      [v.adventureId, ownerId, BOUNDED_TEST.approvedAt],
    )
  ).rows[0];
  if (
    !story ||
    (
      await c.query('SELECT 1 FROM game_playable_versions WHERE adventure_id=$1 LIMIT 1', [
        v.adventureId,
      ])
    ).rowCount
  )
    fail(409, 'ISOLATED_TEST_STORY_REQUIRED', 'ISOLATED_TEST_STORY_REQUIRED');
  const anchor = await legacyAnchor(c, ownerId);
  const acknowledged = (
    await c.query(
      'SELECT * FROM generation_policy_revisions WHERE authorization_id=$1 AND revision=$2 AND profile_hash=$3',
      [anchor.session.id, anchor.session.policy_revision, anchor.session.policy_hash],
    )
  ).rows[0];
  if (
    !acknowledged ||
    acknowledged.profile_snapshot?.image?.estimateRiskAccepted !== true ||
    acknowledged.profile_snapshot?.image?.costBasis !== 'approved_estimate' ||
    acknowledged.profile_snapshot?.image?.providerEnforcesQuotedCap !== false
  )
    fail(409, 'BOUNDED_PRIOR_RISK_ACK_REQUIRED', 'BOUNDED_PRIOR_RISK_ACK_REQUIRED');
  if (
    acknowledged.config_fingerprint !== config.configFingerprint ||
    digest(acknowledged.profile_snapshot) !== digest(safeOwnerProfile(config))
  )
    fail(409, 'BOUNDED_PRIOR_POLICY_MISMATCH', 'BOUNDED_PRIOR_POLICY_MISMATCH');
  await noOtherUnknown(c, anchor.reservationId);
  const before = await ledger(c, anchor.reservationId);
  if (before.held !== BigInt(BOUNDED_TEST.retainedMicros))
    fail(409, 'PRIOR_LIABILITY_UNRESOLVED', 'PRIOR_LIABILITY_UNRESOLVED');
  const aggregate = before.spent + before.held + BigInt(BOUNDED_TEST.capMicros);
  if (aggregate > BigInt(config.totalCapMicros) || aggregate > BigInt(Number.MAX_SAFE_INTEGER))
    fail(409, 'BOUNDED_GLOBAL_CAP_CONFLICT', 'BOUNDED_GLOBAL_CAP_CONFLICT');
  const id = randomUUID(),
    scope = 'bounded-authoring-' + id,
    now = new Date(),
    expires = new Date(now.getTime() + v.lifetimeMinutes * 60000),
    profile = safeOwnerProfile(config);
  const hash = digest({
    profile,
    adventureId: v.adventureId,
    legacyAuthorizationId: BOUNDED_TEST.legacyAuthorizationId,
    retained: anchor.reservationId,
    baseline: before.spent.toString(),
    cap: BOUNDED_TEST.capMicros,
    aggregate: aggregate.toString(),
    expires: expires.toISOString(),
  });
  await c.query(
    'INSERT INTO generation_budget_scopes(id,approved,total_cap_micros,text_cap_micros,image_cap_micros,serialize_outstanding) VALUES($1,true,$2,$3,$4,true)',
    [
      scope,
      BOUNDED_TEST.capMicros,
      Math.min(BOUNDED_TEST.capMicros, config.textCapMicros),
      Math.min(BOUNDED_TEST.capMicros, config.imageCapMicros),
    ],
  );
  await c.query(
    "INSERT INTO live_test_sessions(id,owner_id,scope_id,expires_at,cap_micros,state,mode,config_hash,owner_handle,text_cap_micros,image_cap_micros) VALUES($1,$2,$3,NULL,$4,'active','owner',$5,$6,$7,$8)",
    [
      id,
      ownerId,
      scope,
      BOUNDED_TEST.capMicros,
      digest(config),
      config.ownerHandle,
      Math.min(BOUNDED_TEST.capMicros, config.textCapMicros),
      Math.min(BOUNDED_TEST.capMicros, config.imageCapMicros),
    ],
  );
  await appendPolicyRevision(c, {
    authorizationId: id,
    scopeId: scope,
    revision: 1,
    hash,
    previousHash: null,
    config,
    operationId: v.operationId,
    requestHash,
  });
  return (
    await c.query<BoundedTest>(
      'INSERT INTO bounded_authoring_tests(authorization_id,owner_id,adventure_id,legacy_authorization_id,retained_reservation_id,scope_id,operation_id,request_hash,config_hash,policy_hash,profile_snapshot,baseline_spent_micros,retained_micros,cap_micros,aggregate_cap_micros,activated_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *',
      [
        id,
        ownerId,
        v.adventureId,
        BOUNDED_TEST.legacyAuthorizationId,
        anchor.reservationId,
        scope,
        v.operationId,
        requestHash,
        digest(config),
        hash,
        JSON.stringify(profile),
        before.spent.toString(),
        BOUNDED_TEST.retainedMicros,
        BOUNDED_TEST.capMicros,
        aggregate.toString(),
        now,
        expires,
      ],
    )
  ).rows[0];
}
/** Caller already holds child authorization + scope; no foreign locks are acquired here. */
export async function checkBoundedAdmission(
  c: PoolClient,
  test: BoundedTest,
  ownerId: string,
  upper = 0,
  kind?: 'text' | 'image',
) {
  if (test.owner_id !== ownerId) fail(403, 'FORBIDDEN', 'FORBIDDEN');
  if (!Number.isSafeInteger(upper) || upper < 0) fail(400, 'INVALID_COST', 'INVALID_COST');
  const s = (
    await c.query(
      'SELECT s.*,b.blocked,b.approved FROM live_test_sessions s JOIN generation_budget_scopes b ON b.id=s.scope_id WHERE s.id=$1',
      [test.authorization_id],
    )
  ).rows[0];
  if (
    !s ||
    s.state !== 'active' ||
    s.stop_code ||
    s.blocked ||
    !s.approved ||
    Date.now() >= new Date(test.expires_at).getTime()
  )
    fail(409, 'BOUNDED_TEST_STOPPED_OR_EXPIRED', 'BOUNDED_TEST_STOPPED_OR_EXPIRED');
  const story = (
    await c.query(
      "SELECT id FROM adventures WHERE id=$1 AND owner_id=$2 AND visibility='private' AND status<>'archived'",
      [test.adventure_id, ownerId],
    )
  ).rows[0];
  if (!story) fail(403, 'ISOLATED_TEST_STORY_REQUIRED', 'ISOLATED_TEST_STORY_REQUIRED');
  const anchor = await legacyAnchor(c, ownerId);
  if (anchor.reservationId !== test.retained_reservation_id)
    fail(409, 'BOUNDED_LEGACY_EVIDENCE_MISMATCH', 'BOUNDED_LEGACY_EVIDENCE_MISMATCH');
  await noOtherUnknown(c, test.retained_reservation_id, test.scope_id);
  const usage = await ledger(c, test.retained_reservation_id, test.scope_id);
  if (
    usage.text + BigInt(kind === 'text' ? upper : 0) > n(test.profile_snapshot.textCapMicros) ||
    usage.image + BigInt(kind === 'image' ? upper : 0) > n(test.profile_snapshot.imageCapMicros) ||
    usage.child + BigInt(upper) > BigInt(test.cap_micros) ||
    usage.total + BigInt(upper) > BigInt(test.aggregate_cap_micros)
  )
    fail(409, 'GENERATION_BUDGET_EXCEEDED', 'GENERATION_BUDGET_EXCEEDED');
  return usage;
}
export async function boundedPolicy(
  c: PoolClient,
  test: BoundedTest,
  ownerId: string,
  config: OwnerGenerationConfig,
  imageInput?: GenerationRequest,
): Promise<ImagePolicy> {
  if (
    test.config_hash !== digest(config) ||
    !ownerPricingIsCurrent(config.text.pricing) ||
    !ownerPricingIsCurrent(config.image.pricing)
  )
    fail(409, 'GENERATION_POLICY_CHANGED', 'GENERATION_POLICY_CHANGED');
  if (
    imageInput &&
    (imageInput.adventureId !== test.adventure_id ||
      !imageInput.studioLocationContext ||
      imageInput.kind !== 'background' ||
      imageInput.authoringContext ||
      imageInput.campaignContext)
  )
    fail(403, 'BOUNDED_TEST_LOCATION_ONLY', 'BOUNDED_TEST_LOCATION_ONLY');
  // Callers lock the child authorization/scope first; dispatch validation and
  // financial settlement share the same cross-scope admission fence.
  await fenceGenerationAdmission(c);
  await checkBoundedAdmission(c, test, ownerId);
  return {
    ...defaultImagePolicy,
    scopeId: test.scope_id,
    approved: true,
    externalEnabled: true,
    verifiedUpperMicros: config.text.upperMicros,
    totalCapMicros: BOUNDED_TEST.capMicros,
    textCapMicros: Math.min(BOUNDED_TEST.capMicros, config.textCapMicros),
    imageCapMicros: Math.min(BOUNDED_TEST.capMicros, config.imageCapMicros),
    generationMode: 'owner',
    generationAuthorizationId: test.authorization_id,
    generationConfigFingerprint: config.configFingerprint,
    generationPolicyRevision: 1,
    generationPolicyHash: test.policy_hash,
  };
}
export async function assertBoundedTextSource(
  c: PoolClient,
  authorizationId: string,
  projectId: string | null,
) {
  const test = await boundedTest(c, authorizationId);
  if (!test) return;
  if (
    !(
      await c.query(
        'SELECT 1 FROM story_playable_builds WHERE project_id=$1 AND adventure_id=$2 AND owner_id=$3',
        [projectId, test.adventure_id, test.owner_id],
      )
    ).rowCount
  )
    fail(403, 'BOUNDED_TEST_STORY_PLAN_ONLY', 'BOUNDED_TEST_STORY_PLAN_ONLY');
}
