process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { digest } = require('../../apps/api/dist/ai/context');
const {
  knownCountSettlement,
  knownPermitSettlement,
  settleKnownCount,
} = require('../../apps/api/dist/generation/known-text-settlement');
function countFixture() {
  const owner = randomUUID(),
    id = randomUUID(),
    holdId = randomUUID(),
    authId = randomUUID(),
    reservationId = randomUUID();
  const authorization = {
    id: authId,
    owner_id: owner,
    scope_id: `release:${owner}`,
    mode: 'release',
  };
  const job = {
    id,
    authorization_id: authId,
    scope_id: authorization.scope_id,
    actor_id: owner,
    reservation_id: reservationId,
    operation_id: randomUUID(),
    spark_quote_id: holdId,
    status: 'stale',
    input_tokens: 42,
    actual_micros: '1000',
    completed_at: new Date(),
    pricing_snapshot: { microsPerRequest: 1000, version: 'fixed-v1' },
    model: 'fixture',
    provider_version: 'fixture-v1',
    request_hash: 'request-hash',
    source_hash: 'source-hash',
    body_sha256: 'body-hash',
    policy_revision: 3,
    policy_hash: 'policy-hash',
  };
  const reservation = {
    id: reservationId,
    actor_id: owner,
    scope_id: authorization.scope_id,
    kind: 'text',
    operation_key: `text-count:${job.operation_id}`,
    status: 'settled',
    upper_micros: '1000',
    actual_micros: '1000',
    spark_quote_id: holdId,
  };
  const hold = {
    id: holdId,
    owner_id: owner,
    source_kind: 'text',
    source_id: `count:${id}`,
    reserved_subunits: '2000',
    sparks_reserved_subunits: '2000',
    status: 'pending',
    reason: 'failure_policy_pending',
    captured_subunits: null,
    settlement_fingerprint: null,
    dream_hold_id: null,
  };
  const quote = {
    id: holdId,
    owner_id: owner,
    source_kind: 'text',
    source_id: hold.source_id,
    operation_id: id,
    reserve_subunits: '2000',
    price_snapshot: {
      tariff: {
        sparkRateVersion: 'api-cent-2-sparks-v2',
        provider: 'openai',
        providerRateVersion: 'fixture-v1',
        model: 'fixture',
      },
      providerQuote: {
        automaticKnownCostPolicy: 'known-cost-v1',
        automaticKnownCostAcceptance: { policy: 'known-cost-v1', requestHash: job.request_hash },
        countId: id,
        model: job.model,
        providerVersion: job.provider_version,
        pricing: structuredClone(job.pricing_snapshot),
        policy: { revision: 3, hash: job.policy_hash },
        requestHash: job.request_hash,
      },
    },
  };
  const f = { job, authorization, reservation, funding: { hold, quote } };
  f.proof = () => knownCountSettlement(job, authorization, reservation, f.funding);
  return f;
}
function split(f) {
  const { hold, quote } = f.funding;
  hold.dream_hold_id = randomUUID();
  hold.sparks_reserved_subunits = '1000';
  quote.price_snapshot.fundingPolicy = 'dreams-first-v1';
  f.funding.dreams = {
    hold: {
      id: hold.dream_hold_id,
      owner_id: hold.owner_id,
      source_kind: 'text',
      source_id: hold.source_id,
      reserved_subunits: '1000',
      status: hold.status,
      reason: 'unknown',
      captured_subunits: null,
      settlement_fingerprint: null,
    },
    quote: {
      id: hold.dream_hold_id,
      owner_id: hold.owner_id,
      source_kind: 'text',
      source_id: hold.source_id,
      operation_id: hold.id,
      reserve_subunits: '1000',
      price_snapshot: {
        currency: 'dreams',
        policyVersion: 'dreams-first-v1',
        providerQuote: {
          sparkQuoteId: hold.id,
          priceSnapshot: structuredClone(quote.price_snapshot),
        },
      },
    },
  };
}
test('fixed-price stale and late counts settle exact admitted price without adopting tokens', () => {
  for (const status of ['stale', 'unknown', 'over_context', 'succeeded']) {
    const f = countFixture();
    f.job.status = status;
    assert.deepEqual(f.proof(), {
      outcome: 'success',
      actualMicros: '1000',
      evidence: 'configured_rates',
      receiptId: `count:${f.job.id}`,
    });
    split(f);
    assert.ok(f.proof());
  }
});
for (const [name, change] of [
  [
    'historical unmarked consent',
    (f) => delete f.funding.quote.price_snapshot.providerQuote.automaticKnownCostPolicy,
  ],
  [
    'new marked quote without policy acceptance',
    (f) => delete f.funding.quote.price_snapshot.providerQuote.automaticKnownCostAcceptance,
  ],
  [
    'different accepted request hash',
    (f) =>
      (f.funding.quote.price_snapshot.providerQuote.automaticKnownCostAcceptance.requestHash =
        'other'),
  ],
  ['missing receipt', (f) => (f.job.input_tokens = null)],
  ['unknown actual', (f) => (f.job.actual_micros = null)],
  ['foreign authorization', (f) => (f.authorization.owner_id = randomUUID())],
  ['unsettled provider liability', (f) => (f.reservation.status = 'unknown')],
  ['changed fixed price', (f) => (f.job.pricing_snapshot.microsPerRequest = 2000)],
  ['changed request', (f) => (f.job.request_hash = 'other')],
  ['changed policy', (f) => (f.job.policy_hash = 'other')],
  ['foreign reservation', (f) => (f.reservation.operation_key = 'other')],
  ['wrong reserve', (f) => (f.funding.hold.reserved_subunits = '1')],
  ['terminal old receipt', (f) => (f.funding.hold.status = 'settled')],
  ['partial prior capture', (f) => (f.funding.hold.captured_subunits = '1')],
  [
    'broken Dreams linkage',
    (f) => {
      split(f);
      f.funding.dreams.quote.operation_id = randomUUID();
    },
  ],
])
  test(`fixed count proof rejects ${name}`, () => {
    const f = countFixture();
    change(f);
    assert.equal(f.proof(), undefined);
  });
function permitFixture() {
  const f = countFixture(),
    { authorization: a, reservation: r, funding } = f;
  const requestId = randomUUID(),
    jobId = randomUUID();
  const context = { contextHash: 'fixture', turnFence: { roundId: 'one', phaseEpoch: 1 } };
  const snapshot = {
    model: 'fixture',
    reserveMicros: 1000,
    inputMicrosPerMillion: 1000000,
    outputMicrosPerMillion: 1000000,
  };
  const p = {
    id: randomUUID(),
    operation_id: randomUUID(),
    session_id: a.id,
    request_id: requestId,
    campaign_id: randomUUID(),
    reservation_id: r.id,
    spark_quote_id: funding.hold.id,
    state: 'settled',
    job_id: jobId,
    dispatched_at: new Date(),
    completed_at: new Date(),
    context_hash: digest(context),
    request_snapshot: snapshot,
    generation_policy_revision: 3,
    generation_policy_hash: 'policy-hash',
  };
  const j = {
    id: jobId,
    campaign_id: p.campaign_id,
    npc_id: 'keeper',
    purpose: 'plan',
    status: 'failed',
    generation_authorization_id: a.id,
    payer_user_id: a.owner_id,
    requester_user_id: a.owner_id,
    credits: 0,
    provider_external: true,
    provider_budget_status: 'spent',
    provider_cost_evidence: 'configured_rates',
    provider_actual_micros: '500',
    provider_upper_micros: '1000',
    input_tokens: 400,
    output_tokens: 100,
    request_meta: { runtimeRequestId: requestId },
    context,
    request_snapshot: structuredClone(snapshot),
    provider_usage: {
      inputTokens: 400,
      outputTokens: 100,
      costMicros: 500,
      costEvidence: 'configured_rates',
      costVerifiedForSparks: true,
    },
  };
  const request = {
    id: requestId,
    job_id: jobId,
    campaign_id: p.campaign_id,
    requester_user_id: a.owner_id,
    npc_id: j.npc_id,
    purpose: j.purpose,
    context,
  };
  r.operation_key = `manual-text:${requestId}`;
  r.actual_micros = '500';
  funding.hold.source_id = requestId;
  funding.quote.source_id = requestId;
  funding.quote.operation_id = p.id;
  Object.assign(funding.quote.price_snapshot.tariff, {
    providerRateVersion: p.generation_policy_hash,
    inputMicrosPerMillion: '1000000',
    outputMicrosPerMillion: '1000000',
    cachedInputMicrosPerMillion: '1000000',
  });
  funding.quote.price_snapshot.providerQuote = {
    automaticKnownCostPolicy: 'known-cost-v1',
    automaticKnownCostAcceptance: {
      policy: 'known-cost-v1',
      operationId: p.operation_id,
      requestId: p.request_id,
      campaignId: p.campaign_id,
      authorizationId: p.session_id,
      contextHash: p.context_hash,
    },
    permitId: p.id,
    requestId,
    contextHash: p.context_hash,
    estimateSnapshot: structuredClone(snapshot),
    profile: { model: 'fixture', inputMicrosPerMillion: 1000000, outputMicrosPerMillion: 1000000 },
    policy: { revision: 3, hash: p.generation_policy_hash },
  };
  return {
    ...f,
    permit: p,
    npc: j,
    request,
    proof: () => knownPermitSettlement(p, j, request, a, r, funding),
  };
}
test('failed permit result settles only its recomputed persisted provider usage', () => {
  const f = permitFixture();
  assert.deepEqual(f.proof(), {
    outcome: 'success',
    actualMicros: '500',
    evidence: 'configured_rates',
    receiptId: `permit:${f.permit.id}`,
  });
  split(f);
  assert.ok(f.proof());
});
for (const [name, change] of [
  [
    'historical unmarked consent',
    (f) => delete f.funding.quote.price_snapshot.providerQuote.automaticKnownCostPolicy,
  ],
  [
    'new marked quote without policy acceptance',
    (f) => delete f.funding.quote.price_snapshot.providerQuote.automaticKnownCostAcceptance,
  ],
  [
    'different accepted operation',
    (f) =>
      (f.funding.quote.price_snapshot.providerQuote.automaticKnownCostAcceptance.operationId =
        randomUUID()),
  ],
  ['missing provider usage', (f) => (f.npc.provider_usage = null)],
  ['unverified usage', (f) => (f.npc.provider_usage.costVerifiedForSparks = false)],
  ['invented provider cost', (f) => (f.npc.provider_usage.costMicros = 501)],
  ['foreign job', (f) => (f.permit.job_id = randomUUID())],
  ['foreign request', (f) => (f.request.id = randomUUID())],
  ['changed request context', (f) => (f.request.context = {})],
  ['changed admitted snapshot', (f) => (f.permit.request_snapshot.reserveMicros = 999)],
  ['another direct NPC hold', (f) => (f.npc.spark_hold_id = randomUUID())],
  ['unknown liability', (f) => (f.npc.provider_budget_status = 'unknown')],
  ['unconsumed permit', (f) => (f.permit.state = 'authorized')],
  ['overrun', (f) => (f.reservation.upper_micros = '1')],
  [
    'changed split tariff',
    (f) => {
      split(f);
      f.funding.dreams.quote.price_snapshot.providerQuote.priceSnapshot.tariff.sparkRateVersion =
        'api-cent-1-spark-v1';
    },
  ],
])
  test(`permit proof rejects ${name}`, () => {
    const f = permitFixture();
    change(f);
    assert.equal(f.proof(), undefined);
  });
test('late count transaction captures once, retains native context and never dispatches', async () => {
  const f = countFixture(),
    { hold, quote } = f.funding;
  f.job.status = 'unknown';
  hold.reason = 'unknown';
  const sqls = [],
    ledger = [],
    wallet = { balance_subunits: '10000', held_subunits: '2000' };
  const c = {
    query: async (sql, values = []) => {
      sqls.push(sql);
      let rows = [];
      if (sql.includes('FROM generation_budget_reservations')) rows = [f.reservation];
      else if (sql.includes('pg_advisory_xact_lock')) rows = [{}];
      else if (sql.includes('FROM spark_wallets')) rows = [wallet];
      else if (sql.includes('FROM spark_holds')) rows = [hold];
      else if (sql.includes('FROM spark_quotes')) rows = [quote];
      else if (sql.startsWith('UPDATE spark_wallets')) {
        wallet.held_subunits = String(BigInt(wallet.held_subunits) - BigInt(values[1]));
        wallet.balance_subunits = String(BigInt(wallet.balance_subunits) - BigInt(values[2]));
      } else if (sql.startsWith('UPDATE spark_holds'))
        Object.assign(hold, {
          status: values[1],
          captured_subunits: values[2],
          settlement_fingerprint: values[3],
        });
      else if (sql.startsWith('INSERT INTO spark_ledger')) ledger.push(values);
      else if (sql.startsWith('UPDATE generation_text_counts')) f.job.status = 'stale';
      else throw Error(sql);
      return { rows, rowCount: rows.length };
    },
  };
  await settleKnownCount(c, f.job, f.authorization);
  await settleKnownCount(c, f.job, f.authorization);
  assert.equal(wallet.balance_subunits, '8000');
  assert.equal(wallet.held_subunits, '0');
  assert.equal(ledger.length, 2);
  assert.equal(f.job.status, 'stale');
  assert.ok(!sqls.some((sql) => /game_npc_decision_requests|UPDATE npc_ai_jobs/.test(sql)));
});
test('source hooks do not relax generic pending holds and contain bounded independent recovery cursors', () => {
  const source = readFileSync('apps/api/src/generation/service.ts', 'utf8');
  assert.match(source, /countRecoveryCursor/);
  assert.match(source, /permitRecoveryCursor/);
  assert.match(source, /ORDER BY j.id LIMIT 25/);
  assert.match(source, /ORDER BY p.id LIMIT 25/);
  assert.match(source, /onModuleDestroy/);
  assert.match(source, /clearInterval/);
  const hooks = readFileSync('apps/api/src/generation/sparks-hooks.ts', 'utf8');
  assert.match(hooks, /hold\?\.status === 'pending'/);
});

test('policy disclosure and same consent payload are conditional, not inferred for old clients', () => {
  const funding = readFileSync('apps/web/components/wallet-funding.tsx', 'utf8');
  assert.match(funding, /automaticKnownCostPolicy === 'known-cost-v1'/);
  const count = readFileSync('apps/web/components/live-test/text-count-preflight.tsx', 'utf8');
  assert.match(count, /view\?\.automaticKnownCostPolicy === 'known-cost-v1'/);
  assert.match(count, /countKnownCostConsent/);
  const permit = readFileSync('apps/web/components/live-test/live-test-panel.tsx', 'utf8');
  assert.match(permit, /request.automaticKnownCostPolicy === 'known-cost-v1'/);
  const npc = readFileSync('apps/web/components/game/living-ai-panel.tsx', 'utf8');
  assert.match(npc, /quote.automaticKnownCostPolicy === 'known-cost-v1'/);
});

test('permit replay cannot upgrade old consent or remove an accepted policy', async () => {
  const { GenerationAuthority } = require('../../apps/api/dist/generation/service');
  for (const accepted of [false, true]) {
    const f = permitFixture();
    const c = {
      query: async (sql) => {
        if (sql.includes('FROM live_test_text_permits')) return { rows: [f.permit] };
        if (sql.includes('FROM spark_quotes'))
          return {
            rows: [
              {
                price_snapshot: {
                  providerQuote: accepted
                    ? { automaticKnownCostAcceptance: { policy: 'known-cost-v1' } }
                    : {},
                },
              },
            ],
          };
        throw Error(`Unexpected mutation/read: ${sql}`);
      },
    };
    const authority = Object.create(GenerationAuthority.prototype);
    Object.assign(authority, {
      db: { tx: (fn) => fn(c) },
      owner: async () => {},
      resolveAuthorizationId: async () => f.authorization.id,
    });
    await assert.rejects(
      authority.consent(f.authorization.owner_id, f.permit.campaign_id, f.permit.request_id, {
        operationId: f.permit.operation_id,
        turnFence: { roundId: 'one', phaseEpoch: 1, rulesetVersion: 1 },
        consent: true,
        ...(!accepted ? { automaticKnownCostPolicy: 'known-cost-v1' } : {}),
      }),
      /IDEMPOTENCY_CONFLICT/,
    );
  }
});

test('count replay cannot add new acceptance to an original old-client operation', async () => {
  const { GenerationAuthority } = require('../../apps/api/dist/generation/service');
  const owner = randomUUID(),
    campaignId = randomUUID(),
    requestId = randomUUID();
  const body = {
    operationId: randomUUID(),
    turnFence: { roundId: 'one', phaseEpoch: 1, rulesetVersion: 1 },
    policyRevision: 1,
    policyHash: 'a'.repeat(64),
    candidateFingerprint: 'b'.repeat(64),
    consent: true,
  };
  const prior = {
    id: randomUUID(),
    status: 'stale',
    actual_micros: '1000',
    input_tokens: 42,
    request_hash: digest({ campaignId, requestId, ...body }),
  };
  const authority = Object.create(GenerationAuthority.prototype);
  Object.assign(authority, {
    db: {
      tx: (fn) =>
        fn({
          query: async (sql) => {
            assert.match(sql, /SELECT \* FROM generation_text_counts/);
            return { rows: [prior] };
          },
        }),
    },
    owner: async () => {},
    resolveAuthorizationId: async () => randomUUID(),
  });
  assert.equal((await authority.preflightCount(owner, campaignId, requestId, body)).id, prior.id);
  await assert.rejects(
    authority.preflightCount(owner, campaignId, requestId, {
      ...body,
      automaticKnownCostPolicy: 'known-cost-v1',
    }),
    /IDEMPOTENCY_CONFLICT/,
  );
});

test('fixed count proof accepts canonical PostgreSQL bigint token receipts exactly', () => {
  for (const value of [
    '0',
    '42',
    String(Number.MAX_SAFE_INTEGER),
    0,
    42,
    Number.MAX_SAFE_INTEGER,
  ]) {
    const f = countFixture();
    f.job.input_tokens = value;
    assert.ok(f.proof(), `valid persisted token count ${String(value)}`);
  }
});

test('fixed count proof rejects malformed, negative and unsafe bigint token receipts', () => {
  for (const value of [
    null,
    undefined,
    '',
    '00',
    '042',
    '+42',
    '-0',
    '-1',
    '42.0',
    '4.2',
    '4e2',
    ' 42',
    '42 ',
    '9007199254740992',
    '999999999999999999999999999999',
    true,
    {},
    42n,
    -0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    const f = countFixture();
    f.job.input_tokens = value;
    assert.equal(f.proof(), undefined, `invalid persisted token count ${String(value)}`);
  }
});
