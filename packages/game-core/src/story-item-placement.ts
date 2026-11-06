import {
  hasPosition,
  isActorConscious,
  type GameEntity,
  type GamePoint,
  type GameState,
  type Locale,
  type StoryTurnInput,
} from '@dreamwalk/contracts';
import { itemDropCandidates } from './item-placement';
import { matchesTurnFence } from './turns';
import { npcContextFingerprint } from './living';

const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase().trim();
const words = (text: string) => normalize(text).match(/[\p{L}\p{N}_-]+/gu) ?? [];
const unquoted = (text: string) =>
  text.replace(/"[^"]*"|«[^»]*»|“[^”]*”|„[^“]*“|(?<![\p{L}])'[^']*'(?![\p{L}])/gu, ' ');
const stem = (token: string) =>
  /^[а-яіїєґё]{5,}$/u.test(token)
    ? token.replace(
        /(?:ами|ями|ого|ому|ыми|ими|ий|ый|ой|ая|яя|ое|ее|ые|ие|ій|ом|ем|а|я|у|ю|и|і|ы|е|о)$/u,
        '',
      )
    : token;
const labels = (item: GameEntity) =>
  [item.id, item.label ?? '', ...Object.values(item.labelTranslations ?? {})].filter(Boolean);
const mentions = (text: string, names: string[]) => {
  const tokens = ` ${words(text).map(stem).join(' ')} `;
  return names.some((name) => {
    const phrase = words(name).map(stem).join(' ');
    return phrase.length > 1 && tokens.includes(` ${phrase} `);
  });
};

/** These vetoes are a conservative backstop, not a positive verb grammar. The
 * director still interprets arbitrary current player attempts semantically. */
function directClause(state: GameState, actorId: string, raw: string, aliases: string[]) {
  const clause = raw.trim();
  if (
    /^(?:(?:i|я)\s+)?(?:if|unless|would|could|might|если|якщо|вчера|учора|yesterday)(?=$|[^\p{L}])/u.test(
      clause,
    )
  )
    return false;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const object = aliases
    .map((alias) =>
      words(alias)
        .map((token) =>
          /^[а-яіїєґё]+$/u.test(token) ? `${escape(stem(token))}[а-яіїєґё]{0,4}` : escape(token),
        )
        .join(' '),
    )
    .join('|');
  const motion =
    'drop|put|place|set|leave|lower|release|throw|кладу|класть|полож[а-яё]*|остав[а-яё]*|опуска[а-яё]*|брос[а-яё]*|покла[а-яіїєґ]*|залиша[а-яіїєґ]*|викла[а-яіїєґ]*';
  // Negation must bind locally to this object, not an unrelated manner adjunct
  // or a second carried prop. Positive intent remains the director's decision.
  if (
    new RegExp(
      `(?:^|[^\\p{L}])(?:not|never|don't|doesn't|didn't|won't|не|ні) (?:(?:буду|стану) )?(?:${motion}) (?:(?:the|a|your|my|этот|цей|свой|свій) ){0,2}(?:${object})(?=$|[^\\p{L}])`,
      'u',
    ).test(clause)
  )
    return false;
  if (/^(?:he|she|they|он|она|они|він|вона|вони)(?=$|[^\p{L}])/u.test(clause)) return false;
  if (
    /^(?:(?:i|я)\s+)?(?:(?:quietly|молча|тихо)\s+)?(?:say|says|said|tell|tells|told|quote|remember|recall|imagine|watch|ask|order|говорю|сказал|сказала|сказать|прошу|приказываю|вспоминаю|представляю|наблюдаю|кажу|сказав|наказую|згадую|уявляю|спостерігаю)(?=$|[^\p{L}])/u.test(
      clause,
    )
  )
    return false;
  if (/(?:^|[^\p{L}])(?:yesterday|вчера|учора)(?=$|[^\p{L}])/u.test(clause)) return false;
  return !Object.values(state.entities).some(
    (other) =>
      other.id !== actorId &&
      ['npc', 'player'].includes(other.kind) &&
      labels(other).some((name) => {
        const prefix = words(name).map(stem).join(' ');
        return prefix && words(clause).map(stem).join(' ').startsWith(`${prefix} `);
      }),
  );
}

function directAttempt(state: GameState, actorId: string, text: string, aliases: string[]) {
  const clauses = normalize(unquoted(text)).split(
    /[.!?;]+|\s+(?:and\s+(?:i\s+)?(?=say\b|tell\b)|и\s+(?=говорю\b)|та\s+(?=кажу\b))/u,
  );
  let previousReference = false;
  return clauses.some((raw) => {
    const clause = raw.trim();
    const referenced = mentions(clause, aliases);
    const pronoun =
      previousReference && /(?:^|[^\p{L}])(?:it|его|её|ее|його|її)(?=$|[^\p{L}])/u.test(clause);
    previousReference = referenced;
    return (
      (referenced || pronoun) &&
      directClause(state, actorId, clause, aliases) &&
      !inconsistentStoryPlacementNarration(clause, [
        { id: 'reference', label: undefined, labels: aliases, revision: 0, points: [] },
      ])
    );
  });
}

/** Named, existing carried objects only; never an inventory catalog or NPC evidence.
 * The staged turn view mirrors applyStoryOrderedAction without changing the state. */
export function storyItemPlacementContext(
  state: GameState,
  actorId: string,
  text: string,
  input: StoryTurnInput,
) {
  const actor = state.entities[actorId];
  const map = actor && state.maps[actor.mapId];
  let placementState = state;
  const turn = state.turnController;
  if (
    turn?.phase === 'world' &&
    !turn.pendingResolution &&
    input.turnFence &&
    matchesTurnFence(state, input.turnFence) &&
    turn.actorOrder.includes(actorId)
  ) {
    placementState = {
      ...state,
      turnController: { ...turn, phase: 'player', activeActorId: actorId },
    };
  }
  const owned = [...new Set(actor?.inventory ?? [])].sort().flatMap((id) => {
    const item = state.entities[id];
    return item?.kind === 'item' && item.ownerId === actorId ? [item] : [];
  });
  const items =
    actor?.kind === 'player' && isActorConscious(actor) && hasPosition(actor)
      ? owned
          .flatMap((item) => {
            const unique = (noun: string) =>
              !owned.some(
                (other) =>
                  other.id !== item.id &&
                  labels(other).some((label) => stem(words(label).at(-1) ?? '') === stem(noun)),
              );
            const aliases = labels(item).filter(
              (label) =>
                !owned.some(
                  (other) =>
                    other.id !== item.id &&
                    labels(other).some(
                      (otherLabel) =>
                        words(otherLabel).map(stem).join(' ') === words(label).map(stem).join(' '),
                    ),
                ) &&
                (words(label).length > 1 || unique(label)),
            );
            for (const label of labels(item)) {
              const noun = words(label).at(-1);
              if (noun && noun.length >= 3 && unique(noun)) aliases.push(noun);
            }
            if (!mentions(unquoted(text), aliases)) return [];
            return [
              {
                id: item.id,
                label: item.label,
                labels: [...new Set(aliases)],
                revision: item.revision,
                points: directAttempt(state, actorId, text, aliases)
                  ? itemDropCandidates(placementState, actorId, item.id).slice(0, 16)
                  : [],
              },
            ];
          })
          .slice(0, 8)
      : [];
  return {
    items,
    readset: {
      actorRevision: actor?.revision ?? null,
      mapId: map?.id ?? null,
      mapRevision: map?.revision ?? null,
      image: map?.locationImage ?? null,
      imageBinding:
        state.artBindings
          ?.filter((binding) => binding.slot === `map:${map?.id}:background`)
          .map((binding) => ({ revisionId: binding.revisionId, sha256: binding.sha256 })) ?? [],
      groundingImage: map?.spatialGrounding
        ? {
            revisionId: map.spatialGrounding.imageRevisionId,
            sha256: map.spatialGrounding.imageSha256,
          }
        : null,
      // The hash binds all collision/footprint/grounding data without exposing
      // unrelated hidden geometry or private entity attributes to the director.
      geometryHash: npcContextFingerprint({
        map: map
          ? {
              width: map.width,
              height: map.height,
              blocked: map.blocked,
              exits: map.exits,
              grounding: map.spatialGrounding,
              composition: map.composition,
            }
          : null,
        occupants: Object.values(state.entities)
          .filter((entity) => entity.mapId === actor?.mapId)
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((entity) => ({
            id: entity.id,
            kind: entity.kind,
            mapId: entity.mapId,
            spatialMode: entity.spatialMode,
            x: entity.x,
            y: entity.y,
            ownerId: entity.ownerId,
            tokenSize: entity.tokenSize,
            open: entity.open,
            surfaceSlot: entity.item?.surfaceSlot,
          })),
      }),
    },
  };
}

type ReferencedPlacementItem = {
  id: string;
  label?: string;
  labels: string[];
  revision: number;
  points: GamePoint[];
};

/** Narrow literal outcome check. Ordinary untracked RP is intentionally untouched.
 * Free prose cannot prove arbitrary semantic consistency; the typed effect is the
 * authority for custody/position, never the generated narration. */
export function claimedStoryItemPlacements(narration: string, items: ReferencedPlacementItem[]) {
  const claims = new Set<string>();
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const destination =
    '(?:(?:on|onto|to|upon|at) (?:the |your |my )?(?:ground|floor|feet)|(?:beside|next to) (?:you|me|him|her)|(?:на|до|к|біля|у|под|під) (?:земл[еяюі]|пол[ауі]?|підло[гз][а-яіїєґ]*|ног[аи]?|дол[уі])|рядом|поруч)';
  const motion =
    'drop(?:s|ped)?|plac(?:e[sd]?|ing)|set|sets|put|puts|lay|lays|laid|lower(?:s|ed)?|release[sd]?|leav(?:e[sd]?|ing)|остав[а-яё]*|клад[а-яё]*|полож[а-яё]*|опус[а-яё]*|урон[а-яё]*|покла[а-яіїєґ]*|опуска[а-яіїєґ]*|залиша[а-яіїєґ]*';
  const stateVerb =
    'is|are|was|were|rest(?:s|ed)?|land(?:s|ed)?|settl(?:e[sd]?|ing)|lies|lying|леж[а-яёіїєґ]*|пада[а-яёіїєґ]*|упа[а-яё]*';
  const manner =
    'the|a|your|my|his|her|carefully|gently|quietly|softly|down|right|now|still|already|затем|теперь|тепер|мягко|осторожно|бережно|обережно|тихо|вже';
  let previous: string | undefined;
  for (const raw of normalize(narration).split(/[.!?;\n]+/u)) {
    const clause = words(unquoted(raw)).join(' ');
    if (
      /(?:^| )(?:not|never|no|if|would|could|might|не|нет|ні|если|якщо|бы|би)(?=$| )/u.test(clause)
    ) {
      previous = undefined;
      continue;
    }
    for (const item of items) {
      const aliases = [...item.labels];
      for (const name of item.labels) {
        const noun = words(name).at(-1);
        if (
          noun &&
          noun.length >= 3 &&
          !items.some(
            (other) =>
              other.id !== item.id &&
              other.labels.some((label) => stem(words(label).at(-1) ?? '') === stem(noun)),
          )
        )
          aliases.push(noun);
      }
      const object = aliases.map((alias) =>
        words(alias)
          .map((token) =>
            /^[а-яіїєґё]+$/u.test(token) ? `${escape(stem(token))}[а-яіїєґё]{0,4}` : escape(token),
          )
          .join(' '),
      );
      if (previous === item.id) object.push('it', 'его', 'её', 'ее', 'його', 'її', 'он', 'він');
      const objectPattern = `(?:${[...new Set(object)].filter(Boolean).join('|')})`;
      // Bind the actual object locally to the predicate and destination. Looking
      // at the floor while holding a key is not placing that key on the floor.
      const active = new RegExp(
        `(?:^| )(?:${motion}) (?:(?:${manner}) ){0,3}${objectPattern} (?:(?:${manner}) ){0,3}${destination}(?=$| )`,
        'u',
      );
      const resulting = new RegExp(
        `(?:^| )${objectPattern} (?:(?:${stateVerb}|${manner}) ){0,5}${destination}(?=$| )`,
        'u',
      );
      if (active.test(clause) || resulting.test(clause)) claims.add(item.id);
    }
    const referenced = items.filter((item) => mentions(clause, item.labels));
    previous = referenced.length === 1 ? referenced[0].id : undefined;
  }
  return [...claims];
}

/** Only contradictions attached to the dropped object trigger fallback, not an
 * unrelated cup of tea on a table elsewhere in the same continuation. */
export function inconsistentStoryPlacementNarration(
  narration: string,
  items: ReferencedPlacementItem[],
) {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const manner =
    'the|a|your|my|his|her|carefully|gently|quietly|softly|down|right|now|still|already|теперь|тепер|мягко|осторожно|бережно|обережно';
  const active =
    'drop(?:s|ped)?|lower(?:s|ed)?|release[sd]?|put|puts|place[sd]?|set|sets|leave[sd]?|keep|keeps|kept|throw[sn]?|toss(?:es|ed)?|клад[а-яё]*|полож[а-яё]*|остав[а-яё]*|покла[а-яіїєґ]*|залиша[а-яіїєґ]*';
  const state =
    'is|are|was|were|rest[sd]?|remains?|stays?|lies|lying|леж[а-яёіїєґ]*|оста[а-яё]*|залиша[а-яіїєґ]*';
  const destination =
    '(?:(?:on|onto|into|under|across) (?:the |a )?(?:table|shelf|counter|chest|drawer|river)|(?:на|под|під|у|в) (?:стол|стіл|полиц|полк|стільниц|рек|річк)[а-яёіїєґ]*|in (?:your |my |his |her |the )?(?:pocket|inventory|hand)|(?:в|у) (?:карман|инвентар|рук|кишен|інвентар)[а-яёіїєґ]*)';
  let previous: string | undefined;
  for (const raw of normalize(narration).split(/[.!?;\n]+/u)) {
    const clause = words(unquoted(raw)).join(' ');
    for (const item of items) {
      const object = item.labels.map((alias) =>
        words(alias)
          .map((token) =>
            /^[а-яіїєґё]+$/u.test(token) ? `${escape(stem(token))}[а-яіїєґё]{0,4}` : escape(token),
          )
          .join(' '),
      );
      if (previous === item.id) object.push('it', 'его', 'её', 'ее', 'його', 'її', 'он', 'він');
      const pattern = `(?:${[...new Set(object)].filter(Boolean).join('|')})`;
      if (
        new RegExp(
          `(?:^| )(?:${active}) (?:(?:${manner}) ){0,3}${pattern} (?:(?:${manner}) ){0,3}${destination}(?=$| )`,
          'u',
        ).test(clause) ||
        new RegExp(
          `(?:^| )${pattern} (?:(?:${state}|${manner}) ){0,5}${destination}(?=$| )`,
          'u',
        ).test(clause) ||
        new RegExp(
          `(?:^| )${pattern} (?:(?:${manner}) ){0,2}(?:flies|ricochets|strikes|hits|летит|рикошет[а-яё]*|влучає|ударяет)(?=$| )`,
          'u',
        ).test(clause)
      )
        return true;
    }
    const named = items.filter((item) => mentions(clause, item.labels));
    previous = named.length === 1 ? named[0].id : undefined;
  }
  return false;
}

export function storyItemPlacementOutcomeText(locale: Locale = 'en', count = 1) {
  if (count > 1)
    return {
      en: 'You placed the carried items on the ground.',
      ru: 'Предметы были оставлены на земле.',
      uk: 'Предмети було залишено на землі.',
    }[locale];
  return {
    en: 'You placed the carried item on the ground.',
    ru: 'Предмет был оставлен на земле.',
    uk: 'Предмет було залишено на землі.',
  }[locale];
}
