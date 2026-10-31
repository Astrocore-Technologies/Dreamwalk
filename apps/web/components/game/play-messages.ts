'use client';
import { useT } from '@/lib/i18n';
export function useAdvancedPlayLabel() {
  const { locale } = useT();
  return locale === 'ru'
    ? 'Дополнительно: AI и бюджет сессии'
    : locale === 'uk'
      ? 'Додатково: AI та бюджет сесії'
      : 'Advanced: AI and session budget';
}
