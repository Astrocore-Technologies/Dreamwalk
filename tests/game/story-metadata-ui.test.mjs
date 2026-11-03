import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('story cards, public detail and author preview do not advertise a fixed duration', async () => {
  const publicUi = await read('apps/web/components/public.tsx');
  const studio = await read('apps/web/components/studio.tsx');
  assert.doesNotMatch(publicUi, /adventure\.duration|a\.duration|Длительность|Clock3/);
  assert.doesNotMatch(studio, /value=\{draft\.duration\}|taxonomy\(draft\.duration\)/);
  // Existing durations remain round-tripped, not silently erased during unrelated edits.
  assert.match(studio, /duration: a\.duration/);
});

test('public story boundaries panel is removed without deleting author warnings or NPC boundaries', async () => {
  const publicUi = await read('apps/web/components/public.tsx');
  const studio = await read('apps/web/components/studio.tsx');
  const contracts = await read('packages/contracts/src/index.ts');
  assert.doesNotMatch(publicUi, /Границы истории|content\.boundaries|content\?\.boundaries/);
  assert.match(studio, /draft\.content\.boundaries\.includes/);
  assert.match(studio, /Все границы и предупреждения/);
  assert.match(contracts, /boundaries: z\.array/);
  assert.match(contracts, /duration: text\(80\)/);
  assert.match(await read('apps/web/components/studio/npc-character-copy.ts'), /Границы поведения/);
});

test('public detail never renders the private author world even in the owner preview', async () => {
  const publicUi = await read('apps/web/components/public.tsx');
  assert.doesNotMatch(publicUi, /a\.content(?:\?|)\.world/);
  assert.match(publicUi, /className="prose">\{text\.synopsis\}/);
});

test('Studio composition uses only owned story data and preserves all authoring steps', async () => {
  const studio = await read('apps/web/components/studio.tsx');
  assert.match(studio, /useResource<Adventure\[\]>\('\/studio\/adventures'\)/);
  assert.match(studio, /Date\.parse\(right\.updatedAt\) - Date\.parse\(left\.updatedAt\)/);
  assert.match(studio, /src=\{coverUrl\(recent\)\}/);
  assert.match(studio, /src=\{coverUrl\(story\)\}/);
  assert.match(studio, /src=\{coverUrl\(draft\)\}/);
  for (const step of [
    'Основное',
    'Мир и правила',
    'Локации',
    'NPC',
    'Стартовая сцена',
    'Ограничения',
    'Просмотр',
    'Публикация',
  ])
    assert.ok(
      studio
        .slice(studio.indexOf('const steps ='), studio.indexOf('const newContent'))
        .includes(step),
    );
  assert.match(studio, /onClick=\{\(\) => setStep\(6\)\}/);
  assert.match(studio, /onClick=\{\(\) => setStep\(7\)\}/);
  assert.match(studio, /reload=\{reloadDraft\}/);
  assert.match(studio, /<StoryLorebookEditor/);
  assert.match(studio, /<LocationMapIntent/);
  assert.match(studio, /<StoryNpcEditor/);
});
