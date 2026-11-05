process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { NpcAiEngine } = require('../../apps/api/dist/ai/npc-ai.service');

function fixture(meta) {
  const scope = {
    campaignId: randomUUID(),
    npcId: 'keeper',
    origin: 'user',
    requesterUserId: randomUUID(),
    purpose: 'plan',
  };
  const operationId = randomUUID(),
    quoteId = randomUUID();
  const job = {
    id: randomUUID(),
    npc_id: scope.npcId,
    origin: scope.origin,
    subject_kind: 'npc',
    requester_user_id: scope.requesterUserId,
    purpose: scope.purpose,
    request_meta: { quoteId, consent: true, ...meta },
  };
  const client = { query: async () => ({ rows: [job] }) };
  const engine = Object.create(NpcAiEngine.prototype);
  engine.db = { tx: (fn) => fn(client) };
  engine.authorize = async () => {};
  engine.dto = async (_c, value) => ({ id: value.id });
  return { engine, scope, operationId, quoteId, job };
}

test('public replay normalizes absent and null legacy metadata without duplicate admission', async () => {
  for (const meta of [
    {},
    { sponsorId: null, runtimeRequestId: null, acceptedWorldBatchId: null },
  ]) {
    const f = fixture(meta);
    assert.deepEqual(await f.engine.replay(f.scope, f.operationId, f.quoteId, true), {
      id: f.job.id,
    });
  }
});

test('public replay cannot drop accepted world batch identity or alter ordinary consent metadata', async () => {
  for (const meta of [
    { acceptedWorldBatchId: randomUUID() },
    { requestKey: 'different' },
    { sponsorId: randomUUID() },
    { runtimeRequestId: randomUUID() },
  ]) {
    const f = fixture(meta);
    await assert.rejects(
      () => f.engine.replay(f.scope, f.operationId, f.quoteId, true),
      /IDEMPOTENCY_CONFLICT/,
    );
  }
  const f = fixture({});
  await assert.rejects(
    () => f.engine.replay(f.scope, f.operationId, randomUUID(), true),
    /IDEMPOTENCY_CONFLICT/,
  );
  await assert.rejects(
    () => f.engine.replay(f.scope, f.operationId, f.quoteId, false),
    /IDEMPOTENCY_CONFLICT/,
  );
});
