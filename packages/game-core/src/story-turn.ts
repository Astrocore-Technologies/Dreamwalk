import {
  footprintDistance,
  occupiedCells,
  readNarrativePreferences,
  storyTurnInputSchema,
  storyTurnProposalSchema,
  narrativeActionSchema,
  type StoryTurnInput,
  type Locale,
  type StorySegment,
  type StoryActionPreview,
  type StoryTurnProposal,
  type GameState,
  type GameAction,
  type GameResult,
  type StoryFeedEntry,
} from '@dreamwalk/contracts';
import { applyAction, visible, projectState, findPath, walkable } from './index';
import { recordNpcEvents } from './npc';
import { parsePlayerTextAction } from './living-reasoning';
import {
  applyNpcSpeech,
  admittedNpcSpeechObservationId,
  buildNpcPublicSpeechContext,
  commitNpcPublicUtterance,
  canNpcHear,
  npcSpeechListenerIds,
  npcSpeechProspectiveListenerIds,
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
    if (
      !target ||
      !(
        visible(state, actor, target) ||
        (p.data.kind === 'consume' &&
          target.ownerId === actorId &&
          actor.inventory?.includes(target.id))
      )
    )
      return null;
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
  replyLocale: Locale = 'en',
  sharedDirector = false,
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
  const audience = npcSpeechProspectiveListenerIds(next, npcId, channel);
  const topics = publicNpcFactTopics(next, npcId).filter(
    (t) => normalize(t.title) === normalize(segment.text),
  );
  const requested =
    !sharedDirector && topics.length === 1 ? resolveNpcFactTopic(next, npcId, topics[0].id) : [];
  let ids =
    selectedObservationIds ??
    [
      ...new Set([
        marker,
        ...requested,
        ...(next.npcBrains?.[npcId]?.living?.observations ?? []).slice(-16).map((o) => o.id),
      ]),
    ].slice(0, 16);
  if (sharedDirector) {
    // The director also writes globally visible narration. Local permission to hear
    // an old whisper or to release an asked secret must not become shared context.
    const readers = Object.values(next.entities)
      .filter((e) => e.kind === 'player')
      .map((e) => e.id);
    ids = ids.filter((id) => {
      if (id === marker) return true; // This new statement was explicitly sent to the shared director.
      const observation = next.npcBrains?.[npcId]?.living?.observations.find((o) => o.id === id);
      return (
        observation?.disclosure === 'public' ||
        (observation?.disclosure === 'participants' &&
          readers.every((reader) => observation.audienceIds.includes(reader)))
      );
    });
  }
  const safe = buildNpcPublicSpeechContext(
    next,
    npcId,
    audience,
    ids,
    requested,
    undefined,
    replyLocale,
    actorId,
  );
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
/** Bind a generated voice to the public evidence it actually received. The engine's
 * full speech hash additionally binds current listeners/private mechanics at commit. */
function directorVoice(context: ReturnType<typeof safeSpeech>['context']) {
  const evidence = {
    npcId: context.npcId,
    replyLocale: context.replyLocale,
    claims: context.claims,
    segmentIndex: context.segmentIndex,
    replyToObservationId: context.replyToObservationId,
    currentUtterance: context.currentUtterance,
    observationIds: context.observationIds,
    requestedFactIds: context.requestedFactIds,
    ...('publicIdentity' in context ? { publicIdentity: context.publicIdentity } : {}),
    ...('publicSpeechStyle' in context ? { publicSpeechStyle: context.publicSpeechStyle } : {}),
    ...('performance' in context ? { performance: context.performance } : {}),
  };
  return {
    ...evidence,
    audienceIds: context.audienceIds,
    speechHash: npcContextFingerprint(evidence),
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
      footprintDistance(npc, actor) > 1
    )
      throw new Error('OUT_OF_RANGE');
  }
  let simulated = structuredClone(state);
  const directorStates = new Map<number, GameState>();
  const actionOutcomes: { segmentIndex: number; code: string }[] = [];
  const actionPreview: StoryActionPreview[] = [],
    dialogues: ReturnType<typeof safeSpeech>['context'][] = [];
  for (const segment of parsed.segments) {
    if (mode === 'director' && segment.kind === 'speech')
      directorStates.set(segment.index, structuredClone(simulated));
    if (segment.kind === 'attempt') {
      const action = parsePlayerTextAction(simulated, actorId, segment.text);
      if (action && action.kind !== 'move_to' && action.kind !== 'transition') {
        const valid = allowedAction(simulated, actorId, action);
        if (!valid) throw new Error('UNSUPPORTED');
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
      const r = safeSpeech(
        simulated,
        actorId,
        input.targetNpcId,
        input.channel,
        segment,
        turnId,
        undefined,
        input.replyLocale,
      );
      simulated = r.state;
      dialogues.push(r.context);
    }
  }
  // Preview each eligible existing character with the same speech admission used at commit.
  // The director may see shared canon; these isolated voice contexts are the only evidence
  // an existing character response may use. Newborns have no inherited conversation.
  const sceneSpeakers =
    mode === 'director'
      ? Object.values(state.entities)
          .filter(
            (npc) =>
              npc.kind === 'npc' &&
              state.npcBrains?.[npc.id]?.living &&
              visible(state, actor, npc) &&
              !npc.encounterId,
          )
          .sort(
            (a, b) =>
              footprintDistance(actor, a) - footprintDistance(actor, b) || a.id.localeCompare(b.id),
          )
          .slice(0, 4)
          .flatMap((npc) =>
            parsed.segments
              .filter((segment) => segment.kind === 'speech')
              .flatMap((segment) => {
                const checkpoint = directorStates.get(segment.index)!;
                const approached = approachStoryNpc(checkpoint, actorId, npc.id);
                if (approached.error) return [];
                try {
                  return [
                    directorVoice(
                      safeSpeech(
                        approached.state,
                        actorId,
                        npc.id,
                        'say',
                        segment,
                        turnId,
                        undefined,
                        input.replyLocale,
                        true,
                      ).context,
                    ),
                  ];
                } catch {
                  return [];
                }
              }),
          )
      : [];
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
    replyLocale: input.replyLocale ?? 'en',
    ...(state.narrativePreferences?.[actorId]
      ? { narrativePreferences: readNarrativePreferences(state, actorId) }
      : {}),
    targetNpcId: input.targetNpcId ?? null,
    segments: parsed.segments,
    mapId: actor.mapId,
    canonRevision: state.narrativeCanon?.revision ?? 0,
    mechanics,
    actionPreview,
    actionOutcomes,
    dialogues,
    ...(mode === 'director' ? { sceneSpeakers } : {}),
    ...(mode === 'director'
      ? { director: buildNarrativeContext(state, actorId, input.text, input.replyLocale) }
      : {}),
    allowedActions: [
      'inspect',
      'open',
      'close',
      'unlock',
      'pick_up',
      'consume',
      'give',
      'wait',
      ...(mode === 'director' && !state.turnController ? ['approach'] : []),
    ],
    sceneInteractionPolicy:
      mode === 'director'
        ? 'Materialize new people through newNpc. Use new_npc only for the new character in this proposal. approach requires an explicit player attempt; speech replies require replyNpcId and use only that character perceived evidence plus attributed player speech, never narrator omniscience.'
        : undefined,
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
  if (
    (context.mode === 'npc' || !state.turnController) &&
    steps.some((step, i) => context.segments[i].kind === 'attempt' && !step.action)
  )
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
      ? createMockNarrativeProposal(state, actorId, input.text, turnId, input.replyLocale)
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
  if (
    context.mode === 'director' &&
    (!p.narrative || p.steps.filter((step) => step.reply).length > 1)
  )
    return reject('INVALID_ACTION');
  const actions: StoryActionPreview[] = [];
  for (const [i, segment] of context.segments.entries()) {
    const step = p.steps[i];
    if (context.mode === 'director' && step.reply && 'text' in step.reply) {
      // Director voices carry public speech evidence, not private action targets.
      // A newborn has no provider-visible current observation before admission.
      if (
        (step.replyNpcId === 'new_npc' &&
          (step.reply.companionIntent || step.reply.actionIntent)) ||
        step.reply.actionIntent?.actions.some((action) => action.kind !== 'wait')
      )
        return reject('FORBIDDEN');
    }
    if (segment.kind === 'attempt') {
      if (
        (context.mode === 'npc' && !step.action) ||
        step.reply ||
        step.replyNpcId ||
        step.replyContextHash
      )
        return reject('INVALID_ACTION');
      if (step.action)
        actions.push({
          segmentIndex: segment.index,
          action: step.action,
          ...(step.action.targetId === 'new_npc' && p.narrative?.newNpc
            ? { targetLabel: p.narrative.newNpc.name }
            : {}),
        });
    } else if (
      step.action ||
      (context.mode === 'npc'
        ? !step.reply || Boolean(step.replyNpcId)
        : Boolean(step.reply) !== Boolean(step.replyNpcId))
    )
      return reject('INVALID_ACTION');
    if (context.mode === 'director' && state.turnController && step.action)
      return reject('FORBIDDEN');
    if (
      step.action?.kind === 'approach' &&
      (context.mode !== 'director' || !step.action.targetId || step.action.itemId)
    )
      return reject('FORBIDDEN');
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
    // Materialize the typed scene before resolving its ordered interactions. All mutations
    // remain in this local proposal until every action and speech admission succeeds.
    const directorContext = buildNarrativeContext(next, actorId, input.text, input.replyLocale);
    const created = applyNarrativeProposal(
      next,
      actorId,
      { turnId, contextHash: directorContext.contextHash, ...p.narrative!, actions: [] },
      input.text,
      input.replyLocale,
    );
    if (created.error) return reject(created.error);
    next = recordNpcEvents(next, created.state, created.events, `story:${turnId}`).state;
    events.push(...created.events);
    const resolveNpc = (id: string) =>
      id === 'new_npc' && p.narrative?.newNpc ? `support-${turnId}` : id;
    for (const [i, segment] of context.segments.entries()) {
      const audience =
        segment.kind === 'speech'
          ? npcSpeechListenerIds(next, actorId, { channel: 'say', text: segment.text })
          : listeners(next, actorId);
      push({
        kind: segment.kind,
        channel: 'say',
        authorId: actorId,
        authorLabel: next.entities[actorId].label,
        text: segment.text,
        audienceIds: audience,
      });
      if (segment.kind === 'attempt') {
        const proposed = p.steps[i].action;
        if (!proposed) continue; // Descriptive emote, not a mechanically completed action.
        const action = proposed.kind === 'approach' ? null : allowedAction(next, actorId, proposed);
        if (!action && proposed.kind !== 'approach') return reject('FORBIDDEN');
        const outcome =
          proposed.kind === 'approach'
            ? approachStoryNpc(next, actorId, resolveNpc(proposed.targetId!))
            : applyAction(next, actorId, action!);
        if (outcome.error && (!action || !knownFailure(segment.index, action, outcome.error)))
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
          ...(action ? { action: { kind: narrativeActionSchema.parse(action).kind } } : {}),
          audienceIds: audience,
        });
      } else if (p.steps[i].reply && p.steps[i].replyNpcId) {
        const npcId = resolveNpc(p.steps[i].replyNpcId!);
        const npc = next.entities[npcId];
        if (
          npc?.kind !== 'npc' ||
          !visible(next, next.entities[actorId], npc) ||
          footprintDistance(npc, next.entities[actorId]) > 1
        )
          return reject('OUT_OF_RANGE');
        const preview =
          p.steps[i].replyNpcId === 'new_npc'
            ? undefined
            : context.sceneSpeakers?.find(
                (voice) => voice.npcId === npcId && voice.segmentIndex === segment.index,
              );
        let spoken: ReturnType<typeof safeSpeech>;
        try {
          spoken = safeSpeech(
            next,
            actorId,
            npcId,
            'say',
            segment,
            turnId,
            preview?.observationIds,
            input.replyLocale,
            true,
          );
        } catch {
          return reject('FORBIDDEN');
        }
        if (p.steps[i].replyNpcId === 'new_npc') {
          if (!p.narrative?.newNpc || p.steps[i].replyContextHash) return reject('FORBIDDEN');
        } else {
          if (
            !preview ||
            p.steps[i].replyContextHash !== preview.speechHash ||
            directorVoice(spoken.context).speechHash !== preview.speechHash
          )
            return reject('STALE_STATE');
        }
        entries[entries.length - 1].sourceId = spoken.sourceId;
        next = spoken.state;
        events.push(...spoken.events);
        const response = commitNpcPublicUtterance(next, npcId, {
          ...p.steps[i].reply!,
          channel: 'say',
          recipientId: actorId,
          replyLocale: input.replyLocale ?? 'en',
          observationIds: spoken.context.observationIds,
          requestedFactIds: spoken.context.requestedFactIds,
          contextHash: spoken.context.speechHash,
          replyToObservationId: spoken.context.replyToObservationId,
        });
        if (response.error) return reject(response.error);
        const responseUtterance = response.state.npcUtterances?.find(
          (u) => u.speakerId === npcId && !next.npcUtterances?.some((old) => old.id === u.id),
        );
        const sourceId = responseUtterance?.id;
        next = response.state;
        events.push(...response.events);
        push({
          kind: 'npc_reply',
          channel: 'say',
          sourceId,
          authorId: npcId,
          authorLabel: npc.label,
          ...p.steps[i].reply!,
          audienceIds: responseUtterance?.audienceIds ?? [],
        });
      }
    }
    push({ kind: 'narration', channel: 'say', text: p.narrative!.narration, audienceIds: ['*'] });
  } else {
    const npcId = input.targetNpcId!;
    for (const [i, segment] of context.segments.entries()) {
      const step = p.steps[i];
      const audience =
        segment.kind === 'speech'
          ? npcSpeechListenerIds(next, actorId, { channel: input.channel, text: segment.text })
          : input.channel === 'whisper'
            ? [actorId, npcId]
            : listeners(next, actorId);
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
          action: { kind: narrativeActionSchema.parse(step.action).kind },
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
            input.replyLocale,
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
          replyToObservationId: spoken.context.replyToObservationId,
          replyLocale: input.replyLocale,
        });
        if (r.error) return reject(r.error);
        const responseUtterance = r.state.npcUtterances?.find(
          (u) => u.speakerId === npcId && !next.npcUtterances?.some((old) => old.id === u.id),
        );
        const sourceId = responseUtterance?.id;
        next = r.state;
        events.push(...r.events);
        push({
          sourceId,
          kind: 'npc_reply',
          channel: input.channel,
          authorId: npcId,
          authorLabel: next.entities[npcId].label,
          ...('text' in step.reply! ? { text: step.reply!.text } : { code: 'acknowledged' }),
          audienceIds: responseUtterance?.audienceIds ?? [],
        });
      }
    }
  }
  return { state: next, events, entries, actions };
}

/** Complete only a short, collision-checked approach explicitly proposed for a player attempt.
 * This scene cut does not fast-forward unrelated actors or claim queued movement completed. */
function approachStoryNpc(state: GameState, actorId: string, npcId: string): GameResult {
  const actor = state.entities[actorId],
    npc = state.entities[npcId];
  const reject = (error: GameResult['error']): GameResult => ({ state, events: [], error });
  if (
    !actor ||
    actor.kind !== 'player' ||
    npc?.kind !== 'npc' ||
    actor.encounterId ||
    npc.encounterId ||
    !visible(state, actor, npc)
  )
    return reject('FORBIDDEN');
  if (footprintDistance(actor, npc) <= 1) return { state, events: [] };
  if (state.turnController) return reject('WRONG_MODE');
  const candidates: { x: number; y: number }[] = [];
  for (let y = actor.y - 8; y <= actor.y + 8; y++)
    for (let x = actor.x - 8; x <= actor.x + 8; x++)
      if (
        footprintDistance({ ...actor, x, y }, npc) === 1 &&
        walkable(state, actor.mapId, { x, y }, actorId, true)
      )
        candidates.push({ x, y });
  const paths = candidates
    .map((p) => findPath(state, actor.mapId, actor, p, actorId, true))
    .filter((p): p is NonNullable<typeof p> => !!p && p.length <= 8)
    .filter((path) =>
      path.every((p) =>
        occupiedCells({ ...actor, ...p }).every(
          (cell) =>
            !Object.values(state.encounters).some(
              (e) =>
                e.phase === 'planning' &&
                e.mapId === actor.mapId &&
                cell.x >= e.area.x &&
                cell.y >= e.area.y &&
                cell.x < e.area.x + e.area.width &&
                cell.y < e.area.y + e.area.height,
            ),
        ),
      ),
    )
    .sort((a, b) => a.length - b.length);
  const path = paths[0];
  if (!path?.length) return reject('PATH_BLOCKED');
  const next = structuredClone(state),
    moved = next.entities[actorId];
  Object.assign(moved, path[path.length - 1]);
  moved.path = [];
  moved.movementGeneration = (moved.movementGeneration ?? 0) + 1;
  moved.revision++;
  next.revision++;
  return { state: next, events: [{ kind: 'actor.moved', actorId, mapId: actor.mapId }] };
}
