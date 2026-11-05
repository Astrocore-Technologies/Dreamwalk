process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');
const { digest } = require('../../apps/api/dist/ai/context');
const { GameService } = require('../../apps/api/dist/game/game.service');
const { WorldGenerationBatch } = require('../../apps/api/dist/game/world-generation-batch');
const { ApiException } = require('../../apps/api/dist/errors');
function playerState(actors = ['alice']) {
  const draft = g.createCompleteObservatoryDraft();
  draft.turnRules = g.turnRulesSchema.parse({});
  return g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, actors);
}
function worldState() {
  const state = playerState();
  return g.endPlayerTurn(state, 'alice', g.turnFence(state)).state;
}
function commandFixture({ owner = true, release = true, actors } = {}) {
  const game = Object.create(GameService.prototype),
    live = { state: playerState(actors) };
  const authorities = [],
    operations = new Map();
  game.serial = async (_id, work) => work();
  game.access = async () => ({
    actorId: 'alice',
    user: { id: 'payer' },
    ownerId: owner ? 'payer' : 'other',
  });
  game.load = async () => live;
  game.touch = game.refreshArt = async () => {};
  game.project = () => ({ revision: 1 });
  game.ai = { releaseGeneration: () => release };
  game.db = { query: async (_sql, v) => (operations.has(v[2]) ? [operations.get(v[2])] : []) };
  game.persist = async (_id, target, state, _kind, operation, extra) => {
    await extra({
      query: async (sql, values) => {
        assert.match(sql, /INSERT INTO game_ordinary_round_consents/);
        authorities.push(values);
        return { rows: [], rowCount: 1 };
      },
    });
    target.state = state;
    operations.set(operation.command.operationId, {
      request_hash: operation.hash,
      result: operation.response,
    });
  };
  const command = {
    protocolVersion: 1,
    type: 'turn.end',
    operationId: randomUUID(),
    turnFence: g.turnFence(live.state),
    ordinaryGeneration: true,
  };
  return { game, live, authorities, command };
}
test('owner End turn persists exact-round authority once, even before the co-op last actor', async () => {
  const f = commandFixture({ actors: ['alice', 'bob'] });
  const round = f.live.state.turnController.roundId;
  const first = await f.game.command({}, 'campaign', f.command);
  assert.equal(first.status, 'committed');
  assert.equal(f.live.state.turnController.phase, 'player');
  assert.deepEqual(f.authorities, [['campaign', round, 'payer', f.command.operationId, null]]);
  const replay = await f.game.command({}, 'campaign', f.command);
  assert.equal(replay.status, 'committed');
  assert.equal(f.authorities.length, 1);
});
test('guest, legacy caller, stale fence and demo End turn cannot authorize owner spending', async () => {
  for (const change of ['guest', 'legacy', 'stale', 'demo']) {
    const f = commandFixture({ owner: change !== 'guest', release: change !== 'demo' });
    if (change === 'legacy') delete f.command.ordinaryGeneration;
    if (change === 'stale') f.command.turnFence.roundId = 'other';
    await f.game.command({}, 'campaign', f.command);
    assert.equal(f.authorities.length, 0, change);
  }
});
function consentFixture() {
  const state = worldState(),
    owner = randomUUID(),
    campaign = randomUUID(),
    operationId = randomUUID();
  const request = {
    id: randomUUID(),
    npc_id: 'keeper',
    purpose: 'plan',
    context: {},
    requester_user_id: null,
  };
  const quote = { id: randomUUID(), sparkReservedSubunits: '40' };
  const batch = {
    id: randomUUID(),
    operation_id: operationId,
    state: 'quoted',
    state_hash: digest(state),
    request_hash: digest([
      { id: request.id, npcId: 'keeper', purpose: 'plan', context: digest({}), requester: null },
    ]),
    turn_fence: g.turnFence(state),
    expires_at: new Date(Date.now() + 60000),
    entries: [{ requestId: request.id, npcId: 'keeper', purpose: 'plan', quote }],
    quote: { sparkReservedSubunits: '40' },
  };
  let authority = true,
    balance = '40',
    accepted = 0;
  const c = {
    query: async (sql, values) => {
      let rows = [];
      if (sql.startsWith('WITH accepted AS')) rows = [];
      else if (sql.startsWith('SELECT * FROM game_world_generation_batches')) rows = [batch];
      else if (sql.includes('FROM game_ordinary_round_consents'))
        rows = authority ? [{ policy_version: null }] : [];
      else if (sql.includes('FROM npc_ai_quotes'))
        rows = [
          {
            user_id: owner,
            campaign_id: campaign,
            npc_id: 'keeper',
            purpose: 'plan',
            spark_quote_id: randomUUID(),
            expires_at: batch.expires_at,
          },
        ];
      else if (sql.includes('FROM npc_ai_jobs WHERE quote_id')) rows = [];
      else if (sql.includes('FROM spark_wallets'))
        rows = [{ enabled: true, balance_subunits: balance, held_subunits: '0' }];
      else if (sql.includes('FROM dream_wallets')) rows = [];
      else if (sql.startsWith('UPDATE game_npc_decision_requests')) {
        // Native request ownership is written only after every guard.
      } else if (sql.startsWith('UPDATE game_world_generation_batches')) {
        accepted++;
        batch.quote = JSON.parse(values[1]);
        batch.accepted_at = new Date();
        batch.state = 'accepted';
      } else if (sql.includes('UPDATE game_ordinary_round_consents')) {
        // This fixture asserts the trusted batch stamp and acceptance count.
      } else throw new Error(sql);
      return { rows, rowCount: rows.length };
    },
  };
  const service = new WorldGenerationBatch({ tx: async (work) => work(c) }, {});
  service.authorize = service.lock = async () => {};
  service.eligible = async () => [request];
  service.progress = async () => ({ active: false, unknown: false, rows: [] });
  const body = { operationId, quoteId: batch.id, consent: true };
  return {
    service,
    state,
    batch,
    owner,
    campaign,
    body,
    authorize: (value) => {
      authority = value;
    },
    balance: (value) => {
      balance = value;
    },
    accepted: () => accepted,
  };
}
test('automatic consent stamps trusted policy only after exact native validation and replays once', async () => {
  const f = consentFixture();
  const args = [f.owner, f.campaign, f.state, f.body, f.state.turnController.roundId];
  await f.service.consent(...args);
  assert.equal(f.batch.quote.ordinaryTurnConsentVersion, 'end-turn-v1');
  await f.service.consent(...args);
  assert.equal(f.accepted(), 1);
});
test('missing owner authority, wrong round, insufficient funds and generated media fail closed', async () => {
  for (const change of ['missing', 'round', 'balance', 'image', 'risk', 'media']) {
    const f = consentFixture();
    if (change === 'missing') f.authorize(false);
    if (change === 'balance') f.balance('39');
    if (change === 'image') f.batch.quote.generatedLocationImages = 1;
    if (change === 'risk') f.batch.quote.estimateRiskConsentRequired = true;
    if (change === 'media') f.batch.media_entries = [{ imageQuoteId: randomUUID() }];
    await assert.rejects(
      f.service.consent(
        f.owner,
        f.campaign,
        f.state,
        f.body,
        change === 'round' ? 'other' : f.state.turnController.roundId,
      ),
    );
    assert.equal(f.accepted(), 0, change);
  }
});
test('manual consent cannot inject ordinary policy through public body', async () => {
  const f = consentFixture();
  await assert.rejects(
    f.service.consent(f.owner, f.campaign, f.state, {
      ...f.body,
      ordinaryTurnConsentVersion: 'end-turn-v1',
    }),
  );
  await f.service.consent(f.owner, f.campaign, f.state, f.body);
  assert.equal(f.batch.quote.ordinaryTurnConsentVersion, undefined);
});
function schedulerFixture(policyVersion) {
  const game = Object.create(GameService.prototype),
    live = { state: worldState(), paused: false };
  let authority = 'pending',
    quotes = 0,
    consents = 0,
    failures = 0;
  game.live = new Map([['campaign', live]]);
  game.ordinaryAdmissions = new Set();
  game.ordinaryAdmissionChecks = new Map();
  game.serial = async (_id, work) => work();
  game.withRuntimeVisionQuote = async (work) => work();
  game.scheduleRoundRequests = async () => {};
  game.db = {
    query: async () =>
      authority === 'pending'
        ? [{ owner_id: 'owner', operation_id: 'operation', policy_version: policyVersion }]
        : [],
    tx: async (work) =>
      work({
        query: async (sql) => {
          if (sql.startsWith('UPDATE game_ordinary_round_consents')) {
            if (authority !== 'pending') return { rows: [], rowCount: 0 };
            authority = 'blocked';
            return { rows: [{}], rowCount: 1 };
          }
          return { rows: [{ id: 'request' }], rowCount: 1 };
        },
      }),
  };
  game.worldGeneration = {
    pendingLocationCount: async () => 0,
    quote: async () => {
      quotes++;
      return { quote: { id: 'quote' } };
    },
    consent: async (_owner, _campaign, state, body, round) => {
      assert.equal(round, state.turnController.roundId);
      assert.equal(body.operationId, 'operation');
      consents++;
      authority = 'accepted';
    },
    failUnspent: async () => {
      failures++;
    },
  };
  return {
    game,
    live,
    removeAuthority: () => {
      authority = 'none';
    },
    counts: () => ({ quotes, consents, failures, authority }),
  };
}
test('scheduler quotes and admits once, never from status/guest authority or player phase', async () => {
  const f = schedulerFixture();
  await Promise.all([f.game.admitOrdinaryRound('campaign'), f.game.admitOrdinaryRound('campaign')]);
  f.game.ordinaryAdmissionChecks.clear();
  await f.game.admitOrdinaryRound('campaign');
  assert.deepEqual(f.counts(), { quotes: 1, consents: 1, failures: 0, authority: 'accepted' });
  const absent = schedulerFixture();
  absent.removeAuthority();
  await absent.game.admitOrdinaryRound('campaign');
  assert.equal(absent.counts().quotes, 0);
  const player = schedulerFixture();
  player.live.state = playerState();
  await player.game.admitOrdinaryRound('campaign');
  assert.equal(player.counts().quotes, 0);
});
test('native preflight failures stop once without consent, dispatch or automatic charge retry', async () => {
  const f = schedulerFixture();
  f.game.worldGeneration.quote = async () => {
    throw new Error('count needed');
  };
  f.game.withRuntimeVisionQuote = async (work) => {
    try {
      await work();
    } catch {
      /* Simulate the outer native preflight resolver. */
    }
    throw new ApiException(503, 'RUNTIME_MAP_COUNT_UNAVAILABLE', 'RUNTIME_MAP_COUNT_UNAVAILABLE');
  };
  await f.game.admitOrdinaryRound('campaign');
  assert.equal(f.counts().authority, 'blocked');
  assert.equal(f.counts().consents, 0);
  assert.equal(f.counts().failures, 1);
});

test('new-location intent stops ordinary admission before quoting and preserves the pending request', async () => {
  const f = schedulerFixture();
  f.game.worldGeneration.pendingLocationCount = async () => 1;
  await f.game.admitOrdinaryRound('campaign');
  assert.deepEqual(f.counts(), { quotes: 0, consents: 0, failures: 0, authority: 'blocked' });
  f.game.ordinaryAdmissionChecks.clear();
  await f.game.admitOrdinaryRound('campaign');
  assert.deepEqual(f.counts(), { quotes: 0, consents: 0, failures: 0, authority: 'blocked' });
});

test('bounded autonomous speech authority requires the explicit new End turn policy version', async () => {
  const f = commandFixture();
  f.command.ordinarySpeechPolicy = 'bounded-npc-speech-v1';
  const round = f.live.state.turnController.roundId;
  await f.game.command({}, 'campaign', f.command);
  assert.deepEqual(f.authorities, [
    ['campaign', round, 'payer', f.command.operationId, 'bounded-npc-speech-v1'],
  ]);
  await f.game.command({}, 'campaign', f.command);
  assert.equal(f.authorities.length, 1);
  for (const policy of [undefined, 'bounded-npc-speech-v1']) {
    const scheduled = schedulerFixture(policy);
    let quoted, consented;
    scheduled.game.worldGeneration.quote = async (_owner, _campaign, _state, body) => {
      quoted = body;
      return {
        quote: {
          id: 'quote',
          autonomousSpeechPolicyHash: 'speech-policy',
          automaticKnownCostPolicyHash: 'known-cost-policy',
        },
      };
    };
    scheduled.game.worldGeneration.consent = async (_owner, _campaign, _state, body) => {
      consented = body;
    };
    await scheduled.game.admitOrdinaryRound('campaign');
    assert.equal(quoted.autonomousSpeechPolicy, policy);
    assert.equal(quoted.automaticKnownCostPolicy, policy ? 'known-cost-v1' : undefined);
    assert.equal(consented.autonomousSpeechPolicyHash, policy ? 'speech-policy' : undefined);
    assert.equal(consented.automaticKnownCostPolicyHash, policy ? 'known-cost-policy' : undefined);
  }
});
