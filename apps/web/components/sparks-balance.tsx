'use client';
import { formatSparkSubunits } from '@dreamwalk/contracts';
import { useT } from '@/lib/i18n';
import { useSparksWallet } from '@/lib/use-sparks-wallet';
import type { Locale } from '@/lib/locales';
export const sparksBalanceMessages: Record<
  Locale,
  { loading: string; unavailable: string; available: string; starter: string; description: string }
> = {
  ru: {
    loading: 'Загружаем баланс искр',
    unavailable: 'Баланс искр недоступен',
    available: 'Доступно искр',
    starter: 'Стартовый подарок',
    description: 'Искры для твоих AI-приключений.',
  },
  uk: {
    loading: 'Завантажуємо баланс іскор',
    unavailable: 'Баланс іскор недоступний',
    available: 'Доступно іскор',
    starter: 'Стартовий подарунок',
    description: 'Іскри для твоїх AI-пригод.',
  },
  en: {
    loading: 'Loading Sparks balance',
    unavailable: 'Sparks balance unavailable',
    available: 'Available Sparks',
    starter: 'Welcome gift',
    description: 'Sparks for your AI adventures.',
  },
};
export function SparksBalance({ ownerId }: { ownerId: string }) {
  const { locale } = useT();
  const wallet = useSparksWallet(ownerId);
  const text = sparksBalanceMessages[locale];
  const amount = wallet.data ? formatSparkSubunits(wallet.data.availableSubunits, locale) : null;
  return (
    <strong
      className="sparks-balance"
      data-testid="sparks-balance"
      title={
        amount !== null ? text.available : wallet.unavailable ? text.unavailable : text.loading
      }
      aria-label={
        amount !== null
          ? `${text.available}: ${amount}`
          : wallet.unavailable
            ? text.unavailable
            : text.loading
      }
      aria-live="polite"
    >
      {amount ?? (wallet.unavailable ? '—' : '…')}
    </strong>
  );
}
