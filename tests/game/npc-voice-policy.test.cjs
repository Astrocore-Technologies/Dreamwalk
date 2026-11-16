const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildOpenAiNpcRequestBody,
  openAiOutputSchema,
} = require('../../apps/api/dist/ai/openai-provider');

const config = { model: 'gpt-6-luna', maxOutputTokens: 2048, maxInputBytes: 64000 };
const body = (purpose, context = {}) =>
  JSON.parse(buildOpenAiNpcRequestBody(config, purpose, context));

test('an NPC reply is written before its inner thought', () => {
  const keys = Object.keys(openAiOutputSchema('speech', {}).properties);
  assert.ok(keys.indexOf('silent') < keys.indexOf('text'));
  assert.ok(keys.indexOf('text') < keys.indexOf('cognition'));
});

test('replies are told to keep their own voice, react to violence and not mirror each other', () => {
  const alone = body('speech', {}).instructions;
  assert.match(alone, /own voice, manner and rhythm/);
  assert.match(alone, /Never echo or restate the player's last words/);
  assert.match(alone, /Do not end every reply with a question/);
  assert.match(alone, /wounded, threatened or attacked someone present, react at once/);
  assert.doesNotMatch(alone, /answer the same message/);
  const together = body('speech', { otherResponders: ['Paul', 'Hitogami'] }).instructions;
  assert.match(together, /Paul, Hitogami answer the same message at the same time/);
});

test('the narrator is told not to repeat scenery or close every narration with a question', () => {
  assert.match(
    body('story_turn', { mode: 'director' }).instructions,
    /do not close every narration/,
  );
  assert.doesNotMatch(body('speech', {}).instructions, /do not close every narration/);
});
