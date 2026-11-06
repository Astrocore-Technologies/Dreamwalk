process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');
const { StoryTurnRuntime } = require('../../apps/api/dist/game/story-turn-runtime');
const { forecastWorldRound } = require('../../apps/api/dist/game/round-cost-forecast');
const {
  buildOpenAiNpcRequestBody,
  OpenAiNpcProvider,
} = require('../../apps/api/dist/ai/openai-provider');

function world() {
  const draft = g.createCompleteObservatoryDraft();
  draft.turnRules = g.turnRulesSchema.parse({});
  const state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice', 'bob']);
  Object.assign(state.entities.alice, { x: 5, y: 4, label: 'Aster' });
  Object.assign(state.entities.keeper, {
    label: 'Orin',
    labelTranslations: { ru: 'Орин', uk: 'Орін' },
  });
  return state;
}
function input(state, text, extra = {}) {
  return {
    operationId: randomUUID(),
    text,
    channel: 'say',
    replyLocale: 'en',
    expectedCanonRevision: 0,
    turnFence: g.turnFence(state),
    ...extra,
  };
}
function post(state, text, extra = {}) {
  const runtime = Object.create(StoryTurnRuntime.prototype);
  runtime.port = {};
  return runtime.simulateTurnPost(
    state,
    'alice',
    input(state, text, extra),
    randomUUID(),
    'fixture-owner',
  );
}
test('explicit multilingual self attempts bind only one currently visible target', () => {
  const state = world();
  for (const text of [
    'I hit Orin in the face',
    'Aster punches Orin',
    'я ударяю Орин по плечу',
    'вдаряю Орін',
  ])
    assert.deepEqual(
      g.parseStoryAttackAttempt(state, 'alice', text),
      { kind: 'hit', targetId: 'keeper' },
      text,
    );
  assert.deepEqual(g.parseStoryAttackAttempt(state, 'alice', 'я штовхаю Орін'), {
    kind: 'push',
    targetId: 'keeper',
  });
  for (const text of [
    'I do not hit Orin',
    'не ударяю Орин',
    'if I hit Orin',
    'хочу ударить Орин',
    'Orin hit bob',
    'tell Orin to hit bob',
    'I say "hit Orin"',
    'hit Orin or bob',
    'hit the man',
    'shoot him',
    'shoot the wall near Orin',
    'ударяю статую и Орин',
    'hit Orinov',
  ])
    assert.equal(g.parseStoryAttackAttempt(state, 'alice', text), null, text);
  state.entities.keeper.mapId = 'elsewhere';
  assert.equal(g.parsePlayerTextAction(state, 'alice', 'hit Orin'), null);
});

test('typed contact preserves free player resources while NPC prose remains semantic', () => {
  const state = world(),
    result = g.applyTurnAction(
      state,
      'alice',
      { kind: 'hit', targetId: 'keeper' },
      g.turnFence(state),
    );
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.keeper.vitality, state.entities.keeper.vitality - 1);
  assert.deepEqual(
    result.state.turnController.resources.alice,
    state.turnController.resources.alice,
  );
  const prose = post(state, '*I hit Orin in the face* *look around*');
  assert.equal(prose.state.entities.keeper.vitality, state.entities.keeper.vitality);
  assert.deepEqual(prose.committedAttackOutcomes, []);
  assert.equal(prose.directorText, '*I hit Orin in the face*\n*look around*');
});

test('failed contact and pending player reaction do not claim completed injury', () => {
  const state = world();
  Object.assign(state.entities.keeper, { x: 7, y: 4 });
  const distant = g.applyTurnAction(
    state,
    'alice',
    { kind: 'hit', targetId: 'keeper' },
    g.turnFence(state),
  );
  assert.equal(distant.error, 'OUT_OF_RANGE');
  assert.deepEqual(distant.state.entities.keeper, state.entities.keeper);
  Object.assign(state.entities.bob, { x: 5, y: 3 });
  const deferred = post(state, '*hit bob*');
  assert.deepEqual(deferred.committedAttackOutcomes, []);
  assert.equal(
    deferred.entries.some((entry) => entry.kind === 'outcome'),
    false,
  );
  assert.equal(deferred.state.entities.bob.vitality, state.entities.bob.vitality);
  const ready = worldPhase(deferred.state),
    request = input(ready, '*hit bob*'),
    turnId = randomUUID();
  const proposal = g.createMockStoryTurnProposal(ready, 'alice', request, turnId);
  const pending = g.applyStoryTurnProposal(ready, 'alice', request, turnId, proposal);
  assert.equal(pending.error, undefined);
  assert.equal(pending.entries.find((entry) => entry.kind === 'outcome').code, 'ACTION_PENDING');
  assert.equal(pending.state.turnController.phase, 'reaction');
  assert.equal(pending.state.entities.bob.vitality, state.entities.bob.vitality);
});

function semanticProposal(state, text, effect = 'harm', targetId = 'keeper') {
  const turnId = randomUUID(),
    request = input(state, text);
  const context = g.buildStoryTurnContext(state, 'alice', request, turnId);
  return {
    turnId,
    request,
    context,
    proposal: {
      turnId,
      contextHash: context.contextHash,
      status: 'ready',
      code: null,
      steps: context.segments.map((segment) => ({
        segmentIndex: segment.index,
        action: null,
        reply: null,
        ...(segment.kind === 'attempt' ? { narrativeImpact: { targetId, effect } } : {}),
      })),
      narrative: {
        narration:
          effect === 'harm'
            ? 'Orin recoils, injured but still conscious.'
            : 'The attempt misses Orin.',
        newScene: null,
        newNpc: null,
        evidenceIds: [],
      },
    },
  };
}
function worldPhase(state) {
  state = g.endPlayerTurn(state, 'alice', g.turnFence(state)).state;
  return g.endPlayerTurn(state, 'bob', g.turnFence(state)).state;
}
function applySemantic(state, sample) {
  return g.applyStoryTurnProposal(state, 'alice', sample.request, sample.turnId, sample.proposal);
}

test('semantic director admits a fictional shot without command keywords or tracked inventory', () => {
  const state = worldPhase(world());
  state.turnController.resources.alice.main = 0;
  const before = structuredClone(state),
    sample = semanticProposal(state, '*The muzzle flashes toward Orin*');
  assert.equal(sample.context.actionPreview.length, 0);
  assert.equal(sample.context.narrativeImpactPolicy.explicitLifecycle, true);
  const result = applySemantic(state, sample);
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.keeper.vitality, before.entities.keeper.vitality - 1);
  assert.deepEqual(result.state.entities.alice.inventory, before.entities.alice.inventory);
  assert.deepEqual(Object.keys(result.state.entities), Object.keys(before.entities));
  assert.deepEqual(
    result.state.turnController.resources.alice,
    state.turnController.resources.alice,
  );
  assert.ok(
    result.state.npcBrains.keeper.living.observations.some((entry) => entry.kind === 'harmed'),
  );
  assert.deepEqual(
    result.state.narrativeCanon.turns.find((entry) => entry.id === sample.turnId).impact,
    {
      segmentIndex: 0,
      targetId: 'keeper',
      effect: 'harm',
      damage: 1,
      lifeStateBefore: 'conscious',
      lifeStateAfter: 'conscious',
      vitalityBefore: before.entities.keeper.vitality,
      vitalityAfter: before.entities.keeper.vitality - 1,
    },
  );
  assert.match(result.entries.find((entry) => entry.code === 'NARRATIVE_HARM').text, /injury/);
  const duplicate = g.applyStoryImpact(
    result.state,
    'alice',
    sample.turnId,
    0,
    { targetId: 'keeper', effect: 'harm' },
    sample.request,
  );
  assert.strictEqual(duplicate.state, result.state);
  assert.deepEqual(duplicate.events, []);
  const replay = applySemantic(result.state, sample);
  assert.ok(replay.error);
  assert.equal(replay.state.entities.keeper.vitality, result.state.entities.keeper.vitality);
  const next = g.buildNarrativeContext(result.state, 'alice', 'What happens next?');
  assert.deepEqual(next.confirmedTurns.at(-1).impact, {
    segmentIndex: 0,
    targetId: 'keeper',
    effect: 'harm',
    damage: 1,
    lifeStateBefore: 'conscious',
    lifeStateAfter: 'conscious',
    vitalityBefore: before.entities.keeper.vitality,
    vitalityAfter: before.entities.keeper.vitality - 1,
  });
});

test('semantic injury can cause unconsciousness; blocked persists without invented damage', () => {
  const state = worldPhase(world());
  state.entities.keeper.vitality = 2;
  state.turnController.ruleset.hitDamage = 20;
  const sample = semanticProposal(state, '*I loose the shot toward Orin*');
  assert.equal(
    sample.context.narrativeImpactPolicy.targets.find((entry) => entry.targetId === 'keeper')
      .maxDamage,
    2,
  );
  const result = applySemantic(state, sample);
  assert.equal(result.error, undefined);
  assert.equal(result.state.entities.keeper.vitality, 0);
  assert.equal(result.state.entities.keeper.lifeState, 'unconscious');
  const low = worldPhase(world());
  low.entities.keeper.vitality = 1;
  assert.equal(
    applySemantic(low, semanticProposal(low, '*I loose another shot toward Orin*')).error,
    undefined,
  );
  const blocked = applySemantic(
    low,
    semanticProposal(low, '*I loose another shot toward Orin*', 'blocked'),
  );
  assert.equal(blocked.error, undefined);
  assert.equal(blocked.state.entities.keeper.vitality, 1);
  assert.equal(blocked.state.narrativeCanon.turns.at(-1).impact.damage, 0);
  assert.ok(blocked.events.some((entry) => entry.kind === 'narrative.impact_blocked'));
  assert.ok(!blocked.events.some((entry) => entry.kind === 'action.hit'));
});

test('semantic impacts reject players, self, hidden/missing targets, speech and duplicate effects atomically', () => {
  const state = worldPhase(world());
  for (const target of ['alice', 'bob', 'new_npc', 'missing']) {
    const result = applySemantic(
      state,
      semanticProposal(state, '*A shot rings out toward someone*', 'harm', target),
    );
    assert.equal(result.error, 'FORBIDDEN', target);
    assert.strictEqual(result.state, state);
  }
  const hidden = structuredClone(state);
  hidden.entities.keeper.mapId = 'elsewhere';
  assert.equal(
    applySemantic(hidden, semanticProposal(hidden, '*A shot rings out toward Orin*')).error,
    'FORBIDDEN',
  );
  const speech = semanticProposal(state, 'I tell Orin about an earlier fight');
  speech.proposal.steps[0].narrativeImpact = { targetId: 'keeper', effect: 'harm' };
  assert.equal(applySemantic(state, speech).error, 'FORBIDDEN');
  const double = semanticProposal(state, '*A shot rings out toward Orin* *Another shot follows*');
  const twice = applySemantic(state, double);
  assert.equal(twice.error, undefined);
  assert.equal(twice.state.entities.keeper.vitality, state.entities.keeper.vitality - 2);
  assert.equal(twice.events.filter((event) => event.kind === 'action.hit').length, 2);
  const duplicateSegment = structuredClone(double);
  duplicateSegment.proposal.steps[1].segmentIndex = 0;
  const rejectedDuplicate = applySemantic(state, duplicateSegment);
  assert.ok(rejectedDuplicate.error);
  assert.strictEqual(rejectedDuplicate.state, state);
  assert.deepEqual(rejectedDuplicate.events, []);
  const matched = semanticProposal(state, '*hit bob*');
  assert.equal(
    applySemantic(state, matched).error,
    'FORBIDDEN',
    'already interpreted action cannot get a second consequence',
  );
  const mixed = semanticProposal(state, '*A shot rings out toward Orin*');
  mixed.proposal.steps[0].action = { kind: 'hit', targetId: 'keeper' };
  assert.equal(applySemantic(state, mixed).error, 'FORBIDDEN');
  const stale = semanticProposal(state, '*A shot rings out toward Orin*');
  state.entities.keeper.vitality--;
  assert.ok(applySemantic(state, stale).error);
});

test('deferred forecast keeps ordered mechanical attempts uncommitted until director admission', async () => {
  const state = world();
  Object.assign(state.entities.bob, { x: 5, y: 3 });
  const result = post(state, '*hit bob* *look around*'),
    turnId = randomUUID();
  const captures = [];
  await forecastWorldRound(
    {
      query: async () => [
        {
          npc_id: 'alice',
          purpose: 'story_turn',
          status: 'queued',
          context: { turnBasedDeferredDirector: true },
          id: turnId,
          turn_id: turnId,
          turn_actor_id: 'alice',
          turn_input: input(state, '*hit Orin* *look around*'),
          turn_context: {
            directorText: result.directorText,
            committedAttackOutcomes: result.committedAttackOutcomes,
          },
        },
      ],
    },
    {
      localRequestForecast: (purpose, context) => {
        captures.push({ purpose, context });
        return 0;
      },
    },
    'fixture',
    result.state,
  );
  const request = captures.find((entry) => entry.purpose === 'story_turn');
  assert.deepEqual(request.context.committedAttackOutcomes, result.committedAttackOutcomes);
  assert.equal(result.committedAttackOutcomes.length, 0);
  assert.equal(request.context.actionPreview.length, 1);
  assert.equal(request.context.actionPreview[0].action.kind, 'hit');
  const body = buildOpenAiNpcRequestBody(
    { model: 'fixture', maxOutputTokens: 1000 },
    'story_turn',
    request.context,
  );
  assert.match(
    body,
    /Already persisted effects and pending other-player reactions must not be repeated or overridden/,
  );
  assert.match(body, /narrativeImpactPolicy/);
  assert.match(body, /death is explicit/);
  assert.match(
    body,
    /Compatibility impact uses the listed target and allowedEffects for this segment/,
  );
  assert.match(body, /ACTION_PENDING/);
});

test('semantic impact survives the strict provider schema and normalization without a real API call', async () => {
  const state = worldPhase(world()),
    sample = semanticProposal(state, '*I send a shot toward Orin*');
  const answer = structuredClone(sample.proposal);
  delete answer.turnId;
  delete answer.contextHash;
  answer.steps[0].replyNpcId = null;
  answer.steps[0].replyContextHash = null;
  let calls = 0,
    sentBody;
  const provider = new OpenAiNpcProvider(
    {
      enabled: true,
      apiKey: 'fixture-only',
      model: 'fixture',
      version: 'impact-test',
      maxInputBytes: 64000,
      maxOutputTokens: 1000,
      maxResponseBytes: 64000,
      inputMicrosPerMillion: 1,
      outputMicrosPerMillion: 1,
    },
    async (_url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      sentBody = body;
      return new Response(
        JSON.stringify({
          id: 'fixture',
          status: 'completed',
          service_tier: 'default',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] },
          ],
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  );
  const result = await provider.generate({
    jobId: randomUUID(),
    purpose: 'story_turn',
    context: { ...sample.context, turnBasedDeferredDirector: true },
    signal: new AbortController().signal,
    maxCostMicros: 100,
  });
  assert.ok(sentBody);
  const objectStep = sentBody.text.format.schema.properties.steps.items.anyOf.find(
    (entry) => entry.type === 'object',
  );
  assert.ok(objectStep.properties.narrativeImpact);
  assert.ok(objectStep.properties.establishedEvents);
  assert.match(
    sentBody.instructions,
    /Questions, negation, hypotheses, quoted dialogue, historical reports and instructions to another player do not establish a current outcome/,
  );
  assert.match(
    JSON.parse(sentBody.input).context.narrativeImpactPolicy.instructions,
    /Harm at zero vitality causes unconsciousness/,
  );
  assert.equal(result.failureCode, undefined);
  assert.equal(calls, 1);
  assert.deepEqual(result.proposal.steps[0].narrativeImpact, {
    targetId: 'keeper',
    effect: 'harm',
  });
  const applied = g.applyStoryTurnProposal(
    state,
    'alice',
    sample.request,
    sample.turnId,
    result.proposal,
  );
  assert.equal(applied.error, undefined);
  assert.equal(applied.state.entities.keeper.vitality, state.entities.keeper.vitality - 1);
});
