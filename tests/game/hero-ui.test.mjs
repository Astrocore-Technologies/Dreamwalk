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
    if (file === 'home/home-page.tsx') {
      assert.match(text, /storyReturnPath\(active\.slug, heroSelection\.heroId\)/);
      assert.doesNotMatch(text, /api\('\/game\/campaigns'/);
    } else assert.match(text, /heroSelection\.body/);
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

test('hero portrait uses the shared paid-image flow outside the hero form and excludes notes', async () => {
  const personal = await source('personal.tsx');
  const control = await source('hero-portrait-control.tsx');
  assert.match(personal, /<\/form>\s*<HeroPortraitControl/);
  assert.match(personal, /form="hero-editor"/);
  assert.match(control, /<ImageGeneration/);
  assert.match(control, /externalOnly/);
  assert.doesNotMatch(control, /\.notes|notes:/);
  assert.match(control, /active\.current/);
  assert.match(control, /lock\.current/);
  assert.match(control, /!revision\.owned/);
  assert.match(control, /hero-portraits\/\$\{revision\.id\}\/asset/);
  assert.doesNotMatch(control, /api\([^\n]*['"]\/heroes/);
  for (const value of ['Сгенерировать арт героя', 'Generate hero art', 'Згенерувати арт героя'])
    assert.ok(control.includes(value));
});
