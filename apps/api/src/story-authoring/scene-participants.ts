/** Preserve explicit author encounter membership when source NPC identities change.
 * Missing/removed IDs are dropped, never replaced with other roster members. */
export function remapSceneParticipants<T extends { participantNpcIds?: string[] }>(
  scenes: T[],
  identities: ReadonlyMap<string, string>,
): T[] {
  return scenes.map((scene) => ({
    ...scene,
    ...(scene.participantNpcIds
      ? {
          participantNpcIds: [
            ...new Set(
              scene.participantNpcIds.flatMap((id) =>
                identities.has(id) ? [identities.get(id)!] : [],
              ),
            ),
          ],
        }
      : {}),
  }));
}
