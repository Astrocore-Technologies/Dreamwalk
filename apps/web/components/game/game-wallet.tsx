'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { MoonStar, Sparkles } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { SPARKS_REFRESH_EVENT } from '@/lib/sparks-wallet';
import { SparksBalance } from '../sparks-balance';
import { DreamsBalance, useDreamsText } from '../dreams-wallet';
import styles from './game.module.css';

/** Only the signed-in player's own balances, never the campaign owner's wallet. */
export function GameWallet({ ownerId, scope }: { ownerId: string; scope: string }) {
  const { locale } = useT();
  const { text } = useDreamsText();
  useEffect(() => {
    window.dispatchEvent(new Event(SPARKS_REFRESH_EVENT));
  }, [ownerId, scope]);
  return (
    <Link href="/wallet" className={styles.gameWallet} data-testid="game-wallet">
      <span>
        <Sparkles size={14} aria-hidden="true" />
        <span>{locale === 'ru' ? 'Искры' : locale === 'uk' ? 'Іскри' : 'Sparks'}</span>
        <SparksBalance ownerId={ownerId} />
      </span>
      <span>
        <MoonStar size={14} aria-hidden="true" />
        <span>{text.name}</span>
        <DreamsBalance ownerId={ownerId} />
      </span>
    </Link>
  );
}
