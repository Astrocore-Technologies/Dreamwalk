import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(
  new URL('../../apps/web/components/studio/story-npc-editor.tsx', import.meta.url),
  'utf8',
);

test('story NPC editor uses scoped copies and independent export, never edits a library entity', () => {
  assert.match(source, /`\/studio\/adventures\/\$\{adventureId\}\/npcs`/);
  assert.match(source, /`\$\{base\}\/import`/);
  assert.match(source, /`\$\{base\}\/\$\{\(current as LocalNpc\)\.id\}\/template`/);
  assert.match(source, /useResource<Npc\[\]>\('\/npcs'\)/);
  assert.doesNotMatch(source, /api[^\n]*\(`\/npcs\//);
  assert.doesNotMatch(source, /target="_blank"|window\.open|dangerouslySetInnerHTML/);
  assert.match(source, /selectedNpcIds\.includes\(npc.id\)/);
});
test('author save precedes revision read and exact prepared request survives uncertain retries', () => {
  assert.ok(
    source.indexOf('await beforeEdit()') < source.indexOf('const story = await api<Adventure>'),
  );
  assert.match(source, /let operation = operations.current.get\(key\)/);
  assert.match(source, /if \(!operation\)/);
  assert.match(source, /requestId: crypto.randomUUID\(\)/);
  assert.match(source, /expectedStoryRevision: story.editRevision/);
  assert.match(source, /body: JSON.stringify\(operation.body\)/);
  assert.match(source, /expectedNpcRevision:/);
  // Known rejected mutations may refresh their CAS token; transport failures retain the exact body.
  assert.match(source, /failure instanceof ApiError/);
  assert.match(source, /'STALE_STATE', 'VALIDATION_FAILED', 'NOT_FOUND', 'IDEMPOTENCY_CONFLICT'/);
});
test('epochs and locks guard interrupted edits, uploads and sprite completion; dirty drafts are not reloaded', () => {
  assert.match(source, /if \(lock.current\) return/);
  assert.match(source, /if \(stamp !== epoch.current\) return/);
  assert.match(source, /formEpoch === epoch.current && !lock.current/);
  assert.match(source, /dirtyRef.current \|\|/);
  assert.match(source, /editing !== 'new' && !dirty && !busy/);
  assert.match(source, /<CharacterSpriteControl/);
  assert.match(source, /dirty \? setDiscard\(true\) : close\(\)/);
  assert.match(source, /window.addEventListener\('beforeunload', warn\)/);
  assert.doesNotMatch(source, /useEffect\([\s\S]{0,250}setDraft\(.*locals/);
});
test('all NPC authoring fields retain validation and local copy has three complete language entries', () => {
  for (const field of [
    'description',
    'personality',
    'appearance',
    'biography',
    'secrets',
    'greeting',
  ])
    assert.match(source, new RegExp(`'${field}'`));
  assert.match(source, /min=\{18\}/);
  assert.match(source, /max=\{10000\}/);
  assert.match(source, /maxLength=\{80\}/);
  assert.match(source, /maxLength=\{120\}/);
  assert.match(source, /sourceLanguage/);
  assert.match(source, /portraitAssetId/);
  // Hidden profile/model preferences remain in the schema-derived draft rather than controls.
  assert.match(source, /Object.entries\(data\).*key in npcSchema.shape/);
  assert.doesNotMatch(source, /label=\{t\('Стиль поведения'\)\}/);
  assert.match(source, /npcSchema.parse\(draft\)/);
  assert.match(source, /locale === 'ru' \? 0 : locale === 'en' \? 1 : 2/);
  assert.match(source, /Персонажі цієї історії/);
  assert.match(source, /Characters in this story/);
  assert.match(source, /Персонажи этой истории/);
});

test('optional template selector has a stable localized name independent of option text', () => {
  assert.match(source, /<Select\s+aria-label=\{text\('library'\)\}\s+value=\{templateId\}/);
});
