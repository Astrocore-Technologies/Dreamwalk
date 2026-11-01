import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTaxonomy, mergeTaxonomy } from '../../apps/api/src/taxonomy.ts';
import { taxonomySchema } from '../../packages/contracts/src/taxonomy.ts';
const old = { genres: ['Фэнтези', 'Untranslated custom'], tags: [] };
test('legacy genres normalize deterministically without replacing custom values or inventing translations', () => {
  const a = normalizeTaxonomy(old);
  assert.deepEqual(a, normalizeTaxonomy(old));
  assert.deepEqual(a.genres, old.genres);
  assert.equal(a.genreDefinitions[0].labels.en, 'Fantasy');
  assert.deepEqual(a.genreDefinitions[1].labels, {
    uk: old.genres[1],
    en: old.genres[1],
    ru: old.genres[1],
  });
  assert.deepEqual(normalizeTaxonomy(a), a);
});
test('legacy omission preserves translations and historical values; guarded stale updates fail', () => {
  const a = normalizeTaxonomy(old);
  a.genreDefinitions[1].labels.en = 'Edited translation';
  const b = mergeTaxonomy(a, { genres: ['Фэнтези'], tags: [], expectedRevision: 0 });
  assert.equal(b.genreDefinitions[1].labels.en, 'Edited translation');
  assert.equal(b.revision, 1);
  assert.throws(() => mergeTaxonomy(b, { ...old, expectedRevision: 0 }), /Reload before saving/);
  assert.equal(mergeTaxonomy(b, old).genreDefinitions[1].labels.en, 'Edited translation');
});
test('claimed curated/hash IDs do not alias another genre; existing value/ID pairing is immutable', () => {
  const base = normalizeTaxonomy({ genres: ['Custom'], tags: [] });
  const occupied = { ...base.genreDefinitions[0], value: 'Other' };
  const result = normalizeTaxonomy({ ...base, genreDefinitions: [occupied] });
  assert.notEqual(result.genreDefinitions[0].id, result.genreDefinitions[1].id);
  assert.deepEqual(result, normalizeTaxonomy(result));
  assert.throws(
    () =>
      mergeTaxonomy(base, {
        genres: ['Custom'],
        tags: [],
        expectedRevision: base.revision,
        genreDefinitions: [{ ...base.genreDefinitions[0], value: 'Changed' }],
      }),
    /immutable/,
  );
  assert.throws(
    () =>
      mergeTaxonomy(base, {
        genres: ['Custom'],
        tags: [],
        expectedRevision: base.revision,
        genreDefinitions: [{ ...base.genreDefinitions[0], id: 'renamed' }],
      }),
    /immutable/,
  );
});
test('response schema guarantees complete active-genre lookup and unique IDs', () => {
  const a = normalizeTaxonomy(old);
  assert.equal(taxonomySchema.safeParse({ ...a, genreDefinitions: [] }).success, false);
  assert.equal(
    taxonomySchema.safeParse({
      ...a,
      genreDefinitions: [...a.genreDefinitions, a.genreDefinitions[0]],
    }).success,
    false,
  );
});

test('full GET roundtrips reject stale metadata and metadata writes require a revision', () => {
  const initial = normalizeTaxonomy(old);
  const latest = mergeTaxonomy(initial, {
    ...initial,
    genreDefinitions: initial.genreDefinitions.map((d, i) =>
      i ? d : { ...d, labels: { ...d.labels, en: 'New label' } },
    ),
  });
  assert.throws(() => mergeTaxonomy(latest, initial), /Reload before saving/);
  assert.throws(
    () =>
      mergeTaxonomy(latest, {
        genres: latest.genres,
        tags: latest.tags,
        genreDefinitions: latest.genreDefinitions,
      }),
    /revision precondition/,
  );
  assert.equal(
    mergeTaxonomy(latest, { genres: latest.genres, tags: latest.tags }).genreDefinitions[0].labels
      .en,
    'New label',
  );
});
