process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
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
  const wallet = { balance_subunits: '100000', held_subunits: '5252' };
  const ledger = [],
    audit = [],
    sqls = [];
  let requester = owner;
  const client = {
    query: async (sql, values = []) => {
      sqls.push(sql);
      let rows = [];
      if (sql.includes('FROM game_campaigns')) rows = [{ id: campaign, owner_id: owner }];
      else if (sql.includes('FROM npc_ai_jobs'))
        rows = values[0] === job.id && values[1] === campaign ? [job] : [];
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
  return {
    owner,
    campaign,
    job,
    hold,
    quote,
    authorization,
    reservation,
    wallet,
    ledger,
    audit,
    sqls,
    service,
    body,
    requestAs: (id) => {
      requester = id;
    },
    call: (input) => service.handle({}, campaign, job.id, input),
  };
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
