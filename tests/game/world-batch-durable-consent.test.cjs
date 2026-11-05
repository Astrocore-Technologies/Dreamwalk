const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { digest } = require('../../apps/api/dist/ai/context');
const {
  verifyAcceptedWorldBatch,
  SparksAccounting,
} = require('../../apps/api/dist/generation/sparks-accounting');
const {
  RuntimeMapCountRequired,
  withRuntimeMapPreflight,
} = require('../../apps/api/dist/ai/runtime-map-preflight');
function fixture() {
  const owner = randomUUID(),
    campaignId = randomUUID(),
    nativeQuoteId = randomUUID(),
    sparkId = randomUUID();
  const context = { contextHash: 'exact', worldRoundDecision: true, privatePlan: 'unchanged' };
  const proof = {
    batchId: randomUUID(),
    nativeQuoteId,
    runtimeRequestId: randomUUID(),
    contextDigest: digest(context),
    campaignId,
    providerId: 'fixture',
    providerVersion: 'v1',
    policyVersion: 'p1',
  };
  const expires_at = new Date(Date.now() - 60000),
    accepted_at = new Date(Date.now() - 120000);
  const native = {
    id: nativeQuoteId,
    user_id: owner,
    campaign_id: campaignId,
    npc_id: 'npc-a',
    purpose: 'plan',
    context_hash: 'exact',
    provider_id: 'fixture',
    provider_version: 'v1',
    policy_version: 'p1',
    spark_quote_id: sparkId,
    request_snapshot: { immutable: true },
    expires_at,
  };
  const request = {
    id: proof.runtimeRequestId,
    campaign_id: campaignId,
    npc_id: 'npc-a',
    purpose: 'plan',
    context,
    requester_user_id: owner,
    status: 'queued',
    job_id: null,
  };
  const batch = {
    id: proof.batchId,
    owner_id: owner,
    campaign_id: campaignId,
    state: 'accepted',
    expires_at,
    accepted_at,
    turn_fence: { roundId: 'round-a', phaseEpoch: 2, rulesetVersion: 1 },
    entries: [
      {
        requestId: request.id,
        npcId: request.npc_id,
        purpose: request.purpose,
        contextDigest: digest(context),
        quote: { id: native.id },
      },
    ],
  };
  const campaign = {
    owner_id: owner,
    status: 'active',
    state: {
      turnController: {
        phase: 'world',
        roundId: 'round-a',
        phaseEpoch: 2,
        ruleset: { version: 1 },
      },
    },
  };
  const spark = {
    id: sparkId,
    owner_id: owner,
    source_kind: 'npc',
    source_id: native.id,
    operation_id: native.id,
    expires_at,
    price_snapshot: {
      providerQuote: { ...native.request_snapshot, policyVersion: 'p1', contextHash: 'exact' },
    },
  };
  let consumed = false,
    unknown = false;
  const client = {
    query: async (sql, values) => {
      let rows;
      if (sql.includes('FROM game_world_generation_batches'))
        rows = values[0] === batch.id ? [batch] : [];
      else if (sql.includes('FROM game_npc_decision_requests')) rows = [request];
      else if (sql.includes('FROM npc_ai_quotes')) rows = [native];
      else if (sql.includes('FROM game_campaigns')) rows = [campaign];
      else if (sql.includes('FROM npc_ai_jobs WHERE quote_id')) rows = consumed ? [{}] : [];
      else if (sql.includes('FROM npc_ai_jobs j LEFT JOIN')) rows = unknown ? [{}] : [];
      else if (sql.includes('FROM spark_quotes')) rows = [spark];
      else throw new Error(`Unexpected SQL: ${sql}`);
      return { rows, rowCount: rows.length };
    },
  };
  return {
    owner,
    proof,
    sparkId,
    native,
    request,
    batch,
    campaign,
    spark,
    client,
    consume: () => {
      consumed = true;
    },
    unknown: () => {
      unknown = true;
    },
  };
}
test('finite accepted world consent survives original quote expiry without changing snapshots', async () => {
  const f = fixture(),
    original = JSON.stringify([f.batch, f.native, f.spark]);
  await verifyAcceptedWorldBatch(f.client, f.owner, f.proof, f.sparkId);
  assert.equal(JSON.stringify([f.batch, f.native, f.spark]), original);
});
for (const [name, mutate] of Object.entries({
  'spoofed batch': (f) => {
    f.proof.batchId = randomUUID();
  },
  'late acceptance': (f) => {
    f.batch.accepted_at = new Date();
  },
  'unaccepted quote': (f) => {
    f.batch.state = 'quoted';
  },
  'changed private context': (f) => {
    f.request.context.privatePlan = 'changed';
  },
  'changed round': (f) => {
    f.campaign.state.turnController.roundId = 'next-round';
  },
  'changed provider version': (f) => {
    f.native.provider_version = 'v2';
  },
  'changed price': (f) => {
    f.spark.price_snapshot.providerQuote.immutable = false;
  },
  'wrong payer': (f) => {
    f.owner = randomUUID();
  },
  'claimed request': (f) => {
    f.request.job_id = randomUUID();
  },
  'consumed quote': (f) => f.consume(),
  'unknown liability': (f) => f.unknown(),
}))
  test(`durable consent rejects ${name} in admission and independently in accounting`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(verifyAcceptedWorldBatch(f.client, f.owner, f.proof, f.sparkId));
    await assert.rejects(new SparksAccounting().reserve(f.client, f.owner, f.sparkId, f.proof));
  });
test('frozen full roster may preflight more than sixteen bodies exactly once', async () => {
  const roster = Array.from({ length: 40 }, () => randomUUID());
  let current = 0;
  const result = await withRuntimeMapPreflight(
    async () => {
      if (current === roster.length) return 'complete';
      const e = new RuntimeMapCountRequired(
        `body-${current}`,
        'model',
        'v1',
        async () => 1,
        () => {},
      );
      e.scope = { campaignId: 'campaign', npcId: `npc-${current}`, origin: 'user' };
      e.context = { contextHash: 'fixed' };
      e.stateHash = 'fixed';
      e.worldBatchRequestId = roster[current];
      e.worldBatchRequestIds = roster;
      throw e;
    },
    async () => {
      current++;
    },
  );
  assert.equal(result, 'complete');
  assert.equal(current, 40);
});
test('full roster preflight still rejects repeated body without retrying provider', async () => {
  const roster = [randomUUID(), randomUUID()];
  let calls = 0;
  await assert.rejects(
    withRuntimeMapPreflight(
      async () => {
        const e = new RuntimeMapCountRequired(
          'same-body',
          'model',
          'v1',
          async () => 1,
          () => {},
        );
        e.scope = { campaignId: 'campaign', npcId: 'npc', origin: 'user' };
        e.context = { contextHash: 'fixed' };
        e.stateHash = 'fixed';
        e.worldBatchRequestId = roster[Math.min(calls, 1)];
        e.worldBatchRequestIds = roster;
        throw e;
      },
      async () => {
        calls++;
      },
    ),
    /RUNTIME_MAP_QUOTE_CHANGED/,
  );
  assert.equal(calls, 1);
});
test('accounting honors expired accepted price, checks current funds, and rejects expiry without proof', async () => {
  const { createSparkTariffSnapshot } = require('@dreamwalk/contracts');
  const f = fixture();
  let balance = '9';
  f.spark.reserve_subunits = '10';
  f.spark.price_snapshot.tariff = createSparkTariffSnapshot({
    provider: 'fixture',
    model: 'fixture',
    providerRateVersion: 'v1',
    inputMicrosPerMillion: '100000',
    cachedInputMicrosPerMillion: '10000',
    outputMicrosPerMillion: '500000',
  });
  const base = f.client.query;
  f.client.query = async (sql, values) => {
    if (sql.includes('FROM spark_wallets'))
      return {
        rows: [{ enabled: true, balance_subunits: balance, held_subunits: '0' }],
        rowCount: 1,
      };
    if (sql.includes('FROM spark_holds')) return { rows: [], rowCount: 0 };
    if (sql.startsWith('INSERT INTO spark_holds'))
      return {
        rows: [
          { id: values[0], reserved_subunits: values[4], sparks_reserved_subunits: values[6] },
        ],
        rowCount: 1,
      };
    if (sql.startsWith('UPDATE spark_wallets') || sql.startsWith('INSERT INTO spark_ledger'))
      return { rows: [], rowCount: 1 };
    return base(sql, values);
  };
  const accounting = new SparksAccounting();
  await assert.rejects(accounting.reserve(f.client, f.owner, f.sparkId), /SPARK_QUOTE_EXPIRED/);
  await assert.rejects(
    accounting.reserve(f.client, f.owner, f.sparkId, f.proof),
    /INSUFFICIENT_SPARKS/,
  );
  balance = '10';
  const hold = await accounting.reserve(f.client, f.owner, f.sparkId, f.proof);
  assert.equal(hold.reserved_subunits, '10');
  assert.equal(hold.sparks_reserved_subunits, '10');
});
test('opaque locked roster cannot be forged, narrowed, or reused across requests or transactions', () => {
  const {
    captureWorldQuoteRoster,
    readWorldQuoteRoster,
  } = require('../../apps/api/dist/ai/runtime-map-preflight');
  const c = {},
    context = { privatePlan: 'exact' },
    contextDigest = digest(context);
  const rows = [
    { id: 'r1', npc_id: 'n1', purpose: 'plan', context },
    { id: 'r2', npc_id: 'n2', purpose: 'speech', context },
  ];
  const token = captureWorldQuoteRoster(c, 'owner', 'campaign', rows);
  const args = [c, 'owner', 'campaign', 'r1', 'n1', 'plan', contextDigest];
  const ids = readWorldQuoteRoster(token, ...args);
  assert.deepEqual(ids, ['r1', 'r2']);
  assert.ok(Object.isFrozen(ids));
  assert.throws(() => readWorldQuoteRoster({ ids: ['r1'] }, ...args), /RUNTIME_REQUEST_STALE/);
  assert.throws(() => readWorldQuoteRoster(token, {}, ...args.slice(1)), /RUNTIME_REQUEST_STALE/);
  assert.throws(
    () => readWorldQuoteRoster(token, c, 'owner', 'campaign', 'r3', 'n1', 'plan', contextDigest),
    /RUNTIME_REQUEST_STALE/,
  );
  assert.throws(
    () => readWorldQuoteRoster(token, c, 'owner', 'campaign', 'r2', 'n1', 'plan', contextDigest),
    /RUNTIME_REQUEST_STALE/,
  );
  assert.throws(
    () => readWorldQuoteRoster(token, c, 'owner', 'campaign', 'r1', 'n1', 'plan', 'changed'),
    /RUNTIME_REQUEST_STALE/,
  );
  rows[0].context.privatePlan = 'changed';
  assert.deepEqual(readWorldQuoteRoster(token, ...args), ['r1', 'r2']);
});

test('native queue persists verified world batch identity with original consent and request hash', async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
  const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service');
  const f = fixture();
  Object.assign(f.native, { credits: 0, upper_micros: '0' });
  let inserted;
  const client = {
    query: async (sql, values = []) => {
      if (sql.startsWith('INSERT INTO npc_ai_jobs')) {
        inserted = { id: values[0], request_hash: values[4], request_meta: JSON.parse(values[19]) };
        return { rows: [inserted], rowCount: 1 };
      }
      if (sql.includes('FROM npc_ai_provider_budgets'))
        return {
          rows: [
            {
              blocked: false,
              reserved_micros: '0',
              spent_micros: '0',
              unknown_micros: '0',
              cap_micros: '100',
            },
          ],
          rowCount: 1,
        };
      if (sql.includes('count(*) FROM npc_ai_jobs')) return { rows: [{ count: '0' }], rowCount: 1 };
      if (sql.includes('FROM wallets')) return { rows: [{ balance: 100 }], rowCount: 1 };
      if (sql.includes('sum(credits)')) return { rows: [{ held: '0' }], rowCount: 1 };
      if (sql.includes('FROM spark_wallets') || sql.includes('FROM npc_ai_jobs WHERE campaign_id'))
        return { rows: [], rowCount: 0 };
      if (
        sql.startsWith('SELECT a.id') ||
        sql.includes('pg_advisory_xact_lock') ||
        sql.includes('FROM game_members') ||
        sql.includes('FROM adventure_invitations') ||
        sql.startsWith('INSERT ') ||
        sql.startsWith('UPDATE ')
      )
        return { rows: [], rowCount: 0 };
      return f.client.query(sql, values);
    },
  };
  const engine = Object.create(NpcAiEngine.prototype);
  Object.assign(engine, {
    db: { tx: (fn) => fn(client) },
    provider: { id: f.proof.providerId, version: f.proof.providerVersion, external: false },
    policy: {
      maxContextBytes: 64000,
      version: 'p1',
      creditPrice: 0,
      maxQueuedPerCampaign: 8,
      providerCapMicros: 100,
      reservationMs: 60000,
    },
    authorize: async () => {},
    turnAuthorized: async () => true,
    contextFits: () => true,
    requestPlan: async () => ({ reserveMicros: 0, snapshot: f.native.request_snapshot }),
    excludeLegacyOwnerBypass: async () => {},
    isFreeBuiltInSimulation: () => true,
    dto: async (_c, job) => job,
  });
  const scope = {
    campaignId: f.proof.campaignId,
    npcId: f.request.npc_id,
    origin: 'user',
    requesterUserId: f.owner,
    purpose: 'plan',
  };
  const input = {
    scope,
    context: f.request.context,
    operationId: randomUUID(),
    quoteId: f.native.id,
    consent: true,
    runtimeRequestId: f.request.id,
    expectedRuntimeContextDigest: digest(f.request.context),
    acceptedWorldBatchId: f.batch.id,
  };
  await engine.queue(input);
  assert.equal(inserted.request_meta.acceptedWorldBatchId, f.batch.id);
  assert.equal(inserted.request_meta.consent, true);
  assert.equal(
    inserted.request_hash,
    digest({
      scope,
      context: input.context,
      quoteId: input.quoteId,
      consent: true,
      requestKey: '',
      sponsorId: null,
      runtimeRequestId: input.runtimeRequestId,
      acceptedWorldBatchId: f.batch.id,
    }),
  );
  inserted = undefined;
  await assert.rejects(
    engine.queue({ ...input, acceptedWorldBatchId: randomUUID() }),
    /WORLD_BATCH_CONSENT_STALE/,
  );
  assert.equal(inserted, undefined, 'unverified identity never reaches the insert');
});
