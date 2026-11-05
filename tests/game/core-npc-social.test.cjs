const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../../packages/game-core/dist');
const { applyNpcSocialReactions } = require('../../packages/game-core/dist/npc-social');
function world() {
  const d = g.createAuthoredDraft('courtyard');
  d.npcBehavior = 'reactive-v1';
  d.turnRules = g.turnRulesSchema.parse({});
  const compiled = g.compilePlayableDraft(d);
  assert.deepEqual(compiled.errors, []);
  const s = g.createStateFromPlayable(compiled.playable, ['alice', 'bob']);
  Object.assign(s.entities.alice, { x: 4, y: 5 });
  Object.assign(s.entities.keeper, { x: 4, y: 4 });
  return s;
}
function said(s, text = 'I should have listened to you.', actor = 'alice') {
  const r = g.applyNpcSpeech(
    s,
    actor,
    'keeper',
    { channel: 'whisper', text },
    { suppressReply: true },
  );
  assert.equal(r.error, undefined);
  const source = r.state.npcBrains.keeper.living.observations
    .filter((o) => o.kind === 'said')
    .at(-1);
  assert.ok(source);
  return { state: r.state, source };
}
function reaction(source, deltas = {}) {
  return {
    actorId: source.actorId,
    observationId: source.id,
    affinity: 1,
    respect: 0,
    fear: -1,
    ...deltas,
  };
}
function plan(s, reactions) {
  return {
    ...g.createMockNpcPlan(s, 'keeper'),
    actions: [{ kind: 'wait' }],
    targetRevisions: {},
    knowledgeRevision: s.npcBrains.keeper.living.knowledgeRevision,
    socialReactions: reactions,
  };
}
test('speech changes subjective feelings only after an admitted character decision and survives restart', () => {
  let { state: s, source } = said(world());
  assert.equal(s.npcBrains.keeper.living.relationships.alice, undefined);
  s = g.endPlayerTurn(s, 'alice', g.turnFence(s)).state;
  s = g.endPlayerTurn(s, 'bob', g.turnFence(s)).state;
  const result = g.acceptNpcPlan(s, 'keeper', plan(s, [reaction(source)]));
  assert.equal(result.error, undefined);
  const memory = result.state.npcBrains.keeper.living;
  assert.equal(memory.relationships.alice.character.affinity, 1);
  assert.equal(memory.relationships.alice.trust, 0);
  assert.equal(memory.relationships.alice.debt, 0);
  assert.equal(memory.relationships.alice.alertness, 0);
  assert.equal(memory.relationships.bob, undefined);
  assert.equal(s.npcBrains.keeper.living.relationships.alice, undefined);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.state)).npcBrains.keeper.living.relationships,
    memory.relationships,
  );
  assert.ok(memory.relationships.alice.evidenceIds.includes(source.id));
  assert.equal(
    g.buildNpcDecisionContext(result.state, 'keeper').relationships.alice.character.affinity,
    1,
  );
  assert.doesNotMatch(
    JSON.stringify(g.projectState(result.state, 'bob')),
    /recentTextKeys|socialReactions|lastObservedTick/,
  );
  assert.doesNotMatch(JSON.stringify(result.events), /affinity|socialReactions/);
});
test('replay, another same-round appraisal and repeated flattery cannot farm subjective progression', () => {
  let { state: s, source } = said(world(), 'You are thoughtful!');
  const input = [reaction(source)];
  s = applyNpcSocialReactions(s, 'keeper', input).state;
  const once = structuredClone(s.npcBrains.keeper.living.relationships.alice);
  s.tick += 10;
  assert.deepEqual(
    applyNpcSocialReactions(s, 'keeper', input).state.npcBrains.keeper.living.relationships.alice,
    once,
  );
  ({ state: s, source } = said(s, 'YOU are thoughtful!!!'));
  assert.deepEqual(
    applyNpcSocialReactions(s, 'keeper', [reaction(source)]).state.npcBrains.keeper.living
      .relationships.alice,
    once,
  );
  s.tick += 10;
  ({ state: s, source } = said(s, 'I am listening now.'));
  s.npcBrains.keeper.living.relationships.alice.social.lastRoundId = s.turnController.roundId;
  assert.deepEqual(
    applyNpcSocialReactions(s, 'keeper', [reaction(source)]).state.npcBrains.keeper.living
      .relationships.alice.character,
    once.character,
  );
});
test('forged actor, unheard/reported evidence and mechanical facts cannot become social appraisals', () => {
  const { state: s, source } = said(world());
  for (const change of [
    { actorId: 'bob' },
    { observationId: 'foreign-secret' },
    { actorId: 'keeper' },
  ]) {
    const r = applyNpcSocialReactions(s, 'keeper', [{ ...reaction(source), ...change }]);
    assert.equal(r.error, 'FORBIDDEN');
    assert.strictEqual(r.state, s);
  }
  for (const override of [
    { depth: 1 },
    { sourceNpcId: 'bob' },
    { kind: 'claim' },
    { kind: 'helped' },
  ]) {
    const clone = structuredClone(s);
    Object.assign(
      clone.npcBrains.keeper.living.observations.find((o) => o.id === source.id),
      override,
    );
    assert.equal(applyNpcSocialReactions(clone, 'keeper', [reaction(source)]).error, 'FORBIDDEN');
  }
  assert.equal(
    applyNpcSocialReactions(s, 'keeper', [reaction(source), reaction(source)]).error,
    'FORBIDDEN',
  );
});
test('schema and admission preserve earned distrust, action checks and knowledge fences', () => {
  let { state: s, source } = said(world());
  s.npcBrains.keeper.living.relationships.alice = {
    trust: -4,
    debt: 2,
    alertness: 3,
    evidenceIds: [],
    character: { affinity: -4, respect: 1, fear: 3, lastChangedTick: -1, stage: 'hostile' },
  };
  s = g.endPlayerTurn(s, 'alice', g.turnFence(s)).state;
  s = g.endPlayerTurn(s, 'bob', g.turnFence(s)).state;
  const p = plan(s, [reaction(source)]);
  const r = g.acceptNpcPlan(s, 'keeper', p);
  assert.equal(r.error, undefined);
  assert.equal(r.state.npcBrains.keeper.living.relationships.alice.trust, -4);
  assert.equal(r.state.npcBrains.keeper.living.relationships.alice.character.stage, 'hostile');
  assert.equal(r.state.npcBrains.keeper.living.relationships.alice.character.fear, 2);
  assert.equal(
    g.npcSocialReactionSchema.safeParse({ ...reaction(source), affinity: 2 }).success,
    false,
  );
  assert.equal(
    g.npcSocialReactionSchema.safeParse({ ...reaction(source), trust: 1 }).success,
    false,
  );
  assert.equal(g.acceptNpcPlan(s, 'keeper', { ...p, knowledgeRevision: 999 }).error, 'STALE_STATE');
  assert.ok(
    g.acceptNpcPlan(s, 'keeper', {
      ...p,
      actions: [{ kind: 'give', targetId: 'alice', itemId: 'invented' }],
    }).error,
  );
  assert.equal(s.npcBrains.keeper.living.relationships.alice.character.affinity, -4);
});

test('accumulated relationship memories do not displace the new conversational beat', () => {
  const { state: s, source } = said(world());
  const memory = s.npcBrains.keeper.living;
  for (let i = 0; i < 25; i++)
    memory.observations.unshift({
      ...source,
      id: `important-${i}`,
      rootId: `old-${i}`,
      kind: 'helped',
      tick: -i - 1,
    });
  memory.relationships.alice = {
    trust: 4,
    debt: 3,
    alertness: 0,
    evidenceIds: memory.observations.slice(0, 25).map((o) => o.id),
  };
  const context = g.buildNpcDecisionContext(s, 'keeper');
  assert.equal(context.observations.length, 16);
  assert.ok(context.observations.some((o) => o.id === source.id));
  assert.equal(context.latestInteractionId, source.id);
  assert.equal(context.observations[0].kind, 'helped');
});
test('a later public exchange cannot widen a relationship learned from a private whisper', () => {
  let { state: s, source } = said(world());
  s = applyNpcSocialReactions(s, 'keeper', [reaction(source)]).state;
  assert.deepEqual(s.npcBrains.keeper.living.relationships.alice.social.audienceIds, [
    'alice',
    'keeper',
  ]);
  s.tick += 1;
  s.turnController.roundId = 'next-round';
  ({ state: s, source } = said(s, 'Thank you for hearing me.'));
  const actual = s.npcBrains.keeper.living.observations.find((o) => o.id === source.id);
  actual.disclosure = 'public';
  actual.audienceIds = [];
  s = applyNpcSocialReactions(s, 'keeper', [reaction(source)]).state;
  assert.equal(s.npcBrains.keeper.living.relationships.alice.character.affinity, 2);
  assert.deepEqual(s.npcBrains.keeper.living.relationships.alice.social.audienceIds, [
    'alice',
    'keeper',
  ]);
});

test('a subjective appraisal does not suppress a witnessed physical event in the same tick', () => {
  let { state: s, source } = said(world());
  s.npcBrains.keeper.living.personality.characterization = {
    version: 1,
    motives: [{ kind: 'care', priority: 3 }],
    reactions: [],
    publicVoice: { cadence: 'balanced', register: 'plain', humor: 'none' },
    dialogueExamples: [],
  };
  s = applyNpcSocialReactions(s, 'keeper', [reaction(source)]).state;
  const result = g.recordLivingNpcEvents(
    s,
    s,
    [{ kind: 'action.hit', actorId: 'alice', targetId: 'keeper' }],
    'harm-after-dialogue',
  );
  assert.equal(result.state.npcBrains.keeper.living.relationships.alice.trust, -1);
  assert.equal(result.state.npcBrains.keeper.living.relationships.alice.character.fear, 1);
});

test('same-tick source chronology is recorded before relevance ranking for context packing', () => {
  let { state: s, source: older } = said(world(), 'That was an earlier remark.');
  const { state: latest, source: current } = said(s, 'Here is my actual question.');
  assert.equal(older.tick, current.tick);
  const context = g.buildNpcDecisionContext(latest, 'keeper');
  assert.equal(context.latestInteractionId, current.id);
  assert.ok(context.observations.some((o) => o.id === current.id));
});

test('legacy speech receives only audience-safe categorical social tone and not private mixed axes', () => {
  let { state: s, source } = said(world());
  s = applyNpcSocialReactions(s, 'keeper', [reaction(source, { respect: 1 })]).state;
  const memory = s.npcBrains.keeper.living;
  const privateVoice = g.buildNpcPublicSpeechContext(s, 'keeper', ['alice', 'keeper'], [source.id]);
  assert.deepEqual(privateVoice.socialTone, {
    towardActorId: 'alice',
    warmth: 'warm',
    regard: 'respectful',
    tension: 'settled',
    scope: 'subjective_conversation_only',
  });
  assert.equal(privateVoice.performance, undefined, 'legacy speech style stays unchanged');
  assert.doesNotMatch(
    JSON.stringify(privateVoice),
    /recentTextKeys|lastObservedTick|lastChangedTick/,
  );
  Object.assign(s.entities.bob, { x: 3, y: 4 });
  s.tick++;
  s = g.applyNpcSpeech(
    s,
    'alice',
    'keeper',
    { channel: 'say', text: 'Will you listen?' },
    { suppressReply: true },
  ).state;
  const current = s.npcBrains.keeper.living.observations.filter((o) => o.kind === 'said').at(-1);
  const profile = {
    version: 1,
    motives: [{ kind: 'care', priority: 3 }],
    reactions: [],
    publicVoice: { cadence: 'balanced', register: 'plain', humor: 'none' },
    dialogueExamples: [],
  };
  s.npcBrains.keeper.living.personality.characterization = profile;
  s.npcBrains.keeper.living.relationships.alice.character.affinity = -5;
  s.npcBrains.keeper.living.relationships.alice.character.stage = 'hostile';
  const publicVoice = g.buildNpcPublicSpeechContext(
    s,
    'keeper',
    ['alice', 'bob', 'keeper'],
    [current.id],
  );
  assert.equal(
    publicVoice.socialTone,
    undefined,
    'a private relationship cannot alter the public cue',
  );
  assert.equal(
    publicVoice.performance.stance,
    'friendly',
    'private combined axes cannot leak through hostile stage',
  );
  assert.equal(memory.relationships.alice.social.affinity, 1);
});
test('nonpublic legacy speech without audience provenance cannot become public tone', () => {
  const { state: s, source } = said(world());
  delete s.npcBrains.keeper.living.observations.find((o) => o.id === source.id).audienceIds;
  const r = applyNpcSocialReactions(s, 'keeper', [reaction(source)]);
  assert.deepEqual(r.state.npcBrains.keeper.living.relationships.alice.social.audienceIds, []);
});

test('the first private social appraisal does not change a wider-audience performance baseline', () => {
  let s = world();
  Object.assign(s.entities.bob, { x: 3, y: 4 });
  const m = s.npcBrains.keeper.living;
  m.personality.characterization = {
    version: 1,
    motives: [{ kind: 'care', priority: 3 }],
    reactions: [],
    publicVoice: { cadence: 'balanced', register: 'plain', humor: 'none' },
    dialogueExamples: [],
  };
  m.relationships.alice = {
    trust: 0,
    debt: 0,
    alertness: 0,
    evidenceIds: [],
    character: { affinity: -4, respect: 0, fear: 0, lastChangedTick: -1, stage: 'hostile' },
  };
  s = g.applyNpcSpeech(
    s,
    'alice',
    'keeper',
    { channel: 'say', text: 'Will you listen?' },
    { suppressReply: true },
  ).state;
  const publicSource = s.npcBrains.keeper.living.observations
    .filter((o) => o.kind === 'said')
    .at(-1);
  const audience = ['alice', 'bob', 'keeper'];
  const before = g.buildNpcPublicSpeechContext(s, 'keeper', audience, [publicSource.id]);
  const whispered = said(s, 'I owe you an explanation.');
  const result = applyNpcSocialReactions(whispered.state, 'keeper', [reaction(whispered.source)]);
  assert.equal(result.error, undefined);
  assert.deepEqual(
    g.buildNpcPublicSpeechContext(result.state, 'keeper', audience, [publicSource.id]),
    before,
  );
});
