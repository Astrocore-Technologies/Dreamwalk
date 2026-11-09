'use client';
import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { PortraitFrame } from '@dreamwalk/contracts';
import { FramedPortrait } from '../framed-portrait';
import { useTurnText } from './turn-messages';
import { TOKEN_COLORS, type TokenKind } from './actor-token';
import styles from './game.module.css';

/** Neutral bust drawn in the role colour when a character has no authorized art. */
function BustArt({ kind }: { kind: TokenKind }) {
  const colors = TOKEN_COLORS[kind];
  return (
    <svg
      viewBox="0 0 120 120"
      preserveAspectRatio="xMidYMid slice"
      role="presentation"
      aria-hidden="true"
      data-art-bust={kind}
    >
      <defs>
        <linearGradient id={`bust-${kind}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#40335f" />
          <stop offset="1" stopColor="#1d1730" />
        </linearGradient>
      </defs>
      <rect width="120" height="120" fill={`url(#bust-${kind})`} />
      <circle cx="60" cy="48" r="20" fill={colors.figure} />
      <ellipse cx="60" cy="118" rx="42" ry="34" fill={colors.figure} />
    </svg>
  );
}

/**
 * Compact art window over the map. It never covers the story feed or composer and
 * only receives what the server already authorized for this actor.
 */
export function ActorArtWindow({
  name,
  kind,
  portraitUrl,
  portraitFrame,
  fullLength,
  role,
  lifeState,
  canTalk,
  onTalk,
  onDetails,
  onClose,
}: {
  name: string;
  kind: TokenKind;
  portraitUrl?: string;
  portraitFrame?: PortraitFrame | null;
  /** Show the whole picture (a standing character) instead of the face crop used on the map. */
  fullLength?: boolean;
  role?: string;
  lifeState?: string;
  canTalk: boolean;
  onTalk: () => void;
  onDetails?: () => void;
  onClose: () => void;
}) {
  const text = useTurnText();
  const closeButton = useRef<HTMLButtonElement>(null);
  // A missing or withdrawn portrait falls back to the bust instead of a broken image.
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const shownUrl = portraitUrl && portraitUrl !== brokenUrl ? portraitUrl : undefined;
  useEffect(() => {
    const frame = requestAnimationFrame(() => closeButton.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [name, kind]);
  // The role line never repeats the title (an unnamed actor already shows it as the name).
  const roleLine = kind === 'self' ? text('artYou') : kind === 'player' ? text('artPlayer') : role;
  const subtitle = roleLine && roleLine !== name ? roleLine : undefined;
  return (
    <aside
      className={styles.artWindow}
      role="dialog"
      aria-label={name}
      data-testid="actor-art-window"
      data-actor-kind={kind}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <button
        ref={closeButton}
        type="button"
        className={styles.artClose}
        aria-label={text('closeArt')}
        onClick={onClose}
      >
        <X size={18} aria-hidden="true" />
      </button>
      <div
        className={styles.artFrame}
        data-has-art={!!shownUrl}
        data-full-length={!!shownUrl && !!fullLength}
      >
        {shownUrl ? (
          <FramedPortrait
            src={shownUrl}
            alt={name}
            frame={fullLength ? undefined : portraitFrame}
            onError={() => setBrokenUrl(shownUrl)}
          />
        ) : (
          <BustArt kind={kind} />
        )}
      </div>
      <div className={styles.artBody}>
        <h3>{name}</h3>
        {subtitle && <p className={styles.artSubtitle}>{subtitle}</p>}
        {lifeState && (
          <p role="status" data-life-state={lifeState} className={styles.artSubtitle}>
            {lifeState}
          </p>
        )}
        {(canTalk || onDetails) && (
          <div className={styles.artActions}>
            {canTalk && (
              <button type="button" className="button primary" onClick={onTalk}>
                {text('talk')}
              </button>
            )}
            {onDetails && (
              <button type="button" className="button secondary" onClick={onDetails}>
                {text('inspect')}
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
