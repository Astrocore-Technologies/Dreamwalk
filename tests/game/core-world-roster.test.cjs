const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');
const fence = (s) => g.turnFence(s);
function fixture() {
  const draft = g.createAuthoredDraft('courtyard');
  draft.turnRules = g.turnRulesSchema.parse({});
  const compiled = g.compilePlayableDraft(draft);
  assert.deepEqual(compiled.errors, []);
  let s = g.createStateFromPlayable(compiled.playable, ['alice'], 19);
  const ids = Array.from({ length: 40 }, (_, i) => `crowd-${i}`);
  for (const id of ids) {
    s.entities[id] = { ...structuredClone(s.entities.keeper), id };
    s.npcBrains[id] = structuredClone(s.npcBrains.keeper);
  }
  s.entities.dormant = { ...structuredClone(s.entities.keeper), id: 'dormant', mapId: 'off-map' };
  s.npcBrains.dormant = structuredClone(s.npcBrains.keeper);
  s = g.endPlayerTurn(s, 'alice', fence(s)).state;
  return { s, ids };
}

test('every admitted NPC above 32 gets its bounded action without expanding any actor budget', () => {
  let { s, ids } = fixture();
  const admitted = g.admitWorldTurnActors(s, ids, fence(s));
  assert.equal(admitted.error, undefined);
  s = admitted.state;
  assert.strictEqual(g.admitWorldTurnActors(s, ids, fence(s)).state, s);
  assert.equal(g.admitWorldTurnActors(s, [...ids, 'keeper'], fence(s)).error, 'STALE_STATE');
  for (const id of ids) {
    const result = g.applyWorldTurnAction(s, id, { kind: 'wait' }, fence(s));
    assert.equal(result.error, undefined, id);
    s = result.state;
    assert.equal(g.applyWorldTurnAction(s, id, { kind: 'wait' }, fence(s)).error, 'ROUND_LOCKED');
  }
  assert.equal(s.turnController.worldActions, 40);
  assert.equal(s.turnController.ruleset.maxWorldActions, 16);
  assert.equal(g.applyWorldTurnAction(s, 'keeper', { kind: 'wait' }, fence(s)).error, 'FORBIDDEN');
  const next = g.finishWorldPhase(s, fence(s));
  assert.equal(next.error, undefined);
  assert.equal(next.state.turnController.worldActorIds, undefined);
  assert.equal(next.state.turnController.resources.alice.main, 1);
});

test('off-map NPC identity, cognition, and position remain dormant and resume without duplication', () => {
  let { s, ids } = fixture();
  const dormant = structuredClone(s.entities.dormant);
  const brain = structuredClone(s.npcBrains.dormant);
  assert.equal(g.admitWorldTurnActors(s, ['dormant'], fence(s)).error, 'FORBIDDEN');
  assert.equal(g.applyWorldTurnAction(s, 'dormant', { kind: 'wait' }, fence(s)).error, 'FORBIDDEN');
  s = g.admitWorldTurnActors(s, ids, fence(s)).state;
  s = g.applyWorldTurnAction(s, ids[0], { kind: 'wait' }, fence(s)).state;
  s = g.finishWorldPhase(s, fence(s)).state;
  assert.deepEqual(s.entities.dormant, dormant);
  assert.deepEqual(s.npcBrains.dormant, brain);
  const count = Object.keys(s.entities).length;
  s.entities.alice.mapId = 'off-map';
  s = g.endPlayerTurn(s, 'alice', fence(s)).state;
  assert.equal(g.applyWorldTurnAction(s, ids[0], { kind: 'wait' }, fence(s)).error, 'FORBIDDEN');
  s = g.admitWorldTurnActors(s, ['dormant'], fence(s)).state;
  const resumed = g.applyWorldTurnAction(s, 'dormant', { kind: 'wait' }, fence(s));
  assert.equal(resumed.error, undefined);
  assert.equal(Object.keys(resumed.state.entities).length, count);
  assert.deepEqual(resumed.state.npcBrains.dormant, brain);
});

test('duplicate, stale, or late roster admission cannot increase world budgets', () => {
  let { s, ids } = fixture();
  assert.equal(g.admitWorldTurnActors(s, [ids[0], ids[0]], fence(s)).error, 'FORBIDDEN');
  assert.equal(g.admitWorldTurnActors(s, ids, { ...fence(s), phaseEpoch: 0 }).error, 'STALE_STATE');
  s = g.applyWorldTurnAction(s, ids[0], { kind: 'wait' }, fence(s)).state;
  assert.equal(g.admitWorldTurnActors(s, ids, fence(s)).error, 'ROUND_LOCKED');
  ({ s } = fixture());
  s = g.admitWorldTurnActors(s, [], fence(s)).state;
  assert.equal(g.applyWorldTurnAction(s, 'keeper', { kind: 'wait' }, fence(s)).error, 'FORBIDDEN');
});

test('world execution rechecks vitality, encounter and living brain after roster admission', () => {
  const { s, ids } = fixture();
  for (const change of [
    (state) => {
      state.entities[ids[0]].vitality = 0;
    },
    (state) => {
      state.entities[ids[0]].encounterId = 'new-encounter';
    },
    (state) => {
      delete state.npcBrains[ids[0]].living;
    },
  ]) {
    const admitted = g.admitWorldTurnActors(s, ids, fence(s)).state;
    change(admitted);
    const result = g.applyWorldTurnAction(admitted, ids[0], { kind: 'wait' }, fence(admitted));
    assert.equal(result.error, 'FORBIDDEN');
    assert.strictEqual(result.state, admitted);
    assert.equal(result.state.turnController.worldActions, 0);
  }
});

test('world policy leaves off-map perception, promise deadlines and cognition untouched', () => {
  let { s, ids } = fixture();
  s.npcBrains.dormant.living.obligations = [
    {
      id: 'dormant-promise',
      toActorId: 'alice',
      itemId: 'lost-item',
      createdTick: 0,
      dueTick: 1,
      status: 'accepted',
      evidenceIds: [],
    },
  ];
  s.npcBrains.dormant.living.rememberedItems = {
    'lost-item': { mapId: 'off-map', x: 1, y: 1, present: true },
  };
  s.tick = 100;
  s = g.admitWorldTurnActors(s, ids, fence(s)).state;
  const original = structuredClone(s.npcBrains.dormant);
  const result = g.stepLivingNpcs(s, { deferredNpcIds: Object.keys(s.npcBrains) });
  assert.deepEqual(result.state.npcBrains.dormant, original);
  assert.equal(
    result.events.some((event) => event.actorId === 'dormant'),
    false,
  );
});

test('speech fan-out reaches over 32 admitted listeners without a per-round utterance quota', () => {
  let { s, ids } = fixture();
  s = g.finishWorldPhase(s, fence(s)).state;
  s.turnController.ruleset.maxQueuedSpeech = 1;
  for (const id of ids)
    Object.assign(s.entities[id], {
      x: s.entities.alice.x,
      y: s.entities.alice.y,
      mapId: s.entities.alice.mapId,
    });
  const input = { channel: 'say', text: 'Hello everyone.' };
  const identity = { turnId: '00000000-0000-4000-8000-000000000001', segmentIndex: 0 };
  const said = g.applyNpcSpeech(s, 'alice', undefined, input, { suppressReply: true, identity });
  assert.equal(said.error, undefined);
  s = said.state;
  for (const id of ids) {
    const marker = g.admittedNpcSpeechObservationId(s, 'alice', id, input, identity);
    assert.ok(marker);
    const observation = g.npcReplyObservation(s, 'alice', id, marker);
    const queued = g.queueTurnSpeech(
      s,
      'alice',
      {
        id: `speech-${id}`,
        recipientId: id,
        utteranceId: marker,
        channel: 'say',
        audienceIds: observation.audienceIds,
      },
      fence(s),
    );
    assert.equal(queued.error, undefined, id);
    s = queued.state;
  }
  assert.equal(s.turnController.deferredSpeech.length, 40);
  assert.equal(g.turnProjectionSchema.safeParse(g.projectTurnController(s, 'alice')).success, true);
  const other = { ...identity, segmentIndex: 1 };
  s = g.applyNpcSpeech(s, 'alice', undefined, input, {
    suppressReply: true,
    identity: other,
  }).state;
  const marker = g.admittedNpcSpeechObservationId(s, 'alice', ids[0], input, other);
  assert.equal(
    g.queueTurnSpeech(
      s,
      'alice',
      {
        id: 'new-segment',
        recipientId: ids[0],
        utteranceId: marker,
        channel: 'say',
        audienceIds: g.npcReplyObservation(s, 'alice', ids[0], marker).audienceIds,
      },
      fence(s),
    ).error,
    undefined,
  );
});

test('late roster NPC reactions keep their opportunity and cannot spend twice', () => {
  let { s, ids } = fixture();
  Object.assign(s.entities.alice, { x: 2, y: 3 });
  const last = ids.at(-1);
  Object.assign(s.entities[last], { x: 3, y: 3 });
  s = g.admitWorldTurnActors(s, ids, fence(s)).state;
  for (const id of ids.slice(0, -1)) {
    const result = g.applyWorldTurnAction(s, id, { kind: 'wait' }, fence(s));
    assert.equal(result.error, undefined);
    s = result.state;
  }
  const attack = g.applyWorldTurnAction(s, last, { kind: 'hit', targetId: 'alice' }, fence(s));
  assert.equal(attack.error, undefined);
  assert.equal(attack.state.turnController.phase, 'reaction');
  const oldFence = fence(attack.state);
  const resolved = g.resolveTurnReaction(attack.state, 'alice', 'defend', oldFence);
  assert.equal(resolved.error, undefined);
  s = resolved.state;
  assert.equal(s.turnController.worldActions, 40);
  assert.equal(s.turnController.worldNpcActions[last], 1);
  assert.equal(g.resolveTurnReaction(s, 'alice', 'defend', oldFence).error, 'STALE_STATE');
  assert.equal(g.applyWorldTurnAction(s, last, { kind: 'wait' }, fence(s)).error, 'ROUND_LOCKED');
});
