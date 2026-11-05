/** An explicit author selection, never an inference from a character's name in prose. */
export function selectSceneParticipant(
  current: readonly string[] | undefined,
  storyNpcIds: readonly string[],
  npcId: string,
  selected: boolean,
) {
  const allowed = new Set(storyNpcIds);
  const next = new Set((current ?? []).filter((id) => allowed.has(id)));
  if (selected && allowed.has(npcId)) next.add(npcId);
  if (!selected) next.delete(npcId);
  return [...next];
}
