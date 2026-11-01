'use client';
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
  if (!turn) return null;
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
          <span className={styles.kicker}>
            {text('round')} {turn.roundNumber}
          </span>
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
        {turn.phase === 'player' && (
          <Button
            type="button"
            disabled={!connected || !turn.ownTurn || busy || turn.pendingResolution}
            busy={busy}
            onClick={onEnd}
          >
            {text('end')}
          </Button>
        )}
      </header>
      <dl className={styles.turnResources}>
        {(['movement', 'main', 'additional', 'reaction'] as const).map((key) => (
          <div key={key}>
            <dt>{text(key === 'reaction' ? 'reactionResource' : key)}</dt>
            <dd>{turn.resources[key]}</dd>
          </div>
        ))}
      </dl>
      <p className={styles.turnHint}>
        {turn.pendingResolution
          ? text('resolving')
          : turn.phase === 'world'
            ? text('worldPending')
            : turn.phase === 'reaction'
              ? text('reactionHint')
              : turn.ownTurn
                ? text('frozen')
                : text('waiting')}
      </p>
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
