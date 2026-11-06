/** Pure synthetic proof tests. No database, transport or production identifiers. */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  knownAuthoringSettlementQuote,
} = require('../../apps/api/dist/live-test/known-authoring-settlement');
const { digest } = require('../../apps/api/dist/ai/context');
const { sparkTariff } = require('../../apps/api/dist/generation/sparks-hooks');
const { planSparkSettlement } = require('../../apps/api/dist/generation/sparks-accounting');
const { planDreamSettlement } = require('../../apps/api/dist/generation/dreams-accounting');
function fixture() {
  const owner = randomUUID(),
    jobId = randomUUID(),
    nativeId = randomUUID(),
    holdId = randomUUID(),
    sessionId = randomUUID();
  const snapshot = {
    model: 'synthetic-authoring',
    reserveMicros: 3000,
    inputMicrosPerMillion: 100000,
    outputMicrosPerMillion: 500000,
    cachePricing: {
      cachedInputMicrosPerMillion: 10000,
      cacheWrite30mMicrosPerMillion: 125000,
      cacheWrite12hMicrosPerMillion: 250000,
    },
  };
  const usage = {
    inputTokens: 6405,
    cachedInputTokens: 1383,
    outputTokens: 201,
    cacheWriteInputTokens: 5019,
    cacheWriteInputTokensDetails: { ttl30mTokens: 5019, ttl12hTokens: 0 },
    costMicros: 743,
    costEvidence: 'configured_rates',
    costVerifiedForSparks: true,
  };
  const job = {
    id: jobId,
    actor_id: owner,
    quote_id: nativeId,
    operation_id: randomUUID(),
    session_id: sessionId,
    project_id: randomUUID(),
    project_revision: 1,
    source_hash: digest('source'),
    readset_hash: digest('readset'),
    context_hash: digest('private'),
    provider_version: 'fixture-v1',
    generation_policy_revision: 1,
    generation_policy_hash: digest('policy'),
    reservation_id: randomUUID(),
    spark_quote_id: holdId,
    status: 'stale',
    error_code: 'MAP_IMAGE_UNCERTAIN',
    actual_micros: '743',
    provider_usage: usage,
    spark_cost_evidence: 'configured_rates',
    dispatched_at: new Date(),
    completed_at: new Date(),
    request_snapshot: snapshot,
  };
  job.request_hash = digest({
    quoteId: nativeId,
    operationId: job.operation_id,
    consent: true,
    automaticKnownCostPolicy: 'known-cost-v1',
  });
  const native = {
    ...structuredClone(job),
    id: nativeId,
    request_hash: digest('native-request'),
    upper_micros: '3000',
  };
  const authorization = {
    id: sessionId,
    owner_id: owner,
    mode: 'release',
    scope_id: `release:${owner}`,
  };
  const reservation = {
    id: job.reservation_id,
    actor_id: owner,
    scope_id: authorization.scope_id,
    kind: 'text',
    operation_key: `manual-authoring-text:${jobId}`,
    status: 'settled',
    upper_micros: '3000',
    actual_micros: '743',
    spark_quote_id: holdId,
  };
  const hold = {
    id: holdId,
    owner_id: owner,
    source_kind: 'text',
    source_id: nativeId,
    reserved_subunits: '6000',
    sparks_reserved_subunits: '6000',
    captured_subunits: null,
    settlement_fingerprint: null,
    dream_hold_id: null,
    status: 'pending',
    reason: 'failure_policy_pending',
  };
  const quote = {
    id: holdId,
    owner_id: owner,
    source_kind: 'text',
    source_id: nativeId,
    operation_id: nativeId,
    reserve_subunits: '6000',
    price_snapshot: {
      tariff: structuredClone(sparkTariff(snapshot, 'openai', job.provider_version)),
      providerQuote: {
        automaticKnownCostPolicy: 'known-cost-v1',
        quoteId: nativeId,
        providerVersion: job.provider_version,
        requestHash: native.request_hash,
        profile: snapshot,
        requestSnapshot: structuredClone(snapshot),
      },
    },
  };
  return { job, native, authorization, reservation, hold, quote };
}
function addDreams(f) {
  f.hold.sparks_reserved_subunits = '5000';
  f.hold.dream_hold_id = randomUUID();
  f.quote.price_snapshot.fundingPolicy = 'dreams-first-v1';
  f.dreams = {
    hold: {
      ...structuredClone(f.hold),
      id: f.hold.dream_hold_id,
      reserved_subunits: '1000',
      reason: 'unknown',
    },
    quote: {
      ...structuredClone(f.quote),
      id: f.hold.dream_hold_id,
      operation_id: f.hold.id,
      reserve_subunits: '1000',
      price_snapshot: {
        currency: 'dreams',
        policyVersion: 'dreams-first-v1',
        providerQuote: {
          sparkQuoteId: f.hold.id,
          priceSnapshot: structuredClone(f.quote.price_snapshot),
        },
      },
    },
  };
  return f;
}
const review = (f, previous) =>
  knownAuthoringSettlementQuote(
    f.job,
    f.native,
    f.authorization,
    f.reservation,
    f.hold,
    f.quote,
    previous,
    f.dreams,
  );
const rejected = (e) => e.getResponse?.().code === 'AUTHORING_SETTLEMENT_UNAVAILABLE';
test('exact authoring provenance recomputes cache-aware cost and funding without mutation', () => {
  const f = fixture(),
    before = structuredClone(f),
    q = review(f);
  assert.equal(q.captureSubunits, '1486');
  assert.equal(q.releaseSubunits, '4514');
  assert.equal(q.actualMicros, '743');
  assert.equal(q.requiresConsent, true);
  assert.equal(q.settlementMode, 'automatic');
  assert.equal(q.noAuthoringEffect, true);
  assert.deepEqual(f, before);
  addDreams(f);
  assert.deepEqual(review(f).funding, {
    dreamsCaptureSubunits: '1000',
    dreamsReleaseSubunits: '0',
    sparksCaptureSubunits: '486',
    sparksReleaseSubunits: '4514',
  });
});
for (const [name, mutate] of Object.entries({
  unknown: (f) => (f.job.status = 'unknown'),
  queued: (f) => (f.job.status = 'queued'),
  dispatched: (f) => (f.job.status = 'dispatched'),
  generated: (f) => (f.job.status = 'generated'),
  committed: (f) => (f.job.status = 'committed'),
  cancelled: (f) => (f.job.status = 'cancelled'),
  undispatched: (f) => (f.job.dispatched_at = null),
  incomplete: (f) => (f.job.completed_at = null),
  erased: (f) => (f.job.context_hash = 'erased'),
  reported: (f) => (f.job.spark_cost_evidence = 'reported'),
  unknownUsage: (f) => (f.job.provider_usage = null),
  unverified: (f) => (f.job.provider_usage.costVerifiedForSparks = false),
  costMismatch: (f) => (f.job.actual_micros = '744'),
  usageMismatch: (f) => (f.job.provider_usage.costMicros = 744),
  cacheMismatch: (f) => (f.job.provider_usage.cacheWriteInputTokensDetails.ttl12hTokens = 1),
  foreignNative: (f) => (f.native.actor_id = randomUUID()),
  foreignHold: (f) => (f.hold.owner_id = randomUUID()),
  foreignQuote: (f) => (f.quote.owner_id = randomUUID()),
  foreignSession: (f) => (f.authorization.owner_id = randomUUID()),
  foreignScope: (f) => (f.reservation.scope_id = `release:${randomUUID()}`),
  foreignReservation: (f) => (f.reservation.actor_id = randomUUID()),
  wrongKind: (f) => (f.reservation.kind = 'image'),
  wrongOperation: (f) => (f.reservation.operation_key = randomUUID()),
  wrongHold: (f) => (f.reservation.spark_quote_id = randomUUID()),
  pendingSpend: (f) => (f.reservation.status = 'held'),
  reservationCost: (f) => (f.reservation.actual_micros = '744'),
  nativeHold: (f) => (f.native.spark_quote_id = randomUUID()),
  nativeSnapshot: (f) => (f.native.request_snapshot.model = 'other'),
  missingAdmittedSnapshot: (f) => delete f.quote.price_snapshot.providerQuote.requestSnapshot,
  missingJobSnapshot: (f) => (f.job.request_snapshot = null),
  missingNativeSnapshot: (f) => (f.native.request_snapshot = null),
  admittedSnapshot: (f) => (f.quote.price_snapshot.providerQuote.requestSnapshot.model = 'other'),
  nativeRequest: (f) => (f.native.request_hash = digest('other')),
  consentBinding: (f) => (f.job.request_hash = digest('other')),
  quoteKind: (f) => (f.quote.source_kind = 'npc'),
  quoteSource: (f) => (f.quote.source_id = randomUUID()),
  held: (f) => (f.hold.status = 'held'),
  unknownHold: (f) => (f.hold.reason = 'unknown'),
  unsupportedRate: (f) => (f.quote.price_snapshot.tariff.sparkRateVersion = 'future'),
  wrongTariff: (f) => (f.quote.price_snapshot.tariff.inputMicrosPerMillion = '2'),
  reserveMismatch: (f) => (f.hold.reserved_subunits = '6001'),
  reserveExceeded: (f) => {
    f.job.request_snapshot.reserveMicros =
      f.native.request_snapshot.reserveMicros =
      f.quote.price_snapshot.providerQuote.requestSnapshot.reserveMicros =
        700;
    f.native.upper_micros = f.reservation.upper_micros = '700';
    f.quote.reserve_subunits = f.hold.reserved_subunits = f.hold.sparks_reserved_subunits = '1400';
  },
  brokenFunding: (f) => (f.hold.sparks_reserved_subunits = '5000'),
  capturedPending: (f) => (f.hold.captured_subunits = '0'),
}))
  test(`rejects ${name} without changes`, () => {
    const f = fixture();
    mutate(f);
    const before = structuredClone(f);
    assert.throws(() => review(f), rejected);
    assert.deepEqual(f, before);
  });
test('terminal replay requires the original audited receipt and identical financial fingerprint', () => {
  const f = fixture(),
    q = review(f),
    operationId = randomUUID();
  const settlement = {
    outcome: 'success',
    actualMicros: q.actualMicros,
    evidence: 'configured_rates',
    receiptId: `owner-authoring-settlement:${operationId}`,
  };
  const plan = planSparkSettlement(
    { ...f.hold, spark_rate_version: q.rateVersion },
    settlement,
    true,
  );
  f.hold = {
    ...f.hold,
    status: 'settled',
    captured_subunits: q.captureSubunits,
    reason: null,
    settlement_fingerprint: plan.fingerprint,
  };
  const previous = {
    details: {
      operationId,
      holdId: q.holdId,
      actualMicros: q.actualMicros,
      captureSubunits: q.captureSubunits,
      releaseSubunits: q.releaseSubunits,
    },
  };
  assert.throws(() => review(f), rejected);
  assert.equal(review(f, previous).requiresConsent, false);
  previous.details.operationId = randomUUID();
  assert.throws(() => review(f, previous), rejected);
});

for (const [name, mutate] of Object.entries({
  missing: (f) => (f.dreams = undefined),
  wrongSource: (f) => (f.dreams.hold.source_id = randomUUID()),
  wrongOperation: (f) => (f.dreams.quote.operation_id = randomUUID()),
  wrongReason: (f) => (f.dreams.hold.reason = 'reserve_exceeded'),
  wrongQuoteSource: (f) => (f.dreams.quote.source_id = randomUUID()),
  smallerReserve: (f) => (f.dreams.hold.reserved_subunits = '999'),
  largerReserve: (f) => (f.dreams.hold.reserved_subunits = '1001'),
  wrongQuoteReserve: (f) => (f.dreams.quote.reserve_subunits = '999'),
  wrongPolicy: (f) => (f.dreams.quote.price_snapshot.policyVersion = 'other'),
  wrongFundingPolicy: (f) => (f.quote.price_snapshot.fundingPolicy = 'other'),
  wrongBinding: (f) => (f.dreams.quote.price_snapshot.providerQuote.sparkQuoteId = randomUUID()),
  wrongSnapshot: (f) => (f.dreams.quote.price_snapshot.providerQuote.priceSnapshot = {}),
  foreignOwner: (f) => (f.dreams.hold.owner_id = randomUUID()),
  foreignQuote: (f) => (f.dreams.quote.owner_id = randomUUID()),
  held: (f) => (f.dreams.hold.status = 'held'),
  terminal: (f) => (f.dreams.hold.status = 'settled'),
  captured: (f) => (f.dreams.hold.captured_subunits = '1'),
}))
  test(`rejects malformed Dreams backing: ${name}`, () => {
    const f = addDreams(fixture());
    mutate(f);
    const before = structuredClone(f);
    assert.throws(() => review(f), rejected);
    assert.deepEqual(f, before);
  });
test('mixed terminal replay proves both original settlement fingerprints and exact captures', () => {
  const f = addDreams(fixture()),
    q = review(f),
    operationId = randomUUID();
  const s = {
    outcome: 'success',
    actualMicros: q.actualMicros,
    evidence: 'configured_rates',
    receiptId: `owner-authoring-settlement:${operationId}`,
  };
  const spark = planSparkSettlement({ ...f.hold, spark_rate_version: q.rateVersion }, s, true);
  const dream = planDreamSettlement(
    { ...f.dreams.hold, policy_version: 'dreams-first-v1' },
    {
      outcome: 'success',
      actualSubunits: q.funding.dreamsCaptureSubunits,
      policyVersion: 'dreams-first-v1',
      evidence: 'configured_rates',
      receiptId: s.receiptId,
    },
    true,
  );
  Object.assign(f.hold, {
    status: 'settled',
    reason: null,
    captured_subunits: q.captureSubunits,
    settlement_fingerprint: spark.fingerprint,
  });
  Object.assign(f.dreams.hold, {
    status: 'settled',
    reason: null,
    captured_subunits: q.funding.dreamsCaptureSubunits,
    settlement_fingerprint: dream.fingerprint,
  });
  const previous = {
    details: {
      operationId,
      holdId: q.holdId,
      actualMicros: q.actualMicros,
      captureSubunits: q.captureSubunits,
      releaseSubunits: q.releaseSubunits,
    },
  };
  assert.equal(review(f, previous).requiresConsent, false);
  f.dreams.hold.settlement_fingerprint = digest('another receipt');
  assert.throws(() => review(f, previous), rejected);
});

test('zero known cost releases and an admitted legacy conversion is retained', () => {
  const zero = fixture();
  Object.assign(zero.job.provider_usage, {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    cacheWriteInputTokens: 0,
    cacheWriteInputTokensDetails: { ttl30mTokens: 0, ttl12hTokens: 0 },
    costMicros: 0,
  });
  zero.job.actual_micros = zero.reservation.actual_micros = '0';
  assert.equal(review(zero).captureSubunits, '0');
  assert.equal(review(zero).releaseSubunits, '6000');
  const old = fixture();
  old.quote.price_snapshot.tariff.sparkRateVersion = 'api-cent-1-spark-v1';
  old.quote.reserve_subunits =
    old.hold.reserved_subunits =
    old.hold.sparks_reserved_subunits =
      '3000';
  assert.equal(review(old).captureSubunits, '743');
  assert.equal(review(old).releaseSubunits, '2257');
});

const {
  KnownAuthoringSettlement,
} = require('../../apps/api/dist/live-test/known-authoring-settlement');
const { SparksAccounting } = require('../../apps/api/dist/generation/sparks-accounting');
const automaticReview = (f, previous) =>
  knownAuthoringSettlementQuote(
    f.job,
    f.native,
    f.authorization,
    f.reservation,
    f.hold,
    f.quote,
    previous,
    f.dreams,
    true,
  );
test('historical and old-client consent never authorizes automatic capture', async () => {
  for (const policy of [undefined, 'other-policy', 'known-cost-v1']) {
    const f = fixture();
    f.quote.price_snapshot.providerQuote.automaticKnownCostPolicy = policy;
    f.job.request_hash = digest({
      quoteId: f.native.id,
      operationId: f.job.operation_id,
      consent: true,
    });
    assert.throws(() => automaticReview(f), rejected);
    if (policy === 'other-policy') assert.throws(() => review(f), rejected);
    else {
      assert.equal(review(f).requiresConsent, true);
      assert.equal(review(f).settlementMode, 'legacy_confirmation');
    }
  }
  const { f, c, service } = serviceFixture();
  delete f.quote.price_snapshot.providerQuote.automaticKnownCostPolicy;
  assert.equal(await service.settleAutomatic(c, f.job.actor_id, f.job.id), undefined);
  assert.deepEqual(f.writes, []);
});
test('automatic proof closes semantic failure, cancellation and a verified late receipt, never unknown usage', () => {
  for (const status of ['failed', 'stale', 'cancelled']) {
    const f = addDreams(fixture());
    f.job.status = status;
    f.hold.reason = 'unknown';
    assert.equal(automaticReview(f).captureSubunits, '1486');
    assert.equal(automaticReview(f).settlementMode, 'automatic');
    f.job.provider_usage = null;
    assert.throws(() => automaticReview(f), rejected);
  }
  for (const mutate of [
    (f) => (f.job.status = 'unknown'),
    (f) => (f.job.provider_usage.costVerifiedForSparks = false),
    (f) => (f.job.request_hash = digest('different consent')),
    (f) => (f.reservation.operation_key = 'different job'),
    (f) => (f.hold.reason = 'reserve_exceeded'),
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => automaticReview(f), rejected);
  }
});
function serviceFixture() {
  const f = fixture();
  f.audits = [];
  f.writes = [];
  const c = {
    query: async (sql, values = []) => {
      if (sql.startsWith('SELECT session_id FROM live_authoring_text_jobs'))
        return { rows: [{ session_id: f.job.session_id }] };
      if (sql.startsWith('SELECT * FROM live_authoring_text_jobs')) return { rows: [f.job] };
      if (sql.startsWith('SELECT * FROM live_authoring_text_quotes')) return { rows: [f.native] };
      if (sql.startsWith('SELECT * FROM generation_budget_reservations'))
        return { rows: [f.reservation] };
      if (sql.startsWith('SELECT * FROM spark_holds')) return { rows: [f.hold] };
      if (sql.startsWith('SELECT * FROM spark_quotes')) return { rows: [f.quote] };
      if (sql.startsWith('SELECT details FROM audit')) return { rows: f.audits };
      if (sql.startsWith('INSERT INTO audit')) {
        f.audits.push({ details: JSON.parse(values[3]) });
        f.writes.push(sql);
        return { rows: [] };
      }
      if (
        sql.includes('pg_advisory_xact_lock') ||
        sql.startsWith('SELECT owner_id FROM spark_wallets')
      )
        return { rows: [] };
      throw new Error(`Unexpected fixture query: ${sql}`);
    },
  };
  const db = { tx: async (work) => work(c) };
  const authority = { lockAuthorization: async () => f.authorization };
  return { f, c, service: new KnownAuthoringSettlement(db, authority) };
}
test('automatic mutation uses original operation receipt once; restart replay is duplicate and invalid proof is no-op', async () => {
  const { f, c, service } = serviceFixture();
  const original = SparksAccounting.prototype.settle;
  let captures = 0;
  SparksAccounting.prototype.settle = async (_c, actor, holdId, settlement, reconcile) => {
    assert.equal(actor, f.job.actor_id);
    assert.equal(holdId, f.hold.id);
    assert.equal(settlement.receiptId, `owner-authoring-settlement:${f.job.operation_id}`);
    assert.equal(reconcile, true);
    const plan = planSparkSettlement(
      { ...f.hold, spark_rate_version: automaticReview(f, f.audits[0]).rateVersion },
      settlement,
      true,
    );
    if (!plan.duplicate) {
      captures++;
      f.hold = {
        ...f.hold,
        status: 'settled',
        reason: null,
        captured_subunits: '1486',
        settlement_fingerprint: plan.fingerprint,
      };
    }
    return f.hold;
  };
  try {
    assert.equal(
      (await service.settleAutomatic(c, f.job.actor_id, f.job.id)).requiresConsent,
      false,
    );
    assert.equal(
      (await service.settleAutomatic(c, f.job.actor_id, f.job.id)).requiresConsent,
      false,
    );
    assert.equal(captures, 1);
    assert.equal(f.audits.length, 1);
    f.job.provider_usage = null;
    assert.equal(await service.settleAutomatic(c, f.job.actor_id, f.job.id), undefined);
    assert.equal(captures, 1);
  } finally {
    SparksAccounting.prototype.settle = original;
  }
});
test('recovery is bounded, advances past rejected rows, resets cursor and never dispatches', async () => {
  const service = new KnownAuthoringSettlement({}, {});
  const ids = Array.from({ length: 25 }, () => randomUUID()).sort();
  const cursors = [],
    recovered = [];
  service.db = {
    query: async (sql, values) => {
      assert.match(sql, /h.status='pending'/);
      assert.match(sql, /automaticKnownCostPolicy'='known-cost-v1'/);
      assert.match(sql, /ORDER BY j.id LIMIT 25/);
      cursors.push(values[0]);
      return values[0] ? [] : ids.map((id) => ({ id, actor_id: 'actor' }));
    },
    tx: async (work) => work({}),
  };
  service.settleAutomatic = async (_c, actor, id) => {
    assert.equal(actor, 'actor');
    recovered.push(id);
  };
  await service.recoverPending();
  await service.recoverPending();
  await service.recoverPending();
  assert.deepEqual(cursors, [null, ids[24], null]);
  assert.equal(recovered.length, 50);
});

test('manual POST cannot mutate an automatic pending quote or unsupported policy', async () => {
  for (const policy of ['known-cost-v1', 'future-policy']) {
    const { f, service } = serviceFixture();
    f.quote.price_snapshot.providerQuote.automaticKnownCostPolicy = policy;
    if (policy === 'future-policy')
      f.job.request_hash = digest({
        quoteId: f.native.id,
        operationId: f.job.operation_id,
        consent: true,
      });
    await assert.rejects(
      service.handle(f.job.actor_id, f.job.id, {
        operationId: randomUUID(),
        holdId: f.hold.id,
        expectedActualMicros: '743',
        expectedReservedSubunits: '6000',
        expectedCaptureSubunits: '1486',
        consent: true,
      }),
      rejected,
    );
    assert.deepEqual(f.writes, []);
    assert.deepEqual(f.audits, []);
  }
});
