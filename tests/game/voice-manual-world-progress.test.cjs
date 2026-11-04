/** Manual-world recovery only; all storage/provider ports are in-memory and no network is used. */
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://synthetic:synthetic@127.0.0.1:9/synthetic';
for (const key of Object.keys(process.env))
  if (/^(NPC_AI_|LIVE_TEST_|IMAGE_)/.test(key)) delete process.env[key];
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');
const { GameService } = require('../../apps/api/dist/game/game.service.js');
const { LiveTestService } = require('../../apps/api/dist/live-test/service.js');

async function world({
  expired = true,
  stopped = false,
  linkedJob = false,
  permitState = null,
  liability = false,
} = {}) {
  const draft = g.createAuthoredDraft('courtyard');
  draft.turnRules = g.turnRulesSchema.parse({});
  let state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice'], 7);
  state = g.endPlayerTurn(state, 'alice', g.turnFence(state)).state;
  for (const brain of Object.values(state.npcBrains)) {
    brain.plan = [];
    brain.cursor = 0;
    if (brain.living) brain.living.causes = [];
  }
  const campaignId = randomUUID(),
    sessionId = randomUUID(),
    request = {
      id: randomUUID(),
      campaign_id: campaignId,
      npc_id: Object.keys(state.npcBrains)[0],
      requester_user_id: null,
      purpose: 'plan',
      status: 'queued',
      cause_key: 'pushed:no-consent-fixture',
      context: { contextHash: 'synthetic', turnFence: g.turnFence(state) },
    };
  const observed = { queueCalls: 0, dispatchCalls: 0, mockCalls: 0, ledgerWrites: 0 };
  const expiresAt = new Date(Date.now() + (expired ? -60000 : 60000));
  const rows = (values) => ({ rows: values, rowCount: values.length });
  async function query(sql, params = []) {
    if (sql.includes('pg_advisory_xact_lock')) return rows([{}]);
    // These legacy requests already belong to a frozen world roster. New-round
    // preparation is covered separately; it must not manufacture replacement work.
    if (sql.startsWith('SELECT 1 FROM game_world_round_rosters')) return rows([{}]);
    if (sql.startsWith('SELECT roster FROM game_world_round_rosters'))
      return rows([{ roster: [{ npcId: request.npc_id, consideration: 'plan' }] }]);
    if (sql.startsWith('UPDATE game_npc_decision_requests r SET')) {
      if (linkedJob && ['queued', 'scheduled'].includes(request.status)) {
        request.status = 'failed';
        request.result_code = 'PROVIDER_OUTCOME_UNKNOWN';
        return rows([{ id: request.id }]);
      }
      return rows([]);
    }
    if (sql.includes("result_code='MISSING_PROVIDER_JOB'")) return rows([]);
    if (sql.startsWith('SELECT campaign_id FROM game_npc_decision_requests'))
      return rows([{ campaign_id: campaignId }]);
    if (sql.startsWith('SELECT status,job_id FROM game_npc_decision_requests'))
      return rows([{ status: request.status, job_id: null }]);
    if (sql.startsWith('SELECT * FROM game_npc_decision_requests'))
      return rows(request.status === 'queued' ? [request] : []);
    if (sql.includes('FROM live_test_text_permits'))
      return rows(
        permitState
          ? [{ session_id: sessionId, state: permitState, job_id: linkedJob ? randomUUID() : null }]
          : [],
      );
    if (sql.includes('FROM live_test_sessions'))
      return rows([
        { id: sessionId, state: stopped ? 'stopped' : 'active', expires_at: expiresAt },
      ]);
    if (sql.includes('FROM npc_ai_jobs'))
      return rows(linkedJob ? [{ id: randomUUID(), status: 'reconciling' }] : []);
    if (sql.includes('FROM generation_budget_reservations'))
      return rows(liability ? [{ id: randomUUID(), status: 'held' }] : []);
    if (sql.startsWith('SELECT 1 FROM game_npc_decision_requests'))
      return rows(['queued', 'scheduled'].includes(request.status) ? [{ pending: 1 }] : []);
    if (sql.startsWith('UPDATE game_npc_decision_requests SET')) {
      if (sql.includes("status='failed'")) request.status = 'failed';
      if (sql.includes("status='cancelled'")) request.status = 'cancelled';
      request.result_code = params[1];
      return rows([{ id: request.id }]);
    }
    if (/^(UPDATE|INSERT).*generation_budget/.test(sql)) observed.ledgerWrites++;
    return rows([]);
  }
  const db = {
    query: async (sql, params) => (await query(sql, params)).rows,
    tx: async (work) => work({ query }),
  };
  const manual = new LiveTestService(db, {
    enabled: true,
    sessionId,
    ownerId: randomUUID(),
    expiresAt,
  });
  const service = Object.create(GameService.prototype);
  service.db = db;
  service.reconcileIntents = async () => {};
  // These requests exercise legacy manual authorization, not composer-bound
  // release quotes or world-generation batches.
  service.story = {
    requireLegacyReplyConsent: async () => false,
    quotedReply: async () => null,
  };
  service.ai = {
    // No optional extended-history provider is configured in this consent/liability fixture.
    contextWindow: () => undefined,
    releaseGeneration: () => false,
    manualLive: () => true,
    manualRequestAuthorized: async () => false,
    rejectManualUnqueuedRequest: (c, id, code) => manual.rejectUndispatchedRequest(c, id, code),
    queue: async () => {
      observed.queueCalls++;
      throw new Error('UNEXPECTED_PROVIDER_QUEUE');
    },
  };
  service.evaluateDecision = async () => {
    observed.mockCalls++;
    throw new Error('UNEXPECTED_MOCK');
  };
  service.dispatchAi = () => {
    observed.dispatchCalls++;
  };
  service.persist = async (_id, live, next) => {
    live.state = next;
  };
  const live = { state, aiPending: false };
  await service.advanceTurnWorld(campaignId, live);
  return { live, request, observed };
}

test('expired manual session cannot strand an unapproved, never-dispatched world plan', async () => {
  const result = await world();
  assert.ok(
    ['failed', 'cancelled'].includes(result.request.status),
    'expired request must be terminal',
  );
  assert.equal(result.live.state.turnController.phase, 'player');
  assert.equal(result.live.state.turnController.roundNumber, 2);
  assert.deepEqual(result.observed, {
    queueCalls: 0,
    dispatchCalls: 0,
    mockCalls: 0,
    ledgerWrites: 0,
  });
});

test('stopped manual session drains only a proven unapproved request without a job or liability', async () => {
  const result = await world({ expired: false, stopped: true });
  assert.equal(result.request.status, 'failed');
  assert.equal(result.live.state.turnController.phase, 'player');
  assert.equal(result.live.state.turnController.roundNumber, 2);
  assert.deepEqual(result.observed, {
    queueCalls: 0,
    dispatchCalls: 0,
    mockCalls: 0,
    ledgerWrites: 0,
  });
});

test('active manual session preserves the owner opportunity to consent instead of silently skipping', async () => {
  const result = await world({ expired: false });
  assert.equal(result.request.status, 'queued');
  assert.equal(result.live.state.turnController.phase, 'world');
  assert.equal(result.live.state.turnController.roundNumber, 1);
  assert.deepEqual(result.observed, {
    queueCalls: 0,
    dispatchCalls: 0,
    mockCalls: 0,
    ledgerWrites: 0,
  });
});

test('expiry cannot release or replace a linked uncertain job or its liability', async () => {
  for (const permitState of [null, 'authorized', 'unknown']) {
    const result = await world({ linkedJob: true, permitState });
    assert.equal(result.request.status, 'failed');
    assert.equal(result.request.result_code, 'PROVIDER_OUTCOME_UNKNOWN');
    assert.equal(result.live.state.turnController.phase, 'player');
    assert.deepEqual(result.observed, {
      queueCalls: 0,
      dispatchCalls: 0,
      mockCalls: 0,
      ledgerWrites: 0,
    });
  }
});

test('an orphaned manual ledger reservation is protected even without a permit or linked job', async () => {
  const result = await world({ liability: true });
  assert.equal(result.request.status, 'queued');
  assert.equal(result.live.state.turnController.phase, 'world');
  assert.deepEqual(result.observed, {
    queueCalls: 0,
    dispatchCalls: 0,
    mockCalls: 0,
    ledgerWrites: 0,
  });
});
