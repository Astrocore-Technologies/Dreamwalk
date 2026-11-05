import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('story cards, public detail and author preview do not advertise a fixed duration', async () => {
  const publicUi =
    (await read('apps/web/components/public.tsx')) +
    (await read('apps/web/components/story/story-detail-page.tsx'));
  const studio = await read('apps/web/components/studio.tsx');
  assert.doesNotMatch(publicUi, /adventure\.duration|a\.duration|Длительность|Clock3/);
  assert.doesNotMatch(studio, /value=\{draft\.duration\}|taxonomy\(draft\.duration\)/);
  // Existing durations remain round-tripped, not silently erased during unrelated edits.
  assert.match(studio, /duration: a\.duration/);
});

test('public story boundaries panel is removed without deleting author warnings or NPC boundaries', async () => {
  const publicUi =
    (await read('apps/web/components/public.tsx')) +
    (await read('apps/web/components/story/story-detail-page.tsx'));
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
  const publicUi =
    (await read('apps/web/components/public.tsx')) +
    (await read('apps/web/components/story/story-detail-page.tsx'));
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

test('story detail keeps its launch controller and authored content in a scoped two-column composition', async () => {
  const detail = await read('apps/web/components/story/story-detail-page.tsx');
  const css = await read('apps/web/components/story/story-detail.css');
  const publicUi = await read('apps/web/components/public.tsx');
  assert.match(publicUi, /export \{ AdventurePage \} from '.\/story\/story-detail-page'/);
  assert.match(
    detail,
    /<AdventureLaunch key=\{`\$\{user\?\.id\}:\$\{a\.id\}`\} adventure=\{a\} \/>/,
  );
  assert.match(detail, /src=\{coverUrl\(a\)\}/);
  assert.match(detail, /src=\{assetUrl\(n.portraitAssetId\)\}/);
  for (const field of ['name', 'role', 'description', 'greeting'])
    assert.ok(detail.includes(`selectNpcText(n, locale).${field}`));
  assert.match(detail, /<details className="sd-story-about">/);
  assert.match(detail, /a.access !== 'invited'/);
  assert.match(detail, /withStoryReturn\('\/my-characters', storyReturnPath\(a.slug\)\)/);
  assert.doesNotMatch(detail, /start-preparations|consent:|\/dispatch|\.secrets/);
  assert.match(css, /grid-row: 2 \/ span 2/);
  assert.match(css, /aspect-ratio: 4.4/);
  assert.match(css, /@media \(max-width: 900px\)/);
});

test('inner Studio selection is presentation-only and retains every mounted draft editor', async () => {
  const collection = await read('apps/web/components/studio/collection-editor.tsx');
  const studio = await read('apps/web/components/studio.tsx');
  const css = await read('apps/web/components/studio/studio.module.css');
  assert.match(collection, /items\.map\(\(item, index\) =>/);
  assert.match(collection, /hidden=\{active !== item\.id\}/);
  assert.match(collection, /disabled=\{active !== item\.id\}/);
  assert.match(collection, /aria-pressed=\{active === item\.id\}/);
  assert.match(collection, /type="button"/);
  assert.match(collection, /document\.activeElement === document\.body/);
  assert.match(collection, /target\?\.focus\(\)/);
  assert.match(collection, /aria-invalid=\{invalidIds\.includes\(item\.id\)/);
  assert.match(studio, /!locationSchema\.safeParse\(item\).success/);
  assert.match(studio, /!sceneSchema\.safeParse\(item\).success/);
  assert.doesNotMatch(collection, /\bapi\(|fetch\(|onChange|localStorage/);
  assert.match(studio, /items=\{draft\.content\.locations\}/);
  assert.match(studio, /items=\{draft\.content\.scenes\}/);
  assert.match(studio, /adventureSchema\.safeParse/);
  assert.match(studio, /expectedEditRevision: revision/);
  assert.match(css, /\.collectionPage\[hidden\]\s*\{\s*display: none/);
  assert.match(css, /\.collectionChoices button:focus-visible/);
  assert.match(studio, /<PrivateRelease/);
  assert.match(studio, /<InvitationManager/);
});
