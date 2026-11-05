import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import { parseSparkInteger, providerMicrosToSparkSubunits } from '@dreamwalk/contracts';
import { digest } from '../ai/context';
import { fenceGenerationAdmission } from '../generation/scope-fence';
import {
  SparksAccounting,
  DREAMS_FIRST_POLICY,
  planSparkSettlement,
  sparkQuoteRateVersion,
  type SparkHold,
} from '../generation/sparks-accounting';
import { planDreamSettlement, type DreamHold } from '../generation/dreams-accounting';
import { generationRequestSchema } from './contracts';
import { AUTOMATIC_IMAGE_SETTLEMENT_POLICY, imageKnownCostPolicy } from './settlement-policy';

const proofHash = (v: unknown) => digest(v ?? null);
const signedSnapshotMatches = (snapshot: Row, prefix: string) => {
  const { id, fingerprint, ...fields } = snapshot;
  return id === `${prefix}:${fingerprint}` && digest(fields) === fingerprint;
};
const unavailable = () => {
  throw new Error('IMAGE_SETTLEMENT_PROOF_UNAVAILABLE');
};
export const knownImageReceipt = (jobId: string, actualMicros: string) => ({
  outcome: 'success' as const,
  actualMicros,
  evidence: 'configured_rates' as const,
  // Compatible with the original successful-image receipt. No second capture identity.
  receiptId: `image:${jobId}`,
});
type Row = QueryResultRow;
export type KnownImageProof = {
  job: Row;
  native: Row;
  authorization: Row;
  attempt: Row;
  reservation: Row;
  hold: Row;
  quote: Row;
  dreams?: { hold: Row; quote: Row };
};
/** Source authority is the admitted, unique native image job and its original hold,
 * not the presence of an actual_micros number. No current tariff or current consent. */
export function knownImageSettlementQuote(p: KnownImageProof) {
  const { job: j, native: n, authorization: a, attempt: t, reservation: r, hold: h, quote: q } = p;
  const admitted = q.price_snapshot?.providerQuote,
    profile = j.pricing_profile_snapshot;
  if (
    !['generated', 'admitted', 'rejected', 'cancelled'].includes(j.status) ||
    j.input?.automaticKnownCostPolicy !== AUTOMATIC_IMAGE_SETTLEMENT_POLICY ||
    admitted?.automaticKnownCostPolicy !== AUTOMATIC_IMAGE_SETTLEMENT_POLICY ||
    j.mode !== 'external' ||
    j.spark_cost_verified !== true ||
    !j.dispatched_at ||
    !z.uuid().safeParse(j.operation_id).success ||
    !generationRequestSchema.safeParse(j.input).success ||
    ['ERASED', 'DATA_ERASED'].includes(j.error_code) ||
    j.quote_id !== n.id ||
    j.actor_id !== n.actor_id ||
    [
      'request_hash',
      'policy_version',
      'cost_basis',
      'generation_policy_revision',
      'generation_policy_hash',
      'adventure_id',
    ].some((k) => j[k] !== n[k]) ||
    ['input', 'reference_hashes', 'estimate_snapshot', 'pricing_profile_snapshot'].some(
      (k) => proofHash(j[k]) !== proofHash(n[k]),
    ) ||
    String(j.upper_micros) !== String(n.upper_micros) ||
    !['owner', 'release'].includes(a.mode) ||
    a.owner_id !== j.actor_id ||
    a.scope_id !== r.scope_id ||
    (a.mode === 'release' && a.scope_id !== `release:${j.actor_id}`) ||
    (j.input.generationAuthorizationId && j.input.generationAuthorizationId !== a.id) ||
    (j.input.liveTestSessionId && j.input.liveTestSessionId !== a.id) ||
    t.job_id !== j.id ||
    !t.dispatched_at ||
    !t.result_received_at ||
    !t.provider ||
    !z.uuid().safeParse(t.dispatch_id).success ||
    t.request_hash !== j.request_hash ||
    !j.provider_request_id ||
    t.provider_request_id !== j.provider_request_id ||
    String(t.actual_micros) !== String(j.actual_micros) ||
    r.id !== j.reservation_id ||
    r.actor_id !== j.actor_id ||
    r.kind !== 'image' ||
    r.operation_key !== j.id ||
    r.status !== 'settled' ||
    String(r.actual_micros) !== String(j.actual_micros) ||
    String(r.upper_micros) !== String(j.upper_micros) ||
    r.spark_quote_id !== j.spark_quote_id ||
    n.spark_quote_id !== j.spark_quote_id ||
    h.id !== j.spark_quote_id ||
    q.id !== h.id ||
    h.owner_id !== j.actor_id ||
    q.owner_id !== j.actor_id ||
    h.source_kind !== 'image' ||
    q.source_kind !== 'image' ||
    h.source_id !== n.id ||
    q.source_id !== n.id ||
    q.operation_id !== n.id ||
    String(q.reserve_subunits) !== String(h.reserved_subunits) ||
    !profile ||
    !profile.fingerprint ||
    !j.estimate_snapshot?.fingerprint ||
    !['approved_estimate', 'verified_bound'].includes(j.cost_basis) ||
    !admitted ||
    admitted.quoteId !== n.id ||
    admitted.requestHash !== j.request_hash ||
    admitted.settlement !== 'actual-image-micros' ||
    proofHash(admitted.pricingProfile) !== proofHash(profile) ||
    proofHash(admitted.estimate) !== proofHash(j.estimate_snapshot)
  )
    unavailable();
  if (
    admitted.automaticKnownCostPolicyHash !==
    imageKnownCostPolicy({
      quoteId: n.id,
      requestHash: n.request_hash,
      reserveMicros: String(n.upper_micros),
      costBasis: n.cost_basis,
    }).fingerprint
  )
    unavailable();
  const expected = digest({
    input: j.input,
    refs: j.reference_hashes,
    policy: j.policy_version,
    provider: t.provider,
    upper: Number(j.upper_micros),
    ...(j.estimate_snapshot
      ? {
          estimateSnapshotHash: j.estimate_snapshot.fingerprint,
          pricingProfileHash: profile.fingerprint,
        }
      : {}),
    ...(j.generation_policy_revision != null
      ? { policyRevision: j.generation_policy_revision, policyHash: j.generation_policy_hash }
      : {}),
  });
  if (
    !signedSnapshotMatches(profile, 'image-profile-v1') ||
    !signedSnapshotMatches(j.estimate_snapshot, 'image-estimate-v1')
  )
    unavailable();
  const tariff = q.price_snapshot?.tariff;
  if (
    expected !== j.request_hash ||
    !tariff ||
    tariff.provider !== t.provider ||
    tariff.providerRateVersion !== profile.fingerprint ||
    tariff.model !== profile.model ||
    tariff.inputMicrosPerMillion !== String(profile.inputTextMicrosPerMillion) ||
    tariff.outputMicrosPerMillion !== String(profile.outputImageMicrosPerMillion)
  )
    unavailable();
  try {
    const actual = parseSparkInteger(String(j.actual_micros)),
      upper = parseSparkInteger(String(j.upper_micros));
    const rateVersion = sparkQuoteRateVersion(q.price_snapshot);
    const reserve = parseSparkInteger(String(h.reserved_subunits));
    const sparkReserve = parseSparkInteger(
      String(h.sparks_reserved_subunits ?? h.reserved_subunits),
    );
    const captureSubunits = providerMicrosToSparkSubunits(actual.toString(), rateVersion),
      capture = BigInt(captureSubunits);
    if (
      actual > upper ||
      capture > reserve ||
      sparkReserve > reserve ||
      reserve !== BigInt(providerMicrosToSparkSubunits(upper.toString(), rateVersion)) ||
      !!h.dream_hold_id !== sparkReserve < reserve
    )
      unavailable();
    const receipt = knownImageReceipt(j.id, actual.toString());
    const terminal = ['settled', 'released'].includes(h.status);
    if (terminal) {
      if (
        h.reason !== null ||
        String(h.captured_subunits) !== captureSubunits ||
        h.status !== (capture === 0n ? 'released' : 'settled') ||
        !planSparkSettlement({ ...h, spark_rate_version: rateVersion } as SparkHold, receipt, true)
          .duplicate
      )
        unavailable();
    } else if (
      h.status !== 'pending' ||
      !['unknown', 'failure_policy_pending'].includes(h.reason) ||
      h.captured_subunits !== null ||
      h.settlement_fingerprint !== null
    )
      unavailable();
    const dreamReserve = reserve - sparkReserve,
      dreamCapture = capture < dreamReserve ? capture : dreamReserve;
    if (dreamReserve > 0n) {
      const dh = p.dreams?.hold,
        dq = p.dreams?.quote;
      if (
        !dh ||
        !dq ||
        q.price_snapshot.fundingPolicy !== DREAMS_FIRST_POLICY ||
        dh.id !== h.dream_hold_id ||
        dq.id !== dh.id ||
        dh.owner_id !== j.actor_id ||
        dq.owner_id !== j.actor_id ||
        dh.source_kind !== 'image' ||
        dq.source_kind !== 'image' ||
        dh.source_id !== n.id ||
        dq.source_id !== n.id ||
        dq.operation_id !== h.id ||
        String(dh.reserved_subunits) !== dreamReserve.toString() ||
        String(dq.reserve_subunits) !== dreamReserve.toString() ||
        dq.price_snapshot?.currency !== 'dreams' ||
        dq.price_snapshot?.policyVersion !== DREAMS_FIRST_POLICY ||
        dq.price_snapshot?.providerQuote?.sparkQuoteId !== h.id ||
        !dq.price_snapshot?.providerQuote?.priceSnapshot ||
        digest(dq.price_snapshot.providerQuote.priceSnapshot) !== digest(q.price_snapshot)
      )
        unavailable();
      if (terminal) {
        if (
          dh!.reason !== null ||
          dh!.status !== (dreamCapture === 0n ? 'released' : 'settled') ||
          String(dh!.captured_subunits) !== dreamCapture.toString() ||
          !planDreamSettlement(
            { ...dh, policy_version: DREAMS_FIRST_POLICY } as DreamHold,
            {
              outcome: 'success',
              actualSubunits: dreamCapture.toString(),
              policyVersion: DREAMS_FIRST_POLICY,
              evidence: 'configured_rates',
              receiptId: receipt.receiptId,
            },
            true,
          ).duplicate
        )
          unavailable();
      } else if (
        dh!.status !== 'pending' ||
        dh!.reason !== 'unknown' ||
        dh!.captured_subunits !== null ||
        dh!.settlement_fingerprint !== null
      )
        unavailable();
    } else if (p.dreams) unavailable();
    return {
      actualMicros: actual.toString(),
      captureSubunits,
      releaseSubunits: (reserve - capture).toString(),
      terminal,
      receipt,
    };
  } catch {
    return unavailable();
  }
}

/** Caller owns authorization -> scope -> job locks. Never takes another scope lock.
 * Invalid/incomplete source evidence is a no-op; DB/accounting errors roll back. */
export async function settleKnownImageTx(c: PoolClient, jobId: string) {
  const j = (await c.query('SELECT * FROM image_generation_jobs WHERE id=$1', [jobId])).rows[0];
  if (
    !j?.spark_quote_id ||
    j.spark_cost_verified !== true ||
    j.input?.automaticKnownCostPolicy !== AUTOMATIC_IMAGE_SETTLEMENT_POLICY
  )
    return;
  const r = (
    await c.query('SELECT * FROM generation_budget_reservations WHERE id=$1', [j.reservation_id])
  ).rows[0];
  if (!r) return;
  await fenceGenerationAdmission(c);
  const authorizations = (
    await c.query(
      "SELECT * FROM live_test_sessions WHERE scope_id=$1 AND owner_id=$2 AND mode IN ('owner','release')",
      [r.scope_id, j.actor_id],
    )
  ).rows;
  const n = (await c.query('SELECT * FROM image_generation_quotes WHERE id=$1', [j.quote_id]))
    .rows[0];
  const t = (await c.query('SELECT * FROM image_generation_attempts WHERE job_id=$1', [j.id]))
    .rows[0];
  if (!n || !t || authorizations.length !== 1) return;
  await c.query('SELECT owner_id FROM spark_wallets WHERE owner_id=$1 FOR UPDATE', [j.actor_id]);
  const h = (
    await c.query('SELECT * FROM spark_holds WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
      j.spark_quote_id,
      j.actor_id,
    ])
  ).rows[0];
  const q = (
    await c.query('SELECT * FROM spark_quotes WHERE id=$1 AND owner_id=$2', [
      j.spark_quote_id,
      j.actor_id,
    ])
  ).rows[0];
  if (!h || !q) return;
  if (h.dream_hold_id)
    await c.query('SELECT owner_id FROM dream_wallets WHERE owner_id=$1 FOR UPDATE', [j.actor_id]);
  const readDreams = async () => {
    if (!h.dream_hold_id) return undefined;
    const hold = (
      await c.query('SELECT * FROM dream_holds WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
        h.dream_hold_id,
        j.actor_id,
      ])
    ).rows[0];
    const quote = (
      await c.query('SELECT * FROM dream_quotes WHERE id=$1 AND owner_id=$2', [
        h.dream_hold_id,
        j.actor_id,
      ])
    ).rows[0];
    return hold && quote ? { hold, quote } : undefined;
  };
  const proof = {
    job: j,
    native: n,
    authorization: authorizations[0],
    attempt: t,
    reservation: r,
    hold: h,
    quote: q,
    dreams: await readDreams(),
  };
  let view;
  try {
    view = knownImageSettlementQuote(proof);
  } catch (e) {
    if (e instanceof Error && e.message === 'IMAGE_SETTLEMENT_PROOF_UNAVAILABLE') return;
    throw e;
  }
  if (view.terminal) return view;
  const settled = await new SparksAccounting().settle(c, j.actor_id, h.id, view.receipt, true);
  const final = knownImageSettlementQuote({ ...proof, hold: settled, dreams: await readDreams() });
  if (!final.terminal) unavailable();
  await c.query('INSERT INTO audit(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)', [
    j.actor_id,
    'image.known_result.settled',
    j.id,
    JSON.stringify({
      actualMicros: final.actualMicros,
      captureSubunits: final.captureSubunits,
      releaseSubunits: final.releaseSubunits,
    }),
  ]);
  return final;
}
