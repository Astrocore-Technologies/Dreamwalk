import type { GameEntity, GameState, Locale } from '@dreamwalk/contracts';
import { observedVisible } from './observation-visibility';

/** Server-created evidence from authorized, ready released-label cache entries only.
 * This is a sidecar, never canonical game state or client-supplied action input.
 * GameState has no campaign identity: the caller must bind campaignId before use. */
export interface PresentationAliases {
  readonly version: 'released-label-alias-v1';
  readonly campaignId: string;
  readonly authority: string;
  readonly actorId: string;
  readonly locale: Locale;
  readonly sourceVersionId: string;
  readonly entries: readonly {
    readonly kind: 'entity' | 'map';
    readonly id: string;
    readonly sourceText: string;
    readonly text: string;
    readonly translationKey: string;
  }[];
}

const normalize = (value: string) =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[«»“”"']/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
const bounded = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  !!value.trim() &&
  value.length <= max &&
  !/[\p{Cc}\p{Cf}<>]/u.test(value);
const invalid = (): never => {
  throw new Error('INVALID_PRESENTATION_ALIASES');
};
const onlyKeys = (value: object, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const entityNames = (entity: GameEntity) =>
  [entity.id, entity.label ?? '', ...Object.values(entity.labelTranslations ?? {})].filter(Boolean);
const mapNames = (map: GameState['maps'][string]) => [
  map.id,
  map.label ?? map.id,
  ...Object.values(map.labelTranslations ?? {}),
];

/** Names never grant visibility, custody, life state, stock or mechanical authority. */
export function presentationEntityEligible(
  state: GameState,
  actorId: string,
  entity: GameEntity,
): boolean {
  const actor = state.entities[actorId];
  if (actor?.kind !== 'player' || !['npc', 'item', 'door'].includes(entity.kind)) return false;
  if (entity.ownerId)
    return (
      entity.kind === 'item' && entity.ownerId === actorId && !!actor.inventory?.includes(entity.id)
    );
  return observedVisible(state, actor, entity);
}

function currentEntryEligible(
  state: GameState,
  actorId: string,
  entry: PresentationAliases['entries'][number],
): boolean {
  if (entry.kind === 'entity') {
    const entity = state.entities[entry.id];
    return (
      !!entity &&
      entity.label === entry.sourceText &&
      presentationEntityEligible(state, actorId, entity)
    );
  }
  const map = state.maps[entry.id];
  return !!map && (map.label ?? map.id) === entry.sourceText;
}

function checkedAliases(
  state: GameState,
  actorId: string,
  evidence: unknown,
  allVisible: boolean,
  referenceText?: string,
): PresentationAliases | undefined {
  if (evidence === undefined) return undefined;
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return invalid();
  const value = evidence as PresentationAliases;
  if (
    !onlyKeys(value, [
      'version',
      'campaignId',
      'authority',
      'actorId',
      'locale',
      'sourceVersionId',
      'entries',
    ]) ||
    value.version !== 'released-label-alias-v1' ||
    !bounded(value.campaignId, 128) ||
    typeof value.authority !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.authority) ||
    !bounded(value.actorId, 128) ||
    value.actorId !== actorId ||
    state.entities[actorId]?.kind !== 'player' ||
    !['en', 'uk', 'ru'].includes(value.locale) ||
    !bounded(value.sourceVersionId, 128) ||
    (state.narrativeSource && value.sourceVersionId !== state.narrativeSource.versionId) ||
    !Array.isArray(value.entries) ||
    value.entries.length > 256
  )
    return invalid();
  const ids = new Set<string>();
  for (const entry of value.entries) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !onlyKeys(entry, ['kind', 'id', 'sourceText', 'text', 'translationKey']) ||
      !['entity', 'map'].includes(entry.kind) ||
      !bounded(entry.id, 128) ||
      !bounded(entry.sourceText, 120) ||
      !bounded(entry.text, 120) ||
      typeof entry.translationKey !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(entry.translationKey)
    )
      return invalid();
    if (
      entry.kind === 'entity' &&
      state.entities[entry.id] &&
      !['npc', 'item', 'door'].includes(state.entities[entry.id].kind)
    )
      return invalid();
    const key = `${entry.kind}:${entry.id}`;
    if (ids.has(key)) return invalid();
    ids.add(key);
  }
  const active = value.entries.filter((entry) => currentEntryEligible(state, actorId, entry));
  for (const entry of value.entries) {
    if (
      !active.includes(entry) &&
      (allVisible ||
        (referenceText !== undefined &&
          (mentionsPresentationLabel(referenceText, entry.text) ||
            mentionsPresentationLabel(referenceText, entry.sourceText))))
    )
      return invalid();
    if (!active.includes(entry)) continue;
    // Canonical names and translations share one identity namespace per kind. Reject
    // the whole sidecar rather than choosing a canonical rival or creating a duplicate.
    const canonical =
      entry.kind === 'entity'
        ? Object.values(state.entities)
            .filter(
              (entity) =>
                entity.id === actorId ||
                (entity.ownerId
                  ? entity.ownerId === actorId &&
                    !!state.entities[actorId].inventory?.includes(entity.id)
                  : observedVisible(state, state.entities[actorId], entity)),
            )
            .map((entity) => ({ id: entity.id, names: entityNames(entity) }))
        : Object.values(state.maps).map((map) => ({ id: map.id, names: mapNames(map) }));
    if (
      canonical.some(
        (other) =>
          other.id !== entry.id &&
          other.names.some((name) => normalize(name) === normalize(entry.text)),
      ) ||
      active.some(
        (other) =>
          other.kind === entry.kind &&
          other.id !== entry.id &&
          typeof other.text === 'string' &&
          normalize(other.text) === normalize(entry.text),
      )
    )
      return invalid();
  }
  return value.entries.length ? value : undefined;
}

/** Fail closed on malformed, stale, concealed, foreign-inventory or colliding evidence.
 * Optional referenceText validates only currently used visibility/label bindings;
 * the complete frozen catalog stays unchanged for deferred-stage hashing.
 * The copy is detached and deeply frozen so quote/count/apply can share exact bytes. */
export function validatePresentationAliases(
  state: GameState,
  actorId: string,
  evidence: unknown,
  referenceText?: string,
): PresentationAliases | undefined {
  const value = checkedAliases(
    state,
    actorId,
    evidence,
    referenceText === undefined,
    referenceText,
  );
  return (
    value &&
    Object.freeze({
      ...value,
      entries: Object.freeze(value.entries.map((entry) => Object.freeze({ ...entry }))),
    })
  );
}

/** Recheck current eligibility after ordered effects without refreshing the frozen catalog. */
export function entityPresentationLabels(
  state: GameState,
  actorId: string,
  entity: GameEntity,
  evidence?: PresentationAliases,
): string[] {
  const value = checkedAliases(state, actorId, evidence, false);
  const extra =
    value && presentationEntityEligible(state, actorId, entity)
      ? value.entries
          .filter(
            (entry) =>
              entry.kind === 'entity' &&
              entry.id === entity.id &&
              currentEntryEligible(state, actorId, entry),
          )
          .map((entry) => entry.text)
      : [];
  return [...entityNames(entity), ...extra];
}

export function mapPresentationLabels(
  state: GameState,
  mapId: string,
  evidence?: PresentationAliases,
): string[] {
  const map = state.maps[mapId];
  if (!map) return [];
  const value = evidence && checkedAliases(state, evidence.actorId, evidence, false);
  return [
    ...new Set([
      ...mapNames(map),
      ...(value?.entries
        .filter(
          (entry) =>
            entry.kind === 'map' &&
            entry.id === mapId &&
            currentEntryEligible(state, value.actorId, entry),
        )
        .map((entry) => entry.text) ?? []),
    ]),
  ];
}

/** Conservative capture filter only, never action authorization or input rewriting.
 * Over-inclusion preserves colliding names; ordinary Cyrillic case endings are
 * retained by their stems for the same already-supported travel/placement grammar. */
export function mentionsPresentationLabel(text: string, label: string): boolean {
  const stemmed = (value: string) =>
    normalize(value)
      .split(/[^\p{L}\p{N}_-]+/u)
      .map((word) =>
        /^[а-яёіїєґ]{4,}$/u.test(word)
          ? word.replace(
              /(?:ого|ому|ыми|ими|ої|ій|ая|яя|ую|юю|ой|ей|ий|ый|ою|ею|ые|ие|их|ых|ом|ем|а|я|у|ю|е|і|и|ы)$/u,
              '',
            )
          : word,
      )
      .join(' ');
  return (
    typeof text === 'string' &&
    typeof label === 'string' &&
    !!label.trim() &&
    (normalize(text).includes(normalize(label)) || stemmed(text).includes(stemmed(label)))
  );
}

/** A stale reference must not fall through to a canonical namesake or a paid new scene. */
export function presentationAliasReferencesValid(
  state: GameState,
  actorId: string,
  text: string,
  evidence?: PresentationAliases,
): boolean {
  try {
    checkedAliases(state, actorId, evidence, false, text);
    return true;
  } catch {
    return false;
  }
}
