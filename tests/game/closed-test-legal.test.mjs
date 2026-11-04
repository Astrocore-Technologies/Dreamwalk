import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  closedTestLegalCopy,
  closedTestDraftLabel,
} from '../../apps/web/components/closed-test-legal-copy.ts';
const source = await readFile(
  new URL('../../apps/web/components/static.tsx', import.meta.url),
  'utf8',
);
const legalSource = await readFile(
  new URL('../../apps/web/components/legal-page.tsx', import.meta.url),
  'utf8',
);
// Source and copy checks only; these do not establish legal compliance or browser rendering.
test('all three reviewed closed-test pages exist in all supported locales with draft labels', () => {
  assert.deepEqual(Object.keys(closedTestLegalCopy).sort(), ['en', 'ru', 'uk']);
  for (const locale of ['en', 'ru', 'uk']) {
    assert.deepEqual(Object.keys(closedTestLegalCopy[locale]), ['/about', '/terms', '/privacy']);
    assert.ok(closedTestDraftLabel[locale].length > 10);
    for (const [path, count] of [
      ['/about', 5],
      ['/terms', 7],
      ['/privacy', 6],
    ]) {
      const page = closedTestLegalCopy[locale][path];
      assert.ok(page.title.length > 0);
      assert.equal(page.paragraphs.length, count);
      assert.ok(page.paragraphs.every((p) => typeof p === 'string' && p.length > 0));
      assert.ok(page.paragraphs[0].startsWith('**'));
      assert.match(page.paragraphs.join('\n'), /\[[^\]]+\]/);
    }
  }
});
test('reviewed draft copy includes limits and no internal review notes or invented operator', () => {
  const text = JSON.stringify(closedTestLegalCopy);
  assert.doesNotMatch(
    text,
    /Internal review notes|Outstanding facts|IsekaiZero|Astrocore|copyright.gov|\$5|200 Sparks/,
  );
  const en = JSON.stringify(closedTestLegalCopy.en);
  for (const clause of [
    'Continued use is not declared to constitute acceptance',
    'not proof of payment',
    'not a complete privacy policy',
    'Do not assume that providers never receive data',
    'not a promise of immediate, complete erasure',
    'neither imposes a blanket ban nor grants blanket permission',
  ])
    assert.ok(en.includes(clause));
});
test('content policy uses the same draft rules and pages render escaped text without new consent', () => {
  assert.match(source, /path === '\/content-policy' \? '\/terms' : path/);
  assert.match(source, /closedTestLegalCopy\[locale\]\[legalPath\]/);
  assert.match(source, /eyebrow=\{closedTestDraftLabel\[locale\]\}/);
  assert.match(source, /<strong key=\{segment\}>\{part.slice\(2, -2\)\}<\/strong>/);
  assert.match(
    source,
    /if \(legalPath === '\/terms' \|\| legalPath === '\/privacy'\) return <LegalPage path=\{legalPath\} \/>/,
  );
  assert.match(legalSource, /closedTestLegalCopy\[locale\]\[path\]/);
  assert.match(legalSource, /closedTestDraftLabel\[locale\]/);
  assert.match(legalSource, /<InlineCopy text=\{page.paragraphs\[0\]\} \/>/);
  assert.match(legalSource, /page.paragraphs.slice\(1\).map/);
  assert.match(legalSource, /<strong key=\{index\}>\{part.slice\(2, -2\)\}<\/strong>/);
  assert.match(legalSource, /<InlineCopy text=\{body\} \/>/);
  assert.doesNotMatch(
    legalSource,
    /<form|<input|<button|onClick|onSubmit|dangerouslySetInnerHTML|fetch\(|localStorage|sessionStorage|document.cookie/,
  );
  assert.doesNotMatch(
    source,
    /dangerouslySetInnerHTML|type="checkbox"|onSubmit|fetch\(|method:|Платные AI-провайдеры сейчас не получают данные|Игровой движок, AI-ведущий и совместные сессии ещё не подключены/,
  );
});

test('page copy matches parent-reviewed November 1 draft byte-for-byte', () => {
  const expected = {
    'ru/about': 'e009ffc9119fcbc62b16b11acc3abacb2ee94367c929b42f45ddad8141c45670',
    'ru/terms': '66be5ebc21ca504109ad376af4c7b764e96745f5de22d060c73630fdd4cfa6a1',
    'ru/privacy': '06326b0f38aff5d306a16d3f870ea1213bb00cc14079717f6d81446ba02e69e8',
    'uk/about': 'f81a22a6e0fbcb8d29e31e07f2de4601c133de0353bfdbcb2d41ddc14e5084ea',
    'uk/terms': 'feb79ad740392ce8a3cb3d1dd25dd87b132dbb3347e29bce9a8a724988e68ed4',
    'uk/privacy': '2b8d9ebb7fcb8bcbb685f16e226ee7e01c4bdaff61996e57a42765103c58ccca',
    'en/about': 'e5ba4b82af875dd987d7f383e8b1697e72984657158c8b8f4ea785d98074433a',
    'en/terms': '5c6b7b56195cafe4b68d1ee3afed7dd1e97154d1b07c0fb43f89fc9396bbcab3',
    'en/privacy': '1857107c4ffc9ba4cfc5f0c0701d8150a6c8f7a6f4ef1a88ae443ee64b0526a6',
  };
  for (const [locale, pages] of Object.entries(closedTestLegalCopy)) {
    for (const [path, page] of Object.entries(pages))
      assert.equal(
        createHash('sha256').update(JSON.stringify(page)).digest('hex'),
        expected[locale + path],
      );
  }
});
