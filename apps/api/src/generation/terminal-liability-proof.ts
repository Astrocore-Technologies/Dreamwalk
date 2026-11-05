import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow as Row } from 'pg';
import { providerMicrosToSparkSubunits } from '@dreamwalk/contracts';
import { digest } from '../ai/context';
import { knownCountSettlement, knownPermitSettlement } from './known-text-settlement';
import { textUsageCostMicros } from './text-pricing';
import { sourceAccessSql } from '../game/source-access';
import { knownNpcSettlementQuote } from '../game/known-npc-settlement';
import { automaticNpcAdmission } from '../game/automatic-npc-settlement';
import { knownAuthoringSettlementQuote } from '../live-test/known-authoring-settlement';
import { knownImageSettlementQuote } from '../image-generation/known-settlement';
import { imageRecoverySchema, isRecoverableModelRejection } from '../image-generation/recovery';
import {
  DREAMS_FIRST_POLICY,
  planSparkSettlement,
  sparkQuoteRateVersion,
  type SparkHold,
  type SparkSettlement,
} from './sparks-accounting';
import { planDreamSettlement, type DreamHold } from './dreams-accounting';

export type TerminalLiabilitySnapshot = {
  scope: Row;
  authorizations: Row[];
  reservations: Row[];
  counts: Row[];
  permits: Row[];
  npcJobs: Row[];
  npcQuotes: Row[];
  authoringJobs: Row[];
  authoringQuotes: Row[];
  imageJobs: Row[];
  imageQuotes: Row[];
  imageAttempts: Row[];
  recoveries: Row[];
  requests: Row[];
  batches: Row[];
  audits: Row[];
  providerBudgets: Row[];
  sparkWallets: Row[];
  sparkHolds: Row[];
  sparkQuotes: Row[];
  sparkLedger: Row[];
  dreamWallets: Row[];
  dreamHolds: Row[];
  dreamQuotes: Row[];
  dreamLedger: Row[];
};
export type TerminalLiabilityOptions = {
  /** Caller must additionally prove these historical sources are unrelated to the
   * uncertainty epoch being cleared. This never authorizes capture or release. */
  allowRetainedFullyFundedPending?: boolean;
  /** ONLY exact immutable current epoch events, never request input. */
  allowedRequestStops?: { kind: string; id: string; causeCode: string }[];
};
export type TerminalLiabilityResult =
  | { eligible: false; code: string }
  | {
      eligible: true;
      evidence: {
        version: 'terminal-liabilities-v1';
        scopeId: string;
        reservations: number;
        sources: number;
        actualMicros: string;
        coveredExposureMicros: string;
        retainedFullyFunded: {
          holdId: string;
          reservationId: string;
          sourceKind: string;
          sourceId: string;
        }[];
        verifiedSources: {
          kind: string;
          id: string;
          authorizationId: string;
          reservationId: string;
          status: string;
          providerJobStatus?: string;
        }[];
        retainedSourceIds: { kind: string; id: string }[];
        fingerprint: string;
      };
    };
const integer = (v: unknown): bigint => {
  if (typeof v === 'number' && (!Number.isSafeInteger(v) || Object.is(v, -0)))
    throw new Error('INVALID_INTEGER');
  if (!['string', 'number', 'bigint'].includes(typeof v) || !/^(0|[1-9][0-9]*)$/.test(String(v)))
    throw new Error('INVALID_INTEGER');
  return BigInt(String(v));
};
const one = (rows: Row[], id: unknown, field = 'id'): Row => {
  const matches = rows.filter((r) => r[field] === id);
  if (matches.length !== 1) throw new Error('MISSING_OR_DUPLICATE_BINDING');
  return matches[0];
};
const terminal = (h: Row) => ['settled', 'released'].includes(h.status);
const success = (receiptId: string, actualMicros: unknown): SparkSettlement => ({
  outcome: 'success',
  receiptId,
  actualMicros: integer(actualMicros).toString(),
  evidence: 'configured_rates',
});
const requestStopCauses = new Set([
  'PROVIDER_TIMEOUT',
  'IMAGE_PROVIDER_DEADLINE_EXCEEDED',
  'PROVIDER_DEADLINE_EXCEEDED',
  'TEXT_COUNT_DEADLINE_EXCEEDED',
  'PROVIDER_RESERVATION_EXPIRED',
  'PROVIDER_CANCELLED_IN_FLIGHT',
  'PROVIDER_FINALIZED_IN_FLIGHT',
]);
const discarded = (status: unknown) =>
  ['stale', 'failed', 'cancelled', 'rejected'].includes(String(status));
function allowedStops(
  options: TerminalLiabilityOptions,
  kind: string,
  id: string,
  status: unknown,
  nativeCountProven = false,
): Set<string> {
  return new Set(
    discarded(status) ||
      (kind === 'count' &&
        nativeCountProven &&
        ['unknown', 'over_context'].includes(String(status)))
      ? (options.allowedRequestStops ?? [])
          .filter((e) => e.kind === kind && e.id === id && requestStopCauses.has(e.causeCode))
          .map((e) => e.causeCode)
      : [],
  );
}
const restricted = (j: Row, allowed = new Set<string>()) =>
  [j.result_code, j.error_code, j.safe_diagnostic?.category, j.safe_diagnostic?.providerCode].some(
    (code) => {
      const value = String(code ?? '');
      if (requestStopCauses.has(value)) return !allowed.has(value);
      return /ERASE|REVOK|DELETED|UNAVAILABLE|HTTP_403|DEADLINE|TIMEOUT|OVERRUN|ACCESS|SECURITY/i.test(
        value,
      );
    },
  ) ||
  j.context_hash === 'erased' ||
  Number(j.safe_diagnostic?.httpStatus) === 403;

/** Pure native proof adapters expect unfinalized funding. Copies remove ONLY mutable
 * settlement fields; original holds are separately checked against exact receipts below.
 * No source identity, request, cost, policy, usage or lifecycle is rewritten. */
function unfinalized(h: Row, dream = false): Row {
  return {
    ...h,
    status: 'pending',
    reason: dream ? 'unknown' : 'failure_policy_pending',
    captured_subunits: null,
    settlement_fingerprint: null,
  };
}
function funding(s: TerminalLiabilitySnapshot, id: unknown) {
  const hold = one(s.sparkHolds, id),
    quote = one(s.sparkQuotes, id);
  const dreams = hold.dream_hold_id
    ? { hold: one(s.dreamHolds, hold.dream_hold_id), quote: one(s.dreamQuotes, hold.dream_hold_id) }
    : undefined;
  return { hold, quote, dreams };
}
function sourceFunding(f: ReturnType<typeof funding>) {
  return {
    hold: unfinalized(f.hold),
    quote: f.quote,
    dreams: f.dreams
      ? { hold: unfinalized(f.dreams.hold, true), quote: f.dreams.quote }
      : undefined,
  };
}
function ledgerMatches(
  rows: Row[],
  hold: Row,
  reserve: bigint,
  capture: bigint,
  receipt: unknown,
  pending: boolean,
  pendingReceiptIds: string[],
) {
  const entries = rows.filter((e) => e.hold_id === hold.id);
  if (
    entries.some(
      (e) =>
        e.owner_id !== hold.owner_id ||
        !['reserve', 'pending', 'capture', 'release'].includes(e.kind),
    )
  )
    return false;
  const exact = (kind: string, amount: bigint) => {
    const entriesOfKind = entries.filter((e) => e.kind === kind);
    return (
      entriesOfKind.length === 1 &&
      entriesOfKind[0].event_key === `${kind}:${hold.id}` &&
      integer(entriesOfKind[0].amount_subunits) === amount &&
      (kind === 'reserve' || digest(entriesOfKind[0].evidence) === digest(receipt))
    );
  };
  if (
    !exact('reserve', reserve) ||
    new Set(entries.map((e) => e.event_key)).size !== entries.length
  )
    return false;
  if (
    entries
      .filter((e) => e.kind === 'pending')
      .some(
        (e) =>
          e.event_key !== `pending:${hold.id}:${digest(e.evidence)}` ||
          integer(e.amount_subunits) !== reserve ||
          !['unknown', 'failure_policy_pending'].includes(e.evidence?.outcome) ||
          !pendingReceiptIds.includes(e.evidence?.receiptId) ||
          Object.keys(e.evidence).sort().join(',') !== 'outcome,receiptId',
      )
  )
    return false;
  if (pending)
    return (
      !entries.some((e) => ['capture', 'release'].includes(e.kind)) &&
      entries.some(
        (e) =>
          e.kind === 'pending' &&
          e.event_key === `pending:${hold.id}:${digest(e.evidence)}` &&
          integer(e.amount_subunits) === reserve &&
          ['unknown', 'failure_policy_pending'].includes(e.evidence?.outcome),
      )
    );
  return exact('capture', capture) && exact('release', reserve - capture);
}
/** Exact immutable quote, native receipt, split, hold and append-only ledger proof. */
function financial(
  s: TerminalLiabilitySnapshot,
  r: Row,
  f: ReturnType<typeof funding>,
  receipts: SparkSettlement[],
  allowPending: boolean,
  pendingReceiptIds: string[],
): 'terminal' | 'retained' | undefined {
  const { hold: h, quote: q, dreams } = f;
  const rate = sparkQuoteRateVersion(q.price_snapshot),
    reserve = integer(h.reserved_subunits);
  const sparkReserve = integer(h.sparks_reserved_subunits ?? h.reserved_subunits),
    dreamReserve = reserve - sparkReserve;
  if (
    h.owner_id !== r.actor_id ||
    q.owner_id !== h.owner_id ||
    q.id !== h.id ||
    h.id !== r.spark_quote_id ||
    q.source_kind !== h.source_kind ||
    q.source_id !== h.source_id ||
    integer(q.reserve_subunits) !== reserve ||
    reserve !== integer(providerMicrosToSparkSubunits(integer(r.upper_micros).toString(), rate)) ||
    dreamReserve < 0n ||
    !!h.dream_hold_id !== dreamReserve > 0n
  )
    return;
  const pending = h.status === 'pending';
  if (
    !terminal(h) &&
    !(
      pending &&
      allowPending &&
      ['unknown', 'failure_policy_pending'].includes(h.reason) &&
      h.captured_subunits === null &&
      h.settlement_fingerprint === null &&
      h.settled_at === null
    )
  )
    return;
  for (const receipt of receipts) {
    try {
      const capture =
        receipt.outcome === 'success'
          ? integer(providerMicrosToSparkSubunits(receipt.actualMicros, rate))
          : 0n;
      if (capture > reserve) continue;
      if (
        !pending &&
        (h.reason !== null ||
          !h.settled_at ||
          integer(h.captured_subunits) !== capture ||
          h.status !== (capture === 0n ? 'released' : 'settled') ||
          !planSparkSettlement({ ...h, spark_rate_version: rate } as SparkHold, receipt, true)
            .duplicate)
      )
        continue;
      const dreamCapture = capture < dreamReserve ? capture : dreamReserve,
        sparkCapture = capture - dreamCapture;
      if (
        !ledgerMatches(
          s.sparkLedger,
          h,
          sparkReserve,
          sparkCapture,
          receipt,
          pending,
          pendingReceiptIds,
        )
      )
        continue;
      if (dreamReserve > 0n) {
        const dh = dreams?.hold,
          dq = dreams?.quote;
        if (
          !dh ||
          !dq ||
          q.price_snapshot.fundingPolicy !== DREAMS_FIRST_POLICY ||
          dh.id !== h.dream_hold_id ||
          dq.id !== dh.id ||
          dh.owner_id !== h.owner_id ||
          dq.owner_id !== h.owner_id ||
          dh.source_kind !== h.source_kind ||
          dq.source_kind !== h.source_kind ||
          dh.source_id !== h.source_id ||
          dq.source_id !== h.source_id ||
          dq.operation_id !== h.id ||
          integer(dh.reserved_subunits) !== dreamReserve ||
          integer(dq.reserve_subunits) !== dreamReserve ||
          dq.price_snapshot?.currency !== 'dreams' ||
          dq.price_snapshot?.policyVersion !== DREAMS_FIRST_POLICY ||
          dq.price_snapshot?.providerQuote?.sparkQuoteId !== h.id ||
          digest(dq.price_snapshot?.providerQuote?.priceSnapshot) !== digest(q.price_snapshot)
        )
          continue;
        const dr = {
          outcome: 'success' as const,
          actualSubunits: dreamCapture.toString(),
          policyVersion: DREAMS_FIRST_POLICY,
          evidence: 'configured_rates' as const,
          receiptId: receipt.receiptId,
        };
        if (
          pending
            ? dh.status !== 'pending' ||
              dh.reason !== 'unknown' ||
              dh.captured_subunits !== null ||
              dh.settlement_fingerprint !== null ||
              dh.settled_at !== null
            : dh.reason !== null ||
              !dh.settled_at ||
              dh.status !== (dreamCapture === 0n ? 'released' : 'settled') ||
              integer(dh.captured_subunits) !== dreamCapture ||
              !planDreamSettlement(
                { ...dh, policy_version: DREAMS_FIRST_POLICY } as DreamHold,
                dr,
                true,
              ).duplicate
        )
          continue;
        if (
          !ledgerMatches(
            s.dreamLedger,
            dh,
            dreamReserve,
            dreamCapture,
            dr,
            pending,
            pendingReceiptIds,
          )
        )
          continue;
      } else if (dreams) continue;
      return pending ? 'retained' : 'terminal';
    } catch {
      /* Try only explicitly supported deterministic native receipt identities. */
    }
  }
}
function walletsMatch(wallets: Row[], holds: Row[], ledger: Row[], spark: boolean) {
  if (new Set(wallets.map((w) => w.owner_id)).size !== wallets.length) return false;
  for (const wallet of wallets) {
    const hs = holds.filter((h) => h.owner_id === wallet.owner_id),
      ls = ledger.filter((l) => l.owner_id === wallet.owner_id);
    const held = hs
      .filter((h) => !terminal(h))
      .reduce(
        (sum, h) =>
          sum +
          integer(
            spark ? (h.sparks_reserved_subunits ?? h.reserved_subunits) : h.reserved_subunits,
          ),
        0n,
      );
    let balance = 0n;
    for (const l of ls) {
      const amount = integer(l.amount_subunits);
      if (['starter_grant', 'admin_credit'].includes(l.kind)) balance += amount;
      else if (['capture', 'admin_debit'].includes(l.kind)) balance -= amount;
      else if (!['reserve', 'pending', 'release'].includes(l.kind)) return false;
      if (l.hold_id && !hs.some((h) => h.id === l.hold_id)) return false;
    }
    if (
      held !== integer(wallet.held_subunits) ||
      balance !== integer(wallet.balance_subunits) ||
      held > balance
    )
      return false;
  }
  return holds.every((h) => wallets.some((w) => w.owner_id === h.owner_id));
}
function legacyNpcProof(s: TerminalLiabilitySnapshot, options: TerminalLiabilityOptions): boolean {
  for (const j of s.npcJobs) {
    if (j.provider_external === false) continue;
    const permit = s.permits.find((p) => p.job_id === j.id);
    const own = s.authorizations.some((a) => a.id === j.generation_authorization_id);
    const allowed = own
      ? allowedStops(options, permit ? 'permit' : 'npc', permit?.id ?? j.id, j.status)
      : new Set<string>();
    if (
      !['committed', 'stale', 'cancelled', 'failed'].includes(j.status) ||
      restricted(j, allowed) ||
      !['spent', 'released', 'none'].includes(j.provider_budget_status)
    )
      return false;
    if (j.provider_budget_status === 'spent') {
      const usage = j.provider_usage,
        pricing = j.request_snapshot;
      if (
        !usage ||
        !pricing ||
        j.provider_cost_evidence !== 'configured_rates' ||
        usage.costEvidence !== 'configured_rates' ||
        usage.costVerifiedForSparks !== true ||
        !['inputTokens', 'outputTokens'].every(
          (k) => Number.isSafeInteger(usage[k]) && usage[k] >= 0,
        )
      )
        return false;
      const computed = textUsageCostMicros(pricing, usage);
      if (
        !computed.costVerifiedForSparks ||
        integer(computed.costMicros) !== integer(j.provider_actual_micros) ||
        integer(usage.costMicros) !== integer(j.provider_actual_micros) ||
        integer(j.input_tokens) !== integer(usage.inputTokens) ||
        integer(j.output_tokens) !== integer(usage.outputTokens) ||
        integer(j.cached_input_tokens ?? 0) !== integer(usage.cachedInputTokens ?? 0) ||
        integer(pricing.reserveMicros) !== integer(j.provider_upper_micros) ||
        integer(j.provider_actual_micros) > integer(j.provider_upper_micros)
      )
        return false;
    } else if (
      (j.provider_actual_micros != null && integer(j.provider_actual_micros) !== 0n) ||
      j.started_at ||
      j.provider_request_id ||
      j.result_at
    )
      return false;
    if (!s.providerBudgets.some((b) => b.provider_id === j.provider_id)) return false;
  }
  for (const b of s.providerBudgets) {
    const jobs = s.npcJobs.filter((j) => j.provider_id === b.provider_id);
    if (
      b.blocked ||
      integer(b.overrun_micros) !== 0n ||
      integer(b.unknown_micros) !== 0n ||
      integer(b.reserved_micros) !== 0n
    )
      return false;
    const spent = jobs
      .filter((j) => j.provider_budget_status === 'spent')
      .reduce((sum, j) => sum + integer(j.provider_actual_micros), 0n);
    if (
      jobs.some((j) => ['reserved', 'unknown'].includes(j.provider_budget_status)) ||
      spent !== integer(b.spent_micros)
    )
      return false;
    if (
      b.unlimited_allowance === true
        ? b.cap_micros !== null || !String(b.provider_id).startsWith('release:')
        : b.unlimited_allowance !== false || spent > integer(b.cap_micros)
    )
      return false;
  }
  return true;
}
function secureRecovery(s: TerminalLiabilitySnapshot, j: Row, r: Row): boolean {
  const recovery = one(s.recoveries, j.id, 'job_id'),
    attempt = one(s.imageAttempts, j.id, 'job_id');
  const native = one(s.imageQuotes, j.quote_id);
  const evidence = recovery.evidence;
  if (
    j.mode !== 'external' ||
    j.actor_id !== r.actor_id ||
    native.actor_id !== j.actor_id ||
    native.request_hash !== j.request_hash ||
    digest(native.input) !== digest(j.input) ||
    r.operation_key !== j.id ||
    integer(j.upper_micros) !== integer(r.upper_micros) ||
    j.error_code !== recovery.original_job?.errorCode
  )
    return false;
  const parsed = imageRecoverySchema.safeParse({
    mode: 'review',
    operationId: recovery.operation_id,
    evidence,
  });
  return (
    parsed.success &&
    recovery.scope_id === r.scope_id &&
    s.authorizations.some(
      (a) => a.id === recovery.authorization_id && a.owner_id === j.actor_id && a.mode === 'owner',
    ) &&
    recovery.request_hash ===
      createHash('sha256')
        .update(JSON.stringify({ jobId: j.id, evidence }))
        .digest('hex') &&
    j.status === 'rejected' &&
    r.status === 'settled' &&
    integer(j.actual_micros) === integer(r.actual_micros) &&
    integer(recovery.actual_micros) === integer(r.actual_micros) &&
    integer(evidence.actualMicros) === integer(r.actual_micros) &&
    recovery.original_job?.status === 'unknown' &&
    isRecoverableModelRejection(recovery.original_job?.safeDiagnostic) &&
    digest(recovery.original_job.safeDiagnostic) === digest(j.safe_diagnostic) &&
    evidence.requestId === j.safe_diagnostic?.requestId &&
    attempt.request_hash === j.request_hash &&
    !!attempt.dispatched_at &&
    attempt.actual_micros === null &&
    attempt.result_received_at === null &&
    !j.spark_quote_id &&
    !r.spark_quote_id
  );
}

/** Fail closed on unsupported historical bindings. This proves liabilities only;
 * caller independently verifies current ownership, policy, access and block epoch. */
export function proveTerminalLiabilitySnapshot(
  s: TerminalLiabilitySnapshot,
  options: TerminalLiabilityOptions = {},
): TerminalLiabilityResult {
  let stage = 'SCOPE';
  const no = (code: string): TerminalLiabilityResult => ({ eligible: false, code });
  try {
    const owner = s.authorizations[0]?.owner_id,
      ids = new Set(s.authorizations.map((a) => a.id));
    if (
      !owner ||
      !s.scope.approved ||
      s.authorizations.some((a) => a.scope_id !== s.scope.id || a.owner_id !== owner) ||
      ids.size !== s.authorizations.length
    )
      return no('SCOPE_AUTHORIZATION_BINDING');
    if (
      s.counts.some(
        (j) =>
          j.status === 'dispatched' ||
          (j.status === 'unknown' && j.scope_id !== s.scope.id && !ids.has(j.authorization_id)),
      )
    )
      return no('COUNT_GLOBAL_LIABILITY_UNRESOLVED');
    stage = 'COUNT';
    // Global counts share the admission safety boundary even when their financial
    // scope is foreign. A terminal label alone is not a trusted fixed-price bill.
    for (const count of s.counts.filter(
      (j) => j.scope_id !== s.scope.id && !ids.has(j.authorization_id),
    )) {
      if (
        !['succeeded', 'over_context', 'stale'].includes(count.status) ||
        restricted(count) ||
        !count.completed_at ||
        !count.request_hash ||
        !count.body_sha256 ||
        !count.source_hash ||
        integer(count.input_tokens) > BigInt(Number.MAX_SAFE_INTEGER) ||
        integer(count.actual_micros) !== integer(count.pricing_snapshot?.microsPerRequest)
      )
        return no('COUNT_FOREIGN_RECEIPT_UNPROVEN');
    }
    stage = 'NPC_PROVIDER';
    if (!legacyNpcProof(s, options)) return no('NPC_PROVIDER_LEDGER_UNRESOLVED');
    const sources: {
      kind: 'count' | 'permit' | 'npc' | 'authoring' | 'image';
      row: Row;
      authorizationId: string;
      reservationId: string;
    }[] = [];
    for (const j of s.counts.filter(
      (j) => j.scope_id === s.scope.id || ids.has(j.authorization_id),
    ))
      sources.push({
        kind: 'count',
        row: j,
        authorizationId: j.authorization_id,
        reservationId: j.reservation_id,
      });
    for (const p of s.permits)
      sources.push({
        kind: 'permit',
        row: p,
        authorizationId: p.session_id,
        reservationId: p.reservation_id,
      });
    for (const j of s.authoringJobs)
      sources.push({
        kind: 'authoring',
        row: j,
        authorizationId: j.session_id,
        reservationId: j.reservation_id,
      });
    for (const j of s.npcJobs.filter(
      (j) =>
        ids.has(j.generation_authorization_id) &&
        j.provider_external !== false &&
        !s.permits.some((p) => p.job_id === j.id),
    ))
      sources.push({
        kind: 'npc',
        row: j,
        authorizationId: j.generation_authorization_id,
        reservationId: j.generation_reservation_id,
      });
    for (const j of s.imageJobs) {
      const a = s.authorizations.filter(
        (a) =>
          a.id === (j.input?.generationAuthorizationId ?? j.input?.liveTestSessionId) ||
          (!j.input?.generationAuthorizationId &&
            !j.input?.liveTestSessionId &&
            a.owner_id === j.actor_id &&
            ['owner', 'release'].includes(a.mode)),
      );
      if (a.length !== 1) return no('IMAGE_AUTHORIZATION_BINDING');
      sources.push({
        kind: 'image',
        row: j,
        authorizationId: a[0].id,
        reservationId: j.reservation_id,
      });
    }
    const retainedFullyFunded: {
      holdId: string;
      reservationId: string;
      sourceKind: string;
      sourceId: string;
    }[] = [];
    const verifiedSources: {
      kind: string;
      id: string;
      authorizationId: string;
      reservationId: string;
      status: string;
    }[] = [];
    let actual = 0n,
      text = 0n,
      image = 0n;
    const usedHolds = new Set<string>();
    for (const source of sources) {
      stage = source.kind.toUpperCase();
      const j = source.row,
        a = one(s.authorizations, source.authorizationId),
        r = one(s.reservations, source.reservationId);
      if (
        r.scope_id !== s.scope.id ||
        r.actor_id !== owner ||
        !['settled', 'released'].includes(r.status) ||
        !['text', 'image'].includes(r.kind) ||
        r.kind !== (source.kind === 'image' ? 'image' : 'text')
      )
        return no(`${stage}_RESERVATION_UNRESOLVED`);
      if (
        s.reservations.some(
          (other) =>
            other.id !== r.id && other.spark_quote_id && other.spark_quote_id === r.spark_quote_id,
        ) ||
        sources.filter((other) => other.reservationId === r.id).length !== 1
      )
        return no(`${stage}_DUPLICATE_RESERVATION`);
      const upper = integer(r.upper_micros),
        cost = r.status === 'released' && r.actual_micros === null ? 0n : integer(r.actual_micros);
      if (cost > upper || (r.status === 'released' && cost !== 0n))
        return no(`${stage}_RESERVATION_OVERRUN`);
      if (source.kind === 'image' && s.recoveries.some((rec) => rec.job_id === j.id)) {
        if (!secureRecovery(s, j, r)) return no('IMAGE_SECURE_RECOVERY_UNPROVEN');
        actual += cost;
        image += cost;
        verifiedSources.push({
          kind: source.kind,
          id: j.id,
          authorizationId: a.id,
          reservationId: r.id,
          status: String(j.status ?? j.state),
        });
        continue;
      }
      const providerJob =
        source.kind === 'permit' && j.job_id ? s.npcJobs.find((n) => n.id === j.job_id) : undefined;
      const allowed = allowedStops(options, source.kind, j.id, providerJob?.status ?? j.status);
      if (source.kind !== 'count' && restricted(j, allowed))
        return no(`${stage}_SOURCE_RESTRICTED`);
      const f = funding(s, r.spark_quote_id),
        sf = sourceFunding(f);
      if (usedHolds.has(f.hold.id)) return no(`${stage}_DUPLICATE_HOLD`);
      usedHolds.add(f.hold.id);
      let receipts: SparkSettlement[] = [];
      if (source.kind === 'count') {
        if (!['succeeded', 'over_context', 'stale', 'unknown'].includes(j.status))
          return no('COUNT_NOT_TERMINAL');
        const receipt = knownCountSettlement(j, a, r, sf, true);
        if (!receipt) return no('COUNT_NATIVE_RECEIPT_UNPROVEN');
        // A late count may intentionally retain its unknown/over-context label.
        // Only this exact native receipt proves financial completion; never adopt
        // its token count or extend the exemption to any other unknown source.
        if (restricted(j, allowedStops(options, 'count', j.id, j.status, true)))
          return no('COUNT_SOURCE_RESTRICTED');
        receipts = [receipt];
      } else if (source.kind === 'permit') {
        if (
          j.state === 'cancelled' &&
          !j.dispatched_at &&
          !j.job_id &&
          j.completed_at &&
          cost === 0n &&
          !s.npcJobs.some((n) => n.request_meta?.runtimeRequestId === j.request_id)
        ) {
          if (
            j.session_id !== a.id ||
            j.spark_quote_id !== f.hold.id ||
            r.operation_key !== `manual-text:${j.request_id}` ||
            f.hold.source_kind !== 'text' ||
            f.hold.source_id !== j.request_id ||
            f.quote.operation_id !== j.id
          )
            return no('PERMIT_UNDISPATCHED_BINDING');
          receipts = [{ outcome: 'not_dispatched', receiptId: `permit:${j.id}` }];
        } else {
          const n = one(s.npcJobs, j.job_id),
            request = one(s.requests, j.request_id);
          if (restricted(n, allowed)) return no('PERMIT_PROVIDER_RESTRICTED');
          const receipt = knownPermitSettlement(j, n, request, a, r, sf, false, true);
          if (!receipt) return no('PERMIT_NATIVE_RECEIPT_UNPROVEN');
          receipts = [receipt];
        }
      } else if (source.kind === 'npc') {
        if (
          j.generation_reservation_id !== r.id ||
          j.generation_authorization_id !== a.id ||
          r.operation_key !== `release-npc:${j.id}` ||
          r.status !== 'settled' ||
          integer(j.provider_actual_micros) !== cost
        )
          return no('NPC_RESERVATION_BINDING');
        const native = one(s.npcQuotes, j.quote_id),
          request = s.requests.find((p) => p.id === j.request_meta?.runtimeRequestId);
        const batches = s.batches.filter((b) =>
          b.entries?.some(
            (e: Row) =>
              e.requestId === j.request_meta?.runtimeRequestId && e.quote?.id === j.quote_id,
          ),
        );
        if (
          batches.length > 1 ||
          !automaticNpcAdmission(
            j,
            native,
            a,
            r,
            sf.hold,
            sf.quote,
            batches[0],
            request,
            sf.dreams,
            true,
          )
        )
          return no('NPC_NATIVE_ADMISSION_UNPROVEN');
        const view = knownNpcSettlementQuote(
          j,
          f.hold.status === 'pending' ? sf.hold : f.hold,
          f.quote,
          'terminal',
        );
        receipts = [
          success(`commit:${j.id}`, view.actualMicros),
          success(`automatic-npc-settlement:${j.id}`, view.actualMicros),
          success(`ordinary-failure:${j.id}`, view.actualMicros),
        ];
        const audits = s.audits.filter(
          (x) =>
            x.action === 'npc.known_failure.settled' &&
            x.target_id === j.id &&
            x.actor_id === owner,
        );
        if (audits.length > 1) return no('NPC_SETTLEMENT_AUDIT_AMBIGUOUS');
        if (
          audits[0]?.details?.operationId &&
          audits[0].details.holdId === f.hold.id &&
          audits[0].details.actualMicros === cost.toString()
        )
          receipts.push(
            success(`owner-npc-settlement:${audits[0].details.operationId}`, view.actualMicros),
          );
      } else if (source.kind === 'authoring') {
        const native = one(s.authoringQuotes, j.quote_id);
        const audits = s.audits.filter(
          (x) =>
            x.action === 'authoring.known_failure.settled' &&
            x.target_id === j.id &&
            x.actor_id === owner,
        );
        if (audits.length > 1) return no('AUTHORING_SETTLEMENT_AUDIT_AMBIGUOUS');
        if (terminal(f.hold) && audits[0]) {
          const view = knownAuthoringSettlementQuote(
            j,
            native,
            a,
            r,
            f.hold,
            f.quote,
            audits[0],
            f.dreams,
          );
          receipts = [
            success(
              `owner-authoring-settlement:${audits[0].details.operationId}`,
              view.actualMicros,
            ),
          ];
        } else {
          const view = knownAuthoringSettlementQuote(
            j,
            native,
            a,
            r,
            f.hold.status === 'pending' ? sf.hold : f.hold,
            f.quote,
            undefined,
            f.hold.status === 'pending' ? sf.dreams : f.dreams,
            false,
            true,
          );
          receipts = [success(`authoring:${j.id}`, view.actualMicros)];
        }
      } else {
        if (!['admitted', 'rejected', 'cancelled', 'expired'].includes(j.status))
          return no('IMAGE_NOT_TERMINAL');
        const native = one(s.imageQuotes, j.quote_id),
          attempts = s.imageAttempts.filter((t) => t.job_id === j.id);
        if (
          !j.dispatched_at &&
          !attempts.length &&
          cost === 0n &&
          ['cancelled', 'expired', 'rejected'].includes(j.status)
        ) {
          if (
            j.actor_id !== owner ||
            native.actor_id !== owner ||
            j.request_hash !== native.request_hash ||
            digest(j.input) !== digest(native.input) ||
            j.spark_quote_id !== f.hold.id ||
            native.spark_quote_id !== f.hold.id ||
            r.operation_key !== j.id ||
            f.hold.source_kind !== 'image' ||
            f.hold.source_id !== native.id ||
            f.quote.operation_id !== native.id
          )
            return no('IMAGE_UNDISPATCHED_BINDING');
          receipts = [
            { outcome: 'not_dispatched', receiptId: `undispatched:${r.id}` },
            { outcome: 'not_dispatched', receiptId: `image:${j.id}` },
          ];
        } else {
          if (attempts.length !== 1) return no('IMAGE_ATTEMPT_BINDING');
          const view = knownImageSettlementQuote(
            { job: j, native, authorization: a, reservation: r, attempt: attempts[0], ...f },
            true,
          );
          receipts = [view.receipt];
        }
      }
      const pendingReceiptIds =
        source.kind === 'npc'
          ? [
              `failure:${j.id}`,
              `unknown:${j.id}`,
              `missing:${j.id}`,
              ...(['stale', 'failed', 'cancelled'].includes(j.status)
                ? [`finalize:${j.id}:${j.status}`]
                : []),
              ...receipts.map((receipt) => receipt.receiptId),
            ]
          : source.kind === 'authoring'
            ? [`authoring:${j.id}`, ...receipts.map((receipt) => receipt.receiptId)]
            : receipts.map((receipt) => receipt.receiptId);
      const result = financial(s, r, f, receipts, true, pendingReceiptIds);
      if (!result) return no(`${stage}_FINANCIAL_RECEIPT_UNPROVEN`);
      if (result === 'retained') {
        if (!options.allowRetainedFullyFundedPending)
          return no(`${stage}_KNOWN_FULLY_FUNDED_PENDING`);
        retainedFullyFunded.push({
          holdId: f.hold.id,
          reservationId: r.id,
          sourceKind: source.kind,
          sourceId: j.id,
        });
      }
      actual += cost;
      // Retained historical funds remain conservatively covered by the original
      // reserve in scope exposure. No cap or available-wallet calculation is relaxed.
      if (r.kind === 'image') image += result === 'retained' ? upper : cost;
      else text += result === 'retained' ? upper : cost;
      verifiedSources.push({
        kind: source.kind,
        id: j.id,
        authorizationId: a.id,
        reservationId: r.id,
        status: String(j.status ?? j.state),
        ...(providerJob ? { providerJobStatus: String(providerJob.status) } : {}),
      });
    }
    stage = 'RESERVATION';
    if (
      s.reservations.length !== sources.length ||
      s.reservations.some((r) => !sources.some((src) => src.reservationId === r.id))
    )
      return no('RESERVATION_SOURCE_UNSUPPORTED');
    stage = 'WALLET';
    if (
      s.sparkHolds.some(
        (h) => !terminal(h) && !retainedFullyFunded.some((x) => x.holdId === h.id),
      ) ||
      s.dreamHolds.some(
        (h) =>
          !terminal(h) &&
          !retainedFullyFunded.some((x) =>
            s.sparkHolds.some((sh) => sh.id === x.holdId && sh.dream_hold_id === h.id),
          ),
      )
    )
      return no('WALLET_ORPHAN_PENDING_HOLD');
    if (
      !walletsMatch(s.sparkWallets, s.sparkHolds, s.sparkLedger, true) ||
      !walletsMatch(s.dreamWallets, s.dreamHolds, s.dreamLedger, false)
    )
      return no('WALLET_LEDGER_TOTAL_MISMATCH');
    stage = 'SCOPE';
    const unlimited = s.scope.unlimited_allowance;
    if (unlimited === true) {
      if (
        s.scope.id !== `release:${owner}` ||
        [s.scope.total_cap_micros, s.scope.text_cap_micros, s.scope.image_cap_micros].some(
          (v) => v !== null,
        ) ||
        !s.authorizations.some(
          (a) =>
            a.mode === 'release' &&
            a.unlimited_allowance === true &&
            a.cap_micros === null &&
            a.text_cap_micros === null &&
            a.image_cap_micros === null,
        )
      )
        return no('SCOPE_UNLIMITED_SHAPE_INVALID');
    } else if (
      unlimited !== false ||
      text + image > integer(s.scope.total_cap_micros) ||
      text > integer(s.scope.text_cap_micros) ||
      image > integer(s.scope.image_cap_micros)
    )
      return no('SCOPE_CAP_EXCEEDED');
    const evidence = {
      version: 'terminal-liabilities-v1' as const,
      scopeId: String(s.scope.id),
      reservations: s.reservations.length,
      sources: sources.length,
      actualMicros: actual.toString(),
      coveredExposureMicros: (text + image).toString(),
      retainedFullyFunded,
      verifiedSources,
      retainedSourceIds: retainedFullyFunded.map((x) => ({ kind: x.sourceKind, id: x.sourceId })),
    };
    return {
      eligible: true,
      evidence: { ...evidence, fingerprint: digest({ evidence, snapshot: s }) },
    };
  } catch {
    return no(`${stage}_PROOF_UNAVAILABLE`);
  }
}

/** READ ONLY. Caller holds ALL target authorizations (ID order), scope and global
 * admission fence. Mutable source rows use SHARE NOWAIT, never wait behind native
 * job/provider -> authorization ordering. A 55P03 MUST abort the whole transaction;
 * caller may retry later. No foreign authorization/scope locks. Wallets use native
 * Sparks -> Dreams order, also NOWAIT. Admission fence prevents source phantoms.
 * Every read is bounded; overflow is an honest blocker, never a partial proof. */
export async function proveTerminalScopeLiabilities(
  c: PoolClient,
  scope: Row,
  authorizations: Row[],
  options: TerminalLiabilityOptions = {},
): Promise<TerminalLiabilityResult> {
  const owner = authorizations[0]?.owner_id;
  if (!owner || authorizations.some((a) => a.owner_id !== owner || a.scope_id !== scope.id))
    return { eligible: false, code: 'SCOPE_AUTHORIZATION_BINDING' };
  try {
    let loaded = 0;
    const rows = async (sql: string, params: unknown[] = []) => {
      const immutable = /FROM (spark_ledger|dream_ledger|audit|image_generation_recoveries)\b/.test(
        sql,
      );
      const base = sql.replace(/ FOR UPDATE$/, '');
      const lock = sql.endsWith(' FOR UPDATE')
        ? ' FOR UPDATE NOWAIT'
        : immutable
          ? ''
          : ' FOR SHARE NOWAIT';
      const result = (await c.query(`${base} LIMIT 501${lock}`, params)).rows;
      loaded += result.length;
      if (result.length > 500 || loaded > 4000) throw new Error('TERMINAL_PROOF_SIZE_LIMIT');
      return result;
    };
    const ids = authorizations.map((a) => a.id);
    const reservations = await rows(
      'SELECT * FROM generation_budget_reservations WHERE scope_id=$1 ORDER BY id',
      [scope.id],
    );
    const reservationIds = reservations.map((r) => r.id);
    const counts = await rows('SELECT * FROM generation_text_counts ORDER BY id');
    const permits = await rows(
      'SELECT * FROM live_test_text_permits WHERE session_id=ANY($1::uuid[]) OR reservation_id=ANY($2::uuid[]) ORDER BY id',
      [ids, reservationIds],
    );
    const npcJobs = await rows('SELECT * FROM npc_ai_jobs ORDER BY id');
    const authoringJobs = await rows(
      'SELECT * FROM live_authoring_text_jobs WHERE session_id=ANY($1::uuid[]) OR reservation_id=ANY($2::uuid[]) ORDER BY id',
      [ids, reservationIds],
    );
    const imageJobs = await rows(
      "SELECT * FROM image_generation_jobs WHERE reservation_id=ANY($1::uuid[]) OR input->>'generationAuthorizationId'=ANY($2::text[]) OR input->>'liveTestSessionId'=ANY($2::text[]) ORDER BY id",
      [reservationIds, ids],
    );
    // Lock current access rows as well as source receipts: erasure and revocation
    // do not necessarily participate in the generation admission fence.
    const users = await rows('SELECT * FROM users WHERE id=$1', [owner]);
    if (users.length !== 1 || users[0].deleted_at)
      return { eligible: false, code: 'SOURCE_OWNER_UNAVAILABLE' };
    const projectIds = [
      ...new Set(
        [
          ...authoringJobs.map((j) => j.project_id),
          ...imageJobs.map((j) => j.input?.authoringContext?.projectId),
        ].filter(Boolean),
      ),
    ];
    const projects = await rows(
      'SELECT * FROM visual_authoring_projects WHERE id=ANY($1::uuid[]) ORDER BY id',
      [projectIds],
    );
    if (
      projects.length !== projectIds.length ||
      projects.some((p) => p.owner_id !== owner || p.status === 'cancelled')
    )
      return { eligible: false, code: 'AUTHORING_SOURCE_ACCESS_REVOKED' };
    const campaignIds = [
      ...new Set(
        [
          ...npcJobs
            .filter((j) => ids.includes(j.generation_authorization_id))
            .map((j) => j.campaign_id),
          ...permits.map((p) => p.campaign_id),
          ...imageJobs.flatMap((j) => [
            j.input?.campaignContext?.campaignId,
            j.input?.travelContext?.campaignId,
          ]),
        ].filter(Boolean),
      ),
    ];
    const campaigns = await rows(
      'SELECT * FROM game_campaigns WHERE id=ANY($1::uuid[]) ORDER BY id',
      [campaignIds],
    );
    const members = await rows(
      'SELECT * FROM game_members WHERE campaign_id=ANY($1::uuid[]) AND user_id=$2 ORDER BY campaign_id',
      [campaignIds, owner],
    );
    if (
      campaigns.length !== campaignIds.length ||
      campaigns.some(
        (campaign) =>
          campaign.owner_id !== owner &&
          !members.some((m) => m.campaign_id === campaign.id && m.status === 'accepted'),
      )
    )
      return { eligible: false, code: 'NPC_MEMBERSHIP_REVOKED' };
    const versions = await rows(
      'SELECT * FROM game_playable_versions WHERE id=ANY($1::uuid[]) ORDER BY id',
      [campaigns.map((campaign) => campaign.source_version_id).filter(Boolean)],
    );
    const adventureIds = [
      ...new Set(
        [
          ...versions.map((v) => v.adventure_id),
          ...imageJobs.map((j) => j.adventure_id),
          ...projects.map((p) => p.adventure_id),
        ].filter(Boolean),
      ),
    ];
    const adventures = await rows('SELECT * FROM adventures WHERE id=ANY($1::uuid[]) ORDER BY id', [
      adventureIds,
    ]);
    if (
      adventures.length !== adventureIds.length ||
      adventures.some((a) => a.deleted_at || a.status === 'archived')
    )
      return { eligible: false, code: 'SOURCE_ADVENTURE_UNAVAILABLE' };
    const authors = await rows('SELECT * FROM users WHERE id=ANY($1::uuid[]) ORDER BY id', [
      [...new Set(adventures.map((a) => a.owner_id))],
    ]);
    if (
      authors.some((author) => author.deleted_at) ||
      adventures.some((a) => !authors.some((author) => author.id === a.owner_id))
    )
      return { eligible: false, code: 'SOURCE_AUTHOR_UNAVAILABLE' };
    await rows(
      'SELECT * FROM adventure_invitations WHERE adventure_id=ANY($1::uuid[]) AND recipient_id=$2 ORDER BY id',
      [adventureIds, owner],
    );
    await rows(
      'SELECT * FROM adventure_private_releases WHERE adventure_id=ANY($1::uuid[]) ORDER BY id',
      [adventureIds],
    );
    await rows(
      'SELECT * FROM game_playable_approvals WHERE playable_version_id=ANY($1::uuid[]) ORDER BY playable_version_id',
      [versions.map((v) => v.id)],
    );
    const accessible = await rows(
      `SELECT c.* FROM game_campaigns c WHERE c.id=ANY($1::uuid[]) AND ${sourceAccessSql('$2::uuid')} ORDER BY c.id`,
      [campaignIds, owner],
    );
    if (accessible.length !== campaigns.length)
      return { eligible: false, code: 'NPC_SOURCE_ACCESS_REVOKED' };
    if (
      projects.some(
        (p) =>
          p.adventure_id &&
          !adventures.some((a) => a.id === p.adventure_id && a.owner_id === owner),
      )
    )
      return { eligible: false, code: 'AUTHORING_SOURCE_ACCESS_REVOKED' };
    for (const j of imageJobs) {
      const input = j.input;
      if (input?.studioLocationContext) {
        const story = adventures.find((a) => a.id === j.adventure_id && a.owner_id === owner);
        const locations = story?.data?.content?.locations;
        if (
          !Array.isArray(locations) ||
          !locations.some((location: Row) => location.id === input.studioLocationContext.locationId)
        )
          return { eligible: false, code: 'IMAGE_STUDIO_SOURCE_ACCESS_REVOKED' };
      }
      if (
        !input?.campaignContext &&
        !input?.travelContext &&
        j.adventure_id &&
        !adventures.some((a) => a.id === j.adventure_id && a.owner_id === owner)
      )
        return { eligible: false, code: 'IMAGE_SOURCE_ACCESS_REVOKED' };
    }
    // Reference takedown/admission shares this owner fence. Use try-lock, not a
    // blocking inversion against image admission that may already own art-owner.
    if (
      imageJobs.some(
        (j) =>
          (j.input?.referenceRevisionIds?.length ?? 0) +
            (j.input?.privateReferenceAssetIds?.length ?? 0) >
          0,
      )
    ) {
      const lock = (
        await c.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked', [
          `art-owner:${owner}`,
        ])
      ).rows[0];
      if (lock?.locked !== true) return { eligible: false, code: 'IMAGE_REFERENCE_PROOF_BUSY' };
      for (const j of imageJobs) {
        const referenceIds = j.input?.referenceRevisionIds ?? [],
          privateIds = j.input?.privateReferenceAssetIds ?? [];
        const refs = await rows(
          'SELECT r.* FROM art_asset_revisions r WHERE r.id=ANY($1::uuid[]) ORDER BY r.id',
          [referenceIds],
        );
        const families = await rows(
          'SELECT * FROM art_asset_families WHERE id=ANY($1::uuid[]) ORDER BY id',
          [refs.map((r) => r.family_id)],
        );
        const assets = await rows('SELECT * FROM assets WHERE id=ANY($1::uuid[]) ORDER BY id', [
          [...privateIds, ...refs.map((r) => r.upload_id).filter(Boolean)],
        ]);
        const takedowns = await rows(
          'SELECT * FROM art_asset_takedowns WHERE revision_id=ANY($1::uuid[]) ORDER BY revision_id',
          [referenceIds],
        );
        if (
          refs.length !== referenceIds.length ||
          takedowns.length ||
          families.some((f) => f.owner_id !== owner || f.archived_at) ||
          refs.some(
            (r) =>
              !families.some((f) => f.id === r.family_id) ||
              !assets.some((a) => a.id === r.upload_id),
          ) ||
          privateIds.some(
            (id: string) => !assets.some((a) => a.id === id && a.owner_id === owner),
          ) ||
          refs.some((r) => j.reference_hashes?.[r.id] !== r.sha256) ||
          privateIds.some(
            (id: string) => j.reference_hashes?.[id] !== assets.find((a) => a.id === id)?.sha256,
          )
        )
          return { eligible: false, code: 'IMAGE_REFERENCE_ACCESS_REVOKED' };
      }
    }
    const npcQuotes = await rows(
      'SELECT * FROM npc_ai_quotes WHERE id=ANY($1::uuid[]) ORDER BY id',
      [
        npcJobs
          .filter((j) => ids.includes(j.generation_authorization_id))
          .map((j) => j.quote_id)
          .filter(Boolean),
      ],
    );
    const authoringQuotes = await rows(
      'SELECT * FROM live_authoring_text_quotes WHERE id=ANY($1::uuid[]) ORDER BY id',
      [authoringJobs.map((j) => j.quote_id)],
    );
    const imageQuotes = await rows(
      'SELECT * FROM image_generation_quotes WHERE id=ANY($1::uuid[]) ORDER BY id',
      [imageJobs.map((j) => j.quote_id)],
    );
    const imageAttempts = await rows(
      'SELECT * FROM image_generation_attempts WHERE job_id=ANY($1::uuid[]) ORDER BY job_id',
      [imageJobs.map((j) => j.id)],
    );
    const recoveries = await rows(
      'SELECT * FROM image_generation_recoveries WHERE scope_id=$1 ORDER BY id',
      [scope.id],
    );
    const requests = await rows(
      'SELECT * FROM game_npc_decision_requests WHERE id=ANY($1::uuid[]) ORDER BY id',
      [
        [
          ...permits.map((p) => p.request_id),
          ...npcJobs
            .filter((j) => ids.includes(j.generation_authorization_id))
            .map((j) => j.request_meta?.runtimeRequestId)
            .filter(Boolean),
        ],
      ],
    );
    const batches = await rows(
      'SELECT * FROM game_world_generation_batches WHERE owner_id=$1 AND accepted_at IS NOT NULL ORDER BY id',
      [owner],
    );
    const audits = await rows(
      "SELECT * FROM audit WHERE actor_id=$1 AND action IN ('npc.known_failure.settled','authoring.known_failure.settled') ORDER BY id",
      [owner],
    );
    const providerBudgets = await rows(
      'SELECT * FROM npc_ai_provider_budgets ORDER BY provider_id',
    );
    const sparkWallets = await rows('SELECT * FROM spark_wallets WHERE owner_id=$1 FOR UPDATE', [
      owner,
    ]);
    const sparkHolds = await rows('SELECT * FROM spark_holds WHERE owner_id=$1 ORDER BY id', [
      owner,
    ]);
    const sparkQuotes = await rows('SELECT * FROM spark_quotes WHERE owner_id=$1 ORDER BY id', [
      owner,
    ]);
    const sparkLedger = await rows('SELECT * FROM spark_ledger WHERE owner_id=$1 ORDER BY id', [
      owner,
    ]);
    const dreamWallets = await rows('SELECT * FROM dream_wallets WHERE owner_id=$1 FOR UPDATE', [
      owner,
    ]);
    const dreamHolds = await rows('SELECT * FROM dream_holds WHERE owner_id=$1 ORDER BY id', [
      owner,
    ]);
    const dreamQuotes = await rows('SELECT * FROM dream_quotes WHERE owner_id=$1 ORDER BY id', [
      owner,
    ]);
    const dreamLedger = await rows('SELECT * FROM dream_ledger WHERE owner_id=$1 ORDER BY id', [
      owner,
    ]);
    return proveTerminalLiabilitySnapshot(
      {
        scope,
        authorizations,
        reservations,
        counts,
        permits,
        npcJobs,
        npcQuotes,
        authoringJobs,
        authoringQuotes,
        imageJobs,
        imageQuotes,
        imageAttempts,
        recoveries,
        requests,
        batches,
        audits,
        providerBudgets,
        sparkWallets,
        sparkHolds,
        sparkQuotes,
        sparkLedger,
        dreamWallets,
        dreamHolds,
        dreamQuotes,
        dreamLedger,
      },
      options,
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'TERMINAL_PROOF_SIZE_LIMIT')
      return { eligible: false, code: 'PROOF_SIZE_LIMIT' };
    throw error;
  }
}
