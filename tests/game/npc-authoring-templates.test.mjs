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
