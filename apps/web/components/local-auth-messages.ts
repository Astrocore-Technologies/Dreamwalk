import type { Locale } from '@/lib/locales';
export const localAuthMessages: Record<Locale, { identifier: string; hint: string }> = {
  uk: { identifier: 'Email або локальний логін', hint: 'Локальний тестовий адміністратор: admin.' },
  en: { identifier: 'Email or local username', hint: 'Local test administrator: admin.' },
  ru: { identifier: 'Email или локальный логин', hint: 'Локальный тестовый администратор: admin.' },
};
