process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { digest } = require('../../apps/api/dist/ai/context');
const { estimateTextRequest } = require('../../apps/api/dist/generation/estimates');
const {
  autonomousSpeechEnvelope,
  autonomousSpeechConsentHash,
  assertAutonomousSpeechSnapshot,
  autonomousSpeechBoundEntry,
} = require('../../apps/api/dist/generation/autonomous-speech-envelope');
const {
  verifyAcceptedWorldBatch,
  SparksAccounting,
} = require('../../apps/api/dist/generation/sparks-accounting');
const { providerMicrosToSparkSubunits } = require('@dreamwalk/contracts');
function fixture() {
  const owner = randomUUID(),
    campaignId = randomUUID(),
    sourceVersionId = randomUUID();
  const now = Date.now(),
    accepted_at = new Date(now - 120000),
    expires_at = new Date(now - 60000);
  const profile = {
    model: 'synthetic-text',
    contextTokens: 32000,
    contextBudgetTokens: 32000,
    maxOutputTokens: 1024,
    maxInputBytes: 64000,
    inputMicrosPerMillion: 1000000,
    outputMicrosPerMillion: 2000000,
    pricing: {
      source: 'synthetic-unit-fixture',
      reviewedAt: new Date(now - 86400000).toISOString(),
      validUntil: new Date(now + 86400000).toISOString(),
    },
    estimation: {
      kind: 'operator_heuristic',
      textTokensPerKiBUtf8: 256,
      textProtocolTokens: 0,
      marginBps: 1000,
      fixedMarginMicros: 10,
    },
  };
  const snapshot = estimateTextRequest('{}', profile, 'synthetic-price-v1');
  const fence = { roundId: 'round-a', phaseEpoch: 2, rulesetVersion: 1 };
  const source = {
    id: randomUUID(),
    campaign_id: campaignId,
    npc_id: 'keeper',
    purpose: 'plan',
    context: { contextHash: 'plan-exact', worldRoundDecision: true, turnFence: fence },
    status: 'scheduled',
    source_job_status: 'committed',
    source_job_quote_id: randomUUID(),
    source_proposal: {
      brainGeneration: 0,
      actions: [
        { kind: 'communicate', targetId: 'alice', channel: 'say', observationIds: ['public-one'] },
      ],
    },
  };
  const envelope = autonomousSpeechEnvelope(snapshot, {
    providerId: 'release:synthetic',
    providerVersion: 'v1',
    policyVersion: 'policy-v1',
    sourceVersionId,
    sourceRequestId: source.id,
    sourceContextDigest: digest(source.context),
    npcId: 'keeper',
    turnFence: fence,
  });
  const context = {
    contextHash: 'speech-exact',
    generationPolicy: 'world-batch-v1',
    turnFence: fence,
    worldPlanCommunication: {
      sourceRequestId: source.id,
      roundId: fence.roundId,
      brainGeneration: 1,
      cursor: 0,
    },
    recipientId: 'alice',
    channel: 'say',
    observationIds: ['public-one'],
    replyLocale: 'uk',
  };
  const request = {
    id: randomUUID(),
    campaign_id: campaignId,
    npc_id: 'keeper',
    purpose: 'speech',
    context,
    requester_user_id: owner,
    status: 'queued',
    job_id: null,
    cause_key: `round:${fence.roundId}:keeper:communication:1:0`,
  };
  const native = {
    id: randomUUID(),
    user_id: owner,
    campaign_id: campaignId,
    npc_id: 'keeper',
    purpose: 'speech',
    context_hash: context.contextHash,
    provider_id: 'release:synthetic',
    provider_version: 'v1',
    policy_version: 'policy-v1',
    request_snapshot: snapshot,
    upper_micros: String(snapshot.reserveMicros),
    spark_quote_id: randomUUID(),
    expires_at,
  };
  const quote = {
    id: native.id,
    sparkReservedSubunits: providerMicrosToSparkSubunits(String(snapshot.reserveMicros)),
    sparkRateVersion: 'api-cent-2-sparks-v2',
  };
  const batch = {
    id: randomUUID(),
    owner_id: owner,
    campaign_id: campaignId,
    state: 'accepted',
    accepted_at,
    expires_at,
    turn_fence: fence,
    entries: [
      {
        requestId: source.id,
        npcId: 'keeper',
        purpose: 'plan',
        contextDigest: digest(source.context),
        quote: { id: source.source_job_quote_id },
      },
    ],
    media_entries: [],
    autonomous_speech_entries: [
      {
        envelope,
        quote: {
          sparkReservedSubunits: providerMicrosToSparkSubunits(String(envelope.reserveMicros)),
          sparkRateVersion: 'api-cent-2-sparks-v2',
        },
      },
    ],
    quote: { autonomousSpeechPolicy: 'bounded-npc-speech-v1' },
  };
  batch.quote.autonomousSpeechPolicyHash = autonomousSpeechConsentHash(
    batch.entries,
    [],
    batch.autonomous_speech_entries,
  );
  const binding = {
    batch_id: batch.id,
    npc_id: 'keeper',
    source_request_id: source.id,
    request_id: request.id,
    native_quote_id: native.id,
    context_digest: digest(context),
    quote,
    created_at: new Date(now - 90000),
  };
  const campaign = {
    owner_id: owner,
    status: 'active',
    source_version_id: sourceVersionId,
    state: {
      turnController: {
        phase: 'world',
        roundId: fence.roundId,
        phaseEpoch: 2,
        ruleset: { version: 1 },
      },
    },
  };
  const proof = {
    batchId: batch.id,
    nativeQuoteId: native.id,
    runtimeRequestId: request.id,
    contextDigest: digest(context),
    campaignId,
    providerId: native.provider_id,
    providerVersion: native.provider_version,
    policyVersion: native.policy_version,
  };
  const spark = {
    id: native.spark_quote_id,
    owner_id: owner,
    source_kind: 'npc',
    source_id: native.id,
    operation_id: native.id,
    reserve_subunits: quote.sparkReservedSubunits,
    expires_at,
    price_snapshot: {
      tariff: { sparkRateVersion: quote.sparkRateVersion },
      providerQuote: {
        ...snapshot,
        policyVersion: native.policy_version,
        contextHash: context.contextHash,
      },
    },
  };
  let unknown = false,
    consumed = false;
  const client = {
    async query(sql, _values) {
      let rows;
      if (sql.includes('FROM game_world_generation_batches')) rows = [batch];
      else if (sql.includes('FROM game_autonomous_speech_bindings')) rows = [binding];
      else if (sql.includes('FROM game_npc_decision_requests r JOIN npc_ai_jobs')) rows = [source];
      else if (sql.includes('FROM game_npc_decision_requests')) rows = [request];
      else if (sql.includes('FROM npc_ai_quotes')) rows = [native];
      else if (sql.includes('FROM game_campaigns')) rows = [campaign];
      else if (sql.includes('FROM npc_ai_jobs WHERE quote_id')) rows = consumed ? [{}] : [];
      else if (sql.includes('FROM npc_ai_jobs j LEFT JOIN')) rows = unknown ? [{}] : [];
      else if (sql.includes('FROM spark_quotes')) rows = [spark];
      else throw Error('Unexpected SQL: ' + sql);
      return { rows, rowCount: rows.length };
    },
  };
  return {
    owner,
    campaignId,
    profile,
    snapshot,
    source,
    envelope,
    request,
    native,
    batch,
    binding,
    campaign,
    proof,
    spark,
    client,
    unknown() {
      unknown = true;
    },
    consumed() {
      consumed = true;
    },
  };
}
test('configured full context speech allowance uses reviewed prices and no invented exact body', () => {
  const f = fixture();
  assert.equal(f.envelope.maxInputTokens, 30976);
  assert.equal(f.envelope.estimatedTotalMicros, 33024);
  assert.equal(f.envelope.reserveMicros, 36337);
  assert.equal(f.envelope.maxRequests, 1);
  assert.equal(f.envelope.maxRetries, 0);
  assert.equal(f.envelope.maxImages, 0);
  assert.equal(f.envelope.maxOperationalCounts, 0);
  assert.equal(f.envelope.bodySha256, undefined);
  assertAutonomousSpeechSnapshot(f.envelope, f.snapshot);
});
test('a smaller configured transport bound narrows a conservative context allowance without an arbitrary RP cap', () => {
  const f = fixture();
  const snapshot = estimateTextRequest(
    '{}',
    { ...f.profile, contextBudgetTokens: 32000, maxInputBytes: 8000 },
    'synthetic-price-v1',
  );
  const envelope = autonomousSpeechEnvelope(snapshot, f.envelope);
  assert.equal(envelope.maxInputTokens, 12096);
});
test('one bound speech survives restart and original expiry without rewriting accepted exact entries', async () => {
  const f = fixture(),
    before = JSON.stringify(f.batch);
  await verifyAcceptedWorldBatch(f.client, f.owner, f.proof, f.spark.id);
  await verifyAcceptedWorldBatch(f.client, f.owner, f.proof, f.spark.id);
  assert.equal(JSON.stringify(f.batch), before);
  assert.equal(f.batch.entries.length, 1);
  assert.equal(f.batch.entries[0].purpose, 'plan');
});
for (const [name, mutate] of Object.entries({
  'legacy consent': (f) => {
    delete f.batch.quote.autonomousSpeechPolicyHash;
  },
  'missing allowance': (f) => {
    f.batch.autonomous_speech_entries = [];
  },
  'second child': (f) => {
    f.binding.request_id = randomUUID();
  },
  'different NPC': (f) => {
    f.request.npc_id = 'other';
  },
  'changed context': (f) => {
    f.request.context.replyLocale = 'en';
  },
  'changed recipient': (f) => {
    f.request.context.recipientId = 'bystander';
  },
  'forged plan cursor': (f) => {
    f.request.context.worldPlanCommunication.cursor = 1;
  },
  'forged plan generation': (f) => {
    f.source.source_proposal.brainGeneration = 10;
  },
  'noncommunication plan': (f) => {
    f.source.source_proposal.actions[0].kind = 'wait';
  },
  'different plan recipient': (f) => {
    f.source.source_proposal.actions[0].targetId = 'bystander';
  },
  'different plan channel': (f) => {
    f.source.source_proposal.actions[0].channel = 'whisper';
  },
  'different plan evidence': (f) => {
    f.source.source_proposal.actions[0].observationIds = ['secret-one'];
  },
  'forged cause identity': (f) => {
    f.request.cause_key = 'another-operation';
  },
  'changed parent source': (f) => {
    f.source.context.contextHash = 'other';
  },
  'parent not committed': (f) => {
    f.source.source_job_status = 'running';
  },
  'wrong original plan quote': (f) => {
    f.source.source_job_quote_id = randomUUID();
  },
  'source revision': (f) => {
    f.campaign.source_version_id = randomUUID();
  },
  'future round': (f) => {
    f.campaign.state.turnController.roundId = 'next';
  },
  'changed Sparks rate version': (f) => {
    f.binding.quote.sparkRateVersion = 'different-rate';
  },
  'changed tariff': (f) => {
    f.native.request_snapshot.inputMicrosPerMillion++;
  },
  'changed output bound': (f) => {
    f.native.request_snapshot.maxOutputTokens++;
  },
  'excess input': (f) => {
    f.native.request_snapshot.estimatedInputTokens = f.envelope.maxInputTokens + 1;
  },
  'excess reserve': (f) => {
    f.native.request_snapshot.reserveMicros = f.envelope.reserveMicros + 1;
  },
  'unapproved map': (f) => {
    f.request.context.runtimeMapImage = {};
  },
  'late binding': (f) => {
    f.binding.created_at = new Date();
  },
  'unknown cost': (f) => f.unknown(),
  'already consumed quote': (f) => f.consumed(),
}))
  test(`future speech rejects ${name} independently before native admission and accounting`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(verifyAcceptedWorldBatch(f.client, f.owner, f.proof, f.spark.id));
    await assert.rejects(new SparksAccounting().reserve(f.client, f.owner, f.spark.id, f.proof));
  });
test('changed pricing evidence and unreviewed costs cannot manufacture an allowance', () => {
  const f = fixture();
  const bad = structuredClone(f.snapshot);
  delete bad.pricing;
  assert.throws(() => autonomousSpeechEnvelope(bad, f.envelope), /SPARK_PRICE_UNVERIFIED/);
  bad.pricing = { ...f.snapshot.pricing, validUntil: '2020-01-01' };
  assert.throws(() => autonomousSpeechEnvelope(bad, f.envelope), /SPARK_PRICE_UNVERIFIED/);
});
test('bound proof never promotes a different exact native quote or incomplete binding', () => {
  const f = fixture();
  assert.ok(autonomousSpeechBoundEntry(f.batch, f.binding, f.request, f.native, f.source));
  f.native.id = randomUUID();
  assert.equal(
    autonomousSpeechBoundEntry(f.batch, f.binding, f.request, f.native, f.source),
    undefined,
  );
});

test('round preview includes separately labeled optional capacity from current contexts without a quote or paid count', async () => {
  const core = require('../../packages/game-core/dist');
  const { forecastWorldRound } = require('../../apps/api/dist/game/round-cost-forecast');
  const draft = core.createCompleteObservatoryDraft();
  draft.turnRules = core.turnRulesSchema.parse({});
  const state = core.createStateFromPlayable(core.compilePlayableDraft(draft).playable, ['alice']);
  const before = JSON.stringify(state);
  const result = await forecastWorldRound(
    { query: async () => [] },
    {
      localRequestForecast: () => 10,
      localAutonomousSpeechForecast: (context) => context.currentEstimate,
      localAutonomousSpeechAllowance: () => 64512,
    },
    'synthetic-campaign',
    state,
    undefined,
    () => [{ contextHash: 'current', currentEstimate: 30 }],
  );
  assert.equal(result.optionalAutonomousSpeechRequests, 1);
  assert.equal(result.baseEstimatedSparkSubunits, providerMicrosToSparkSubunits('10'));
  assert.equal(result.optionalAutonomousSpeechSparkSubunits, providerMicrosToSparkSubunits('30'));
  assert.equal(result.estimatedTotalMicros, 40);
  assert.equal(
    result.optionalAutonomousSpeechAllowanceSubunits,
    providerMicrosToSparkSubunits('64512'),
  );
  assert.equal(result.optionalAutonomousSpeechUnestimatedRequests, 0);
  assert.equal(result.requestCount, 2);
  assert.equal(JSON.stringify(state), before);
  const unavailable = await forecastWorldRound(
    { query: async () => [] },
    {
      localRequestForecast: () => 10,
      localAutonomousSpeechForecast: () => null,
    },
    'synthetic-campaign',
    state,
    undefined,
    () => [{ contextHash: 'current', currentEstimate: 30 }],
  );
  assert.equal(
    unavailable.estimatedSparkSubunits,
    null,
    'missing speech pricing cannot publish a cheap partial total',
  );
});

test('new UI sends bounded consent once and never prompts for uncovered autonomous legacy speech', () => {
  const { readFileSync } = require('node:fs');
  const page = readFileSync('apps/web/components/game/game-page.tsx', 'utf8');
  const world = readFileSync('apps/web/components/game/world-generation-confirmation.tsx', 'utf8');
  const confirm = readFileSync('apps/web/components/game/story-reply-confirmation.tsx', 'utf8');
  const copy = readFileSync('apps/web/components/game/story-messages.ts', 'utf8');
  assert.match(page, /ordinarySpeechPolicy: 'bounded-npc-speech-v1'/);
  assert.doesNotMatch(world, /status\.communicationConsentRequired|status\.pendingSpeechIds/);
  assert.match(world, /worldSpeechSkipLegacy/);
  assert.match(world, /worldCostForecastHint/);
  assert.match(world, /baseEstimatedSparkSubunits/);
  assert.match(confirm, /autonomousSpeechPolicyHash: quote\.autonomousSpeechPolicyHash/);
  assert.match(confirm, /declineSpeech \? 'declineSpeech'/);
  for (const phrase of [
    'не более одной на NPC',
    'at most one per NPC',
    'не більше однієї на NPC',
    'а не ожидаемая плата или лимит провайдера',
    'not an expected charge or a provider-enforced limit',
    'не очікувана плата чи ліміт провайдера',
  ])
    assert.ok(copy.includes(phrase));
});

test('known semantic child failure settles its exact bill once and refuses forged source lineage', () => {
  const {
    ordinaryFailureSettlement,
  } = require('../../apps/api/dist/ai/ordinary-failure-settlement');
  const { planSparkSettlement } = require('../../apps/api/dist/generation/sparks-accounting');
  const f = fixture();
  f.batch.quote.ordinaryTurnConsentVersion = 'end-turn-v1';
  const job = {
    ...f.native,
    id: randomUUID(),
    quote_id: f.native.id,
    context: f.request.context,
    status: 'result_received',
    subject_kind: 'npc',
    credits: 0,
    sponsor_id: null,
    provider_external: true,
    provider_cost_evidence: 'configured_rates',
    provider_budget_status: 'spent',
    provider_upper_micros: f.native.upper_micros,
    provider_actual_micros: '30',
    provider_usage: {
      inputTokens: 10,
      outputTokens: 10,
      costMicros: 30,
      costEvidence: 'configured_rates',
      costVerifiedForSparks: true,
    },
    input_tokens: '10',
    output_tokens: '10',
    cached_input_tokens: '0',
    requester_user_id: f.owner,
    payer_user_id: f.owner,
    spark_hold_id: f.spark.id,
    request_meta: { acceptedWorldBatchId: f.batch.id, runtimeRequestId: f.request.id },
  };
  f.request.job_id = job.id;
  f.request.status = 'scheduled';
  const hold = {
    id: f.spark.id,
    owner_id: f.owner,
    source_kind: 'npc',
    source_id: f.native.id,
    status: 'held',
    reserved_subunits: f.spark.reserve_subunits,
    captured_subunits: null,
    settlement_fingerprint: null,
    spark_rate_version: 'api-cent-2-sparks-v2',
  };
  const evidence = { binding: f.binding, source: f.source, native: f.native };
  const result = ordinaryFailureSettlement(job, f.batch, f.request, hold, f.spark, evidence);
  assert.ok(result);
  assert.equal(result.actualMicros, '30');
  const settlement = planSparkSettlement(hold, result);
  assert.equal(settlement.captured, '60');
  assert.equal(settlement.pending, false);
  const replay = planSparkSettlement(
    { ...hold, status: 'settled', settlement_fingerprint: settlement.fingerprint },
    result,
  );
  assert.equal(replay.duplicate, true);
  f.source.source_proposal.actions[0].targetId = 'another-recipient';
  assert.equal(
    ordinaryFailureSettlement(job, f.batch, f.request, hold, f.spark, evidence),
    undefined,
  );
});
test('receipt outcome and funding are durable metadata, independent of private proposal retention', () => {
  const {
    autonomousSpeechReceipt,
  } = require('../../apps/api/dist/game/autonomous-speech-receipts');
  const base = {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    hold_status: 'settled',
    job_status: 'committed',
    reserved_subunits: '100',
    captured_subunits: '60',
    sparks_reserved_subunits: '70',
  };
  assert.equal(autonomousSpeechReceipt({ ...base, has_delivery: true }).outcome, 'delivered');
  const silent = autonomousSpeechReceipt({ ...base, proposal: null, has_delivery: false });
  assert.equal(silent.outcome, 'silent');
  assert.equal(silent.funding.dreamsCapturedSubunits, '30');
  assert.equal(silent.funding.sparksCapturedSubunits, '30');
  assert.equal(autonomousSpeechReceipt({ ...base, job_status: 'stale' }).outcome, 'failed');
  const unknown = autonomousSpeechReceipt({
    ...base,
    hold_status: 'pending',
    job_status: 'reconciling',
    captured_subunits: null,
  });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.outcome, 'pending');
  assert.equal(unknown.capturedSubunits, null);
  assert.equal(autonomousSpeechReceipt({ ...base, captured_subunits: '101' }), undefined);
});
test('receipt pagination is bounded and exact-owner scoped without mutable private context equality', async () => {
  const {
    readAutonomousSpeechReceipts,
  } = require('../../apps/api/dist/game/autonomous-speech-receipts');
  const rows = Array.from({ length: 21 }, () => ({
    id: randomUUID(),
    created_at: new Date().toISOString(),
    hold_status: 'settled',
    job_status: 'committed',
    reserved_subunits: '100',
    captured_subunits: '60',
  }));
  const campaign = randomUUID(),
    owner = randomUUID(),
    cursor = randomUUID();
  const result = await readAutonomousSpeechReceipts(
    {
      async query(sql, args) {
        assert.deepEqual(args, [campaign, owner, cursor]);
        assert.match(sql, /LIMIT 21/);
        assert.match(sql, /j.requester_user_id=\$2 AND j.payer_user_id=\$2/);
        assert.match(sql, /j.context_hash<>'erased'/);
        assert.match(sql, /child.request_id=r.id AND child.native_quote_id=native.id/);
        assert.doesNotMatch(sql, /j.context=r.context/);
        return { rows };
      },
    },
    campaign,
    owner,
    cursor,
  );
  assert.equal(result.speechReceipts.length, 20);
  assert.equal(result.speechReceiptNext, rows[19].id);
});

test('receipt UI fences stale campaign/access/cursor responses before displaying private own-account amounts', () => {
  const fs = require('node:fs');
  const ui = fs.readFileSync('apps/web/components/game/world-generation-confirmation.tsx', 'utf8');
  assert.match(ui, /receiptPage\?\.key === receiptKey/);
  assert.match(ui, /currentReceiptKey.current === receiptKey/);
  assert.match(ui, /\[campaignId, access\]/);
  assert.match(ui, /visibleReceipts\?\.items.map/);
  assert.match(ui, /dateTime=\{receipt.createdAt\}/);
});
test('exhausted one-child allowance skips another distinct action without another confirmation or quote', async () => {
  const { WorldGenerationBatch } = require('../../apps/api/dist/game/world-generation-batch');
  const f = fixture(),
    queries = [];
  const request = { ...f.request, id: randomUUID(), status: 'queued', job_id: null };
  const service = new WorldGenerationBatch(
    {},
    {
      quote() {
        throw Error('UNAPPROVED_SECOND_QUOTE');
      },
    },
  );
  const result = await service.bindAutonomousSpeech(
    {
      async query(sql, args) {
        queries.push([sql, args]);
        if (sql.startsWith('SELECT * FROM game_autonomous_speech_bindings'))
          return { rows: [f.binding] };
        if (sql.startsWith('SELECT id FROM game_npc_decision_requests')) return { rows: [] };
        assert.match(sql, /SET status='failed',result_code=\$3/);
        assert.deepEqual(args, [f.campaignId, request.id, 'AUTONOMOUS_SPEECH_ALLOWANCE_EXHAUSTED']);
        return { rows: [], rowCount: 1 };
      },
    },
    f.batch,
    request,
    { turnController: { roundId: 'round-a', phaseEpoch: 2, ruleset: { version: 1 } } },
  );
  assert.equal(result, undefined);
  assert.equal(queries.length, 3);
});

for (const kind of [
  'invalid_consent',
  'invalid_parent',
  'unknown_pricing',
  'overflow',
  'local_snapshot_error',
])
  test(`accepted optional speech ${kind} skips without intermediate confirmation or provider call`, async () => {
    const { WorldGenerationBatch } = require('../../apps/api/dist/game/world-generation-batch');
    const f = fixture();
    if (kind === 'invalid_consent') f.batch.quote.autonomousSpeechPolicyHash = 'changed';
    if (kind === 'invalid_parent') f.source.source_proposal.actions[0].targetId = 'other';
    const service = new WorldGenerationBatch(
      {},
      {
        quote() {
          throw Error('UNAPPROVED_QUOTE');
        },
        autonomousSpeechRequestSnapshot() {
          if (kind === 'unknown_pricing') return undefined;
          if (kind === 'local_snapshot_error') throw Error('LOCAL_SNAPSHOT_UNAVAILABLE');
          return {
            ...f.snapshot,
            ...(kind === 'overflow' ? { reserveMicros: f.envelope.reserveMicros + 1 } : {}),
          };
        },
      },
    );
    let skipped = false;
    await service.bindAutonomousSpeech(
      {
        async query(sql, args) {
          if (sql.startsWith('SELECT * FROM game_autonomous_speech_bindings')) return { rows: [] };
          if (sql.startsWith('SELECT source_version_id')) return { rows: [f.campaign] };
          if (sql.includes('j.proposal AS source_proposal')) return { rows: [f.source] };
          if (sql.startsWith('SELECT id FROM game_npc_decision_requests')) return { rows: [] };
          assert.match(sql, /SET status='failed',result_code=\$3/);
          assert.deepEqual(args, [
            f.campaignId,
            f.request.id,
            'AUTONOMOUS_SPEECH_ALLOWANCE_UNAVAILABLE',
          ]);
          skipped = true;
          return { rows: [], rowCount: 1 };
        },
      },
      f.batch,
      f.request,
      { turnController: { roundId: 'round-a', phaseEpoch: 2, ruleset: { version: 1 } } },
    );
    assert.equal(skipped, true);
  });

for (const known of [true, false])
  test(`native quote ${known ? 'local refusal skips' : 'unknown database error propagates'} only after rolling back local quote writes`, async () => {
    const { WorldGenerationBatch } = require('../../apps/api/dist/game/world-generation-batch');
    const { ApiException } = require('../../apps/api/dist/errors');
    const f = fixture(),
      statements = [];
    const error = known
      ? new ApiException(409, 'PROVIDER_BUDGET_EXCEEDED', 'PROVIDER_BUDGET_EXCEEDED')
      : Error('SYNTHETIC_DATABASE_DISCONNECT');
    const service = new WorldGenerationBatch(
      {},
      {
        quote() {
          throw error;
        },
        autonomousSpeechRequestSnapshot() {
          return f.snapshot;
        },
      },
    );
    const operation = () =>
      service.bindAutonomousSpeech(
        {
          async query(sql, args) {
            statements.push(sql);
            if (sql.startsWith('SELECT * FROM game_autonomous_speech_bindings'))
              return { rows: [] };
            if (sql.startsWith('SELECT source_version_id')) return { rows: [f.campaign] };
            if (sql.includes('j.proposal AS source_proposal')) return { rows: [f.source] };
            if (sql.includes("SET status='failed'"))
              assert.deepEqual(args, [
                f.campaignId,
                f.request.id,
                'AUTONOMOUS_SPEECH_ALLOWANCE_UNAVAILABLE',
              ]);
            return { rows: [], rowCount: 1 };
          },
        },
        f.batch,
        f.request,
        { turnController: { roundId: 'round-a', phaseEpoch: 2, ruleset: { version: 1 } } },
      );
    if (known) await operation();
    else await assert.rejects(operation, error);
    const save = statements.indexOf('SAVEPOINT optional_speech_quote'),
      rollback = statements.indexOf('ROLLBACK TO SAVEPOINT optional_speech_quote'),
      release = statements.indexOf('RELEASE SAVEPOINT optional_speech_quote');
    assert.ok(save >= 0 && rollback > save && release > rollback);
    assert.equal(
      statements.some((sql) => sql.includes("SET status='failed'")),
      known,
    );
  });

for (const kind of ['legacy', 'pruned_parent', 'accepted_exact', 'stale_exact'])
  test(`uncovered legacy speech ${kind} does not acquire new spending authority`, async () => {
    const { WorldGenerationBatch } = require('../../apps/api/dist/game/world-generation-batch');
    const f = fixture();
    f.batch.quote = {};
    f.batch.autonomous_speech_entries = [];
    if (kind === 'pruned_parent') f.source.source_proposal = null;
    const service = new WorldGenerationBatch({}, { releaseGeneration: () => true });
    service.authorize = async () => {};
    service.lock = async () => {};
    let skip;
    await service.skipUncoveredLegacySpeech(
      {
        async query(sql, args) {
          if (sql.startsWith('SELECT owner_id,state'))
            return { rows: [{ ...f.campaign, owner_id: f.owner }] };
          if (sql.startsWith('SELECT * FROM game_npc_decision_requests'))
            return { rows: [f.request] };
          if (sql.includes('bool_or(state'))
            return {
              rows: [
                {
                  protected: kind === 'accepted_exact',
                  historical: ['accepted_exact', 'stale_exact'].includes(kind),
                },
              ],
            };
          if (sql.includes('j.proposal AS source_proposal')) return { rows: [f.source] };
          if (sql.startsWith('SELECT * FROM game_world_generation_batches'))
            return { rows: [f.batch] };
          if (sql.includes("SET status='failed'")) {
            skip = args[2];
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('SELECT id FROM game_npc_decision_requests'))
            return { rows: [{ id: f.request.id }] };
          assert.match(sql, /SET requester_user_id=\$3/);
          return { rows: [], rowCount: 1 };
        },
      },
      f.campaignId,
      f.request,
    );
    assert.equal(
      skip,
      kind === 'accepted_exact'
        ? undefined
        : kind === 'legacy'
          ? 'AUTONOMOUS_SPEECH_LEGACY_UNCOVERED'
          : 'AUTONOMOUS_SPEECH_ALLOWANCE_UNAVAILABLE',
    );
  });

test('mandatory funding excludes future speech permission without changing immutable consent prices', () => {
  const {
    mandatoryWorldBatchFunding,
  } = require('../../apps/api/dist/generation/world-batch-funding');
  const quote = (amount, dreams = true) => ({
    sparkReservedSubunits: amount,
    ...(dreams ? { funding: { policyVersion: 'dreams-first-v1' } } : {}),
  });
  const batch = {
    entries: [{ quote: quote('100') }, { quote: quote('20', false) }],
    media_entries: [{ quote: quote('300'), grounding: { quote: quote('400') } }],
    autonomous_speech_entries: [{ quote: quote('900000') }],
    quote: { sparkReservedSubunits: '900820' },
  };
  const original = JSON.stringify(batch);
  assert.deepEqual(mandatoryWorldBatchFunding(batch), { total: 820n, sparksOnly: 20n });
  assert.equal(JSON.stringify(batch), original);
  assert.throws(() => mandatoryWorldBatchFunding({ entries: [{ quote: {} }] }));
});
