// Targeted isolated Sparks tests. No existing database, application, provider or credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const {
  planSparkSettlement,
  SparksAccounting,
  sparkTextActual,
} = require('../../apps/api/dist/generation/sparks-accounting');
const { validateProviderResult } = require('../../apps/api/dist/ai/provider');
const {
  createSparkTariffSnapshot,
  LEGACY_SPARK_RATE_VERSION,
  SPARK_RATE_VERSION,
} = require('../../packages/contracts/dist/sparks');
const tariff = createSparkTariffSnapshot({
  provider: 'fixture',
  model: 'fixture',
  providerRateVersion: 'v1',
  inputMicrosPerMillion: '100000',
  cachedInputMicrosPerMillion: '10000',
  outputMicrosPerMillion: '500000',
});
const hold = (extra = {}) => ({
  id: randomUUID(),
  owner_id: randomUUID(),
  source_kind: 'text',
  source_id: 'fixture',
  reserved_subunits: '100',
  captured_subunits: null,
  status: 'held',
  settlement_fingerprint: null,
  spark_rate_version: LEGACY_SPARK_RATE_VERSION,
  ...extra,
});
const success = (actualMicros) => ({
  outcome: 'success',
  actualMicros,
  evidence: 'configured_rates',
  receiptId: 'fixture-receipt',
});

test('exact usage capture releases surplus; replay agrees and mismatched settlement rejects', () => {
  const h = hold(),
    plan = planSparkSettlement(h, success('1'));
  assert.equal(plan.captured, '1');
  assert.equal(plan.released, '99');
  assert.equal(
    planSparkSettlement(
      { ...h, status: 'settled', captured_subunits: '1', settlement_fingerprint: plan.fingerprint },
      success('1'),
    ).duplicate,
    true,
  );
  assert.throws(
    () =>
      planSparkSettlement(
        { ...h, status: 'settled', settlement_fingerprint: plan.fingerprint },
        success('2'),
      ),
    /CONFLICT/,
  );
});
test('new rate doubles only new-version holds; legacy, missing and overruns cannot overcharge', () => {
  assert.equal(planSparkSettlement(hold(), success('50')).captured, '50');
  const current = hold({ spark_rate_version: SPARK_RATE_VERSION });
  assert.equal(planSparkSettlement(current, success('50')).captured, '100');
  assert.equal(planSparkSettlement(current, success('51')).reason, 'reserve_exceeded');
  assert.throws(
    () => planSparkSettlement(hold({ spark_rate_version: undefined }), success('1')),
    /RATE_UNSUPPORTED/,
  );
  const plan = planSparkSettlement(current, success('1'));
  assert.equal(
    planSparkSettlement(
      { ...current, status: 'settled', settlement_fingerprint: plan.fingerprint },
      success('1'),
    ).duplicate,
    true,
  );
});
test('unknown and unresolved failure preserve liability; resolution requires explicit reconciliation', () => {
  for (const outcome of ['unknown', 'failure_policy_pending']) {
    const plan = planSparkSettlement(hold(), { outcome, receiptId: 'fixture' });
    assert.equal(plan.pending, true);
    assert.equal(plan.captured, undefined);
    assert.equal(plan.released, undefined);
  }
  assert.throws(
    () => planSparkSettlement(hold({ status: 'pending' }), success('1')),
    /RECONCILIATION_REQUIRED/,
  );
  assert.equal(planSparkSettlement(hold({ status: 'pending' }), success('1'), true).captured, '1');
});
test('overrun cannot capture or release, zero-dispatch and application cache cost zero', () => {
  assert.equal(planSparkSettlement(hold(), success('101')).reason, 'reserve_exceeded');
  for (const outcome of ['not_dispatched', 'application_cache']) {
    const plan = planSparkSettlement(hold(), { outcome, receiptId: 'fixture' });
    assert.equal(plan.captured, '0');
    assert.equal(plan.released, '100');
  }
  assert.throws(() => planSparkSettlement(hold(), success('9223372036854775808')), /bigint/);
});
test('cache-aware immutable rate meter separates cached input, and validates provider evidence', () => {
  assert.equal(
    sparkTextActual(tariff, { inputTokens: '1000', cachedInputTokens: '800', outputTokens: '10' }),
    '66',
  );
  const value = {
    proposal: {},
    requestId: 'fixture',
    usage: { inputTokens: 10, cachedInputTokens: 5, outputTokens: 1, costMicros: 2 },
  };
  assert.equal(validateProviderResult(value).usage.cachedInputTokens, 5);
  for (const cache of [-1, 11, 1.5])
    assert.throws(() =>
      validateProviderResult({ ...value, usage: { ...value.usage, cachedInputTokens: cache } }),
    );
});

test('Responses adapter retains cached usage but never invents a discount for old quotes', async () => {
  const { OpenAiNpcProvider } = require('../../apps/api/dist/ai/openai-provider');
  const config = {
    enabled: true,
    apiKey: 'synthetic-only',
    model: 'synthetic-model',
    version: 'fixture-v1',
    maxInputBytes: 64000,
    maxOutputTokens: 100,
    maxResponseBytes: 64000,
    inputMicrosPerMillion: 100000,
    outputMicrosPerMillion: 500000,
  };
  const request = {
    jobId: randomUUID(),
    purpose: 'speech',
    context: { contextHash: 'fixture', replyLocale: 'en' },
    signal: new AbortController().signal,
    maxCostMicros: 100000,
  };
  const response = (cached) =>
    new Response(
      JSON.stringify({
        id: 'fixture-receipt',
        status: 'completed',
        service_tier: 'default',
        usage: {
          input_tokens: 100,
          output_tokens: 10,
          input_tokens_details: { cached_tokens: cached },
        },
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: JSON.stringify({ text: 'Hello' }) }],
          },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const result = await new OpenAiNpcProvider(config, async () => response(80)).generate(request);
  assert.equal(result.usage.cachedInputTokens, 80);
  assert.equal(result.usage.costMicros, 15); // Existing no-cache tariff is unchanged.
  assert.equal(result.usage.costEvidence, 'configured_rates');
  await assert.rejects(
    new OpenAiNpcProvider(config, async () => response(101)).generate(request),
    (error) => error.code === 'PROVIDER_USAGE_UNKNOWN' && error.uncertain,
  );
  assert.throws(() => planSparkSettlement(hold(), { outcome: 'made_up', receiptId: 'fixture' }));
});

test(
  'disposable PostgreSQL: disabled/zero provenance, concurrency, immutable quote, once-only capture and unknown holds',
  { timeout: 90000 },
  async () => {
    const net = require('node:net');
    const { once } = require('node:events');
    const { Pool } = require('pg');
    const { startLocalPostgres } = await import('../../scripts/postgres-local.mjs');
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    process.env.NODE_ENV = 'test';
    process.env.LOCAL_POSTGRES_CLUSTER = 'sparks-' + randomUUID();
    process.env.LOCAL_POSTGRES_PORT = String(port);
    delete process.env.DATABASE_URL;
    const db = await startLocalPostgres();
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    const accounting = new SparksAccounting();
    async function tx(work) {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const result = await work(c);
        await c.query('COMMIT');
        return result;
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      } finally {
        c.release();
      }
    }
    const owner = randomUUID();
    const quoteInput = (sourceId, reserve = '60') => ({
      ownerId: owner,
      operationId: randomUUID(),
      sourceKind: 'text',
      sourceId,
      reserveSubunits: reserve,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      tariff,
      providerQuote: { version: 'fixture-v1', reserveMicros: reserve },
    });
    try {
      await pool.query(
        'CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE npc_ai_jobs(id uuid PRIMARY KEY,input_tokens integer); CREATE TABLE npc_ai_quotes(id uuid PRIMARY KEY); CREATE TABLE generation_text_counts(id uuid PRIMARY KEY); CREATE TABLE generation_budget_reservations(id uuid PRIMARY KEY); CREATE TABLE image_generation_quotes(id uuid PRIMARY KEY); CREATE TABLE image_generation_jobs(id uuid PRIMARY KEY); CREATE TABLE live_test_text_permits(id uuid PRIMARY KEY); CREATE TABLE live_authoring_text_quotes(id uuid PRIMARY KEY); CREATE TABLE live_authoring_text_jobs(id uuid PRIMARY KEY);',
      );
      await pool.query(await readFile('packages/db/migrations/042_sparks_accounting.sql', 'utf8'));
      await pool.query('INSERT INTO users(id) VALUES($1)', [owner]);
      await tx((c) => accounting.ensureWallet(c, owner));
      let wallet = (await pool.query('SELECT * FROM spark_wallets')).rows[0];
      assert.equal(wallet.enabled, false);
      assert.equal(wallet.balance_subunits, '0');
      await assert.rejects(
        tx((c) => accounting.quote(c, quoteInput('disabled'))),
        /DISABLED/,
      );
      // Explicit synthetic fixture funding only, confined to this freshly created disposable cluster.
      await pool.query(
        'UPDATE spark_wallets SET enabled=true,balance_subunits=100 WHERE owner_id=$1',
        [owner],
      );
      const legacyInput = quoteInput('legacy-inflight', '20');
      legacyInput.tariff = createSparkTariffSnapshot({
        ...tariff,
        sparkRateVersion: LEGACY_SPARK_RATE_VERSION,
      });
      const legacyQuote = await tx((c) => accounting.quote(c, legacyInput));
      await tx((c) => accounting.reserve(c, owner, legacyQuote.id));
      await tx((c) => accounting.settle(c, owner, legacyQuote.id, success('1')));
      assert.equal(
        (
          await pool.query('SELECT captured_subunits FROM spark_holds WHERE id=$1', [
            legacyQuote.id,
          ])
        ).rows[0].captured_subunits,
        '1',
      );
      const missingRateId = randomUUID();
      await pool.query(
        "INSERT INTO spark_quotes(id,owner_id,operation_id,request_hash,source_kind,source_id,price_snapshot,reserve_subunits,expires_at) VALUES($1,$2,$3,'fixture','text','missing-rate','{}',10,now()+interval '1 minute')",
        [missingRateId, owner, randomUUID()],
      );
      await assert.rejects(
        tx((c) => accounting.reserve(c, owner, missingRateId)),
        /RATE_UNSUPPORTED/,
      );
      const futureRateId = randomUUID();
      await pool.query(
        "INSERT INTO spark_quotes(id,owner_id,operation_id,request_hash,source_kind,source_id,price_snapshot,reserve_subunits,expires_at) VALUES($1,$2,$3,'fixture','text','future-rate',$4,10,now()+interval '1 minute')",
        [
          futureRateId,
          owner,
          randomUUID(),
          JSON.stringify({ tariff: { sparkRateVersion: 'future' } }),
        ],
      );
      await assert.rejects(
        tx((c) => accounting.reserve(c, owner, futureRateId)),
        /RATE_UNSUPPORTED/,
      );
      const input = quoteInput('first');
      const q1 = await tx((c) => accounting.quote(c, input));
      assert.equal((await tx((c) => accounting.quote(c, input))).id, q1.id);
      await assert.rejects(
        tx((c) => accounting.quote(c, { ...input, reserveSubunits: '59' })),
        /CONFLICT/,
      );
      const q2 = await tx((c) => accounting.quote(c, quoteInput('second')));
      const outcomes = await Promise.allSettled([
        tx((c) => accounting.reserve(c, owner, q1.id)),
        tx((c) => accounting.reserve(c, owner, q2.id)),
      ]);
      assert.equal(outcomes.filter((x) => x.status === 'fulfilled').length, 1);
      assert.match(outcomes.find((x) => x.status === 'rejected').reason.message, /INSUFFICIENT/);
      const reserved = outcomes.find((x) => x.status === 'fulfilled').value;
      await tx((c) => accounting.reserve(c, owner, reserved.id));
      await assert.rejects(
        pool.query('UPDATE spark_quotes SET reserve_subunits=1 WHERE id=$1', [reserved.id]),
        /immutable/,
      );
      await Promise.all([
        tx((c) => accounting.settle(c, owner, reserved.id, success('1'))),
        tx((c) => accounting.settle(c, owner, reserved.id, success('1'))),
      ]);
      wallet = (await pool.query('SELECT * FROM spark_wallets')).rows[0];
      assert.equal(wallet.balance_subunits, '97');
      assert.equal(wallet.held_subunits, '0');
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int n FROM spark_ledger WHERE kind='capture' AND amount_subunits>1",
          )
        ).rows[0].n,
        1,
      );
      const unknownQuote = await tx((c) => accounting.quote(c, quoteInput('unknown', '40')));
      await tx((c) => accounting.reserve(c, owner, unknownQuote.id));
      await tx((c) =>
        accounting.settle(c, owner, unknownQuote.id, { outcome: 'unknown', receiptId: 'missing' }),
      );
      wallet = (await pool.query('SELECT * FROM spark_wallets')).rows[0];
      assert.equal(wallet.balance_subunits, '97');
      assert.equal(wallet.held_subunits, '40');
      await assert.rejects(
        tx((c) => accounting.settle(c, owner, unknownQuote.id, success('2'))),
        /RECONCILIATION/,
      );
      await tx((c) => accounting.settle(c, owner, unknownQuote.id, success('2'), true));
      wallet = (await pool.query('SELECT * FROM spark_wallets')).rows[0];
      assert.equal(wallet.balance_subunits, '93');
      assert.equal(wallet.held_subunits, '0');
      await assert.rejects(pool.query('DELETE FROM spark_ledger'), /immutable/);
      await assert.rejects(
        pool.query('UPDATE spark_holds SET reserved_subunits=1 WHERE id=$1', [unknownQuote.id]),
        /immutable/,
      );
    } finally {
      await pool.end();
      await db.stop();
    }
  },
);

test('image authoring shows equivalents, keeps consent/caps, and separates admin settings from ordinary authorization', async () => {
  const helper = await readFile('apps/web/components/visual-authoring/sparks-cost.tsx', 'utf8');
  for (const phrase of [
    'не списание и не резерв кошелька',
    'not wallet charges or wallet holds',
    'не списання й не резерв гаманця',
  ])
    assert.ok(helper.includes(phrase));
  const equivalent = await readFile(
    'apps/web/components/visual-authoring/spark-equivalent.ts',
    'utf8',
  );
  assert.match(equivalent, /Number\.isSafeInteger/);
  assert.match(equivalent, /providerMicrosToSparkSubunits\(String\(micros\), rateVersion\)/);
  assert.match(helper, /providerSparkSubunits\(micros, rateVersion\)/);
  assert.match(helper, /formatSparkSubunits\(subunits, locale, 'exact'\)/);
  const inline = await readFile(
    'apps/web/components/visual-authoring/location-image-inline.tsx',
    'utf8',
  );
  assert.match(inline, /reserve > generationRemaining/);
  assert.match(inline, /!quoteCurrent/);
  assert.match(inline, /attested: true/);
  assert.match(inline, /<ImageConfirmation/);
  assert.match(inline, /cancelledQuotes\.current\.has\(confirmedQuoteId\)/);
  assert.match(inline, /confirmedQuoteId !== quote\?\.quote\.id/);
  assert.match(inline, /consent: true/);
  assert.match(inline, /\{m\('library'\)\}/);
  assert.doesNotMatch(inline, /formatUsd|m\('settings'\)/);
  const dialog = await readFile('apps/web/components/visual-authoring/location-image.tsx', 'utf8');
  assert.match(dialog, /user\?\.role === 'admin' && <LiveTestPanel/);
  const images = await readFile('apps/web/components/assets/image-generation.tsx', 'utf8');
  assert.match(images, /useLiveTestStatus\(\)/);
  assert.match(images, /user\?\.role === 'admin' &&/);
  assert.match(images, /SparkQuoteNotice/);
  assert.match(helper, /SparksEquivalentNotice/);
  assert.match(images, /quoteBudgetAvailable/);
  assert.match(images, /<ImageConfirmation/);
  assert.match(images, /confirmedQuoteId !== quote\?\.id/);
  assert.match(images, /consent: true/);
  assert.doesNotMatch(images, /g\('usd'\)/);
});
