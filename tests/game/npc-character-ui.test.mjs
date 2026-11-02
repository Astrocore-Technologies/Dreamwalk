import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  characterCopy,
  characterText,
} from '../../apps/web/components/studio/npc-character-copy.ts';
const read = (path) =>
  readFile(new URL(`../../apps/web/components/${path}`, import.meta.url), 'utf8');
const profile = await read('studio/npc-character-profile.tsx');
const lore = await read('studio/story-lorebook-editor.tsx');
const preferences = await read('game/narrative-preferences.tsx');
const story = await read('game/unified-story.tsx');

test('character and lore copy covers every key in three languages', () => {
  for (const [key, values] of Object.entries(characterCopy)) {
    assert.equal(values.length, 3, key);
    for (const [index, locale] of ['ru', 'en', 'uk'].entries()) {
      assert.ok(values[index].trim(), `${key}:${locale}`);
      assert.equal(characterText(locale, key), values[index]);
    }
  }
});
test('structured profile is opt-in, clears explicitly and respects bounded real controls', () => {
  assert.match(profile, /newCharacterProfile\(\) : null/);
  assert.match(profile, /c\.motives\.length >= 4/);
  assert.match(profile, /c\.reactions\.length >= triggers\.length/);
  assert.match(profile, /c\.dialogueExamples\.length >= 4/);
  assert.match(profile, /maxLength=\{240\}/);
  assert.match(profile, /personality\.values\.length === 1/);
  assert.doesNotMatch(
    profile,
    /romanceEnabled|JSON\.parse|dangerouslySetInnerHTML|systemPrompt|importCard/,
  );
  assert.match(profile, /publicVoice:/);
  assert.match(profile, /dialogueExamples:/);
});
test('lore preview is explicit, saved-source-bound, stale guarded and knowledge-specific', () => {
  assert.ok(lore.indexOf('await beforePreview()') < lore.indexOf('await api<Preview>'));
  assert.match(lore, /if \(!saved\) throw/);
  assert.match(lore, /inputFingerprint !== fingerprintRef\.current/);
  assert.match(lore, /response\.storyEditRevision !== savedRevision/);
  assert.match(lore, /result\.fingerprint === fingerprint/);
  assert.match(lore, /selectedNpcIds\.includes\(npcId\)/);
  assert.match(lore, /entry\.knowerNpcIds\.length >= 8/);
  assert.match(lore, /entries\.length >= 16/);
  assert.doesNotMatch(lore, /setInterval|\/dispatch|\/quote|\/generate|dangerouslySetInnerHTML/);
});
test('presentation edits use exact replay identity and explicit CAS conflict recovery', () => {
  assert.match(preferences, /if \(!open \|\| saved\) return/);
  assert.match(preferences, /expectedRevision: saved\.revision/);
  assert.match(preferences, /let operation = operations\.current\.get\(key\)/);
  assert.match(preferences, /if \(!operation\)/);
  assert.match(preferences, /body: JSON\.stringify\(operation\)/);
  assert.match(preferences, /failure instanceof ApiError/);
  assert.match(preferences, /if \(failure\.code === 'STALE_STATE'\) setStale\(true\)/);
  assert.match(preferences, /disabled=\{!dirty \|\| stale\}/);
  assert.doesNotMatch(preferences, /<Textarea|\/commands|\/move|\/turns|setInterval/);
});
test('a presentation change invalidates only the matching prepared quote, preserving story draft', () => {
  assert.match(story, /detail\?\.campaignId === campaignId\) setPrepared\(null\)/);
  const listener = story.slice(
    story.indexOf('const invalidate ='),
    story.indexOf('const refresh ='),
  );
  assert.doesNotMatch(listener, /setText|submit|confirm|quote\(/);
  assert.match(listener, /removeEventListener/);
});

test('uncertain preference writes freeze edits and discard until the exact save is resolved', () => {
  assert.match(preferences, /setPending\(true\)/);
  assert.match(preferences, /'RATE_LIMITED',[\s\S]*?\]\.includes\(failure.code\)/);
  assert.match(preferences, /disabled=\{!dirty \|\| pending\}/);
  assert.match(preferences, /if \(pending\) return/);
  assert.equal((preferences.match(/disabled=\{pending\}/g) || []).length, 3);
  assert.match(preferences, /pending && <p role="status"/);
});
