const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const g = require('../../packages/game-core/dist');
const { buildOpenAiNpcRequestBody } = require('../../apps/api/dist/ai/openai-provider');

function contextFor(text) {
  const draft = g.createCompleteObservatoryDraft();
  let state = g.createStateFromPlayable(g.compilePlayableDraft(draft).playable, ['alice']);
  Object.assign(state.entities.alice, {
    x: state.entities.keeper.x - 1,
    y: state.entities.keeper.y,
  });
  state = g.endPlayerTurn(g.initializeTurnController(state, ['alice']).state, 'alice', 0).state;
  const input = {
    operationId: randomUUID(),
    text,
    channel: 'say',
    replyLocale: 'ru',
    expectedCanonRevision: 0,
    turnFence: g.turnFence(state),
  };
  return {
    state,
    context: g.buildStoryTurnContext(state, 'alice', input, randomUUID()),
  };
}
const config = { model: 'gpt-6-luna', maxOutputTokens: 2048, maxInputBytes: 64000 };
const instructions = (context) =>
  JSON.parse(buildOpenAiNpcRequestBody(config, 'story_turn', context)).instructions;

test('naming a present character, even in a declined form, marks them as addressed', () => {
  const { state, context } = contextFor('*подхожу* Смотрителю — что вы тут чините?');
  const keeper = state.entities.keeper;
  assert.ok(keeper, 'fixture has a keeper');
  const label = keeper.label;
  const named = contextFor(`*подхожу* ${label}, что вы тут чините?`).context;
  assert.ok(named.sceneSpeakers.length > 0);
  assert.deepEqual(
    named.addressedSpeakers?.map((a) => a.npcId),
    ['keeper'],
  );
  assert.equal(context.addressedSpeakers, undefined);
});

test('requests without a named addressee keep their previous shape', () => {
  const { context } = contextFor('*осматриваюсь* Здравствуйте всем.');
  assert.equal('addressedSpeakers' in context, false);
  assert.doesNotMatch(instructions(context), /addressedSpeakers lists/);
});

test('with an addressee the narrator is told who answers and not to deflect', () => {
  const { state } = contextFor('*осматриваюсь* Привет.');
  const label = state.entities.keeper.label;
  const { context } = contextFor(`*подхожу* ${label}, что вы тут чините?`);
  assert.match(instructions(context), /must never answer on behalf of, deflect to or announce/);
});

test('narration is told to add something rather than restate the action', () => {
  const { context } = contextFor('*осматриваюсь*');
  assert.match(instructions(context), /never merely restate what the player already wrote/);
});
