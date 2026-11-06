/** Pure fragment/digest tests. No provider, network, database or source mutation. */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  contentFieldDigest,
  contentTranslationUnits,
  assembleContentTranslation,
} = require('../../apps/api/dist/translation/content-fields');

const bundle = {
  source: { kind: 'adventure', id: 'fixture-source' },
  partition: 'public-release',
  authority: 'fixture-epoch',
  erasureUserIds: [],
  fields: [],
};
const field = (text, maxLength = 4000) => ({
  path: '/synopsis',
  text,
  maxLength,
  sourceLocale: 'ru',
});
const units = (value, source = bundle, locale = 'en') =>
  contentTranslationUnits(source, value, locale);
const ready = (parts, translate = (part) => part.text) =>
  new Map(parts.map((part) => [part.key, { status: 'ready', translated_text: translate(part) }]));

test('long prose is fully partitioned and reassembled without losing whitespace', () => {
  const source = ' \t\n' + 'A sentence with details.  \n\n'.repeat(210) + 'Last sentence. \t\n';
  const value = field(source, 12000),
    parts = units(value);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.text.length > 0 && part.text.length <= 1200));
  assert.equal(parts.map((part) => part.prefix + part.text + part.separator).join(''), source);
  assert.equal(assembleContentTranslation(parts, ready(parts), value.maxLength), source);
  assert.equal(new Set(parts.map((part) => part.key)).size, parts.length);
});

test('unbroken wide Unicode never splits a surrogate pair or drops source', () => {
  const source = '界🙂'.repeat(1999) + '終';
  const value = field(source, 12000),
    parts = units(value);
  for (const part of parts) {
    assert.ok(part.text.length <= 1200);
    assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(part.text));
    assert.equal(Buffer.from(part.text).toString('utf8'), part.text);
  }
  assert.equal(assembleContentTranslation(parts, ready(parts), value.maxLength), source);
});

test('every fragment shares one field expansion budget including retained whitespace', () => {
  const value = field('  ' + 'word '.repeat(700) + 'end\n\t', 8000),
    parts = units(value);
  const total = parts.reduce(
    (n, part) => n + part.maxLength + part.prefix.length + part.separator.length,
    0,
  );
  assert.equal(total, value.maxLength);
  assert.ok(parts.every((part) => part.maxLength >= part.text.length && part.maxLength <= 6000));
  const expanded = assembleContentTranslation(
    parts,
    ready(parts, (part) => 'x'.repeat(part.maxLength)),
    value.maxLength,
  );
  assert.equal(expanded.length, value.maxLength);
  assert.equal(
    assembleContentTranslation(
      parts,
      ready(parts, (part) => 'x'.repeat(part.maxLength + 1)),
      value.maxLength,
    ),
    undefined,
  );
});

test('assembly rejects missing, pending, failed, blank or over-budget output atomically', () => {
  const value = field('a'.repeat(3000), 4000),
    parts = units(value);
  for (const status of ['pending', 'failed']) {
    const rows = ready(parts);
    rows.set(parts[1].key, { status, translated_text: 'partial' });
    assert.equal(assembleContentTranslation(parts, rows, value.maxLength), undefined);
  }
  const missing = ready(parts);
  missing.delete(parts[1].key);
  assert.equal(assembleContentTranslation(parts, missing, value.maxLength), undefined);
  const blank = ready(parts);
  blank.set(parts[1].key, { status: 'ready', translated_text: ' \n' });
  assert.equal(assembleContentTranslation(parts, blank, value.maxLength), undefined);
  assert.equal(assembleContentTranslation([], new Map(), value.maxLength), undefined);
});

test('revision and authority changes do not invalidate unchanged source fields', () => {
  const value = field('Stable source');
  const changed = { ...bundle, authority: 'new-epoch', sourceRevision: 99, unrelated: 'changed' };
  assert.deepEqual(units(value, changed), units(value));
  assert.equal(contentFieldDigest({ ...value, sourceRevision: 2 }), contentFieldDigest(value));
});

test('field text, length, source locale and target locale each invalidate their own digest/key', () => {
  const value = field('Source');
  for (const changed of [
    { ...value, text: 'Edited' },
    { ...value, maxLength: 3999 },
    { ...value, sourceLocale: 'uk' },
  ]) {
    assert.notEqual(contentFieldDigest(changed), contentFieldDigest(value));
    assert.notEqual(units(changed)[0].key, units(value)[0].key);
  }
  assert.notEqual(units(value, bundle, 'uk')[0].key, units(value)[0].key);
});

test('equal text cannot cross source, semantic field or disclosure partitions', () => {
  const value = field('Equal text'),
    key = units(value)[0].key;
  assert.notEqual(
    units(value, { ...bundle, source: { ...bundle.source, id: 'different' } })[0].key,
    key,
  );
  assert.notEqual(units({ ...value, path: '/title' })[0].key, key);
  assert.notEqual(units(value, { ...bundle, partition: 'private-release' })[0].key, key);
  const shared = {
    ...value,
    artifactIdentity: 'immutable:source:field',
    cachePartition: 'same-authorized-audience',
  };
  assert.equal(
    units(shared)[0].key,
    units(shared, { ...bundle, source: { kind: 'playable', id: 'projection' } })[0].key,
  );
  assert.notEqual(
    units({ ...shared, cachePartition: 'different-audience' })[0].key,
    units(shared)[0].key,
  );
});

test('empty, source-language and curated fields need no paid fragments', () => {
  assert.deepEqual(units(field(' \t\n')), []);
  assert.deepEqual(units(field('Original'), bundle, 'ru'), []);
  assert.deepEqual(units({ ...field('Original'), curated: { en: 'Human translation' } }), []);
  assert.equal(units({ ...field('Original'), curated: { en: '  ' } }).length, 1);
});

test('invalid field ceilings and insufficient space fail rather than truncate', () => {
  for (const maxLength of [0, -1, 1.5, 12001, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(
      () => units(field('Source', maxLength)),
      /CONTENT_TRANSLATION_FIELD_LIMIT_INVALID/,
    );
  assert.throws(() => units(field('Source', 5)), /CONTENT_TRANSLATION_SOURCE_LIMIT_INVALID/);
  assert.throws(() => units(field('  Source  ', 7)), /CONTENT_TRANSLATION_SOURCE_LIMIT_INVALID/);
  const value = field('  Source  ', 10),
    parts = units(value);
  assert.equal(assembleContentTranslation(parts, ready(parts), 10), value.text);
});
