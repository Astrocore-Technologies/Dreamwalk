'use client';
import { selectAdventureText, selectNpcText } from '@dreamwalk/contracts';
import { useT } from '@/lib/i18n';
import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import {
  Activity,
  ArrowRight,
  BookOpen,
  Check,
  ClipboardList,
  Coins,
  Layers,
  LockKeyhole,
  Plus,
  Search,
  Settings2,
  Shield,
  Users,
  X,
} from 'lucide-react';
import type {
  Adventure,
  ControlledTag,
  ModelProfile,
  Npc,
  RuntimeProfile,
  User,
  Wallet,
} from '@dreamwalk/contracts';
import { api, useDate, errorMessage, useClient, useResource } from '@/lib/client';
import {
  Badge,
  Button,
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
} from './ui';
import styles from './studio/admin.module.css';

type Report = {
  id: string;
  adventureId: string;
  reason: string;
  status: string;
  resolution?: string;
  createdAt: string;
  reporterId?: string;
};
type AuditEntry = {
  id: string;
  actorId: string | null;
  actorName?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  details?: unknown;
  createdAt: string;
};
const statusLabel: Record<string, string> = {
  draft: 'Черновик',
  pending_review: 'На проверке',
  published: 'Опубликовано',
  archived: 'Архив',
  open: 'Открыта',
  resolved: 'Решена',
  dismissed: 'Отклонена',
};
const actionLabels: Record<string, string> = {
  'operator.local_admin_grant': 'Права администратора выданы локальным оператором',
  'adventure.submit': 'История отправлена на проверку',
  'adventure.visibility': 'Режим публикации изменён',
  'adventure.approve': 'История опубликована',
  'adventure.reject': 'История возвращена автору',
  'adventure.quarantine': 'История помещена в карантин',
  'model.create': 'Поведенческий профиль создан',
  'model.update': 'Поведенческий профиль обновлён',
  'runtime.create': 'Runtime-конфигурация создана',
  'runtime.update': 'Runtime-конфигурация обновлена',
  'report.resolve': 'Жалоба рассмотрена',
  'taxonomy.update': 'Справочник обновлён',
  'user.role': 'Роль пользователя изменена',
  'wallet.adjust': 'Demo-баланс скорректирован',
};
const links = [
  { href: '/admin', label: 'Обзор' },
  { href: '/admin/users', label: 'Пользователи' },
  { href: '/admin/adventures', label: 'Контент' },
  { href: '/admin/reports', label: 'Жалобы' },
  { href: '/admin/taxonomy', label: 'Жанры и теги' },
  { href: '/admin/models', label: 'Модели' },
  { href: '/admin/credits', label: 'Искры' },
  { href: '/admin/audit', label: 'Аудит' },
];
export function AdminPage({ path }: { path: string }) {
  const { t } = useT();
  const { user, loading } = useClient();
  if (loading) return <Loading />;
  if (user?.role !== 'admin')
    return (
      <Empty
        title={t('Доступ только администраторам')}
        description={t(
          'Этот раздел защищён серверной проверкой роли. Обычные пользователи не могут управлять публикациями, моделями или балансами.',
        )}
        action={
          <Link className="button secondary" href="/home">
            {t('На главную')}
          </Link>
        }
      />
    );
  return (
    <>
      <PageHeading
        eyebrow={t('DREAMWALK / УПРАВЛЕНИЕ')}
        title={t('Панель администратора')}
        description={t('Люди, истории и границы платформы. Все изменения фиксируются в журнале.')}
      />
      <Tabs
        items={links.map((l) => ({
          ...l,
          label: t(l.label),
          active: path === l.href,
        }))}
      />
      <div className="notice">
        <LockKeyhole size={17} />
        {t(
          'Закрытый тест платформы · AI и реальные платежи отключены · Секретные ключи не вводятся через интерфейс',
        )}
      </div>
      {path === '/admin/users' ? (
        <AdminUsers />
      ) : path === '/admin/adventures' ? (
        <AdminContent />
      ) : path === '/admin/reports' ? (
        <AdminReports />
      ) : path === '/admin/taxonomy' ? (
        <AdminTaxonomy />
      ) : path === '/admin/models' ? (
        <AdminModels />
      ) : path === '/admin/credits' ? (
        <AdminCredits />
      ) : path === '/admin/audit' ? (
        <AdminAudit />
      ) : (
        <AdminOverview />
      )}
    </>
  );
}
function AdminOverview() {
  const { t } = useT();
  const overview = useResource<{
    users: number;
    adventures: number;
    pendingReview: number;
    openReports: number;
  }>('/admin/overview');
  return (
    <>
      <ErrorBox message={overview.error} retry={overview.reload} />
      {overview.loading ? (
        <Loading />
      ) : (
        overview.data && (
          <div className={styles.stats}>
            {[
              {
                label: t('Пользователей'),
                value: overview.data.users,
                icon: Users,
                href: '/admin/users',
              },
              {
                label: t('Приключений'),
                value: overview.data.adventures,
                icon: BookOpen,
                href: '/admin/adventures',
              },
              {
                label: t('На модерации'),
                value: overview.data.pendingReview,
                icon: Shield,
                href: '/admin/adventures',
              },
              {
                label: t('Открытых жалоб'),
                value: overview.data.openReports,
                icon: ClipboardList,
                href: '/admin/reports',
              },
            ].map((item) => (
              <Link key={item.label} href={item.href} className={styles.stat}>
                <item.icon size={20} />
                <strong>{item.value}</strong>
                <span>{item.label}</span>
                <ArrowRight size={16} />
              </Link>
            ))}
          </div>
        )
      )}
      <div className={styles.overviewGrid}>
        <Panel>
          <div className={styles.sectionHeading}>
            <Shield size={22} />
            <h2>{t('Безопасная публикация')}</h2>
          </div>
          <p className="muted">
            {t(
              'Черновики не попадают в каталог автоматически. Проверяйте мир, предупреждения и персонажей перед одобрением. Отклонение сопровождается понятной автору причиной.',
            )}
          </p>
          <Link className="text-link" href="/admin/adventures">
            {t('Открыть очередь')}
            <ArrowRight size={16} />
          </Link>
        </Panel>
        <Panel>
          <div className={styles.sectionHeading}>
            <Layers size={22} />
            <h2>{t('Стиль не равен модели')}</h2>
          </div>
          <p className="muted">
            {t(
              'Green Apple и Cookie задают поведение. Runtime-профиль описывает техническую конфигурацию. В этой версии доступны только тестовые сценарии, без внешних вызовов.',
            )}
          </p>
          <Link className="text-link" href="/admin/models">
            {t('Каталог профилей')}
            <ArrowRight size={16} />
          </Link>
        </Panel>
      </div>
    </>
  );
}
function AdminUsers() {
  const date = useDate();
  const { t } = useT();
  const { user, toast } = useClient(),
    [query, setQuery] = useState(''),
    [search, setSearch] = useState(''),
    users = useResource<User[]>(`/admin/users?q=${encodeURIComponent(search)}`),
    [target, setTarget] = useState<User | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function changeRole() {
    if (!target) return;
    setBusy(true);
    setError('');
    try {
      await api(`/admin/users/${target.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          role: target.role === 'admin' ? 'user' : 'admin',
        }),
      });
      toast(t('Роль обновлена'));
      setTarget(null);
      users.reload();
    } catch (e) {
      setError(t(errorMessage(e)));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className={styles.sectionHeading}>
        <Users size={22} />
        <h2>{t('Пользователи')}</h2>
      </div>
      <form
        method="post"
        className={styles.search}
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(query);
        }}
      >
        <Input
          aria-label={t('Поиск пользователей')}
          placeholder={t('Имя, handle или email')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" variant="secondary">
          <Search size={16} />
          {t('Найти')}
        </Button>
      </form>
      <ErrorBox message={users.error} retry={users.reload} />
      {users.loading ? (
        <Loading />
      ) : users.data?.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('Пользователь')}</th>
                <th>{t('Контакт')}</th>
                <th>{t('Роль')}</th>
                <th>{t('Создан')}</th>
                <th>{t('Действие')}</th>
              </tr>
            </thead>
            <tbody>
              {users.data.map((u) => (
                <tr key={u.id}>
                  <td>
                    <strong>{u.name}</strong>
                    <small className={styles.secondary}>@{u.handle}</small>
                  </td>
                  <td>{u.email}</td>
                  <td>
                    <Badge tone={u.role === 'admin' ? 'green' : ''}>
                      {u.role === 'admin' ? t('Администратор') : t('Пользователь')}
                    </Badge>
                  </td>
                  <td>{date(u.createdAt)}</td>
                  <td>
                    <Button
                      variant="ghost"
                      disabled={u.id === user?.id}
                      onClick={() => {
                        setError('');
                        setTarget(u);
                      }}
                    >
                      {u.id === user?.id ? t('Это вы') : t('Изменить роль')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !users.error && (
          <Empty title={t('Никого не найдено')} description={t('Попробуйте другой запрос.')} />
        )
      )}
      {target && (
        <Modal title={t('Изменить роль пользователя?')} onClose={() => setTarget(null)}>
          <p>
            <strong>{target.name}</strong> {t(' получит роль «')}
            {target.role === 'admin' ? t('Пользователь') : t('Администратор')}».
          </p>
          {target.role !== 'admin' && (
            <div className="notice">
              {t(
                'Администратор может управлять публикациями, пользователями и тестовой валютой. Предоставляйте эту роль только доверенным людям.',
              )}
            </div>
          )}
          <ErrorBox message={error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setTarget(null)}>
              {t('Отмена')}
            </Button>
            <Button busy={busy} onClick={() => void changeRole()}>
              {t('Подтвердить')}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

function AdminContent() {
  const date = useDate();
  const { t, locale } = useT();
  const [tab, setTab] = useState<'adventures' | 'npcs'>('adventures'),
    [filter, setFilter] = useState('pending_review'),
    [query, setQuery] = useState('');
  const adventures = useResource<Adventure[]>(
      `/admin/adventures${filter ? `?status=${filter}` : ''}`,
    ),
    npcs = useResource<Npc[]>(tab === 'npcs' ? '/admin/npcs' : null),
    [target, setTarget] = useState<Adventure | null>(null),
    [decision, setDecision] = useState<'approve' | 'reject' | 'quarantine'>('approve'),
    [reason, setReason] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    { toast } = useClient();
  async function moderate(e: FormEvent) {
    e.preventDefault();
    if (!target) return;
    setBusy(true);
    setError('');
    try {
      await api(`/admin/adventures/${target.id}/moderate`, {
        method: 'POST',
        body: JSON.stringify({ decision, reason }),
      });
      toast(t('Решение сохранено в журнале'));
      setTarget(null);
      adventures.reload();
    } catch (e) {
      setError(t(errorMessage(e)));
    } finally {
      setBusy(false);
    }
  }
  const filtered = (adventures.data || []).filter((a) =>
    (a.title + ' ' + selectAdventureText(a, locale).title + ' ' + a.author?.name)
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      <div className={styles.sectionHeading}>
        <Shield size={22} />
        <h2>{t('Модерация контента')}</h2>
      </div>
      <div className="row">
        <Button
          variant={tab === 'adventures' ? 'primary' : 'secondary'}
          onClick={() => setTab('adventures')}
        >
          {t('Приключения')}
        </Button>
        <Button variant={tab === 'npcs' ? 'primary' : 'secondary'} onClick={() => setTab('npcs')}>
          NPC
        </Button>
      </div>
      <div className={styles.filters}>
        <Input
          aria-label={t('Поиск контента')}
          placeholder={t('Поиск по названию или автору')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {tab === 'adventures' && (
          <Select
            aria-label={t('Статус публикации')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="pending_review">{t('На проверке')}</option>
            <option value="published">{t('Опубликовано')}</option>
            <option value="draft">{t('Черновики')}</option>
            <option value="archived">{t('Архив')}</option>
            <option value="">{t('Все статусы')}</option>
          </Select>
        )}
      </div>
      {tab === 'adventures' ? (
        <>
          <ErrorBox message={adventures.error} retry={adventures.reload} />
          {adventures.loading ? (
            <Loading />
          ) : filtered.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('Приключение')}</th>
                    <th>{t('Автор')}</th>
                    <th>{t('Статус')}</th>
                    <th>{t('Изменено')}</th>
                    <th>{t('Проверка')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <strong>{selectAdventureText(a, locale).title}</strong>
                        <small className={styles.secondary}>
                          {a.genre} {t(' · версия ')}
                          {a.version || '—'}
                        </small>
                      </td>
                      <td>{a.author?.name || a.ownerId}</td>
                      <td>
                        <Badge>{t(statusLabel[a.status])}</Badge>
                      </td>
                      <td>{date(a.updatedAt)}</td>
                      <td>
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setTarget(a);
                            setReason('');
                            setDecision(
                              a.status === 'pending_review'
                                ? 'approve'
                                : a.status === 'published'
                                  ? 'quarantine'
                                  : 'reject',
                            );
                            setError('');
                          }}
                        >
                          {t('Рассмотреть')}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            !adventures.error && (
              <Empty
                title={t('Очередь свободна')}
                description={t(
                  'Здесь появятся истории выбранного статуса. Все решения сохраняются в аудите.',
                )}
              />
            )
          )}
        </>
      ) : (
        <>
          <ErrorBox message={npcs.error} retry={npcs.reload} />
          {npcs.loading ? (
            <Loading />
          ) : (
            <div className={styles.modelList}>
              {npcs.data
                ?.filter((n) =>
                  (
                    n.name +
                    ' ' +
                    n.role +
                    ' ' +
                    selectNpcText(n, locale).name +
                    ' ' +
                    selectNpcText(n, locale).role
                  )
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .map((n) => (
                  <Panel key={n.id}>
                    <div className="row">
                      <h3>{selectNpcText(n, locale).name}</h3>
                      <Badge>{t('Личный')}</Badge>
                    </div>
                    <p className="muted">
                      {selectNpcText(n, locale).role} · {n.age} {t(' лет')}
                    </p>
                    {selectNpcText(n, locale).description && (
                      <p>{selectNpcText(n, locale).description}</p>
                    )}
                    <details>
                      <summary>{t('Просмотреть содержание')}</summary>
                      <div className="stack">
                        <p>
                          <strong>{t('Характер:')}</strong> {selectNpcText(n, locale).personality}
                        </p>
                        <p>
                          <strong>{t('Биография:')}</strong> {n.biography}
                        </p>
                        <p>
                          <strong>{t('Приветствие:')}</strong> {selectNpcText(n, locale).greeting}
                        </p>
                        <p>
                          <strong>{t('Закрытые знания:')}</strong> {n.secrets}
                        </p>
                      </div>
                    </details>
                  </Panel>
                ))}
            </div>
          )}
        </>
      )}
      {target && (
        <Modal
          title={t('Проверка: {title}', { title: target.title })}
          onClose={() => setTarget(null)}
        >
          <div className={styles.reviewContent}>
            <Badge>{t(statusLabel[target.status])}</Badge>
            <p className="muted">
              {t('Оригинал')} · {(target.sourceLanguage || 'ru').toUpperCase()}
            </p>
            <p>{target.synopsis}</p>
            <p>
              {t('Теги')}: {target.tags.join(' · ')}
            </p>
            {Object.entries(target.translations || {}).some(
              ([, entry]) => entry?.sourceRevision === target.sourceRevision,
            ) && (
              <details>
                <summary>{t('Переводы метаданных')}</summary>
                {(['uk', 'en', 'ru'] as const).map((language) => {
                  const translation = target.translations?.[language];
                  if (!translation || translation.sourceRevision !== target.sourceRevision)
                    return null;
                  const text = selectAdventureText(target, language);
                  return (
                    <section key={language}>
                      <Badge>
                        {language.toUpperCase()} · {t('Актуальный перевод')}
                      </Badge>
                      <h4>{text.title}</h4>
                      <p>{text.synopsis}</p>
                      <p>
                        {t('Теги')}:{' '}
                        {Object.entries(translation.tags ?? {})
                          .map(([original, label]) => `${original} → ${label}`)
                          .join(' · ')}
                      </p>
                    </section>
                  );
                })}
              </details>
            )}
            <details open>
              <summary>{t('Мир и правила')}</summary>
              <p>{target.content.world}</p>
              <p>{target.content.rules}</p>
            </details>
            <details>
              <summary>{t('Локации и сцены')}</summary>
              {target.content.locations.map((l) => (
                <div key={l.id}>
                  <h4>{l.name}</h4>
                  <p>{l.description}</p>
                </div>
              ))}
              {target.content.scenes.map((s) => (
                <div key={s.id}>
                  <h4>{s.name}</h4>
                  <p>{s.description}</p>
                </div>
              ))}
            </details>
            <p>
              <strong>{t('Предупреждения:')}</strong>{' '}
              {target.content.boundaries.join(', ') || t('Не указаны')}
            </p>
            <p className="muted">
              NPC: {target.content.npcIds.length}
              {t('. Содержимое персонажей можно проверить в отдельной вкладке NPC.')}
            </p>
          </div>
          <form method="post" className="stack" onSubmit={(e) => void moderate(e)}>
            <Field label={t('Решение')}>
              <Select
                value={decision}
                onChange={(e) => setDecision(e.target.value as typeof decision)}
              >
                <option
                  value="approve"
                  disabled={target.status !== 'pending_review' || target.visibility !== 'public'}
                >
                  {t('Одобрить и опубликовать версию')}
                </option>
                <option value="reject">{t('Вернуть автору на доработку')}</option>
                <option value="quarantine">{t('Убрать из каталога (карантин)')}</option>
              </Select>
            </Field>
            <Field label={t('Причина решения')}>
              <Textarea
                required
                minLength={3}
                maxLength={2000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('Что проверено или что нужно исправить?')}
              />
            </Field>
            <ErrorBox message={error} />
            <div className="form-actions">
              <Button variant="secondary" type="button" onClick={() => setTarget(null)}>
                {t('Отмена')}
              </Button>
              <Button busy={busy} type="submit">
                {t('Сохранить решение')}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

function AdminReports() {
  const date = useDate();
  const { t } = useT();
  const reports = useResource<Report[]>('/admin/reports'),
    [target, setTarget] = useState<Report | null>(null),
    [resolution, setResolution] = useState(''),
    [status, setStatus] = useState<'resolved' | 'dismissed'>('resolved'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    { toast } = useClient();
  async function resolve(e: FormEvent) {
    e.preventDefault();
    if (!target) return;
    setBusy(true);
    setError('');
    try {
      await api(`/admin/reports/${target.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status, resolution }),
      });
      toast(t('Жалоба обработана'));
      setTarget(null);
      reports.reload();
    } catch (e) {
      setError(t(errorMessage(e)));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className={styles.sectionHeading}>
        <ClipboardList size={22} />
        <h2>{t('Жалобы пользователей')}</h2>
      </div>
      <ErrorBox message={reports.error} retry={reports.reload} />
      {reports.loading ? (
        <Loading />
      ) : reports.data?.length ? (
        <div className={styles.modelList}>
          {reports.data.map((r) => (
            <Panel key={r.id}>
              <div className="row">
                <Badge>{t(statusLabel[r.status] || r.status)}</Badge>
                <small className="muted">{date(r.createdAt)}</small>
              </div>
              <p>{r.reason}</p>
              <small className={styles.secondary}>
                {t('История: ')}
                {r.adventureId}
              </small>
              {r.resolution && (
                <p className="muted">
                  {t('Решение: ')}
                  {r.resolution}
                </p>
              )}
              <Button
                variant="secondary"
                disabled={r.status !== 'open'}
                onClick={() => {
                  setTarget(r);
                  setError('');
                  setResolution('');
                }}
              >
                {t('Рассмотреть жалобу')}
              </Button>
            </Panel>
          ))}
        </div>
      ) : (
        !reports.error && (
          <Empty
            title={t('Пока без жалоб')}
            description={t(
              'Обращения пользователей появятся здесь. Решение по жалобе не заменяет отдельную модерацию публикации.',
            )}
          />
        )
      )}
      {target && (
        <Modal title={t('Решение по жалобе')} onClose={() => setTarget(null)}>
          <p>{target.reason}</p>
          <form method="post" className="stack" onSubmit={(e) => void resolve(e)}>
            <Field label={t('Результат')}>
              <Select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                <option value="resolved">{t('Проблема рассмотрена и решена')}</option>
                <option value="dismissed">{t('Отклонить жалобу с объяснением')}</option>
              </Select>
            </Field>
            <Field label={t('Объяснение решения')}>
              <Textarea
                required
                minLength={3}
                maxLength={2000}
                value={resolution}
                onChange={(e) => setResolution(e.target.value)}
              />
            </Field>
            <div className="notice">
              {t(
                'Если историю нужно скрыть, отдельно отправьте её в карантин на вкладке «Контент».',
              )}
            </div>
            <ErrorBox message={error} />
            <div className="form-actions">
              <Button variant="secondary" type="button" onClick={() => setTarget(null)}>
                {t('Отмена')}
              </Button>
              <Button type="submit" busy={busy}>
                {t('Сохранить')}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

type ModelDraft = Pick<ModelProfile, 'key' | 'name' | 'description' | 'instructions' | 'enabled'>;
type RuntimeDraft = Pick<
  RuntimeProfile,
  | 'name'
  | 'provider'
  | 'model'
  | 'enabled'
  | 'endpointId'
  | 'maxInputTokens'
  | 'maxOutputTokens'
  | 'timeoutMs'
  | 'concurrency'
>;
const blankModel: ModelDraft = {
  key: '',
  name: '',
  description: '',
  instructions: '',
  enabled: true,
};
const blankRuntime: RuntimeDraft = {
  name: '',
  provider: 'mock',
  model: 'mock-narrative',
  enabled: false,
  endpointId: 'mock',
  maxInputTokens: 16000,
  maxOutputTokens: 2000,
  timeoutMs: 30000,
  concurrency: 1,
};
function AdminModels() {
  const { t, locale } = useT();
  const models = useResource<ModelProfile[]>('/admin/models'),
    runtimes = useResource<RuntimeProfile[]>('/admin/runtimes'),
    [kind, setKind] = useState<'model' | 'runtime' | null>(null),
    [editId, setEditId] = useState<string | null>(null),
    [model, setModel] = useState<ModelDraft>(blankModel),
    [runtime, setRuntime] = useState<RuntimeDraft>(blankRuntime),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    { toast } = useClient();
  function openModel(item?: ModelProfile) {
    setKind('model');
    setEditId(item?.id || null);
    setModel(
      item
        ? {
            key: item.key,
            name: item.name,
            description: item.description,
            instructions: item.instructions,
            enabled: item.enabled,
          }
        : blankModel,
    );
    setError('');
  }
  function openRuntime(item?: RuntimeProfile) {
    setKind('runtime');
    setEditId(item?.id || null);
    setRuntime(
      item
        ? {
            name: item.name,
            provider: item.provider,
            model: item.model,
            enabled: item.enabled,
            endpointId: item.endpointId,
            maxInputTokens: item.maxInputTokens,
            maxOutputTokens: item.maxOutputTokens,
            timeoutMs: item.timeoutMs,
            concurrency: item.concurrency,
          }
        : blankRuntime,
    );
    setError('');
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/admin/${kind === 'model' ? 'models' : 'runtimes'}${editId ? `/${editId}` : ''}`, {
        method: editId ? 'PATCH' : 'POST',
        body: JSON.stringify(kind === 'model' ? model : runtime),
      });
      toast(kind === 'model' ? t('Версия профиля сохранена') : t('Конфигурация сохранена'));
      setKind(null);
      models.reload();
      runtimes.reload();
    } catch (e) {
      setError(t(errorMessage(e)));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className={styles.sectionHeading}>
        <Layers size={22} />
        <h2>{t('Поведенческие профили')}</h2>
        <Button variant="secondary" onClick={() => openModel()}>
          <Plus size={16} />
          {t('Новый профиль')}
        </Button>
      </div>
      <p className="muted">
        {t(
          'Стиль подачи, а не личность NPC и не техническая модель. Каждое изменение создаёт новую версию профиля.',
        )}
      </p>
      <ErrorBox message={models.error} retry={models.reload} />
      {models.loading ? (
        <Loading />
      ) : (
        <div className={styles.modelList}>
          {models.data?.map((m) => (
            <Panel key={m.id}>
              <div className="row">
                <div className={styles.profileIcon}>{m.key === 'cookie' ? '◉' : '◈'}</div>
                <div>
                  <h3>{m.name}</h3>
                  <small className="muted">
                    {m.key} {t(' · версия ')}
                    {m.version}
                  </small>
                </div>
                <Badge tone={m.enabled ? 'green' : ''}>
                  {m.enabled ? t('Доступен') : t('Отключён')}
                </Badge>
              </div>
              <p className="muted">{m.description}</p>
              <Button variant="secondary" onClick={() => openModel(m)}>
                <Settings2 size={15} />
                {t('Настроить профиль')}
              </Button>
            </Panel>
          ))}
        </div>
      )}
      <div className={styles.sectionHeading}>
        <Activity size={22} />
        <h2>{t('Технические runtime-профили')}</h2>
        <Button variant="secondary" onClick={() => openRuntime()}>
          <Plus size={16} />
          {t('Новая конфигурация')}
        </Button>
      </div>
      <div className="notice">
        {t(
          'OpenAI и local можно подготовить как отключённые конфигурации. Внешние вызовы в текущем этапе запрещены. Endpoint выбирается только из серверного списка, API-ключи здесь не хранятся.',
        )}
      </div>
      <ErrorBox message={runtimes.error} retry={runtimes.reload} />
      {runtimes.loading ? (
        <Loading />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('Конфигурация')}</th>
                <th>{t('Провайдер')}</th>
                <th>{t('Лимиты токенов')}</th>
                <th>{t('Статус')}</th>
                <th>{t('Настройки')}</th>
              </tr>
            </thead>
            <tbody>
              {runtimes.data?.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.name}</strong>
                    <small className={styles.secondary}>{r.model}</small>
                  </td>
                  <td>{r.provider}</td>
                  <td>
                    {r.maxInputTokens.toLocaleString(locale)} /{' '}
                    {r.maxOutputTokens.toLocaleString(locale)}
                  </td>
                  <td>
                    <Badge tone={r.enabled ? 'green' : ''}>
                      {r.enabled ? t('Mock активен') : t('Отключён')}
                    </Badge>
                  </td>
                  <td>
                    <Button variant="ghost" onClick={() => openRuntime(r)}>
                      {t('Изменить')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {kind && (
        <Modal
          title={
            kind === 'model'
              ? editId
                ? t('Редактировать профиль')
                : t('Новый поведенческий профиль')
              : editId
                ? t('Настройки runtime')
                : t('Новый runtime')
          }
          onClose={() => setKind(null)}
        >
          <form method="post" className="stack" onSubmit={(e) => void save(e)}>
            {kind === 'model' ? (
              <>
                <div className="field-grid">
                  <Field label={t('Название профиля')}>
                    <Input
                      required
                      minLength={2}
                      maxLength={80}
                      value={model.name}
                      onChange={(e) => setModel((m) => ({ ...m, name: e.target.value }))}
                    />
                  </Field>
                  <Field label={t('Системный ключ')} hint={t('Латиница, цифры и подчёркивание')}>
                    <Input
                      required
                      minLength={2}
                      maxLength={40}
                      pattern="[a-z0-9_]+"
                      value={model.key}
                      onChange={(e) => setModel((m) => ({ ...m, key: e.target.value }))}
                    />
                  </Field>
                </div>
                <Field label={t('Описание для пользователей')}>
                  <Textarea
                    maxLength={2000}
                    value={model.description}
                    onChange={(e) => setModel((m) => ({ ...m, description: e.target.value }))}
                  />
                </Field>
                <Field label={t('Инструкции поведения')}>
                  <Textarea
                    rows={8}
                    maxLength={8000}
                    value={model.instructions}
                    onChange={(e) => setModel((m) => ({ ...m, instructions: e.target.value }))}
                  />
                </Field>
                <Toggle
                  label={t('Доступен для выбора')}
                  checked={model.enabled}
                  onChange={(enabled) => setModel((m) => ({ ...m, enabled }))}
                />
                <p className="muted">
                  {t(
                    'Профили не должны имитировать терапию, провоцировать зависимость или требовать оплату за привязанность персонажа.',
                  )}
                </p>
              </>
            ) : (
              <>
                <Field label={t('Название конфигурации')}>
                  <Input
                    required
                    minLength={2}
                    maxLength={80}
                    value={runtime.name}
                    onChange={(e) => setRuntime((r) => ({ ...r, name: e.target.value }))}
                  />
                </Field>
                <div className="field-grid">
                  <Field label={t('Провайдер')}>
                    <Select
                      value={runtime.provider}
                      onChange={(e) => {
                        const provider = e.target.value as RuntimeDraft['provider'];
                        setRuntime((r) => ({
                          ...r,
                          provider,
                          endpointId: provider,
                          enabled: provider === 'mock' ? r.enabled : false,
                        }));
                      }}
                    >
                      <option value="mock">{t('Mock — без внешних вызовов')}</option>
                      <option value="openai">{t('OpenAI — отключён')}</option>
                      <option value="local">{t('Local — отключён')}</option>
                    </Select>
                  </Field>
                  <Field label={t('Идентификатор модели')}>
                    <Input
                      required
                      maxLength={120}
                      value={runtime.model}
                      onChange={(e) => setRuntime((r) => ({ ...r, model: e.target.value }))}
                    />
                  </Field>
                  <Field label={t('Входные токены')}>
                    <Input
                      type="number"
                      min={128}
                      max={200000}
                      required
                      value={runtime.maxInputTokens}
                      onChange={(e) =>
                        setRuntime((r) => ({
                          ...r,
                          maxInputTokens: Number(e.target.value),
                        }))
                      }
                    />
                  </Field>
                  <Field label={t('Выходные токены')}>
                    <Input
                      type="number"
                      min={64}
                      max={16000}
                      required
                      value={runtime.maxOutputTokens}
                      onChange={(e) =>
                        setRuntime((r) => ({
                          ...r,
                          maxOutputTokens: Number(e.target.value),
                        }))
                      }
                    />
                  </Field>
                  <Field label={t('Таймаут, мс')}>
                    <Input
                      type="number"
                      min={1000}
                      max={120000}
                      required
                      value={runtime.timeoutMs}
                      onChange={(e) =>
                        setRuntime((r) => ({
                          ...r,
                          timeoutMs: Number(e.target.value),
                        }))
                      }
                    />
                  </Field>
                  <Field label={t('Параллельные запросы')}>
                    <Input
                      type="number"
                      min={1}
                      max={10}
                      required
                      value={runtime.concurrency}
                      onChange={(e) =>
                        setRuntime((r) => ({
                          ...r,
                          concurrency: Number(e.target.value),
                        }))
                      }
                    />
                  </Field>
                </div>
                {runtime.provider === 'mock' ? (
                  <Toggle
                    label={t('Разрешить mock-конфигурацию')}
                    description={t('Не включает игровую сессию и не обращается к внешнему API.')}
                    checked={runtime.enabled}
                    onChange={(enabled) => setRuntime((r) => ({ ...r, enabled }))}
                  />
                ) : (
                  <div className="notice">
                    {t(
                      'Конфигурация останется отключённой. Для реальной интеграции нужен отдельный следующий этап и разрешение владельца.',
                    )}
                  </div>
                )}
              </>
            )}
            <ErrorBox message={error} />
            <div className="form-actions">
              <Button variant="secondary" type="button" onClick={() => setKind(null)}>
                {t('Отмена')}
              </Button>
              <Button type="submit" busy={busy}>
                {t('Сохранить')}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

function AdminCredits() {
  const { t, locale } = useT();
  const users = useResource<User[]>('/admin/users'),
    [userId, setUserId] = useState(''),
    [amount, setAmount] = useState(100),
    [reason, setReason] = useState(''),
    [key, setKey] = useState(() => crypto.randomUUID()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirm, setConfirm] = useState(false),
    [result, setResult] = useState<Wallet | null>(null),
    { toast } = useClient();
  async function grant() {
    setBusy(true);
    setError('');
    try {
      const wallet = await api<Wallet>('/admin/credits', {
        method: 'POST',
        body: JSON.stringify({ userId, amount, reason, idempotencyKey: key }),
      });
      setResult(wallet);
      setKey(crypto.randomUUID());
      setConfirm(false);
      toast(t('Операция записана в demo ledger'));
    } catch (e) {
      setError(t(errorMessage(e)));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className={styles.sectionHeading}>
        <Coins size={22} />
        <h2>{t('Тестовая валюта')}</h2>
        <Badge>DEMO</Badge>
      </div>
      <div className="notice">
        {t(
          'Искры в этой версии не имеют денежной стоимости. Платежи, продажи и переводы между пользователями отключены. Корректировки создают новые записи, не переписывая историю.',
        )}
      </div>
      <div className={styles.overviewGrid}>
        <Panel>
          <form
            method="post"
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              setError('');
              setConfirm(true);
            }}
          >
            <Field label={t('Пользователь')}>
              <Select
                value={userId}
                onChange={(e) => {
                  setUserId(e.target.value);
                  setResult(null);
                }}
                required
              >
                <option value="">{t('Выберите пользователя')}</option>
                {users.data?.map((u) => (
                  <option value={u.id} key={u.id}>
                    {u.name} (@{u.handle})
                  </option>
                ))}
              </Select>
            </Field>
            <ErrorBox message={users.error} retry={users.reload} />
            <Field
              label={t('Изменение баланса')}
              hint={t(
                'Положительное число — начисление, отрицательное — компенсация. Только целые Искры.',
              )}
            >
              <Input
                required
                type="number"
                min={-100000}
                max={100000}
                step={1}
                value={amount}
                onChange={(e) => setAmount(Number(e.target.value))}
              />
            </Field>
            <Field label={t('Причина операции')}>
              <Textarea
                required
                minLength={3}
                maxLength={1000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('Например, тест сценария покупки без реального платежа')}
              />
            </Field>
            <Button type="submit" disabled={!amount || users.loading}>
              <Coins size={16} />
              {t('Проверить операцию')}
            </Button>
          </form>
        </Panel>
        <Panel>
          <h3>{t('Неизменяемый учёт')}</h3>
          <ul className={styles.rules}>
            <li>
              <Check size={16} />
              {t('Повтор одного запроса не начислит валюту дважды.')}
            </li>
            <li>
              <Check size={16} />
              {t('Баланс не может стать отрицательным.')}
            </li>
            <li>
              <Check size={16} />
              {t('Каждая корректировка имеет причину и запись аудита.')}
            </li>
            <li>
              <X size={16} />
              {t('Обычный пользователь не может менять баланс.')}
            </li>
          </ul>
          {result && (
            <div className={styles.result}>
              <span>{t('Баланс после операции')}</span>
              <strong>
                {result.balance.toLocaleString(locale)} <small>{t('demo Искр')}</small>
              </strong>
            </div>
          )}
        </Panel>
      </div>
      {confirm && (
        <Modal title={t('Подтвердить demo-операцию?')} onClose={() => setConfirm(false)}>
          <p>
            {users.data?.find((u) => u.id === userId)?.name}:{' '}
            <strong>
              {amount > 0 ? '+' : ''}
              {amount} {t(' demo Искр')}
            </strong>
          </p>
          <p>{reason}</p>
          <ErrorBox message={error} />
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setConfirm(false)} disabled={busy}>
              {t('Отмена')}
            </Button>
            <Button busy={busy} onClick={() => void grant()}>
              {t('Подтвердить операцию')}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
function AdminAudit() {
  const date = useDate();
  const { t } = useT();
  const audit = useResource<AuditEntry[]>('/admin/audit'),
    [query, setQuery] = useState('');
  const rows = (audit.data || []).filter((a) =>
    `${a.action} ${a.actorId} ${a.targetId || ''}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <div className={styles.sectionHeading}>
        <Activity size={22} />
        <h2>{t('Журнал действий')}</h2>
        <Button variant="secondary" onClick={audit.reload}>
          {t('Обновить')}
        </Button>
      </div>
      <p className="muted">
        {t(
          'История административных изменений. Записи доступны только администраторам и не редактируются из интерфейса.',
        )}
      </p>
      <Input
        aria-label={t('Поиск в журнале')}
        placeholder={t('Действие, ID пользователя или объекта')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ErrorBox message={audit.error} retry={audit.reload} />
      {audit.loading ? (
        <Loading />
      ) : rows.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('Время')}</th>
                <th>{t('Действие')}</th>
                <th>{t('Инициатор')}</th>
                <th>{t('Объект')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id}>
                  <td>
                    {date(a.createdAt, {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </td>
                  <td>
                    <strong>{actionLabels[a.action] ? t(actionLabels[a.action]) : a.action}</strong>
                  </td>
                  <td>
                    <code className={styles.identifier}>
                      {a.actorName || a.actorId || t('Система')}
                    </code>
                  </td>
                  <td>
                    <code className={styles.identifier}>{a.targetId || '—'}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        !audit.error && (
          <Empty
            title={t('Журнал пока пуст')}
            description={t('Административные изменения появятся здесь после сохранения.')}
          />
        )
      )}
    </>
  );
}

function AdminTaxonomy() {
  const { t } = useT(),
    { toast } = useClient();
  const resource = useResource<{ genres: string[]; tags: ControlledTag[] }>('/admin/taxonomy');
  const [genres, setGenres] = useState(''),
    [tags, setTags] = useState<ControlledTag[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    if (resource.data) {
      setGenres(resource.data.genres.join('\n'));
      setTags(resource.data.tags);
    }
  }, [resource.data]);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await api<{ genres: string[]; tags: ControlledTag[] }>('/admin/taxonomy', {
        method: 'PATCH',
        body: JSON.stringify({
          genres: genres
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
          tags,
        }),
      });
      resource.setData(data);
      toast(t('Жанры и теги сохранены'));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className={styles.sectionHeading}>
        <Layers size={22} />
        <h2>{t('Жанры и теги')}</h2>
      </div>
      <div className="notice">
        {t(
          'Справочник помогает ориентироваться в каталоге. Изменения не переписывают жанры и теги уже созданных историй.',
        )}
      </div>
      <ErrorBox message={resource.error} retry={resource.reload} />
      {resource.loading ? (
        <Loading />
      ) : (
        <Panel>
          <form method="post" className="stack" onSubmit={(e) => void save(e)}>
            <div className="field-grid">
              <Field label={t('Жанры')} hint={t('Один жанр на строку. От 1 до 50, без повторов.')}>
                <Textarea
                  rows={12}
                  required
                  value={genres}
                  onChange={(e) => setGenres(e.target.value)}
                />
              </Field>
              <fieldset className="stack">
                <legend>{t('Рекомендуемые теги')}</legend>
                {tags.map((tag, index) => (
                  <div className="panel stack" key={index}>
                    <Field label={t('ID тега')}>
                      <Input
                        required
                        pattern="[a-z][a-z0-9-]{1,39}"
                        maxLength={40}
                        readOnly={resource.data?.tags.some((existing) => existing.id === tag.id)}
                        value={tag.id}
                        onChange={(e) =>
                          setTags(
                            tags.map((item, i) =>
                              i === index ? { ...item, id: e.target.value } : item,
                            ),
                          )
                        }
                      />
                    </Field>
                    {(['uk', 'en', 'ru'] as const).map((language) => (
                      <Field
                        key={language}
                        label={t(
                          language === 'uk'
                            ? 'Украинский'
                            : language === 'en'
                              ? 'Английский'
                              : 'Русский',
                        )}
                      >
                        <Input
                          required
                          maxLength={40}
                          value={tag.labels[language]}
                          onChange={(e) =>
                            setTags(
                              tags.map((item, i) =>
                                i === index
                                  ? {
                                      ...item,
                                      labels: { ...item.labels, [language]: e.target.value },
                                    }
                                  : item,
                              ),
                            )
                          }
                        />
                      </Field>
                    ))}
                  </div>
                ))}
                <Button
                  type="button"
                  variant="secondary"
                  disabled={tags.length >= 100}
                  onClick={() =>
                    setTags([...tags, { id: '', labels: { uk: '', en: '', ru: '' }, aliases: [] }])
                  }
                >
                  {t('Добавить тег')}
                </Button>
              </fieldset>
            </div>
            <ErrorBox message={error} />
            <div className="form-actions">
              <Button
                variant="secondary"
                type="button"
                onClick={() => {
                  if (resource.data) {
                    setGenres(resource.data.genres.join('\n'));
                    setTags(resource.data.tags);
                  }
                  setError('');
                }}
              >
                {t('Отменить изменения')}
              </Button>
              <Button type="submit" busy={busy}>
                {t('Сохранить справочник')}
              </Button>
            </div>
          </form>
        </Panel>
      )}
    </>
  );
}
