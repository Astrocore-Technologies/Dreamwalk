import { createHash } from 'node:crypto';

type SourceScene = { id: string; locationId: string; participantNpcIds?: string[] };
type Source = { startSceneId: string; scenes: SourceScene[]; npcIds: string[] };
type Placement = { sourceNpcId: string; locationId: string; sceneId?: string };
type Presence = {
  version: 1;
  entrySceneId: string;
  scenes: {
    id: string;
    participantIds: string[];
    evidence: { kind: 'authored_scene' | 'accepted_story_plan'; reference: string };
  }[];
};

/** Model placement cannot contradict explicit author presence, in any spatial mode. */
export function assertAuthoredNpcLocations(source: Source, placements: Placement[]) {
  const opening = source.scenes.find((scene) => scene.id === source.startSceneId);
  for (const npc of placements) {
    const authored = source.scenes.filter((scene) =>
      scene.participantNpcIds?.includes(npc.sourceNpcId),
    );
    if (
      (authored.length && !authored.some((scene) => scene.locationId === npc.locationId)) ||
      (opening?.participantNpcIds?.includes(npc.sourceNpcId) &&
        opening.locationId !== npc.locationId)
    )
      throw Error('STORY_SCENE_PRESENCE_INVALID');
  }
}

/** Compile encounter permissions from author canon, never from model-generated grouping. */
export function buildStoryScenePresence(
  source: Source,
  locationId: string,
  placements: Placement[],
  proposed?: Presence,
): Presence {
  // Do not hide a foreign/duplicated identity inside a repaired model proposal.
  const claimed = proposed?.scenes.flatMap((scene) => scene.participantIds) ?? [];
  if (new Set(claimed).size !== claimed.length || claimed.some((id) => !source.npcIds.includes(id)))
    throw Error('STORY_SCENE_PRESENCE_INVALID');
  assertAuthoredNpcLocations(source, placements);
  const opening = source.scenes.find((scene) => scene.id === source.startSceneId);
  const used = new Set(source.scenes.map((scene) => scene.id));
  const generatedId = (kind: string, identity: string) => {
    const stem = `${kind}_${createHash('sha256')
      .update(locationId + ':' + identity)
      .digest('hex')
      .slice(0, 24)}`;
    let result = stem;
    for (let suffix = 1; used.has(result); suffix++) result = `${stem}_${suffix}`;
    used.add(result);
    return result;
  };
  const entrySceneId =
    opening?.locationId === locationId ? opening.id : generatedId('arrival', locationId);
  const scenes: Presence['scenes'] = [
    {
      id: entrySceneId,
      participantIds: [],
      evidence:
        opening?.locationId === locationId
          ? { kind: 'authored_scene', reference: opening.id }
          : { kind: 'accepted_story_plan', reference: locationId },
    },
  ];
  const ordered = [...placements].sort(
    (a, b) => source.npcIds.indexOf(a.sourceNpcId) - source.npcIds.indexOf(b.sourceNpcId),
  );
  for (const npc of ordered) {
    const authored = source.scenes.filter((scene) =>
      scene.participantNpcIds?.includes(npc.sourceNpcId),
    );
    const selected =
      opening?.locationId === locationId && opening.participantNpcIds?.includes(npc.sourceNpcId)
        ? opening
        : authored.find((scene) => scene.locationId === locationId);
    const sceneId = selected?.id ?? generatedId('offstage', npc.sourceNpcId);
    let scene = scenes.find((entry) => entry.id === sceneId);
    if (!scene) {
      scene = {
        id: sceneId,
        participantIds: [],
        evidence: selected
          ? { kind: 'authored_scene', reference: selected.id }
          : { kind: 'accepted_story_plan', reference: locationId },
      };
      scenes.push(scene);
    }
    scene.participantIds.push(npc.sourceNpcId);
    npc.sceneId = sceneId;
  }
  return { version: 1, entrySceneId, scenes };
}
