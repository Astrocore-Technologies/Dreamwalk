'use client';
import { useEffect, useId, useRef } from 'react';
import { MessageCircle, X } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { Button } from '@/components/ui';
import { NpcThoughtReader } from './npc-thought-reader';
import { useTurnText } from './turn-messages';
import styles from './npc-public-inspection.module.css';

/** Only the current recipient-safe public projection and authorized portrait enter this card. */
export function NpcPublicInspection({
  npcId,
  campaignId,
  canReadThoughts,
  name,
  role,
  description,
  appearance,
  portraitUrl,
  disabled,
  lifeState = 'conscious',
  onClose,
  onTalk,
}: {
  npcId: string;
  campaignId: string;
  canReadThoughts: boolean;
  name: string;
  role?: string;
  description: string;
  appearance?: string;
  portraitUrl?: string;
  disabled: boolean;
  lifeState?: 'conscious' | 'unconscious' | 'dead';
  onClose: () => void;
  onTalk: () => void;
}) {
  const { t } = useT();
  const text = useTurnText();
  const titleId = useId();
  const card = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // The map menu restores its own focus on dismissal; focus this card after that cleanup.
    const frame = requestAnimationFrame(() => {
      // Reset only this overlay for a new NPC; the preserved story reading position never moves.
      if (card.current?.parentElement) card.current.parentElement.scrollTop = 0;
      closeButton.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [npcId]);
  function close() {
    const feed = card.current
      ?.closest('[data-testid="unified-story"]')
      ?.querySelector<HTMLElement>('[data-testid="story-feed"]');
    onClose();
    requestAnimationFrame(() => {
      if (feed?.isConnected) feed.focus({ preventScroll: true });
    });
  }
  return (
    <section
      ref={card}
      className={styles.card}
      aria-labelledby={titleId}
      data-testid="npc-public-inspection"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={closeButton}
        type="button"
        className={styles.close}
        aria-label={text('close')}
        onClick={close}
      >
        <X size={22} aria-hidden="true" />
      </button>
      {portraitUrl && <img className={styles.portrait} src={portraitUrl} alt={name} />}
      <div className={styles.content}>
        <h2 id={titleId}>{name}</h2>
        {lifeState !== 'conscious' && (
          <p role="status" data-life-state={lifeState}>
            {text(lifeState)} · {text('cannotRespond')}
          </p>
        )}
        {role && (
          <p className={styles.role}>
            <span>{t('Роль')}</span>
            {role}
          </p>
        )}
        <p>{description}</p>
        {appearance && <p>{appearance}</p>}
        <Button
          type="button"
          className={styles.talk}
          disabled={disabled || lifeState !== 'conscious'}
          data-testid="npc-inspection-talk"
          onClick={() => {
            onTalk();
            const input = card.current
              ?.closest('[data-testid="unified-story"]')
              ?.querySelector<HTMLTextAreaElement>('textarea');
            if (input && !input.disabled) input.focus({ preventScroll: true });
          }}
        >
          <MessageCircle size={20} aria-hidden="true" />
          {text('talk')}
        </Button>
        {canReadThoughts && (
          <NpcThoughtReader key={`${campaignId}:${npcId}`} campaignId={campaignId} npcId={npcId} />
        )}
      </div>
    </section>
  );
}
