const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { plainDescription } = require('../../apps/api/dist/image-generation/studio-location');

test('location art prompts carry the author words without Markdown noise', () => {
  const text = plainDescription(
    '## Планировка\n- **Западный сектор:** усадьба и двор.\n1. Колодец с воротом\n> цитата\n`код`',
  );
  assert.equal(text, 'Планировка Западный сектор: усадьба и двор. Колодец с воротом цитата код');
  assert.doesNotMatch(text, /[#*`>]/);
});

test('instructions never carry a concrete example setting the model could copy', () => {
  for (const file of [
    'apps/api/src/image-generation/studio-location.ts',
    'apps/api/src/game/media-preparation.ts',
  ]) {
    const source = readFileSync(file, 'utf8');
    assert.doesNotMatch(source, /lake centered|centered (in|inside) cave/i, file);
    assert.match(source, /Draw exactly the place described below/, file);
  }
});
