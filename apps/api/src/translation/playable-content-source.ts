import type { GameState, Locale } from '@dreamwalk/contracts';
import { projectState } from '@dreamwalk/game-core';
import { digest } from '../ai/context';
import { sourceAccessSql } from '../game/source-access';
import type {
  ContentSourceAccess,
  ContentSourceRef,
  ContentTranslationAdapter,
  ContentTranslationBundle,
  ContentTranslationField,
  ContentTranslationReadField,
} from './content-types';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as ObjectValue) : undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const part = (value: string) => encodeURIComponent(value);
const partition = 'released-descriptions';
const locale = (value: unknown): Locale | undefined =>
  value === 'ru' || value === 'uk' || value === 'en' ? value : undefined;
const profileFields = [
  ['role', 120],
  ['description', 4000],
  ['appearance', 4000],
  ['personality', 4000],
] as const;
const curated = (value: unknown, max: number) => {
  const result: Partial<Record<Locale, string>> = {};
  for (const locale of ['ru', 'uk', 'en'] as const) {
    const text = object(value)?.[locale];
    if (typeof text === 'string' && text.trim() && text.length <= max) result[locale] = text;
  }
  return Object.keys(result).length ? result : undefined;
};

/** Only immutable authored descriptions. In particular, never visit npcBrains,
 * greeting/utterances, narrative turns, planner results or mutable NPC templates. */
export function releasedPlayableFields(value: unknown): ContentTranslationField[] {
  const pkg = object(value);
  if (!pkg || pkg.erased === true) return [];
  const fields = new Map<string, ContentTranslationField>();
  const source = object(pkg.source),
    storyLocale = locale(source?.sourceLanguage);
  const locations = list(object(source?.content)?.locations).map(object);
  const definitions = list(pkg.npcDefinitions).map(object);
  const npcOrigin = (id: string, key: string, text: unknown, max: number) => {
    const definitionsForId = definitions.filter((npc) => npc?.id === id);
    if (definitionsForId.length !== 1 || typeof text !== 'string') return undefined;
    const data = object(definitionsForId[0]?.data),
      original = data?.[key];
    return typeof original === 'string' && original.slice(0, max) === text ? data : undefined;
  };
  const npcLocale = (id: string, key: string, text: unknown, max: number) =>
    locale(npcOrigin(id, key, text, max)?.sourceLanguage);
  const npcCurated = (id: string, key: string, text: unknown, max: number) => {
    const data = npcOrigin(id, key, text, max),
      translations = object(data?.translations);
    if (!data || !Number.isSafeInteger(data.sourceRevision) || Number(data.sourceRevision) < 1)
      return undefined;
    return curated(
      Object.fromEntries(
        ['ru', 'uk', 'en'].flatMap((locale) => {
          const entry = object(translations?.[locale]);
          return entry && entry.sourceRevision === data.sourceRevision
            ? [[locale, entry[key]]]
            : [];
        }),
      ),
      max,
    );
  };
  const mapLocale = (id: string, key: string, text: unknown) => {
    const matching = locations.filter((location) => location?.id === id);
    return matching.length === 1 && matching[0]?.[key] === text ? storyLocale : undefined;
  };
  const add = (
    path: string,
    text: unknown,
    maxLength: number,
    translations?: unknown,
    sourceLocale?: Locale,
  ) => {
    if (typeof text !== 'string' || !text.trim() || text.length > maxLength) return;
    const human = curated(translations, maxLength);
    fields.set(path, {
      path,
      text,
      maxLength,
      ...(human ? { curated: human } : {}),
      ...(sourceLocale ? { sourceLocale } : {}),
    });
  };
  const profile = (id: string, data: unknown) => {
    for (const [key, max] of profileFields)
      add(
        `entity/${part(id)}/profile/${key}`,
        object(data)?.[key],
        max,
        npcCurated(id, key, object(data)?.[key], max),
        npcLocale(id, key, object(data)?.[key], max),
      );
  };
  const compiled = object(pkg.compiled);
  if (compiled) {
    const title = compiled.title ?? source?.title;
    add('title', title, 120, undefined, title === source?.title ? storyLocale : undefined);
    for (const [id, mapValue] of Object.entries(object(compiled.maps) ?? {})) {
      const map = object(mapValue);
      if (map?.id !== id) continue;
      add(
        `map/${part(id)}/label`,
        map.label,
        120,
        map.labelTranslations,
        mapLocale(id, 'name', map.label),
      );
      add(
        `map/${part(id)}/description`,
        map.description,
        6000,
        undefined,
        mapLocale(id, 'description', map.description),
      );
      for (const value of list(map.exits)) {
        const exit = object(value);
        const destination =
          typeof exit?.destinationMapId === 'string'
            ? object(object(compiled.maps)?.[exit.destinationMapId])
            : undefined;
        const exitCurated = curated(exit?.labelTranslations, 120),
          destinationCurated = curated(destination?.labelTranslations, 120);
        const distinctCurated = Object.entries(exitCurated ?? {}).some(
          ([locale, text]) => destinationCurated?.[locale as Locale] !== text,
        );
        // Compiler-derived destination labels reuse the exact map artifact.
        if (typeof exit?.id === 'string' && (exit.label !== destination?.label || distinctCurated))
          add(
            `map/${part(id)}/exit/${part(exit.id)}/label`,
            exit.label,
            120,
            exit.labelTranslations,
          );
      }
    }
    for (const [id, entityValue] of Object.entries(object(compiled.entities) ?? {})) {
      const entity = object(entityValue);
      if (entity?.id !== id || entity.kind === 'player') continue;
      add(
        `entity/${part(id)}/label`,
        entity.label,
        120,
        { ...npcCurated(id, 'name', entity.label, 120), ...curated(entity.labelTranslations, 120) },
        npcLocale(id, 'name', entity.label, 120),
      );
      profile(id, entity.publicProfile);
      add(`entity/${part(id)}/item/label`, object(entity.item)?.label, 120);
      add(`entity/${part(id)}/item/description`, object(entity.item)?.description, 1000);
    }
  } else if (pkg.schemaVersion === 2 && pkg.kind === 'launch-source') {
    // compileStoryPlan pins map.id=location.id and NPC id=sourceNpcId, checked
    // against exact source ID sets. No name matching or guessed remapping.
    const planner = object(pkg.plannerSource);
    const content = object(planner?.content);
    if (!planner || !content) return [];
    add(
      'title',
      planner.title,
      120,
      undefined,
      planner.title === source?.title ? storyLocale : undefined,
    );
    for (const value of list(content.locations)) {
      const location = object(value);
      if (typeof location?.id !== 'string') continue;
      add(
        `map/${part(location.id)}/label`,
        location.name,
        120,
        undefined,
        mapLocale(location.id, 'name', location.name),
      );
      add(
        `map/${part(location.id)}/description`,
        location.description,
        6000,
        undefined,
        mapLocale(location.id, 'description', location.description),
      );
    }
    const ids = list(content.npcIds);
    const npcs = list(planner.npcs).map(object);
    if (
      ids.some((id) => typeof id !== 'string') ||
      new Set(ids).size !== ids.length ||
      npcs.length !== ids.length ||
      new Set(npcs.map((npc) => npc?.id)).size !== ids.length ||
      npcs.some((npc) => !npc || !ids.includes(npc.id))
    )
      return [];
    for (const npc of npcs) {
      const id = npc!.id as string;
      add(
        `entity/${part(id)}/label`,
        npc!.name,
        120,
        npcCurated(id, 'name', npc!.name, 120),
        npcLocale(id, 'name', npc!.name, 120),
      );
      profile(id, npc);
    }
  }
  return [...fields.values()];
}

/** Descriptive overlay candidates only. Final reads intersect these exact paths
 * and text with the locked immutable package and a fresh authorized projection. */
export function playableDescriptionProjection<T>(
  path: string,
  original: T,
  _locale: Locale,
  viewerId: string | null,
) {
  const value = structuredClone(original);
  const fields: ContentTranslationReadField[] = [];
  const match = path.match(/^\/game\/campaigns\/([0-9a-f-]{36})\/snapshot$/i);
  const root = object(value),
    campaign = object(root?.campaign);
  if (!viewerId || !match || !uuid(match[1]) || !uuid(campaign?.playableVersionId))
    return { value, fields };
  const source: ContentSourceRef = { kind: 'playable', id: campaign.playableVersionId };
  const add = (
    fieldPath: string,
    targetValue: unknown,
    key: string,
    maxLength: number,
    label = false,
  ) => {
    const target = object(targetValue),
      text = target?.[key];
    if (!target || typeof text !== 'string' || !text.trim() || text.length > maxLength) return;
    const field: ContentTranslationReadField = {
      source,
      partition,
      campaignId: match[1],
      path: fieldPath,
      text,
      maxLength,
      apply: (translated) => {
        if (label)
          target.labelTranslations = { ...object(target.labelTranslations), [_locale]: translated };
        else target[key] = translated;
      },
    };
    fields.push(field);
    return field;
  };
  add('title', campaign, 'title', 120);
  const projection = object(root?.projection),
    map = object(projection?.map);
  if (typeof map?.id === 'string') {
    add(`map/${part(map.id)}/label`, map, 'label', 120, true);
    add(`map/${part(map.id)}/description`, map, 'description', 6000);
    for (const value of list(map.exits)) {
      const exit = object(value);
      let specificApplied = false;
      if (typeof exit?.id === 'string') {
        const specific = add(
          `map/${part(map.id)}/exit/${part(exit.id)}/label`,
          exit,
          'label',
          120,
          true,
        );
        if (specific) {
          const apply = specific.apply;
          specific.apply = (text) => {
            specificApplied = true;
            apply(text);
          };
        }
      }
      if (typeof exit?.destinationMapId === 'string') {
        const fallback = add(`map/${part(exit.destinationMapId)}/label`, exit, 'label', 120, true);
        if (fallback) {
          const apply = fallback.apply;
          fallback.apply = (text) => {
            if (!specificApplied) apply(text);
          };
        }
      }
    }
  }
  for (const value of list(projection?.locations)) {
    const location = object(value);
    if (typeof location?.id === 'string')
      add(`map/${part(location.id)}/label`, location, 'label', 120, true);
  }
  for (const value of [...list(projection?.entities), ...list(projection?.inventory)]) {
    const entity = object(value);
    if (typeof entity?.id !== 'string' || entity.kind === 'player') continue;
    add(`entity/${part(entity.id)}/label`, entity, 'label', 120, true);
    for (const [key, max] of profileFields)
      add(`entity/${part(entity.id)}/profile/${key}`, entity.publicProfile, key, max);
    add(`entity/${part(entity.id)}/item/label`, entity.item, 'label', 120);
    add(`entity/${part(entity.id)}/item/description`, entity.item, 'description', 1000);
  }
  return { value, fields };
}

export class PlayableContentSource implements ContentTranslationAdapter {
  readonly kind = 'playable' as const;
  project = playableDescriptionProjection;
  async load(
    c: Parameters<ContentTranslationAdapter['load']>[0],
    source: ContentSourceRef,
    access: ContentSourceAccess,
  ): Promise<ContentTranslationBundle[]> {
    if (source.kind !== 'playable' || !uuid(source.id)) return [];
    if (access.kind === 'viewer' && (!uuid(access.userId) || !uuid(access.campaignId))) return [];
    const owner = (
      await c.query(
        'SELECT a.owner_id FROM game_playable_versions v JOIN adventures a ON a.id=v.adventure_id WHERE v.id=$1',
        [source.id],
      )
    ).rows[0]?.owner_id;
    if (!owner) return [];
    const campaignOwner =
      access.kind === 'viewer'
        ? (
            await c.query(
              'SELECT owner_id FROM game_campaigns WHERE id=$1 AND source_version_id=$2',
              [access.campaignId, source.id],
            )
          ).rows[0]?.owner_id
        : null;
    if (access.kind === 'viewer' && !campaignOwner) return [];
    await c.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE NOWAIT', [
      [
        ...new Set(
          [owner, campaignOwner, access.kind === 'viewer' ? access.userId : null].filter(Boolean),
        ),
      ].sort(),
    ]);
    const row = (
      await c.query(
        `SELECT v.package,v.checksum,v.audience,a.id AS adventure_id,a.owner_id,
        a.translation_epoch AS source_epoch,u.translation_epoch AS owner_epoch,a.published_snapshot,
        (SELECT pr.snapshot FROM adventure_private_releases pr
          WHERE pr.id=a.private_release_id AND pr.adventure_id=a.id) AS private_snapshot
       FROM game_playable_versions v JOIN adventures a ON a.id=v.adventure_id
       JOIN users u ON u.id=a.owner_id
       WHERE v.id=$1 AND a.deleted_at IS NULL AND u.deleted_at IS NULL AND a.status<>'archived'
       AND ((v.audience='review' AND a.visibility='public' AND a.published_snapshot IS NOT NULL
         AND EXISTS(SELECT 1 FROM game_playable_approvals ap WHERE ap.playable_version_id=v.id))
        OR (v.audience='private' AND a.private_release_id IS NOT NULL
         AND EXISTS(SELECT 1 FROM adventure_private_releases pr WHERE pr.playable_version_id=v.id AND pr.adventure_id=a.id)))
       FOR SHARE OF v,a NOWAIT`,
        [source.id],
      )
    ).rows[0];
    if (
      !row ||
      row.owner_id !== owner ||
      !row.source_epoch ||
      !row.owner_epoch ||
      digest(row.package) !== row.checksum
    )
      return [];
    const authority: unknown[] = [
      source.id,
      row.checksum,
      row.audience,
      row.source_epoch,
      row.owner_epoch,
    ];
    let fields = releasedPlayableFields(row.package);
    // Reuse human title metadata from an actual release only. Older pinned
    // packages did not include those variants, so bind the exact frozen source
    // revision/language/text before accepting a current released title variant.
    const frozenSource = object(object(row.package)?.source),
      released = object(row.audience === 'review' ? row.published_snapshot : row.private_snapshot);
    if (
      frozenSource &&
      released &&
      Number.isSafeInteger(frozenSource.sourceRevision) &&
      Number(frozenSource.sourceRevision) > 0 &&
      released.sourceRevision === frozenSource.sourceRevision &&
      released.title === frozenSource.title &&
      locale(frozenSource.sourceLanguage) &&
      released.sourceLanguage === frozenSource.sourceLanguage
    ) {
      const translations = object(released.translations);
      const variants = curated(
        Object.fromEntries(
          ['ru', 'uk', 'en'].flatMap((locale) => {
            const entry = object(translations?.[locale]);
            return entry && entry.sourceRevision === frozenSource.sourceRevision
              ? [[locale, entry.title]]
              : [];
          }),
        ),
        120,
      );
      if (variants)
        fields = fields.map((field) =>
          field.path === 'title' && field.text === frozenSource.title
            ? { ...field, curated: { ...variants, ...field.curated } }
            : field,
        );
    }
    const erasureUserIds = [String(owner)];
    if (access.kind === 'viewer') {
      await c.query(
        'SELECT id FROM adventure_invitations WHERE adventure_id=$1 AND recipient_id=$2 ORDER BY id FOR SHARE NOWAIT',
        [row.adventure_id, access.userId],
      );
      const view = (
        await c.query(
          `SELECT c.state,s.state AS snapshot_state,s.checksum,m.actor_id,
          c.owner_id,c.translation_epoch AS campaign_epoch,m.translation_epoch AS member_epoch,
          u.translation_epoch AS viewer_epoch,owner.translation_epoch AS campaign_owner_epoch,
          (SELECT i.translation_epoch FROM adventure_invitations i WHERE i.adventure_id=$4 AND i.recipient_id=$2) AS invitation_epoch
         FROM game_campaigns c JOIN game_snapshots s ON s.campaign_id=c.id
         JOIN game_members m ON m.campaign_id=c.id AND m.user_id=$2
         JOIN users u ON u.id=m.user_id JOIN users owner ON owner.id=c.owner_id
         WHERE c.id=$1 AND c.source_version_id=$3 AND c.status='active' AND m.status='accepted'
         AND u.deleted_at IS NULL AND owner.deleted_at IS NULL AND ${sourceAccessSql('$2')}
         FOR SHARE OF c,s,m NOWAIT`,
          [access.campaignId, access.userId, source.id, row.adventure_id],
        )
      ).rows[0];
      if (
        !view ||
        view.owner_id !== campaignOwner ||
        !view.member_epoch ||
        !view.campaign_epoch ||
        !view.viewer_epoch ||
        !view.campaign_owner_epoch ||
        digest(view.state) !== view.checksum ||
        digest(view.snapshot_state) !== view.checksum
      )
        return [];
      const state = view.state as GameState;
      if (state.entities?.[view.actor_id]?.kind !== 'player') return [];
      const visible = playableDescriptionProjection(
        `/game/campaigns/${access.campaignId}/snapshot`,
        {
          campaign: {
            playableVersionId: source.id,
            title: object(row.package.compiled)?.title ?? object(row.package.source)?.title,
          },
          projection: projectState(state, view.actor_id),
        },
        'en',
        access.userId,
      ).fields;
      const current = new Set(
        visible.map((field) => digest([field.path, field.text, field.maxLength])),
      );
      fields = fields.filter((field) =>
        current.has(digest([field.path, field.text, field.maxLength])),
      );
      authority.push(
        view.actor_id,
        view.campaign_epoch,
        view.member_epoch,
        view.viewer_epoch,
        view.campaign_owner_epoch,
        view.invitation_epoch ?? null,
      );
      erasureUserIds.push(String(access.userId), String(campaignOwner));
    }
    if (!fields.length) return [];
    return [
      {
        source,
        partition,
        authority: digest(authority),
        erasureUserIds: [...new Set(erasureUserIds)].sort(),
        fields: fields.map((field) => ({
          ...field,
          // Same immutable authored field across releases, never equal text alone.
          // The source/version and current viewer ACL remain the admission fence.
          artifactIdentity: digest(['released-story-field', row.adventure_id, owner, field.path]),
          cachePartition: row.audience === 'review' ? 'released:public' : 'released:private',
        })),
      },
    ];
  }
}
