import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = (path) =>
  readFile(new URL(`../../apps/web/components/${path}`, import.meta.url), 'utf8');
test('hero choice travels through every campaign launch and membership acceptance', async () => {
  for (const file of [
    'home/home-page.tsx',
    'game/adventure-launch.tsx',
    'game/game-page.tsx',
    'studio/playable-map-editor.tsx',
  ]) {
    const text = await source(file);
    assert.match(text, /HeroSelection/);
    assert.match(text, /heroSelection\.body/);
    assert.match(text, /heroSelection\.ready/);
    assert.match(text, /\.accepts\(lease\)/);
  }
  assert.match(
    await source('game/game-page.tsx'),
    /accept`[\s\S]*JSON\.stringify\(heroSelection\.body\)/,
  );
});
test('hero cards have a gameplay entry and private pinned data is fetched only from own scoped endpoint', async () => {
  assert.match(await source('personal.tsx'), /\/game\?heroId=\$\{encodeURIComponent\(hero\.id\)/);
  const selection = await source('game/hero-selection.tsx');
  assert.match(selection, /\/game\/campaigns\/\$\{campaignId\}\/hero/);
  assert.match(selection, /<details>/);
  assert.doesNotMatch(selection, /localStorage|\/heroes\/\$\{.*campaign/);
  for (const text of [
    'Hero for this campaign',
    'Герой для этого прохождения',
    'Герой для цього проходження',
  ])
    assert.ok(selection.includes(text));
});
