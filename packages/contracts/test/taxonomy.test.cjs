const { test } = require('node:test');
const assert = require('node:assert/strict');
const { genreDefinitionSchema, taxonomyUpdateSchema } = require('../dist/taxonomy');
const genre = {
  id: 'new-genre',
  value: 'new-genre',
  labels: { uk: 'Новий', en: 'New', ru: 'Новый' },
};
test('genre definitions validate complete bounded translations and IDs', () => {
  assert.deepEqual(genreDefinitionSchema.parse(genre), genre);
  for (const invalid of [
    { ...genre, id: 'Bad ID' },
    { ...genre, labels: { ...genre.labels, en: '   ' } },
    { ...genre, labels: { ...genre.labels, en: 'a'.repeat(41) } },
    { ...genre, labels: { en: 'New', ru: 'Новый' } },
  ])
    assert.equal(genreDefinitionSchema.safeParse(invalid).success, false);
});
test('legacy updates omit definitions while new callers can provide a revision precondition', () => {
  assert.deepEqual(taxonomyUpdateSchema.parse({ genres: ['Custom'], tags: [] }), {
    genres: ['Custom'],
    tags: [],
  });
  assert.equal(
    taxonomyUpdateSchema.parse({
      genres: [genre.value],
      tags: [],
      genreDefinitions: [genre],
      expectedRevision: 0,
    }).expectedRevision,
    0,
  );
});

test('metadata-aware writes require either revision or expectedRevision', () => {
  const update = { genres: [genre.value], tags: [], genreDefinitions: [genre] };
  assert.equal(taxonomyUpdateSchema.safeParse(update).success, false);
  assert.equal(taxonomyUpdateSchema.safeParse({ ...update, revision: 0 }).success, true);
});
