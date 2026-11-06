const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');
const contracts = require('../../packages/contracts/dist');
function world(turnBased = false) {
  const draft = g.createCompleteObservatoryDraft();
  delete draft.supportingNpcPolicy;
  let state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice', 'bob']);
  Object.assign(state.entities.alice, { x: 5, y: 4, inventory: ['key'] });
  Object.assign(state.entities.key, { label: 'brass key', ownerId: 'alice' });
  Object.assign(state.entities.door, { x: 5, y: 5, open: false, locked: true });
  Object.assign(state.entities.keeper, { x: 6, y: 4, inventory: [] });
  Object.assign(state.entities.bob, { x: 7, y: 4 });
  if (turnBased) {
    state = g.initializeTurnController(state, ['alice', 'bob']).state;
    state = g.endPlayerTurn(state, 'alice', g.turnFence(state)).state;
    state = g.endPlayerTurn(state, 'bob', g.turnFence(state)).state;
  }
  return state;
}
const event = (description, effects = [], entityIds = []) => ({ description, effects, entityIds });
function proposal(state, text, events, extra = {}) {
  const turnId = randomUUID();
  const input = {
    operationId: randomUUID(),
    text,
    channel: 'say',
    replyLocale: 'en',
    expectedCanonRevision: state.narrativeCanon?.revision ?? 0,
    ...(state.turnController ? { turnFence: g.turnFence(state) } : {}),
    ...extra,
  };
  const context = g.buildStoryTurnContext(state, 'alice', input, turnId);
  const body = {
    turnId,
    contextHash: context.contextHash,
    status: 'ready',
    code: null,
    steps: context.segments.map((segment) => ({
      segmentIndex: segment.index,
      action: null,
      reply: null,
      ...(segment.kind === 'attempt' ? { establishedEvents: events[segment.index] ?? [] } : {}),
    })),
    narrative: {
      narration: events
        .flat()
        .map((value) => value.description)
        .join(' '),
      newScene: null,
      newNpc: null,
      evidenceIds: [],
    },
  };
  return {
    input,
    context,
    body,
    turnId,
    apply: () => g.applyStoryTurnProposal(state, 'alice', input, turnId, body),
  };
}
const open = { kind: 'door_state', targetId: 'door', open: true, locked: false };
for (const turnBased of [false, true])
  for (const text of [
    '*The permanently sealed door opened.*',
    '*Намертво закрытая дверь открылась.*',
    '*Наглухо зачинені двері відчинилися.*',
    '*open door*',
  ])
    test(`established opening changes both door fields atomically, ${turnBased}, ${text}`, () => {
      const state = world(turnBased),
        before = structuredClone(state);
      const p = proposal(state, text, [[event('The door opened.', [open], ['door'])]]);
      const result = p.apply();
      assert.equal(result.error, undefined);
      assert.equal(result.clarification, undefined);
      assert.equal(result.state.entities.door.open, true);
      assert.equal(result.state.entities.door.locked, false);
      assert.deepEqual(state, before);
      assert.ok(result.events.some((value) => value.kind === 'action.open'));
      assert.equal(
        result.state.narrativeCanon.turns.at(-1).establishedEvents[0].description,
        'The door opened.',
      );
      const replay = g.applyStoryTurnProposal(
        JSON.parse(JSON.stringify(result.state)),
        'alice',
        p.input,
        p.turnId,
        p.body,
      );
      assert.equal(replay.error, undefined);
      assert.equal(replay.events.length, 0);
      const altered = structuredClone(p.body);
      altered.steps[0].establishedEvents[0].description = 'Something else.';
      assert.equal(
        g.applyStoryTurnProposal(result.state, 'alice', p.input, p.turnId, altered).error,
        'INVALID_ACTION',
      );
    });
test('ordinary RP is established canon without a money or item side effect', () => {
  const state = world();
  state.narrativeConstraints = {
    allowNewScenes: true,
    allowNewNpcs: true,
    maxScenes: 16,
    maxSupportingNpcs: 16,
    maxTurns: 1,
    protectedFacts: [],
    forbiddenRoles: [],
  };
  state.narrativeCanon = {
    revision: 1,
    turns: [
      {
        id: randomUUID(),
        actorId: 'alice',
        requestHash: 'old',
        tick: 0,
        narration: 'Earlier',
        evidenceIds: [],
      },
    ],
  };
  const p = proposal(state, '*I paid the innkeeper in fictional coins and enjoyed the meal.*', [
    [event('The meal is paid for, and you enjoy it.')],
  ]);
  const result = p.apply();
  assert.equal(result.error, undefined);
  assert.deepEqual(result.state.entities, state.entities);
  assert.equal(result.state.narrativeCanon.turns.length, 2);
  assert.equal(
    result.state.npcBrains.keeper.living.observations.some(
      (value) => value.confidence === 'witnessed' && value.text?.includes('The meal is paid'),
    ),
    false,
  );
  assert.equal(
    result.state.narrativeCanon.turns.at(-1).establishedEvents[0].authority,
    'authored_fiction',
  );
  assert.equal(result.state.narrativeCanon.turns.at(-1).establishedEvents[0].effects.length, 0);
});
test('one event resolves prop creation, condition and custody in order without capacity gates', () => {
  const state = world();
  state.worldItemRules = { version: 1, inventoryCapacity: 1, maxWorldItems: 1, surfaceCapacity: 1 };
  const p = proposal(state, '*A paper flower appeared in my hand and I gave it to the keeper.*', [
    [
      event(
        'You give the paper flower to the keeper.',
        [
          {
            kind: 'create_prop',
            ref: 'flower',
            name: 'paper flower',
            description: 'Folded white paper.',
          },
          {
            kind: 'public_condition',
            targetId: 'flower',
            description: 'A small crease marks one petal.',
          },
          { kind: 'item_custody', itemId: 'flower', recipientId: 'keeper' },
        ],
        ['keeper'],
      ),
    ],
  ]);
  const result = p.apply();
  assert.equal(result.error, undefined);
  const item = Object.values(result.state.entities).find((value) => value.label === 'paper flower');
  assert.equal(item.ownerId, 'keeper');
  assert.ok(result.state.entities.keeper.inventory.includes(item.id));
  assert.ok(!result.state.entities.alice.inventory.includes(item.id));
  assert.match(item.publicCondition, /crease/);
});
test('tracked item placement then pickup and handoff preserve a single item identity', () => {
  const state = world();
  const p = proposal(
    state,
    '*The brass key lay on the ground, then I recovered it and handed it to the keeper.*',
    [
      [
        event(
          'The keeper receives the brass key.',
          [
            { kind: 'item_placement', itemId: 'key', point: { x: 5, y: 3 }, surfaceId: null },
            { kind: 'item_custody', itemId: 'key', recipientId: 'alice' },
            { kind: 'item_custody', itemId: 'key', recipientId: 'keeper' },
          ],
          ['key', 'keeper'],
        ),
      ],
    ],
  );
  const result = p.apply();
  assert.equal(result.error, undefined);
  assert.equal(result.clarification, undefined);
  assert.equal(result.state.entities.key.ownerId, 'keeper');
  assert.equal(result.state.entities.keeper.inventory.filter((id) => id === 'key').length, 1);
  assert.equal(Object.keys(result.state.entities).length, Object.keys(state.entities).length);
});
test('later invalid effect rolls back earlier opening and all event prose', () => {
  const state = world();
  const p = proposal(state, '*The door opened and Bob was teleported away.*', [
    [
      event('The door opens.', [
        open,
        {
          kind: 'relocate',
          targetId: 'bob',
          mapId: state.entities.alice.mapId,
          point: { x: 4, y: 3 },
        },
      ]),
    ],
  ]);
  const result = p.apply();
  assert.equal(result.error, 'FORBIDDEN');
  assert.equal(result.state, state);
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.entries, []);
});
for (const effect of [
  { kind: 'actor_state', targetId: 'bob', lifeState: 'dead', vitality: 0 },
  { kind: 'public_condition', targetId: 'bob', description: 'Bob agrees to everything.' },
  { kind: 'door_state', targetId: 'hidden-door', open: true, locked: false },
])
  test(`other player and hidden target authority is denied: ${effect.kind}`, () => {
    const state = world();
    state.entities['hidden-door'] = { ...state.entities.door, id: 'hidden-door', x: 12, y: 9 };
    const p = proposal(state, '*Something changes.*', [[event('Something changes.', [effect])]]);
    assert.equal(p.apply().error, 'FORBIDDEN');
  });
test('ordered lifecycle and relocation preserve NPC body and invalidate its old plans', () => {
  const state = world(true);
  const generation = state.npcBrains.keeper.generation;
  const p = proposal(state, '*The keeper fainted, recovered, and came to the open spot.*', [
    [
      event(
        'The keeper recovers and changes position.',
        [
          { kind: 'actor_state', targetId: 'keeper', lifeState: 'unconscious', vitality: 2 },
          { kind: 'actor_state', targetId: 'keeper', lifeState: 'conscious', vitality: 2 },
          {
            kind: 'relocate',
            targetId: 'keeper',
            mapId: state.entities.alice.mapId,
            point: { x: 6, y: 3 },
          },
        ],
        ['keeper'],
      ),
    ],
  ]);
  const result = p.apply();
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.keeper.lifeState, 'conscious');
  assert.equal(result.state.entities.keeper.y, 3);
  assert.ok(result.state.npcBrains.keeper.generation >= generation + 2);
});
test('speech cannot carry established effects and unrecognized fields cannot patch state', () => {
  const state = world(),
    p = proposal(state, 'The door opened.', []);
  p.body.narrative.narration = 'The door opened.';
  p.body.steps[0].establishedEvents = [event('The door opened.', [open])];
  assert.equal(p.apply().error, 'FORBIDDEN');
  p.body.steps[0].establishedEvents[0].effects = [{ kind: 'patch', path: 'wallet', value: 1000 }];
  assert.equal(contracts.storyTurnProposalSchema.safeParse(p.body).success, false);
});
test('private event prose stays private while the actual door state is shared', () => {
  const state = world();
  const p = proposal(
    state,
    '*PRIVATE RP CANARY: the door opened.*',
    [[event('PRIVATE RP CANARY: the door opened.', [open], ['door'])]],
    { channel: 'whisper', targetNpcId: 'keeper' },
  );
  const result = p.apply();
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.door.open, true);
  assert.ok(!JSON.stringify(g.projectState(result.state, 'bob')).includes('PRIVATE RP CANARY'));
  assert.ok(
    !result.state.npcBrains.keeper.living.observations.some(
      (value) => value.kind === 'roleplay_established' && value.audienceIds.includes('bob'),
    ),
  );
  const next = g.buildNarrativeContext(result.state, 'bob', 'Continue');
  assert.ok(!JSON.stringify(next).includes('PRIVATE RP CANARY'));
});
test('more than six segments and two RP events retain every original segment index', () => {
  const state = world();
  const text = Array.from({ length: 8 }, (_, index) => `*gesture ${index}* words ${index}`).join(
    ' ',
  );
  const segments = g.parseStorySegments(text).segments;
  assert.equal(segments.length, 16);
  const events = segments.map((segment) =>
    segment.kind === 'attempt' ? [event(segment.text)] : [],
  );
  const p = proposal(state, text, events);
  const result = p.apply();
  assert.equal(result.error, undefined);
  assert.equal(result.state.narrativeCanon.turns.at(-1).establishedEvents.length, 8);
  assert.equal(result.entries.filter((value) => value.kind === 'attempt').length, 8);
});
test('stale frozen object geometry rejects the complete established proposal', () => {
  const state = world(),
    p = proposal(state, '*The door opened.*', [[event('The door opened.', [open])]]);
  state.entities.door.revision++;
  state.entities.door.x++;
  assert.equal(p.apply().error, 'STALE_STATE');
});
test('an additional ordinary prop can share a visible or hidden object name without an oracle', () => {
  for (const duplicate of ['visible', 'hidden']) {
    const state = world();
    state.entities.anotherCup = {
      id: 'anotherCup',
      kind: 'item',
      label: 'ordinary cup',
      mapId: duplicate === 'visible' ? 'observatory' : 'roof',
      x: 5,
      y: 3,
      revision: 1,
    };
    const result = proposal(state, '*I took out another ordinary cup.*', [
      [
        event('Another ordinary cup is in my hand.', [
          { kind: 'create_prop', ref: 'cup', name: 'ordinary cup', description: 'A plain cup.' },
        ]),
      ],
    ]).apply();
    assert.equal(result.error, undefined);
    assert.equal(
      Object.values(result.state.entities).filter((entity) => entity.label === 'ordinary cup')
        .length,
      2,
    );
    assert.deepEqual(result.state.entities.anotherCup, state.entities.anotherCup);
  }
});
test('a model cannot steal a visible player-owned item or publish private event prose in an entity', () => {
  const state = world();
  Object.assign(state.entities.key, { ownerId: 'bob' });
  state.entities.alice.inventory = [];
  state.entities.bob.inventory = ['key'];
  const steal = proposal(state, '*I took the brass key from Bob.*', [
    [event('The key is mine.', [{ kind: 'item_custody', itemId: 'key', recipientId: 'alice' }])],
  ]).apply();
  assert.equal(steal.error, 'FORBIDDEN');
  assert.equal(steal.state, state);
  const publish = proposal(
    state,
    '*A private thought.*',
    [
      [
        event('PRIVATE CONDITION', [
          { kind: 'public_condition', targetId: 'alice', description: 'PRIVATE CONDITION' },
        ]),
      ],
    ],
    { channel: 'whisper', targetNpcId: 'keeper' },
  ).apply();
  assert.equal(publish.error, 'FORBIDDEN');
  assert.equal(publish.state, state);
});
test('self authored death and revival keep participant membership and do not control another player', () => {
  let state = world(true);
  const bob = structuredClone(state.entities.bob);
  state = proposal(state, '*I died and then returned to life.*', [
    [
      event('I died and returned.', [
        { kind: 'actor_state', targetId: 'alice', lifeState: 'dead', vitality: 0 },
        { kind: 'actor_state', targetId: 'alice', lifeState: 'conscious', vitality: 6 },
      ]),
    ],
  ]).apply().state;
  assert.equal(state.entities.alice.lifeState, 'conscious');
  assert.deepEqual(state.turnController.actorOrder, ['alice', 'bob']);
  assert.equal(state.turnController.phase, 'world');
  assert.deepEqual(state.entities.bob, bob);
});
test('legacy encounter action budget does not veto authored RP and stale own intent is cleared', () => {
  const state = world();
  state.encounters.old = {
    id: 'old',
    mapId: 'observatory',
    generation: 1,
    round: 1,
    phase: 'planning',
    participants: ['alice', 'keeper'],
    area: { x: 4, y: 3, width: 4, height: 4 },
    deadlineMs: 1000,
    intents: { alice: { revision: 1, ready: true, action: { kind: 'wait' } } },
  };
  state.entities.alice.encounterId = 'old';
  state.entities.keeper.encounterId = 'old';
  const result = proposal(state, '*The door opened.*', [
    [event('The door opened.', [open])],
  ]).apply();
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.door.open, true);
  assert.equal(result.state.encounters.old.intents.alice, undefined);
  assert.ok(result.state.encounters.old.participants.includes('keeper'));
});
test('relocation uses the frozen public destination catalog without exposing remote contents', () => {
  const state = world();
  state.entities.remoteSecret = {
    id: 'remoteSecret',
    kind: 'item',
    label: 'REMOTE SECRET CANARY',
    mapId: 'roof',
    x: 1,
    y: 1,
    revision: 1,
  };
  const context = g.establishedRoleplayContext(state, 'alice', 'I move');
  assert.ok(context.destinations.some((map) => map.id === 'roof'));
  assert.equal(JSON.stringify(context).includes('REMOTE SECRET CANARY'), false);
  assert.equal(JSON.stringify(context).includes('remoteSecret'), false);
  const before = structuredClone(state);
  const bad = proposal(state, '*I appeared elsewhere.*', [
    [
      event('I appeared elsewhere.', [
        { kind: 'relocate', targetId: 'alice', mapId: 'unlisted', point: { x: 2, y: 2 } },
      ]),
    ],
  ]).apply();
  assert.equal(bad.error, 'FORBIDDEN');
  assert.deepEqual(state, before);
});
test('new narrative locations and NPCs do not stop at legacy lifetime counters', () => {
  const state = world();
  state.narrativeConstraints = {
    allowNewScenes: true,
    allowNewNpcs: true,
    maxScenes: 1,
    maxSupportingNpcs: 1,
    maxTurns: 1,
    protectedFacts: [],
    forbiddenRoles: [],
  };
  state.entities.keeper.supportingNpc = {
    generated: true,
    roleId: 'old',
    roleLabel: 'old role',
    description: 'Old',
    appearance: 'Old',
    personalitySummary: 'Old',
  };
  const text = 'Continue exploring';
  const body = g.createMockNarrativeProposal(state, 'alice', text, randomUUID());
  assert.ok(body.newScene);
  assert.ok(body.newNpc);
  const context = g.buildNarrativeContext(state, 'alice', text);
  for (const name of ['maxTurns', 'maxScenes', 'maxSupportingNpcs'])
    assert.equal(context.constraints[name], undefined);
  assert.equal(g.applyNarrativeProposal(state, 'alice', body, text).error, undefined);
});
test('modern mock keeps ordinary RP as canon and known locked-door actions as real outcomes', () => {
  for (const text of ['*I smiled and enjoyed my dinner.*', '*open door*']) {
    const state = world();
    const input = { operationId: randomUUID(), text, channel: 'say', expectedCanonRevision: 0 };
    const id = randomUUID();
    const body = g.createMockStoryTurnProposal(state, 'alice', input, id);
    assert.equal(body.status, 'ready');
    assert.ok(body.steps[0].establishedEvents.length);
    const result = g.applyStoryTurnProposal(state, 'alice', input, id, body);
    assert.equal(result.error, undefined);
    assert.ok(result.state.narrativeCanon.turns.at(-1).establishedEvents.length);
    if (text.includes('door')) assert.equal(result.state.entities.door.open, true);
    assert.doesNotMatch(
      result.state.narrativeCanon.turns.at(-1).narration,
      /merely|intention|not yet/i,
    );
  }
});
test('claimed changed tracked IDs cannot be canonized without their corresponding typed effect', () => {
  for (const id of ['door', 'bob']) {
    const state = world();
    const result = proposal(state, '*A tracked state changed.*', [
      [event('A tracked state changed.', [], [id])],
    ]).apply();
    assert.equal(result.error, 'FORBIDDEN');
    assert.equal(result.state, state);
  }
});
test('long established receipts stay complete while an omitted advisory voice uses bounded feed narration', () => {
  const state = world();
  const descriptions = ['A', 'B', 'C'].map((letter) => letter.repeat(900));
  const p = proposal(state, '*I gesture.* Hello', [descriptions.map((text) => event(text)), []]);
  p.body.narrative.narration = 'A compact narration.';
  const voice = p.context.sceneSpeakers?.find((entry) => entry.segmentIndex === 1);
  assert.ok(voice);
  p.body.steps[1] = {
    segmentIndex: 1,
    action: null,
    reply: { text: 'Unadmitted advisory words.' },
    replyNpcId: voice.npcId,
    replyContextHash: voice.speechHash,
  };
  const result = p.apply();
  assert.equal(result.error, undefined);
  const turn = result.state.narrativeCanon.turns.at(-1);
  assert.deepEqual(
    turn.establishedEvents.map((entry) => entry.description),
    descriptions,
  );
  assert.ok(turn.narration.length <= 2000);
  assert.ok(
    result.entries
      .filter((entry) => entry.kind === 'narration')
      .every((entry) => entry.text.length <= 2000),
  );
  assert.equal(
    contracts.gameProjectionSchema.safeParse(g.projectState(result.state, 'alice')).success,
    true,
  );
});
test('free prose is nonmechanical canon and cannot become witnessed physics even beside a valid effect', () => {
  for (const effects of [[], [open]]) {
    const state = world(),
      bob = structuredClone(state.entities.bob);
    const text = 'Bob died and the locked door opened.';
    const result = proposal(state, `*${text}*`, [[event(text, effects)]]).apply();
    assert.equal(result.error, undefined);
    assert.deepEqual(result.state.entities.bob, bob);
    assert.equal(result.state.entities.door.open, effects.length > 0);
    assert.ok(
      !Object.values(result.state.npcBrains).some((brain) =>
        brain.living?.observations.some(
          (observation) =>
            observation.confidence === 'witnessed' && observation.text?.includes(text),
        ),
      ),
    );
    const canon = g.buildNarrativeContext(result.state, 'alice', 'Continue').confirmedTurns.at(-1);
    assert.equal(canon.establishedEvents[0].authority, 'authored_fiction');
    assert.match(
      g.buildNarrativeContext(result.state, 'alice', 'Continue').confirmedTurnsPolicy,
      /not witnessed physical evidence/,
    );
  }
});
test('old in-flight policy hash fails stale without acquiring established authority or changing state', () => {
  const state = world();
  const p = proposal(state, '*The door opened.*', [[event('The door opened.', [open])]]);
  p.body.contextHash = 'previous-policy-context-hash';
  const result = p.apply();
  assert.equal(result.error, 'STALE_STATE');
  assert.equal(result.state, state);
  assert.deepEqual(result.events, []);
});
test('lifetime growth does not make a valid admitted state undecodable at projection boundaries', () => {
  const state = world();
  for (let index = 0; index < 32; index++) {
    const id = `room-${index}`;
    state.maps[id] = { ...structuredClone(state.maps.roof), id, label: `Room ${index}` };
  }
  for (let index = 0; index < 128; index++) {
    const id = `carried-${index}`;
    state.entities[id] = {
      id,
      kind: 'item',
      mapId: 'observatory',
      x: 5,
      y: 4,
      ownerId: 'alice',
      label: 'Cup',
      revision: 1,
    };
    state.entities.alice.inventory.push(id);
  }
  const result = proposal(state, '*I took out one more cup.*', [
    [
      event('Another cup is in my hand.', [
        { kind: 'create_prop', ref: 'cup', name: 'Cup', description: 'Ordinary cup.' },
      ]),
    ],
  ]).apply();
  assert.equal(result.error, undefined);
  const projection = g.projectState(result.state, 'alice');
  assert.ok(projection.inventory.length > 128);
  assert.ok(projection.locations.length > 32);
  assert.equal(contracts.gameProjectionSchema.safeParse(projection).success, true);
});
test('a loaded save beyond visible entity and scene participant thresholds remains decodable', () => {
  const state = world();
  for (let index = 0; index < 513; index++) {
    const id = `visible-${index}`;
    state.entities[id] = {
      id,
      kind: 'item',
      label: 'Keepsake',
      mapId: 'observatory',
      x: 5,
      y: 4,
      revision: 1,
    };
  }
  let projection = g.projectState(JSON.parse(JSON.stringify(state)), 'alice');
  assert.ok(projection.entities.length > 512);
  assert.equal(contracts.gameProjectionSchema.safeParse(projection).success, true);
  const map = state.maps.observatory;
  map.spatialMode = 'location_only';
  map.spawns = [];
  map.blocked = [];
  map.exits = [];
  delete map.composition;
  delete map.spatialGrounding;
  const participants = Object.values(state.entities).filter(
    (entity) => entity.mapId === map.id && !entity.ownerId,
  );
  for (const entity of participants) {
    entity.spatialMode = 'location_only';
    entity.sceneId = 'room';
    delete entity.x;
    delete entity.y;
  }
  map.scenePresence = {
    version: 1,
    entrySceneId: 'room',
    scenes: [
      {
        id: 'room',
        participantIds: participants.map((entity) => entity.id),
        evidence: { kind: 'committed_event', reference: 'loaded-old-save' },
      },
    ],
  };
  projection = g.projectState(JSON.parse(JSON.stringify(state)), 'alice');
  assert.ok(projection.map.scenePresence.scenes[0].participantIds.length > 128);
  assert.equal(contracts.gameProjectionSchema.safeParse(projection).success, true);
});
test('one atomic authored relocation can move self then an initially visible NPC without controlling peers', () => {
  const state = world();
  const destination = 'arrival-room';
  state.maps[destination] = {
    ...structuredClone(state.maps.roof),
    id: destination,
    label: 'Arrival room',
    blocked: [],
    exits: [],
    spawns: [{ x: 2, y: 2 }],
  };
  const beforeBob = structuredClone(state.entities.bob);
  const result = proposal(state, '*The keeper and I appeared together in the arrival room.*', [
    [
      event('We arrived together.', [
        { kind: 'relocate', targetId: 'alice', mapId: destination, point: { x: 2, y: 2 } },
        { kind: 'relocate', targetId: 'keeper', mapId: destination, point: { x: 3, y: 2 } },
      ]),
    ],
  ]).apply();
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.alice.mapId, destination);
  assert.equal(result.state.entities.keeper.mapId, destination);
  assert.deepEqual(result.state.entities.bob, beforeBob);
  assert.deepEqual(result.entries.find((entry) => entry.kind === 'narration').audienceIds, [
    'alice',
  ]);
});
test('typed placement distinguishes authored surfaces from image-grounded floor evidence', () => {
  for (const scenario of [
    'known-table',
    'unknown-table',
    'unverified-image',
    'verified-image-table',
    'verified-image-binding-only-table',
    'verified-image-floor',
  ]) {
    const state = world();
    state.maps.observatory.composition = {
      version: 1,
      provenance: 'original-drawn-fixture',
      layers: [{ id: 'table', visual: 'table', x: 5, y: 3, width: 1, height: 1, solid: true }],
    };
    if (scenario !== 'verified-image-floor') state.maps.observatory.blocked.push({ x: 5, y: 3 });
    else state.maps.observatory.composition.layers = [];
    if (scenario.startsWith('verified-image')) {
      const map = state.maps.observatory;
      const revisionId = randomUUID(),
        sha256 = 'a'.repeat(64);
      map.locationImage = { revisionId, sha256 };
      map.spatialGrounding = {
        version: 1,
        imageRevisionId: revisionId,
        imageSha256: sha256,
        confidence: 1,
        rows: Array.from({ length: map.height }, () => '.'.repeat(map.width)),
        landmarks: [],
      };
      state.artBindings = [
        {
          slot: 'map:observatory:background',
          revisionId,
          sha256,
          mime: 'image/png',
          width: 1024,
          height: 1024,
        },
      ];
    }
    if (scenario === 'verified-image-binding-only-table')
      delete state.maps.observatory.locationImage;
    if (scenario === 'unverified-image')
      state.maps.observatory.locationImage = { revisionId: randomUUID(), sha256: 'a'.repeat(64) };
    const before = structuredClone(state);
    const p = proposal(
      state,
      scenario === 'verified-image-floor'
        ? '*I set the brass key on the ground.*'
        : '*I set the brass key on the table.*',
      [
        [
          event(
            scenario === 'verified-image-floor'
              ? 'The key rests on the ground.'
              : 'The key rests on the table.',
            [
              {
                kind: 'item_placement',
                itemId: 'key',
                point: { x: 5, y: 3 },
                surfaceId:
                  scenario === 'verified-image-floor'
                    ? null
                    : scenario === 'unknown-table'
                      ? 'guessed-surface'
                      : 'table',
              },
            ],
          ),
        ],
      ],
    );
    const result = p.apply();
    if (scenario === 'known-table' || scenario === 'verified-image-floor') {
      assert.equal(result.error, undefined);
      assert.equal(result.state.entities.key.ownerId, undefined);
      assert.equal(
        result.state.entities.key.item?.surfaceId,
        scenario === 'known-table' ? 'table' : undefined,
      );
      assert.deepEqual([result.state.entities.key.x, result.state.entities.key.y], [5, 3]);
    } else {
      assert.equal(result.error, 'FORBIDDEN');
      assert.equal(result.state, state);
      assert.deepEqual(state, before, scenario + ': rejected placement must remain atomic');
      assert.equal(state.entities.key.ownerId, 'alice');
      assert.ok(state.entities.alice.inventory.includes('key'));
    }
  }
});
test('explicit player RP can materialize a scene and NPC despite autonomous creation flags', () => {
  const state = world();
  state.narrativeConstraints = {
    allowNewScenes: false,
    allowNewNpcs: false,
    maxScenes: 1,
    maxSupportingNpcs: 1,
    maxTurns: 1,
    protectedFacts: [],
    forbiddenRoles: [],
  };
  const p = proposal(state, '*A new garden and its gardener appeared.*', [
    [event('A garden and its gardener appeared.')],
  ]);
  assert.equal(p.context.director.constraints.allowNewScenes, true);
  assert.equal(p.context.director.constraints.allowNewNpcs, true);
  assert.deepEqual(p.context.director.autonomousAuthoring, {
    allowNewScenes: false,
    allowNewNpcs: false,
  });
  const authored = g.createMockNarrativeProposal(
    state,
    'alice',
    p.input.text,
    p.turnId,
    'en',
    undefined,
    true,
  );
  assert.ok(authored.newScene);
  assert.ok(authored.newNpc);
  p.body.narrative.newScene = authored.newScene;
  p.body.narrative.newNpc = authored.newNpc;
  const result = p.apply();
  assert.equal(result.error, undefined);
  assert.ok(result.state.maps[`scene-${p.turnId}`]);
  assert.ok(result.state.entities[`support-${p.turnId}`]);
  assert.equal(result.state.narrativeConstraints.allowNewScenes, false);
  assert.equal(result.state.narrativeConstraints.allowNewNpcs, false);
  assert.deepEqual(result.state.artBindings, state.artBindings);
  const autonomous = {
    ...authored,
    contextHash: g.buildNarrativeContext(state, 'alice', p.input.text).contextHash,
  };
  assert.equal(
    g.applyNarrativeProposal(state, 'alice', autonomous, p.input.text).error,
    'FORBIDDEN',
  );
});
test('ordinary RP does not require a new picture or verified image geometry', () => {
  const state = world();
  state.maps.observatory.locationImage = { revisionId: randomUUID(), sha256: 'b'.repeat(64) };
  const p = proposal(state, '*I enjoyed dinner and told a harmless story.*', [
    [event('Dinner was enjoyed and a story was told.')],
  ]);
  const result = p.apply();
  assert.equal(result.error, undefined);
  assert.equal(result.state.narrativeCanon.turns.at(-1).establishedEvents.length, 1);
  assert.deepEqual(result.state.entities, state.entities);
  assert.deepEqual(result.state.artBindings, state.artBindings);
});
test('named carried capabilities use whole word references, not substrings in unrelated words', () => {
  const state = world();
  state.entities.key.label = 'key';
  assert.equal(
    g
      .establishedRoleplayContext(state, 'alice', 'I greeted a monkey.')
      .entities.some((entry) => entry.id === 'key'),
    false,
  );
  assert.equal(
    g
      .establishedRoleplayContext(state, 'alice', 'I hold the key.')
      .entities.some((entry) => entry.id === 'key'),
    true,
  );
});

test('recognized mock actions preserve disabled autonomous creation while explicit new travel remains possible', () => {
  for (const text of ['*wait*', '*inspect door*']) {
    const state = world();
    state.narrativeConstraints = {
      ...state.narrativeConstraints,
      allowNewScenes: false,
      allowNewNpcs: false,
    };
    const id = randomUUID();
    const input = { operationId: randomUUID(), text, channel: 'say', expectedCanonRevision: 0 };
    const body = g.createMockStoryTurnProposal(state, 'alice', input, id);
    assert.equal(body.narrative.newScene, null, text);
    assert.equal(body.narrative.newNpc, null, text);
    const result = g.applyStoryTurnProposal(state, 'alice', input, id, body);
    assert.equal(result.error, undefined, text);
    assert.deepEqual(Object.keys(result.state.maps), Object.keys(state.maps));
    assert.deepEqual(Object.keys(result.state.entities), Object.keys(state.entities));
  }
  const state = world();
  state.narrativeConstraints = {
    ...state.narrativeConstraints,
    allowNewScenes: false,
    allowNewNpcs: false,
  };
  const id = randomUUID();
  const input = {
    operationId: randomUUID(),
    text: '*go to Moon garden*',
    channel: 'say',
    expectedCanonRevision: 0,
  };
  const body = g.createMockStoryTurnProposal(state, 'alice', input, id);
  assert.equal(body.narrative.newScene?.name, 'Moon garden');
  assert.equal(body.narrative.newNpc, null);
  const result = g.applyStoryTurnProposal(state, 'alice', input, id, body);
  assert.equal(result.error, undefined);
  assert.equal(result.state.maps[`scene-${id}`]?.label, 'Moon garden');
});
