/** Voice gameplay regression: a manually selected real NPC decision cannot silently become a fixture. */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://synthetic:synthetic@127.0.0.1:9/synthetic';
for (const key of Object.keys(process.env))
  if (/^(NPC_AI_|LIVE_TEST_|IMAGE_)/.test(key)) delete process.env[key];
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');
const { GameService } = require('../../apps/api/dist/game/game.service.js');
async function scenario({
  manual = true,
  enabled = true,
  budgetExceeded = false,
  authorized = true,
  queueError,
  release = true,
} = {}) {
  const d = g.createAuthoredDraft('courtyard');
  d.turnRules = g.turnRulesSchema.parse({});
  let state = g.createStateFromPlayable(g.compilePlayableDraft(d).playable, ['alice'], 7);
  state = g.endPlayerTurn(state, 'alice', g.turnFence(state)).state;
  const npcId = Object.keys(state.npcBrains)[0],
    request = {
      id: randomUUID(),
      npc_id: npcId,
      purpose: 'plan',
      cause_key: 'harmed-fixture',
      requester_user_id: null,
      context: {
        contextHash: 'synthetic-context',
        turnFence: g.turnFence(state),
        budgetExceeded,
        mockProposal: { actions: [{ kind: 'wait' }] },
      },
    };
  const observed = { fallback: 0, queued: 0, releases: 0, status: 'queued', code: null };
  const write = async (sql, params = []) => {
    if (sql.includes("SET status='failed'")) observed.status = 'failed';
    if (sql.includes("SET status='fallback'")) observed.status = 'fallback';
    if (sql.includes("result_code='PROVIDER_DISABLED'")) observed.code = 'PROVIDER_DISABLED';
    else if (sql.includes('result_code=$2')) observed.code = params[1];
    return { rowCount: 1, rows: [{ id: request.id }] };
  };
  const service = Object.create(GameService.prototype);
  service.reconcileIntents = async () => {};
  service.db = {
    query: async (sql, params = []) => {
      if (sql.startsWith('SELECT * FROM game_npc_decision_requests')) return [request];
      if (sql.startsWith('UPDATE')) await write(sql, params);
      return [];
    },
    tx: async (work) => work({ query: write }),
  };
  service.ai = {
    manualLive: () => manual,
    manualRequestAuthorized: async () => authorized,
    activeSponsor: async () => undefined,
    configuration: () => ({ enabled, provider: manual ? 'external' : 'mock', creditPrice: 0 }),
    queue: async () => {
      observed.queued++;
      if (queueError) throw new Error(queueError);
      return { id: randomUUID() };
    },
    rejectManualUnqueuedRequest: async () => {
      if (release) observed.releases++;
      return release;
    },
  };
  service.evaluateDecision = async () => {
    observed.fallback++;
    return { next: state, accepted: true };
  };
  service.saveIntentOutcome = async () => {};
  service.dispatchAi = () => {};
  service.persist = async (_id, _live, _next, _kind, _extra, work) => {
    if (work) await work({ query: write });
  };
  await service.processDecisionRequests(randomUUID(), { state, aiPending: false });
  return observed;
}
test('disabled real NPC provider leaves the original addressed decision queued without fixture success', async () => {
  const r = await scenario({ enabled: false });
  assert.equal(r.fallback, 0);
  assert.equal(r.queued, 0);
  assert.equal(r.releases, 0);
  assert.equal(r.status, 'queued');
  assert.equal(r.code, 'PROVIDER_DISABLED');
});
test('oversized manual NPC context fails honestly and releases a proven unsent authorization only', async () => {
  const r = await scenario({ budgetExceeded: true });
  assert.equal(r.fallback, 0);
  assert.equal(r.queued, 0);
  assert.equal(r.status, 'failed');
  assert.equal(r.releases, 1);
  assert.equal(r.code, 'CONTEXT_BUDGET_EXCEEDED');
});
test('known queue denial never chooses a mock NPC reaction', async () => {
  const r = await scenario({ queueError: 'PROVIDER_BUDGET_EXCEEDED' });
  assert.equal(r.fallback, 0);
  assert.equal(r.queued, 1);
  assert.equal(r.status, 'failed');
  assert.equal(r.releases, 1);
  assert.equal(r.code, 'PROVIDER_BUDGET_EXCEEDED');
});
test('busy queue remains pending and never releases its authorization', async () => {
  const r = await scenario({ queueError: 'NPC_AI_BUSY' });
  assert.equal(r.fallback, 0);
  assert.equal(r.status, 'queued');
  assert.equal(r.releases, 0);
});
test('uncertain queue outcome with a linked job cannot release or replace that job', async () => {
  const r = await scenario({ queueError: 'QUEUE_UNAVAILABLE', release: false });
  assert.equal(r.fallback, 0);
  assert.equal(r.releases, 0);
  assert.equal(r.status, 'queued');
});
test('unapproved requests remain queued without spending or fixture output', async () => {
  const r = await scenario({ authorized: false, release: false });
  assert.equal(r.fallback, 0);
  assert.equal(r.queued, 0);
  assert.equal(r.releases, 0);
  assert.equal(r.status, 'queued');
});
test('explicit mock mode retains its deterministic acceptance fallback', async () => {
  const r = await scenario({ manual: false, enabled: false });
  assert.equal(r.fallback, 1);
  assert.equal(r.status, 'fallback');
  assert.equal(r.releases, 0);
});
