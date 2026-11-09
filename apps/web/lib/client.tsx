'use client';
import { SPARKS_REFRESH_EVENT } from './sparks-wallet';
import { useT, getLocale, tr } from './i18n';
import { formatDate } from './locales';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { User, Adventure } from '@dreamwalk/contracts';
export type { User, Adventure, Hero, Asset, Settings } from '@dreamwalk/contracts';
const errorKeys: Record<string, string> = {
  MAP_GRID_RECOVERY_REQUIRED:
    'Игра приостановлена: сначала нужно восстановить проверенную клеточную карту текущей сцены. Изображение и история сохранены.',
  MAP_GRID_REQUIRED:
    'Для начала игры нужна проверенная клеточная карта с позициями персонажей на исходном изображении. Подготовка не завершена.',

  STORY_MAP_COUNT_UNAVAILABLE:
    'Не удалось подсчитать карту для оценки. Генерация не запускалась. Администратору нужно проверить доступ модели к подсчёту токенов.',
  STORY_MAP_COUNT_UNRESOLVED:
    'Результат подсчёта карты ещё не установлен. Генерация не запускалась; повторная отправка остановлена.',
  STORY_MAP_QUOTE_CHANGED: 'Карта или состояние истории изменились. Получи новую оценку.',
  RUNTIME_MAP_COUNT_UNAVAILABLE:
    'Не удалось подсчитать карту для оценки. Генерация не запускалась. Администратору нужно проверить доступ модели к подсчёту токенов.',
  RUNTIME_MAP_COUNT_UNRESOLVED:
    'Результат подсчёта карты ещё не установлен. Генерация не запускалась; повторная отправка остановлена.',
  RUNTIME_MAP_QUOTE_CHANGED: 'Карта или состояние истории изменились. Получи новую оценку.',
  RUNTIME_MAP_CONTEXT_TOO_LARGE:
    'Карта и история превышают допустимое окно запроса. Сократи контекст перед новой оценкой.',
  MAP_IMAGE_SOURCE_CHANGED: 'Карта или права доступа изменились. Получи новую оценку.',

  START_PREPARATION_STALE: 'Оценка стоимости устарела. Получи новую оценку перед запуском.',
  MAP_VISION_POLICY_REQUIRED:
    'Анализ изображений карт пока не настроен. Администратору нужно проверить модель и стоимость.',
  MAP_IMAGE_UNAVAILABLE: 'Сохранённое изображение карты недоступно. Подготовка остановлена.',
  MAP_IMAGE_UNCERTAIN:
    'Не удалось уверенно определить безопасный старт на изображении карты. План не применён.',
  MAP_IMAGE_UNSAFE_SPAWN:
    'Не удалось уверенно определить безопасный старт на изображении карты. План не применён.',
  MAP_IMAGE_PRESENCE_UNSUPPORTED:
    'Не удалось подтвердить размещение персонажей на изображении без раскрытия скрытых сцен. План не применён.',
  MAP_IMAGE_LOCAL_EVIDENCE_REQUIRED:
    'Не удалось уверенно определить участок для старта на изображении. План не применён.',
  MAP_IMAGE_LOCAL_EVIDENCE_CONFLICT: 'Наблюдения карты противоречат друг другу. План не применён.',
  MAP_IMAGE_UNSAFE_NPC:
    'Не удалось уверенно определить безопасный старт на изображении карты. План не применён.',
  MAP_IMAGE_DISCONNECTED_SPAWN:
    'Не удалось уверенно определить безопасный старт на изображении карты. План не применён.',
  MAP_IMAGE_UNSAFE_PASSAGE:
    'Не удалось уверенно определить безопасный старт на изображении карты. План не применён.',
  MAP_IMAGE_SOURCE_MISMATCH: 'План не соответствует сохранённому изображению карты и не применён.',
  MAP_IMAGE_DUPLICATE_GEOMETRY:
    'План не соответствует сохранённому изображению карты и не применён.',

  GENERATION_RELEASE_PROFILE_NOT_ACTIVE:
    'Сервис генерации обновляется. Обнови страницу чуть позже.',
  AUTHORING_QUOTE_EXPIRED: 'Оценка стоимости устарела. Получи новую оценку перед запуском.',
  GENERATION_POLICY_CHANGED:
    'Настройки генерации обновились. Получи новую оценку стоимости перед запуском.',
  GENERATION_PRICING_EXPIRED:
    'Оценка стоимости временно недоступна: администратору нужно обновить тарифы генерации.',
  STORY_PLANNER_UNAVAILABLE:
    'Подготовка истории временно недоступна. Администратору нужно проверить настройки генерации.',
  STORY_MAP_INTENT_MISMATCH:
    'План не соответствует заданным размерам или пропорциям локации и не применён. Проверь описание и форму, затем при необходимости подготовь новый план.',
  IMAGE_SIZE_POLICY_REVIEW_REQUIRED:
    'Размер изображения подготовлен по карте, но ещё не разрешён правилами генерации. Администратору нужно проверить размер и оценку стоимости.',
  MAP_IMAGE_FRAMING_AMBIGUOUS:
    'Не удалось однозначно определить размеры карты. Выбери нужную карту и подготовь изображение снова.',
  IMAGE_FRAMING_DIMENSIONS_MISMATCH:
    'Размер полученного изображения не совпал с подтверждённым. Оно не применено к карте; проверь результат перед новым запросом.',
  TOKEN_INVALID: 'Ссылка недействительна или уже использована. Запроси новую.',
  ASSET_QUOTA_EXCEEDED: 'Достигнут лимит медиатеки: 200 изображений или 100 МБ.',
  DREAMS_RECIPIENT_VERIFICATION_REQUIRED: 'Сначала получатель должен подтвердить почту.',
  SPARKS_RECIPIENT_VERIFICATION_REQUIRED: 'Сначала получатель должен подтвердить почту.',
  EMAIL_VERIFICATION_REQUIRED: 'Подтверди почту, чтобы продолжить.',
  UNAUTHORIZED: 'Войди в аккаунт, чтобы продолжить.',
  FORBIDDEN: 'У тебя нет доступа к этому действию.',
  NOT_FOUND: 'Не удалось найти запрошенные данные.',
  VALIDATION_FAILED: 'Проверь заполненные поля и попробуй ещё раз.',
  STATE_CONFLICT: 'Данные изменились или уже существуют. Обнови страницу и проверь ввод.',
  RATE_LIMITED: 'Слишком много запросов. Подожди немного и повтори.',
  INSUFFICIENT_SPARKS: 'Не хватает Искр',
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
export async function api<T>(
  path: string,
  options: RequestInit = {},
  responseStatus?: (status: { translationPending: boolean }) => void,
): Promise<T> {
  const headers = new Headers(options.headers);
  if (!headers.has('Accept-Language')) headers.set('Accept-Language', getLocale());
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
  if (
    typeof window !== 'undefined' &&
    !['GET', 'HEAD'].includes((options.method ?? 'GET').toUpperCase())
  )
    window.dispatchEvent(new Event(SPARKS_REFRESH_EVENT));
  responseStatus?.({
    translationPending: response.headers.get('X-Dreamwalk-Translation-Pending') === 'true',
  });
  return data as T;
}
export function useResource<T>(path: string | null) {
  const { locale } = useT();
  const readLocale =
    path && /^\/(adventures(?:[/?]|$)|creators\/|library(?:[?]|$)|game\/campaigns\/)/.test(path)
      ? locale
      : null;
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
    let translationRefresh: ReturnType<typeof setTimeout> | undefined;
    setLoading(true);
    setError('');
    const read = (): Promise<void> =>
      api<T>(path, {}, ({ translationPending }) => {
        // Only the server's admitted metadata work requests refresh. No extra
        // generation endpoint, retries, game polling, or stale-locale update.
        if (
          active &&
          translationPending &&
          /^\/(adventures(?:[/?]|$)|creators\/|library(?:[?]|$)|taxonomy(?:[?]|$)|tags(?:[?]|$))/.test(
            path,
          )
        )
          translationRefresh = setTimeout(() => {
            if (active) void read();
          }, 1500);
      })
        .then((value) => {
          if (active) setData(value);
        })
        .catch((e: Error) => {
          if (active) setError(e.message);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    void read();
    return () => {
      active = false;
      if (translationRefresh) clearTimeout(translationRefresh);
    };
  }, [path, version, readLocale]);
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
