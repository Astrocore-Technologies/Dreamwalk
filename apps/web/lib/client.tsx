'use client';
import { useT, getLocale, tr } from './i18n';
import { formatDate } from './locales';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { User, Adventure } from '@dreamwalk/contracts';
export type { User, Adventure, Hero, Asset, Settings } from '@dreamwalk/contracts';
const errorKeys: Record<string, string> = {
  ASSET_QUOTA_EXCEEDED: 'Достигнут лимит медиатеки: 200 изображений или 100 МБ.',
  UNAUTHORIZED: 'Войди в аккаунт, чтобы продолжить.',
  FORBIDDEN: 'У тебя нет доступа к этому действию.',
  NOT_FOUND: 'Не удалось найти запрошенные данные.',
  VALIDATION_FAILED: 'Проверь заполненные поля и попробуй ещё раз.',
  STATE_CONFLICT: 'Данные изменились или уже существуют. Обнови страницу и проверь ввод.',
  RATE_LIMITED: 'Слишком много запросов. Подожди немного и повтори.',
  INSUFFICIENT_CREDITS: 'Недостаточно тестовых искр для этой операции.',
  INTERNAL_ERROR: 'Сервис временно недоступен. Попробуй позже.',
  EMAIL_DELIVERY_UNAVAILABLE:
    'Почтовая доставка не подключена. Восстановление доступа пока недоступно.',
};
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (!(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers,
    credentials: 'include',
  }).catch(() => {
    throw new ApiError(tr('Сервис временно недоступен. Попробуй позже.'), 0, 'NETWORK_ERROR');
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = data as { message?: string; code?: string } | null;
    throw new ApiError(
      tr(errorKeys[error?.code || ''] || 'Не удалось выполнить запрос. Попробуйте ещё раз.'),
      response.status,
      error?.code || 'REQUEST_FAILED',
    );
  }
  return data as T;
}
export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(!!path),
    [version, setVersion] = useState(0);
  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    setError('');
    api<T>(path)
      .then((value) => {
        if (active) setData(value);
      })
      .catch((e: Error) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path, version]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { data, error, loading, reload, setData };
}
type ClientContext = {
  user: User | null;
  loading: boolean;
  refresh: () => Promise<void>;
  setUser: (u: User | null) => void;
  toast: (message: string) => void;
};
const Context = createContext<ClientContext | null>(null);
export function ClientProvider({ children }: { children: ReactNode }) {
  const { setLocale, setAuthenticated, t } = useT();
  const [user, setUser] = useState<User | null>(null),
    [loading, setLoading] = useState(true),
    [message, setMessage] = useState('');
  const refresh = useCallback(async () => {
    try {
      setUser((await api<{ user: User | null }>('/auth/me')).user);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh().catch(() => setLoading(false));
  }, [refresh]);
  useEffect(() => {
    const listener = (event: Event) => {
      const value = (event as CustomEvent<User>).detail;
      if (value?.id && value?.settings) setUser(value);
    };
    window.addEventListener('dreamwalk:account-updated', listener);
    return () => window.removeEventListener('dreamwalk:account-updated', listener);
  }, []);
  useEffect(() => {
    setAuthenticated(!!user);
    if (user?.settings.language) setLocale(user.settings.language, false);
  }, [user, setLocale]);
  useEffect(() => {
    const theme = user?.settings?.theme || localStorage.getItem('dreamwalk-theme') || 'dark';
    const media = matchMedia('(prefers-color-scheme: light)');
    const applyTheme = () => {
      document.documentElement.dataset.theme =
        theme === 'system' ? (media.matches ? 'light' : 'dark') : theme;
    };
    applyTheme();
    if (theme === 'system') media.addEventListener('change', applyTheme);
    document.documentElement.dataset.motion = user?.settings?.reducedMotion ? 'reduced' : 'normal';
    return () => media.removeEventListener('change', applyTheme);
  }, [user]);
  useEffect(() => {
    const listener = () =>
      setMessage(tr('Язык изменён на этом устройстве. Сохранить в аккаунте не удалось.'));
    window.addEventListener('dreamwalk:locale-error', listener);
    return () => window.removeEventListener('dreamwalk:locale-error', listener);
  }, []);
  useEffect(() => {
    if (!message) return;
    const timeout = setTimeout(() => setMessage(''), 4500);
    return () => clearTimeout(timeout);
  }, [message]);
  return (
    <Context.Provider value={{ user, loading, refresh, setUser, toast: setMessage }}>
      {children}
      {message && (
        <div className="toast" role="status">
          {message}
          <button aria-label={t('Закрыть уведомление')} onClick={() => setMessage('')}>
            ×
          </button>
        </div>
      )}
    </Context.Provider>
  );
}
export function useClient() {
  const context = useContext(Context);
  if (!context) throw new Error('ClientProvider required');
  return context;
}
export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : tr('Что-то пошло не так. Попробуйте ещё раз.');
}
export function assetUrl(id?: string | null) {
  return id ? `/api/v1/assets/${id}/file` : undefined;
}
export function coverUrl(adventure: Pick<Adventure, 'cover' | 'coverAssetId'>) {
  return (
    assetUrl(adventure.coverAssetId) ||
    `/images/${adventure.cover === 'sea' ? 'harbor' : adventure.cover || 'observatory'}.webp`
  );
}
export function date(value: string) {
  return formatDate(getLocale(), value);
}

/** Dates follow the authenticated preference, never a mutable render-time global. */
export function useDate() {
  const { user } = useClient();
  const { locale } = useT();
  let timezone = user?.settings.timezone || 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    timezone = 'UTC';
  }
  return (value: string, options: Intl.DateTimeFormatOptions = {}) =>
    formatDate(locale, value, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      ...options,
      timeZone: timezone,
    });
}
