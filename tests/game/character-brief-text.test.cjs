const test = require('node:test');
const assert = require('node:assert/strict');
const { characterBriefSchema } = require('../../packages/contracts/dist');
const {
  characterBriefTexts,
} = require('../../apps/api/dist/visual-authoring/character-brief-text');

const brief = (texts) =>
  characterBriefSchema.safeParse({
    name: 'Аннет',
    description: texts.description,
    outfit: 'Preserve described or referenced clothing.',
    appearance: texts.appearance,
    style: 'drawn2D',
    renderMode: 'static',
    source: 'text',
  });

test('a long Markdown NPC appearance still makes a valid sprite brief', () => {
  const long =
    '## Внешность\n- **Волосы:** длинные рыжие, заплетены в косы.\n' +
    'Красный плащ с капюшоном. '.repeat(160);
  assert.ok(long.length > 3000);
  const texts = characterBriefTexts(long);
  assert.ok(texts.appearance.length <= 500 && texts.description.length <= 2000);
  assert.doesNotMatch(texts.description, /[#*]/);
  assert.match(texts.appearance, /^Внешность Волосы: длинные рыжие/);
  assert.ok(brief(texts).success);
});

test('the untrimmed appearance used to fail the brief schema', () => {
  assert.ok(!brief({ description: 'x'.repeat(600), appearance: 'x'.repeat(600) }).success);
});
