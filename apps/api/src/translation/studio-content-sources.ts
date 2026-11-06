import type { Locale } from '@dreamwalk/contracts';
import { normalizeTaxonomy } from '../taxonomy';
import { digest } from '../ai/context';
import type {
  ContentSourceAccess,
  ContentSourceRef,
  ContentTranslationAdapter,
  ContentTranslationBundle,
  ContentTranslationField,
  ContentTranslationReadField,
} from './content-types';

type Data = Record<string, unknown>;
type Client = Parameters<ContentTranslationAdapter['load']>[0];
type LocatedField = ContentTranslationField & {
  target: Data;
  key: string;
  metadata?: 'adventure';
  tag?: string;
};
const locales: Locale[] = ['ru', 'uk', 'en'];
const object = (value: unknown): Data =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const pointer = (value: string) => value.replaceAll('~', '~0').replaceAll('/', '~1');
const sourceLocale = (value: unknown): Locale => (value === 'en' || value === 'uk' ? value : 'ru');
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && !!value.trim() && value.length <= max;

function prepared(data: Data, field: string, max: number, tag?: string) {
  const result: Partial<Record<Locale, string>> = {};
  for (const locale of locales) {
    const entry = object(object(data.translations)[locale]);
    if (entry.sourceRevision !== (data.sourceRevision ?? 1)) continue;
    const value = tag === undefined ? entry[field] : object(entry.tags)[tag];
    if (text(value, max)) result[locale] = value;
  }
  return result;
}

function add(
  fields: LocatedField[],
  target: Data,
  key: string,
  path: string,
  maxLength: number,
  locale: Locale,
  extra: Partial<LocatedField> = {},
) {
  if (!text(target[key], maxLength)) return;
  fields.push({ path, text: target[key], maxLength, sourceLocale: locale, target, key, ...extra });
}

function controlledTags(taxonomy: Data) {
  const result = new Set<string>();
  for (const entry of array(taxonomy.tags)) {
    const tag = object(entry);
    if (typeof tag.id === 'string') result.add(tag.id);
    for (const alias of array(tag.aliases)) if (typeof alias === 'string') result.add(alias);
  }
  return result;
}

function adventureFields(data: Data, taxonomy: Data = {}) {
  const fields: LocatedField[] = [],
    locale = sourceLocale(data.sourceLanguage);
  for (const [key, max] of [
    ['title', 120],
    ['synopsis', 4000],
  ] as const)
    add(fields, data, key, `/${key}`, max, locale, {
      metadata: 'adventure',
      curated: prepared(data, key, max),
    });
  const controlled = controlledTags(taxonomy);
  for (const tag of array(data.tags).slice(0, 12)) {
    if (!text(tag, 40) || controlled.has(tag)) continue;
    fields.push({
      path: `/tags/${pointer(tag)}`,
      text: tag,
      maxLength: 40,
      sourceLocale: locale,
      target: data,
      key: 'tags',
      tag,
      metadata: 'adventure',
      curated: prepared(data, 'tags', 40, tag),
    });
  }
  // Duration and publicNpcs are retained in released storage but have no reader
  // presentation here. Do not purchase translations without a consuming surface.
  // Viewer-safe NPC descriptions are owned by the immutable playable adapter.
  return fields;
}

function plain(fields: LocatedField[]): ContentTranslationField[] {
  return fields.map(({ target: _target, key: _key, metadata: _metadata, tag: _tag, ...field }) => ({
    ...field,
  }));
}

function readFields(
  fields: LocatedField[],
  source: ContentSourceRef,
  partition: string,
  locale: Locale,
): ContentTranslationReadField[] {
  return fields.map(({ target, key, metadata, tag, ...field }) => ({
    ...field,
    source,
    partition,
    apply: (translated) => {
      if (metadata) {
        const revision = target.sourceRevision ?? 1,
          translations = object(target.translations),
          previous = object(translations[locale]);
        const current = previous.sourceRevision === revision ? previous : {};
        target.translations = {
          ...translations,
          [locale]: {
            ...current,
            sourceRevision: revision,
            ...(tag === undefined
              ? { [key]: translated }
              : { tags: { ...object(current.tags), [tag]: translated } }),
          },
        };
      }
    },
  }));
}

async function lockPeople(c: Client, owner: string, access: ContentSourceAccess) {
  const ids = [
    ...new Set([owner, ...(access.kind === 'viewer' && access.userId ? [access.userId] : [])]),
  ].sort();
  const rows = (
    await c.query(
      'SELECT id,translation_epoch FROM users WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL ORDER BY id FOR SHARE NOWAIT',
      [ids],
    )
  ).rows;
  if (!ids.every((id) => rows.some((row) => row.id === id && uuid(row.translation_epoch))))
    return null;
  return new Map<string, string>(rows.map((row) => [row.id, row.translation_epoch]));
}

async function readTaxonomy(c: Client) {
  return object(
    (await c.query("SELECT value FROM platform_settings WHERE key='taxonomy' FOR SHARE NOWAIT"))
      .rows[0]?.value,
  );
}

const adventureAdapter: ContentTranslationAdapter = {
  kind: 'adventure',
  async load(c, source, access) {
    if (source.kind !== 'adventure' || !uuid(source.id)) return [];
    const owner = (await c.query('SELECT owner_id FROM adventures WHERE id=$1', [source.id]))
      .rows[0]?.owner_id;
    if (!uuid(owner)) return [];
    const people = await lockPeople(c, owner, access);
    if (!people) return [];
    const row = (
      await c.query(
        `SELECT a.id,a.owner_id,a.visibility,a.status,a.deleted_at,a.translation_epoch,
          a.published_snapshot,a.private_release_id,r.snapshot AS private_snapshot FROM adventures a
       LEFT JOIN adventure_private_releases r ON r.id=a.private_release_id
       WHERE a.id=$1 FOR SHARE OF a NOWAIT`,
        [source.id],
      )
    ).rows[0];
    if (
      !row ||
      row.owner_id !== owner ||
      row.deleted_at ||
      row.status === 'archived' ||
      !uuid(row.translation_epoch)
    )
      return [];
    const taxonomy = await readTaxonomy(c),
      bundles: ContentTranslationBundle[] = [];
    const authority = `${owner}:${people.get(owner)}:${row.translation_epoch}`;
    const bundle = (partition: string, accessAuthority: string, data: Data) =>
      bundles.push({
        source,
        partition,
        authority: accessAuthority,
        erasureUserIds: [owner],
        fields: plain(adventureFields(data, taxonomy)).map((field) => ({
          ...field,
          artifactIdentity: digest([
            'released-story-field',
            source.id,
            owner,
            field.path === '/title'
              ? 'title'
              : field.path === '/synopsis'
                ? 'synopsis'
                : field.path,
          ]),
          cachePartition: partition === 'private-release' ? 'released:private' : 'released:public',
        })),
      });
    if (row.visibility === 'public' && row.published_snapshot)
      bundle('public-release', `public:${authority}`, object(row.published_snapshot));
    if (row.visibility === 'private' && row.private_release_id && row.private_snapshot) {
      const isOwner = access.kind === 'system' || access.userId === owner;
      const invitation =
        access.kind === 'viewer' && access.userId && !isOwner
          ? (
              await c.query(
                "SELECT id,translation_epoch FROM adventure_invitations WHERE adventure_id=$1 AND recipient_id=$2 AND status='accepted' FOR SHARE NOWAIT",
                [source.id, access.userId],
              )
            ).rows[0]
          : undefined;
      if (isOwner || (invitation && uuid(invitation.translation_epoch)))
        bundle(
          'private-release',
          `private:${authority}${invitation ? `:invite:${invitation.id}:${invitation.translation_epoch}:${people.get(access.kind === 'viewer' ? access.userId! : owner)}` : ''}`,
          object(row.private_snapshot),
        );
    }
    return bundles;
  },
  project(path, original, locale) {
    const value = structuredClone(original),
      fields: ContentTranslationReadField[] = [];
    const addAdventure = (item: unknown) => {
      const data = object(item);
      if (
        !uuid(data.id) ||
        data.status !== 'published' ||
        data.editRevision !== undefined ||
        data.access === 'owner' ||
        data.access === 'reviewer'
      )
        return;
      if (data.visibility !== 'public' && data.visibility !== 'private') return;
      fields.push(
        ...readFields(
          adventureFields(data),
          { kind: 'adventure', id: data.id },
          data.visibility === 'private' ? 'private-release' : 'public-release',
          locale,
        ),
      );
    };
    if (path === '/adventures') array(value).forEach(addAdventure);
    else if (/^\/adventures\/[^/]+$/.test(path)) addAdventure(value);
    else if (/^\/creators\/[^/]+$/.test(path))
      array(object(value).adventures).forEach(addAdventure);
    else if (path === '/library')
      for (const key of ['favorites', 'shared', 'privatePublished'])
        array(object(value)[key]).forEach(addAdventure);
    return { value, fields };
  },
};

function taxonomyFields(raw: Data, normalized = false): LocatedField[] {
  const fields: LocatedField[] = [];
  const data: Data = normalized ? raw : { ...normalizeTaxonomy(raw) };
  for (const collection of ['tags', 'genreDefinitions'])
    for (const value of array(data[collection]).slice(0, collection === 'tags' ? 100 : 1000)) {
      const entry = object(value),
        labels = object(entry.labels);
      if (!text(entry.id, 80) || !text(labels.ru, 40)) continue;
      const explicit = array(raw[collection]).some((item) => object(item).id === entry.id);
      const knownLegacy = labels.en !== labels.ru || labels.uk !== labels.ru;
      const curated: Partial<Record<Locale, string>> = {};
      if (!normalized && (explicit || knownLegacy))
        for (const locale of locales)
          if (text(labels[locale], 40)) curated[locale] = labels[locale];
      fields.push({
        path: `/${collection}/${pointer(entry.id)}/label`,
        text: labels.ru,
        maxLength: 40,
        sourceLocale: 'ru',
        curated,
        target: labels,
        key: 'label',
      });
    }
  return fields;
}

const taxonomyAdapter: ContentTranslationAdapter = {
  kind: 'taxonomy',
  async load(c, source) {
    if (source.kind !== 'taxonomy' || source.id !== 'taxonomy') return [];
    const raw = await readTaxonomy(c);
    if (!Array.isArray(raw.genres)) return [];
    return [
      {
        source,
        partition: 'public-taxonomy',
        authority: 'platform:taxonomy',
        erasureUserIds: [],
        fields: plain(taxonomyFields(raw)),
      },
    ];
  },
  project(path, original, locale) {
    const value = structuredClone(original),
      fields: ContentTranslationReadField[] = [];
    const data = path === '/tags' ? { tags: value } : object(value);
    if (!['/tags', '/taxonomy'].includes(path)) return { value, fields };
    for (const { target, key: _key, metadata: _metadata, tag: _tag, ...field } of taxonomyFields(
      data,
      true,
    ))
      fields.push({
        ...field,
        source: { kind: 'taxonomy', id: 'taxonomy' },
        partition: 'public-taxonomy',
        apply: (translated) => {
          target[locale] = translated;
        },
      });
    return { value, fields };
  },
};

/** No mutable Studio or NPC source: only current immutable released presentation
 * and the platform's public taxonomy. Draft translation is explicitly excluded. */
export const studioContentTranslationAdapters: ContentTranslationAdapter[] = [
  adventureAdapter,
  taxonomyAdapter,
];
