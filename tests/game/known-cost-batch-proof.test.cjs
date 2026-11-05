process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const ts = require('typescript');
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
const { digest } = require('../../apps/api/src/ai/context.ts');
const { verifyAcceptedWorldBatch } = require('../../apps/api/src/generation/sparks-accounting.ts');
const {
  worldKnownCostPolicyHash,
  worldKnownCostPolicyRequired,
  acceptedWorldKnownCostPolicyMatches,
} = require('../../apps/api/src/generation/known-cost-policy.ts');
function fixture() {
  const owner = randomUUID(),
    campaignId = randomUUID(),
    requestId = randomUUID(),
    nativeId = randomUUID();
  const context = { contextHash: 'context', worldRoundDecision: true };
  const native = {
    id: nativeId,
    user_id: owner,
    campaign_id: campaignId,
    npc_id: 'npc',
    purpose: 'plan',
    context_hash: 'context',
    provider_id: 'fixture',
    provider_version: 'v1',
    policy_version: 'p1',
    expires_at: new Date('2026-11-01'),
  };
  const request = {
    id: requestId,
    campaign_id: campaignId,
    npc_id: 'npc',
    purpose: 'plan',
    status: 'queued',
    requester_user_id: owner,
    job_id: null,
    context,
  };
  const batch = {
    id: randomUUID(),
    owner_id: owner,
    campaign_id: campaignId,
    state: 'accepted',
    accepted_at: new Date('2026-10-31'),
    expires_at: new Date('2026-11-01'),
    turn_fence: { roundId: 'round', phaseEpoch: 1, rulesetVersion: 1 },
    entries: [
      {
        requestId,
        npcId: 'npc',
        purpose: 'plan',
        contextDigest: digest(context),
        quote: { id: nativeId },
      },
    ],
    media_entries: [
      {
        preparationId: randomUUID(),
        imageQuoteId: randomUUID(),
        automaticKnownCostPolicyHash: digest('image-policy'),
        quote: {
          automaticKnownCostPolicy: 'known-cost-v1',
          automaticKnownCostPolicyHash: digest('image-policy'),
          providerReserveMicros: 120,
        },
      },
    ],
  };
  batch.quote = {
    automaticKnownCostPolicy: 'known-cost-v1',
    automaticKnownCostPolicyHash: worldKnownCostPolicyHash(batch.entries, batch.media_entries),
  };
  const campaign = {
    owner_id: owner,
    status: 'active',
    state: {
      turnController: { phase: 'world', roundId: 'round', phaseEpoch: 1, ruleset: { version: 1 } },
    },
  };
  const proof = {
    batchId: batch.id,
    nativeQuoteId: nativeId,
    runtimeRequestId: requestId,
    contextDigest: digest(context),
    campaignId,
    providerId: 'fixture',
    providerVersion: 'v1',
    policyVersion: 'p1',
  };
  const c = {
    query: async (sql) => {
      let rows = [];
      if (sql.includes('FROM game_world_generation_batches')) rows = [batch];
      else if (sql.includes('FROM game_npc_decision_requests')) rows = [request];
      else if (sql.includes('FROM npc_ai_quotes')) rows = [native];
      else if (sql.includes('FROM game_campaigns')) rows = [campaign];
      else if (!sql.includes('FROM npc_ai_jobs')) throw new Error(sql);
      return { rows, rowCount: rows.length };
    },
  };
  return { batch, owner, proof, c };
}
test('aggregate policy exact accepted text and image proof permits native admission without writes', async () => {
  const f = fixture(),
    before = JSON.stringify(f.batch);
  assert.equal(acceptedWorldKnownCostPolicyMatches(f.batch), true);
  await verifyAcceptedWorldBatch(f.c, f.owner, f.proof);
  assert.equal(JSON.stringify(f.batch), before);
});
for (const [name, mutate] of Object.entries({
  'missing hash': (b) => delete b.quote.automaticKnownCostPolicyHash,
  'missing outer policy': (b) => delete b.quote.automaticKnownCostPolicy,
  'removed outer proof': (b) => delete b.quote,
  'changed sibling image cost': (b) => b.media_entries[0].quote.providerReserveMicros++,
  'changed sibling image policy': (b) =>
    (b.media_entries[0].automaticKnownCostPolicyHash = digest('other')),
  'changed sibling text quote': (b) =>
    b.entries.push({ requestId: randomUUID(), quote: { id: randomUUID() } }),
  'added unpriced media': (b) => b.media_entries.push({ imageQuoteId: randomUUID() }),
}))
  test(`aggregate policy rejects ${name} before native NPC admission`, async () => {
    const f = fixture();
    mutate(f.batch);
    assert.equal(worldKnownCostPolicyRequired(f.batch), true);
    assert.equal(acceptedWorldKnownCostPolicyMatches(f.batch), false);
    await assert.rejects(
      () => verifyAcceptedWorldBatch(f.c, f.owner, f.proof),
      /WORLD_BATCH_CONSENT_STALE/,
    );
  });
test('unmarked old finite batch remains legacy rather than gaining policy authority', async () => {
  const f = fixture();
  delete f.batch.quote;
  f.batch.media_entries = [];
  assert.equal(worldKnownCostPolicyRequired(f.batch), false);
  assert.equal(acceptedWorldKnownCostPolicyMatches(f.batch), false);
  await verifyAcceptedWorldBatch(f.c, f.owner, f.proof);
});
test('settlement and dispatch both reprove required aggregate before using acceptance', () => {
  const settle = readFileSync(
    require.resolve('../../apps/api/src/game/automatic-npc-settlement.ts'),
    'utf8',
  );
  assert.match(settle, /!acceptedWorldKnownCostPolicyMatches\(batch\)/);
  assert.ok(
    settle.indexOf('worldKnownCostPolicyRequired(batch)') <
      settle.indexOf('acceptedWorldBatchId = batch.id'),
  );
  const world = readFileSync(
    require.resolve('../../apps/api/src/game/world-generation-batch.ts'),
    'utf8',
  );
  const scheduled = world.slice(world.indexOf('async quotedWorldRequest'));
  assert.ok(
    scheduled.indexOf('worldKnownCostPolicyRequired(batch)') <
      scheduled.indexOf('this.travel?.advance'),
  );
  assert.match(
    scheduled,
    /acceptedWorldKnownCostPolicyMatches\(batch\)\s*\? \{ automaticKnownCostPolicy: 'known-cost-v1'/,
  );
});

test('explicit accepted native flag cannot downgrade missing aggregate to legacy', async () => {
  const f = fixture();
  delete f.batch.quote;
  f.batch.media_entries = [];
  f.proof.automaticKnownCostPolicy = 'known-cost-v1';
  await assert.rejects(
    () => verifyAcceptedWorldBatch(f.c, f.owner, f.proof),
    /WORLD_BATCH_CONSENT_STALE/,
  );
});
