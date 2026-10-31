import {
  storyTurnInputSchema,
  storyTurnProposalSchema,
  narrativeActionSchema,
  type StoryTurnInput,
  type StorySegment,
  type StoryActionPreview,
  type StoryTurnProposal,
  type GameState,
  type GameAction,
  type GameResult,
  type StoryFeedEntry,
} from '@dreamwalk/contracts';
import { applyAction, visible, projectState } from './index';
import { recordNpcEvents } from './npc';
import { parsePlayerTextAction } from './living-reasoning';
import {
  applyNpcSpeech,
  admittedNpcSpeechObservationId,
  buildNpcPublicSpeechContext,
  commitNpcPublicUtterance,
  canNpcHear,
  npcContextFingerprint,
  publicNpcFactTopics,
  resolveNpcFactTopic,
  createMockNpcPublicResponse,
} from './living';
import {
  buildNarrativeContext,
  createMockNarrativeProposal,
  applyNarrativeProposal,
} from './narrative';
export function parseStorySegments(text: string): { segments: StorySegment[]; code?: string } {
  const segments: StorySegment[] = [];
  let buffer = '',
    attempt = false;
  const flush = () => {
    if (buffer.trim())
      segments.push({
        index: segments.length,
        kind: attempt ? 'attempt' : 'speech',
        text: buffer.trim(),
      });
    buffer = '';
  };
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && (text[i + 1] === '*' || text[i + 1] === '\\')) {
      buffer += text[++i];
      continue;
    }
    if (text[i] === '*') {
      if (attempt && !buffer.trim()) return { segments: [], code: 'INVALID_MARKUP' };
      flush();
      attempt = !attempt;
    } else buffer += text[i];
  }
  if (attempt) return { segments: [], code: 'INVALID_MARKUP' };
  flush();
  if (!segments.length) return { segments: [], code: 'INVALID_MARKUP' };
  if (segments.length > 6 || segments.filter((s) => s.kind === 'attempt').length > 2)
    return { segments: [], code: 'TOO_MANY_SEGMENTS' };
  if (
    segments.some(
      (s) =>
        s.kind === 'attempt' &&
        /\b(walk|move|approach|go|enter|run)\b|(?:^|\s)(?:иду|идти|подой|подхож|пойти|перей|перехож|бегу|двига|йду|йти|підій|підход|руха|зайти|войти)/iu.test(
          s.text,
        ),
    )
  )
    return { segments, code: 'WALK_FIRST' };
  return { segments };
}
export type StorySafeEntry = Omit<
  StoryFeedEntry,
  'id' | 'sequence' | 'createdAt' | 'turnId' | 'legacy'
> & { audienceIds: string[]; sourceId?: string };
const normalize = (s: string) =>
  s
    .trim()
    .toLocaleLowerCase()
    .replace(/[?!.,]+$/u, '');
const listeners = (s: GameState, speakerId: string) =>
  Object.values(s.entities)
    .filter((e) => ['npc', 'player'].includes(e.kind) && canNpcHear(s, e, s.entities[speakerId]))
    .map((e) => e.id)
    .sort();
function allowedAction(state: GameState, actorId: string, input: unknown): GameAction | null {
  const p = narrativeActionSchema.safeParse(input);
  if (!p.success || p.data.kind === 'transition') return null;
  const actor = state.entities[actorId];
  if (actor?.kind !== 'player') return null;
  if (p.data.targetId) {
    const target = state.entities[p.data.targetId];
    if (!target || !visible(state, actor, target)) return null;
  }
  if (p.data.itemId && !(actor.inventory ?? []).includes(p.data.itemId)) return null;
  return p.data;
}
function safeSpeech(
  state: GameState,
  actorId: string,
  npcId: string,
  channel: 'say' | 'whisper',
  segment: StorySegment,
  turnId: string,
  selectedObservationIds?: string[],
) {
  const identity = { turnId, segmentIndex: segment.index };
  const speech = { channel, text: segment.text };
  const applied = applyNpcSpeech(state, actorId, npcId, speech, { suppressReply: true, identity });
  if (applied.error) throw new Error(applied.error);
  const next = recordNpcEvents(
    state,
    applied.state,
    applied.events,
    `turn:${turnId}:${segment.index}`,
  ).state;
  const marker = admittedNpcSpeechObservationId(next, actorId, npcId, speech, identity);
  if (!marker) throw new Error('STALE_STATE');
  const audience = channel === 'whisper' ? [actorId, npcId] : listeners(next, npcId);
  const topics = publicNpcFactTopics(next, npcId).filter(
    (t) => normalize(t.title) === normalize(segment.text),
  );
  const requested = topics.length === 1 ? resolveNpcFactTopic(next, npcId, topics[0].id) : [];
  const ids =
    selectedObservationIds ??
    [
      ...new Set([
        marker,
        ...requested,
        ...(next.npcBrains?.[npcId]?.living?.observations ?? []).slice(-16).map((o) => o.id),
      ]),
    ].slice(0, 16);
  const safe = buildNpcPublicSpeechContext(next, npcId, audience, ids, requested);
  const current = safe.claims.find((c) => c.observationId === marker);
  if (!current) throw new Error('FORBIDDEN');
  return {
    state: next,
    sourceId: next.npcUtterances?.find(
      (u) => u.speakerId === actorId && !state.npcUtterances?.some((old) => old.id === u.id),
    )?.id,
    events: applied.events,
    context: {
      ...safe,
      segmentIndex: segment.index,
      replyToObservationId: marker,
      currentUtterance: current,
      observationIds: safe.claims.map((c) => c.observationId),
      requestedFactIds: requested,
      speechHash: npcContextFingerprint(safe),
    },
  };
}
export function buildStoryTurnContext(
  state: GameState,
  actorId: string,
  raw: StoryTurnInput,
  turnId: string,
) {
  const input = storyTurnInputSchema.parse(raw),
    parsed = parseStorySegments(input.text);
  if (parsed.code) throw new Error(parsed.code);
  const actor = state.entities[actorId];
  if (actor?.kind !== 'player' || actor.encounterId) throw new Error('WRONG_MODE');
  if (input.channel === 'whisper' && !input.targetNpcId) throw new Error('PRIVATE_STORY_EXTENSION');
  if (input.expectedCanonRevision !== (state.narrativeCanon?.revision ?? 0))
    throw new Error('STALE_CANON');
  const mode = input.targetNpcId ? ('npc' as const) : ('director' as const);
  if (input.targetNpcId) {
    const npc = state.entities[input.targetNpcId];
    if (
      npc?.kind !== 'npc' ||
      !state.npcBrains?.[npc.id]?.living ||
      npc.encounterId ||
      !visible(state, actor, npc) ||
      Math.abs(npc.x - actor.x) + Math.abs(npc.y - actor.y) > 1
    )
      throw new Error('OUT_OF_RANGE');
  }
  let simulated = structuredClone(state);
  const actionOutcomes: { segmentIndex: number; code: string }[] = [];
  const actionPreview: StoryActionPreview[] = [],
    dialogues: ReturnType<typeof safeSpeech>['context'][] = [];
  for (const segment of parsed.segments) {
    if (segment.kind === 'attempt') {
      const action = parsePlayerTextAction(simulated, actorId, segment.text);
      if (action) {
        const valid = allowedAction(simulated, actorId, action);
        if (!valid)
          throw new Error(
            action.kind === 'move_to' || action.kind === 'transition'
              ? 'WALK_FIRST'
              : 'UNSUPPORTED',
          );
        const r = applyAction(simulated, actorId, valid);
        if (r.error === 'OUT_OF_RANGE' || r.error === 'PATH_BLOCKED') throw new Error('WALK_FIRST');
        actionOutcomes.push({ segmentIndex: segment.index, code: r.error ?? 'ACTION_SUCCEEDED' });
        actionPreview.push({
          segmentIndex: segment.index,
          action: narrativeActionSchema.parse(valid),
        });
        if (!r.error)
          simulated = recordNpcEvents(
            simulated,
            r.state,
            r.events,
            `turn:${turnId}:${segment.index}`,
          ).state;
      }
    } else if (input.targetNpcId) {
      const r = safeSpeech(simulated, actorId, input.targetNpcId, input.channel, segment, turnId);
      simulated = r.state;
      dialogues.push(r.context);
    }
  }
  const view = projectState(state, actorId);
  const mechanics = view.entities
    .filter(
      (e) =>
        !input.targetNpcId ||
        visible(state, state.entities[input.targetNpcId], state.entities[e.id]),
    )
    .map((e) => ({
      id: e.id,
      kind: e.kind,
      label: e.label,
      open: e.open,
      locked: e.locked,
      ...(e.kind === 'npc' || e.kind === 'player' ? {} : { x: e.x, y: e.y }),
    }));
  const safe = {
    schemaVersion: 1,
    turnId,
    actorId,
    mode,
    channel: input.channel,
    targetNpcId: input.targetNpcId ?? null,
    segments: parsed.segments,
    mapId: actor.mapId,
    canonRevision: state.narrativeCanon?.revision ?? 0,
    mechanics,
    actionPreview,
    actionOutcomes,
    dialogues,
    ...(mode === 'director' ? { director: buildNarrativeContext(state, actorId, input.text) } : {}),
    allowedActions: ['inspect', 'open', 'close', 'unlock', 'pick_up', 'give', 'wait'],
  };
  const readset = {
    actor: { mapId: actor.mapId, x: actor.x, y: actor.y, inventory: actor.inventory ?? [] },
    source: state.narrativeSource ?? null,
    ...safe,
  };
  return {
    ...safe,
    confirmationHash: npcContextFingerprint(actionPreview),
    contextHash: npcContextFingerprint(readset),
  };
}
export type StoryTurnContext = ReturnType<typeof buildStoryTurnContext>;
export function createMockStoryTurnProposal(
  state: GameState,
  actorId: string,
  input: StoryTurnInput,
  turnId: string,
): StoryTurnProposal {
  const context = buildStoryTurnContext(state, actorId, input, turnId);
  const steps = context.segments.map((segment) => ({
    segmentIndex: segment.index,
    action:
      segment.kind === 'attempt'
        ? (context.actionPreview.find((a) => a.segmentIndex === segment.index)?.action ?? null)
        : null,
    reply:
      segment.kind === 'speech' && context.mode === 'npc'
        ? createMockNpcPublicResponse(
            context.dialogues.find((d) => d.segmentIndex === segment.index)!,
          )
        : null,
  }));
  if (steps.some((step, i) => context.segments[i].kind === 'attempt' && !step.action))
    return {
      turnId,
      contextHash: context.contextHash,
      status: 'clarification',
      code: 'AMBIGUOUS',
      steps: [],
      narrative: null,
    };
  const narrative =
    context.mode === 'director'
      ? createMockNarrativeProposal(state, actorId, input.text, turnId)
      : null;
  return {
    turnId,
    contextHash: context.contextHash,
    status: 'ready',
    code: null,
    steps,
    narrative: narrative
      ? {
          narration: narrative.narration,
          newScene: narrative.newScene,
          newNpc: narrative.newNpc,
          evidenceIds: narrative.evidenceIds,
        }
      : null,
  };
}
export interface StoryTurnApplied extends GameResult {
  entries: StorySafeEntry[];
  actions: StoryActionPreview[];
  clarification?: string;
}
export function applyStoryTurnProposal(
  state: GameState,
  actorId: string,
  input: StoryTurnInput,
  turnId: string,
  raw: unknown,
): StoryTurnApplied {
  const reject = (code: GameResult['error'] = 'STALE_STATE'): StoryTurnApplied => ({
    state,
    events: [],
    entries: [],
    actions: [],
    error: code,
  });
  const parsed = storyTurnProposalSchema.safeParse(raw);
  if (!parsed.success) return reject('INVALID_ACTION');
  let context: StoryTurnContext;
  try {
    context = buildStoryTurnContext(state, actorId, input, turnId);
  } catch {
    return reject();
  }
  const p = parsed.data;
  if (p.turnId !== turnId || p.contextHash !== context.contextHash) return reject();
  if (p.status === 'clarification') {
    if (!p.code || p.steps.length || p.narrative) return reject('INVALID_ACTION');
    return { state, events: [], entries: [], actions: [], clarification: p.code };
  }
  if (
    p.code ||
    p.steps.length !== context.segments.length ||
    p.steps.some((s, i) => s.segmentIndex !== context.segments[i].index)
  )
    return reject('INVALID_ACTION');
  if (context.mode === 'npc' && p.narrative) return reject('FORBIDDEN');
  if (context.mode === 'director' && !p.narrative) return reject('INVALID_ACTION');
  const actions: StoryActionPreview[] = [];
  for (const [i, segment] of context.segments.entries()) {
    const step = p.steps[i];
    if (segment.kind === 'attempt') {
      if (!step.action || step.reply) return reject('INVALID_ACTION');
      actions.push({ segmentIndex: segment.index, action: step.action });
    } else if (step.action || (context.mode === 'npc' ? !step.reply : Boolean(step.reply)))
      return reject('INVALID_ACTION');
  }
  const knownFailure = (segmentIndex: number, action: GameAction, code: string) => {
    const quoted = context.actionPreview.find((a) => a.segmentIndex === segmentIndex)?.action;
    return (
      !!quoted &&
      quoted.kind === action.kind &&
      quoted.targetId === action.targetId &&
      quoted.itemId === action.itemId &&
      context.actionOutcomes.some((o) => o.segmentIndex === segmentIndex && o.code === code)
    );
  };
  const unsupported = (): StoryTurnApplied => ({
    state,
    events: [],
    entries: [],
    actions: [],
    clarification: 'UNSUPPORTED',
  });
  const entries: StorySafeEntry[] = [];
  let next = structuredClone(state);
  const events: GameResult['events'] = [];
  const push = (entry: Omit<StorySafeEntry, 'ordinal' | 'tick'>) =>
    entries.push({ ...entry, ordinal: entries.length, tick: state.tick });
  if (context.mode === 'director') {
    for (const [i, segment] of context.segments.entries()) {
      const audience = listeners(next, actorId);
      push({
        kind: segment.kind,
        channel: 'say',
        authorId: actorId,
        authorLabel: next.entities[actorId].label,
        text: segment.text,
        audienceIds: audience,
      });
      if (segment.kind === 'attempt') {
        const action = allowedAction(next, actorId, p.steps[i].action);
        if (!action) return reject('FORBIDDEN');
        const outcome = applyAction(next, actorId, action);
        if (outcome.error && !knownFailure(segment.index, action, outcome.error))
          return unsupported();
        if (outcome.error === 'OUT_OF_RANGE' || outcome.error === 'PATH_BLOCKED')
          return reject(outcome.error);
        if (!outcome.error) {
          next = recordNpcEvents(
            next,
            outcome.state,
            outcome.events,
            `turn:${turnId}:${segment.index}`,
          ).state;
          events.push(...outcome.events);
        }
        push({
          kind: 'outcome',
          channel: 'say',
          authorId: actorId,
          code: outcome.error ?? 'ACTION_SUCCEEDED',
          // Hearers may not see the target or the giver's private inventory.
          action: { kind: narrativeActionSchema.parse(action).kind },
          audienceIds: audience,
        });
      }
    }
    const directorContext = buildNarrativeContext(next, actorId, input.text);
    const r = applyNarrativeProposal(
      next,
      actorId,
      { turnId, contextHash: directorContext.contextHash, ...p.narrative!, actions: [] },
      input.text,
    );
    if (r.error) return reject(r.error);
    next = recordNpcEvents(next, r.state, r.events, `story:${turnId}`).state;
    events.push(...r.events);
    push({ kind: 'narration', channel: 'say', text: p.narrative!.narration, audienceIds: ['*'] });
  } else {
    const npcId = input.targetNpcId!;
    for (const [i, segment] of context.segments.entries()) {
      const step = p.steps[i];
      const audience = input.channel === 'whisper' ? [actorId, npcId] : listeners(next, actorId);
      push({
        kind: segment.kind,
        channel: input.channel,
        authorId: actorId,
        authorLabel: next.entities[actorId].label,
        text: segment.text,
        audienceIds: audience,
      });
      if (segment.kind === 'attempt') {
        const action = allowedAction(next, actorId, step.action);
        if (!action) return reject('FORBIDDEN');
        const r = applyAction(next, actorId, action);
        if (r.error && !knownFailure(segment.index, action, r.error)) return unsupported();
        if (
          r.error === 'OUT_OF_RANGE' ||
          r.error === 'TARGET_UNAVAILABLE' ||
          r.error === 'INVALID_ACTION'
        )
          return reject(r.error);
        const publicAudience = listeners(next, actorId);
        if (!r.error) {
          next = recordNpcEvents(next, r.state, r.events, `turn:${turnId}:${segment.index}`).state;
          events.push(...r.events);
        }
        push({
          kind: 'outcome',
          channel: 'say',
          authorId: actorId,
          code: r.error ?? 'ACTION_SUCCEEDED',
          action: { kind: step.action!.kind },
          audienceIds: publicAudience,
        });
      } else {
        let spoken: ReturnType<typeof safeSpeech>;
        try {
          spoken = safeSpeech(
            next,
            actorId,
            npcId,
            input.channel,
            segment,
            turnId,
            context.dialogues.find((d) => d.segmentIndex === segment.index)?.observationIds,
          );
        } catch {
          return reject();
        }
        const expected = context.dialogues.find((d) => d.segmentIndex === segment.index);
        if (!expected || spoken.context.speechHash !== expected.speechHash) return reject();
        entries[entries.length - 1].sourceId = spoken.sourceId;
        next = spoken.state;
        events.push(...spoken.events);
        const r = commitNpcPublicUtterance(next, npcId, {
          ...step.reply!,
          channel: input.channel,
          recipientId: actorId,
          observationIds: spoken.context.observationIds,
          requestedFactIds: spoken.context.requestedFactIds,
          contextHash: spoken.context.speechHash,
        });
        if (r.error) return reject(r.error);
        const sourceId = r.state.npcUtterances?.find(
          (u) => u.speakerId === npcId && !next.npcUtterances?.some((old) => old.id === u.id),
        )?.id;
        next = r.state;
        events.push(...r.events);
        push({
          sourceId,
          kind: 'npc_reply',
          channel: input.channel,
          authorId: npcId,
          authorLabel: next.entities[npcId].label,
          ...('text' in step.reply! ? { text: step.reply!.text } : { code: 'acknowledged' }),
          audienceIds: spoken.context.audienceIds,
        });
      }
    }
  }
  return { state: next, events, entries, actions };
}
