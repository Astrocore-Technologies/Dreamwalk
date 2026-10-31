/** Conservative confirmed-erasure redaction. Preserve shared mechanics, not generated prose. */
export function redactNarrativeContent(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (const child of value) redactNarrativeContent(child);
    return value;
  }
  if (value.narrativeCanon) {
    for (const turn of value.narrativeCanon.turns ?? []) {
      turn.narration = '[Narrative text removed after account erasure]';
      turn.evidenceIds = [];
      if (turn.introducedScene) {
        turn.introducedScene.name = 'Unrecorded place';
        turn.introducedScene.description = '[Removed]';
      }
      if (turn.introducedNpc) {
        turn.introducedNpc.name = 'Resident';
        turn.introducedNpc.roleLabel = 'Supporting character';
      }
    }
  }
  if (value.narrative?.turns)
    for (const turn of value.narrative.turns)
      turn.narration = '[Narrative text removed after account erasure]';
  if (typeof value.id === 'string' && value.id.startsWith('scene-')) {
    value.label = 'Unrecorded place';
    delete value.labelTranslations;
    delete value.description;
  }
  if (typeof value.destinationMapId === 'string' && value.destinationMapId.startsWith('scene-')) {
    value.label = 'Unrecorded place';
    delete value.labelTranslations;
  }
  if (value.supportingNpc?.generated) {
    value.label = 'Resident';
    delete value.labelTranslations;
    value.supportingNpc = {
      generated: true,
      roleId: value.supportingNpc.roleId,
      roleLabel: 'Supporting character',
      description: '[Removed]',
      appearance: '[Removed]',
      personalitySummary: '[Removed]',
    };
  }
  // The narrator can paraphrase previous speech without a complete token-level
  // provenance graph. Clear derived textual memory, not just literal actor IDs.
  if (value.npcBrains) {
    for (const [id, brain] of Object.entries(value.npcBrains)) {
      const memory = brain.living;
      if (!memory) continue;
      memory.observations = [];
      memory.beliefs = [];
      memory.relationships = {};
      memory.causes = [];
      memory.processedCauses = [];
      delete memory.summary;
      memory.knowledgeRevision = (memory.knowledgeRevision ?? 0) + 1;
      memory.goal = { kind: 'patrol', revision: (memory.goal?.revision ?? 0) + 1, evidenceIds: [] };
      for (const obligation of memory.obligations ?? []) {
        obligation.evidenceIds = [];
        delete obligation.sourceUtterance;
        delete obligation.sourceUtteranceId;
      }
      brain.plan = [];
      brain.cursor = 0;
      brain.waitingForPath = false;
      brain.generation = (brain.generation ?? 0) + 1;
      const npc = value.entities?.[id];
      if (npc) {
        npc.path = [];
        npc.movementGeneration = (npc.movementGeneration ?? 0) + 1;
        npc.revision++;
      }
    }
  }
  if ('sourceUtterance' in value) delete value.sourceUtterance;
  if ('sourceUtteranceId' in value) delete value.sourceUtteranceId;
  if (value.npcUtterances) value.npcUtterances = [];
  if (value.npcNotices) value.npcNotices = [];
  if (value.npcProvenance) value.npcProvenance = { observations: [], utterances: [] };
  for (const child of Object.values(value)) redactNarrativeContent(child);
  return value;
}
