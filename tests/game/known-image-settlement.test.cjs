/** Source-backed synthetic tests, no database/provider and no generated dist dependency. */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
    }).outputText,
    filename,
  );
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  knownImageSettlementQuote,
  knownImageReceipt,
} = require('../../apps/api/src/image-generation/known-settlement.ts');
const {
  imageKnownCostPolicy,
  imageKnownCostConsentMatches,
} = require('../../apps/api/src/image-generation/settlement-policy.ts');
const { digest } = require('../../apps/api/src/ai/context.ts');
const { sparkTariff } = require('../../apps/api/src/generation/sparks-hooks.ts');
const {
  planSparkSettlement,
  DREAMS_FIRST_POLICY,
} = require('../../apps/api/src/generation/sparks-accounting.ts');
const { planDreamSettlement } = require('../../apps/api/src/generation/dreams-accounting.ts');
function fixture(split = false) {
  const owner = randomUUID(),
    id = randomUUID(),
    nativeId = randomUUID(),
    holdId = randomUUID();
  const profile = {
    model: 'synthetic-image',
    inputTextMicrosPerMillion: 100000,
    inputImageMicrosPerMillion: 200000,
    outputImageMicrosPerMillion: 300000,
  };
  profile.fingerprint = digest(profile);
  profile.id = `image-profile-v1:${profile.fingerprint}`;
  const estimate = { reserveMicros: 3000 };
  estimate.fingerprint = digest(estimate);
  estimate.id = `image-estimate-v1:${estimate.fingerprint}`;
  const input = {
    adventureId: randomUUID(),
    prompt: 'synthetic',
    automaticKnownCostPolicy: 'known-cost-v1',
    title: 'Synthetic',
    kind: 'portrait',
    camera: 'portrait',
    tags: [],
    background: 'opaque',
    referenceRevisionIds: [],
    privateReferenceAssetIds: [],
    rights: {
      basis: 'generated',
      licenseLabel: 'fixture',
      attribution: '',
      allowAuthorReuse: false,
      attested: true,
    },
    mode: 'external',
  };
  const job = {
    id,
    actor_id: owner,
    adventure_id: input.adventureId,
    operation_id: randomUUID(),
    quote_id: nativeId,
    reservation_id: randomUUID(),
    spark_quote_id: holdId,
    mode: 'external',
    status: 'rejected',
    error_code: 'ADMISSION_REJECTED',
    input,
    reference_hashes: {},
    policy_version: 'fixture-policy',
    cost_basis: 'approved_estimate',
    generation_policy_revision: 1,
    generation_policy_hash: digest('policy'),
    upper_micros: '3000',
    actual_micros: '743',
    spark_cost_verified: true,
    dispatched_at: new Date(),
    provider_request_id: 'req_fixture',
    pricing_profile_snapshot: profile,
    estimate_snapshot: estimate,
  };
  job.request_hash = digest({
    input,
    refs: {},
    policy: job.policy_version,
    provider: 'fixture-provider',
    upper: 3000,
    estimateSnapshotHash: estimate.fingerprint,
    pricingProfileHash: profile.fingerprint,
    policyRevision: 1,
    policyHash: job.generation_policy_hash,
  });
  const native = { ...structuredClone(job), id: nativeId };
  const authorization = {
    id: randomUUID(),
    owner_id: owner,
    mode: 'release',
    scope_id: `release:${owner}`,
  };
  const attempt = {
    job_id: id,
    dispatch_id: randomUUID(),
    provider: 'fixture-provider',
    dispatched_at: new Date(),
    result_received_at: new Date(),
    request_hash: job.request_hash,
    provider_request_id: job.provider_request_id,
    actual_micros: '743',
  };
  const reservation = {
    id: job.reservation_id,
    actor_id: owner,
    scope_id: authorization.scope_id,
    kind: 'image',
    operation_key: id,
    status: 'settled',
    upper_micros: '3000',
    actual_micros: '743',
    spark_quote_id: holdId,
  };
  const hold = {
    id: holdId,
    owner_id: owner,
    source_kind: 'image',
    source_id: nativeId,
    status: 'pending',
    reason: 'failure_policy_pending',
    reserved_subunits: '6000',
    sparks_reserved_subunits: split ? '5000' : '6000',
    captured_subunits: null,
    settlement_fingerprint: null,
    dream_hold_id: split ? randomUUID() : null,
  };
  const price_snapshot = {
    rateVersion: 'api-cent-2-sparks-v2',
    tariff: sparkTariff(
      { model: profile.model, inputMicrosPerMillion: 100000, outputMicrosPerMillion: 300000 },
      attempt.provider,
      profile.fingerprint,
    ),
    providerQuote: {
      quoteId: nativeId,
      requestHash: job.request_hash,
      pricingProfile: profile,
      estimate,
      settlement: 'actual-image-micros',
      automaticKnownCostPolicy: 'known-cost-v1',
      automaticKnownCostPolicyHash: imageKnownCostPolicy({
        quoteId: nativeId,
        requestHash: job.request_hash,
        reserveMicros: job.upper_micros,
        costBasis: job.cost_basis,
      }).fingerprint,
    },
    ...(split ? { fundingPolicy: DREAMS_FIRST_POLICY } : {}),
  };
  const quote = {
    id: holdId,
    owner_id: owner,
    source_kind: 'image',
    source_id: nativeId,
    operation_id: nativeId,
    reserve_subunits: '6000',
    price_snapshot,
  };
  const dreams = split
    ? {
        hold: {
          id: hold.dream_hold_id,
          owner_id: owner,
          source_kind: 'image',
          source_id: nativeId,
          status: 'pending',
          reason: 'unknown',
          reserved_subunits: '1000',
          captured_subunits: null,
          settlement_fingerprint: null,
        },
        quote: {
          id: hold.dream_hold_id,
          owner_id: owner,
          source_kind: 'image',
          source_id: nativeId,
          operation_id: holdId,
          reserve_subunits: '1000',
          price_snapshot: {
            currency: 'dreams',
            policyVersion: DREAMS_FIRST_POLICY,
            providerQuote: { sparkQuoteId: holdId, priceSnapshot: price_snapshot },
          },
        },
      }
    : undefined;
  return { job, native, authorization, attempt, reservation, hold, quote, dreams };
}
const reject = (p) =>
  assert.throws(() => knownImageSettlementQuote(p), /IMAGE_SETTLEMENT_PROOF_UNAVAILABLE/);
test('verified rejected image captures original known cost and releases remainder', () => {
  const p = fixture();
  const view = knownImageSettlementQuote(p);
  assert.equal(view.actualMicros, '743');
  assert.equal(view.captureSubunits, '1486');
  assert.equal(view.releaseSubunits, '4514');
  assert.equal(view.terminal, false);
});
for (const status of ['generated', 'admitted', 'rejected', 'cancelled'])
  test(`known ${status} receipt is eligible under explicit admitted policy`, () => {
    const p = fixture();
    p.job.status = status;
    assert.equal(knownImageSettlementQuote(p).actualMicros, '743');
  });
for (const [name, mutate] of [
  ['missing explicit verification', (p) => delete p.job.spark_cost_verified],
  ['unverified', (p) => (p.job.spark_cost_verified = false)],
  ['unknown job', (p) => (p.job.status = 'unknown')],
  ['erased', (p) => (p.job.error_code = 'ERASED')],
  ['erased input', (p) => (p.job.input = {})],
  ['attempt identity', (p) => (p.attempt.request_hash = 'other')],
  ['attempt receipt', (p) => (p.attempt.provider_request_id = 'req_other')],
  ['missing result', (p) => (p.attempt.result_received_at = null)],
  ['attempt cost', (p) => (p.attempt.actual_micros = '700')],
  ['quote identity', (p) => (p.native.spark_quote_id = randomUUID())],
  ['native request', (p) => (p.native.input.prompt = 'changed')],
  ['reservation scope', (p) => (p.reservation.scope_id = 'other')],
  ['reservation binding', (p) => (p.reservation.operation_key = randomUUID())],
  ['reservation unknown', (p) => (p.reservation.status = 'held')],
  ['cost mismatch', (p) => (p.reservation.actual_micros = '0')],
  [
    'overrun',
    (p) => {
      p.job.actual_micros = p.attempt.actual_micros = p.reservation.actual_micros = '3001';
    },
  ],
  [
    'unsupported rate',
    (p) =>
      (p.quote.price_snapshot.tariff = {
        ...p.quote.price_snapshot.tariff,
        sparkRateVersion: 'unknown',
      }),
  ],
  [
    'wrong tariff',
    (p) =>
      (p.quote.price_snapshot.tariff = {
        ...p.quote.price_snapshot.tariff,
        outputMicrosPerMillion: '0',
      }),
  ],
  ['missing snapshot', (p) => delete p.quote.price_snapshot.providerQuote.pricingProfile],
  ['foreign owner', (p) => (p.hold.owner_id = randomUUID())],
  ['held not pending', (p) => (p.hold.status = 'held')],
  ['reserve exceeded reason', (p) => (p.hold.reason = 'reserve_exceeded')],
  ['different capture', (p) => (p.hold.captured_subunits = '1')],
  [
    'changed reserve',
    (p) => {
      p.hold.reserved_subunits = p.quote.reserve_subunits = '7000';
    },
  ],
])
  test(`retains ${name}`, () => {
    const p = fixture();
    mutate(p);
    reject(p);
  });
test('exact original successful receipt remains idempotent', () => {
  const p = fixture(),
    v = knownImageSettlementQuote(p),
    plan = planSparkSettlement(
      { ...p.hold, spark_rate_version: 'api-cent-2-sparks-v2' },
      v.receipt,
      true,
    );
  Object.assign(p.hold, {
    status: 'settled',
    reason: null,
    captured_subunits: v.captureSubunits,
    settlement_fingerprint: plan.fingerprint,
  });
  assert.equal(knownImageSettlementQuote(p).terminal, true);
  p.hold.settlement_fingerprint = digest({ ...v.receipt, receiptId: 'manual:other' });
  reject(p);
});
test('split funds require exact Dreams quote and terminalize with same receipt', () => {
  const p = fixture(true),
    v = knownImageSettlementQuote(p);
  const sp = planSparkSettlement(
    { ...p.hold, spark_rate_version: 'api-cent-2-sparks-v2' },
    v.receipt,
    true,
  );
  const dp = planDreamSettlement(
    { ...p.dreams.hold, policy_version: DREAMS_FIRST_POLICY },
    {
      outcome: 'success',
      actualSubunits: '1000',
      policyVersion: DREAMS_FIRST_POLICY,
      evidence: 'configured_rates',
      receiptId: v.receipt.receiptId,
    },
    true,
  );
  Object.assign(p.hold, {
    status: 'settled',
    reason: null,
    captured_subunits: '1486',
    settlement_fingerprint: sp.fingerprint,
  });
  reject(p);
  Object.assign(p.dreams.hold, {
    status: 'settled',
    reason: null,
    captured_subunits: '1000',
    settlement_fingerprint: dp.fingerprint,
  });
  assert.equal(knownImageSettlementQuote(p).terminal, true);
});
for (const field of ['source_id', 'owner_id', 'operation_id'])
  test(`rejects wrong Dreams ${field}`, () => {
    const p = fixture(true);
    p.dreams.quote[field] = randomUUID();
    reject(p);
  });
test('zero cost releases rather than fabricates capture', () => {
  const p = fixture();
  p.job.actual_micros = p.attempt.actual_micros = p.reservation.actual_micros = '0';
  assert.equal(knownImageSettlementQuote(p).captureSubunits, '0');
});
test('receipt matches historic successful image identity', () =>
  assert.equal(knownImageReceipt('id', '0').receiptId, 'image:id'));
test('rejects internally altered historical image pricing signature', () => {
  const p = fixture();
  p.job.pricing_profile_snapshot.inputImageMicrosPerMillion = 1;
  p.native.pricing_profile_snapshot = structuredClone(p.job.pricing_profile_snapshot);
  reject(p);
});
test('historical pre-upgrade conversion is preserved', () => {
  const p = fixture();
  p.quote.price_snapshot.tariff = {
    ...p.quote.price_snapshot.tariff,
    sparkRateVersion: 'api-cent-1-spark-v1',
  };
  p.hold.reserved_subunits = p.hold.sparks_reserved_subunits = p.quote.reserve_subunits = '3000';
  assert.equal(knownImageSettlementQuote(p).captureSubunits, '743');
});
test('source recovery remains bounded and routes external missing verification to pending', () => {
  const source = fs.readFileSync(
    require.resolve('../../apps/api/src/image-generation/service.ts'),
    'utf8',
  );
  assert.match(source, /j\.id>\$1::uuid\) ORDER BY j\.id LIMIT 25/);
  assert.match(source, /nextSettlementRecovery = Date\.now\(\) \+ 30000/);
  assert.match(source, /j\.mode === 'external' && result\.costVerifiedForSparks !== true/);
  assert.match(
    source,
    /result\.costVerifiedForSparks === true && result\.actualMicros !== undefined/,
  );
  assert.equal((source.match(/await settleKnownImageTx\(c,/g) || []).length, 4);
  assert.doesNotMatch(
    fs.readFileSync(
      require.resolve('../../apps/api/src/image-generation/known-settlement.ts'),
      'utf8',
    ),
    /SET state='active'|SET blocked=false|\.generate\(/,
  );
});
function transactionFixture(p) {
  const calls = [],
    events = new Set();
  const c = {
    query: async (sql, args = []) => {
      calls.push({ sql, args });
      let row;
      if (sql.startsWith('SELECT * FROM image_generation_jobs')) row = p.job;
      else if (sql.startsWith('SELECT * FROM generation_budget_reservations')) row = p.reservation;
      else if (sql.startsWith('SELECT * FROM live_test_sessions')) row = p.authorization;
      else if (sql.startsWith('SELECT * FROM image_generation_quotes')) row = p.native;
      else if (sql.startsWith('SELECT * FROM image_generation_attempts')) row = p.attempt;
      else if (sql.startsWith('SELECT owner_id FROM spark_wallets'))
        row = { owner_id: p.job.actor_id };
      else if (sql.startsWith('SELECT * FROM spark_holds')) row = p.hold;
      else if (
        sql.startsWith('SELECT * FROM spark_quotes') ||
        sql.startsWith('SELECT price_snapshot FROM spark_quotes')
      )
        row = p.quote;
      else if (sql.startsWith('UPDATE spark_holds SET status=$2'))
        Object.assign(p.hold, {
          status: args[1],
          captured_subunits: args[2],
          settlement_fingerprint: args[3],
          reason: null,
        });
      else if (sql.startsWith('INSERT INTO spark_ledger')) {
        assert.equal(events.has(args[2]), false);
        events.add(args[2]);
      } else if (
        !sql.startsWith('SELECT pg_advisory') &&
        !sql.startsWith('UPDATE spark_wallets') &&
        !sql.startsWith('INSERT INTO audit')
      )
        throw new Error(`Unexpected SQL ${sql}`);
      return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
    },
  };
  return { c, calls, events };
}
test('transaction retry uses one capture, one release and one audit with fence before wallets', async () => {
  const { settleKnownImageTx } = require('../../apps/api/src/image-generation/known-settlement.ts');
  const p = fixture(),
    { c, calls, events } = transactionFixture(p);
  assert.equal((await settleKnownImageTx(c, p.job.id)).terminal, true);
  assert.equal((await settleKnownImageTx(c, p.job.id)).terminal, true);
  assert.equal(events.size, 2);
  assert.equal(calls.filter((x) => x.sql.startsWith('INSERT INTO audit')).length, 1);
  assert.ok(
    calls.findIndex((x) => x.sql.startsWith('SELECT pg_advisory')) <
      calls.findIndex((x) => x.sql.startsWith('SELECT owner_id FROM spark_wallets')),
  );
});
test('invalid source proof writes nothing and database errors propagate to caller rollback', async () => {
  const { settleKnownImageTx } = require('../../apps/api/src/image-generation/known-settlement.ts');
  const p = fixture();
  p.attempt.provider_request_id = 'req_foreign';
  const { c, calls } = transactionFixture(p);
  assert.equal(await settleKnownImageTx(c, p.job.id), undefined);
  assert.equal(
    calls.some((x) => /^(UPDATE|INSERT)/.test(x.sql)),
    false,
  );
  await assert.rejects(
    () =>
      settleKnownImageTx(
        {
          query: async () => {
            throw new Error('database failure');
          },
        },
        p.job.id,
      ),
    /database failure/,
  );
});
for (const [name, mutate] of [
  ['historical native request', (p) => delete p.job.input.automaticKnownCostPolicy],
  [
    'historical Spark quote',
    (p) => delete p.quote.price_snapshot.providerQuote.automaticKnownCostPolicy,
  ],
  [
    'unsupported policy',
    (p) => (p.quote.price_snapshot.providerQuote.automaticKnownCostPolicy = 'other'),
  ],
  [
    'missing policy acceptance hash',
    (p) => delete p.quote.price_snapshot.providerQuote.automaticKnownCostPolicyHash,
  ],
  [
    'foreign policy hash',
    (p) => (p.quote.price_snapshot.providerQuote.automaticKnownCostPolicyHash = digest('other')),
  ],
])
  test(`never retroactively captures ${name}`, async () => {
    const p = fixture();
    mutate(p);
    reject(p);
    const {
      settleKnownImageTx,
    } = require('../../apps/api/src/image-generation/known-settlement.ts');
    const { c, calls } = transactionFixture(p);
    assert.equal(await settleKnownImageTx(c, p.job.id), undefined);
    assert.equal(
      calls.some((x) => /^(UPDATE|INSERT)/.test(x.sql)),
      false,
    );
  });
test('same consent POST must bind exact policy native quote, reserve, request and risk basis', () => {
  const p = fixture();
  const fingerprint = imageKnownCostPolicy({
    quoteId: p.native.id,
    requestHash: p.native.request_hash,
    reserveMicros: p.native.upper_micros,
    costBasis: p.native.cost_basis,
  }).fingerprint;
  assert.equal(imageKnownCostConsentMatches(p.native, fingerprint), true);
  assert.equal(imageKnownCostConsentMatches(p.native, undefined), false);
  for (const field of ['id', 'request_hash', 'upper_micros', 'cost_basis'])
    assert.equal(
      imageKnownCostConsentMatches({ ...p.native, [field]: 'changed' }, fingerprint),
      false,
    );
});
test('policy is not injected into old input or compound batch consent', () => {
  const source = fs.readFileSync(
    require.resolve('../../apps/api/src/image-generation/service.ts'),
    'utf8',
  );
  assert.match(source, /if \(input\.automaticKnownCostPolicy\) \{/);
  assert.match(
    source,
    /acceptedTravel\s*\? acceptedPolicy\?\.automaticKnownCostPolicyHash\s*:\s*b\.automaticKnownCostPolicyHash/,
  );
  assert.match(source, /if \(!imageKnownCostConsentMatches\(q, acceptedHash\)\)/);
  assert.ok(
    source.indexOf('IMAGE_SETTLEMENT_POLICY_CONSENT_REQUIRED') <
      source.indexOf('INSERT INTO image_generation_jobs'),
  );
  assert.match(source, /j\.input->>'automaticKnownCostPolicy'='known-cost-v1'/);
  assert.match(
    source,
    /q\.price_snapshot->'providerQuote'->>'automaticKnownCostPolicy'='known-cost-v1'/,
  );
});
test('visual authoring wrappers accept explicit policy and forward it without defaults', () => {
  const {
    visualGenerationQuoteSchema,
    visualGenerationDispatchSchema,
  } = require('../../packages/contracts/src/game/visual-authoring.ts');
  const base = { operationId: randomUUID(), expectedRevision: 1, role: 'portrait' };
  const quote = visualGenerationQuoteSchema.parse({
    ...base,
    automaticKnownCostPolicy: 'known-cost-v1',
  });
  assert.equal(quote.automaticKnownCostPolicy, 'known-cost-v1');
  assert.equal(visualGenerationQuoteSchema.parse(base).automaticKnownCostPolicy, undefined);
  const dispatch = visualGenerationDispatchSchema.parse({
    ...base,
    quoteId: randomUUID(),
    consent: true,
    estimateRiskConsent: true,
    automaticKnownCostPolicyHash: digest('policy'),
  });
  assert.equal(dispatch.automaticKnownCostPolicyHash, digest('policy'));
  assert.throws(() =>
    visualGenerationDispatchSchema.parse({ ...dispatch, automaticKnownCostPolicyHash: 'invalid' }),
  );
  const source = fs.readFileSync(
    require.resolve('../../apps/api/src/visual-authoring/service.ts'),
    'utf8',
  );
  assert.match(
    source,
    /b\.automaticKnownCostPolicy\s*\?\s*\{ automaticKnownCostPolicy: b\.automaticKnownCostPolicy \}/,
  );
  assert.match(
    source,
    /b\.automaticKnownCostPolicyHash\s*\?\s*\{ automaticKnownCostPolicyHash: b\.automaticKnownCostPolicyHash \}/,
  );
  assert.ok(
    source.indexOf('const settlementPolicy = row.quote_result') <
      source.indexOf('SET dispatch_operation_id=$3'),
  );
  assert.match(source, /b\.automaticKnownCostPolicyHash !== settlementPolicy\.fingerprint/);
});
