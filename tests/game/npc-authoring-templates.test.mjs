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
  assert.match(source, /onUploaded=\{\(asset\) => change\('portraitAssetId', asset.id\)\}/);
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
