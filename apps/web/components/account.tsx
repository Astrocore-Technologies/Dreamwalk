'use client';
import { useT } from '@/lib/i18n';
import { AccountExports } from './account-exports';
import { EmailVerification } from './account-email';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useEffect, type FormEvent } from 'react';
import { ArrowRight, Fingerprint, Laptop, ShieldCheck, UserRound } from 'lucide-react';
import {
  api,
  useClient,
  useResource,
  errorMessage,
  useDate,
  assetUrl,
  type User,
  type Settings,
} from '@/lib/client';
import {
  Button,
  ButtonLink,
  Empty,
  ErrorBox,
  Field,
  Input,
  Loading,
  Modal,
  PageHeading,
  Panel,
  Select,
  Tabs,
  Textarea,
  Toggle,
  UploadField,
} from './ui';
export function AuthPage({ signup = false, reset = false }: { signup?: boolean; reset?: boolean }) {
  const { t: tr, locale } = useT();
  const router = useRouter();
  const { setUser, toast } = useClient();
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setError('');
    try {
      if (reset) {
        const response = await api<{ code: string }>('/auth/reset-password', {
          method: 'POST',
          body: JSON.stringify(data),
        });
        setResult(
          response.code === 'EMAIL_DELIVERY_UNAVAILABLE'
            ? tr('Почтовая доставка не подключена. Восстановление доступа пока недоступно.')
            : tr(
                'Если такой аккаунт существует, письмо со ссылкой восстановления придёт на его email.',
              ),
        );
      } else {
        const r = await api<{ user: User }>(signup ? '/auth/register' : '/auth/login', {
          method: 'POST',
          body: JSON.stringify(data),
        });
        if (signup) {
          r.user = await api<User>('/account/settings', {
            method: 'PATCH',
            body: JSON.stringify({ language: locale }),
          });
        }
        setUser(r.user);
        toast(signup ? tr('Добро пожаловать в Dreamwalk') : tr('С возвращением'));
        router.push(r.user.onboarded ? '/home' : '/onboarding');
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-layout">
      <div className="auth-art">
        <div className="eyebrow">{tr('ПЕРВАЯ СТРАНИЦА ТВОЕЙ ИСТОРИИ')}</div>
        <h1>
          {tr('Обычный день.')}
          <br />
          <em>
            {tr('Необыкновенное')}
            <br />
            {tr('продолжение.')}
          </em>
        </h1>
        <p>
          {tr('Мир начинается с любопытства.')}
          <br />
          {tr('Осталось открыть дверь.')}
        </p>
        <span className="auth-star">✧</span>
      </div>
      <Panel className="auth-form">
        <span className="eyebrow">{tr('DREAMWALK ACCOUNT')}</span>
        <h2>
          {reset
            ? tr('Восстановить доступ')
            : signup
              ? tr('Начнём знакомство')
              : tr('Рады снова видеть')}
        </h2>
        <p className="muted">
          {reset
            ? tr('Укажи email своего аккаунта.')
            : signup
              ? tr('Один аккаунт — бесконечно много историй.')
              : tr('Твои миры и герои ждут тебя.')}
        </p>
        <form method="post" className="stack" onSubmit={submit}>
          {signup && (
            <>
              <Field label={tr('Как тебя называть?')}>
                <Input
                  name="name"
                  autoComplete="nickname"
                  required
                  minLength={2}
                  maxLength={60}
                  placeholder={tr('Твоё имя')}
                />
              </Field>
              <Field
                label={tr('Адрес профиля')}
                hint={tr('3–30 символов: латинские буквы, цифры и подчёркивание')}
              >
                <Input
                  name="handle"
                  autoComplete="username"
                  required
                  pattern="[a-z0-9_]{3,30}"
                  placeholder="wanderer"
                />
              </Field>
            </>
          )}
          <Field label="Email">
            <Input
              name="email"
              type="email"
              autoComplete="email"
              required
              placeholder="you@example.com"
            />
          </Field>
          {!reset && (
            <Field
              label={tr('Пароль')}
              hint={
                signup
                  ? tr('Не менее 10 символов. Не используй пароль от других сервисов.')
                  : undefined
              }
            >
              <Input
                name="password"
                type="password"
                autoComplete={signup ? 'new-password' : 'current-password'}
                required
                minLength={signup ? 10 : 1}
                maxLength={128}
                placeholder="••••••••••"
              />
            </Field>
          )}
          <ErrorBox message={error} />
          {result && (
            <div className="notice" role="status">
              {result}
            </div>
          )}
          <Button busy={busy}>
            {reset ? tr('Проверить восстановление') : signup ? tr('Создать аккаунт') : tr('Войти')}
            <ArrowRight size={17} />
          </Button>
        </form>
        {!reset && !signup && (
          <Link className="auth-sub-link" href="/auth/reset-password">
            {tr('Не помню пароль')}
          </Link>
        )}
        <div className="auth-switch">
          {signup ? tr('Уже есть аккаунт?') : tr('Впервые здесь?')}{' '}
          <Link href={signup ? '/auth/sign-in' : '/auth/sign-up'}>
            {signup ? tr('Войти') : tr('Создать аккаунт')}
          </Link>
        </div>
        <p className="legal-note">
          {tr('Продолжая, ты принимаешь')} <Link href="/terms">{tr('условия использования')}</Link>{' '}
          {tr('и')} <Link href="/privacy">{tr('правила приватности')}</Link>
          {tr('. Это локальная платформа раннего доступа, без платежей.')}
        </p>
      </Panel>
    </div>
  );
}
export function Protected({
  children,
  admin = false,
}: {
  children: React.ReactNode;
  admin?: boolean;
}) {
  const { t: tr } = useT();
  const { user, loading } = useClient();
  if (loading) return <Loading />;
  if (!user)
    return (
      <Empty
        title={tr('У каждой истории есть имя')}
        description={tr('Войди, чтобы сохранить открытия, создавать героев и работать в студии.')}
        action={
          <div className="row">
            <ButtonLink href="/auth/sign-in">{tr('Войти')}</ButtonLink>
            <ButtonLink href="/auth/sign-up" variant="secondary">
              {tr('Создать аккаунт')}
            </ButtonLink>
          </div>
        }
      />
    );
  if (admin && user.role !== 'admin')
    return (
      <Empty
        title={tr('Этот раздел только для команды')}
        description={tr('Для управления платформой нужны права администратора.')}
        action={<ButtonLink href="/home">{tr('На главную')}</ButtonLink>}
      />
    );
  return children;
}
export function OnboardingPage() {
  const { t: tr, taxonomy } = useT();
  const { user, setUser, toast } = useClient();
  const router = useRouter();
  const [name, setName] = useState(user?.name || ''),
    [purpose, setPurpose] = useState('both'),
    [genres, setGenres] = useState<string[]>([]),
    [profilePublic, setPublic] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <>
      <PageHeading
        eyebrow={tr('ДОБРО ПОЖАЛОВАТЬ')}
        title={tr('Твоя история начинается здесь')}
        description={tr(
          'Немного о тебе — чтобы этот мир стал чуть ближе. Всё можно изменить позже.',
        )}
      />
      <Panel className="form-panel">
        <form
          method="post"
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              setUser(
                await api<User>('/account/onboarding', {
                  method: 'POST',
                  body: JSON.stringify({
                    name,
                    genres,
                    purpose,
                    profilePublic,
                  }),
                }),
              );
              toast(tr('Теперь здесь немного больше тебя'));
              router.push('/home');
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label={tr('Имя')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} />
          </Field>
          <Field label={tr('Что привело тебя сюда?')}>
            <Select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              <option value="both">{tr('Хочу играть и создавать')}</option>
              <option value="play">{tr('Хочу исследовать миры')}</option>
              <option value="create">{tr('Хочу рассказывать истории')}</option>
            </Select>
          </Field>
          <fieldset className="fieldset">
            <legend>{tr('Какие истории тебе ближе?')}</legend>
            <div className="filter-chips">
              {['Фэнтези', 'Тайна', 'Приключения', 'Мистика', 'Научная фантастика'].map((g) => (
                <button
                  type="button"
                  aria-pressed={genres.includes(g)}
                  className={genres.includes(g) ? 'active' : ''}
                  key={g}
                  onClick={() =>
                    setGenres(genres.includes(g) ? genres.filter((v) => v !== g) : [...genres, g])
                  }
                >
                  {taxonomy(g)}
                </button>
              ))}
            </div>
          </fieldset>
          <Toggle
            label={tr('Публичный профиль')}
            description={tr('Другие смогут увидеть твоё имя, описание и опубликованные истории.')}
            checked={profilePublic}
            onChange={setPublic}
          />
          <ErrorBox message={error} />
          <Button busy={busy}>
            {tr('Открыть Dreamwalk')}
            <ArrowRight size={17} />
          </Button>
        </form>
      </Panel>
    </>
  );
}
export function AccountPage({ path }: { path: string }) {
  const { t: tr } = useT();
  const tab = path.split('/')[2] || 'profile';
  return (
    <>
      <PageHeading
        eyebrow={tr('ТВОЁ ПРОСТРАНСТВО')}
        title={tr('Настроить под себя')}
        description={tr('Имя, привычки и границы. Здесь всё по-твоему.')}
      />
      <Tabs
        items={[
          ['profile', tr('Профиль')],
          ['settings', tr('Предпочтения')],
          ['privacy', tr('Приватность')],
          ['sessions', tr('Безопасность')],
        ].map(([key, label]) => ({
          href: `/account/${key}`,
          label,
          active: tab === key,
        }))}
      />
      {tab === 'profile' ? (
        <ProfileForm />
      ) : tab === 'sessions' ? (
        <SecurityForm />
      ) : (
        <SettingsForm key={tab} privacy={tab === 'privacy'} />
      )}
    </>
  );
}
function ProfileForm() {
  const { t: tr } = useT();
  const { user, setUser, toast } = useClient();
  const [name, setName] = useState(user?.name || ''),
    [handle, setHandle] = useState(user?.handle || ''),
    [bio, setBio] = useState(user?.bio || ''),
    [avatar, setAvatar] = useState(user?.avatarAssetId),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <div className="account-layout">
      <Panel>
        <h2>{tr('Так тебя увидят другие')}</h2>
        <form
          method="post"
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              setUser(
                await api<User>('/account/profile', {
                  method: 'PATCH',
                  body: JSON.stringify({
                    name,
                    handle,
                    bio,
                    avatarAssetId: avatar || null,
                  }),
                }),
              );
              toast(tr('Профиль сохранён'));
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="profile-upload">
            <span className="avatar large">
              {avatar ? <img alt={tr('Аватар')} src={assetUrl(avatar)} /> : name[0]}
            </span>
            <UploadField label={tr('Изменить аватар')} onUploaded={(a) => setAvatar(a.id)} />
          </div>
          <div className="field-grid">
            <Field label={tr('Имя')}>
              <Input
                required
                minLength={2}
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label={tr('Адрес профиля')}>
              <Input
                required
                pattern="[a-z0-9_]{3,30}"
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
              />
            </Field>
          </div>
          <Field
            label={tr('О себе')}
            hint={tr('Необязательно рассказывать всё. Пара слов — уже начало.')}
          >
            <Textarea
              maxLength={2000}
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder={tr('Исследую неизведанные миры и собираю истории…')}
            />
          </Field>
          <ErrorBox message={error} />
          <div className="form-actions">
            <Button busy={busy}>{tr('Сохранить профиль')}</Button>
          </div>
        </form>
      </Panel>
      <Panel className="quiet-panel">
        <UserRound size={28} />
        <h3>{tr('Это ты. А герой — отдельная история.')}</h3>
        <p>
          {tr(
            'Профиль представляет тебя на платформе. Для будущих приключений можно создавать отдельных героев.',
          )}
        </p>
        <ButtonLink href="/my-characters" variant="secondary">
          {tr('Мои герои')}
          <ArrowRight size={16} />
        </ButtonLink>
      </Panel>
    </div>
  );
}
function SettingsForm({ privacy }: { privacy: boolean }) {
  const { t: tr } = useT();
  const { user, setUser, toast } = useClient();
  const [settings, setSettings] = useState<Settings>(user!.settings),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [deleting, setDeleting] = useState(false),
    [confirmation, setConfirmation] = useState(''),
    [password, setPassword] = useState('');
  const router = useRouter();
  useEffect(() => {
    if (user)
      setSettings((previous) => ({
        ...previous,
        language: user.settings.language,
        theme: user.settings.theme,
      }));
  }, [user?.settings.language, user?.settings.theme]);
  function change<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings({ ...settings, [key]: value });
  }
  return (
    <>
      <Panel className="form-panel">
        <form
          method="post"
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              setUser(
                await api<User>('/account/settings', {
                  method: 'PATCH',
                  body: JSON.stringify(settings),
                }),
              );
              toast(tr('Настройки сохранены'));
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2>{privacy ? tr('Твои границы') : tr('Маленькие детали, большой комфорт')}</h2>
          {privacy ? (
            <>
              <Toggle
                label={tr('Публичный профиль')}
                description={tr('Имя, описание и опубликованные истории доступны другим.')}
                checked={settings.profilePublic}
                onChange={(v) => change('profilePublic', v)}
              />
              <Field label={tr('Видимость нового контента')}>
                <Select
                  value={settings.defaultVisibility}
                  onChange={(e) =>
                    change('defaultVisibility', e.target.value as Settings['defaultVisibility'])
                  }
                >
                  <option value="private">{tr('Приватно: только по приглашению')}</option>
                  <option value="public">{tr('Публично после модерации')}</option>
                </Select>
              </Field>
              <div className="notice">
                {tr(
                  'Новые приключения не попадут в каталог без твоей отправки на модерацию и проверки командой.',
                )}
              </div>
            </>
          ) : (
            <>
              <div className="field-grid">
                <Field label={tr('Тема')}>
                  <Select
                    value={settings.theme}
                    onChange={(e) => change('theme', e.target.value as Settings['theme'])}
                  >
                    <option value="dark">{tr('Тёмная · сумерки')}</option>
                    <option value="light">{tr('Светлая · рассвет')}</option>
                    <option value="system">{tr('Как на устройстве')}</option>
                  </Select>
                </Field>
                <Field label={tr('Язык интерфейса')}>
                  <Select
                    value={settings.language}
                    onChange={(e) => change('language', e.target.value as Settings['language'])}
                  >
                    <option value="ru">Русский</option>
                    <option value="uk">Українська</option>
                    <option value="en">English</option>
                  </Select>
                </Field>
                <Field label={tr('Часовой пояс')}>
                  <Input
                    value={settings.timezone}
                    maxLength={100}
                    onChange={(e) => change('timezone', e.target.value)}
                  />
                </Field>
                <Field label={tr('Длина будущих ответов')}>
                  <Select
                    value={settings.replyLength}
                    onChange={(e) =>
                      change('replyLength', e.target.value as Settings['replyLength'])
                    }
                  >
                    <option value="short">{tr('Коротко')}</option>
                    <option value="balanced">{tr('Сбалансированно')}</option>
                    <option value="long">{tr('Подробно')}</option>
                  </Select>
                </Field>
              </div>
              <Toggle
                label={tr('Меньше анимации')}
                description={tr('Спокойные переходы и минимум движения.')}
                checked={settings.reducedMotion}
                onChange={(v) => change('reducedMotion', v)}
              />
              <Toggle
                label={tr('Системные уведомления')}
                checked={settings.notifications}
                onChange={(v) => change('notifications', v)}
              />
              <Toggle
                label={tr('Письма на email')}
                description={tr('Предпочтение сохраняется. Почтовая доставка пока не подключена.')}
                checked={settings.emailNotifications}
                onChange={(v) => change('emailNotifications', v)}
              />
              <Toggle
                label={tr('Уведомлять о публикациях')}
                checked={settings.publicationNotifications}
                onChange={(v) => change('publicationNotifications', v)}
              />
              <Toggle
                label={tr('Уведомлять о жалобах')}
                checked={settings.reportNotifications}
                onChange={(v) => change('reportNotifications', v)}
              />
              <Toggle
                label={tr('Показывать подсказки о стоимости')}
                checked={settings.costHints}
                onChange={(v) => change('costHints', v)}
              />
              <Toggle
                label={tr('Подтверждать дорогие действия')}
                description={tr('Настройка для будущей игры. Сейчас платные действия отключены.')}
                checked={settings.confirmExpensive}
                onChange={(v) => change('confirmExpensive', v)}
              />
            </>
          )}
          <ErrorBox message={error} />
          <div className="form-actions">
            <Button busy={busy}>{tr('Сохранить настройки')}</Button>
          </div>
        </form>
      </Panel>
      {privacy && (
        <Panel className="form-panel">
          <h2>{tr('Управление данными')}</h2>
          <AccountExports />
          <div className="row">
            <Button variant="danger" onClick={() => setDeleting(true)}>
              {tr('Удалить аккаунт')}
            </Button>
          </div>
        </Panel>
      )}
      {deleting && (
        <Modal title={tr('Удалить аккаунт?')} onClose={() => setDeleting(false)}>
          <p className="muted">
            {tr(
              'Вход будет закрыт, активные сессии завершатся, личные данные будут обезличены. Опубликованные версии и минимальный аудит могут сохраняться без твоего имени.',
            )}
          </p>
          <form
            method="post"
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                await api('/account', {
                  method: 'DELETE',
                  body: JSON.stringify({ password, confirmation }),
                });
                setUser(null);
                router.push('/');
                toast(tr('Аккаунт удалён'));
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label={tr('Текущий пароль')}>
              <Input
                required
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field label={tr('Введи DELETE для подтверждения')}>
              <Input
                required
                value={confirmation}
                onChange={(e) => setConfirmation(e.target.value)}
              />
            </Field>
            <ErrorBox message={error} />
            <div className="form-actions">
              <Button type="button" variant="secondary" onClick={() => setDeleting(false)}>
                {tr('Отмена')}
              </Button>
              <Button variant="danger" disabled={confirmation !== 'DELETE'} busy={busy}>
                {tr('Удалить навсегда')}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
function SecurityForm() {
  const date = useDate();
  const { t: tr } = useT();
  const { toast, refresh } = useClient();
  const sessions = useResource<
    {
      id: string;
      createdAt: string;
      lastSeenAt: string;
      userAgent: string;
      current: boolean;
    }[]
  >('/account/sessions');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <div className="account-layout">
      <EmailVerification />
      <Panel>
        <h2>
          <Fingerprint size={22} />
          {tr('Сменить пароль')}
        </h2>
        <form
          method="post"
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            const form = e.currentTarget;
            setBusy(true);
            try {
              await api('/account/password', {
                method: 'POST',
                body: JSON.stringify(Object.fromEntries(new FormData(form))),
              });
              toast(tr('Пароль изменён. Другие сессии завершены.'));
              form.reset();
              sessions.reload();
            } catch (e) {
              setError(errorMessage(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label={tr('Текущий пароль')}>
            <Input
              type="password"
              name="currentPassword"
              autoComplete="current-password"
              required
            />
          </Field>
          <Field label={tr('Новый пароль')}>
            <Input
              type="password"
              name="newPassword"
              minLength={10}
              maxLength={128}
              autoComplete="new-password"
              required
            />
          </Field>
          <ErrorBox message={error} />
          <Button busy={busy}>{tr('Изменить пароль')}</Button>
        </form>
      </Panel>
      <Panel>
        <h2>
          <ShieldCheck size={22} />
          {tr('Активные сессии')}
        </h2>
        <p className="muted">{tr('Не узнаёшь устройство? Заверши его сеанс.')}</p>
        <ErrorBox message={sessions.error} retry={sessions.reload} />
        {sessions.loading ? (
          <Loading />
        ) : (
          sessions.data?.map((s) => (
            <div className="session-row" key={s.id}>
              <Laptop size={24} />
              <div>
                <strong>{s.current ? tr('Это устройство') : tr('Браузер')}</strong>
                <small title={s.userAgent}>{s.userAgent.slice(0, 65)}</small>
                <small>
                  {tr('Последняя активность: {date}', {
                    date: date(s.lastSeenAt),
                  })}
                </small>
              </div>
              <Button
                variant="ghost"
                onClick={async () => {
                  try {
                    await api(`/account/sessions/${s.id}`, {
                      method: 'DELETE',
                      body: '{}',
                    });
                    sessions.reload();
                    await refresh();
                    toast(tr('Сессия завершена'));
                  } catch (e) {
                    toast(errorMessage(e));
                  }
                }}
              >
                {tr('Завершить')}
              </Button>
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}
