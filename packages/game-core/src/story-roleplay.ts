import { type GameState, type StorySegment, type StoryTurnInput } from '@dreamwalk/contracts';
import { applyNpcSpeech } from './living';
import { recordNpcEvents } from './npc';

/** An attributed attempt, never evidence that its claimed physical result happened.
 * Called at the same ordered position in previews and commit, after earlier effects. */
export function admitStoryRoleplayAttempt(
  state: GameState,
  actorId: string,
  input: StoryTurnInput,
  turnId: string,
  segment: StorySegment,
) {
  const audienceLimit =
    input.channel === 'whisper'
      ? [actorId, ...(input.targetNpcId ? [input.targetNpcId] : [])]
      : undefined;
  const applied = applyNpcSpeech(
    state,
    actorId,
    undefined,
    { channel: input.channel, text: segment.text },
    {
      identity: { turnId, segmentIndex: segment.index },
      presentationKind: 'attempt',
      suppressReply: true,
      audienceLimit,
    },
  );
  const source = applied.error ? undefined : applied.state.npcUtterances?.at(-1);
  // The existing speech identity produces one source across all witnesses/replays.
  const existing = source && state.npcUtterances?.find((entry) => entry.id === source.id);
  if (existing) return { state, events: [], source: existing, error: undefined };
  return {
    ...applied,
    state: applied.error
      ? state
      : recordNpcEvents(state, applied.state, applied.events, `turn:${turnId}:${segment.index}`)
          .state,
    source,
  };
}

/** Only earlier sources actually admitted in this branch may supplement the
 * original disclosure allowlist. Normal whole-audience filtering still applies. */
export function storyAttemptEvidenceIds(
  state: GameState,
  actorId: string,
  npcId: string,
  turnId: string,
  beforeIndex: number,
) {
  return (state.npcBrains?.[npcId]?.living?.observations ?? [])
    .filter(
      (observation) =>
        observation.kind === 'attempted' &&
        observation.confidence === 'reported' &&
        observation.actorId === actorId &&
        observation.speechIdentity?.turnId === turnId &&
        observation.speechIdentity.segmentIndex < beforeIndex,
    )
    .map((observation) => observation.id);
}
