const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');
const character = require('../../packages/game-core/dist/character');

const profile = (motive = 'care') => ({
  version: 1,
  motives: [{ kind: motive, priority: 3 }],
  reactions: [],
  publicVoice: { cadence: 'balanced', register: 'plain', humor: 'none' },
  dialogueExamples: [{ situation: 'refusal', text: 'PRIVATE_EXAMPLE_47' }],
});
function world(motive = 'care') {
  const d = g.createAuthoredDraft('courtyard');
  d.npcBehavior = 'reactive-v1';
  d.npcs[0] = {
    ...d.npcs[0],
    x: 4,
    y: 4,
    goal: 'help',
    patrolTarget: { x: 4, y: 4 },
    personality: {
      role: 'helper',
      values: ['kindness'],
      taboos: ['disclose_private'],
      speechStyle: 'PRIVATE_STYLE_47',
      biography: 'PRIVATE_BIOGRAPHY_47',
      characterization: profile(motive),
    },
  };
  d.objects.find((o) => o.id === 'token').ownerNpcId = 'keeper';
  const compiled = g.compilePlayableDraft(d);
  assert.deepEqual(compiled.errors, []);
  const s = g.createStateFromPlayable(compiled.playable, ['alice', 'bob']);
  Object.assign(s.entities.alice, { x: 4, y: 5 });
  Object.assign(s.entities.bob, { x: 3, y: 5 });
  return s;
}
function address(s, operation = 'address') {
  const r = g.applyAction(s, 'alice', { kind: 'talk', targetId: 'keeper' });
  assert.equal(r.error, undefined);
  return g.recordNpcEvents(s, r.state, r.events, operation).state;
}
function witnessed(s, kind, operation, actor = 'alice') {
  return g.recordLivingNpcEvents(s, s, [{ kind, actorId: actor, targetId: 'keeper' }], operation)
    .state;
}

test('characterization is bounded, versioned and rejects ambiguous duplicate reactions/motives', () => {
  assert.equal(g.npcCharacterizationSchema.safeParse(profile()).success, true);
  assert.equal(g.npcCharacterizationSchema.safeParse({ ...profile(), version: 2 }).success, false);
  assert.equal(
    g.npcCharacterizationSchema.safeParse({
      ...profile(),
      motives: [...profile().motives, ...profile().motives],
    }).success,
    false,
  );
  assert.equal(
    g.npcCharacterizationSchema.safeParse({
      ...profile(),
      reactions: Array(2).fill({
        trigger: 'request',
        response: 'assist',
        publicStance: 'friendly',
      }),
    }).success,
    false,
  );
  assert.equal(
    g.npcCharacterizationSchema.safeParse({
      ...profile(),
      publicVoice: { ...profile().publicVoice, secret: 'x' },
    }).success,
    false,
  );
});

test('same request creates different actual plans/obligations from authored motives, not just descriptions', () => {
  const care = address(world('care'));
  const prosper = address(world('prosper'));
  const curious = address(world('discover'));
  assert.equal(g.buildNpcDecisionContext(care, 'keeper').privateAppraisal.response, 'assist');
  assert.equal(g.buildNpcDecisionContext(prosper, 'keeper').privateAppraisal.response, 'refuse');
  assert.equal(g.buildNpcDecisionContext(curious, 'keeper').privateAppraisal.response, 'observe');
  assert.ok(g.createMockNpcPlan(care, 'keeper').actions.some((a) => a.kind === 'give'));
  assert.equal(
    g.createMockNpcPlan(prosper, 'keeper').actions.some((a) => a.kind === 'give'),
    false,
  );
  assert.equal(g.stepLivingNpcs(care).state.npcBrains.keeper.living.obligations.length, 1);
  const refused = g.stepLivingNpcs(prosper).state;
  assert.equal(refused.npcBrains.keeper.living.obligations.length, 0);
  assert.equal(refused.npcBrains.keeper.plan[0].kind, 'wait');
  assert.equal(refused.entities.token.ownerId, 'keeper');
});

test('private examples/motives/appraisal never enter safe speech or player projection; admitted stance shapes fixture reply', () => {
  const a = address(world('care')),
    b = address(world('prosper'));
  const id = a.npcBrains.keeper.living.observations.find((o) => o.kind === 'addressed').id;
  const safeA = g.buildNpcPublicSpeechContext(a, 'keeper', ['alice', 'keeper'], [id]);
  const safeB = g.buildNpcPublicSpeechContext(b, 'keeper', ['alice', 'keeper'], [id]);
  assert.equal(safeA.performance.stance, 'friendly');
  assert.equal(safeB.performance.stance, 'firm');
  assert.notEqual(
    g.createMockNpcPublicResponse(safeA).text,
    g.createMockNpcPublicResponse(safeB).text,
  );
  assert.match(JSON.stringify(g.buildNpcDecisionContext(a, 'keeper')), /PRIVATE_EXAMPLE_47/);
  for (const visible of [safeA, g.projectState(a, 'alice')]) {
    assert.doesNotMatch(
      JSON.stringify(visible),
      /PRIVATE_|privateAppraisal|motives|dialogueExamples/,
    );
  }
  const before = g.buildNpcPublicSpeechContext(a, 'keeper', ['bob', 'keeper'], []);
  a.npcBrains.keeper.living.observations.push({
    id: 'private-threat',
    eventId: 'secret-event',
    rootId: 'secret-event',
    kind: 'harmed',
    tick: 100,
    mapId: 'courtyard',
    channel: 'direct',
    confidence: 'witnessed',
    actorId: 'alice',
    depth: 0,
    disclosure: 'private',
    audienceIds: [],
  });
  assert.deepEqual(g.buildNpcPublicSpeechContext(a, 'keeper', ['bob', 'keeper'], []), before);
});

test('relationship axes are causal, bounded, personal, gradual and stable through replay and restart', () => {
  let s = world();
  s = witnessed(s, 'action.give', 'gift');
  let r = s.npcBrains.keeper.living.relationships.alice;
  assert.equal(r.trust, 1);
  assert.deepEqual(r.character, {
    affinity: 1,
    respect: 1,
    fear: 0,
    lastChangedTick: 0,
    stage: 'cooperative',
  });
  const once = structuredClone(r);
  s = witnessed(s, 'action.give', 'gift');
  assert.deepEqual(s.npcBrains.keeper.living.relationships.alice, once);
  s = witnessed(s, 'action.give', 'another-gift-same-tick');
  assert.equal(s.npcBrains.keeper.living.relationships.alice.trust, 1);
  assert.equal(s.npcBrains.keeper.living.relationships.alice.character.affinity, 1);
  assert.equal(s.npcBrains.keeper.living.relationships.bob, undefined);
  for (let i = 1; i < 12; i++) {
    s.tick = i;
    s = witnessed(s, 'action.hit', `harm-${i}`);
  }
  r = s.npcBrains.keeper.living.relationships.alice;
  assert.equal(r.trust, -5);
  assert.equal(r.character.affinity, -5);
  assert.equal(r.character.fear, 5);
  assert.equal(r.character.respect, 1, 'respect is distinct from liking/fear');
  assert.equal(r.character.stage, 'hostile');
  s.tick++;
  s = witnessed(s, 'action.give', 'late-gift');
  assert.equal(s.npcBrains.keeper.living.relationships.alice.character.stage, 'hostile');
  assert.deepEqual(
    JSON.parse(JSON.stringify(s)).npcBrains.keeper.living.relationships,
    s.npcBrains.keeper.living.relationships,
  );
});

test('reported claims and flattering dialogue cannot manufacture affection, respect or trust', () => {
  let s = world();
  s = g.applyNpcSpeech(s, 'alice', 'keeper', {
    channel: 'whisper',
    text: 'You are wonderful',
    claim: { kind: 'item_taken', actorId: 'bob', targetId: 'key' },
  }).state;
  assert.equal(s.npcBrains.keeper.living.relationships.alice, undefined);
  assert.equal(s.npcBrains.keeper.living.relationships.bob, undefined);
});

test('public-facing disposition honors accumulated conflict instead of instant friendliness', () => {
  let s = world();
  for (let i = 0; i < 4; i++) {
    s.tick = i;
    s = witnessed(s, 'action.hit', `harm-${i}`);
  }
  s.tick++;
  s = address(s);
  const m = s.npcBrains.keeper.living;
  assert.equal(character.characterAppraisal(m).publicStance, 'guarded');
  assert.equal(character.characterAppraisal(m).response, 'observe');
  assert.equal(character.characterAppraisal(m).certainty, 'witnessed');
});

test('public performance follows the newest admitted interaction instead of an old trigger', () => {
  let s = address(world('prosper'));
  const old = s.npcBrains.keeper.living.observations.find((o) => o.kind === 'addressed');
  assert.ok(old);
  s.tick++;
  s = g.applyNpcSpeech(
    s,
    'alice',
    undefined,
    { channel: 'say', text: 'I am sorry. Is that cloth yours?' },
    { suppressReply: true },
  ).state;
  const m = s.npcBrains.keeper.living;
  const current = m.observations.find((o) => o.kind === 'said');
  const selected = [old.id, current.id];
  for (const ids of [selected, [...selected].reverse()]) {
    const context = g.buildNpcPublicSpeechContext(s, 'keeper', ['alice', 'keeper'], ids);
    assert.equal(context.performance.stance, 'reserved', 'an old refusal is not the current beat');
  }
  assert.equal(m.relationships.alice, undefined, 'apology does not mechanically manufacture trust');
});

test('new emote resets an old delivery stance without leaking private changes or erasing character', () => {
  let s = address(world('prosper'));
  const old = s.npcBrains.keeper.living.observations.find((o) => o.kind === 'addressed');
  // Same simulation tick, but this gesture was admitted later.
  s = g.applyNpcSpeech(
    s,
    'alice',
    undefined,
    { channel: 'say', text: 'looks at the cloth on the floor' },
    { suppressReply: true, presentationKind: 'attempt' },
  ).state;
  const m = s.npcBrains.keeper.living;
  const current = m.observations.find((o) => o.kind === 'attempted');
  const context = g.buildNpcPublicSpeechContext(
    s,
    'keeper',
    ['alice', 'keeper'],
    [old.id, current.id],
  );
  assert.equal(context.performance.stance, 'reserved');
  assert.deepEqual(m.personality.characterization.motives, [{ kind: 'prosper', priority: 3 }]);
  m.observations.push({
    ...old,
    id: 'private-newest',
    tick: 100,
    disclosure: 'private',
    audienceIds: [],
  });
  assert.deepEqual(
    g.buildNpcPublicSpeechContext(
      s,
      'keeper',
      ['alice', 'keeper'],
      [old.id, current.id, 'private-newest'],
    ),
    context,
  );
});

test('a fresh admitted ownership-unknown pickup does not replay an older guarded stance', () => {
  const s = address(world('prosper'));
  const memory = s.npcBrains.keeper.living;
  const old = memory.observations.find((o) => o.kind === 'addressed');
  const pickup = {
    ...old,
    id: 'neutral-pickup',
    eventId: 'neutral-pickup',
    rootId: 'neutral-pickup',
    kind: 'item_taken',
    channel: 'direct',
    confidence: 'witnessed',
    itemOwnershipContext: 'unestablished',
    targetId: 'ordinary-prop',
  };
  memory.observations.push(pickup);
  assert.equal(character.characterTrigger(pickup, 'keeper'), undefined);
  for (const ids of [
    [old.id, pickup.id],
    [pickup.id, old.id],
  ]) {
    const context = g.buildNpcPublicSpeechContext(s, 'keeper', ['alice', 'keeper'], ids);
    assert.equal(context.performance.stance, 'reserved');
    assert.equal(
      context.claims.find((claim) => claim.observationId === pickup.id).itemOwnershipContext,
      'unestablished',
    );
  }
});

test('opt-in mood holds game time; old character state remains unchanged', () => {
  let s = witnessed(world(), 'action.give', 'help');
  const { updateNpcAffect } = require('../../packages/game-core/dist/living-policy');
  s.tick = 20;
  updateNpcAffect(s, 'keeper');
  assert.equal(s.npcBrains.keeper.living.affect.mood, 'grateful');
  s.tick = 60;
  updateNpcAffect(s, 'keeper');
  assert.equal(s.npcBrains.keeper.living.affect.mood, 'calm');
  const legacy = world();
  delete legacy.npcBrains.keeper.living.personality.characterization;
  const old = witnessed(legacy, 'action.give', 'legacy-help');
  assert.equal(old.npcBrains.keeper.living.relationships.alice.character, undefined);
  assert.equal(g.buildNpcDecisionContext(old, 'keeper').privateAppraisal, undefined);
  assert.equal(
    g.buildNpcPublicSpeechContext(old, 'keeper', ['alice', 'keeper'], []).performance,
    undefined,
  );
});

test('long history preserves early unfinished promise and invalidates an old summary after new evidence', () => {
  let s = address(world());
  const evidence = s.npcBrains.keeper.living.observations.find((o) => o.kind === 'addressed').id;
  const accepted = g.acceptNpcObligation(s, 'keeper', 'alice', 'token', [evidence], 1000);
  assert.equal(accepted.error, undefined);
  s = accepted.state;
  const summary = g.createNpcMemorySummary(s, 'keeper', [evidence]);
  assert.equal(g.validateNpcSummary(s, 'keeper', summary), true);
  for (let i = 0; i < 180; i++) {
    s.tick = i + 1;
    s = address(s, `history-${i}`);
  }
  s = JSON.parse(JSON.stringify(s));
  assert.equal(s.npcBrains.keeper.living.obligations[0].status, 'accepted');
  assert.ok(s.npcBrains.keeper.living.observations.some((o) => o.id === evidence));
  assert.equal(g.validateNpcSummary(s, 'keeper', summary), false);
  assert.ok(g.buildNpcDecisionContext(s, 'keeper').observations.some((o) => o.id === evidence));
  assert.equal(s.entities.token.ownerId, 'keeper');
});

test('ordinary typed speech selects only its addressed character, not an overhearing NPC', () => {
  for (const [motive, expected] of [
    ['care', 'assist'],
    ['prosper', 'refuse'],
  ]) {
    let s = world(motive);
    s = g.applyNpcSpeech(
      s,
      'alice',
      'keeper',
      { channel: 'say', text: 'Can you help me?' },
      { suppressReply: true },
    ).state;
    const observation = s.npcBrains.keeper.living.observations.find((o) => o.kind === 'said');
    assert.equal(g.buildNpcDecisionContext(s, 'keeper').privateAppraisal.response, expected);
    const safe = g.buildNpcPublicSpeechContext(s, 'keeper', ['alice', 'keeper'], [observation.id]);
    assert.equal(safe.performance.stance, expected === 'assist' ? 'friendly' : 'firm');
    assert.equal(
      g.createMockNpcPlan(s, 'keeper').actions.some((a) => a.kind === 'give'),
      expected === 'assist',
    );
    assert.equal(
      character.characterAppraisal(s.npcBrains.keeper.living, observation, 'different-npc').trigger,
      'routine',
    );
  }
});

test('conflicting declared motives are weighted by the actual observed situation', () => {
  const s = world('care'),
    memory = s.npcBrains.keeper.living;
  memory.personality.characterization.motives.push({ kind: 'protect', priority: 2 });
  const threat = {
    id: 'threat',
    eventId: 'threat',
    rootId: 'threat',
    kind: 'harmed',
    tick: 1,
    mapId: 'courtyard',
    channel: 'direct',
    confidence: 'witnessed',
    actorId: 'alice',
    depth: 0,
    disclosure: 'public',
    audienceIds: [],
  };
  assert.equal(character.characterAppraisal(memory, threat, 'keeper').motive, 'protect');
  assert.equal(character.characterAppraisal(memory, threat, 'keeper').response, 'warn');
  assert.equal(
    character.characterAppraisal(memory, { ...threat, kind: 'addressed' }, 'keeper').motive,
    'care',
  );
});

test('private appraisal evidence is selected, and typed requests retrieve only authorized relevant lore', () => {
  let s = world('discover');
  s = g.applyNpcSpeech(
    s,
    'alice',
    'keeper',
    { channel: 'say', text: 'Where is the lighthouse?' },
    { suppressReply: true },
  ).state;
  const memory = s.npcBrains.keeper.living;
  const template = memory.observations.find((o) => o.kind === 'said');
  for (const [id, text, map] of [
    ['light', 'lighthouse beacon', s.entities.keeper.mapId],
    ['garden', 'garden flowers', s.entities.keeper.mapId],
    ['away', 'lighthouse secret', 'different-map'],
  ]) {
    memory.observations.push({
      ...template,
      id,
      eventId: id,
      rootId: id,
      kind: 'authored_fact',
      factId: `story-lore-${id}`,
      title: text,
      text: undefined,
      definitionText: text,
      relevanceTopics: [text],
      relevanceMapId: map,
    });
  }
  let context = g.buildNpcDecisionContext(s, 'keeper');
  assert.ok(context.observations.some((o) => o.id === 'light'));
  assert.equal(
    context.observations.some((o) => ['garden', 'away'].includes(o.id)),
    false,
  );
  assert.ok(
    context.privateAppraisal.evidenceIds.every((id) =>
      context.observations.some((o) => o.id === id),
    ),
  );
  // Saturation cannot leave the fictional appraisal citing an omitted source.
  for (let i = 0; i < 30; i++)
    memory.observations.push({
      ...template,
      id: `crowd-${i}`,
      eventId: `crowd-${i}`,
      rootId: `crowd-${i}`,
      kind: 'harmed',
      tick: i + 1,
    });
  context = g.buildNpcDecisionContext(s, 'keeper');
  assert.ok(context.observations.length <= 16);
  assert.ok(
    context.privateAppraisal.evidenceIds.every((id) =>
      context.observations.some((o) => o.id === id),
    ),
  );
});

test('an authored help reaction enters the existing causal scheduler only for opted-in characters', () => {
  let s = world();
  s.npcBrains.keeper.living.personality.characterization.reactions.push({
    trigger: 'help',
    response: 'refuse',
    publicStance: 'firm',
  });
  s = witnessed(s, 'action.give', 'help-reaction');
  const m = s.npcBrains.keeper.living;
  const helped = m.observations.find((o) => o.kind === 'helped');
  assert.ok(m.causes.some((c) => c.observationId === helped.id));
  assert.equal(character.characterAppraisal(m, helped, 'keeper').response, 'refuse');
  const legacy = world();
  delete legacy.npcBrains.keeper.living.personality.characterization;
  const old = witnessed(legacy, 'action.give', 'old-help');
  assert.equal(
    old.npcBrains.keeper.living.causes.some(
      (c) =>
        old.npcBrains.keeper.living.observations.find((o) => o.id === c.observationId)?.kind ===
        'helped',
    ),
    false,
  );
});
