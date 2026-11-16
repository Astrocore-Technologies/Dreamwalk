/**
 * Ensemble reply: one paid request writes the lines of every character who answers the same
 * public message, so they do not mirror each other. The lead request pays; every other request
 * of the group is served from the lead's result through the existing cache settlement path
 * (reservation released, no cost). Off unless ENSEMBLE_REPLIES=true.
 */
export interface EnsembleRow {
  id: string;
  npc_id: string;
  purpose: string;
  context: Record<string, unknown>;
}
export interface EnsembleGroup {
  leadId: string;
  memberIds: string[];
}
const MAX_GROUP = 4;
/** Groups of public `say` replies to the same segment of one turn; whispers never join. */
export function planEnsembleGroups(rows: EnsembleRow[]): EnsembleGroup[] {
  const byMessage = new Map<string, EnsembleRow[]>();
  for (const row of rows) {
    const turnId = row.context.storyTurnId,
      segment = row.context.segmentIndex;
    if (
      row.purpose !== 'speech' ||
      row.context.channel !== 'say' ||
      typeof turnId !== 'string' ||
      typeof segment !== 'number'
    )
      continue;
    const key = `${turnId}:${segment}`;
    byMessage.set(key, [...(byMessage.get(key) ?? []), row]);
  }
  const groups: EnsembleGroup[] = [];
  for (const group of byMessage.values()) {
    if (group.length < 2 || group.length > MAX_GROUP) continue;
    // The lead must owe a reply: an optional one may choose silence and cannot carry the others.
    const lead = group.find((row) => row.context.responseOptional !== true);
    if (!lead) continue;
    groups.push({
      leadId: lead.id,
      memberIds: group.filter((row) => row.id !== lead.id).map((row) => row.id),
    });
  }
  return groups;
}
/** The line the lead's proposal wrote for one character, as that character's own reply. */
export function ensembleReplyFor(
  leadProposal: unknown,
  npcId: string,
): { text: string } | undefined {
  const lines = (leadProposal as { ensembleLines?: { speakerId: string; text: string }[] } | null)
    ?.ensembleLines;
  const line = Array.isArray(lines) ? lines.find((entry) => entry.speakerId === npcId) : undefined;
  return line?.text ? { text: line.text } : undefined;
}
