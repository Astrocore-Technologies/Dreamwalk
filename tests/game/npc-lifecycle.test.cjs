process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');
const c = require('../../packages/contracts/dist');
const { prepareNpcActionIntent } = require('../../packages/game-core/dist/npc-actions');
const { GameService } = require('../../apps/api/dist/game/game.service');

function world() {
  const draft = g.createCompleteObservatoryDraft();
  draft.turnRules = g.turnRulesSchema.parse({});
  let state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice']);
  Object.assign(state.entities.alice, { x: 5, y: 4 });
  Object.assign(state.entities.keeper, { label: 'Orin' });
  return g.endPlayerTurn(state, 'alice', g.turnFence(state)).state;
}
function proposal(state, effect, text = '*I act toward Orin*') {
  const id = randomUUID(),
    input = {
      operationId: randomUUID(),
      text,
      channel: 'say',
      replyLocale: 'en',
      expectedCanonRevision: state.narrativeCanon?.revision ?? 0,
      turnFence: g.turnFence(state),
    };
  const context = g.buildStoryTurnContext(state, 'alice', input, id);
  const raw = {
    turnId: id,
    contextHash: context.contextHash,
    status: 'ready',
    code: null,
    steps: context.segments.map((s) => ({
      segmentIndex: s.index,
      action: null,
      reply: null,
      ...(s.index === 0 ? { narrativeImpact: { targetId: 'keeper', effect } } : {}),
    })),
    narrative: {
      narration: 'The current attempt changes the scene.',
      newScene: null,
      newNpc: null,
      evidenceIds: [],
    },
  };
  return { id, input, context, raw };
}
function apply(state, effect, text) {
  const p = proposal(state, effect, text);
  return { ...g.applyStoryTurnProposal(state, 'alice', p.input, p.id, p.raw), sample: p };
}
function observer(state, id, x = 7, y = 4) {
  state.entities[id] = { ...structuredClone(state.entities.keeper), id, x, y, label: id };
  state.npcBrains[id] = structuredClone(state.npcBrains.keeper);
  state.npcBrains[id].living.observations = [];
  return state.entities[id];
}

test('explicit death persists body, inventory, history and invalidates active intentions atomically', () => {
  const state = world(),
    brain = state.npcBrains.keeper;
  state.entities.keeper.path = [{ x: 7, y: 4 }];
  brain.plan = [{ kind: 'move_to', target: { x: 7, y: 4 } }];
  brain.cursor = 0;
  brain.living.companionship = { actorId: 'alice', status: 'following' };
  const prior = structuredClone(brain.living.observations);
  state.turnController.deferredSpeech = [
    { id: 'old-reply', actorId: 'alice', recipientId: 'keeper', sequence: 1, channel: 'say' },
  ];
  const result = apply(state, 'death');
  assert.equal(result.error, undefined);
  const npc = result.state.entities.keeper,
    after = result.state.npcBrains.keeper;
  assert.equal(npc.lifeState, 'dead');
  assert.equal(npc.vitality, 0);
  assert.equal(npc.lifeRevision, 1);
  assert.equal(npc.path, undefined);
  assert.deepEqual(after.plan, []);
  assert.equal(after.living.companionship, undefined);
  assert.ok(after.generation > brain.generation);
  assert.ok(after.living.knowledgeRevision > brain.living.knowledgeRevision);
  assert.deepEqual(result.state.turnController.deferredSpeech, []);
  assert.deepEqual(npc.inventory, state.entities.keeper.inventory);
  assert.ok(prior.every((o) => after.living.observations.some((n) => n.id === o.id)));
  const body = g.projectState(result.state, 'alice').entities.find((e) => e.id === 'keeper');
  assert.equal(body.lifeState, 'dead');
  assert.equal(body.lifeRevision, undefined);
  assert.equal(body.x, state.entities.keeper.x);
  assert.equal(body.y, state.entities.keeper.y);
  const saved = JSON.parse(JSON.stringify(result.state));
  assert.equal(c.actorLifeState(saved.entities.keeper), 'dead');
  assert.equal(
    g
      .buildNarrativeContext(saved, 'alice', 'Continue')
      .visibleEntities.find((e) => e.id === 'keeper').lifeState,
    'dead',
  );
  assert.equal(result.actions.length, 0, 'semantic death is not a forged mechanical hit');
});

test('unconscious and dead NPCs cannot speak, perceive, plan, move, consume or accept cognition', () => {
  for (const effect of ['unconscious', 'death']) {
    const state = apply(world(), effect).state,
      npc = state.entities.keeper;
    assert.equal(g.currentNpcPlan(state, 'keeper'), null);
    assert.ok(g.acceptNpcPlan(state, 'keeper', {}).error);
    assert.ok(
      g.recordNpcCognition(
        state,
        'keeper',
        {},
        { knowledgeRevision: state.npcBrains.keeper.living.knowledgeRevision },
      ).error,
    );
    assert.ok(
      g.applyNpcSpeech(state, 'alice', 'keeper', { channel: 'say', text: 'Can you hear?' }).error,
    );
    assert.ok(
      g.commitNpcPublicUtterance(state, 'keeper', {
        channel: 'say',
        recipientId: 'alice',
        text: 'Hello',
        observationIds: [],
        contextHash: 'old',
      }).error,
    );
    assert.equal(
      g.npcSpeechListenerIds(state, 'alice', { channel: 'say', text: 'Hello' }).includes('keeper'),
      false,
    );
    assert.deepEqual(g.npcActionContext(state, 'keeper', ['alice']).targets, []);
    assert.equal(
      prepareNpcActionIntent(state, 'keeper', ['alice'], { actions: [{ kind: 'wait' }] }),
      undefined,
    );
    assert.throws(() => g.buildNpcDecisionContext(state, 'keeper'));
    assert.throws(() =>
      g.buildStoryTurnContext(
        state,
        'alice',
        { ...proposal(state, 'blocked').input, targetNpcId: 'keeper', text: 'Hello' },
        randomUUID(),
      ),
    );
    state.entities.food = {
      id: 'food',
      kind: 'item',
      mapId: npc.mapId,
      x: npc.x,
      y: npc.y,
      revision: 0,
      ownerId: 'keeper',
      item: { portable: true, edible: true },
    };
    npc.inventory = ['food'];
    assert.ok(g.consumeWorldItem(state, 'keeper', 'food').error);
    const memories = structuredClone(state.npcBrains.keeper.living.observations);
    const changed = g.recordNpcEvents(
      state,
      state,
      [{ kind: 'action.hit', actorId: 'alice', targetId: 'alice', mapId: npc.mapId }],
      'later',
    );
    assert.deepEqual(changed.state.npcBrains.keeper.living.observations, memories);
  }
});

test('harm reaches zero, recovery is distinct from revival, and old canon cannot kill twice', () => {
  const state = world();
  state.entities.keeper.vitality = 1;
  const injured = apply(state, 'harm');
  assert.equal(injured.error, undefined);
  assert.equal(injured.state.entities.keeper.lifeState, 'unconscious');
  assert.equal(injured.state.entities.keeper.vitality, 0);
  const recovered = apply(injured.state, 'recover', '*I bring Orin around*');
  assert.equal(recovered.error, undefined);
  assert.equal(recovered.state.entities.keeper.vitality, 1);
  assert.equal(recovered.state.entities.keeper.lifeState, 'conscious');
  assert.equal(recovered.actions.length, 0);
  const death = apply(recovered.state, 'death');
  assert.equal(apply(death.state, 'recover').error, 'FORBIDDEN');
  const revived = apply(
    death.state,
    'revive',
    '*I restore Orin to life by the established ritual*',
  );
  assert.equal(revived.error, undefined);
  assert.equal(revived.state.entities.keeper.lifeState, 'conscious');
  assert.ok(revived.state.entities.keeper.lifeRevision > death.state.entities.keeper.lifeRevision);
  const duplicate = g.applyStoryImpact(
    revived.state,
    'alice',
    death.sample.id,
    0,
    { targetId: 'keeper', effect: 'death' },
    death.sample.input,
  );
  assert.strictEqual(duplicate.state, revived.state);
  assert.deepEqual(duplicate.events, []);
  assert.equal(duplicate.state.entities.keeper.lifeState, 'conscious');
});

test('natural hit on an unconscious NPC stays semantic and can admit a fatal outcome', () => {
  const state = apply(world(), 'unconscious').state;
  const p = proposal(state, 'death', '*I hit Orin with a fatal blow*');
  assert.deepEqual(p.context.actionPreview, []);
  const result = g.applyStoryTurnProposal(state, 'alice', p.input, p.id, p.raw);
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.keeper.lifeState, 'dead');
  assert.equal(result.events.filter((e) => e.kind === 'action.hit').length, 1);
});

test('lifecycle witnesses require perception; seeing a later body does not reveal its killer', () => {
  const state = world();
  observer(state, 'witness', 7, 4);
  observer(state, 'absent', 7, 4).mapId = 'elsewhere';
  observer(state, 'sleeping', 7, 5).lifeState = 'unconscious';
  const result = apply(state, 'death');
  assert.equal(result.error, undefined);
  assert.ok(
    result.state.npcBrains.witness.living.observations.some(
      (o) => o.kind === 'died' && o.targetId === 'keeper' && o.actorId === 'alice',
    ),
  );
  assert.equal(
    result.state.npcBrains.absent.living.observations.some((o) => o.kind === 'died'),
    false,
  );
  assert.equal(result.state.npcBrains.sleeping.living.observations.length, 0);
  const later = result.state;
  later.entities.absent.mapId = later.entities.keeper.mapId;
  const perceived = g.refreshLivingPerception(later).state;
  const seen = perceived.npcBrains.absent.living.observations.find(
    (o) => o.kind === 'life_state_seen' && o.targetId === 'keeper',
  );
  assert.ok(seen);
  assert.equal(seen.lifeState, 'dead');
  assert.equal(seen.actorId, undefined);
});

test('painted-wall hidden target is absent from policy and cannot receive an impact', () => {
  const state = world();
  Object.assign(state.entities.keeper, { x: 8, y: 4 });
  const rows = Array.from({ length: 24 }, () => '.'.repeat(24));
  rows[4] = '.......#................';
  state.maps.observatory.spatialGrounding = {
    imageRevisionId: 'fixture',
    rows,
    doors: [],
    landmarks: [],
    confidence: 'high',
  };
  const p = proposal(state, 'death');
  assert.equal(
    p.context.narrativeImpactPolicy.targets.some((t) => t.targetId === 'keeper'),
    false,
  );
  assert.equal(
    p.context.director.visibleEntities.some((t) => t.id === 'keeper'),
    false,
  );
  const result = g.applyStoryTurnProposal(state, 'alice', p.input, p.id, p.raw);
  assert.equal(result.error, 'FORBIDDEN');
  assert.strictEqual(result.state, state);
});

test('mixed independent pickup and impact commit together; failed later pickup rolls everything back', () => {
  const state = world();
  state.entities.pebble = {
    id: 'pebble',
    label: 'pebble',
    kind: 'item',
    revision: 0,
    mapId: 'observatory',
    x: 5,
    y: 4,
    item: { portable: true },
  };
  const p = proposal(state, 'harm', '*I act toward Orin* *I pick up pebble*');
  p.raw.steps[1].action = { kind: 'pick_up', targetId: 'pebble' };
  const result = g.applyStoryTurnProposal(state, 'alice', p.input, p.id, p.raw);
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.pebble.ownerId, 'alice');
  assert.equal(result.state.entities.keeper.vitality, state.entities.keeper.vitality - 1);
  assert.deepEqual(
    result.actions.map((a) => a.action.kind),
    ['pick_up'],
  );
  const far = structuredClone(state);
  far.entities.pebble.x = 12;
  const failed = proposal(far, 'death', '*I act toward Orin* *I pick up pebble*');
  failed.raw.steps[1].action = { kind: 'pick_up', targetId: 'pebble' };
  const rejected = g.applyStoryTurnProposal(far, 'alice', failed.input, failed.id, failed.raw);
  assert.ok(rejected.error || rejected.clarification);
  assert.strictEqual(rejected.state, far);
  assert.equal(rejected.state.entities.keeper.lifeState, undefined);
});

test('legacy snapshots remain unconscious at zero and explicit death survives unrelated vitality changes', () => {
  const state = world();
  state.entities.keeper.vitality = 0;
  assert.equal(c.actorLifeState(state.entities.keeper), 'unconscious');
  assert.equal(
    g.projectState(state, 'alice').entities.find((e) => e.id === 'keeper').lifeState,
    'unconscious',
  );
  state.entities.keeper.lifeState = 'dead';
  state.entities.keeper.vitality = 4;
  assert.equal(c.isActorConscious(state.entities.keeper), false);
  assert.equal(
    g
      .storyImpactContext(state, 'alice')
      .find((t) => t.targetId === 'keeper')
      .allowedEffects.includes('recover'),
    false,
  );
});

test('received and queued old NPC jobs stay stale even after a new revival', async () => {
  const initial = world(),
    died = apply(initial, 'death').state,
    revived = apply(died, 'revive').state;
  const service = Object.create(GameService.prototype);
  for (const state of [died, revived]) {
    const response = await service.evaluateDecision('fixture', state, {
      id: 'old',
      npcId: 'keeper',
      purpose: 'plan',
      context: { turnFence: g.turnFence(state), lifeRevision: 0 },
      contextHash: 'old',
      proposal: {},
    });
    assert.equal(response.accepted, false);
    assert.equal(response.decisionCode, 'NPC_LIFECYCLE_CHANGED');
    assert.strictEqual(response.next, state);
  }
  const calls = [];
  service.reconcileIntents = async () => {};
  service.story = { reconcileTerminalTravel: async () => {} };
  service.db = {
    query: async () => [
      { id: 'queued-old', npc_id: 'keeper', purpose: 'plan', context: { lifeRevision: 0 } },
    ],
  };
  service.worldGeneration = { failUnspent: async (...a) => calls.push(a) };
  await service.processDecisionRequests('fixture', { state: revived });
  assert.deepEqual(calls, [['fixture', 'queued-old', 'NPC_LIFECYCLE_CHANGED']]);
  const queries = [];
  service.db = {
    query: async (...a) => {
      queries.push(a);
      return [];
    },
  };
  await service.cancelStaleNpcLifecycleJobs('fixture', revived);
  assert.equal(queries.length, 1);
  assert.match(queries[0][0], /cancel_requested=true/);
  assert.match(queries[0][0], /'reserved','result_received','validated'/);
  assert.doesNotMatch(queries[0][0], /'running'/);
  assert.deepEqual(queries[0][1], [
    'fixture',
    [],
    JSON.stringify({ keeper: String(revived.entities.keeper.lifeRevision) }),
  ]);
});

test('pre-death accepted plan and public speech cannot return after revival', () => {
  const initial = world();
  const oldPlan = g.createMockNpcPlan(initial, 'keeper');
  const context = g.buildNpcPublicSpeechContext(
    initial,
    'keeper',
    ['alice', 'keeper'],
    [],
    [],
    undefined,
    'en',
    'alice',
  );
  const dead = apply(initial, 'death').state;
  const revived = apply(dead, 'revive').state;
  const plan = g.acceptNpcPlan(revived, 'keeper', oldPlan);
  assert.ok(plan.error);
  assert.equal(g.currentNpcPlan(revived, 'keeper'), null);
  assert.equal(revived.entities.keeper.path, undefined);
  const speech = g.commitNpcPublicUtterance(revived, 'keeper', {
    text: 'An old answer.',
    channel: 'say',
    recipientId: 'alice',
    observationIds: [],
    contextHash: g.npcContextFingerprint(context),
  });
  assert.ok(speech.error);
  assert.strictEqual(speech.state, revived);
});
