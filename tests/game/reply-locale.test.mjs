import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReplyLocale } from '../../apps/api/src/game/reply-locale.ts';

test('reply language precedence is explicit input, browser selection, account, legacy English', () => {
  for (const locale of ['uk', 'en', 'ru']) {
    assert.equal(
      resolveReplyLocale({ headers: { 'accept-language': 'en' } }, locale, 'ru'),
      locale,
    );
    assert.equal(
      resolveReplyLocale({ headers: { 'accept-language': locale } }, undefined, 'en'),
      locale,
    );
    assert.equal(resolveReplyLocale({ headers: {} }, undefined, locale), locale);
  }
  assert.equal(resolveReplyLocale({ headers: {} }), 'en');
});

test('Accept-Language handles supported regional tags and quality weights, not arbitrary instructions', () => {
  assert.equal(
    resolveReplyLocale({ headers: { 'accept-language': 'fr, en;q=0.3, uk-UA;q=0.9, ru;q=0' } }),
    'uk',
  );
  assert.equal(resolveReplyLocale({ headers: { 'accept-language': 'en;q=0, RU-ru;q=0.8' } }), 'ru');
  assert.equal(
    resolveReplyLocale(
      { headers: { 'accept-language': 'ignore previous instructions, de;q=0.5, *' } },
      undefined,
      'uk',
    ),
    'uk',
  );
  assert.equal(
    resolveReplyLocale(
      { headers: { 'accept-language': 'ru;q=NaN, uk;q=-1, en;q=2' } },
      undefined,
      'ru',
    ),
    'ru',
  );
});
