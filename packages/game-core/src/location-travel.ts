import {
  mapPresentationLabels,
  presentationAliasReferencesValid,
  type PresentationAliases,
} from './presentation-aliases';
import { groundedArrivalArea } from './grounded-arrival';
import { enterScene, copyEntityPlacement } from './scene-presence';
import {
  footprintIntersectsArea,
  isActorConscious,
  type GameEntity,
  type GameResult,
  type GameState,
} from '@dreamwalk/contracts';
import { visible, walkable } from './index';

export const normalizeLocationName = (value: string) =>
  value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[«»“”"']/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();

/** Public destination names only. Never send remote entities, stock, exits or NPC memory. */
export function travelLocations(state: GameState) {
  return Object.values(state.maps)
    .map((map) => ({
      id: map.id,
      label: map.label ?? map.id,
      ...(map.labelTranslations ? { labelTranslations: { ...map.labelTranslations } } : {}),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Recognize a deliberate departure in an RP attempt, not speech, a question or a hypothetical. */
export function requestedLocation(text: string): string | null {
  if (text.length > 1000) return null;
  const match = text
    .trim()
    .match(
      /^(?:(?:я|он|она|парень|девушка|герой|героиня|хлопець|дівчина|геройка|він|вона|i|he|she|the boy|the girl|my character)\s+)?(?:(?:решил[аи]?|вирішив|вирішила|decided to)\s+)?(?:пойти|идти|иду|идёт|идет|пош[её]л|пошла|отправиться|отправился|отправилась|перейти|переш[её]л|перешла|піти|йду|йде|пішов|пішла|вирушити|вирушив|вирушила|перейти|go|goes|went|walk|walks|walked|travel|travels|traveled|head|heads|headed)\s+(?:в|во|на|до|to|into)\s+(.+?)\s*[.!…]*$/iu,
    );
  if (!match) return null;
  const quoted = /^(?:«[^»]+»|“[^”]+”|"[^"]+")$/u.test(match[1].trim());
  if (
    !quoted &&
    /[?？]|(?:^|\s)(?:не|нет|если|якщо|ні|not|never|don't|doesn't|didn't|would|could|might|if)(?:\s|$)/iu.test(
      match[1],
    )
  )
    return null;
  const name = match[1]
    .trim()
    .replace(/^[«“"]|[»”"]$/gu, '')
    .trim();
  if (name.length < 2 || name.length > 120 || /[\p{Cc}\p{Cf}<>;\n]/u.test(name)) return null;
  // Multi-action prose is left to coauthoring rather than silently guessing a destination.
  if (!quoted && /\s(?:и|та|and|затем|потом|then)\s/iu.test(name)) return null;
  return name;
}

// Conservative inflection matching for already-authored RU/UK names. Exact labels win;
// multiple matching places are clarified rather than guessed or duplicated at a cost.
const inflectedLocationName = (value: string) =>
  normalizeLocationName(value)
    .split(' ')
    .map((word) => {
      if (!/^[а-яёіїєґ]+$/u.test(word) || word.length < 4) return word;
      return word.replace(
        /(?:ого|ому|ыми|ими|ая|яя|ую|юю|ой|ей|ий|ый|ою|ею|ые|ие|их|ых|ом|ем|а|я|у|ю|е|і|и|ы)$/u,
        '',
      );
    })
    .join(' ');
export function resolveTravelRequest(
  state: GameState,
  text: string,
  presentationAliases?: PresentationAliases,
) {
  const destinationName = requestedLocation(text);
  if (!destinationName) return null;
  return resolveTravelDestination(state, destinationName, presentationAliases);
}

/** A model-derived name uses the same public catalog and ambiguity rules as the free parser. */
export function resolveTravelDestination(
  state: GameState,
  destinationName: string,
  presentationAliases?: PresentationAliases,
) {
  if (
    presentationAliases &&
    !presentationAliasReferencesValid(
      state,
      presentationAliases.actorId,
      destinationName,
      presentationAliases,
    )
  )
    return { destinationName, mapId: null, ambiguous: true };
  const locations = travelLocations(state);
  const names = (map: (typeof locations)[number]) =>
    mapPresentationLabels(state, map.id, presentationAliases);
  const exact = locations.filter((map) =>
    names(map).some(
      (name) => normalizeLocationName(name) === normalizeLocationName(destinationName),
    ),
  );
  const matches = exact.length
    ? exact
    : locations.filter((map) =>
        names(map).some(
          (name) => inflectedLocationName(name) === inflectedLocationName(destinationName),
        ),
      );
  return {
    destinationName,
    mapId: matches.length === 1 ? matches[0].id : null,
    ambiguous: matches.length > 1,
  };
}

/** A scene cut, not movement through a route. Only the actor and consenting present companions travel. */
export function travelToLocation(state: GameState, actorId: string, mapId: string): GameResult {
  const reject = (error: GameResult['error']): GameResult => ({ state, events: [], error });
  const actor = state.entities[actorId],
    map = state.maps[mapId];
  if (actor?.kind !== 'player' || !isActorConscious(actor) || state.rulesetVersion !== 'hybrid-v3')
    return reject('FORBIDDEN');
  if (!map) return reject('TARGET_UNAVAILABLE');
  if (actor.encounterId) return reject('WRONG_MODE');
  if (actor.mapId === mapId) return { state, events: [] };
  const next = structuredClone(state),
    events: GameResult['events'] = [];
  const companions = Object.entries(state.npcBrains ?? {})
    .filter(
      ([id, brain]) =>
        brain.living?.companionship?.actorId === actorId &&
        state.entities[id]?.kind === 'npc' &&
        !state.entities[id].encounterId &&
        isActorConscious(state.entities[id]) &&
        visible(state, state.entities[id], actor),
    )
    .map(([id]) => id)
    .sort();
  if (map.spatialMode === 'location_only') {
    for (const id of [actorId, ...companions]) {
      const entity = next.entities[id];
      if (!enterScene(next, entity, mapId)) return reject('TARGET_UNAVAILABLE');
      entity.revision++;
      entity.movementGeneration = (entity.movementGeneration ?? 0) + 1;
      const agreement = next.npcBrains?.[id]?.living?.companionship;
      if (agreement) agreement.crossings = [];
      events.push({ kind: 'actor.transitioned', actorId: id, mapId });
    }
    next.revision++;
    return { state: next, events };
  }
  const admission = groundedArrivalArea(state, mapId);
  if (!admission.valid) return reject('TARGET_UNAVAILABLE');
  const points = [...map.spawns];
  for (let y = 0; y < map.height; y++) for (let x = 0; x < map.width; x++) points.push({ x, y });
  const safe = (entity: GameEntity, point: { x: number; y: number }) =>
    admission.allows(entity, point) &&
    walkable(next, mapId, point, entity.id, true) &&
    !Object.values(next.encounters).some(
      (encounter) =>
        encounter.phase === 'planning' &&
        encounter.mapId === mapId &&
        footprintIntersectsArea({ ...entity, ...point, spatialMode: undefined }, encounter.area),
    );
  for (const id of [actorId, ...companions]) {
    const entity = next.entities[id];
    const point = points.find((candidate) => safe(entity, candidate));
    if (!point) {
      if (id === actorId) return reject('PATH_BLOCKED');
      continue; // A companion without room stays behind. Never overlap or move another actor.
    }
    for (const sourceMap of Object.values(next.maps))
      for (const scene of sourceMap.scenePresence?.scenes ?? [])
        if (scene.participantIds.includes(id)) {
          scene.participantIds = scene.participantIds.filter((member) => member !== id);
          sourceMap.revision++;
        }
    const record = entity as unknown as Record<string, unknown>;
    delete record.spatialMode;
    delete record.sceneId;
    Object.assign(entity, point, {
      mapId,
      path: [],
      movementGeneration: (entity.movementGeneration ?? 0) + 1,
      revision: entity.revision + 1,
    });
    delete entity.movementTrace;
    for (const itemId of entity.inventory ?? [])
      if (next.entities[itemId]) copyEntityPlacement(next.entities[itemId], entity);
    const agreement = next.npcBrains?.[id]?.living?.companionship;
    if (agreement) agreement.crossings = [];
    events.push({ kind: 'actor.transitioned', actorId: id, mapId });
  }
  next.revision++;
  return { state: next, events };
}
