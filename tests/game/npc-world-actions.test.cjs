process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://fixture:fixture@127.0.0.1:1/fixture';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');
const { GameService } = require('../../apps/api/dist/game/game.service');
const { StoryTurnRuntime } = require('../../apps/api/dist/game/story-turn-runtime');
const { OpenAiNpcProvider, openAiOutputSchema } = require('../../apps/api/dist/ai/openai-provider');
function fixture() {
  const d = g.createCompleteObservatoryDraft();
  d.turnRules = g.turnRulesSchema.parse({ movement: 2 });
  const s = g.createStateFromPlayable(g.compilePlayableDraft(d).playable, ['alice']);
  Object.assign(s.entities.alice, { x: 5, y: 4 });
  return s;
}
function service() {
  const s = Object.create(GameService.prototype);
  s.ai = { contextBudgetBytes: () => 64000 };
  return s;
}

test('erasure cancels an action plan even after its source observation left the hot journal', async () => {
  const { purgeLivingNpcReferences } = await import('../../scripts/game-data-requests.mjs');
  const s = fixture();
  s.npcBrains.keeper.plan = [{ kind: 'move_to', target: { x: 3, y: 6 } }];
  s.npcBrains.keeper.planSource = { actorId: 'alice', sourceObservationId: 'archived-source' };
  const clean = purgeLivingNpcReferences(s, 'alice');
  assert.deepEqual(clean.npcBrains.keeper.plan, []);
  assert.equal(clean.npcBrains.keeper.planSource, undefined);
});

test('emote-only runtime post remains an attempted act, while a confirmed hit creates witnessed consequences', () => {
  const runtime = Object.create(StoryTurnRuntime.prototype),
    game = service();
  runtime.port = { prepareTurnSpeech: game.prepareTurnSpeech.bind(game) };
  const s = fixture(),
    input = (text) => ({
      operationId: randomUUID(),
      text,
      channel: 'say',
      targetNpcId: 'keeper',
      expectedCanonRevision: 0,
      turnFence: g.turnFence(s),
    });
  const emote = runtime.simulateTurnPost(
    s,
    'alice',
    input('*ударил мужчину по лицу*'),
    randomUUID(),
    'fixture-user',
  );
  assert.equal(emote.actions.length, 0);
  assert.equal(emote.requests[0].context.currentUtterance.kind, 'attempted');
  assert.equal(emote.requests[0].context.untrustedRoleplay[0].verified, false);
  assert.equal(emote.state.entities.keeper.vitality, s.entities.keeper.vitality);
  assert.ok(g.parsePlayerTextAction(s, 'alice', 'hit keeper'));
  const hit = runtime.simulateTurnPost(
    s,
    'alice',
    input('*hit keeper* Stop.'),
    randomUUID(),
    'fixture-user',
  );
  const harm = hit.state.npcBrains.keeper.living.observations.find((o) => o.kind === 'harmed');
  assert.ok(harm);
  assert.equal(harm.confidence, 'witnessed');
  assert.ok(
    hit.requests[0].context.claims.some((o) => o.kind === 'harmed' && o.confidence === 'witnessed'),
  );
});

test('world phase gives an unaddressed NPC its existing policy opportunity without generating speech or provider work', async () => {
  const game = service();
  let s = fixture();
  s.entities.guard = { ...s.entities.keeper, id: 'guard', x: 8, y: 4 };
  s.npcBrains.guard = structuredClone(s.npcBrains.keeper);
  s.npcBrains.guard.living.obligations = [
    {
      id: 'existing-promise',
      toActorId: 'alice',
      createdTick: 0,
      dueTick: 200,
      status: 'accepted',
      evidenceIds: [],
      promisedAction: { kind: 'inspect', targetId: 'key' },
      conditions: [],
    },
  ];
  s = g.endPlayerTurn(s, 'alice', g.turnFence(s)).state;
  const live = { state: s, aiPending: false };
  let dispatches = 0;
  game.db = { query: async () => [] };
  game.processDecisionRequests = async () => {};
  game.scheduleAutonomousRequests = async () => {};
  game.dispatchAi = () => {
    dispatches++;
  };
  game.persist = async (_id, entry, state) => {
    entry.state = state;
  };
  await game.advanceTurnWorld('fixture', live);
  assert.notDeepEqual(
    { x: live.state.entities.guard.x, y: live.state.entities.guard.y },
    { x: 8, y: 4 },
  );
  assert.equal(live.state.turnController.phase, 'player');
  assert.equal(live.state.npcUtterances?.length ?? 0, 0);
  assert.equal(dispatches, 0);
});

test('strict fake provider transport normalizes NPC actionIntent in both reply routes without network', async () => {
  const config = {
    enabled: true,
    apiKey: 'fixture-only',
    model: 'fixture',
    version: 'actions-test',
    maxInputBytes: 64000,
    maxOutputTokens: 1000,
    maxResponseBytes: 64000,
    inputMicrosPerMillion: 1,
    outputMicrosPerMillion: 1,
  };
  const speechSchema = openAiOutputSchema('speech').properties.actionIntent;
  assert.deepEqual(
    speechSchema,
    openAiOutputSchema('story_turn').properties.steps.items.properties.reply.anyOf[0].properties
      .actionIntent,
  );
  for (const purpose of ['speech', 'story_turn']) {
    const s = fixture(),
      id = randomUUID(),
      input = {
        operationId: randomUUID(),
        text: 'Please look.',
        channel: 'say',
        targetNpcId: 'keeper',
        expectedCanonRevision: 0,
      };
    const context = g.buildStoryTurnContext(s, 'alice', input, id),
      source = context.dialogues[0].replyToObservationId;
    const actionIntent = {
      sourceObservationId: source,
      actions: [{ kind: 'move_to', targetId: null, target: { x: 3, y: 6 } }],
    };
    const reply = { text: 'I will look.', companionIntent: null, actionIntent };
    const answer =
      purpose === 'speech'
        ? { ...reply, itemIntents: [] }
        : {
            status: 'ready',
            code: null,
            narrative: null,
            steps: [
              {
                segmentIndex: 0,
                action: null,
                reply: { ...reply, code: null },
                replyNpcId: null,
                replyContextHash: null,
              },
            ],
          };
    let calls = 0;
    const provider = new OpenAiNpcProvider(config, async (_url, init) => {
      calls++;
      assert.match(JSON.parse(init.body).instructions, /attempted actions, not spoken quotations/);
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
    });
    const response = await provider.generate({
      jobId: randomUUID(),
      purpose,
      context,
      signal: new AbortController().signal,
      maxCostMicros: 100,
    });
    assert.ok(response.proposal);
    const actual =
      purpose === 'speech'
        ? response.proposal.actionIntent
        : response.proposal.steps[0].reply.actionIntent;
    assert.deepEqual(actual.actions, [{ kind: 'move_to', target: { x: 3, y: 6 } }]);
    assert.equal(calls, 1);
  }
});
