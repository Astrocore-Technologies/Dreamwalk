import type { GamePoint, GameProjection } from '@dreamwalk/contracts';
import { isSpatialRecoveryRequired } from './spatial-recovery';

/** Presentation fence only. Server authorization and phase fences remain authoritative. */
export function projectionTurnFence(projection: GameProjection | null | undefined) {
  const turn = projection?.turn;
  return turn
    ? { roundId: turn.roundId, phaseEpoch: turn.phaseEpoch, rulesetVersion: 1 as const }
    : undefined;
}
export function playerControlsAvailable(projection: GameProjection | null | undefined) {
  if (isSpatialRecoveryRequired(projection)) return false;
  const turn = projection?.turn;
  return !turn || (turn.phase === 'player' && turn.ownTurn && !turn.pendingResolution);
}
/** Animate only an already-committed, server-supplied path. Never advances canonical positions. */
export function committedPathSample(points: readonly GamePoint[], elapsed: number, stepMs = 130) {
  if (!points.length) return null;
  // A long legal path is not a minutes-long animation or a straight-line teleport.
  const duration = Math.min(Math.max(1, stepMs), 1800 / Math.max(1, points.length - 1));
  const progress = Math.max(0, elapsed) / duration;
  const index = Math.min(points.length - 1, Math.floor(progress));
  const from = points[index],
    to = points[Math.min(points.length - 1, index + 1)];
  const fraction = Math.min(1, progress - index);
  const dx = to.x - from.x,
    dy = to.y - from.y;
  return {
    x: from.x + dx * fraction,
    y: from.y + dy * fraction,
    moving: index < points.length - 1,
    direction: Math.abs(dx) > Math.abs(dy) ? (dx < 0 ? 1 : 2) : dy < 0 ? 3 : 0,
  };
}
export function spriteFeedback(kind: 'hit' | 'push', elapsed: number, dx: number, dy: number) {
  const duration = kind === 'hit' ? 360 : 440;
  const fraction = Math.max(0, Math.min(1, elapsed / duration));
  const envelope = Math.sin(Math.PI * fraction) * (1 - fraction);
  return kind === 'hit'
    ? {
        x: Math.sin(fraction * Math.PI * 8) * envelope * 7,
        y: 0,
        rotation: Math.sin(fraction * Math.PI * 6) * envelope * 0.07,
      }
    : { x: dx * envelope * 10, y: dy * envelope * 10, rotation: -dx * envelope * 0.09 };
}

/** Public lifecycle only; legacy zero-vitality saves never imply death. */
export function publicLifeState(entity: {
  lifeState?: 'conscious' | 'unconscious' | 'dead';
  vitality?: number;
}) {
  return (
    entity.lifeState ??
    (entity.vitality !== undefined && entity.vitality <= 0 ? 'unconscious' : 'conscious')
  );
}
export function npcUnavailable(entity: {
  kind: string;
  lifeState?: 'conscious' | 'unconscious' | 'dead';
  vitality?: number;
}) {
  return (
    entity.kind === 'npc' &&
    (publicLifeState(entity) !== 'conscious' ||
      (entity.vitality !== undefined && entity.vitality <= 0))
  );
}
