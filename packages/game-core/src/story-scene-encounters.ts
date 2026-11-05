import {
  isActorConscious,
  type GameState,
  type GameResult,
  type Locale,
  type StoryTurnInput,
} from '@dreamwalk/contracts';
import { enterScene, sharesScene } from './scene-presence';
import { npcContextFingerprint } from './living';
import { parseStorySegments } from './story-turn';

/** Candidates are private director input, never a public roster or proof of contact.
 * Only the trusted compiler's unresolved opening singleton can be established. */
function sceneEncounterRecords(state: GameState, actorId: string) {
  const actor = state.entities[actorId];
  if (
    actor?.kind !== 'player' ||
    actor.spatialMode !== 'location_only' ||
    !isActorConscious(actor) ||
    !sharesScene(state, actor, actor) ||
    !state.narrativeSource?.checksum
  )
    return [];
  const map = state.maps[actor.mapId];
  return Object.values(state.entities)
    .flatMap((npc) => {
      const marker = npc.unresolvedScenePresence;
      const scene = map.scenePresence?.scenes.find((entry) => entry.id === npc.sceneId);
      if (
        npc.kind !== 'npc' ||
        npc.spatialMode !== 'location_only' ||
        !isActorConscious(npc) ||
        npc.encounterId ||
        !state.npcBrains?.[npc.id]?.living ||
        !marker ||
        marker.kind !== 'unspecified_opening' ||
        marker.sourceChecksum !== state.narrativeSource!.checksum ||
        marker.sourceMapId !== actor.mapId ||
        npc.mapId !== actor.mapId ||
        marker.sourceSceneId !== npc.sceneId ||
        npc.sceneId === actor.sceneId ||
        !scene ||
        scene.participantIds.length !== 1 ||
        scene.participantIds[0] !== npc.id
      )
        return [];
      return [
        {
          npcId: npc.id,
          fingerprint: npcContextFingerprint({
            source: state.narrativeSource,
            marker,
            scene,
            mapRevision: map.revision,
            entityRevision: npc.revision,
            lifeRevision: npc.lifeRevision ?? 0,
            actorScene: actor.sceneId,
          }),
        },
      ];
    })
    .sort((a, b) => a.npcId.localeCompare(b.npcId))
    .slice(0, 8);
}

export function sceneEncounterCandidates(state: GameState, actorId: string) {
  return sceneEncounterRecords(state, actorId).map((entry) => ({
    npcId: `encounter-${entry.fingerprint}`,
    status: 'unestablished' as const,
    fingerprint: entry.fingerprint,
  }));
}

export function sceneEncounterOutcomeText(name: string, locale: Locale = 'en') {
  return {
    en: `You encounter ${name}.`,
    ru: `Вы встречаете ${name}.`,
    uk: `Ви зустрічаєте ${name}.`,
  }[locale];
}

/** Called only after an attempt was admitted and its canonical turn exists. */
export function applySceneEncounter(
  state: GameState,
  actorId: string,
  turnId: string,
  segmentIndex: number,
  candidateId: string,
  expectedFingerprint: string,
  input: StoryTurnInput,
): GameResult {
  const reject = (error: GameResult['error']): GameResult => ({ state, events: [], error });
  const turn = state.narrativeCanon?.turns.find((entry) => entry.id === turnId);
  if (!turn || turn.actorId !== actorId) return reject('FORBIDDEN');
  if (turn.sceneEncounter)
    return turn.sceneEncounter.segmentIndex === segmentIndex &&
      turn.sceneEncounter.fingerprint === expectedFingerprint &&
      turn.sceneEncounter.requestToken === candidateId
      ? { state, events: [] }
      : reject('STALE_STATE');
  const segment = parseStorySegments(input.text).segments[segmentIndex];
  if (segment?.kind !== 'attempt') return reject('FORBIDDEN');
  const candidate = sceneEncounterRecords(state, actorId).find(
    (entry) => `encounter-${entry.fingerprint}` === candidateId,
  );
  if (!candidate || candidate.fingerprint !== expectedFingerprint) return reject('STALE_STATE');
  const npcId = candidate.npcId;
  const next = structuredClone(state),
    actor = next.entities[actorId],
    npc = next.entities[npcId];
  if (!enterScene(next, npc, actor.mapId, actor.sceneId)) return reject('FORBIDDEN');
  delete npc.unresolvedScenePresence;
  npc.revision++;
  next.narrativeCanon!.turns.find((entry) => entry.id === turnId)!.sceneEncounter = {
    segmentIndex,
    npcId,
    fingerprint: expectedFingerprint,
    requestToken: candidateId,
  };
  next.narrativeCanon!.revision++;
  next.revision++;
  return {
    state: next,
    events: [
      { kind: 'narrative.npc_encountered', actorId, targetId: npcId, mapId: actor.mapId },
      { kind: 'actor.scene_entered', actorId: npcId, mapId: actor.mapId },
    ],
  };
}
