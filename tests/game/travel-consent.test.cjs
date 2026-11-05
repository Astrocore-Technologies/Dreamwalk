process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
// Lightweight isolated source execution while retaining the normal TS check as a separate gate.
require.extensions['.ts'] = (module, filename) =>
  module._compile(
    ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
      },
      fileName: filename,
    }).outputText,
    filename,
  );
const { verifyAcceptedTravelBatch } = require('../../apps/api/src/generation/travel-consent.ts');
const { digest } = require('../../apps/api/src/ai/context.ts');
function fixture() {
  const owner = randomUUID(),
    campaignId = randomUUID(),
    preparationId = randomUUID(),
    quoteId = randomUUID(),
    batchId = randomUUID(),
    sparkId = randomUUID();
  const expires_at = new Date(Date.now() - 1000),
    accepted_at = new Date(Date.now() - 2000);
  const scene = { name: 'Cafe', template: 'room' };
  const input = {
    mode: 'external',
    travelContext: { preparationId },
    prompt: 'exact',
    rights: { allowAuthorReuse: false },
  };
  const context = { contextHash: 'exact', travelSceneSpec: { scene } };
  const prep = {
    id: preparationId,
    owner_id: owner,
    campaign_id: campaignId,
    batch_id: batchId,
    state: 'accepted',
    image_quote: {
      id: quoteId,
      reserveMicros: 120,
      sparks: { reserveSubunits: '240', rateVersion: 'test-rate' },
    },
    image_job_id: null,
    input_hash: digest(input),
  };
  const native = {
    id: quoteId,
    actor_id: owner,
    input,
    upper_micros: 120,
    expires_at,
    spark_quote_id: sparkId,
    request_hash: 'request',
    pricing_profile_snapshot: { fingerprint: 'immutable' },
    estimate_snapshot: { fingerprint: 'exact' },
  };
  const request = {
    id: preparationId,
    campaign_id: campaignId,
    requester_user_id: owner,
    status: 'queued',
    job_id: null,
    context,
  };
  const fence = { roundId: 'round-a', phaseEpoch: 2, rulesetVersion: 1 };
  const batch = {
    id: batchId,
    owner_id: owner,
    campaign_id: campaignId,
    state: 'accepted',
    accepted_at,
    expires_at,
    turn_fence: fence,
    media_entries: [
      {
        preparationId,
        imageQuoteId: quoteId,
        quote: {
          providerReserveMicros: 120,
          sparkReservedSubunits: '240',
          sparkRateVersion: 'test-rate',
        },
      },
    ],
    entries: [{ requestId: preparationId, contextDigest: digest(context) }],
  };
  const campaign = {
    owner_id: owner,
    status: 'active',
    state: {
      turnController: {
        phase: 'world',
        roundId: fence.roundId,
        phaseEpoch: fence.phaseEpoch,
        ruleset: { version: 1 },
      },
    },
  };
  const spark = {
    id: sparkId,
    owner_id: owner,
    source_kind: 'image',
    source_id: quoteId,
    operation_id: quoteId,
    expires_at,
    reserve_subunits: '240',
    price_snapshot: {
      tariff: { sparkRateVersion: 'test-rate' },
      providerQuote: {
        quoteId,
        requestHash: native.request_hash,
        pricingProfile: native.pricing_profile_snapshot,
        estimate: native.estimate_snapshot,
        settlement: 'actual-image-micros',
        cachePricing: 'not-quoted',
      },
    },
  };
  let unknown = false,
    jobs = [];
  const client = {
    async query(sql, values) {
      let rows = [];
      if (sql.startsWith('SELECT * FROM game_location_travel_preparations'))
        rows = values[0] === prep.id ? [prep] : [];
      else if (sql.startsWith('SELECT * FROM game_world_generation_batches'))
        rows = values[0] === batch.id ? [batch] : [];
      else if (sql.startsWith('SELECT * FROM image_generation_quotes'))
        rows = values[0] === native.id ? [native] : [];
      else if (sql.startsWith('SELECT * FROM game_npc_decision_requests')) rows = [request];
      else if (sql.includes('FROM game_campaigns')) rows = [campaign];
      else if (sql.startsWith('SELECT id FROM image_generation_jobs')) rows = jobs;
      else if (sql.startsWith('SELECT 1 FROM npc_ai_jobs')) rows = unknown ? [{}] : [];
      else if (sql.includes('FROM spark_quotes')) rows = values[0] === sparkId ? [spark] : [];
      else throw Error(sql);
      return { rows, rowCount: rows.length };
    },
  };
  return {
    owner,
    prep,
    native,
    request,
    batch,
    campaign,
    spark,
    sparkId,
    client,
    proof: { batchId, preparationId, nativeQuoteId: quoteId },
    unknown: () => (unknown = true),
    consume: () => (jobs = [{ id: randomUUID() }]),
  };
}
test('accepted exact image consent survives original native and Sparks quote expiry without changing price', async () => {
  const f = fixture(),
    before = JSON.stringify([f.prep, f.native, f.batch, f.spark]);
  await verifyAcceptedTravelBatch(f.client, f.owner, f.proof, f.sparkId);
  assert.equal(JSON.stringify([f.prep, f.native, f.batch, f.spark]), before);
});
for (const [name, mutate] of Object.entries({
  'foreign owner': (f) => (f.owner = randomUUID()),
  'spoofed batch': (f) => (f.proof.batchId = randomUUID()),
  'changed scene prompt': (f) => (f.native.input.prompt = 'different'),
  'changed native cost': (f) => (f.native.upper_micros = 121),
  'changed request context': (f) => (f.request.context.contextHash = 'new'),
  'changed image tariff': (f) =>
    (f.spark.price_snapshot.providerQuote = {
      ...f.spark.price_snapshot.providerQuote,
      pricingProfile: { fingerprint: 'changed' },
    }),
  'expired before acceptance': (f) => (f.batch.accepted_at = new Date()),
  'wrong world fence': (f) => f.campaign.state.turnController.phaseEpoch++,
  'failed request': (f) => (f.request.status = 'failed'),
  'duplicate consent entry': (f) => f.batch.media_entries.push(f.batch.media_entries[0]),
  'unknown liability': (f) => f.unknown(),
  'already consumed quote': (f) => f.consume(),
}))
  test(`image consent rejects ${name}`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(() => verifyAcceptedTravelBatch(f.client, f.owner, f.proof, f.sparkId));
  });
const {
  imageKnownCostPolicy,
} = require('../../apps/api/src/image-generation/settlement-policy.ts');
const {
  worldKnownCostPolicyHash,
  acceptedWorldKnownCostPolicyMatches,
} = require('../../apps/api/src/generation/known-cost-policy.ts');
function markedFixture() {
  const f = fixture();
  f.native.input.automaticKnownCostPolicy = 'known-cost-v1';
  f.native.cost_basis = 'approved_estimate';
  f.prep.input_hash = digest(f.native.input);
  const policy = imageKnownCostPolicy({
    quoteId: f.native.id,
    requestHash: f.native.request_hash,
    reserveMicros: String(f.native.upper_micros),
    costBasis: f.native.cost_basis,
  });
  f.prep.image_quote.automaticKnownCostSettlement = policy;
  f.batch.media_entries[0].automaticKnownCostPolicyHash = policy.fingerprint;
  f.batch.media_entries[0].quote.automaticKnownCostPolicy = 'known-cost-v1';
  f.batch.media_entries[0].quote.automaticKnownCostPolicyHash = policy.fingerprint;
  Object.assign(f.spark.price_snapshot.providerQuote, {
    automaticKnownCostPolicy: 'known-cost-v1',
    automaticKnownCostPolicyHash: policy.fingerprint,
  });
  f.batch.quote = {
    automaticKnownCostPolicy: 'known-cost-v1',
    automaticKnownCostPolicyHash: worldKnownCostPolicyHash(f.batch.entries, f.batch.media_entries),
  };
  return f;
}
test('single accepted combined consent proves exact new image policy without client consent injection', async () => {
  const f = markedFixture();
  const before = JSON.stringify([f.prep, f.native, f.batch, f.spark]);
  const proof = await verifyAcceptedTravelBatch(f.client, f.owner, f.proof, f.sparkId);
  assert.equal(
    proof.automaticKnownCostPolicyHash,
    f.prep.image_quote.automaticKnownCostSettlement.fingerprint,
  );
  assert.equal(JSON.stringify([f.prep, f.native, f.batch, f.spark]), before);
});
for (const [name, mutate] of Object.entries({
  'missing aggregate acceptance': (f) => delete f.batch.quote.automaticKnownCostPolicyHash,
  'changed aggregate acceptance': (f) =>
    (f.batch.quote.automaticKnownCostPolicyHash = digest('different')),
  'native policy changed': (f) => (f.native.cost_basis = 'verified_bound'),
  'entry policy changed': (f) =>
    (f.batch.media_entries[0].automaticKnownCostPolicyHash = digest('different')),
  'nested entry policy changed': (f) =>
    (f.batch.media_entries[0].quote.automaticKnownCostPolicyHash = digest('different')),
  'prepared policy changed': (f) =>
    (f.prep.image_quote.automaticKnownCostSettlement.fingerprint = digest('different')),
  'immutable marker removed': (f) =>
    delete f.spark.price_snapshot.providerQuote.automaticKnownCostPolicy,
  'immutable hash changed': (f) =>
    (f.spark.price_snapshot.providerQuote.automaticKnownCostPolicyHash = digest('different')),
  'additional media exposure': (f) =>
    f.batch.media_entries.push({
      preparationId: randomUUID(),
      imageQuoteId: randomUUID(),
      quote: { providerReserveMicros: 1 },
    }),
  'additional text exposure': (f) =>
    f.batch.entries.push({ requestId: randomUUID(), contextDigest: digest('different') }),
}))
  test(`new image policy rejects ${name}`, async () => {
    const f = markedFixture();
    mutate(f);
    await assert.rejects(
      () => verifyAcceptedTravelBatch(f.client, f.owner, f.proof, f.sparkId),
      /TRAVEL_BATCH_CONSENT_STALE/,
    );
  });
test('new image policy cannot omit required Sparks binding', async () => {
  const f = markedFixture();
  await assert.rejects(
    () => verifyAcceptedTravelBatch(f.client, f.owner, f.proof),
    /TRAVEL_BATCH_CONSENT_STALE/,
  );
});
test('legacy accepted travel remains unmarked and creates no automatic capture authority', async () => {
  const f = fixture();
  assert.equal(
    (await verifyAcceptedTravelBatch(f.client, f.owner, f.proof, f.sparkId))
      .automaticKnownCostPolicyHash,
    undefined,
  );
  assert.equal(acceptedWorldKnownCostPolicyMatches(f.batch), false);
});
