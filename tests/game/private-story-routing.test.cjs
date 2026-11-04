process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');
const { StoryTurnRuntime } = require('../../apps/api/dist/game/story-turn-runtime');
const { GameService } = require('../../apps/api/dist/game/game.service');
const { extendContextHistory } = require('../../apps/api/dist/game/context-history');
const { settlePendingStorySpeech } = require('../../apps/api/dist/game/pending-story-speech');
function world(worldPhase = true) {
  const d = g.createCompleteObservatoryDraft();
  d.turnRules = g.turnRulesSchema.parse({});
  let s = g.createStateFromPlayable(g.compilePlayableDraft(d).playable, ['alice', 'bob']);
  Object.assign(s.entities.alice, { x: 5, y: 4 });
  Object.assign(s.entities.bob, { x: 5, y: 3 });
  Object.assign(s.entities.keeper, { label: 'Orin' });
  if (worldPhase) {
    s = g.endPlayerTurn(s, 'alice', g.turnFence(s)).state;
    s = g.endPlayerTurn(s, 'bob', g.turnFence(s)).state;
  }
  return s;
}
function proposal(
  s,
  {
    channel = 'say',
    targetNpcId = 'keeper',
    effect = 'harm',
    text = '*I hit Orin*',
    narration = 'A new physical consequence.',
  } = {},
) {
  const id = randomUUID(),
    input = {
      operationId: randomUUID(),
      text,
      channel,
      ...(targetNpcId ? { targetNpcId } : {}),
      replyLocale: 'en',
      expectedCanonRevision: s.narrativeCanon?.revision ?? 0,
      turnFence: g.turnFence(s),
    };
  const context = g.buildStoryTurnContext(s, 'alice', input, id);
  return {
    id,
    input,
    context,
    raw: {
      turnId: id,
      contextHash: context.contextHash,
      status: 'ready',
      code: null,
      steps: context.segments.map((segment) => ({
        segmentIndex: segment.index,
        action: null,
        reply: null,
        ...(segment.index === 0 ? { narrativeImpact: { targetId: 'keeper', effect } } : {}),
      })),
      narrative: { narration, newScene: null, newNpc: null, evidenceIds: [] },
    },
  };
}
function apply(s, p) {
  return g.applyStoryTurnProposal(s, 'alice', p.input, p.id, p.raw);
}

test('targeted say and whisper attempts go to the director, including help for an inactive target', () => {
  for (const channel of ['say', 'whisper']) {
    const s = world(),
      p = proposal(s, { channel });
    assert.equal(p.context.mode, 'director');
    assert.deepEqual(p.context.actionPreview, []);
    const r = apply(s, p);
    assert.equal(r.error, undefined);
    assert.equal(r.state.entities.keeper.vitality, s.entities.keeper.vitality - 1);
    const unconscious = apply(s, proposal(s, { channel, effect: 'unconscious' })).state;
    const recover = apply(
      unconscious,
      proposal(unconscious, {
        channel,
        effect: 'recover',
        text: '*I help Orin regain consciousness*',
      }),
    );
    assert.equal(recover.error, undefined);
    assert.equal(recover.state.entities.keeper.lifeState, 'conscious');
  }
});

test('private physical state is visible while private words stay out of third-player canon, evidence, and feed fallback', async () => {
  const s = world(),
    p = proposal(s, {
      channel: 'whisper',
      effect: 'death',
      text: '*I act toward Orin with PRIVATE_INTENT*',
      narration: 'PRIVATE_NARRATION',
    });
  const r = apply(s, p);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.state.narrativeCanon.turns.at(-1).audienceIds, ['alice', 'keeper']);
  assert.ok(
    r.entries.every(
      (e) =>
        e.channel === 'whisper' && !e.audienceIds.includes('*') && !e.audienceIds.includes('bob'),
    ),
  );
  assert.equal(
    g.projectState(r.state, 'bob').entities.find((e) => e.id === 'keeper').lifeState,
    'dead',
  );
  assert.equal(JSON.stringify(g.projectState(r.state, 'bob')).includes('PRIVATE_'), false);
  for (const actor of ['alice', 'bob'])
    assert.equal(
      JSON.stringify(g.buildNarrativeContext(r.state, actor, 'Continue')).includes('PRIVATE_'),
      false,
    );
  assert.equal(
    g.buildNarrativeContext(r.state, 'alice', 'Continue').evidenceIds.includes(p.id),
    false,
  );
  assert.equal(
    JSON.stringify(r.state.npcBrains.keeper.living.observations).includes('PRIVATE_INTENT'),
    false,
  );
  for (const actor of ['alice', 'bob']) {
    const runtime = Object.create(StoryTurnRuntime.prototype);
    runtime.db = { query: async () => [] };
    runtime.reconcile = async () => {};
    runtime.port = {
      serial: async (_id, fn) => fn(),
      access: async () => ({ actorId: actor, user: { id: actor } }),
      load: async () => ({ state: r.state }),
    };
    const feed = await runtime.feed({}, 'fixture');
    const text = JSON.stringify(feed);
    assert.equal(text.includes('PRIVATE_NARRATION'), actor === 'alice');
    if (actor === 'alice')
      assert.equal(feed.entries.find((e) => e.text === 'PRIVATE_NARRATION').channel, 'whisper');
  }
});

test('one director owns targeted mixed post without an earlier separate NPC reply', () => {
  for (const channel of ['say', 'whisper']) {
    const s = world(false),
      p = proposal(s, { channel, text: '*I hit Orin* Are you there?' });
    const runtime = Object.create(StoryTurnRuntime.prototype);
    runtime.port = {
      prepareAreaTurnSpeech: () => {
        throw new Error('duplicate area reply');
      },
      prepareTurnSpeech: () => {
        throw new Error('duplicate target reply');
      },
    };
    const post = runtime.simulateTurnPost(s, 'alice', p.input, p.id, 'owner');
    assert.deepEqual(post.requests, []);
    assert.deepEqual(post.committedAttackOutcomes, []);
    assert.match(post.directorText, /I hit Orin/);
    assert.equal(post.state.entities.keeper.vitality, s.entities.keeper.vitality);
    if (channel === 'whisper') assert.ok(post.entries.every((e) => !e.audienceIds.includes('bob')));
  }
});

test('area whisper attempt has actor-only narration and preserves separate audible speech behind director ordering', async () => {
  const s = world(false),
    p = proposal(s, {
      channel: 'whisper',
      targetNpcId: null,
      text: '*I act toward Orin* A whispered question',
    });
  assert.equal(p.context.mode, 'director');
  assert.deepEqual(p.context.outputAudienceIds, ['alice']);
  assert.deepEqual(p.context.sceneSpeakers, []);
  const runtime = Object.create(StoryTurnRuntime.prototype);
  const preparer = Object.create(GameService.prototype);
  runtime.port = { prepareAreaTurnSpeech: preparer.prepareAreaTurnSpeech.bind(preparer) };
  const post = runtime.simulateTurnPost(s, 'alice', p.input, p.id, 'owner');
  assert.equal(post.speechAlreadyRecorded, false);
  assert.equal(post.requests[0].context.awaitStoryDirector, p.id);
  assert.ok(post.requests[0].context.pendingStorySpeech);
  assert.deepEqual(
    post.state.npcBrains.keeper.living.observations,
    s.npcBrains.keeper.living.observations,
  );
  assert.equal(post.state.npcUtterances?.length ?? 0, s.npcUtterances?.length ?? 0);
  assert.equal(post.state.turnController.deferredSpeech[0].pendingStoryTurnId, p.id);
  assert.deepEqual(post.entries.find((e) => e.kind === 'attempt').audienceIds, ['alice']);
  assert.deepEqual(post.entries.find((e) => e.kind === 'speech').audienceIds, ['alice']);
  const service = Object.create(GameService.prototype);
  service.reconcileIntents = async () => {};
  service.story = { reconcileTerminalTravel: async () => {} };
  const requests = [
    { id: 'reply', npc_id: 'keeper', purpose: 'speech', context: { awaitStoryDirector: p.id } },
  ];
  service.db = {
    query: async (sql) => (sql.startsWith('SELECT status') ? [{ status: 'scheduled' }] : requests),
  };
  service.worldGeneration = {
    failUnspent: async () => {
      throw new Error('premature failure');
    },
  };
  await service.processDecisionRequests('fixture', { state: world() });
});

test('private safe voice narrows source and reply audience and old lifecycle voice cannot replay', () => {
  const s = world(),
    p = proposal(s, {
      channel: 'whisper',
      effect: 'blocked',
      text: '*I lower my hand* PRIVATE_SPEECH',
    });
  const voice = p.context.sceneSpeakers.find((v) => v.npcId === 'keeper');
  assert.ok(voice);
  assert.deepEqual(voice.audienceIds, ['alice', 'keeper']);
  p.raw.steps[1] = {
    segmentIndex: 1,
    action: null,
    reply: { text: 'PRIVATE_REPLY' },
    replyNpcId: 'keeper',
    replyContextHash: voice.speechHash,
  };
  const r = apply(s, p);
  assert.equal(r.error, undefined);
  const reply = r.state.npcUtterances.find((u) => u.text === 'PRIVATE_REPLY');
  assert.deepEqual(reply.audienceIds, ['alice', 'keeper']);
  assert.equal(JSON.stringify(g.projectState(r.state, 'bob')).includes('PRIVATE_'), false);
  assert.equal(apply(r.state, p).error, 'STALE_STATE');
  const dead = apply(s, proposal(s, { effect: 'death' })).state;
  const revived = apply(dead, proposal(dead, { effect: 'revive' })).state;
  assert.ok(apply(revived, p).error);
  assert.equal(revived.npcUtterances?.some((u) => u.text === 'PRIVATE_REPLY') ?? false, false);
});

test('director history query binds complete private scope and public history excludes whispers', async () => {
  for (const channel of ['say', 'whisper']) {
    const s = world(),
      p = proposal(s, { channel });
    let historyQuery;
    const db = {
      query: async (sql, args) => {
        if (sql.includes('FROM game_story_feed')) historyQuery = { sql, args };
        return [];
      },
    };
    const ai = {
      contextWindow: () => ({ effectiveContextTokens: 2000 }),
      packContext: (value) => value,
    };
    await extendContextHistory(db, ai, 'fixture', s, 'alice', p.context, 'story_turn', 'keeper');
    assert.ok(historyQuery);
    assert.equal(historyQuery.args[3], channel === 'whisper');
    if (channel === 'whisper') assert.deepEqual(historyQuery.args[1], ['alice', 'keeper']);
    assert.match(historyQuery.sql, /audience_ids @> \$2::text\[\]/);
  }
});

test('audible targeted public RP replies without approaching or changing position', () => {
  const s = world();
  Object.assign(s.entities.keeper, { x: 8, y: 4 });
  const before = structuredClone(s.entities.alice);
  const p = proposal(s, { effect: 'blocked', text: '*I wave toward Orin* Hello' });
  const voice = p.context.sceneSpeakers.find((v) => v.npcId === 'keeper');
  assert.ok(voice);
  p.raw.steps[1] = {
    segmentIndex: 1,
    action: null,
    reply: { text: 'Hello there.' },
    replyNpcId: 'keeper',
    replyContextHash: voice.speechHash,
  };
  const r = apply(s, p);
  assert.equal(r.error, undefined);
  assert.equal(r.state.entities.alice.x, before.x);
  assert.equal(r.state.entities.alice.y, before.y);
  assert.equal(r.state.entities.alice.path, undefined);
  assert.equal(r.state.npcUtterances.filter((u) => u.speakerId === 'keeper').length, 1);
  const whisper = proposal(s, {
    channel: 'whisper',
    effect: 'blocked',
    text: '*I wave toward Orin* Hello',
  });
  assert.equal(whisper.context.sceneSpeakers.length, 0, 'whisper does not widen hearing range');
});

function pendingCase(text, effect, characterized = false) {
  const s = world(false),
    p = proposal(s, { channel: 'whisper', targetNpcId: null, text, effect });
  if (characterized) characterize(s);
  const game = Object.create(GameService.prototype);
  game.ai = { contextBudgetBytes: () => 128000 };
  const runtime = Object.create(StoryTurnRuntime.prototype);
  runtime.port = { prepareAreaTurnSpeech: game.prepareAreaTurnSpeech.bind(game) };
  const posted = runtime.simulateTurnPost(s, 'alice', p.input, p.id, 'owner');
  let ready = g.endPlayerTurn(posted.state, 'alice', g.turnFence(posted.state)).state;
  ready = g.endPlayerTurn(ready, 'bob', g.turnFence(ready)).state;
  const request = posted.requests[0];
  assert.ok(request);
  const frozen = game.deferredSpeechContext(ready, request);
  const input = { ...p.input, text: posted.directorText, turnFence: g.turnFence(ready) };
  const context = g.buildStoryTurnContext(ready, 'alice', input, p.id);
  const raw = {
    turnId: p.id,
    contextHash: context.contextHash,
    status: 'ready',
    code: null,
    steps: context.segments.map((segment) => ({
      segmentIndex: segment.index,
      action:
        context.actionPreview.find((entry) => entry.segmentIndex === segment.index)?.action ?? null,
      reply: null,
      ...(segment.kind === 'attempt' &&
      !context.actionPreview.some((entry) => entry.segmentIndex === segment.index)
        ? { narrativeImpact: { targetId: 'keeper', effect } }
        : {}),
    })),
    narrative: { narration: 'A private outcome.', newScene: null, newNpc: null, evidenceIds: [] },
  };
  const applied = g.applyStoryTurnProposal(ready, 'alice', input, p.id, raw, {
    sourceSpeechSegments: g
      .parseStorySegments(p.input.text)
      .segments.filter((segment) => segment.kind === 'speech'),
  });
  assert.equal(applied.error, undefined);
  return {
    s,
    p,
    game,
    runtime,
    posted,
    ready,
    request,
    frozen,
    after: settlePendingStorySpeech(applied.state, p.id),
  };
}

test('pending area words enter memory only at their ordered committed position', () => {
  const afterDeath = pendingCase('*I act toward Orin* PRIVATE_AFTER_DEATH', 'death');
  assert.equal(
    afterDeath.after.npcBrains.keeper.living.observations.some(
      (o) => o.text === 'PRIVATE_AFTER_DEATH',
    ),
    false,
  );
  assert.equal(
    afterDeath.after.turnController.deferredSpeech.some((ref) => ref.id === afterDeath.request.id),
    false,
  );
  assert.throws(() => afterDeath.game.deferredSpeechContext(afterDeath.after, afterDeath.request));
  const beforeDeath = pendingCase('PRIVATE_BEFORE_DEATH *I act toward Orin*', 'death');
  assert.ok(
    beforeDeath.after.npcBrains.keeper.living.observations.some(
      (o) => o.text === 'PRIVATE_BEFORE_DEATH',
    ),
  );
  assert.equal(
    beforeDeath.after.turnController.deferredSpeech.some(
      (ref) => ref.id === beforeDeath.request.id,
    ),
    false,
  );
  assert.equal(
    beforeDeath.after.npcUtterances.filter((u) => u.text === 'PRIVATE_BEFORE_DEATH').length,
    1,
  );
});

test('unchanged pending area source admits once and preserves a valid frozen reply', () => {
  const x = pendingCase('*I lower my hand* A quiet question', 'blocked');
  const current = x.game.deferredSpeechContext(x.after, x.request);
  assert.equal(current.awaitStoryDirector, x.p.id);
  assert.ok(current.pendingStorySpeech);
  assert.equal(current.lifeRevision, x.request.context.lifeRevision);
  const frozen = {
    ...x.frozen,
    generationPolicy: 'world-batch-v1',
    worldPrepared: true,
    turnFence: g.turnFence(x.after),
  };
  assert.equal(x.game.frozenSpeechContext(x.after, 'keeper', frozen, current), true);
  assert.equal(
    frozen.pendingStorySpeechKnowledgeRevision,
    x.after.npcBrains.keeper.living.knowledgeRevision,
  );
  const reply = g.commitNpcPublicUtterance(x.after, 'keeper', {
    text: 'A quiet answer.',
    channel: 'whisper',
    recipientId: 'alice',
    observationIds: current.observationIds,
    requestedFactIds: current.requestedFactIds,
    replyToObservationId: current.replyToObservationId,
    deferredSpeechId: x.request.id,
    contextHash: current.speechHash,
  });
  assert.equal(reply.error, undefined);
  assert.equal(reply.state.npcUtterances.filter((u) => u.text === 'A quiet question').length, 1);
  assert.equal(reply.state.npcUtterances.filter((u) => u.text === 'A quiet answer.').length, 1);
  const duplicate = g.commitNpcPublicUtterance(reply.state, 'keeper', {
    text: 'A quiet answer.',
    channel: 'whisper',
    recipientId: 'alice',
    observationIds: current.observationIds,
    requestedFactIds: current.requestedFactIds,
    replyToObservationId: current.replyToObservationId,
    deferredSpeechId: x.request.id,
    contextHash: current.speechHash,
  });
  assert.ok(
    duplicate.error ||
      duplicate.state.npcUtterances.filter((u) => u.text === 'A quiet answer.').length === 1,
  );
});

test('world preparation preserves dependency, original life revision and pending-only source without live memory', async () => {
  const x = pendingCase('*I lower my hand* A later question', 'blocked');
  const row = {
    id: x.request.id,
    npc_id: 'keeper',
    purpose: 'speech',
    cause_key: x.request.causeKey,
    requester_user_id: 'owner',
    context: { ...x.request.context, generationPolicy: 'world-batch-v1' },
  };
  let stored;
  x.runtime.db = {
    query: async (sql) => (sql.startsWith('SELECT * FROM game_npc_decision_requests') ? [row] : []),
    tx: async (fn) =>
      fn({
        query: async (sql, args) => {
          if (sql.startsWith('UPDATE game_npc_decision_requests')) stored = JSON.parse(args[1]);
          return { rows: [], rowCount: 1 };
        },
      }),
  };
  x.runtime.ai = { contextWindow: () => null };
  x.runtime.row = async () => ({
    id: x.p.id,
    actor_id: 'alice',
    requester_user_id: 'owner',
    status: 'committed',
    input: x.p.input,
    context: { directorText: x.posted.directorText },
  });
  x.runtime.port.deferredSpeechContext = x.game.deferredSpeechContext.bind(x.game);
  x.runtime.port.failWorldRequest = async () => {
    throw new Error('unexpected failure');
  };
  const before = JSON.stringify(x.ready);
  await x.runtime.prepareWorldRequests('fixture', { state: x.ready });
  assert.equal(JSON.stringify(x.ready), before);
  assert.equal(stored.awaitStoryDirector, x.p.id);
  assert.ok(stored.pendingStorySpeech);
  assert.equal(stored.lifeRevision, x.request.context.lifeRevision);
  assert.equal(typeof stored.pendingStorySpeechKnowledgeRevision, 'number');
  const cancelled = [];
  x.game.reconcileIntents = async () => {};
  x.game.story = { reconcileTerminalTravel: async () => {} };
  x.game.db = {
    query: async (sql) =>
      sql.startsWith('SELECT status') ? [{ status: 'committed' }] : [{ ...row, context: stored }],
  };
  x.game.worldGeneration = { failUnspent: async (...args) => cancelled.push(args) };
  const without = structuredClone(x.after);
  without.turnController.deferredSpeech = [];
  await x.game.processDecisionRequests('fixture', { state: without });
  assert.deepEqual(cancelled, [['fixture', x.request.id, 'STORY_SPEECH_NOT_ADMITTED']]);
  const revived = structuredClone(x.ready);
  revived.entities.keeper.lifeRevision = 2;
  assert.throws(
    () => x.game.deferredSpeechContext(revived, { ...x.request, context: stored }),
    /STALE_STATE/,
  );
});

test('pending source identity survives an earlier ordered mechanical segment', () => {
  const x = pendingCase('*wait* *I lower my hand* A final question', 'blocked');
  const current = x.game.deferredSpeechContext(x.after, x.request);
  assert.equal(current.replyToObservationId, x.request.context.replyToObservationId);
  assert.equal(x.after.npcUtterances.filter((u) => u.text === 'A final question').length, 1);
});

test('private director cannot open a public semantic travel child', () => {
  const s = world(),
    p = proposal(s, {
      channel: 'whisper',
      targetNpcId: null,
      text: '*I go to Private Observatory*',
    });
  delete p.raw.steps[0].narrativeImpact;
  p.raw.travelIntent = {
    segmentIndex: 0,
    destinationName: 'Private Observatory',
    description: 'A secluded room mentioned in the private attempt.',
    template: 'room',
  };
  assert.equal(
    g.storyTurnProposalSchema.safeParse(p.raw).success,
    true,
    'exercise actual combined travel schema',
  );
  const r = apply(s, p);
  assert.equal(r.error, 'FORBIDDEN');
  assert.strictEqual(r.state, s);
  assert.equal(r.state.entities.alice.mapId, s.entities.alice.mapId);
  assert.deepEqual(r.entries, []);
  assert.equal(r.pendingTravel, undefined);
  assert.equal(r.state.narrativeCanon, s.narrativeCanon);
});

test('mixed semantic then pickup stays uncommitted locally and resolves witnesses in order', () => {
  for (const deathFirst of [true, false]) {
    const s = world(false);
    Object.assign(s.entities.key, { x: 5, y: 4, label: 'Key' });
    const text = deathFirst ? '*I end Orin life* *pick up Key*' : '*pick up Key* *I end Orin life*';
    const p = proposal(s, { text, effect: 'death' });
    const runtime = Object.create(StoryTurnRuntime.prototype);
    runtime.port = {};
    const local = runtime.simulateTurnPost(s, 'alice', p.input, p.id, 'owner');
    assert.equal(local.state.entities.key.ownerId, undefined);
    assert.equal(local.actions.length, 0);
    assert.equal(local.directorText.replace(/\s+/g, ' '), text);
    let ready = g.endPlayerTurn(local.state, 'alice', g.turnFence(local.state)).state;
    ready = g.endPlayerTurn(ready, 'bob', g.turnFence(ready)).state;
    const input = { ...p.input, turnFence: g.turnFence(ready) };
    const context = g.buildStoryTurnContext(ready, 'alice', input, p.id);
    const raw = {
      ...p.raw,
      contextHash: context.contextHash,
      steps: context.segments.map((segment) => ({
        segmentIndex: segment.index,
        reply: null,
        action:
          context.actionPreview.find((entry) => entry.segmentIndex === segment.index)?.action ??
          null,
        ...(segment.index === (deathFirst ? 0 : 1)
          ? { narrativeImpact: { targetId: 'keeper', effect: 'death' } }
          : {}),
      })),
    };
    const r = g.applyStoryTurnProposal(ready, 'alice', input, p.id, raw);
    assert.equal(r.error, undefined);
    assert.equal(r.state.entities.key.ownerId, 'alice');
    assert.equal(r.state.entities.keeper.lifeState, 'dead');
    const oldIds = new Set(s.npcBrains.keeper.living.observations.map((o) => o.id));
    const pickup = r.state.npcBrains.keeper.living.observations.filter(
      (o) => !oldIds.has(o.id) && o.kind === 'item_taken' && o.targetId === 'key',
    );
    assert.equal(pickup.length, deathFirst ? 0 : 1);
    assert.equal(
      r.state.turnController.resources.alice.additional,
      ready.turnController.resources.alice.additional - 1,
    );
    assert.equal(r.state.turnController.phase, 'world');
  }
});

function characterize(s) {
  s.npcBrains.keeper.living.personality.characterization = {
    version: 1,
    motives: [{ kind: 'care', priority: 3 }],
    reactions: [],
    publicVoice: { cadence: 'balanced', register: 'plain', humor: 'none' },
    dialogueExamples: [],
  };
}
function variantReply(p) {
  const variant = p.context.sceneSpeakerImpactVariants[0];
  assert.ok(variant, 'bounded conditional safe voice exists');
  const step =
    p.raw.steps.find((entry) => entry.segmentIndex === variant.changes.segmentIndex) ??
    p.raw.steps.at(-1);
  step.reply = { text: 'I can answer the current question.' };
  step.replyNpcId = 'keeper';
  step.replyContextHash = variant.changes.speechHash;
  return variant;
}
test('characterized harm and explicit revival can answer once with exact post-effect safe voice', () => {
  for (const effect of ['harm', 'recover', 'revive']) {
    let s = world();
    characterize(s);
    if (effect !== 'harm')
      s = apply(s, proposal(s, { effect: effect === 'revive' ? 'death' : 'unconscious' })).state;
    const p = proposal(s, {
      effect,
      channel: 'whisper',
      text: '*I act toward Orin* Can you answer?',
    });
    const variant = variantReply(p);
    assert.equal(variant.afterImpact.effect, effect);
    const r = apply(s, p);
    assert.equal(r.error, undefined);
    assert.equal(r.state.entities.keeper.lifeState ?? 'conscious', 'conscious');
    assert.equal(r.entries.filter((e) => e.kind === 'npc_reply').length, 1);
    assert.equal(r.state.npcUtterances.filter((u) => u.speakerId === 'keeper').length, 1);
    assert.equal(JSON.stringify(g.projectState(r.state, 'bob')).includes('I can answer'), false);
  }
});
test('conditional voices never widen pre-effect disclosure and stale advisory reply preserves the effect', () => {
  let s = world();
  characterize(s);
  const memory = s.npcBrains.keeper.living;
  const existing = memory.observations.find((o) => o.kind === 'authored_fact');
  assert.ok(existing);
  existing.disclosure = 'private';
  existing.revealCondition = 'trusted';
  existing.definitionText = 'HYPOTHETICAL_TRUST_SECRET';
  memory.relationships.alice = {
    ...(memory.relationships.alice ?? {}),
    trust: 0,
    alertness: 0,
    evidenceIds: [],
  };
  s = apply(s, proposal(s, { effect: 'death' })).state;
  const p = proposal(s, {
    effect: 'revive',
    channel: 'whisper',
    text: '*I restore Orin life* Can you answer?',
  });
  assert.ok(p.context.sceneSpeakerImpactVariants.length);
  assert.equal(
    JSON.stringify(p.context.sceneSpeakerImpactBases).includes('HYPOTHETICAL_TRUST_SECRET'),
    false,
  );
  assert.equal(
    JSON.stringify(p.context.sceneSpeakerImpactVariants).includes('HYPOTHETICAL_TRUST_SECRET'),
    false,
  );
  variantReply(p);
  p.raw.steps.at(-1).replyContextHash = 'stale-voice';
  p.raw.narrative.narration = 'Orin answered FAKE_UNCOMMITTED_SECRET.';
  const r = apply(s, p);
  assert.equal(r.error, undefined);
  assert.equal(r.state.entities.keeper.lifeState, 'conscious');
  assert.equal(r.entries.filter((e) => e.kind === 'npc_reply').length, 0);
  assert.equal(JSON.stringify(r.state.narrativeCanon).includes('FAKE_UNCOMMITTED_SECRET'), false);
  assert.equal(JSON.stringify(r.entries).includes('FAKE_UNCOMMITTED_SECRET'), false);
  assert.equal(r.state.npcUtterances.filter((u) => u.speakerId === 'alice').length, 1);
  assert.equal(
    r.state.turnController.deferredSpeech.length,
    0,
    'omitted reply is not an invented queued continuation',
  );
});
test('conditional voice additions fit a normal configured provider context budget', () => {
  const { OpenAiNpcProvider } = require('../../apps/api/dist/ai/openai-provider');
  const s = world();
  characterize(s);
  const p = proposal(s, {
    text: '*I act toward Orin* Please answer. *I raise my hand* Are you there?',
  });
  const extra = {
    bases: p.context.sceneSpeakerImpactBases,
    variants: p.context.sceneSpeakerImpactVariants,
  };
  assert.ok(extra.variants.length > 0 && extra.variants.length <= 2);
  assert.ok(Buffer.byteLength(JSON.stringify(extra)) <= 8192);
  const provider = new OpenAiNpcProvider(
    {
      enabled: true,
      apiKey: 'synthetic-only',
      model: 'synthetic',
      version: 'fixture',
      maxInputBytes: 64000,
      maxOutputTokens: 2048,
      maxResponseBytes: 128000,
      inputMicrosPerMillion: 250000,
      outputMicrosPerMillion: 750000,
      estimation: {
        kind: 'operator_heuristic',
        textTokensPerKiBUtf8: 1024,
        textProtocolTokens: 4096,
        marginBps: 2500,
        fixedMarginMicros: 17,
      },
      pricing: {
        source: 'https://example.test/pricing',
        reviewedAt: '2026-01-01T00:00:00.000Z',
        validUntil: '2099-01-01T00:00:00.000Z',
      },
    },
    async () => {
      throw Error('no network');
    },
  );
  assert.ok(Buffer.byteLength(JSON.stringify(p.context)) < provider.contextBudgetBytes(264036));
  assert.ok(provider.prepareTextRequest('story_turn', p.context).snapshot.serializedBytes < 64000);
});

test('inactive conditional branches cannot disclose a newly asked private fact even when blocked is chosen', () => {
  for (const life of ['dead', 'unconscious']) {
    let s = world();
    const fact = s.npcBrains.keeper.living.observations.find((o) => o.kind === 'authored_fact');
    fact.disclosure = 'private';
    fact.revealCondition = 'asked';
    fact.publicQuestion = 'What is your secret?';
    fact.definitionText = 'INACTIVE_ASKED_SECRET_CANARY';
    s = apply(s, proposal(s, { effect: life === 'dead' ? 'death' : 'unconscious' })).state;
    const p = proposal(s, {
      effect: 'blocked',
      channel: 'whisper',
      text: '*I try to help Orin* What is your secret?',
    });
    assert.ok(p.context.sceneSpeakerImpactVariants.length);
    assert.equal(JSON.stringify(p.context).includes('INACTIVE_ASKED_SECRET_CANARY'), false);
    assert.equal(JSON.stringify(p.context).includes(fact.id), false);
    const r = apply(s, p);
    assert.equal(r.error, undefined);
    assert.equal(r.state.entities.keeper.lifeState, life);
  }
});

test('conditional voices cannot unlock trusted facts through a hypothetical earlier gift', () => {
  const s = world();
  const memory = s.npcBrains.keeper.living;
  const fact = memory.observations.find((o) => o.kind === 'authored_fact');
  fact.disclosure = 'private';
  fact.revealCondition = 'trusted';
  fact.definitionText = 'FUTURE_GIFT_SECRET';
  memory.relationships.alice = { trust: 0, alertness: 0, evidenceIds: [] };
  s.entities.key.ownerId = 'alice';
  s.entities.alice.inventory = ['key'];
  const p = proposal(s, {
    channel: 'whisper',
    text: '*give key to keeper* *I reach toward Orin* What do you know?',
  });
  assert.ok(p.context.sceneSpeakerImpactVariants.length);
  assert.equal(JSON.stringify(p.context.sceneSpeakers).includes('FUTURE_GIFT_SECRET'), false);
  assert.equal(
    JSON.stringify(p.context.sceneSpeakerImpactBases).includes('FUTURE_GIFT_SECRET'),
    false,
  );
  assert.equal(
    JSON.stringify(p.context.sceneSpeakerImpactVariants).includes('FUTURE_GIFT_SECRET'),
    false,
  );
});
test('deferred player contact pays the player budget after reaction and resumes world', () => {
  const s = world();
  Object.assign(s.entities.bob, { x: 4, y: 4 });
  const p = proposal(s, { text: '*I lower my hand toward Orin* *hit bob*', effect: 'blocked' });
  p.raw.steps[1].action = p.context.actionPreview.find((entry) => entry.segmentIndex === 1).action;
  const r = apply(s, p);
  assert.equal(r.error, undefined);
  assert.equal(r.state.turnController.phase, 'reaction');
  assert.equal(r.state.entities.bob.vitality, s.entities.bob.vitality);
  const done = g.resolveTurnReaction(r.state, 'bob', 'decline', g.turnFence(r.state));
  assert.equal(done.error, undefined);
  assert.equal(done.state.turnController.phase, 'world');
  assert.equal(
    done.state.turnController.resources.alice.main,
    s.turnController.resources.alice.main - 1,
  );
  assert.equal(done.state.turnController.worldActions, s.turnController.worldActions);
  assert.deepEqual(done.state.turnController.worldNpcActions, s.turnController.worldNpcActions);
  assert.ok(g.resolveTurnReaction(done.state, 'bob', 'decline', g.turnFence(done.state)).error);
});
test('changed post-impact area voice cancels its unpaid frozen body without a new quote or dispatch', async () => {
  const x = pendingCase('*I strike toward Orin* Can you answer?', 'harm', true);
  const current = x.game.deferredSpeechContext(x.after, x.request);
  const frozen = {
    ...x.frozen,
    generationPolicy: 'world-batch-v1',
    worldPrepared: true,
    turnFence: g.turnFence(x.after),
  };
  assert.equal(x.game.frozenSpeechContext(x.after, 'keeper', frozen, current), false);
  const row = {
    id: x.request.id,
    npc_id: 'keeper',
    purpose: 'speech',
    cause_key: x.request.causeKey,
    context: frozen,
  };
  const cancelled = [];
  x.game.reconcileIntents = async () => {};
  x.game.story = { reconcileTerminalTravel: async () => {} };
  x.game.db = {
    query: async (sql) => (sql.startsWith('SELECT status') ? [{ status: 'committed' }] : [row]),
  };
  x.game.story = {
    reconcileTerminalTravel: async () => {},
    requireLegacyReplyConsent: async () => false,
    quotedReply: async () => null,
  };
  x.game.ai = { releaseGeneration: () => true, contextBudgetBytes: () => 128000 };
  x.game.worldGeneration = {
    quotedWorldRequest: async () => ({ quote: { id: 'frozen' } }),
    failUnspent: async (...args) => cancelled.push(args),
    invalidate: async () => {
      throw Error('no requote');
    },
  };
  await x.game.processDecisionRequests('fixture', { state: x.after });
  assert.deepEqual(cancelled, [['fixture', x.request.id, 'ROUND_CONTEXT_STALE']]);
  assert.equal(x.after.npcUtterances.filter((u) => u.speakerId === 'keeper').length, 0);
});

test('typed attempt plus speech keeps its director route through world reconstruction', () => {
  for (const channel of ['say', 'whisper'])
    for (const targetNpcId of ['keeper', null]) {
      const s = world(false),
        p = proposal(s, { channel, targetNpcId, text: '*wait* Hello' });
      const game = Object.create(GameService.prototype);
      const runtime = Object.create(StoryTurnRuntime.prototype);
      runtime.port = { prepareAreaTurnSpeech: game.prepareAreaTurnSpeech.bind(game) };
      const posted = runtime.simulateTurnPost(s, 'alice', p.input, p.id, 'owner');
      assert.equal(
        posted.state.turnController.resources.alice.main,
        s.turnController.resources.alice.main,
      );
      assert.match(posted.directorText, /\*wait\*/);
      let ready = g.endPlayerTurn(posted.state, 'alice', g.turnFence(posted.state)).state;
      ready = g.endPlayerTurn(ready, 'bob', g.turnFence(ready)).state;
      const input = { ...p.input, text: posted.directorText, turnFence: g.turnFence(ready) };
      const context = g.buildStoryTurnContext(ready, 'alice', input, p.id);
      assert.equal(context.mode, 'director');
      assert.equal(context.actionPreview[0].action.kind, 'wait');
      const raw = {
        ...p.raw,
        contextHash: context.contextHash,
        steps: context.segments.map((segment) => ({
          segmentIndex: segment.index,
          action:
            context.actionPreview.find((entry) => entry.segmentIndex === segment.index)?.action ??
            null,
          reply: null,
        })),
      };
      const r = g.applyStoryTurnProposal(ready, 'alice', input, p.id, raw);
      assert.equal(r.error, undefined);
      assert.equal(
        r.state.turnController.resources.alice.main,
        ready.turnController.resources.alice.main - 1,
      );
      assert.equal(r.state.npcUtterances.filter((u) => u.text === 'Hello').length, 1);
    }
});

test('mixed existing travel remains pending locally until the ordered director resolves it', () => {
  const s = world(false);
  s.maps.roof.blocked = [];
  Object.assign(s.entities.journal, { x: 3, y: 3 });
  const input = {
    operationId: randomUUID(),
    text: '*go to Rooftop* *pick up journal* Hello from the roof.',
    channel: 'say',
    replyLocale: 'en',
    expectedCanonRevision: 0,
    turnFence: g.turnFence(s),
  };
  const id = randomUUID();
  const game = Object.create(GameService.prototype);
  const runtime = Object.create(StoryTurnRuntime.prototype);
  runtime.port = { prepareAreaTurnSpeech: game.prepareAreaTurnSpeech.bind(game) };
  const posted = runtime.simulateTurnPost(s, 'alice', input, id, 'owner');
  assert.equal(posted.state.entities.alice.mapId, s.entities.alice.mapId);
  assert.equal(posted.state.entities.journal.ownerId, undefined);
  assert.deepEqual(posted.state.turnController.resources.alice, s.turnController.resources.alice);
  assert.match(posted.directorText, /go to Rooftop/);
  assert.match(posted.directorText, /pick up journal/);
  let ready = g.endPlayerTurn(posted.state, 'alice', g.turnFence(posted.state)).state;
  ready = g.endPlayerTurn(ready, 'bob', g.turnFence(ready)).state;
  const worldInput = { ...input, text: posted.directorText, turnFence: g.turnFence(ready) };
  const context = g.buildStoryTurnContext(ready, 'alice', worldInput, id);
  assert.deepEqual(
    context.actionPreview.map((entry) => entry.action.kind),
    ['travel', 'pick_up'],
  );
});
