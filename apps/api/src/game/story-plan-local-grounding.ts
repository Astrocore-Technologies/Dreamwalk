import { type MapSpatialGrounding } from '@dreamwalk/contracts';

type Point = { x: number; y: number };
const key = (p: Point) => `${p.x},${p.y}`;

/** A second, independently scoped observation in the SAME quoted image response.
 * Never upgrade primary confidence or turn unknown pixels into inferred terrain. */
export function selectLocalGrounding(
  primary: MapSpatialGrounding,
  local: MapSpatialGrounding,
): MapSpatialGrounding {
  if (
    local.imageRevisionId !== primary.imageRevisionId ||
    local.imageSha256 !== primary.imageSha256
  )
    throw Error('MAP_IMAGE_SOURCE_MISMATCH');
  if (local.confidence < 0.85) throw Error('MAP_IMAGE_LOCAL_EVIDENCE_REQUIRED');
  let classified = 0;
  for (let y = 0; y < 24; y++)
    for (let x = 0; x < 24; x++) {
      const cell = local.rows[y][x];
      if (cell === '?') continue;
      classified++;
      // Unobserved/transparent water cannot prove separation between local islands.
      if (cell === '~' || (primary.rows[y][x] !== '?' && primary.rows[y][x] !== cell))
        throw Error('MAP_IMAGE_LOCAL_EVIDENCE_CONFLICT');
    }
  if (classified > 96 || !local.landmarks.some((l) => l.kind === 'room' || l.kind === 'path'))
    throw Error('MAP_IMAGE_LOCAL_EVIDENCE_REQUIRED');
  return local;
}

/** Recovery cannot turn an unplaced/offstage source NPC into an opening encounter.
 * Components are observations, not collision: ordinary RP movement stays unchanged. */
export function assertLocalGroundingPresence(
  grounding: MapSpatialGrounding,
  locationId: string,
  spawns: Point[],
  npcs: { sourceNpcId: string; x?: number; y?: number }[],
  scenes: { id: string; locationId: string; participantNpcIds?: string[] }[],
  startSceneId: string,
  passages: Point[],
) {
  const components = new Map<string, number>();
  let count = 0;
  for (let y = 0; y < 24; y++)
    for (let x = 0; x < 24; x++) {
      if (components.has(`${x},${y}`) || !'.D'.includes(grounding.rows[y][x])) continue;
      const queue = [{ x, y }];
      const component = count++;
      for (let i = 0; i < queue.length; i++) {
        const p = queue[i];
        if (components.has(key(p))) continue;
        components.set(key(p), component);
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const next = { x: p.x + dx, y: p.y + dy };
          if ('.D'.includes(grounding.rows[next.y]?.[next.x] ?? '?') && !components.has(key(next)))
            queue.push(next);
        }
      }
    }
  const opening = components.get(key(spawns[0]));
  if (
    !grounding.landmarks.some(
      (l) =>
        (l.kind === 'room' || l.kind === 'path') &&
        spawns.some((p) => p.x >= l.x && p.x < l.x + l.width && p.y >= l.y && p.y < l.y + l.height),
    )
  )
    throw Error('MAP_IMAGE_LOCAL_EVIDENCE_REQUIRED');
  const entry = scenes.find((s) => s.id === startSceneId && s.locationId === locationId);
  if (passages.some((p) => components.get(key(p)) !== opening))
    throw Error('MAP_IMAGE_UNSAFE_PASSAGE');
  for (const [index, npc] of npcs.entries()) {
    if (npc.x === undefined || npc.y === undefined) throw Error('MAP_IMAGE_UNSAFE_NPC');
    const component = components.get(key({ x: npc.x, y: npc.y }));
    if (
      component === undefined ||
      (component === opening) !== !!entry?.participantNpcIds?.includes(npc.sourceNpcId)
    )
      throw Error('MAP_IMAGE_PRESENCE_UNSUPPORTED');
    for (const other of npcs.slice(0, index)) {
      if (component !== components.get(key({ x: other.x!, y: other.y! }))) continue;
      if (
        !scenes.some(
          (s) =>
            s.locationId === locationId &&
            s.participantNpcIds?.includes(npc.sourceNpcId) &&
            s.participantNpcIds.includes(other.sourceNpcId),
        )
      )
        throw Error('MAP_IMAGE_PRESENCE_UNSUPPORTED');
    }
  }
}
