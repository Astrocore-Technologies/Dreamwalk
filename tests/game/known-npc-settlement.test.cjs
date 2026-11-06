process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { digest } = require('../../apps/api/dist/ai/context');
const { automaticNpcAdmission } = require('../../apps/api/dist/game/automatic-npc-settlement');
const {
  KnownNpcSettlement,
  knownNpcSettlementQuote,
} = require('../../apps/api/dist/game/known-npc-settlement');

function fixture() {
  const owner = randomUUID(),
    campaign = randomUUID(),
    jobId = randomUUID(),
    holdId = randomUUID(),
    quoteId = randomUUID();
  const snapshot = {
    model: 'synthetic-fixture',
    inputMicrosPerMillion: 100000,
    outputMicrosPerMillion: 500000,
    cachePricing: {
      cachedInputMicrosPerMillion: 10000,
      cacheWrite30mMicrosPerMillion: 125000,
      cacheWrite12hMicrosPerMillion: 250000,
    },
  };
  const job = {
    id: jobId,
    campaign_id: campaign,
    quote_id: quoteId,
    payer_user_id: owner,
    requester_user_id: owner,
    subject_kind: 'npc',
    credits: 0,
    sponsor_id: null,
    status: 'stale',
    provider_id: 'release:fixture',
    provider_external: true,
    provider_budget_status: 'spent',
    provider_actual_micros: '743',
    provider_cost_evidence: 'configured_rates',
    input_tokens: 6405,
    cached_input_tokens: 1383,
    output_tokens: 201,
    provider_usage: {
      inputTokens: 6405,
      cachedInputTokens: 1383,
      outputTokens: 201,
      cacheWriteInputTokens: 5019,
      cacheWriteInputTokensDetails: { ttl30mTokens: 5019, ttl12hTokens: 0 },
      costMicros: 743,
      costVerifiedForSparks: true,
      costEvidence: 'configured_rates',
    },
    request_snapshot: snapshot,
    spark_hold_id: holdId,
    generation_authorization_id: randomUUID(),
    generation_reservation_id: randomUUID(),
    proposal: { private: 'must remain unchanged' },
  };
  const hold = {
    id: holdId,
    owner_id: owner,
    source_kind: 'npc',
    source_id: quoteId,
    reserved_subunits: '5252',
    sparks_reserved_subunits: '5252',
    captured_subunits: null,
    status: 'pending',
    reason: 'failure_policy_pending',
    dream_hold_id: null,
    settlement_fingerprint: null,
  };
  const quote = {
    id: holdId,
    owner_id: owner,
    source_kind: 'npc',
    source_id: quoteId,
    reserve_subunits: '5252',
    price_snapshot: {
      tariff: { sparkRateVersion: 'api-cent-2-sparks-v2' },
      providerQuote: structuredClone(snapshot),
    },
  };
  const authorization = { owner_id: owner, scope_id: `release:${owner}`, mode: 'release' };
  const reservation = {
    actor_id: owner,
    scope_id: authorization.scope_id,
    spark_quote_id: holdId,
    status: 'settled',
    actual_micros: '743',
    kind: 'text',
  };
  const native = {};
  const wallet = { balance_subunits: '100000', held_subunits: '5252' };
  const ledger = [],
    audit = [],
    sqls = [],
    batches = [],
    requests = [];
  let requester = owner;
  const client = {
    query: async (sql, values = []) => {
      sqls.push(sql);
      let rows = [];
      if (sql.includes('FROM game_campaigns')) rows = [{ id: campaign, owner_id: owner }];
      else if (sql.includes('FROM npc_ai_jobs'))
        rows = values[0] === job.id && values[1] === campaign ? [job] : [];
      else if (sql.includes('FROM npc_ai_quotes')) rows = [native];
      else if (sql.includes('FROM game_world_generation_batches')) rows = batches;
      else if (sql.includes('FROM game_npc_decision_requests'))
        rows = requests.filter((r) => r.id === values[0]);
      else if (sql.includes('FROM audit'))
        rows = audit.map((entry) => ({ details: JSON.parse(entry[3]) }));
      else if (sql.includes('FROM npc_ai_provider_budgets'))
        rows = [{ provider_id: job.provider_id }];
      else if (sql.includes('FROM live_test_sessions')) rows = [authorization];
      else if (sql.includes('FROM generation_budget_reservations')) rows = [reservation];
      else if (sql.includes('pg_advisory_xact_lock')) rows = [{}];
      else if (sql.includes('FROM spark_wallets')) rows = [{ owner_id: owner, ...wallet }];
      else if (sql.includes('FROM spark_holds'))
        rows = values[0] === hold.id && values[1] === owner ? [{ ...hold }] : [];
      else if (sql.includes('FROM spark_quotes')) rows = [quote];
      else if (sql.startsWith('UPDATE spark_wallets')) {
        wallet.held_subunits = String(BigInt(wallet.held_subunits) - BigInt(values[1]));
        wallet.balance_subunits = String(BigInt(wallet.balance_subunits) - BigInt(values[2]));
      } else if (sql.startsWith('UPDATE spark_holds')) {
        Object.assign(hold, {
          status: values[1],
          captured_subunits: values[2],
          settlement_fingerprint: values[3],
          reason: null,
        });
      } else if (sql.startsWith('INSERT INTO spark_ledger'))
        ledger.push({ key: values[2], kind: values[3], amount: values[4] });
      else if (sql.startsWith('INSERT INTO audit')) audit.push(values);
      else throw new Error(`Unexpected SQL: ${sql}`);
      return { rows, rowCount: rows.length };
    },
  };
  const authority = {
    lockAuthorization: async () => {
      sqls.push('LOCK AUTHORIZATION AND SCOPE');
      return authorization;
    },
  };
  const service = new KnownNpcSettlement(
    { tx: (fn) => fn(client) },
    { require: async () => ({ id: requester }) },
    authority,
  );
  const body = {
    holdId,
    expectedActualMicros: '743',
    expectedReservedSubunits: '5252',
    expectedCaptureSubunits: '1486',
    operationId: randomUUID(),
    consent: true,
  };
  const result = {
    owner,
    campaign,
    job,
    hold,
    quote,
    authorization,
    reservation,
    native,
    wallet,
    ledger,
    audit,
    sqls,
    batches,
    requests,
    service,
    client,
    body,
    requestAs: (id) => {
      requester = id;
    },
    call: (input) => service.handle({}, campaign, job.id, input),
  };
  completeLegacyFixture(result);
  return result;
}

test('read quote verifies mixed cache writes and returns only safe exact settlement amounts', async () => {
  const f = fixture();
  const view = await f.call();
  assert.equal(view.actualMicros, '743');
  assert.equal(view.captureSubunits, '1486');
  assert.equal(view.releaseSubunits, '3766');
  assert.equal(view.requiresConsent, true);
  assert.equal(view.noGameEffect, true);
  assert.equal(view.funding.sparksCaptureSubunits, '1486');
  assert.equal(JSON.stringify(view).includes('private'), false);
  assert.equal(
    f.sqls.some((sql) => /UPDATE|INSERT|FOR UPDATE|LOCK AUTHORIZATION/.test(sql)),
    false,
  );
});

test('explicit consent settles once through actual accounting, refunds surplus, preserves provider/game evidence', async () => {
  const f = fixture(),
    before = structuredClone(f.job),
    reservation = structuredClone(f.reservation);
  const first = await f.call(f.body);
  assert.equal(first.status, 'settled');
  assert.deepEqual(first.sparks, { balanceSubunits: '98514', heldSubunits: '0' });
  assert.deepEqual(
    f.ledger.map(({ kind, amount }) => ({ kind, amount })),
    [
      { kind: 'capture', amount: '1486' },
      { kind: 'release', amount: '3766' },
    ],
  );
  assert.deepEqual(f.job, before);
  assert.deepEqual(f.reservation, reservation);
  assert.equal(f.audit.length, 1);
  assert.deepEqual(await f.call(f.body), first);
  assert.equal(f.ledger.length, 2);
  assert.equal(f.audit.length, 1);
  await assert.rejects(
    f.call({ ...f.body, operationId: randomUUID() }),
    /SPARK_SETTLEMENT_CONFLICT/,
  );
  assert.equal(f.ledger.length, 2);
});

test('locks keep campaign/job prerequisites, provider, authorization/scope, global fence, wallet, hold order', async () => {
  const f = fixture();
  await f.call(f.body);
  const patterns = [
    'game_campaigns',
    'npc_ai_jobs',
    'npc_ai_provider_budgets',
    'LOCK AUTHORIZATION',
    'pg_advisory_xact_lock',
    'FROM spark_wallets',
    'FROM spark_holds',
  ];
  const indices = patterns.map((pattern) => f.sqls.findIndex((sql) => sql.includes(pattern)));
  assert.ok(indices.every((index, i) => index >= 0 && (i === 0 || index > indices[i - 1])));
  assert.equal(
    f.sqls.some((sql) => /UPDATE (npc_ai|game_|generation_)/.test(sql)),
    false,
  );
});

test('outsider cannot read or settle and cannot learn whether a job exists', async () => {
  const f = fixture();
  f.requestAs(randomUUID());
  await assert.rejects(f.call(), /NOT_FOUND/);
  await assert.rejects(f.call(f.body), /NOT_FOUND/);
  assert.equal(f.ledger.length, 0);
  assert.equal(
    f.sqls.some((sql) => sql.includes('FROM npc_ai_jobs')),
    false,
  );
});

for (const field of [
  'holdId',
  'expectedActualMicros',
  'expectedReservedSubunits',
  'expectedCaptureSubunits',
])
  test(`changed consent ${field} cannot settle`, async () => {
    const f = fixture();
    await assert.rejects(
      f.call({ ...f.body, [field]: field === 'holdId' ? randomUUID() : '1' }),
      /NPC_SETTLEMENT_CHANGED/,
    );
    assert.equal(f.ledger.length, 0);
    assert.equal(f.hold.status, 'pending');
  });

test('missing consent and extra fields fail validation without settlement', async () => {
  const f = fixture();
  for (const body of [
    { ...f.body, consent: false },
    { ...f.body, consent: undefined },
    { ...f.body, retry: true },
  ])
    await assert.rejects(f.call(body));
  assert.equal(f.ledger.length, 0);
});

for (const [name, mutate] of [
  [
    'unknown provider',
    (f) => {
      f.job.provider_budget_status = 'unknown';
    },
  ],
  [
    'running provider',
    (f) => {
      f.job.status = 'running';
    },
  ],
  [
    'unverified usage',
    (f) => {
      f.job.provider_usage.costVerifiedForSparks = false;
    },
  ],
  [
    'unpriced cache',
    (f) => {
      delete f.job.request_snapshot.cachePricing;
      delete f.quote.price_snapshot.providerQuote.cachePricing;
    },
  ],
  [
    'changed immutable tariff',
    (f) => {
      f.job.request_snapshot.inputMicrosPerMillion++;
    },
  ],
  [
    'wrong actual cost',
    (f) => {
      f.job.provider_actual_micros = '744';
    },
  ],
  [
    'wrong token receipt',
    (f) => {
      f.job.input_tokens++;
    },
  ],
  [
    'wrong rate version',
    (f) => {
      f.quote.price_snapshot.tariff.sparkRateVersion = 'invented';
    },
  ],
  [
    'unknown liability',
    (f) => {
      f.hold.reason = 'unknown';
    },
  ],
  [
    'wrong hold owner',
    (f) => {
      f.hold.owner_id = randomUUID();
    },
  ],
  [
    'wrong quote source',
    (f) => {
      f.quote.source_id = randomUUID();
    },
  ],
  [
    'manual provider',
    (f) => {
      f.job.provider_id = 'manual:fixture';
    },
  ],
  [
    'unsettled shared spend',
    (f) => {
      f.reservation.status = 'unknown';
    },
  ],
  [
    'wrong shared scope',
    (f) => {
      f.reservation.scope_id = 'foreign';
    },
  ],
  [
    'foreign authorization',
    (f) => {
      f.authorization.owner_id = randomUUID();
    },
  ],
])
  test(`${name} fails closed without charging`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(f.call(f.body), /NPC_SETTLEMENT_UNAVAILABLE/);
    assert.equal(f.ledger.length, 0);
  });

test('quote derives Dreams-first split from the existing reservation without moving balances', () => {
  const f = fixture();
  f.hold.dream_hold_id = randomUUID();
  f.hold.sparks_reserved_subunits = '4252';
  const view = knownNpcSettlementQuote(f.job, f.hold, f.quote);
  assert.deepEqual(view.funding, {
    dreamsCaptureSubunits: '1000',
    dreamsReleaseSubunits: '0',
    sparksCaptureSubunits: '486',
    sparksReleaseSubunits: '3766',
  });
});

test('HTTP route is explicit, no-store and registered; service has no provider dispatch dependency', () => {
  const controller = readFileSync('apps/api/src/game/game.controller.ts', 'utf8');
  assert.match(controller, /@Get\('campaigns\/:id\/ai\/jobs\/:jobId\/settlement'\)/);
  assert.match(controller, /@Post\('campaigns\/:id\/ai\/jobs\/:jobId\/settlement'\)/);
  assert.match(controller, /@Header\('Cache-Control', 'no-store'\)/);
  assert.match(readFileSync('apps/api/src/main.ts', 'utf8'), /KnownNpcSettlement,/);
  const source = readFileSync('apps/api/src/game/known-npc-settlement.ts', 'utf8');
  assert.doesNotMatch(
    source,
    /\.generate\(|\.enqueue\(|UPDATE game_|UPDATE npc_ai_|UPDATE generation_/,
  );
});

function ordinaryFixture() {
  const f = fixture();
  const { digest } = require('../../apps/api/dist/ai/context');
  f.job.status = 'running';
  f.job.npc_id = 'synthetic-npc';
  f.job.purpose = 'plan';
  f.job.provider_upper_micros = '2626';
  f.job.context = { contextHash: 'exact', worldRoundDecision: true };
  f.job.context_hash = 'exact';
  f.job.policy_version = 'synthetic-v1';
  f.job.request_meta = {
    acceptedWorldBatchId: randomUUID(),
    runtimeRequestId: randomUUID(),
    consent: true,
  };
  f.hold.status = 'held';
  f.hold.reason = null;
  Object.assign(f.quote.price_snapshot.providerQuote, {
    policyVersion: 'synthetic-v1',
    contextHash: 'exact',
  });
  f.request = {
    id: f.job.request_meta.runtimeRequestId,
    job_id: f.job.id,
    requester_user_id: f.owner,
    campaign_id: f.campaign,
    npc_id: f.job.npc_id,
    purpose: 'plan',
    context: structuredClone(f.job.context),
  };
  f.batch = {
    id: f.job.request_meta.acceptedWorldBatchId,
    state: 'accepted',
    accepted_at: new Date(Date.now() - 2000),
    expires_at: new Date(Date.now() - 1000),
    owner_id: f.owner,
    campaign_id: f.campaign,
    quote: { ordinaryTurnConsentVersion: 'end-turn-v1' },
    entries: [
      {
        requestId: f.request.id,
        npcId: f.job.npc_id,
        purpose: 'plan',
        contextDigest: digest(f.job.context),
        quote: { id: f.job.quote_id },
      },
    ],
  };
  const {
    ordinaryFailureSettlement,
  } = require('../../apps/api/dist/ai/ordinary-failure-settlement');
  f.settlement = () => ordinaryFailureSettlement(f.job, f.batch, f.request, f.hold, f.quote);
  return f;
}

test('ordinary known failure settles only its original held bill without new generation', () => {
  const f = ordinaryFixture();
  const result = f.settlement();
  assert.deepEqual(result, {
    outcome: 'success',
    actualMicros: '743',
    evidence: 'configured_rates',
    receiptId: `ordinary-failure:${f.job.id}`,
  });
  const { planSparkSettlement } = require('../../apps/api/dist/generation/sparks-accounting');
  const plan = planSparkSettlement(
    { ...f.hold, spark_rate_version: 'api-cent-2-sparks-v2' },
    result,
  );
  assert.equal(plan.captured, '1486');
  assert.equal(plan.released, '3766');
  assert.equal(plan.pending, false);
  const settled = {
    ...f.hold,
    status: 'settled',
    settlement_fingerprint: plan.fingerprint,
    spark_rate_version: 'api-cent-2-sparks-v2',
  };
  assert.equal(planSparkSettlement(settled, result).duplicate, true);
  assert.equal(f.ledger.length, 0); // This proof is read-only; existing accounting owns the one capture.
});

test('director cost proof permits only story_turn while server admission proof owns legacy eligibility', () => {
  const f = ordinaryFixture();
  f.job.subject_kind = 'player';
  f.job.purpose = f.request.purpose = f.batch.entries[0].purpose = 'story_turn';
  assert.equal(f.settlement().actualMicros, '743');
  f.job.status = 'stale';
  f.hold.status = 'pending';
  f.hold.reason = 'failure_policy_pending';
  assert.equal(knownNpcSettlementQuote(f.job, f.hold, f.quote).captureSubunits, '1486');
  f.job.purpose = 'speech';
  assert.throws(
    () => knownNpcSettlementQuote(f.job, f.hold, f.quote),
    /NPC_SETTLEMENT_UNAVAILABLE/,
  );
});

for (const [name, change] of [
  [
    'player with non-director purpose',
    (f) => {
      f.job.subject_kind = 'player';
    },
  ],
  ['legacy consent', (f) => delete f.batch.quote.ordinaryTurnConsentVersion],
  [
    'old pending hold',
    (f) => {
      f.hold.status = 'pending';
      f.hold.reason = 'failure_policy_pending';
    },
  ],
  [
    'unknown provider cost',
    (f) => {
      f.job.provider_actual_micros = null;
      f.job.provider_budget_status = 'unknown';
    },
  ],
  ['unverified cache cost', (f) => (f.job.provider_usage.costVerifiedForSparks = false)],
  ['changed price', (f) => (f.quote.price_snapshot.providerQuote.inputMicrosPerMillion = 999999)],
  ['reserve overrun', (f) => (f.job.provider_upper_micros = '1')],
  ['wrong owner', (f) => (f.batch.owner_id = randomUUID())],
  ['wrong job', (f) => (f.request.job_id = randomUUID())],
  ['changed request', (f) => (f.request.context.changed = true)],
  ['duplicate entry', (f) => f.batch.entries.push(f.batch.entries[0])],
  ['unaccepted batch', (f) => (f.batch.state = 'quoted')],
  ['late consent', (f) => (f.batch.accepted_at = new Date(Date.now() + 1000))],
  ['location image', (f) => (f.batch.quote.generatedLocationImages = 1)],
  ['location media', (f) => (f.batch.media_entries = [{ kind: 'image' }])],
  ['explicit estimate risk', (f) => (f.batch.quote.estimateRiskConsentRequired = true)],
])
  test(`ordinary failure stays closed for ${name}`, () => {
    const f = ordinaryFixture();
    change(f);
    assert.equal(f.settlement(), undefined);
    assert.equal(f.ledger.length, 0);
  });

test('real NPC finalize consumes an ordinary known failure once and leaves later rounds unblocked', async () => {
  const f = ordinaryFixture();
  f.job.request_meta.failureStage = 'output_envelope';
  f.job.request_meta.outputEnvelope = {
    reason: 'missing_output_text',
    outputItems: '0',
    messageItems: '0',
    contentItems: '0',
    outputTextItems: '0',
    hasMalformedMessage: false,
    hasMalformedOutputText: false,
    hasOtherOutput: false,
    hasOtherContent: false,
  };
  const metadata = structuredClone(f.job.request_meta);
  const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service');
  const { ReleaseGenerationProvider } = require('../../apps/api/dist/generation/release-provider');
  let calls = 0;
  const provider = new ReleaseGenerationProvider(
    {
      id: 'synthetic',
      version: 'fixture',
      external: true,
      generate: async () => {
        calls++;
        throw new Error('Must not generate');
      },
    },
    { release: {}, lockAuthorization: async () => f.authorization },
  );
  const baseQuery = f.client.query;
  const client = {
    query: async (sql, values = []) => {
      let rows;
      if (sql.startsWith('SELECT * FROM npc_ai_jobs')) rows = [{ ...f.job }];
      else if (sql.includes('FROM game_world_generation_batches')) rows = [f.batch];
      else if (sql.includes('FROM game_npc_decision_requests')) rows = [f.request];
      else if (sql.includes('FROM generation_budget_scopes'))
        rows = [{ id: f.reservation.scope_id }];
      else if (sql.includes('FROM spark_holds') && values.length === 1) rows = [{ ...f.hold }];
      else if (sql.startsWith('UPDATE npc_ai_jobs')) {
        f.job.status = values[1];
        rows = [];
      } else return baseQuery(sql, values);
      return { rows, rowCount: rows.length };
    },
  };
  const engine = new NpcAiEngine({ tx: (fn) => fn(client) }, provider);
  await engine.finalize(client, f.job.id, 'stale');
  assert.equal(f.job.status, 'stale');
  assert.equal(f.hold.status, 'settled');
  assert.equal(f.wallet.held_subunits, '0');
  assert.deepEqual(
    f.ledger.map(({ kind, amount }) => ({ kind, amount })),
    [
      { kind: 'capture', amount: '1486' },
      { kind: 'release', amount: '3766' },
    ],
  );
  await engine.finalize(client, f.job.id, 'stale');
  assert.equal(f.ledger.length, 2);
  assert.equal(calls, 0);
  assert.equal(f.job.proposal.private, 'must remain unchanged');
  assert.deepEqual(f.job.request_meta, metadata);
});

function completeLegacyFixture(f) {
  const p = Object.assign(f.job.request_snapshot, {
    reserveMicros: 2626,
    providerFingerprint: 'fixture-v1',
  });
  Object.assign(f.job, {
    npc_id: 'keeper',
    purpose: 'plan',
    origin: 'user',
    context_hash: 'fixture-context',
    context: { contextHash: 'fixture-context' },
    provider_version: 'v1',
    policy_version: 'p1',
    provider_upper_micros: '2626',
    created_at: new Date('2026-10-01'),
    started_at: new Date('2026-10-01'),
    completed_at: new Date('2026-10-01'),
    request_meta: {
      quoteId: f.job.quote_id,
      consent: true,
      requestKey: '',
      sponsorId: null,
      runtimeRequestId: null,
      acceptedWorldBatchId: null,
    },
  });
  Object.assign(f.native, {
    id: f.job.quote_id,
    user_id: f.owner,
    campaign_id: f.campaign,
    npc_id: f.job.npc_id,
    purpose: f.job.purpose,
    context_hash: f.job.context_hash,
    provider_id: f.job.provider_id,
    provider_version: 'v1',
    policy_version: 'p1',
    credits: 0,
    upper_micros: '2626',
    request_snapshot: structuredClone(p),
    spark_quote_id: f.hold.id,
    expires_at: new Date('2026-10-02'),
  });
  f.authorization.id = f.job.generation_authorization_id;
  Object.assign(f.reservation, {
    id: f.job.generation_reservation_id,
    operation_key: `release-npc:${f.job.id}`,
    upper_micros: '2626',
  });
  f.quote.operation_id = f.native.id;
  f.quote.price_snapshot.providerQuote = {
    ...p,
    policyVersion: 'p1',
    contextHash: f.job.context_hash,
  };
  Object.assign(f.quote.price_snapshot.tariff, {
    provider: f.job.provider_id,
    providerRateVersion: p.providerFingerprint,
    model: p.model,
    inputMicrosPerMillion: String(p.inputMicrosPerMillion),
    outputMicrosPerMillion: String(p.outputMicrosPerMillion),
    cachedInputMicrosPerMillion: String(p.cachePricing.cachedInputMicrosPerMillion),
    cacheWriteMicrosPerMillion: String(p.cachePricing.cacheWrite30mMicrosPerMillion),
  });
  fixtureRequestHash(f);
}
function fixtureRequestHash(f) {
  f.job.request_hash = digest({
    scope: {
      campaignId: f.campaign,
      npcId: f.job.npc_id,
      origin: 'user',
      requesterUserId: f.owner,
      purpose: f.job.purpose,
      ...(f.job.subject_kind === 'player' ? { subjectKind: 'player' } : {}),
    },
    context: f.job.context,
    ...f.job.request_meta,
  });
}
function automaticFixture() {
  const f = fixture();
  f.quote.price_snapshot.providerQuote.automaticKnownCostPolicy = 'known-cost-v1';
  f.job.request_meta.automaticKnownCostPolicy = 'known-cost-v1';
  fixtureRequestHash(f);
  f.proof = () =>
    automaticNpcAdmission(f.job, f.native, f.authorization, f.reservation, f.hold, f.quote);
  f.automatic = () => f.service.execute(f.client, f.owner, f.campaign, f.job.id, undefined, true);
  return f;
}
test('automatic recovery settles original accepted native cost without consent or game effects, once', async () => {
  const f = automaticFixture();
  assert.equal(f.proof(), true);
  const proposal = structuredClone(f.job.proposal);
  await f.automatic();
  assert.equal(f.hold.status, 'settled');
  assert.equal(f.wallet.held_subunits, '0');
  assert.equal(f.wallet.balance_subunits, '98514');
  assert.equal(f.audit.length, 1);
  assert.equal(JSON.parse(f.audit[0][3]).automatic, true);
  await f.automatic();
  assert.equal(f.ledger.length, 2);
  assert.deepEqual(f.job.proposal, proposal);
  assert.equal(f.job.status, 'stale');
});
for (const [name, change] of [
  [
    'legacy unmarked acceptance',
    (f) => delete f.quote.price_snapshot.providerQuote.automaticKnownCostPolicy,
  ],
  [
    'new quote without explicit policy acceptance',
    (f) => delete f.job.request_meta.automaticKnownCostPolicy,
  ],
  ['missing original consent', (f) => (f.job.request_meta.consent = false)],
  ['modified request hash', (f) => (f.job.request_hash = 'changed')],
  ['foreign native quote', (f) => (f.native.user_id = randomUUID())],
  ['changed native pricing', (f) => (f.native.request_snapshot.model = 'changed')],
  ['expired direct acceptance', (f) => (f.native.expires_at = new Date('2026-09-01'))],
  ['foreign reservation', (f) => (f.reservation.operation_key = 'other')],
  ['wrong upper bound', (f) => (f.reservation.upper_micros = '1')],
  ['unknown liability', (f) => (f.hold.reason = 'unknown')],
  ['partial existing capture', (f) => (f.hold.captured_subunits = '1')],
  ['changed historical tariff', (f) => (f.quote.price_snapshot.tariff.model = 'changed')],
  [
    'unproved Dreams split',
    (f) => {
      f.hold.sparks_reserved_subunits = '1000';
      f.hold.dream_hold_id = randomUUID();
    },
  ],
])
  test(`automatic native proof rejects ${name}`, () => {
    const f = automaticFixture();
    change(f);
    assert.equal(f.proof(), false);
  });
test('bounded automatic recovery advances past malformed receipts and wraps its cursor', async () => {
  const f = automaticFixture();
  const rows = Array.from({ length: 25 }, () => ({
    id: randomUUID(),
    campaign_id: f.campaign,
    payer_user_id: f.owner,
  }));
  const cursors = [],
    attempted = [];
  f.service.db.query = async (_sql, values) => {
    cursors.push(values[0]);
    return cursors.length === 1 ? rows : [];
  };
  f.service.execute = async (_c, _owner, _campaign, id) => {
    attempted.push(id);
  };
  await f.service.recoverPending();
  await f.service.recoverPending();
  await f.service.recoverPending();
  assert.deepEqual(cursors, [null, rows.at(-1).id, null]);
  assert.equal(attempted.length, 25);
});

test('automatic native proof verifies the exact Dreams split and rejects tampered lineage', () => {
  const f = automaticFixture();
  const { hold, quote } = f;
  hold.dream_hold_id = randomUUID();
  hold.sparks_reserved_subunits = '4252';
  quote.price_snapshot.fundingPolicy = 'dreams-first-v1';
  const dreams = {
    hold: {
      id: hold.dream_hold_id,
      owner_id: f.owner,
      source_kind: 'npc',
      source_id: f.native.id,
      reserved_subunits: '1000',
      status: 'pending',
      reason: 'unknown',
      captured_subunits: null,
      settlement_fingerprint: null,
    },
    quote: {
      id: hold.dream_hold_id,
      owner_id: f.owner,
      source_kind: 'npc',
      source_id: f.native.id,
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
  const proof = () =>
    automaticNpcAdmission(
      f.job,
      f.native,
      f.authorization,
      f.reservation,
      hold,
      quote,
      undefined,
      undefined,
      dreams,
    );
  assert.equal(proof(), true);
  dreams.quote.price_snapshot.providerQuote.priceSnapshot.tariff.sparkRateVersion =
    'api-cent-1-spark-v1';
  assert.equal(proof(), false);
});

test('historical end-turn allowance stays finite, source-linked and excludes image/risk consent', () => {
  const f = automaticFixture();
  delete f.quote.price_snapshot.providerQuote.automaticKnownCostPolicy;
  delete f.job.request_meta.automaticKnownCostPolicy;
  const requestId = randomUUID();
  const batch = {
    id: randomUUID(),
    owner_id: f.owner,
    campaign_id: f.campaign,
    state: 'stale',
    accepted_at: new Date('2026-10-01'),
    expires_at: new Date('2026-10-02'),
    quote: { ordinaryTurnConsentVersion: 'end-turn-v1', generatedLocationImages: 0 },
    media_entries: [],
    entries: [
      {
        requestId,
        quote: { id: f.native.id },
        npcId: f.job.npc_id,
        purpose: f.job.purpose,
        contextDigest: digest(f.job.context),
      },
    ],
  };
  const request = {
    id: requestId,
    job_id: f.job.id,
    requester_user_id: f.owner,
    campaign_id: f.campaign,
    npc_id: f.job.npc_id,
    purpose: f.job.purpose,
    context: f.job.context,
  };
  f.job.request_meta.runtimeRequestId = requestId;
  f.job.request_meta.acceptedWorldBatchId = batch.id;
  f.job.request_hash = digest({
    scope: {
      campaignId: f.campaign,
      npcId: f.job.npc_id,
      origin: 'user',
      requesterUserId: f.owner,
      purpose: f.job.purpose,
      ...(f.job.subject_kind === 'player' ? { subjectKind: 'player' } : {}),
    },
    context: f.job.context,
    ...f.job.request_meta,
  });
  const proof = () =>
    automaticNpcAdmission(
      f.job,
      f.native,
      f.authorization,
      f.reservation,
      f.hold,
      f.quote,
      batch,
      request,
    );
  assert.equal(proof(), true);
  batch.quote.generatedLocationImages = 1;
  assert.equal(proof(), false);
  batch.quote.generatedLocationImages = 0;
  batch.quote.estimateRiskConsentRequired = true;
  assert.equal(proof(), false);
});

test('terminal status cannot display a hypothetical charge different from persisted capture', async () => {
  const f = fixture();
  f.hold.status = 'released';
  f.hold.captured_subunits = '0';
  await assert.rejects(f.call(), /NPC_SETTLEMENT_UNAVAILABLE/);
  assert.equal(f.ledger.length, 0);
});

test('legacy player story_turn requires full original proof and exact owner consent', async () => {
  const f = fixture();
  f.job.subject_kind = 'player';
  f.job.purpose = f.native.purpose = 'story_turn';
  fixtureRequestHash(f);
  const view = await f.call();
  assert.equal(view.settlementMode, 'legacy_confirmation');
  assert.equal(view.captureSubunits, '1486');
  const result = await f.call(f.body);
  assert.equal(result.status, 'settled');
  assert.deepEqual(await f.call(f.body), result);
  assert.equal(f.ledger.length, 2);
  assert.equal(f.audit.length, 1);
});
for (const [name, change] of [
  [
    'changed native quote',
    (f) => {
      f.native.request_snapshot.model = 'wrong';
    },
  ],
  [
    'missing original consent',
    (f) => {
      f.job.request_meta.consent = false;
    },
  ],
  [
    'changed request hash',
    (f) => {
      f.job.request_hash = 'wrong';
    },
  ],
  [
    'partial automatic marker',
    (f) => {
      f.job.request_meta.automaticKnownCostPolicy = 'known-cost-v1';
    },
  ],
])
  test(`legacy recovery rejects ${name}`, async () => {
    const f = fixture();
    change(f);
    await assert.rejects(f.call(f.body), /NPC_SETTLEMENT_UNAVAILABLE/);
    assert.equal(f.ledger.length, 0);
  });
test('automatic pending quote stays read-only and cannot use manual consent endpoint', async () => {
  const f = automaticFixture();
  assert.equal((await f.call()).settlementMode, 'automatic');
  await assert.rejects(f.call(f.body), /NPC_SETTLEMENT_UNAVAILABLE/);
  assert.equal(f.ledger.length, 0);
});
test('terminal GET checks audit against exact ledger receipt before reporting complete', async () => {
  const f = fixture();
  await f.call(f.body);
  f.audit[0][3] = JSON.stringify({ ...JSON.parse(f.audit[0][3]), operationId: randomUUID() });
  await assert.rejects(f.call(), /NPC_SETTLEMENT_UNAVAILABLE/);
  assert.equal(f.ledger.length, 2);
});

test('pre-batch legacy player hash is accepted only when the original field was absent', async () => {
  const f = fixture();
  f.job.subject_kind = 'player';
  f.job.purpose = f.native.purpose = 'story_turn';
  delete f.job.request_meta.acceptedWorldBatchId;
  fixtureRequestHash(f);
  assert.equal((await f.call()).settlementMode, 'legacy_confirmation');
  f.job.request_meta.acceptedWorldBatchId = null;
  await assert.rejects(f.call(), /NPC_SETTLEMENT_UNAVAILABLE/);
  f.job.request_meta.acceptedWorldBatchId = randomUUID();
  await assert.rejects(f.call(), /NPC_SETTLEMENT_UNAVAILABLE/);
  assert.equal(f.ledger.length, 0);
});

test('an ordinary terminal receipt remains readable without inventing a manual recovery audit', async () => {
  const f = fixture();
  const { SparksAccounting } = require('../../apps/api/dist/generation/sparks-accounting');
  await new SparksAccounting().settle(
    f.client,
    f.owner,
    f.hold.id,
    {
      outcome: 'success',
      actualMicros: '743',
      evidence: 'configured_rates',
      receiptId: `ordinary-failure:${f.job.id}`,
    },
    true,
  );
  assert.equal((await f.call()).status, 'settled');
  assert.equal(f.audit.length, 0);
  await assert.rejects(f.call(f.body), /SPARK_SETTLEMENT_CONFLICT/);
  assert.equal(f.ledger.length, 2);
});

test('pre-automatic manual audit keeps its original receipt and never becomes automatic consent', async () => {
  const f = fixture();
  await f.call(f.body);
  const details = JSON.parse(f.audit[0][3]);
  delete details.automatic;
  f.audit[0][3] = JSON.stringify(details);
  assert.equal((await f.call()).status, 'settled');
  assert.equal((await f.call(f.body)).status, 'settled');
  assert.equal(f.ledger.length, 2);
});

test('an unmarked ordinary accepted batch remains automatic for pending and terminal reads', async () => {
  const f = fixture();
  const requestId = randomUUID(),
    batchId = randomUUID();
  f.job.request_meta.runtimeRequestId = requestId;
  f.job.request_meta.acceptedWorldBatchId = batchId;
  f.requests.push({
    id: requestId,
    job_id: f.job.id,
    requester_user_id: f.owner,
    campaign_id: f.campaign,
    npc_id: f.job.npc_id,
    purpose: f.job.purpose,
    context: structuredClone(f.job.context),
  });
  f.batches.push({
    id: batchId,
    state: 'accepted',
    accepted_at: new Date('2026-10-01'),
    expires_at: new Date('2026-10-02'),
    owner_id: f.owner,
    campaign_id: f.campaign,
    quote: { ordinaryTurnConsentVersion: 'end-turn-v1' },
    media_entries: [],
    entries: [
      {
        requestId,
        npcId: f.job.npc_id,
        purpose: f.job.purpose,
        contextDigest: digest(f.job.context),
        quote: { id: f.native.id },
      },
    ],
  });
  fixtureRequestHash(f);
  assert.equal((await f.call()).settlementMode, 'automatic');
  await assert.rejects(f.call(f.body), /NPC_SETTLEMENT_UNAVAILABLE/);
  assert.equal(f.ledger.length, 0);
  const { SparksAccounting } = require('../../apps/api/dist/generation/sparks-accounting');
  await new SparksAccounting().settle(
    f.client,
    f.owner,
    f.hold.id,
    {
      outcome: 'success',
      actualMicros: '743',
      evidence: 'configured_rates',
      receiptId: `ordinary-failure:${f.job.id}`,
    },
    true,
  );
  const terminal = await f.call();
  assert.equal(terminal.status, 'settled');
  assert.equal(terminal.settlementMode, 'automatic');
  assert.equal(f.audit.length, 0);
  assert.equal(f.ledger.length, 2);
});
