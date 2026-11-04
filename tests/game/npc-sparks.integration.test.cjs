// NpcAiEngine method integration with serialized transactional memory transport.
// Accounting SQL itself is covered separately; these spies exercise its real transition planner.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const configPath = require.resolve('../../apps/api/dist/config');
require.cache[configPath] = {
  id: configPath,
  filename: configPath,
  loaded: true,
  exports: { config: { DATABASE_URL: 'postgresql://synthetic@127.0.0.1:1/never' } },
};
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service');
const {
  SparksAccounting,
  planSparkSettlement,
} = require('../../apps/api/dist/generation/sparks-accounting');
const { ProviderFailure } = require('../../apps/api/dist/ai/types');
function fixture(enabled = true, mode = 'success') {
  const owner = randomUUID(),
    campaign = randomUUID();
  let state = {
    quotes: [],
    jobs: [],
    sparkQuotes: [],
    holds: [],
    balance: 1000n,
    held: 0n,
    ledger: [],
    credits: 50,
    calls: 0,
  };
  const clone = (x) => structuredClone(x);
  const query = async (sql, p = []) => {
    const result = (rows) => ({ rows: clone(rows), rowCount: rows.length });
    if (
      sql.startsWith('SELECT enabled FROM spark_wallets') &&
      mode.startsWith('mixed-') &&
      p[0] !== owner
    )
      return result(mode === 'mixed-missing' ? [] : [{ enabled: false }]);
    if (sql.startsWith('SELECT enabled FROM spark_wallets'))
      return result([
        { enabled: mode === 'flip' && sql.includes('FOR UPDATE') ? !enabled : enabled },
      ]);
    if (
      sql.startsWith(
        'SELECT owner_id,reserve_subunits,price_snapshot FROM spark_quotes WHERE id=$1',
      )
    )
      return result(state.sparkQuotes.filter((q) => q.id === p[0]));
    if (
      sql.startsWith('SELECT balance_subunits,held_subunits FROM dream_wallets WHERE owner_id=$1')
    )
      return result([]); // These historical scenarios have no Dreams wallet.
    if (
      sql.startsWith('SELECT id,reserved_subunits FROM spark_holds') ||
      sql.startsWith(
        'SELECT reserved_subunits,sparks_reserved_subunits,captured_subunits FROM spark_holds',
      ) ||
      sql.startsWith('SELECT status FROM spark_holds') ||
      sql.startsWith('SELECT reserved_subunits FROM spark_holds')
    )
      return result(state.holds.filter((h) => h.id === p[0]));
    if (sql.startsWith('SELECT count(')) return result([{ count: 0 }]);
    if (sql.startsWith('SELECT state FROM game_campaigns')) return result([{ state: {} }]);
    if (sql.startsWith('SELECT c.id FROM game_campaigns')) return result([{ id: campaign }]);
    if (
      sql.startsWith('SELECT 1 FROM game_campaigns WHERE id=$1 AND owner_id=$2') ||
      sql.startsWith('SELECT 1 FROM game_members WHERE campaign_id=')
    )
      return result([{ authorized: true }]);
    if (sql.startsWith('SELECT * FROM npc_ai_quotes'))
      return result(state.quotes.filter((q) => q.id === p[0]));
    if (sql.startsWith('INSERT INTO npc_ai_quotes')) {
      state.quotes.push({
        id: p[0],
        campaign_id: p[1],
        npc_id: p[2],
        user_id: p[3],
        context_hash: p[4],
        purpose: p[5],
        provider_id: p[6],
        policy_version: p[7],
        credits: p[8],
        upper_micros: p[9],
        expires_at: p[10],
        provider_version: p[11],
        request_snapshot: JSON.parse(p[12]),
        spark_quote_id: p[13],
      });
      return result([]);
    }
    if (sql.startsWith('SELECT * FROM npc_ai_jobs WHERE campaign_id=$1 AND operation_id'))
      return result(state.jobs.filter((j) => j.campaign_id === p[0] && j.operation_id === p[1]));
    if (sql.startsWith('SELECT 1 FROM npc_ai_jobs WHERE quote_id'))
      return result(state.jobs.filter((j) => j.quote_id === p[0]));
    if (sql.startsWith('SELECT id FROM npc_ai_jobs WHERE campaign_id'))
      return result(
        state.jobs.filter(
          (j) =>
            j.npc_id === p[1] && !['committed', 'cancelled', 'stale', 'failed'].includes(j.status),
        ),
      );
    if (
      sql.startsWith('SELECT * FROM npc_ai_jobs WHERE id') ||
      sql.startsWith('SELECT campaign_id FROM npc_ai_jobs WHERE id')
    )
      return result(state.jobs.filter((j) => j.id === p[0]));
    if (sql.startsWith('SELECT * FROM npc_ai_provider_budgets'))
      return result([
        {
          cap_micros: 100000,
          reserved_micros: 0,
          spent_micros: 0,
          unknown_micros: 0,
          blocked: false,
        },
      ]);
    if (sql.startsWith('SELECT balance FROM wallets')) {
      if (enabled) throw Error('Legacy wallet touched');
      return result([{ balance: state.credits }]);
    }
    if (sql.startsWith('SELECT COALESCE(sum(credits)')) return result([{ held: 0 }]);
    if (sql.startsWith('INSERT INTO npc_ai_jobs')) {
      const j = {
        id: p[0],
        campaign_id: p[1],
        npc_id: p[2],
        operation_id: p[3],
        request_hash: p[4],
        origin: p[5],
        requester_user_id: p[6],
        payer_user_id: p[7],
        purpose: p[8],
        context_hash: p[9],
        context: JSON.parse(p[10]),
        provider_id: p[11],
        provider_version: p[12],
        policy_version: p[13],
        status: 'reserved',
        credits: p[14],
        reservation_status: p[15],
        reservation_expires_at: p[16],
        provider_upper_micros: String(p[17]),
        provider_budget_status: 'reserved',
        quote_id: p[18],
        request_meta: JSON.parse(p[19]),
        sponsor_id: p[20],
        subject_kind: p[21],
        request_snapshot: JSON.parse(p[24]),
        spark_hold_id: p[25],
        created_at: new Date(),
        provider_actual_micros: null,
      };
      state.jobs.push(j);
      return result([j]);
    }
    if (sql.startsWith('SELECT proposal FROM npc_ai_cache'))
      return result(mode === 'cache' ? [{ proposal: { actions: [{ kind: 'wait' }] } }] : []);
    if (sql.startsWith('UPDATE npc_ai_jobs')) {
      const j = state.jobs.find((j) => j.id === p[0]);
      if (sql.includes("status='running'")) j.status = 'running';
      if (sql.includes('provider_cost_evidence=$2')) j.provider_cost_evidence = p[1];
      if (sql.includes('provider_budget_status=$2')) {
        j.provider_budget_status = p[1];
        j.provider_actual_micros = p[2];
      }
      if (sql.includes('provider_request_id=$2,input_tokens')) j.provider_actual_micros = p[4];
      if (sql.includes("status='result_received'")) {
        j.status = 'result_received';
        j.proposal = JSON.parse(p[1]);
      }
      if (sql.includes('status=$2')) j.status = p[1];
      return result([]);
    }
    if (sql.startsWith('UPDATE wallets')) {
      if (enabled) throw Error('Legacy wallet debited');
      state.credits -= p[1];
      return result([]);
    }
    if (sql.startsWith('INSERT INTO ledger')) {
      if (enabled) throw Error('Legacy ledger touched');
      return result([]);
    }
    if (
      /^(SELECT pg_advisory|SELECT a.id|SELECT user_id FROM game_members|SELECT i.id FROM adventure_invitations|SELECT 1 FROM npc_ai_jobs WHERE campaign_id|INSERT INTO npc_ai_provider_budgets|UPDATE npc_ai_provider_budgets|INSERT INTO npc_ai_cache)/.test(
        sql,
      )
    )
      return result([]);
    throw Error(`Unsupported fixture SQL: ${sql}`);
  };
  let tail = Promise.resolve();
  const db = {
    query: async (...args) => (await query(...args)).rows,
    tx(fn) {
      const task = tail.then(async () => {
        const before = clone(state);
        try {
          return await fn({ query });
        } catch (e) {
          state = before;
          throw e;
        }
      });
      tail = task.catch(() => {});
      return task;
    },
  };
  const provider = {
    id: 'fixture',
    version: 'v1',
    external: false,
    prepareTextRequest: () => ({
      snapshot: {
        model: 'fixture',
        providerFingerprint: 'fixed-v1',
        bodySha256: 'immutable-body',
        reserveMicros: 100,
        inputMicrosPerMillion: 100000,
        outputMicrosPerMillion: 500000,
      },
    }),
    async generate() {
      state.calls++;
      if (mode === 'failure') throw new ProviderFailure('MOCK_FAILURE', false);
      return {
        proposal: { actions: [{ kind: 'wait' }] },
        requestId: 'receipt',
        usage: {
          inputTokens: 10,
          outputTokens: 1,
          costMicros: mode === 'overrun' ? 101 : 30,
          costEvidence: 'configured_rates',
          ...(['unpriced', 'cached-read', 'unpriced-asserted'].includes(mode)
            ? {
                ...(mode === 'cached-read'
                  ? { cachedInputTokens: 2 }
                  : { cacheWriteInputTokens: 2 }),
                costVerifiedForSparks: mode === 'unpriced-asserted',
              }
            : {}),
        },
      };
    },
  };
  const engine = new NpcAiEngine(db, provider, {
    creditPrice: 5,
    providerUpperMicros: 100,
    providerCapMicros: 100000,
  });
  const originals = {};
  for (const name of ['quote', 'reserve', 'settle'])
    originals[name] = SparksAccounting.prototype[name];
  SparksAccounting.prototype.quote = async (_c, input) => {
    const q = {
      ...input,
      reserve_subunits: input.reserveSubunits,
      price_snapshot: { tariff: input.tariff },
      id: randomUUID(),
    };
    state.sparkQuotes.push(q);
    return q;
  };
  SparksAccounting.prototype.reserve = async (_c, uid, qid) => {
    const existing = state.holds.find((h) => h.id === qid);
    if (existing) return existing;
    const q = state.sparkQuotes.find((q) => q.id === qid);
    assert.equal(q.ownerId, uid);
    if (state.balance - state.held < BigInt(q.reserveSubunits)) throw Error('INSUFFICIENT_SPARKS');
    const h = {
      id: qid,
      status: 'held',
      reserved_subunits: q.reserveSubunits,
      spark_rate_version: q.tariff.sparkRateVersion,
    };
    state.holds.push(h);
    state.held += BigInt(q.reserveSubunits);
    return h;
  };
  SparksAccounting.prototype.settle = async (_c, _uid, id, event) => {
    const h = state.holds.find((h) => h.id === id);
    const plan = planSparkSettlement(h, event);
    if (plan.duplicate) return h;
    state.ledger.push(event);
    if (plan.pending) h.status = 'pending';
    else {
      h.status = plan.captured === '0' ? 'released' : 'settled';
      h.settlement_fingerprint = plan.fingerprint;
      state.balance -= BigInt(plan.captured);
      state.held -= BigInt(h.reserved_subunits);
    }
    return h;
  };
  const scope = { campaignId: campaign, npcId: 'keeper', origin: 'user', requesterUserId: owner };
  const context = { contextHash: 'fixture' };
  return {
    engine,
    db,
    scope,
    context,
    owner,
    get state() {
      return state;
    },
    restore() {
      for (const name of Object.keys(originals)) SparksAccounting.prototype[name] = originals[name];
    },
    async admit() {
      const quote = await engine.quote(scope, context, owner);
      const input = { scope, context, operationId: randomUUID(), quoteId: quote.id, consent: true };
      return { quote, input, job: await engine.queue(input) };
    },
  };
}
test('enabled engine quotes/reserves once under replay, dispatches, commits actual and releases remainder without credits', async () => {
  const f = fixture();
  try {
    const { quote, input, job } = await f.admit();
    assert.equal(quote.chargeUnit, 'sparks');
    assert.equal(quote.sparkReservedSubunits, '200');
    assert.equal(quote.sparkRateVersion, 'api-cent-2-sparks-v2');
    assert.equal(job.sparkReservedSubunits, '200');
    assert.equal(job.credits, 0);
    const duplicates = await Promise.all([f.engine.queue(input), f.engine.queue(input)]);
    assert.ok(duplicates.every((j) => j.id === job.id));
    assert.equal(f.state.holds.length, 1);
    assert.equal(f.state.held, 200n);
    await f.engine.run(job.id, async () => true);
    await f.db.tx((c) => f.engine.finalize(c, job.id, 'committed'));
    await f.db.tx((c) => f.engine.finalize(c, job.id, 'committed'));
    assert.equal(f.state.balance, 940n);
    assert.equal(f.state.held, 0n);
    assert.equal(f.state.credits, 50);
    assert.equal(f.state.calls, 1);
    assert.equal(f.state.ledger.length, 1);
  } finally {
    f.restore();
  }
});
for (const mode of [
  'cache',
  'cancel',
  'failure',
  'stale',
  'unpriced',
  'cached-read',
  'unpriced-asserted',
  'overrun',
])
  test(`enabled NPC ${mode} preserves correct liability`, async () => {
    const f = fixture(true, mode);
    try {
      const { job } = await f.admit();
      if (mode === 'cancel') await f.engine.cancel(job.id);
      else {
        await f.engine.run(job.id, async () => true);
        if (mode === 'stale') await f.db.tx((c) => f.engine.finalize(c, job.id, 'stale'));
        if (['unpriced', 'cached-read', 'unpriced-asserted'].includes(mode))
          await f.db.tx((c) => f.engine.finalize(c, job.id, 'committed'));
      }
      assert.equal(f.state.balance, 1000n);
      assert.equal(f.state.held, ['cache', 'cancel'].includes(mode) ? 0n : 200n);
      assert.equal(
        f.state.holds[0].status,
        ['cache', 'cancel'].includes(mode) ? 'released' : 'pending',
      );
      assert.equal(f.state.credits, 50);
    } finally {
      f.restore();
    }
  });
test('enabled zero-credit policy still requires explicit consent and stale quote rejects before hold', async () => {
  const f = fixture();
  try {
    f.engine.policy.creditPrice = 0;
    await assert.rejects(
      f.engine.queue({ scope: f.scope, context: f.context, operationId: randomUUID() }),
    );
    const quote = await f.engine.quote(f.scope, f.context, f.owner);
    f.state.quotes[0].expires_at = new Date(0);
    await assert.rejects(
      f.engine.queue({
        scope: f.scope,
        context: f.context,
        operationId: randomUUID(),
        quoteId: quote.id,
        consent: true,
      }),
    );
    assert.equal(f.state.holds.length, 0);
  } finally {
    f.restore();
  }
});
test('disabled payer retains demo credits without Spark reservation', async () => {
  const f = fixture(false);
  try {
    const { quote, job } = await f.admit();
    assert.equal(quote.credits, 5);
    assert.equal(f.state.holds.length, 0);
    await f.engine.run(job.id, async () => true);
    await f.db.tx((c) => f.engine.finalize(c, job.id, 'committed'));
    assert.equal(f.state.credits, 45);
    assert.equal(f.state.balance, 1000n);
  } finally {
    f.restore();
  }
});
test('enabled missing immutable snapshot and changed request quote fail before reservation', async () => {
  const f = fixture();
  try {
    const quote = await f.engine.quote(f.scope, f.context, f.owner);
    const original = f.engine.provider.prepareTextRequest;
    f.engine.provider.prepareTextRequest = () => ({
      snapshot: { ...original().snapshot, bodySha256: 'changed-body' },
    });
    await assert.rejects(
      f.engine.queue({
        scope: f.scope,
        context: f.context,
        operationId: randomUUID(),
        quoteId: quote.id,
        consent: true,
      }),
    );
    f.engine.provider.prepareTextRequest = () => undefined;
    await assert.rejects(f.engine.quote(f.scope, f.context, f.owner));
    assert.equal(f.state.holds.length, 0);
    assert.equal(f.state.calls, 0);
  } finally {
    f.restore();
  }
});
test('insufficient Sparks rolls admission back without any legacy credit fallback', async () => {
  const f = fixture();
  try {
    f.state.balance = 99n;
    await assert.rejects(f.admit(), /INSUFFICIENT_SPARKS/);
    assert.equal(f.state.jobs.length, 0);
    assert.equal(f.state.holds.length, 0);
    assert.equal(f.state.credits, 50);
    assert.equal(f.state.calls, 0);
  } finally {
    f.restore();
  }
});
test('documented cache writes survive validation and cannot overlap read or ordinary input', () => {
  const { validateProviderResult } = require('../../apps/api/dist/ai/provider');
  const result = {
    proposal: {},
    requestId: 'receipt',
    usage: {
      inputTokens: 10,
      cachedInputTokens: 3,
      cacheWriteInputTokens: 7,
      outputTokens: 1,
      costMicros: 2,
      costVerifiedForSparks: false,
    },
  };
  assert.equal(validateProviderResult(result).usage.costVerifiedForSparks, false);
  assert.throws(() =>
    validateProviderResult({ ...result, usage: { ...result.usage, cacheWriteInputTokens: 8 } }),
  );
});
test('enabled sponsor cannot silently spend under the old demo sponsorship policy', async () => {
  const f = fixture();
  const { NpcSponsorship } = require('../../apps/api/dist/ai/sponsorship');
  const original = NpcSponsorship.prototype.validate;
  NpcSponsorship.prototype.validate = async () => f.owner;
  try {
    await assert.rejects(
      f.engine.queue({
        scope: { campaignId: f.scope.campaignId, npcId: f.scope.npcId, origin: 'system' },
        context: f.context,
        operationId: randomUUID(),
        sponsorId: randomUUID(),
      }),
      (error) => error.getResponse().code === 'SPARK_SPONSOR_POLICY_REQUIRED',
    );
    assert.equal(f.state.jobs.length, 0);
    assert.equal(f.state.holds.length, 0);
    assert.equal(f.state.credits, 50);
  } finally {
    NpcSponsorship.prototype.validate = original;
    f.restore();
  }
});
test('Responses zero-cache is verified while unpriced reads/writes retain legacy meter but forbid Spark capture', async () => {
  const { OpenAiNpcProvider } = require('../../apps/api/dist/ai/openai-provider');
  const cfg = {
    enabled: true,
    apiKey: 'synthetic-only',
    model: 'synthetic-model',
    version: 'v1',
    maxInputBytes: 64000,
    maxOutputTokens: 100,
    maxResponseBytes: 64000,
    inputMicrosPerMillion: 100000,
    outputMicrosPerMillion: 500000,
  };
  for (const [read, write, verified] of [
    [0, 0, true],
    [80, 0, false],
    [0, 80, false],
  ]) {
    const provider = new OpenAiNpcProvider(
      cfg,
      async () =>
        new Response(
          JSON.stringify({
            id: 'fixture',
            status: 'completed',
            service_tier: 'default',
            usage: {
              input_tokens: 100,
              output_tokens: 10,
              input_tokens_details: { cached_tokens: read, cache_write_tokens: write },
            },
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: JSON.stringify({ text: 'Hello' }) }],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const result = await provider.generate({
      jobId: randomUUID(),
      purpose: 'speech',
      context: { contextHash: 'fixture', replyLocale: 'en' },
      signal: new AbortController().signal,
      maxCostMicros: 100000,
    });
    assert.equal(result.usage.costVerifiedForSparks, verified);
    assert.equal(result.usage.costMicros, 15);
    assert.equal(result.usage.costEvidence, 'configured_rates');
  }
});

test('wallet mode flip between early admission read and final wallet lock fails closed', async () => {
  const f = fixture(false, 'flip');
  try {
    // Skip quote because flip mode simulates a change specifically at wallet-lock time.
    f.engine.policy.creditPrice = 0;
    await assert.rejects(
      f.engine.queue({ scope: f.scope, context: f.context, operationId: randomUUID() }),
      (error) => error.getResponse().code === 'SPARK_POLICY_CHANGED',
    );
    assert.equal(f.state.jobs.length, 0);
    assert.equal(f.state.calls, 0);
  } finally {
    f.restore();
  }
});
test('authoring Responses propagates unpriced cache categories without changing legacy cost or allowing malformed totals', async () => {
  const {
    BoundedAuthoringTextProvider,
  } = require('../../apps/api/dist/live-test/authoring-provider');
  const definition = {
    version: 'synthetic-v1',
    schema: { type: 'object' },
    instructions: 'Synthetic test only',
    validateProposal: (x) => x,
  };
  const profile = {
    model: 'synthetic-model',
    contextTokens: 1000,
    maxOutputTokens: 100,
    maxInputBytes: 64000,
    inputMicrosPerMillion: 100000,
    outputMicrosPerMillion: 500000,
    upperMicros: 1000,
  };
  for (const [details, verified] of [
    [{ cached_tokens: 0 }, true],
    [{ cached_tokens: 80 }, false],
    [
      {
        cached_tokens: 20,
        cache_write_tokens: 80,
        cache_write_tokens_details: { ttl_30m_tokens: 50, ttl_12h_tokens: 30 },
      },
      false,
    ],
    [{ cached_tokens: 80, cache_write_tokens: 21 }, null],
    [
      {
        cache_write_tokens: 10,
        cache_write_tokens_details: { ttl_30m_tokens: 10, ttl_12h_tokens: 1 },
      },
      null,
    ],
  ]) {
    const provider = new BoundedAuthoringTextProvider(
      definition,
      'synthetic-only',
      async () =>
        new Response(
          JSON.stringify({
            id: 'fixture',
            status: 'completed',
            service_tier: 'default',
            usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: details },
            output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      profile,
    );
    const generate = () =>
      provider.generate({
        jobId: randomUUID(),
        context: { contextHash: 'fixture' },
        signal: new AbortController().signal,
        maxCostMicros: 1000,
      });
    if (verified === null)
      await assert.rejects(generate(), (error) => error.code === 'PROVIDER_USAGE_UNKNOWN');
    else {
      const result = await generate();
      assert.equal(result.usage.costVerifiedForSparks, verified);
      assert.equal(result.usage.costMicros, 15);
      assert.equal(result.usage.cachedInputTokens, details.cached_tokens ?? 0);
      assert.equal(result.usage.cacheWriteInputTokens, details.cache_write_tokens ?? 0);
    }
  }
});

for (const mode of ['mixed-disabled', 'mixed-missing'])
  test(`enabled requester cannot bypass charging via ${mode} sponsor wallet`, async () => {
    const f = fixture(true, mode);
    const { NpcSponsorship } = require('../../apps/api/dist/ai/sponsorship');
    const original = NpcSponsorship.prototype.validate;
    const sponsor = randomUUID();
    let validations = 0;
    NpcSponsorship.prototype.validate = async () => {
      validations++;
      return sponsor;
    };
    try {
      const wallet = await f.db.query('SELECT enabled FROM spark_wallets WHERE owner_id=$1', [
        sponsor,
      ]);
      assert.equal(wallet[0]?.enabled ?? false, false);
      await assert.rejects(
        f.engine.queue({
          scope: { ...f.scope, subjectKind: 'player', purpose: 'intent' },
          context: f.context,
          operationId: randomUUID(),
          sponsorId: randomUUID(),
        }),
        (error) => error.getResponse().code === 'SPARK_SPONSOR_POLICY_REQUIRED',
      );
      assert.equal(validations, 0);
      assert.equal(f.state.jobs.length, 0);
      assert.equal(f.state.holds.length, 0);
      assert.equal(f.state.balance, 1000n);
      assert.equal(f.state.credits, 50);
      assert.equal(f.state.calls, 0);
    } finally {
      NpcSponsorship.prototype.validate = original;
      f.restore();
    }
  });

test('both Responses adapters settle explicitly priced disjoint cache categories and pin request TTL', async () => {
  const { OpenAiNpcProvider } = require('../../apps/api/dist/ai/openai-provider');
  const {
    BoundedAuthoringTextProvider,
  } = require('../../apps/api/dist/live-test/authoring-provider');
  const cachePricing = {
    cachedInputMicrosPerMillion: 10000,
    cacheWrite30mMicrosPerMillion: 125000,
    cacheWrite12hMicrosPerMillion: 250000,
  };
  const cfg = {
    enabled: true,
    apiKey: 'synthetic-only',
    model: 'synthetic',
    version: 'v1',
    contextTokens: 1000,
    maxInputBytes: 64000,
    maxOutputTokens: 100,
    maxResponseBytes: 64000,
    inputMicrosPerMillion: 100000,
    outputMicrosPerMillion: 500000,
    upperMicros: 1000,
    cachePricing,
  };
  const definition = {
    version: 'v1',
    schema: { type: 'object' },
    instructions: 'Synthetic',
    validateProposal: (x) => x,
  };
  for (const [details, expected] of [
    [{ cached_tokens: 80, cache_write_tokens: 0 }, 8],
    [{ cached_tokens: 0, cache_write_tokens: 80 }, 17],
    [
      {
        cached_tokens: 20,
        cache_write_tokens: 80,
        cache_write_tokens_details: { ttl_30m_tokens: 50, ttl_12h_tokens: 30 },
      },
      19,
    ],
    [undefined, null],
    [{}, null],
    [{ cached_tokens: 0 }, null],
    [{ cache_write_tokens: 0 }, null],
    [{ cached_tokens: 0, cache_write_tokens: 0 }, 15],
    [{ cached_tokens: 0, cache_write_tokens: 101 }, null],
    [
      {
        cache_write_tokens: 80,
        cache_write_tokens_details: { ttl_30m_tokens: 50, ttl_12h_tokens: 31 },
      },
      null,
    ],
  ])
    for (const kind of ['npc', 'authoring']) {
      let bodies = [];
      const transport = async (_url, opts) => {
        bodies.push(JSON.parse(opts.body));
        return new Response(
          JSON.stringify({
            id: 'fixture',
            status: 'completed',
            service_tier: 'default',
            usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: details },
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: JSON.stringify({ text: 'Hello' }) }],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      };
      const provider =
        kind === 'npc'
          ? new OpenAiNpcProvider(cfg, transport)
          : new BoundedAuthoringTextProvider(definition, 'synthetic-only', transport, cfg);
      const request = {
        jobId: randomUUID(),
        purpose: 'speech',
        context: { contextHash: 'fixture', replyLocale: 'en' },
        signal: new AbortController().signal,
        maxCostMicros: 100000,
      };
      if (expected === null)
        await assert.rejects(
          provider.generate(request),
          (e) => e.code === 'PROVIDER_USAGE_UNKNOWN',
        );
      else {
        const result = await provider.generate(request);
        assert.equal(result.usage.costMicros, expected);
        assert.equal(result.usage.costVerifiedForSparks, true);
      }
      assert.deepEqual(bodies[0].prompt_cache_options, { mode: 'implicit', ttl: '30m' });
      assert.equal(bodies[0].service_tier, 'default');
    }
  const original = new OpenAiNpcProvider(cfg);
  const changed = new OpenAiNpcProvider({
    ...cfg,
    cachePricing: { ...cachePricing, cachedInputMicrosPerMillion: 10001 },
  });
  assert.notEqual(original.version, changed.version);
  const legacy = { ...cfg };
  delete legacy.cachePricing;
  assert.equal(
    new OpenAiNpcProvider(legacy).version,
    new OpenAiNpcProvider({ ...legacy, cachePricing: undefined }).version,
  );
});

test('cache tariffs are copied immutably and changed tariffs reject old quote snapshots before transport', async () => {
  const { OpenAiNpcProvider } = require('../../apps/api/dist/ai/openai-provider');
  const {
    BoundedAuthoringTextProvider,
  } = require('../../apps/api/dist/live-test/authoring-provider');
  const cachePricing = {
    cachedInputMicrosPerMillion: 10000,
    cacheWrite30mMicrosPerMillion: 125000,
    cacheWrite12hMicrosPerMillion: 250000,
  };
  const profile = {
    enabled: true,
    apiKey: 'synthetic-only',
    model: 'synthetic',
    version: 'v1',
    contextTokens: 100000,
    maxInputBytes: 64000,
    maxOutputTokens: 100,
    maxResponseBytes: 64000,
    inputMicrosPerMillion: 100000,
    outputMicrosPerMillion: 500000,
    upperMicros: 100000,
    cachePricing,
    estimation: {
      kind: 'operator_heuristic',
      textTokensPerKiBUtf8: 1024,
      textProtocolTokens: 100,
      marginBps: 1000,
      fixedMarginMicros: 100,
    },
    pricing: {
      source: 'synthetic',
      reviewedAt: new Date(Date.now() - 1000).toISOString(),
      validUntil: new Date(Date.now() + 60000).toISOString(),
    },
  };
  const context = { contextHash: 'fixture', replyLocale: 'en' };
  let calls = 0;
  const transport = async () => {
    calls++;
    throw Error('must not dispatch');
  };
  const definition = {
    version: 'v1',
    schema: { type: 'object' },
    instructions: 'Synthetic',
    validateProposal: (x) => x,
  };
  for (const kind of ['npc', 'authoring']) {
    const make = (p) =>
      kind === 'npc'
        ? new OpenAiNpcProvider(p, transport)
        : new BoundedAuthoringTextProvider(definition, 'synthetic-only', transport, p);
    const original = make(profile);
    const prepare = (p) =>
      kind === 'npc' ? p.prepareTextRequest('speech', context) : p.prepareTextRequest(context);
    const snapshot = prepare(original).snapshot;
    const oldRate = cachePricing.cachedInputMicrosPerMillion;
    cachePricing.cachedInputMicrosPerMillion++;
    assert.equal(prepare(original).snapshot.cachePricing.cachedInputMicrosPerMillion, oldRate);
    const changed = make(profile);
    await assert.rejects(
      changed.generate({
        jobId: randomUUID(),
        purpose: 'speech',
        context,
        signal: new AbortController().signal,
        maxCostMicros: 100000,
        textReservationSnapshot: snapshot,
      }),
      (e) => e.code === 'PROVIDER_REQUEST_SNAPSHOT_CHANGED',
    );
  }
  assert.equal(calls, 0);
});

test('NPC replay displays the persisted legacy hold rather than repricing provider micros', async () => {
  const f = fixture();
  try {
    const { input, job } = await f.admit();
    // A historical hold remains 100 subunits for the same 100-micro provider reserve.
    f.state.holds[0].reserved_subunits = '100';
    f.state.holds[0].spark_rate_version = 'api-cent-1-spark-v1';
    f.state.held = 100n;
    const replay = await f.engine.queue(input);
    assert.equal(replay.id, job.id);
    assert.equal(replay.sparkReservedSubunits, '100');
    assert.equal(f.state.holds.length, 1);
  } finally {
    f.restore();
  }
});

test('a valid round consideration with blocked remote whisper settles known usage and does not poison later replies', async () => {
  const f = fixture();
  try {
    const { job } = await f.admit();
    await f.engine.run(job.id, async () => true);
    const g = require('../../packages/game-core/dist');
    const { GameService } = require('../../apps/api/dist/game/game.service');
    const draft = g.createAuthoredDraft('courtyard');
    draft.npcBehavior = 'reactive-v1';
    draft.turnRules = g.turnRulesSchema.parse({});
    let state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice']);
    state.maps.courtyard.blocked = [];
    Object.assign(state.entities.keeper, { x: 13, y: 10 });
    Object.assign(state.entities.alice, { x: 9, y: 9 });
    state = g.endPlayerTurn(state, 'alice', g.turnFence(state)).state;
    const npc = state.entities.keeper,
      brain = state.npcBrains.keeper;
    const context = {
      ...g.buildNpcDecisionContext(state, 'keeper'),
      turnFence: g.turnFence(state),
      worldRoundDecision: {
        ...g.turnFence(state),
        npcId: 'keeper',
        entityRevision: npc.revision,
        brainGeneration: brain.generation,
        mapId: npc.mapId,
        mapRevision: state.maps[npc.mapId].revision,
      },
    };
    const proposal = {
      ...g.createMockNpcPlan(state, 'keeper'),
      actions: [
        { kind: 'communicate', channel: 'whisper', targetId: 'alice', observationIds: ['missing'] },
      ],
      targetRevisions: { alice: state.entities.alice.revision },
      cognition: {
        motive: 'Ask quietly.',
        belief: 'The visitor may know.',
        intent: 'Talk.',
        innerThought: 'I should ask.',
        reconsiderAfterRounds: 1,
      },
      knowledgeRevision: brain.living.knowledgeRevision,
    };
    const game = Object.create(GameService.prototype);
    const considered = await game.evaluateDecision('synthetic', state, {
      id: job.id,
      npcId: 'keeper',
      purpose: 'plan',
      context,
      contextHash: context.contextHash,
      proposal,
    });
    assert.equal(considered.accepted, true);
    assert.equal(considered.decisionCode, 'NPC_INTENTION_BLOCKED:TARGET_UNAVAILABLE');
    await f.db.tx((c) => f.engine.finalize(c, job.id, considered.accepted ? 'committed' : 'stale'));
    assert.equal(f.state.jobs[0].status, 'committed');
    assert.equal(f.state.holds[0].status, 'settled');
    assert.equal(f.state.held, 0n);
    assert.equal(f.state.balance, 940n);
    assert.equal(f.state.calls, 1);
    assert.deepEqual(considered.next.npcUtterances, state.npcUtterances);
    assert.deepEqual(considered.next.npcBrains.keeper.plan, []);
  } finally {
    f.restore();
  }
});
