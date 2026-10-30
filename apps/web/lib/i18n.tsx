'use client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useRef,
  type ReactNode,
} from 'react';
import { translate, dictionaries, type Locale } from './locales';
let currentLocale: Locale = 'ru';
export function tr(key: string, params?: Record<string, string | number>) {
  return translate(currentLocale, key, params);
}
export function taxonomy(value: string) {
  return dictionaries[currentLocale][value] ?? value;
}
export function getLocale() {
  return currentLocale;
}
const Context = createContext<{
  locale: Locale;
  setLocale: (locale: Locale, persistAccount?: boolean) => void;
  t: typeof tr;
  taxonomy: (value: string) => string;
  setAuthenticated: (value: boolean) => void;
}>({
  locale: 'ru',
  setLocale: () => {},
  t: tr,
  taxonomy: (value) => value,
  setAuthenticated: () => {},
});
export function LocaleProvider({ children }: { children: ReactNode }) {
  const authenticated = useRef(false);
  const [locale, changeLocale] = useState<Locale>('ru');
  const setLocale = useCallback((next: Locale, persistAccount = true) => {
    currentLocale = next;
    changeLocale(next);
    localStorage.setItem('dreamwalk-language', next);
    document.documentElement.lang = next;
    if (persistAccount && authenticated.current)
      void fetch('/api/v1/account/settings', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: next }),
      })
        .then(async (response) => {
          if (!response.ok) throw new Error('Locale persistence failed');
          const updatedUser: unknown = await response.json();
          window.dispatchEvent(
            new CustomEvent('dreamwalk:account-updated', { detail: updatedUser }),
          );
        })
        .catch(() => window.dispatchEvent(new Event('dreamwalk:locale-error')));
  }, []);
  useEffect(() => {
    const saved = localStorage.getItem('dreamwalk-language');
    if (saved === 'en' || saved === 'uk' || saved === 'ru') setLocale(saved, false);
  }, [setLocale]);
  useEffect(() => {
    document.title = translate(locale, 'Dreamwalk — истории начинаются с тебя');
    document
      .querySelector('meta[name=description]')
      ?.setAttribute(
        'content',
        translate(
          locale,
          'Открой новый мир, создай героя и расскажи собственную историю. Платформа приключений Dreamwalk.',
        ),
      );
  }, [locale]);
  return (
    <Context.Provider
      value={{
        locale,
        setLocale,
        setAuthenticated: (value) => {
          authenticated.current = value;
        },
        t: (key, params) => translate(locale, key, params),
        taxonomy: (value) => dictionaries[locale][value] ?? value,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useT() {
  return useContext(Context);
}
