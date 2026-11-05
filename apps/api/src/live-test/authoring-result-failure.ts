/** Public failure categories only. Never return raw provider/source/database details. */
const validationCodes = new Set([
  'MAP_GRID_REQUIRED',
  'MAP_IMAGE_PRESENCE_UNSUPPORTED',
  'MAP_IMAGE_LOCAL_EVIDENCE_REQUIRED',
  'MAP_IMAGE_LOCAL_EVIDENCE_CONFLICT',
  'STORY_MAP_INTENT_MISMATCH',
  'STORY_SOURCE_MISMATCH',
  'STORY_CONNECTION_INVALID',
  'STORY_DISCONNECTED',
  'STORY_UNRESOLVED_PRESENCE_INVALID',
  'STORY_SCENE_PRESENCE_INVALID',
  'STORY_SCENE_ENTRY_INVALID',
  'STORY_SCENE_PRESENCE_EVIDENCE_REQUIRED',
  'STORY_POSITION_REQUIRED',
  'MAP_IMAGE_UNCERTAIN',
  'MAP_IMAGE_UNSAFE_SPAWN',
  'MAP_IMAGE_UNSAFE_NPC',
  'MAP_IMAGE_DISCONNECTED_SPAWN',
  'MAP_IMAGE_UNSAFE_PASSAGE',
  'MAP_IMAGE_SOURCE_MISMATCH',
  'MAP_IMAGE_DUPLICATE_GEOMETRY',
]);
export function authoringResultFailureCode(
  error: unknown,
  phase: 'fence' | 'validate' | 'apply' = 'fence',
): string {
  if (error instanceof Error) {
    if (validationCodes.has(error.message)) return error.message;
    if (error.message.startsWith('INVALID_MAP:')) return 'STORY_MAP_INVALID';
  }
  // A compiler/commit error is not evidence that the user's source became stale.
  if (phase === 'validate') return 'AUTHORING_PROPOSAL_INVALID';
  return phase === 'apply' ? 'AUTHORING_APPLY_FAILED' : 'AUTHORING_STALE';
}
