import test from 'node:test';
import assert from 'node:assert/strict';
import {
  insertNpcTemplate,
  npcAuthoringTemplates,
  authoringText,
  templateCopy,
} from '../../apps/web/components/studio/npc-authoring-templates.ts';

test('insertion preserves the beginning, selection and end at a bounded cursor', () => {
  assert.deepEqual(insertNpcTemplate('abcdef', 'example', 3, 100), {
    value: 'abc\nexample\ndef',
    cursor: 12,
  });
  assert.deepEqual(insertNpcTemplate('', 'example', 0, 7), { value: 'example', cursor: 7 });
  assert.equal(insertNpcTemplate('author text', 'example', 999, 100).value, 'author text\nexample');
  assert.equal(insertNpcTemplate('author text', 'example', -1, 100).value, 'example\nauthor text');
});
test('full fields reject the whole insertion without truncating author text', () => {
  assert.equal(insertNpcTemplate('author text', 'example', 3, 12), null);
  assert.equal(insertNpcTemplate('😀'.repeat(2000), 'example', 4000, 4000), null);
});
test('repeated insertion retains each example and uses the returned cursor', () => {
  const first = insertNpcTemplate('before after', 'one', 7, 100);
  const second = insertNpcTemplate(first.value, 'two', first.cursor, 100);
  assert.equal(second.value, 'before one\ntwo\nafter');
});
test('all visible labels and examples cover three languages and fit the shortest fields', () => {
  for (const locale of ['ru', 'en', 'uk']) {
    for (const template of Object.values(npcAuthoringTemplates)) {
      assert.ok(authoringText(locale, template.label).length > 0);
      assert.ok(authoringText(locale, template.text).length < 200);
    }
    for (const copy of Object.values(templateCopy)) assert.ok(authoringText(locale, copy));
  }
});

// The dedicated NPC view remains part of the existing NPC-authoring CI gate.
test('NPC design copy is complete in RU, EN and UK', async () => {
  const { npcDesignCopy, npcDesignText } =
    await import('../../apps/web/components/studio/npc-design-copy.ts');
  for (const [key, values] of Object.entries(npcDesignCopy)) {
    assert.equal(values.length, 3, key);
    for (const [index, locale] of ['ru', 'en', 'uk'].entries()) {
      assert.ok(values[index].trim(), `${key}:${locale}`);
      assert.equal(npcDesignText(locale, key), values[index]);
    }
  }
});

test('NPC extraction keeps private drafts, CAS autosave and explicit destructive actions', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../../apps/web/components/studio/npc-library.tsx', import.meta.url),
    'utf8',
  );
  const library = source.slice(
    source.indexOf('export function NpcLibrary'),
    source.indexOf('type NpcDraft'),
  );
  assert.match(library, /items\.data\.map\(\(npc\)/);
  assert.match(library, /!items.error &&/);
  assert.doesNotMatch(library, /npc\.secrets|copy\.secrets|Math\.random/);
  assert.match(source, /enabled: !isNew && hydration > 0/);
  assert.match(source, /expectedEditRevision: revision/);
  assert.match(source, /await autosave\.flush\(\)/);
  assert.match(source, /baseline\.current && dirty && !reloadAllowed\.current/);
  assert.match(source, /characterProfile: n\.characterProfile/);
  assert.match(source, /characterPackageVersionId: n\.characterPackageVersionId/);
  assert.match(source, /secrets: n\.secrets/);
  assert.match(source, /visibility: 'private'/);
  assert.match(source, /dirty \? setLeave\(true\)/);
  assert.match(source, /onClick=\{\(\) => setConfirm\(true\)\}/);
  assert.match(source, /<CharacterSpriteControl target=\{\{ kind: 'npc', id \}\}/);
  assert.match(
    source,
    /onUploaded=\{\(asset\) => \{\s*change\('portraitAssetId', asset.id\);\s*change\('portraitFrame', null\);\s*\}\}/,
  );
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|\/dispatch|\/quote|\/generate/);
  const shell = await readFile(
    new URL('../../apps/web/components/studio.tsx', import.meta.url),
    'utf8',
  );
  assert.match(shell, /<NpcLibrary tabs=\{<StudioTabs npcs \/>\} \/>/);
  assert.doesNotMatch(source, /from ['"]\.\.\/studio['"]/);
});

test('NPC decorative hero stays local and bounded, never becomes an authored portrait', async () => {
  const { readFile } = await import('node:fs/promises');
  const art = await readFile(
    new URL('../../apps/web/public/images/npc-library-observatory.webp', import.meta.url),
  );
  assert.equal(art.toString('ascii', 0, 4), 'RIFF');
  assert.equal(art.toString('ascii', 8, 12), 'WEBP');
  assert.ok(art.length < 400_000);
  const source = await readFile(
    new URL('../../apps/web/components/studio/npc-library.tsx', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(source, /npc-library-observatory/);
  const css = await readFile(
    new URL('../../apps/web/components/studio/npc-library.module.css', import.meta.url),
    'utf8',
  );
  assert.match(css, /npc-library-observatory\.webp/);
  assert.match(css, /object-fit: contain/);
  assert.match(css, /prefers-reduced-motion/);
});

test('story character cards preview only authored public presentation without replacing private drafts', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../../apps/web/components/studio/story-npc-editor.tsx', import.meta.url),
    'utf8',
  );
  const preview = source.slice(
    source.indexOf('data-testid="story-npc-preview"'),
    source.indexOf('{legacy.map'),
  );
  for (const field of ['name', 'portraitAssetId', 'description'])
    assert.ok(preview.includes(`previewNpc.${field}`));
  assert.doesNotMatch(
    preview,
    /previewNpc\.(secrets|characterProfile|personality|knowledge|biography)/,
  );
  assert.match(source, /key in npcSchema.shape/);
  assert.match(source, /expectedNpcRevision/);
  assert.match(source, /expectedStoryRevision: story.editRevision/);
  assert.match(source, /await beforeEdit\(\)/);
  assert.match(source, /if \(kind === 'save'\) npcSchema.parse\(draft\)/);
  assert.match(source, /dirty \? setDiscard\(true\) : close\(\)/);
  assert.match(
    source,
    /!locals.loading &&\s*!templates.loading &&\s*!locals.error &&\s*!templates.error/,
  );
});

test('lore layout retains every field and diagnoses hidden invalid records with the shared schema', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../../apps/web/components/studio/story-lorebook-editor.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /kind="lore"/);
  assert.match(source, /!storyLoreEntrySchema.safeParse\(entry\).success/);
  assert.match(source, /!selectedNpcIds.includes\(id\)/);
  assert.match(source, /!locations.some\(\(location\) => location.id === entry.locationId\)/);
  for (const field of [
    'title',
    'text',
    'disclosure',
    'publicQuestion',
    'knowerNpcIds',
    'locationId',
    'topics',
  ])
    assert.ok(source.includes(`entry.${field}`), field);
  assert.match(source, /const saved = await beforePreview\(\)/);
  assert.match(source, /response.storyEditRevision !== savedRevision/);
  assert.match(source, /inputFingerprint === fingerprintRef.current/);
  const excluded = source.slice(source.indexOf("<h3>{text('excluded')}</h3>"));
  assert.doesNotMatch(excluded, /\{entry\.(text|title)\}/);
});

test('lore collection keeps inactive editors mounted and restores deletion focus without changing draft ownership', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    new URL('../../apps/web/components/studio/collection-editor.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /'locations' \| 'scenes' \| 'lore'/);
  assert.match(source, /items.map\(\(item, index\) => \(/);
  assert.match(source, /hidden=\{active !== item.id\}/);
  assert.match(source, /disabled=\{active !== item.id\}/);
  assert.match(source, /\{children\(item, index\)\}/);
  assert.match(source, /document.activeElement === document.body/);
  assert.match(source, /target\?\.focus\(\)/);
  assert.doesNotMatch(source, /api\(|onChange\(|fetch\(/);
});
