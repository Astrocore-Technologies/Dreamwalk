const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');
const c = require('../../packages/contracts/dist');
function world(turns = false) {
  const draft = g.createCompleteObservatoryDraft();
  delete draft.supportingNpcPolicy;
  const state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice', 'bob']);
  return turns ? g.initializeTurnController(state, ['alice', 'bob']).state : state;
}
const input = (text) => ({
  operationId: randomUUID(),
  text,
  channel: 'say',
  expectedCanonRevision: 0,
  replyLocale: 'ru',
});
test('explicit multilingual travel intent resolves names, not negated/hypothetical speech', () => {
  assert.equal(
    g.requestedLocation('Парень решил пойти в кафе синяя синичка'),
    'кафе синяя синичка',
  );
  assert.equal(g.requestedLocation('Дівчина вирішила піти до кав’ярні'), 'кав’ярні');
  assert.equal(g.requestedLocation('I decided to go to Blue Bird Cafe.'), 'Blue Bird Cafe');
  for (const text of [
    'Он не пошёл в кафе',
    'Если он пошёл в кафе',
    'go to Cafe?',
    'I would go to Cafe',
    'Лира хочет в кафе',
    'подошёл к Мире',
  ])
    assert.equal(g.requestedLocation(text), null, text);
  const s = world();
  const destination = Object.values(s.maps).find((m) => m.id !== s.entities.alice.mapId);
  assert.equal(
    g.parsePlayerTextAction(s, 'alice', `пойти в ${destination.label ?? destination.id}`).targetId,
    destination.id,
  );
});
test('existing location scene cut works from anywhere, ignores route/door, is free and preserves other players', () => {
  const s = world(true),
    before = structuredClone(s.turnController.resources.alice);
  const destination = Object.values(s.maps).find((m) => m.id !== s.entities.alice.mapId);
  s.maps[s.entities.alice.mapId].exits = [];
  const result = g.applyTurnAction(
    s,
    'alice',
    { kind: 'travel', targetId: destination.id },
    g.turnFence(s),
  );
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.alice.mapId, destination.id);
  assert.deepEqual(result.state.entities.bob, s.entities.bob);
  assert.deepEqual(result.state.turnController.resources.alice, before);
  assert.equal(
    result.state.entities.alice.movementGeneration,
    s.entities.alice.movementGeneration + 1,
  );
  assert.equal(
    g.applyTurnAction(s, 'bob', { kind: 'travel', targetId: destination.id }, g.turnFence(s)).error,
    'WRONG_MODE',
  );
  assert.equal(
    g.applyTurnAction(
      s,
      'alice',
      { kind: 'travel', targetId: destination.id },
      { ...g.turnFence(s), phaseEpoch: 9 },
    ).error,
    'STALE_STATE',
  );
  assert.equal(
    g.applyTurnAction(s, 'alice', { kind: 'travel', targetId: 'missing' }, g.turnFence(s)).error,
    'TARGET_UNAVAILABLE',
  );
});
test('only consenting present companions move, preserving knowledge and collision-safe footprints', () => {
  const s = world();
  Object.assign(s.entities.alice, { x: 5, y: 4 });
  s.npcBrains.keeper.living.companionship = { actorId: 'alice', crossings: [] };
  const destination = Object.values(s.maps).find((m) => m.id !== s.entities.alice.mapId);
  const secret = structuredClone(s.npcBrains.keeper.living.observations);
  const result = g.travelToLocation(s, 'alice', destination.id);
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.keeper.mapId, destination.id);
  assert.equal(
    c.footprintOverlaps(result.state.entities.alice, result.state.entities.keeper),
    false,
  );
  assert.deepEqual(result.state.npcBrains.keeper.living.observations, secret);
  delete s.npcBrains.keeper.living.companionship;
  assert.equal(
    g.travelToLocation(s, 'alice', destination.id).state.entities.keeper.mapId,
    s.entities.keeper.mapId,
  );
});
test('incapacitated companions never follow a scene cut despite a retained agreement or positive vitality', () => {
  for (const condition of [
    { lifeState: 'unconscious', vitality: 5 },
    { lifeState: 'dead', vitality: 5 },
    { vitality: 0 },
  ]) {
    const s = world();
    Object.assign(s.entities.alice, { x: 5, y: 4 });
    Object.assign(s.entities.keeper, condition);
    s.npcBrains.keeper.living.companionship = { actorId: 'alice', crossings: [] };
    const destination = Object.values(s.maps).find((m) => m.id !== s.entities.alice.mapId);
    const result = g.travelToLocation(s, 'alice', destination.id);
    assert.equal(result.error, undefined);
    assert.equal(result.state.entities.alice.mapId, destination.id);
    assert.deepEqual(result.state.entities.keeper, s.entities.keeper);
    assert.equal(
      result.events.some((event) => event.actorId === 'keeper'),
      false,
    );
  }
});
test('direct travel helper cannot move an incapacitated player', () => {
  const s = world();
  Object.assign(s.entities.alice, { lifeState: 'unconscious', vitality: 5 });
  const destination = Object.values(s.maps).find((m) => m.id !== s.entities.alice.mapId);
  const result = g.travelToLocation(s, 'alice', destination.id);
  assert.equal(result.error, 'FORBIDDEN');
  assert.strictEqual(result.state, s);
  assert.deepEqual(result.events, []);
});
test('blocked destination rejects atomically, even with companions', () => {
  const s = world();
  const map = Object.values(s.maps).find((m) => m.id !== s.entities.alice.mapId);
  map.blocked = Array.from({ length: map.width * map.height }, (_, i) => ({
    x: i % map.width,
    y: Math.floor(i / map.width),
  }));
  const result = g.travelToLocation(s, 'alice', map.id);
  assert.equal(result.error, 'PATH_BLOCKED');
  assert.strictEqual(result.state, s);
  assert.deepEqual(result.events, []);
});
test('generated destination and arrival commit atomically in realtime and world phase', () => {
  for (const turns of [false, true]) {
    const s = world(turns);
    if (turns) {
      s.turnController.phase = 'world';
      s.turnController.activeActorId = null;
    }
    const i = input('*Парень решил пойти в кафе синяя синичка*'),
      id = randomUUID();
    const proposal = g.createMockStoryTurnProposal(s, 'alice', i, id);
    assert.equal(proposal.steps[0].action.kind, 'travel');
    assert.equal(proposal.narrative.newScene.name, 'кафе синяя синичка');
    const result = g.applyStoryTurnProposal(s, 'alice', i, id, proposal);
    assert.equal(result.error, undefined);
    assert.equal(result.state.entities.alice.mapId, `scene-${id}`);
    assert.equal(result.state.maps[`scene-${id}`].label, 'кафе синяя синичка');
    assert.equal(result.state.narrativeCanon.turns.length, 1);
    assert.equal(result.state.entities.bob.mapId, s.entities.bob.mapId);
    assert.ok(result.events.some((e) => e.kind === 'narrative.scene_created'));
    assert.ok(result.events.some((e) => e.kind === 'actor.transitioned'));
    const missingAction = structuredClone(proposal);
    missingAction.steps[0].action = null;
    assert.strictEqual(g.applyStoryTurnProposal(s, 'alice', i, id, missingAction).state, s);
    const wrongName = structuredClone(proposal);
    wrongName.narrative.newScene.name = 'Unrequested castle';
    assert.equal(g.applyStoryTurnProposal(s, 'alice', i, id, wrongName).error, 'FORBIDDEN');
  }
});
test('travel cannot be invented from ordinary speech, remote NPC intent or a private whisper', () => {
  const s = world(),
    id = randomUUID(),
    i = input('Let us think about a cafe');
  const p = g.createMockStoryTurnProposal(s, 'alice', i, id);
  p.steps[0].action = { kind: 'travel', targetId: Object.keys(s.maps)[1] };
  assert.ok(g.applyStoryTurnProposal(s, 'alice', i, id, p).error);
  assert.equal(g.travelToLocation(s, 'keeper', Object.keys(s.maps)[1]).error, 'FORBIDDEN');
  const privateInput = { ...input('*go to Cafe*'), channel: 'whisper' };
  const privateId = randomUUID();
  const privateContext = g.buildStoryTurnContext(s, 'alice', privateInput, privateId);
  assert.equal(privateContext.mode, 'director');
  assert.deepEqual(privateContext.outputAudienceIds, ['alice']);
  const privateProposal = g.createMockStoryTurnProposal(s, 'alice', privateInput, privateId);
  const rejected = g.applyStoryTurnProposal(s, 'alice', privateInput, privateId, privateProposal);
  assert.ok(rejected.error || rejected.clarification);
  assert.strictEqual(rejected.state, s);
  assert.equal(rejected.pendingTravel, undefined);
});
test('location catalog contains public labels only, no remote actors, secrets or map geometry', () => {
  const s = world();
  const view = g.projectState(s, 'alice');
  assert.equal(view.locations.length, Object.keys(s.maps).length);
  for (const location of view.locations)
    assert.ok(
      Object.keys(location).every((key) => ['id', 'label', 'labelTranslations'].includes(key)),
    );
  assert.equal(c.gameProjectionSchema.safeParse(view).success, true);
});

test('travel resolves the same authored destination by localized public labels', () => {
  const s = world(),
    map = Object.values(s.maps)[1];
  map.labelTranslations = { ru: 'Старая крыша', en: 'Old Roof' };
  assert.equal(g.resolveTravelRequest(s, 'иду на старую крышу')?.mapId, map.id);
  assert.equal(g.resolveTravelRequest(s, 'иду на Старая крыша').mapId, map.id);
  assert.equal(g.resolveTravelRequest(s, 'go to Old Roof').mapId, map.id);
});
test('semantic mixed RP commits its item once and stages a missing destination without a regex or fake arrival', () => {
  const s = world(true);
  s.turnController.phase = 'world';
  s.turnController.activeActorId = null;
  const i = {
    ...input(
      '*pick up notebook* *Собравшись с мыслями, парень выбрал следующим пристанищем Синий салон*',
    ),
    turnFence: g.turnFence(s),
  };
  const id = randomUUID();
  const context = g.buildStoryTurnContext(s, 'alice', i, id);
  assert.deepEqual(context.travelRequests, []);
  const intent = {
    segmentIndex: 1,
    destinationName: 'Синий салон',
    description: 'Тихий салон с витражами в духе этого города.',
    template: 'room',
  };
  const proposal = {
    turnId: id,
    contextHash: context.contextHash,
    status: 'ready',
    code: null,
    travelIntent: intent,
    steps: [
      { segmentIndex: 0, action: { kind: 'pick_up', targetId: 'new_item' }, reply: null },
      { segmentIndex: 1, action: null, reply: null },
    ],
    narrative: {
      narration: 'Блокнот в кармане. Герой направляется к салону.',
      newItem: { name: 'notebook', description: 'A plain pocket notebook.' },
      newScene: null,
      newNpc: null,
      evidenceIds: [],
    },
  };
  const r = g.applyStoryTurnProposal(s, 'alice', i, id, proposal);
  assert.equal(r.error, undefined);
  assert.equal(r.clarification, undefined);
  assert.deepEqual(r.pendingTravel, intent);
  assert.deepEqual(r.state.entities.alice.inventory, [`prop-${id}`]);
  assert.equal(r.state.entities.alice.mapId, s.entities.alice.mapId);
  assert.equal(Object.keys(r.state.maps).length, Object.keys(s.maps).length);
  assert.equal(r.state.narrativeCanon.turns.length, 1);
  const replay = g.applyStoryTurnProposal(r.state, 'alice', i, id, proposal);
  assert.ok(replay.error);
  assert.equal(replay.state.entities.alice.inventory.length, 1);
});
test('semantic existing destination uses catalog resolution and never moves another player', () => {
  const s = world(true);
  s.turnController.phase = 'world';
  s.turnController.activeActorId = null;
  const destination = Object.values(s.maps).find((m) => m.id !== s.entities.alice.mapId);
  const i = input('*He puts this place behind him, choosing a new setting for the next chapter*'),
    id = randomUUID();
  const context = g.buildStoryTurnContext(s, 'alice', i, id);
  const p = {
    turnId: id,
    contextHash: context.contextHash,
    status: 'ready',
    code: null,
    travelIntent: {
      segmentIndex: 0,
      destinationName: destination.label ?? destination.id,
      description: 'Existing public destination.',
      template: 'room',
    },
    steps: [{ segmentIndex: 0, action: null, reply: null }],
    narrative: { narration: 'He sets off.', newScene: null, newNpc: null, evidenceIds: [] },
  };
  const r = g.applyStoryTurnProposal(s, 'alice', i, id, p);
  assert.equal(r.error, undefined);
  assert.equal(r.pendingTravel, undefined);
  assert.equal(r.state.entities.alice.mapId, destination.id);
  assert.deepEqual(r.state.entities.bob, s.entities.bob);
  assert.equal(
    g.applyStoryTurnProposal(s, 'alice', i, id, {
      ...p,
      travelIntent: { ...p.travelIntent, segmentIndex: 4 },
    }).error,
    'FORBIDDEN',
  );
  assert.equal(g.requestedLocation('go to «Coffee and Silence»'), 'Coffee and Silence');
  assert.equal(g.requestedLocation('go to «Do not disturb»'), 'Do not disturb');
});

test('mixed existing travel previews and commits destination pickup and speech in their original order', () => {
  const s = world(true);
  s.turnController.phase = 'world';
  s.turnController.activeActorId = null;
  s.maps.roof.blocked = [];
  Object.assign(s.entities.journal, { x: 3, y: 3 });
  Object.assign(s.entities.keeper, { mapId: 'roof', x: 2, y: 4 });
  const i = {
    ...input('*go to Rooftop* *pick up journal* Hello from the roof.'),
    turnFence: g.turnFence(s),
  };
  const id = randomUUID();
  const context = g.buildStoryTurnContext(s, 'alice', i, id);
  assert.deepEqual(context.travelRequests, []);
  assert.deepEqual(
    context.actionPreview.map((entry) => entry.action.kind),
    ['travel', 'pick_up'],
  );
  assert.equal(context.actionPreview[0].action.targetId, 'roof');
  const voice = context.sceneSpeakers.find((entry) => entry.npcId === 'keeper');
  assert.ok(voice, 'the following speech sees the destination NPC, not the original scene');
  assert.equal(voice.segmentIndex, 2);
  assert.equal(voice.currentPlace.name, 'Rooftop');
  const proposal = {
    turnId: id,
    contextHash: context.contextHash,
    status: 'ready',
    code: null,
    steps: context.segments.map((segment) => ({
      segmentIndex: segment.index,
      action:
        context.actionPreview.find((entry) => entry.segmentIndex === segment.index)?.action ?? null,
      reply: null,
    })),
    narrative: {
      narration: 'At the rooftop, the journal is picked up before the greeting.',
      newScene: null,
      newNpc: null,
      evidenceIds: [],
    },
  };
  const done = g.applyStoryTurnProposal(s, 'alice', i, id, proposal);
  assert.equal(done.error, undefined);
  assert.equal(done.clarification, undefined);
  assert.equal(done.pendingTravel, undefined);
  assert.equal(done.state.entities.alice.mapId, 'roof');
  assert.ok(done.state.entities.alice.inventory.includes('journal'));
  assert.equal(done.state.entities.journal.ownerId, 'alice');
  assert.equal(done.state.turnController.phase, 'world');
  assert.equal(
    done.state.turnController.resources.alice.main,
    s.turnController.resources.alice.main,
  );
  assert.equal(
    done.state.turnController.resources.alice.additional,
    s.turnController.resources.alice.additional,
  );
  assert.deepEqual(done.state.entities.bob, s.entities.bob);
  assert.ok(
    done.state.npcUtterances.some(
      (utterance) =>
        utterance.text === 'Hello from the roof.' && utterance.audienceIds.includes('keeper'),
    ),
  );
  const altered = structuredClone(proposal);
  altered.steps[0].action.targetId = s.entities.alice.mapId;
  assert.equal(g.applyStoryTurnProposal(s, 'alice', i, id, altered).error, 'FORBIDDEN');
  altered.steps[0].action.targetId = 'new_scene';
  assert.equal(g.applyStoryTurnProposal(s, 'alice', i, id, altered).error, 'FORBIDDEN');
  const replay = g.applyStoryTurnProposal(done.state, 'alice', i, id, proposal);
  assert.ok(replay.error);
  assert.equal(
    replay.state.entities.alice.inventory.filter((item) => item === 'journal').length,
    1,
  );
});

function travelImpactCase() {
  const s = world(true);
  s.turnController.phase = 'world';
  s.turnController.activeActorId = null;
  s.maps.roof.blocked = [];
  s.entities['roof-guide'] = {
    ...structuredClone(s.entities.keeper),
    id: 'roof-guide',
    label: 'Roof guide',
    mapId: 'roof',
    x: 2,
    y: 4,
  };
  s.npcBrains['roof-guide'] = structuredClone(s.npcBrains.keeper);
  const i = {
    ...input('*go to Rooftop* *I strike the figure waiting beside the rooftop door*'),
    turnFence: g.turnFence(s),
  };
  const id = randomUUID();
  const context = g.buildStoryTurnContext(s, 'alice', i, id);
  const proposal = {
    turnId: id,
    contextHash: context.contextHash,
    status: 'ready',
    code: null,
    steps: [
      {
        segmentIndex: 0,
        action: context.actionPreview.find((entry) => entry.segmentIndex === 0).action,
        reply: null,
      },
      {
        segmentIndex: 1,
        action: null,
        reply: null,
        narrativeImpact: { targetId: 'roof-guide', effect: 'harm' },
      },
    ],
    narrative: {
      narration: 'The traveler reaches the rooftop and injures the figure there.',
      newScene: null,
      newNpc: null,
      evidenceIds: [],
    },
  };
  return { s, i, id, context, proposal };
}
test('travel then impact uses the destination attempt snapshot and commits one durable outcome', () => {
  const { s, i, id, context, proposal } = travelImpactCase();
  assert.equal(
    context.narrativeImpactPolicy.targets.some((target) => target.targetId === 'roof-guide'),
    false,
  );
  const targets = context.narrativeImpactPolicy.segmentTargets.find(
    (entry) => entry.segmentIndex === 1,
  ).targets;
  const target = targets.find((entry) => entry.targetId === 'roof-guide');
  assert.ok(target);
  const result = g.applyStoryTurnProposal(s, 'alice', i, id, proposal);
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.alice.mapId, 'roof');
  assert.equal(result.state.entities['roof-guide'].vitality, target.vitality - target.maxDamage);
  assert.deepEqual(result.state.entities.keeper, s.entities.keeper);
  assert.equal(
    result.state.narrativeCanon.turns.find((turn) => turn.id === id).impact.targetId,
    'roof-guide',
  );
  const replay = g.applyStoryTurnProposal(result.state, 'alice', i, id, proposal);
  assert.ok(replay.error);
  assert.equal(
    replay.state.entities['roof-guide'].vitality,
    result.state.entities['roof-guide'].vitality,
  );
});
test('travel then impact cannot use initial visibility to affect a character left behind', () => {
  const { s, i, id, context, proposal } = travelImpactCase();
  assert.ok(context.narrativeImpactPolicy.targets.some((target) => target.targetId === 'keeper'));
  assert.equal(
    context.narrativeImpactPolicy.segmentTargets
      .find((entry) => entry.segmentIndex === 1)
      .targets.some((target) => target.targetId === 'keeper'),
    false,
  );
  proposal.steps[1].narrativeImpact.targetId = 'keeper';
  const rejected = g.applyStoryTurnProposal(s, 'alice', i, id, proposal);
  assert.equal(rejected.error, 'FORBIDDEN');
  assert.strictEqual(rejected.state, s);
  assert.equal(rejected.pendingTravel, undefined);
});
