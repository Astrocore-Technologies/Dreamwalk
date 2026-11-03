import type { Locale } from '@dreamwalk/contracts';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : undefined;
const items = (value: unknown) => (Array.isArray(value) ? value : []);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
export interface TranslationScope {
  kind: 'adventure' | 'campaign';
  id: string;
  viewerId: string | null;
}
export interface VisibleText {
  scope: TranslationScope;
  source: string;
  revision: string;
  maxLength: number;
  apply: (translation: string) => void;
}

/** Called ONLY after a controller has built its authorized, spoiler-safe DTO.
 * Explicit paths, not recursive key matching: credentials, source lore, hidden
 * NPC facts, proposals, prices, hashes and user profiles can never become input.
 * Draft/Studio and mutation payloads are never translated.
 */
export function translationProjection<T>(
  path: string,
  original: T,
  locale: Locale,
  viewerId: string | null,
) {
  const value = structuredClone(original);
  const fields: VisibleText[] = [];
  function add(
    scope: TranslationScope,
    object: unknown,
    key: string,
    maxLength: number,
    revision = '',
  ) {
    const target = record(object);
    const source = target?.[key];
    if (!target || typeof source !== 'string' || !source.trim() || source.length > maxLength)
      return;
    fields.push({
      scope,
      source,
      maxLength,
      revision,
      apply: (text) => {
        target[key] = text;
      },
    });
  }
  function label(scope: TranslationScope, object: unknown) {
    const target = record(object);
    if (!target || record(target.labelTranslations)?.[locale]) return;
    const source = target.label;
    if (typeof source !== 'string' || !source.trim() || source.length > 120) return;
    fields.push({
      scope,
      source,
      maxLength: 120,
      revision: '',
      apply: (text) => {
        target.labelTranslations = { ...record(target.labelTranslations), [locale]: text };
      },
    });
  }
  function adventure(object: unknown) {
    const target = record(object);
    if (
      !target ||
      !uuid(target.id) ||
      target.sourceLanguage === locale ||
      target.status !== 'published' ||
      target.editRevision !== undefined ||
      target.access === 'owner' ||
      target.access === 'reviewer'
    )
      return;
    const scope: TranslationScope = { kind: 'adventure', id: target.id, viewerId };
    const sourceRevision = Number(target.sourceRevision ?? 1);
    const current = record(record(target.translations)?.[locale]);
    const revision = `${target.sourceLanguage ?? 'ru'}:${sourceRevision}`;
    for (const [key, maxLength] of [
      ['title', 120],
      ['synopsis', 4000],
    ] as const) {
      if (
        current?.sourceRevision === sourceRevision &&
        typeof current[key] === 'string' &&
        current[key]
      )
        continue;
      const source = target[key];
      if (typeof source !== 'string' || !source.trim() || source.length > maxLength) continue;
      fields.push({
        scope,
        source,
        maxLength,
        revision,
        apply: (text) => {
          const translations = record(target.translations) ?? {};
          const existing = record(translations[locale]);
          target.translations = {
            ...translations,
            [locale]: {
              ...(existing?.sourceRevision === sourceRevision ? existing : {}),
              sourceRevision,
              [key]: text,
            },
          };
        },
      });
    }
  }
  if (path === '/adventures') items(value).forEach(adventure);
  else if (/^\/adventures\/[^/]+$/.test(path)) adventure(value);
  else if (/^\/creators\/[^/]+$/.test(path)) items(record(value)?.adventures).forEach(adventure);
  else if (path === '/library') {
    // Do not replace the author's editable drafts, even inside a mixed library response.
    for (const key of ['favorites', 'shared', 'privatePublished'])
      items(record(value)?.[key]).forEach(adventure);
  }
  const campaign = path.match(
    /^\/game\/campaigns\/([0-9a-f-]{36})\/(snapshot|turns\/feed|narrative)$/i,
  );
  if (campaign && viewerId) {
    const scope: TranslationScope = { kind: 'campaign', id: campaign[1], viewerId };
    const root = record(value);
    if (campaign[2] === 'snapshot') {
      add(scope, root?.campaign, 'title', 120);
      const projection = record(root?.projection);
      const map = record(projection?.map);
      label(scope, map);
      add(scope, map, 'description', 6000);
      items(map?.exits).forEach((exit) => label(scope, exit));
      for (const entity of [...items(projection?.entities), ...items(projection?.inventory)]) {
        const visible = record(entity);
        // Player identity stays exactly as entered, never transliterated by a model.
        if (visible?.kind !== 'player') label(scope, entity);
        for (const [key, limit] of [
          ['role', 120],
          ['description', 4000],
          ['appearance', 4000],
        ] as const)
          add(scope, visible?.publicProfile, key, limit);
        for (const [key, limit] of [
          ['roleLabel', 120],
          ['description', 1000],
          ['appearance', 500],
          ['personalitySummary', 500],
        ] as const)
          add(scope, visible?.supportingNpc, key, limit);
        add(scope, visible?.item, 'label', 120);
        add(scope, visible?.item, 'description', 1000);
      }
      for (const utterance of items(projection?.npcUtterances)) add(scope, utterance, 'text', 1000);
      for (const topic of items(projection?.npcFactTopics)) add(scope, topic, 'title', 120);
      for (const objective of items(projection?.objectives)) {
        const visible = record(objective);
        if (record(visible?.translations)?.[locale]) continue;
        add(scope, visible, 'title', 120);
        add(scope, visible, 'description', 1000);
        // Only an already-revealed epilogue can enter this read projection.
        if (visible?.status === 'achieved') add(scope, visible, 'epilogue', 2000);
      }
      for (const turn of items(record(projection?.narrative)?.turns))
        add(scope, turn, 'narration', 2000);
    } else if (campaign[2] === 'turns/feed') {
      for (const entry of items(root?.entries)) {
        add(scope, entry, 'text', 2000);
        if (record(entry)?.kind === 'npc_reply') add(scope, entry, 'authorLabel', 120);
      }
      // Input receipts and unconfirmed action previews remain original evidence.
    } else {
      for (const turn of items(root?.turns)) {
        if (record(turn)?.status === 'committed') add(scope, turn, 'narration', 2000);
      }
    }
  }
  return { value, fields };
}
