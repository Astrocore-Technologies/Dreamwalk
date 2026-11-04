const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');
function fixture(
  text = '*подходя к месту, парень остановился перед профессором* Профессор, Мира сказала что не знает ни о каком пропуске',
) {
  const draft = g.createCompleteObservatoryDraft();
  delete draft.supportingNpcPolicy;
  const state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice', 'bob']);
  const input = {
    operationId: randomUUID(),
    text,
    channel: 'say',
    expectedCanonRevision: 0,
    replyLocale: 'ru',
  };
  const turnId = randomUUID();
  const context = g.buildStoryTurnContext(state, 'alice', input, turnId);
  const seed = g.createMockNarrativeProposal(state, 'alice', text, turnId, 'ru');
  const spawn = context.director.availableConnections.find(
    (p) => Math.abs(p.x - state.entities.alice.x) + Math.abs(p.y - state.entities.alice.y) >= 3,
  );
  assert.ok(spawn);
  const proposal = {
    turnId,
    contextHash: context.contextHash,
    status: 'ready',
    code: null,
    steps: [
      { segmentIndex: 0, action: { kind: 'approach', targetId: 'new_npc' }, reply: null },
      {
        segmentIndex: 1,
        action: null,
        replyNpcId: 'new_npc',
        reply: { text: 'Мира так сказала? О каком пропуске речь?' },
      },
    ],
    narrative: {
      narration: 'Профессор поднимает глаза от стола, когда ты подходишь.',
      newScene: null,
      newNpc: {
        ...seed.newNpc,
        name: 'Профессор Орин',
        roleLabel: 'Профессор',
        placement: 'current',
        spawn,
        knownEntityIds: [],
      },
      evidenceIds: [],
    },
  };
  return { state, input, turnId, context, proposal };
}
const apply = (f) => g.applyStoryTurnProposal(f.state, 'alice', f.input, f.turnId, f.proposal);
test('coauthor materializes professor, approaches, records attributed claim and replies in one atomic turn', () => {
  const f = fixture(),
    before = JSON.stringify(f.state),
    result = apply(f);
  assert.equal(result.error, undefined);
  assert.equal(result.clarification, undefined);
  assert.equal(JSON.stringify(f.state), before);
  const id = `support-${f.turnId}`,
    professor = result.state.entities[id];
  assert.equal(professor.label, 'Профессор Орин');
  assert.equal(professor.mapId, f.state.entities.alice.mapId);
  assert.equal(g.footprintDistance(result.state.entities.alice, professor), 1);
  assert.ok(result.events.some((e) => e.kind === 'narrative.npc_created' && e.actorId === id));
  assert.ok(result.events.some((e) => e.kind === 'actor.moved' && e.actorId === 'alice'));
  assert.equal(result.entries.find((e) => e.kind === 'npc_reply').authorId, id);
  const memory = result.state.npcBrains[id].living.observations;
  assert.ok(memory.some((o) => o.kind === 'said' && o.actorId === 'alice'));
  assert.ok(
    !memory.some((o) => o.kind === 'authored_fact' && JSON.stringify(o).includes('пропуске')),
  );
  assert.equal(result.actions[0].targetLabel, 'Профессор Орин');
  assert.equal(result.actions[0].action.kind, 'approach'); // Existing confirmation pipeline must approve new interpretation.
  assert.deepEqual(result.state.entities.bob, f.state.entities.bob);
  assert.deepEqual(result.state.entities.keeper, f.state.entities.keeper);
  const restored = JSON.parse(JSON.stringify(result.state));
  assert.ok(g.projectState(restored, 'alice').entities.some((e) => e.id === id));
  const next = {
    ...f.input,
    operationId: randomUUID(),
    text: 'Как вас зовут?',
    targetNpcId: id,
    expectedCanonRevision: 1,
  };
  const nextContext = g.buildStoryTurnContext(restored, 'alice', next, randomUUID());
  assert.ok(JSON.stringify(nextContext.dialogues).includes('Мира сказала'));
});
test('director spawn and dialogue roll back together if actor cannot approach', () => {
  const f = fixture();
  f.proposal.steps[0].action.targetId = 'missing';
  const result = apply(f);
  assert.ok(result.error || result.clarification);
  assert.equal(result.state, f.state);
  assert.deepEqual(result.events, []);
});
test('speech alone cannot carry a movement action', () => {
  const f = fixture('Профессор, подойдите.');
  f.proposal.steps = [
    { segmentIndex: 0, action: { kind: 'approach', targetId: 'new_npc' }, reply: null },
  ];
  assert.equal(apply(f).error, 'INVALID_ACTION');
});
test('distant reply is rejected rather than claiming an unperformed arrival', () => {
  const f = fixture('Профессор, Мира сказала, что пропуска нет.');
  f.proposal.steps = [
    {
      segmentIndex: 0,
      action: null,
      replyNpcId: 'new_npc',
      reply: { text: 'Что именно она сказала?' },
    },
  ];
  const result = apply(f);
  assert.equal(result.error, 'OUT_OF_RANGE');
  assert.equal(result.state, f.state);
});
test('protected identity and invalid spawn cannot be made real by prose', () => {
  for (const change of [
    (p) => (p.narrative.newNpc.name = 'Keeper'),
    (p) => (p.narrative.newNpc.spawn = { x: 0, y: 0 }),
  ]) {
    const f = fixture();
    // Use actual authored label instead of assuming locale.
    if (change.toString().includes('Keeper'))
      f.proposal.narrative.newNpc.name = f.state.entities.keeper.label;
    else change(f.proposal);
    const result = apply(f);
    assert.ok(result.error);
    assert.equal(result.state, f.state);
  }
});
test('whispers cannot materialize or speak through a fresh public actor', () => {
  const f = fixture();
  Object.assign(f.state.entities.alice, { x: 5, y: 4 });
  f.input = { ...f.input, targetNpcId: 'keeper', channel: 'whisper' };
  f.proposal.contextHash = g.buildStoryTurnContext(f.state, 'alice', f.input, f.turnId).contextHash;
  assert.equal(apply(f).error, 'FORBIDDEN');
});
test('semantic movement attempts reach the model without language-specific movement keyword denial', () => {
  for (const text of [
    '*walk to the professor* Hello',
    '*подхожу к профессору* Здравствуйте',
    '*наближаюся до професора* Вітаю',
  ]) {
    const f = fixture(text);
    assert.equal(f.context.segments[0].kind, 'attempt');
    assert.ok(f.context.allowedActions.includes('approach'));
  }
});
test('existing character replies bind to its own admitted voice context, not director canon', () => {
  const f = fixture('Что ты слышал?');
  Object.assign(f.state.entities.alice, { x: 5, y: 4 });
  const context = g.buildStoryTurnContext(f.state, 'alice', f.input, f.turnId);
  const voice = context.sceneSpeakers.find((v) => v.npcId === 'keeper' && v.segmentIndex === 0);
  assert.ok(voice);
  assert.ok(voice.currentUtterance);
  f.proposal.contextHash = context.contextHash;
  f.proposal.narrative = {
    narration: 'Смотритель поворачивается к тебе.',
    newScene: null,
    newNpc: null,
    evidenceIds: [],
  };
  f.proposal.steps = [
    {
      segmentIndex: 0,
      action: null,
      replyNpcId: 'keeper',
      replyContextHash: voice.speechHash,
      reply: { text: 'Я слышал твой вопрос.' },
    },
  ];
  assert.equal(apply(f).error, undefined);
  f.proposal.steps[0].replyContextHash = 'director-omniscience';
  assert.equal(apply(f).error, 'STALE_STATE');
  delete f.proposal.steps[0].replyContextHash;
  assert.equal(apply(f).error, 'STALE_STATE');
});
test('world phase can materialize an adjacent professor but cannot fast-forward player movement', () => {
  const f = fixture('Профессор, Мира сказала что не знает о пропуске.');
  f.state = g.initializeTurnController(f.state, ['alice', 'bob']).state;
  while (f.state.turnController.phase === 'player')
    f.state = g.endPlayerTurn(
      f.state,
      f.state.turnController.activeActorId,
      g.turnFence(f.state),
    ).state;
  const context = g.buildStoryTurnContext(f.state, 'alice', f.input, f.turnId);
  assert.ok(!context.allowedActions.includes('approach'));
  const spawn = context.director.availableConnections.find(
    (p) => g.footprintDistance(f.state.entities.alice, { ...p }) === 1,
  );
  assert.ok(spawn);
  f.proposal.contextHash = context.contextHash;
  f.proposal.narrative.newNpc.spawn = spawn;
  f.proposal.steps = [
    {
      segmentIndex: 0,
      action: null,
      replyNpcId: 'new_npc',
      reply: { text: 'Расскажи, что именно она сказала.' },
    },
  ];
  const result = apply(f);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.state.entities.alice, f.state.entities.alice);
  assert.equal(result.state.entities[`support-${f.turnId}`].mapId, f.state.entities.alice.mapId);
});
test('descriptive director emote has no mechanical outcome or fabricated spoken memory', () => {
  const f = fixture('*останавливается, задумавшись*');
  f.proposal.steps = [{ segmentIndex: 0, action: null, reply: null }];
  const result = apply(f);
  assert.equal(result.error, undefined);
  assert.equal(result.clarification, undefined);
  assert.deepEqual(result.state.entities.alice, f.state.entities.alice);
  assert.equal(result.actions.length, 0);
  assert.equal(
    result.entries.filter((e) => e.kind === 'outcome' || e.kind === 'npc_reply').length,
    0,
  );
  assert.equal(result.state.npcUtterances?.length ?? 0, f.state.npcUtterances?.length ?? 0);
});
test('deferred director cannot smuggle any mechanical action through an emote', () => {
  const f = fixture('*wait*');
  f.state = g.initializeTurnController(f.state, ['alice', 'bob']).state;
  while (f.state.turnController.phase === 'player')
    f.state = g.endPlayerTurn(
      f.state,
      f.state.turnController.activeActorId,
      g.turnFence(f.state),
    ).state;
  f.proposal.contextHash = g.buildStoryTurnContext(f.state, 'alice', f.input, f.turnId).contextHash;
  f.proposal.steps = [{ segmentIndex: 0, action: { kind: 'wait' }, reply: null }];
  const result = apply(f);
  assert.equal(result.error, 'FORBIDDEN');
  assert.equal(result.state, f.state);
});
test('shared narrator voice previews exclude locally permitted whispers and private provisioning', () => {
  const f = fixture('Question');
  Object.assign(f.state.entities.alice, { x: 5, y: 4 });
  f.state.entities.bob.mapId = 'roof';
  f.state.npcBrains.keeper.living.observations.push({
    id: 'old-whisper',
    eventId: 'old-whisper',
    rootId: 'old-whisper',
    tick: 0,
    kind: 'said',
    actorId: 'alice',
    text: 'PRIVATE_WHISPER_CANARY',
    confidence: 1,
    disclosure: 'participants',
    audienceIds: ['alice', 'keeper'],
    depth: 0,
  });
  f.state.npcBrains.keeper.living.observations.push({
    id: 'asked-secret',
    eventId: 'asked-secret',
    rootId: 'asked-secret',
    tick: 0,
    kind: 'authored_fact',
    title: 'Question',
    definitionText: 'PRIVATE_ASKED_CANARY',
    confidence: 1,
    disclosure: 'private',
    revealCondition: 'asked',
    audienceIds: [],
    depth: 0,
  });
  f.state.worldItemDefinitions = [{ id: 'private-stock', label: 'PRIVATE_STOCK_CANARY' }];
  f.state.entities.keeper.itemStock = [{ definitionId: 'private-stock', quantity: 1 }];
  const selected = g.buildStoryTurnContext(
    f.state,
    'alice',
    { ...f.input, targetNpcId: 'keeper' },
    randomUUID(),
  );
  assert.ok(JSON.stringify(selected).includes('PRIVATE_WHISPER_CANARY'));
  const shared = g.buildStoryTurnContext(f.state, 'alice', f.input, f.turnId);
  assert.ok(shared.sceneSpeakers.length);
  assert.ok(!JSON.stringify(shared).includes('PRIVATE_'));
  assert.ok(
    shared.sceneSpeakers.every(
      (v) => v.itemProvisioning === undefined && v.spatialContext === undefined,
    ),
  );
});
test('existing speaker preview observes preceding pickup in the same ordered turn', () => {
  const f = fixture('Hello');
  f.input.text = '*pick up key* Hello';
  Object.assign(f.state.entities.alice, { x: 5, y: 4 });
  Object.assign(f.state.entities.key, { x: 5, y: 5 });
  const context = g.buildStoryTurnContext(f.state, 'alice', f.input, f.turnId);
  assert.equal(context.actionPreview[0].action.kind, 'pick_up');
  const voice = context.sceneSpeakers.find((v) => v.npcId === 'keeper' && v.segmentIndex === 1);
  assert.ok(voice);
  f.proposal.contextHash = context.contextHash;
  f.proposal.narrative = {
    narration: 'Смотритель замечает поднятый ключ.',
    newScene: null,
    newNpc: null,
    evidenceIds: [],
  };
  f.proposal.steps = [
    { segmentIndex: 0, action: { kind: 'pick_up', targetId: 'key' }, reply: null },
    {
      segmentIndex: 1,
      action: null,
      replyNpcId: 'keeper',
      replyContextHash: voice.speechHash,
      reply: { text: 'Привет.' },
    },
  ];
  const result = apply(f);
  assert.equal(result.error, undefined);
  assert.equal(result.clarification, undefined);
  assert.ok(result.state.entities.alice.inventory.includes('key'));
  assert.equal(result.entries.filter((e) => e.kind === 'npc_reply').length, 1);
});
test('new nearby NPC does not stale an existing speaker when public voice evidence stays the same', () => {
  const f = fixture('Hello');
  Object.assign(f.state.entities.alice, { x: 5, y: 4 });
  const context = g.buildStoryTurnContext(f.state, 'alice', f.input, f.turnId);
  const voice = context.sceneSpeakers.find((v) => v.npcId === 'keeper' && v.segmentIndex === 0);
  assert.ok(voice);
  f.proposal.contextHash = context.contextHash;
  f.proposal.narrative.newNpc.spawn = context.director.availableConnections.find(
    (p) => g.footprintDistance(f.state.entities.alice, p) === 1,
  );
  f.proposal.steps = [
    {
      segmentIndex: 0,
      action: null,
      replyNpcId: 'keeper',
      replyContextHash: voice.speechHash,
      reply: { text: 'Привет. Чем могу помочь?' },
    },
  ];
  const result = apply(f);
  assert.equal(result.error, undefined);
  assert.equal(result.clarification, undefined);
  assert.ok(result.state.entities[`support-${f.turnId}`]);
  assert.equal(result.entries.find((e) => e.kind === 'npc_reply').authorId, 'keeper');
});

function existingSpeakerFixture(text = 'Will you accompany me?', prepare = (state) => state) {
  const f = fixture(text);
  Object.assign(f.state.entities.alice, { x: 5, y: 4 });
  f.state = prepare(f.state);
  const context = g.buildStoryTurnContext(f.state, 'alice', f.input, f.turnId);
  const voice = context.sceneSpeakers.find((v) => v.npcId === 'keeper' && v.segmentIndex === 0);
  assert.ok(voice?.replyToObservationId);
  f.proposal.contextHash = context.contextHash;
  f.proposal.narrative = {
    narration: 'The keeper answers.',
    newScene: null,
    newNpc: null,
    evidenceIds: [],
  };
  f.proposal.steps = [
    {
      segmentIndex: 0,
      action: null,
      replyNpcId: 'keeper',
      replyContextHash: voice.speechHash,
      reply: { text: 'I will accompany you.' },
    },
  ];
  return { ...f, voice };
}

test('director existing-speaker agreement binds the current speech and preserves follow/stop', () => {
  for (const kind of ['follow', 'stop']) {
    const f = existingSpeakerFixture('Will you accompany me?', (state) => {
      if (kind === 'stop')
        state.npcBrains.keeper.living.companionship = {
          actorId: 'alice',
          sourceObservationId: 'prior-agreement',
          utteranceId: 'prior-reply',
          crossings: [],
        };
      return state;
    });
    f.proposal.steps[0].reply.companionIntent = {
      kind,
      actorId: 'alice',
      sourceObservationId: f.voice.replyToObservationId,
    };
    const result = apply(f);
    assert.equal(result.error, undefined);
    assert.equal(result.state.narrativeCanon.revision, 1);
    assert.equal(result.entries.filter((entry) => entry.kind === 'npc_reply').length, 1);
    assert.equal(
      result.state.npcBrains.keeper.living.companionship?.actorId,
      kind === 'follow' ? 'alice' : undefined,
    );
    if (kind === 'follow')
      assert.equal(
        result.state.npcBrains.keeper.living.companionship.sourceObservationId,
        f.voice.replyToObservationId,
      );
    assert.equal(
      f.state.npcBrains.keeper.living.companionship?.actorId,
      kind === 'stop' ? 'alice' : undefined,
    );
  }
});

test('director existing-speaker wait uses the exact current source without private action context', () => {
  const f = existingSpeakerFixture('Please wait here.');
  assert.equal(f.voice.actionContext, undefined);
  f.proposal.steps[0].reply = {
    text: 'I will wait here.',
    actionIntent: {
      sourceObservationId: f.voice.replyToObservationId,
      actions: [{ kind: 'wait' }],
    },
  };
  const result = apply(f);
  assert.equal(result.error, undefined);
  assert.deepEqual(result.state.npcBrains.keeper.plan, [{ kind: 'wait' }]);
  assert.equal(
    result.state.npcBrains.keeper.planSource.sourceObservationId,
    f.voice.replyToObservationId,
  );
  assert.deepEqual(result.state.entities.alice, f.state.entities.alice);
});

test('director wrong-source intents roll back narration and NPC effects atomically', () => {
  for (const intent of ['companionIntent', 'actionIntent']) {
    const f = existingSpeakerFixture();
    f.proposal.steps[0].reply[intent] =
      intent === 'companionIntent'
        ? { kind: 'follow', actorId: 'alice', sourceObservationId: 'old-or-foreign-source' }
        : { sourceObservationId: 'old-or-foreign-source', actions: [{ kind: 'wait' }] };
    const context = g.buildStoryTurnContext(f.state, 'alice', f.input, f.turnId);
    const seed = g.createMockNarrativeProposal(f.state, 'alice', f.input.text, f.turnId, 'ru');
    f.proposal.narrative.newNpc = {
      ...seed.newNpc,
      name: 'New Witness',
      roleLabel: 'Witness',
      placement: 'current',
      spawn: context.director.availableConnections.find(
        (point) => g.footprintDistance(f.state.entities.alice, point) === 1,
      ),
      knownEntityIds: [],
    };
    const before = JSON.stringify(f.state);
    const result = apply(f);
    assert.equal(result.error, 'FORBIDDEN');
    assert.equal(result.state, f.state);
    assert.equal(JSON.stringify(f.state), before);
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.events, []);
  }
});

test('director intents cannot use unavailable movement targets or newborn source identities', () => {
  const existing = existingSpeakerFixture();
  existing.proposal.steps[0].reply.actionIntent = {
    sourceObservationId: existing.voice.replyToObservationId,
    actions: [{ kind: 'move_to', target: { x: 3, y: 6 } }],
  };
  assert.equal(apply(existing).error, 'FORBIDDEN');
  for (const intent of ['companionIntent', 'actionIntent']) {
    const f = fixture();
    // Even knowing the deterministic marker after an independently admitted plain reply
    // cannot supply a source the newborn's original provider context never contained.
    const plain = apply(f);
    assert.equal(plain.error, undefined);
    const source = plain.state.npcBrains[`support-${f.turnId}`].living.observations.find(
      (o) => o.kind === 'said' && o.actorId === 'alice',
    ).id;
    f.proposal.steps[1].reply[intent] =
      intent === 'companionIntent'
        ? { kind: 'follow', actorId: 'alice', sourceObservationId: source }
        : { sourceObservationId: source, actions: [{ kind: 'wait' }] };
    const result = apply(f);
    assert.equal(result.error, 'FORBIDDEN');
    assert.equal(result.state, f.state);
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.events, []);
  }
});

test('director cannot bind a current reply to an older authorized observation in the same voice', () => {
  const f = existingSpeakerFixture('Wait here now.', (state) => {
    const result = g.applyNpcSpeech(
      state,
      'alice',
      'keeper',
      {
        channel: 'say',
        text: 'Come with me earlier.',
      },
      { suppressReply: true, identity: { turnId: randomUUID(), segmentIndex: 0 } },
    );
    assert.equal(result.error, undefined);
    return result.state;
  });
  const old = f.voice.claims.find(
    (claim) => claim.actorId === 'alice' && claim.observationId !== f.voice.replyToObservationId,
  );
  assert.ok(old);
  assert.ok(f.voice.observationIds.includes(old.observationId));
  for (const intent of ['companionIntent', 'actionIntent']) {
    f.proposal.steps[0].reply = {
      text: 'I agree.',
      [intent]:
        intent === 'companionIntent'
          ? { kind: 'follow', actorId: 'alice', sourceObservationId: old.observationId }
          : { sourceObservationId: old.observationId, actions: [{ kind: 'wait' }] },
    };
    const result = apply(f);
    assert.equal(result.error, 'FORBIDDEN');
    assert.equal(result.state, f.state);
    assert.deepEqual(result.entries, []);
    assert.deepEqual(result.events, []);
  }
});
