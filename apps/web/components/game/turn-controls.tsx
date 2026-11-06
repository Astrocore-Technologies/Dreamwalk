'use client';
import { isSpatialRecoveryRequired } from './spatial-recovery';
import type { GameProjection } from '@dreamwalk/contracts';
import { Button } from '../ui';
import { useTurnText } from './turn-messages';
import styles from './game.module.css';

export function TurnControls({
  projection,
  busy,
  connected,
  activeName,
  onEnd,
  onReaction,
}: {
  projection: GameProjection;
  busy: boolean;
  connected: boolean;
  activeName?: string;
  onEnd: () => void;
  onReaction: (decision: 'defend' | 'decline') => void;
}) {
  const text = useTurnText(),
    turn = projection.turn;
  if (!turn || isSpatialRecoveryRequired(projection)) return null;
  const canReact = turn.phase === 'reaction' && turn.reaction?.reactorId === projection.actorId;
  return (
    <section
      className={styles.turnPanel}
      aria-label={text('label')}
      data-turn-phase={turn.phase}
      data-phase-epoch={turn.phaseEpoch}
    >
      <header>
        <div>
          <h2>
            {turn.phase === 'world'
              ? text('world')
              : turn.phase === 'reaction'
                ? text('reaction')
                : turn.ownTurn
                  ? text('yours')
                  : activeName || text('player')}
          </h2>
        </div>
        <Button
          type="button"
          disabled={
            turn.phase !== 'player' || !connected || !turn.ownTurn || busy || turn.pendingResolution
          }
          busy={busy}
          onClick={onEnd}
        >
          {text('end')}
        </Button>
      </header>
      {turn.phase === 'world' && (
        <p className={styles.turnHint} role="status">
          {text('worldWaiting')}
        </p>
      )}
      {canReact && (
        <div className={styles.actions}>
          <Button type="button" disabled={!connected || busy} onClick={() => onReaction('defend')}>
            {text('defend')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!connected || busy}
            onClick={() => onReaction('decline')}
          >
            {text('decline')}
          </Button>
        </div>
      )}
      {turn.pendingNpcReplies.length > 0 && (
        <p className={styles.pendingReplies} role="status">
          {text('pending')}:{' '}
          {turn.pendingNpcReplies
            .map(
              (entry) =>
                `${projection.entities.find((e) => e.id === entry.npcId)?.label || 'NPC'} (${entry.count})`,
            )
            .join(' · ')}
        </p>
      )}
    </section>
  );
}
