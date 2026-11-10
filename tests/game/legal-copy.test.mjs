import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { legalCopy, legalEditionLabel } from '../../apps/web/components/legal-copy.ts';
const source = await readFile(
  new URL('../../apps/web/components/static.tsx', import.meta.url),
  'utf8',
);
const legalSource = await readFile(
  new URL('../../apps/web/components/legal-page.tsx', import.meta.url),
  'utf8',
);
// Source and copy checks only; these do not establish legal compliance or browser rendering.
test('About, Rules and Privacy exist in every locale with the same structure', () => {
  assert.deepEqual(Object.keys(legalCopy).sort(), ['en', 'ru', 'uk']);
  const shape = (locale) =>
    ['/about', '/terms', '/privacy'].map((path) => legalCopy[locale][path].paragraphs.length);
  for (const locale of ['en', 'ru', 'uk']) {
    assert.deepEqual(Object.keys(legalCopy[locale]), ['/about', '/terms', '/privacy']);
    assert.ok(legalEditionLabel[locale].length > 10);
    assert.deepEqual(shape(locale), shape('ru'));
    assert.equal(legalCopy[locale]['/about'].paragraphs.length, 5);
    for (const path of ['/about', '/terms', '/privacy']) {
      const page = legalCopy[locale][path];
      assert.ok(page.title.length > 0);
      assert.ok(page.paragraphs.every((p) => typeof p === 'string' && p.length > 0));
      // Rules and Privacy: the lead and every section start with a bold title (the contents list).
      if (path !== '/about') assert.ok(page.paragraphs.every((p) => p.startsWith('**')));
      assert.doesNotMatch(
        page.paragraphs.join('\n'),
        /<[a-z]|\[(?:ещё не|требуют|not yet|require)/i,
      );
    }
  }
});
test('public texts state the operator and contact and make no claims the service does not meet', () => {
  for (const locale of ['en', 'ru', 'uk']) {
    const text = JSON.stringify(legalCopy[locale]);
    assert.match(text, /Yurii Serhieiev/);
    assert.match(text, /dreamwalkrp@gmail\.com/);
    assert.match(text, /OpenRouter/);
    assert.match(text, /14/);
    assert.match(text, /18\+/);
  }
  const en = JSON.stringify(legalCopy.en);
  for (const clause of [
    'we do not sell data',
    'we cannot guarantee it',
    'the demo balance is not money',
    'Explicit sexual images are not allowed',
    'within 30 days',
  ])
    assert.ok(en.includes(clause), clause);
  // Never promise things the platform does not do.
  assert.doesNotMatch(en, /end-to-end|never use your data for training|no third parties/i);
});
test('content policy uses the same rules and pages render escaped text without new consent', () => {
  assert.match(source, /path === '\/content-policy' \? '\/terms' : path/);
  assert.match(source, /legalCopy\[locale\]\[legalPath\]/);
  assert.match(source, /eyebrow=\{legalEditionLabel\[locale\]\}/);
  assert.match(source, /<strong key=\{segment\}>\{part.slice\(2, -2\)\}<\/strong>/);
  assert.match(
    source,
    /if \(legalPath === '\/terms' \|\| legalPath === '\/privacy'\) return <LegalPage path=\{legalPath\} \/>/,
  );
  assert.match(legalSource, /legalCopy\[locale\]\[path\]/);
  assert.match(legalSource, /legalEditionLabel\[locale\]/);
  assert.match(legalSource, /<InlineCopy text=\{page.paragraphs\[0\]\} \/>/);
  assert.match(legalSource, /page.paragraphs.slice\(1\).map/);
  assert.doesNotMatch(
    legalSource,
    /<form|<input|<button|onClick|onSubmit|dangerouslySetInnerHTML|fetch\(|localStorage|sessionStorage|document.cookie/,
  );
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|type="checkbox"|onSubmit|fetch\(|method:/);
});
