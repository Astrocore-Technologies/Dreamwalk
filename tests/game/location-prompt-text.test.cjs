const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { randomUUID } = require('node:crypto');
const { generationRequestSchema } = require('../../apps/api/dist/image-generation/contracts');
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

const base = () => ({
  adventureId: randomUUID(),
  title: 'Fixture',
  kind: 'background',
  camera: 'top-down',
  tags: [],
  background: 'opaque',
  mode: 'external',
  rights: {
    basis: 'generated',
    licenseLabel: 'Synthetic',
    attribution: '',
    allowAuthorReuse: false,
    attested: true,
  },
});
test('the image prompt allows 3500 characters, the author is told where the cut is', () => {
  assert.ok(generationRequestSchema.safeParse({ ...base(), prompt: 'x'.repeat(3500) }).success);
  assert.ok(!generationRequestSchema.safeParse({ ...base(), prompt: 'x'.repeat(3501) }).success);
  const studio = readFileSync('apps/web/components/studio.tsx', 'utf8');
  assert.match(studio, /первые ~2400 символов/);
  const prompt = readFileSync('apps/api/src/image-generation/studio-location.ts', 'utf8');
  assert.match(prompt, /let limit = 2400/);
  assert.match(prompt, /Buffer\.byteLength\(text, 'utf8'\) > 7500/);
});
