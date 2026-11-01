import { createHash } from 'node:crypto';
import {
  taxonomySchema,
  type GenreDefinition,
  type Taxonomy,
  type TaxonomyUpdate,
} from '@dreamwalk/contracts/dist/taxonomy';
import { fail } from './errors';

const curated: GenreDefinition[] = [
  { id: 'mystery', value: 'Тайна', labels: { ru: 'Тайна', en: 'Mystery', uk: 'Таємниця' } },
  { id: 'fantasy', value: 'Фэнтези', labels: { ru: 'Фэнтези', en: 'Fantasy', uk: 'Фентезі' } },
  {
    id: 'adventure',
    value: 'Приключение',
    labels: { ru: 'Приключение', en: 'Adventure', uk: 'Пригода' },
  },
  {
    id: 'cozy-fantasy',
    value: 'Уютное фэнтези',
    labels: { ru: 'Уютное фэнтези', en: 'Cozy fantasy', uk: 'Затишне фентезі' },
  },
  {
    id: 'science-fiction',
    value: 'Научная фантастика',
    labels: { ru: 'Научная фантастика', en: 'Science fiction', uk: 'Наукова фантастика' },
  },
];
function unique(definitions: GenreDefinition[]) {
  if (
    new Set(definitions.map((d) => d.id)).size !== definitions.length ||
    new Set(definitions.map((d) => d.value)).size !== definitions.length
  )
    fail(400, 'VALIDATION_FAILED', 'Genre identifiers and values must be unique.');
}
/** Read old JSON without changing persisted strings or requiring a data migration. */
export function normalizeTaxonomy(raw: unknown): Taxonomy {
  const data = raw as Taxonomy;
  const definitions = [...(data.genreDefinitions ?? [])];
  unique(definitions);
  for (const value of data.genres) {
    if (definitions.some((d) => d.value === value)) continue;
    const known = curated.find((d) => d.value === value);
    let id = known?.id;
    let salt = 0;
    // Never silently reuse a colliding ID, including an ID claimed by custom metadata.
    while (!id || definitions.some((d) => d.id === id)) {
      id = 'legacy-' + createHash('sha256').update(`${salt++}:${value}`).digest('hex').slice(0, 32);
    }
    definitions.push({ id, value, labels: known?.labels ?? { uk: value, en: value, ru: value } });
  }
  return taxonomySchema.parse({
    genres: data.genres,
    tags: data.tags,
    genreDefinitions: definitions,
    revision: data.revision ?? 0,
  });
}
/** Must run against the latest row while its transaction holds FOR UPDATE. */
export function mergeTaxonomy(raw: unknown, update: TaxonomyUpdate): Taxonomy {
  const old = normalizeTaxonomy(raw);
  const expectedRevision = update.expectedRevision ?? update.revision;
  if (update.genreDefinitions !== undefined && expectedRevision === undefined)
    fail(400, 'VALIDATION_FAILED', 'Genre metadata updates require a revision precondition.');
  if (expectedRevision !== undefined && expectedRevision !== old.revision)
    fail(409, 'STALE_STATE', 'Taxonomy changed. Reload before saving.');
  if (
    new Set(update.genres).size !== update.genres.length ||
    new Set(update.tags.map((t) => t.id)).size !== update.tags.length
  )
    fail(400, 'VALIDATION_FAILED', 'Genres and tags must be unique.');
  const definitions = old.genreDefinitions.map((d) => ({ ...d }));
  if (update.genreDefinitions) {
    unique(update.genreDefinitions);
    for (const next of update.genreDefinitions) {
      const existing = definitions.find((d) => d.id === next.id);
      if (existing) {
        if (existing.value !== next.value)
          fail(400, 'VALIDATION_FAILED', 'Existing genre values are immutable.');
        definitions[definitions.indexOf(existing)] = next;
      } else {
        if (definitions.some((d) => d.value === next.value) || next.value !== next.id)
          fail(
            400,
            'VALIDATION_FAILED',
            'Existing genre IDs are immutable; new values must equal their ID.',
          );
        definitions.push(next);
      }
    }
  }
  return normalizeTaxonomy({
    genres: update.genres,
    tags: update.tags,
    genreDefinitions: definitions,
    revision: old.revision + 1,
  });
}
