const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require(process.env.DREAMWALK_CORE_SOURCE ?? '../../packages/game-core/dist');
const c = require('../../packages/contracts/dist');
function scene() {
  const draft = g.createCompleteObservatoryDraft();
  delete draft.supportingNpcPolicy;
  const state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice', 'bob']);
  const mapId = state.entities.alice.mapId;
  const map = state.maps[mapId];
  Object.assign(map, {
    spatialMode: 'location_only',
    blocked: [],
    spawns: [],
    exits: [],
    scenePresence: {
      version: 1,
      entrySceneId: 'meeting',
      scenes: [
        {
          id: 'meeting',
          participantIds: [],
          evidence: { kind: 'authored_scene', reference: 'opening-meeting' },
        },
        {
          id: 'elsewhere',
          participantIds: [],
          evidence: { kind: 'authored_scene', reference: 'separate-room' },
        },
      ],
    },
  });
  delete map.spatialGrounding;
  delete map.composition;
  for (const entity of Object.values(state.entities).filter((e) => e.mapId === mapId)) {
    delete entity.x;
    delete entity.y;
    delete entity.path;
    delete entity.movementTrace;
    entity.spatialMode = 'location_only';
    entity.sceneId = entity.id === 'bob' ? 'elsewhere' : 'meeting';
    if (!entity.ownerId)
      map.scenePresence.scenes.find((s) => s.id === entity.sceneId).participantIds.push(entity.id);
    if (state.npcBrains?.[entity.id]) delete state.npcBrains[entity.id].patrolTarget;
  }
  return state;
}
function input(text, targetNpcId = 'keeper', channel = 'say') {
  return {
    operationId: randomUUID(),
    text,
    channel,
    ...(targetNpcId ? { targetNpcId } : {}),
    expectedCanonRevision: 0,
  };
}
function apply(state, i) {
  const id = randomUUID(),
    proposal = g.createMockStoryTurnProposal(state, 'alice', i, id);
  return { id, proposal, result: g.applyStoryTurnProposal(state, 'alice', i, id, proposal) };
}
test('location-only speech uses explicit scene encounter, not map-wide knowledge or distance', () => {
  const state = scene();
  assert.equal(c.hasPosition(state.entities.alice), false);
  assert.equal(g.canNpcHear(state, state.entities.keeper, state.entities.alice), true);
  assert.equal(g.canNpcHear(state, state.entities.bob, state.entities.alice), false);
  assert.equal(g.visible(state, state.entities.alice, state.entities.bob), false);
  const { result } = apply(state, input('Hello'));
  assert.equal(result.error, undefined);
  assert.ok(result.state.npcUtterances.some((u) => u.speakerId === 'keeper'));
  assert.ok(result.state.npcUtterances.every((u) => !u.audienceIds.includes('bob')));
  assert.equal(result.state.entities.alice.x, undefined);
  const context = g.buildNarrativeContext(state, 'alice', 'Hello');
  assert.equal(context.currentScene.actorPosition, undefined);
  assert.equal(context.availableConnections.length, 0);
});
test('location-only whisper excludes even an established bystander and private author evidence', () => {
  const state = scene(),
    map = state.maps[state.entities.alice.mapId];
  state.entities.bob.sceneId = 'meeting';
  map.scenePresence.scenes[1].participantIds = [];
  map.scenePresence.scenes[0].participantIds.push('bob');
  state.npcBrains.keeper.living.personality.speechStyle = 'PRIVATE AUTHOR SECRET';
  const i = input('Only for you', 'keeper', 'whisper');
  const context = g.buildStoryTurnContext(state, 'alice', i, randomUUID());
  assert.ok(!JSON.stringify(context).includes('PRIVATE AUTHOR SECRET'));
  const { result } = apply(state, i);
  assert.equal(result.error, undefined);
  for (const utterance of result.state.npcUtterances) {
    assert.deepEqual([...utterance.audienceIds].sort(), ['alice', 'keeper']);
  }
  assert.ok(
    result.entries
      .filter((e) => e.kind === 'speech' || e.kind === 'npc_reply')
      .every((e) => !e.audienceIds.includes('bob')),
  );
});
test('unplaced physical intentions remain attributed attempts without fabricated completion', () => {
  const state = scene();
  const { result } = apply(state, input('*walk to keeper*', null));
  assert.equal(result.error, undefined);
  assert.equal(result.clarification, undefined);
  assert.ok(
    result.state.npcBrains.keeper.living.observations.some(
      (o) => o.kind === 'attempted' && o.confidence === 'reported',
    ),
  );
  assert.equal(result.state.entities.alice.x, undefined);
  assert.equal(result.state.entities.alice.path, undefined);
  assert.ok(!result.events.some((e) => e.kind === 'actor.moved'));
  assert.ok(!result.entries.some((e) => e.code === 'ACTION_SUCCEEDED'));
});
test('location-only semantic lifecycle is admitted, remembered, outsider-safe and replay-safe', () => {
  const state = scene(),
    i = input('*I knock keeper unconscious*', null),
    id = randomUUID();
  const proposal = g.createMockStoryTurnProposal(state, 'alice', i, id);
  proposal.steps[0].narrativeImpact = { targetId: 'keeper', effect: 'unconscious' };
  proposal.narrative.narration = 'The keeper loses consciousness.';
  const result = g.applyStoryTurnProposal(state, 'alice', i, id, proposal);
  assert.equal(result.error, undefined);
  assert.equal(c.actorLifeState(result.state.entities.keeper), 'unconscious');
  assert.equal(result.state.entities.keeper.x, undefined);
  assert.ok(!g.storyImpactContext(state, 'alice').some((e) => e.targetId === 'bob'));
  const repeat = g.applyStoryImpact(
    result.state,
    'alice',
    id,
    0,
    proposal.steps[0].narrativeImpact,
    i,
  );
  assert.equal(repeat.error, undefined);
  assert.equal(repeat.state.narrativeCanon.turns.length, 1);
});
test('legacy positioned state still enforces distance and never becomes a scene encounter', () => {
  const draft = g.createCompleteObservatoryDraft();
  delete draft.supportingNpcPolicy;
  const state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice']);
  Object.assign(state.entities.alice, { x: 20, y: 20 });
  assert.equal(c.hasPosition(state.entities.alice), true);
  assert.equal(g.canNpcHear(state, state.entities.keeper, state.entities.alice, 1), false);
  assert.throws(
    () => g.buildStoryTurnContext(state, 'alice', input('Hello'), randomUUID()),
    /OUT_OF_RANGE/,
  );
});

test('untargeted location-only whisper stays actor-only rather than inventing a radius', () => {
  const state = scene();
  const { result } = apply(state, input('Thinking softly', null, 'whisper'));
  assert.equal(result.error, undefined);
  assert.ok(
    result.state.npcUtterances.every(
      (u) => u.audienceIds.length === 1 && u.audienceIds[0] === 'alice',
    ),
  );
});

test('director admits a new scene and an explicitly encountered NPC without synthetic coordinates', () => {
  const state = scene(),
    id = randomUUID(),
    text = '*I meet a traveler here*';
  const context = g.buildNarrativeContext(state, 'alice', text);
  const result = g.applyNarrativeProposal(
    state,
    'alice',
    {
      turnId: id,
      contextHash: context.contextHash,
      narration: 'A traveler joins the encounter.',
      evidenceIds: [],
      actions: [],
      newScene: null,
      newNpc: {
        name: 'Scene Traveler',
        roleLabel: 'Traveler',
        description: 'A traveler in plain clothes.',
        appearance: 'Plain clothes.',
        personalitySummary: 'Patient.',
        values: ['kindness'],
        publicSpeechStyle: 'warm',
        goal: 'help',
        placement: 'current',
        spatialMode: 'location_only',
        knownEntityIds: ['alice'],
      },
    },
    text,
  );
  assert.equal(result.error, undefined);
  const npc = result.state.entities[`support-${id}`];
  assert.equal(npc.x, undefined);
  assert.equal(npc.y, undefined);
  assert.equal(g.visible(result.state, result.state.entities.alice, npc), true);
  assert.equal(g.visible(result.state, result.state.entities.bob, npc), false);
  const nextId = randomUUID(),
    intent = '*I discover a courtyard*';
  const nextContext = g.buildNarrativeContext(result.state, 'alice', intent);
  const extended = g.applyNarrativeProposal(
    result.state,
    'alice',
    {
      turnId: nextId,
      contextHash: nextContext.contextHash,
      narration: 'A courtyard is discovered.',
      evidenceIds: [],
      actions: [],
      newNpc: null,
      newScene: {
        name: 'Unmapped courtyard',
        description: 'An open courtyard.',
        template: 'room',
        connection: { fromMapId: npc.mapId, spatialMode: 'location_only' },
      },
    },
    intent,
  );
  assert.equal(extended.error, undefined);
  const map = extended.state.maps[`scene-${nextId}`];
  assert.equal(map.spatialMode, 'location_only');
  assert.deepEqual(map.spawns, []);
  assert.deepEqual(map.exits, []);
  assert.deepEqual(map.blocked, []);
});

test('location-only narration, canon, feed and future director context exclude another encounter', () => {
  const state = scene(),
    i = input('*I wave to keeper*', null),
    id = randomUUID();
  const proposal = g.createMockStoryTurnProposal(state, 'alice', i, id);
  proposal.narrative.narration = 'ENCOUNTER_ONLY_EVENT: the keeper sees Alice wave.';
  const result = g.applyStoryTurnProposal(state, 'alice', i, id, proposal);
  assert.equal(result.error, undefined);
  const canon = result.state.narrativeCanon.turns.at(-1);
  assert.equal(canon.channel, 'public');
  assert.ok(canon.audienceIds.includes('alice'));
  assert.ok(!canon.audienceIds.includes('bob'));
  const feed = result.entries.find((entry) => entry.kind === 'narration');
  assert.ok(!feed.audienceIds.includes('*'));
  assert.ok(!feed.audienceIds.includes('bob'));
  assert.ok(
    g
      .projectState(result.state, 'alice')
      .narrative.turns.some((t) => t.narration.includes('ENCOUNTER_ONLY_EVENT')),
  );
  assert.ok(
    !JSON.stringify(g.projectState(result.state, 'bob').narrative).includes('ENCOUNTER_ONLY_EVENT'),
  );
  assert.ok(
    !JSON.stringify(g.buildNarrativeContext(result.state, 'bob', 'What happened?')).includes(
      'ENCOUNTER_ONLY_EVENT',
    ),
  );
  assert.ok(
    JSON.stringify(g.buildNarrativeContext(result.state, 'alice', 'Continue')).includes(
      'ENCOUNTER_ONLY_EVENT',
    ),
  );
  // Earlier private speech remains private even when the same pair is now the full encounter.
  result.state.narrativeCanon.turns.push({
    id: randomUUID(),
    actorId: 'alice',
    requestHash: 'private',
    tick: 0,
    narration: 'PRIVATE_WHISPER_EVENT',
    evidenceIds: [],
    channel: 'whisper',
    audienceIds: ['alice', 'keeper'],
  });
  assert.ok(
    !JSON.stringify(g.buildNarrativeContext(result.state, 'alice', 'Continue')).includes(
      'PRIVATE_WHISPER_EVENT',
    ),
  );
});

test('legacy audience-only private canon cannot become public encounter context', () => {
  const state = scene();
  state.narrativeCanon = {
    revision: 1,
    turns: [
      {
        id: randomUUID(),
        actorId: 'alice',
        requestHash: 'legacy',
        tick: 0,
        narration: 'LEGACY_PRIVATE_EVENT',
        evidenceIds: [],
        audienceIds: ['alice', 'keeper'],
      },
    ],
  };
  assert.ok(
    !JSON.stringify(g.buildNarrativeContext(state, 'alice', 'Continue')).includes(
      'LEGACY_PRIVATE_EVENT',
    ),
  );
});

test('unscoped legacy canon is not evidence or projection in a location-only encounter', () => {
  const state = scene();
  state.narrativeCanon = {
    revision: 1,
    turns: [
      {
        id: randomUUID(),
        actorId: 'bob',
        requestHash: 'old',
        tick: 0,
        narration: 'UNSCOPED_OLD_EVENT',
        evidenceIds: [],
      },
    ],
  };
  assert.ok(
    !JSON.stringify(g.buildNarrativeContext(state, 'alice', 'Continue')).includes(
      'UNSCOPED_OLD_EVENT',
    ),
  );
  assert.ok(
    !JSON.stringify(g.projectState(state, 'alice').narrative).includes('UNSCOPED_OLD_EVENT'),
  );
});

test('location-only cross-location narrator is actor-only, not source or destination bystanders', () => {
  const state = scene(),
    originMap = state.entities.alice.mapId;
  state.maps.destination = {
    id: 'destination',
    label: 'Garden',
    width: 24,
    height: 24,
    revision: 0,
    spatialMode: 'location_only',
    blocked: [],
    spawns: [],
    exits: [],
    scenePresence: {
      version: 1,
      entrySceneId: 'garden',
      scenes: [
        {
          id: 'garden',
          participantIds: ['bob'],
          evidence: { kind: 'authored_scene', reference: 'garden-opening' },
        },
      ],
    },
  };
  state.maps[originMap].scenePresence.scenes[1].participantIds = [];
  Object.assign(state.entities.bob, { mapId: 'destination', sceneId: 'garden' });
  const i = input('*I go to Garden*', null),
    id = randomUUID();
  const proposal = g.createMockStoryTurnProposal(state, 'alice', i, id);
  proposal.narrative.narration = 'COMBINED_SOURCE_DESTINATION_EVENT';
  const result = g.applyStoryTurnProposal(state, 'alice', i, id, proposal);
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.alice.mapId, 'destination');
  assert.deepEqual(result.entries.find((e) => e.kind === 'narration').audienceIds, ['alice']);
  assert.deepEqual(result.state.narrativeCanon.turns.at(-1).audienceIds, ['alice']);
  for (const bystander of ['bob', 'keeper'])
    assert.ok(
      !JSON.stringify(g.projectState(result.state, bystander).narrative).includes(
        'COMBINED_SOURCE_DESTINATION_EVENT',
      ),
    );
});

function unresolvedSceneNpc() {
  const state = scene(),
    npc = state.entities.keeper,
    map = state.maps[npc.mapId];
  state.narrativeSource = { versionId: 'opening-version', checksum: 'a'.repeat(64) };
  map.scenePresence.scenes[0].participantIds = map.scenePresence.scenes[0].participantIds.filter(
    (id) => id !== npc.id,
  );
  npc.sceneId = 'unresolved-keeper';
  npc.unresolvedScenePresence = {
    kind: 'unspecified_opening',
    sourceMapId: npc.mapId,
    sourceSceneId: npc.sceneId,
    sourceChecksum: state.narrativeSource.checksum,
  };
  map.scenePresence.scenes.push({
    id: npc.sceneId,
    participantIds: [npc.id],
    evidence: { kind: 'accepted_story_plan', reference: 'unassigned-source' },
  });
  return state;
}
function encounterProposal(state, text = '*I look for someone to speak with*') {
  const i = input(text, null),
    id = randomUUID();
  const context = g.buildStoryTurnContext(state, 'alice', i, id);
  const proposal = g.createMockStoryTurnProposal(state, 'alice', i, id);
  proposal.steps[0].sceneEncounter = {
    npcId: context.sceneEncounterPolicy?.candidates[0]?.npcId ?? 'not-eligible',
  };
  proposal.narrative.narration =
    'UNADMITTED_INVENTED_QUOTE: Keeper tells you the private password.';
  return { i, id, proposal, context };
}
test('compiler-qualified unresolved original NPC becomes an encounter, then ordinary grounded dialogue', () => {
  const state = unresolvedSceneNpc();
  assert.equal(g.visible(state, state.entities.alice, state.entities.keeper), false);
  const { i, id, proposal, context } = encounterProposal(state);
  assert.match(context.sceneEncounterPolicy.candidates[0].npcId, /^encounter-/);
  assert.ok(!JSON.stringify(context.sceneEncounterPolicy).includes('keeper'));
  assert.ok(!JSON.stringify(g.projectState(state, 'alice')).includes('unresolvedScenePresence'));
  const result = g.applyStoryTurnProposal(state, 'alice', i, id, proposal);
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.keeper.sceneId, result.state.entities.alice.sceneId);
  assert.equal(result.state.entities.keeper.unresolvedScenePresence, undefined);
  assert.ok(
    result.state.npcBrains.keeper.living.observations.some(
      (o) => o.kind === 'actor_seen' && o.actorId === 'alice',
    ),
  );
  assert.equal(result.state.entities.keeper.x, undefined);
  assert.ok(!JSON.stringify(result.entries).includes('UNADMITTED_INVENTED_QUOTE'));
  assert.ok(!result.entries.some((e) => e.kind === 'npc_reply'));
  assert.equal(result.state.narrativeCanon.turns.at(-1).sceneEncounter.npcId, 'keeper');
  const hello = input('Hello', 'keeper');
  hello.expectedCanonRevision = result.state.narrativeCanon.revision;
  const helloId = randomUUID(),
    greeting = g.createMockStoryTurnProposal(result.state, 'alice', hello, helloId);
  const spoken = g.applyStoryTurnProposal(result.state, 'alice', hello, helloId, greeting);
  assert.equal(spoken.error, undefined);
  assert.ok(spoken.entries.some((e) => e.kind === 'npc_reply'));
  assert.equal(spoken.state.entities.keeper.x, undefined);
});
test('unresolved encounter rejects unmarked authored/offstage, changed source, life, scene and map', () => {
  for (const mutate of [
    (s) => delete s.entities.keeper.unresolvedScenePresence,
    (s) => {
      s.entities.keeper.unresolvedScenePresence.sourceChecksum = 'b'.repeat(64);
    },
    (s) => {
      s.entities.keeper.lifeState = 'unconscious';
    },
    (s) => {
      s.entities.keeper.unresolvedScenePresence.sourceSceneId = 'meeting';
    },
    (s) => {
      s.entities.keeper.mapId = 'another-map';
    },
    (s) => {
      s.maps[s.entities.keeper.mapId].scenePresence.scenes
        .find((x) => x.id === 'unresolved-keeper')
        .participantIds.push('bob');
    },
  ]) {
    const state = unresolvedSceneNpc();
    mutate(state);
    const { i, id, proposal, context } = encounterProposal(state);
    assert.equal(context.sceneEncounterPolicy.candidates.length, 0);
    const result = g.applyStoryTurnProposal(state, 'alice', i, id, proposal);
    assert.ok(result.error);
    assert.equal(result.state, state);
  }
  const state = unresolvedSceneNpc(),
    { i, id, proposal } = encounterProposal(state);
  state.entities.keeper.revision++;
  assert.equal(g.applyStoryTurnProposal(state, 'alice', i, id, proposal).error, 'STALE_STATE');
});
test('ordinary quoted speech has no encounter candidates and cannot admit an encounter or same-turn voice', () => {
  const state = unresolvedSceneNpc(),
    i = input('"I meet the keeper"', null),
    id = randomUUID();
  const context = g.buildStoryTurnContext(state, 'alice', i, id);
  assert.equal(context.sceneEncounterPolicy, undefined);
  const proposal = g.createMockStoryTurnProposal(state, 'alice', i, id);
  proposal.steps[0].sceneEncounter = { npcId: 'keeper' };
  assert.ok(g.applyStoryTurnProposal(state, 'alice', i, id, proposal).error);
  const another = encounterProposal(state, '*I seek someone* Hello');
  another.proposal.steps[1].replyNpcId = 'keeper';
  another.proposal.steps[1].reply = { text: 'Fabricated hello' };
  another.proposal.steps[1].replyContextHash = 'unadmitted';
  assert.ok(
    g.applyStoryTurnProposal(state, 'alice', another.i, another.id, another.proposal).error,
  );
});

test('scene encounter admission replays once and candidate prose excludes author-private material', () => {
  const state = unresolvedSceneNpc();
  state.npcBrains.keeper.living.personality.speechStyle = 'PRIVATE_BIO_NEVER_PUBLIC';
  state.entities.keeper.publicProfile = {
    description: 'A traveler whose presence is unspecified.',
    appearance: 'A blue coat.',
  };
  const { i, id, proposal, context } = encounterProposal(state);
  assert.ok(!JSON.stringify(context.sceneEncounterPolicy).includes('PRIVATE_BIO_NEVER_PUBLIC'));
  assert.ok(!JSON.stringify(context.sceneEncounterPolicy).includes('presence is unspecified'));
  const applied = g.applyStoryTurnProposal(state, 'alice', i, id, proposal);
  assert.equal(applied.error, undefined);
  const repeated = g.applySceneEncounter(
    applied.state,
    'alice',
    id,
    0,
    context.sceneEncounterPolicy.candidates[0].npcId,
    context.sceneEncounterPolicy.candidates[0].fingerprint,
    i,
  );
  assert.equal(repeated.error, undefined);
  assert.equal(repeated.state, applied.state);
  assert.deepEqual(repeated.events, []);
  assert.equal(
    g.applySceneEncounter(
      applied.state,
      'alice',
      id,
      0,
      'encounter-changed',
      context.sceneEncounterPolicy.candidates[0].fingerprint,
      i,
    ).error,
    'STALE_STATE',
  );
  assert.ok(
    !JSON.stringify(g.projectState(applied.state, 'alice')).includes(
      context.sceneEncounterPolicy.candidates[0].npcId,
    ),
  );
  assert.equal(
    applied.state.maps[state.entities.alice.mapId].scenePresence.scenes[0].participantIds.filter(
      (id) => id === 'keeper',
    ).length,
    1,
  );
});
