'use client';
import { useT } from '@/lib/i18n';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { ArrowUpRight, Bell, BookOpen, Feather, Plus, Sparkles, UserRound } from 'lucide-react';
import {
  api,
  useResource,
  useClient,
  errorMessage,
  useDate,
  assetUrl,
  type Adventure,
  type Hero,
} from '@/lib/client';
import type { Wallet, Invitation } from '@dreamwalk/contracts';
import { selectAdventureText } from '@dreamwalk/contracts';
import { AdventureCard } from './public';
import {
  Badge,
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
  Textarea,
  UploadField,
} from './ui';
export function LibraryPage() {
  const date = useDate();
  const { t: tr, locale } = useT();
  const { toast } = useClient();
  const params = useSearchParams();
  const { data, loading, error, reload } = useResource<{
    favorites: Adventure[];
    drafts: Adventure[];
    heroes: Hero[];
    shared: Adventure[];
  }>('/library');
  const invitations = useResource<Invitation[]>('/invitations');
  const [tab, setTab] = useState(
    ['shared', 'invitations'].includes(params.get('tab') || '') ? params.get('tab')! : 'favorites',
  );
  const [busy, setBusy] = useState<string | null>(null);
  const invitationLabels = {
    pending: tr('Ожидает ответа'),
    accepted: tr('Принято'),
    declined: tr('Отклонено'),
    revoked: tr('Доступ отозван'),
  };
  async function respond(id: string, decision: 'accept' | 'decline') {
    setBusy(id);
    try {
      await api(`/invitations/${id}/respond`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      invitations.reload();
      reload();
      toast(
        decision === 'accept'
          ? tr('Приглашение принято. Мир появился в общей библиотеке.')
          : tr('Приглашение отклонено.'),
      );
      if (decision === 'accept') setTab('shared');
    } catch (error) {
      toast(errorMessage(error));
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      <PageHeading
        eyebrow={tr('СОХРАНЕНО ДЛЯ ТЕБЯ')}
        title={tr('Моя библиотека')}
        description={tr(
          'Миры, к которым хочется вернуться. И истории, которым ещё предстоит случиться.',
        )}
        action={
          <ButtonLink href="/explore" variant="secondary">
            {tr('Найти новый мир')}
            <ArrowUpRight size={16} />
          </ButtonLink>
        }
      />
      <div className="filter-chips library-tabs">
        {[
          ['favorites', tr('Избранные миры'), data?.favorites.length],
          ['shared', tr('Приглашённые миры'), data?.shared?.length],
          [
            'invitations',
            tr('Приглашения'),
            invitations.data?.filter((i) => i.status === 'pending').length,
          ],
          ['drafts', tr('Мои истории'), data?.drafts.length],
          ['history', tr('Прохождения'), 0],
        ].map(([key, label, count]) => (
          <button
            key={key}
            className={tab === key ? 'active' : ''}
            onClick={() => setTab(String(key))}
          >
            {label}
            <span>{count || 0}</span>
          </button>
        ))}
      </div>
      <ErrorBox message={error} retry={reload} />
      {tab === 'invitations' ? (
        <>
          <div className="notice">
            {tr(
              'Частные миры открываются только после принятия личного приглашения. Ссылка сама по себе не даёт доступа.',
            )}
          </div>
          <ErrorBox message={invitations.error} retry={invitations.reload} />
          {invitations.loading ? (
            <Loading />
          ) : invitations.data?.length ? (
            <div className="stack invitation-list">
              {invitations.data.map((invite) => (
                <Panel key={invite.id}>
                  <div className="section-heading invitation-heading">
                    <div>
                      <span className="eyebrow">{tr('ЛИЧНОЕ ПРИГЛАШЕНИЕ')}</span>
                      <h2>
                        {invite.adventureMetadata
                          ? selectAdventureText(invite.adventureMetadata, locale).title
                          : invite.adventureTitle}
                      </h2>
                    </div>
                    <Badge>{invitationLabels[invite.status]}</Badge>
                  </div>
                  <p>
                    {tr('{name} приглашает тебя посмотреть частный мир.', {
                      name: invite.owner.name,
                    })}
                  </p>
                  <small className="muted">{date(invite.createdAt)}</small>
                  <div className="form-actions">
                    {invite.status === 'pending' ? (
                      <>
                        <Button
                          variant="secondary"
                          disabled={!!busy}
                          onClick={() => void respond(invite.id, 'decline')}
                        >
                          {tr('Отклонить')}
                        </Button>
                        <Button
                          busy={busy === invite.id}
                          disabled={!!busy}
                          onClick={() => void respond(invite.id, 'accept')}
                        >
                          {tr('Принять приглашение')}
                        </Button>
                      </>
                    ) : invite.status === 'accepted' ? (
                      <ButtonLink href={`/adventures/${invite.adventureSlug}`}>
                        {tr('Открыть приглашённый мир')}
                        <ArrowUpRight size={16} />
                      </ButtonLink>
                    ) : null}
                  </div>
                </Panel>
              ))}
            </div>
          ) : (
            <Empty
              title={tr('Приглашений пока нет')}
              description={tr(
                'Автор может пригласить тебя в частный мир по адресу твоего профиля. Приглашения появятся здесь.',
              )}
            />
          )}
        </>
      ) : loading ? (
        <Loading />
      ) : tab === 'history' ? (
        <Empty
          title={tr('Первое приключение впереди')}
          description={tr(
            'Игровые сессии появятся на следующем этапе. А пока выбери мир и подготовь героя.',
          )}
          action={<ButtonLink href="/my-characters">{tr('Создать героя')}</ButtonLink>}
        />
      ) : tab === 'shared' ? (
        <>
          <div className="notice">
            {tr(
              'Эти частные истории доступны тебе по приглашению. Ты можешь просматривать их, но не редактировать. Автор может отозвать доступ.',
            )}
          </div>
          {data?.shared?.length ? (
            <div className="adventure-grid invitation-list">
              {data.shared.map((a) => (
                <AdventureCard key={a.id} adventure={a} />
              ))}
            </div>
          ) : (
            <Empty
              title={tr('Твои личные приглашения — здесь')}
              description={tr(
                'Прими приглашение автора, и его частный мир появится в этом разделе.',
              )}
              action={
                <Button variant="secondary" onClick={() => setTab('invitations')}>
                  {tr('Посмотреть приглашения')}
                </Button>
              }
            />
          )}
        </>
      ) : tab === 'favorites' ? (
        data?.favorites.length ? (
          <div className="adventure-grid">
            {data.favorites.map((a) => (
              <AdventureCard key={a.id} adventure={a} />
            ))}
          </div>
        ) : (
          <Empty
            title={tr('Место для твоих открытий')}
            description={tr('Нажми на сердечко в карточке приключения — и оно останется здесь.')}
            action={<ButtonLink href="/explore">{tr('Открыть миры')}</ButtonLink>}
          />
        )
      ) : data?.drafts.length ? (
        <div className="stack">
          {data.drafts.map((a) => (
            <Link className="draft-row panel" key={a.id} href={`/studio/adventures/${a.id}`}>
              <Feather size={22} />
              <span>
                <strong>{selectAdventureText(a, locale).title}</strong>
                <small>{tr('Обновлено {date}', { date: date(a.updatedAt) })}</small>
              </span>
              <Badge>{a.status === 'published' ? tr('Опубликовано') : tr('Черновик')}</Badge>
              <ArrowUpRight size={18} />
            </Link>
          ))}
        </div>
      ) : (
        <Empty
          title={tr('У каждого мира есть первая строчка')}
          description={tr('Собери собственную историю в студии автора.')}
          action={<ButtonLink href="/studio/adventures/new">{tr('Создать историю')}</ButtonLink>}
        />
      )}
    </>
  );
}
export function HeroesPage() {
  const { t: tr } = useT();
  const { toast } = useClient();
  const resource = useResource<Hero[]>('/heroes');
  const [editing, setEditing] = useState<Partial<Hero> | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [remove, setRemove] = useState<Hero | null>(null);
  return (
    <>
      <PageHeading
        eyebrow={tr('ТВОИ ДРУГИЕ Я')}
        title={tr('Мои герои')}
        description={tr(
          'Храбрец, мечтатель или тот, кто всегда задаёт неудобные вопросы. Кем будешь ты?',
        )}
        action={
          <Button
            onClick={() => {
              setError('');
              setEditing({ name: '', backstory: '', notes: '', traits: [] });
            }}
          >
            <Plus size={17} />
            {tr('Создать героя')}
          </Button>
        }
      />
      <ErrorBox message={resource.error} retry={resource.reload} />
      {resource.loading ? (
        <Loading />
      ) : resource.data?.length ? (
        <div className="hero-grid">
          {resource.data.map((hero) => (
            <Panel key={hero.id} className="hero-card">
              <div className="hero-portrait">
                {hero.portraitAssetId ? (
                  <img src={assetUrl(hero.portraitAssetId)} alt={hero.name} />
                ) : (
                  <UserRound size={55} />
                )}
                <span className="portrait-star">✧</span>
              </div>
              <h2>{hero.name}</h2>
              <p>{hero.backstory || tr('История этого героя ещё не рассказана.')}</p>
              <div className="filter-chips">
                {hero.traits.map((t) => (
                  <Badge key={t}>{t}</Badge>
                ))}
              </div>
              <div className="row">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setError('');
                    setEditing(hero);
                  }}
                >
                  {tr('Редактировать')}
                </Button>
                <Button variant="ghost" onClick={() => setRemove(hero)}>
                  {tr('Удалить')}
                </Button>
              </div>
            </Panel>
          ))}
        </div>
      ) : (
        <Empty
          title={tr('Кто сделает первый шаг?')}
          description={tr(
            'Герой — твоя персона внутри приключения. Дай ему имя, характер и маленькую тайну.',
          )}
          action={
            <Button onClick={() => setEditing({ name: '', backstory: '', notes: '', traits: [] })}>
              <Plus size={17} />
              {tr('Создать первого героя')}
            </Button>
          }
        />
      )}
      <div className="platform-note">
        <UserRound size={16} />
        {tr('Герои принадлежат игрокам. Персонажи мира (NPC) создаются отдельно в студии автора.')}
      </div>
      {editing && (
        <Modal
          title={editing.id ? tr('История твоего героя') : tr('Новый герой')}
          onClose={() => setEditing(null)}
        >
          <form
            method="post"
            className="stack"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              const { id, ...fields } = editing;
              try {
                await api(id ? `/heroes/${id}` : '/heroes', {
                  method: id ? 'PATCH' : 'POST',
                  body: JSON.stringify({
                    name: fields.name,
                    backstory: fields.backstory || '',
                    notes: fields.notes || '',
                    traits: fields.traits || [],
                    portraitAssetId: fields.portraitAssetId || null,
                  }),
                });
                setEditing(null);
                resource.reload();
                toast(tr('Герой сохранён'));
              } catch (e) {
                setError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label={tr('Имя героя')}>
              <Input
                required
                minLength={2}
                maxLength={80}
                value={editing.name || ''}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </Field>
            <UploadField
              label={tr('Загрузить портрет')}
              onUploaded={(a) => setEditing({ ...editing, portraitAssetId: a.id })}
            />
            {editing.portraitAssetId && (
              <img
                className="upload-preview"
                src={assetUrl(editing.portraitAssetId)}
                alt={tr('Портрет героя')}
              />
            )}
            <Field label={tr('Предыстория')}>
              <Textarea
                maxLength={6000}
                value={editing.backstory || ''}
                onChange={(e) => setEditing({ ...editing, backstory: e.target.value })}
                placeholder={tr('Откуда герой пришёл? Что оставил позади?')}
              />
            </Field>
            <Field label={tr('Черты характера')} hint={tr('Через запятую, до 12 черт')}>
              <Input
                value={editing.traits?.join(', ') || ''}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    traits: e.target.value.split(',').map((s) => s.trim()),
                  })
                }
                placeholder={tr('Любопытный, упрямый, добрый')}
              />
            </Field>
            <Field label={tr('Личные заметки')}>
              <Textarea
                value={editing.notes || ''}
                maxLength={6000}
                onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
              />
            </Field>
            <ErrorBox message={error} />
            <div className="form-actions">
              <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
                {tr('Отмена')}
              </Button>
              <Button busy={busy}>{tr('Сохранить героя')}</Button>
            </div>
          </form>
        </Modal>
      )}
      {remove && (
        <Modal
          title={tr('Удалить героя «{name}»?', { name: remove.name })}
          onClose={() => setRemove(null)}
        >
          <p>{tr('Это действие нельзя отменить.')}</p>
          <div className="form-actions">
            <Button variant="secondary" onClick={() => setRemove(null)}>
              {tr('Отмена')}
            </Button>
            <Button
              variant="danger"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`/heroes/${remove.id}`, {
                    method: 'DELETE',
                    body: '{}',
                  });
                  setRemove(null);
                  resource.reload();
                  toast(tr('Герой удалён'));
                } catch (e) {
                  toast(errorMessage(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {tr('Удалить героя')}
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
export function WalletPage() {
  const date = useDate();
  const { t: tr, locale } = useT();
  const wallet = useResource<Wallet & { available?: number; reserved?: number }>('/wallet');
  const packages =
    useResource<{ id: string; name: string; credits: number; available: boolean }[]>(
      '/store/packages',
    );
  return (
    <>
      <PageHeading
        eyebrow={tr('НЕМНОГО МАГИИ НА БУДУЩЕЕ')}
        title={tr('Мои искры')}
        description={tr(
          'Искры — валюта будущих AI-приключений. Сейчас здесь только тестовый баланс.',
        )}
      />
      <div className="wallet-layout">
        <section className="balance-card">
          <div className="row">
            <Sparkles size={24} />
            <Badge>{tr('DEMO · НЕ ДЕНЬГИ')}</Badge>
          </div>
          <p>{tr('Доступно искр')}</p>
          <h2>
            {wallet.loading
              ? '…'
              : (wallet.data?.available ?? wallet.data?.balance ?? 0).toLocaleString(locale)}
            <span>✦</span>
          </h2>
          <small>
            {tr('Зарезервировано искр')}: {(wallet.data?.reserved ?? 0).toLocaleString(locale)}
            <br />
            {tr('Тестовые операции не имеют денежной стоимости.')}
            <br />
            {tr('Реальные покупки отключены.')}
          </small>
        </section>
        <Panel>
          <h2>{tr('Магия без сюрпризов')}</h2>
          <ul className="plain-list">
            <li>
              <BookOpen size={18} />
              {tr('Читать миры и готовить героев — бесплатно')}
            </li>
            <li>
              <ShieldCheckIcon />
              {tr('Стоимость будущего действия будет видна заранее')}
            </li>
            <li>
              <Sparkles size={18} />
              {tr('Без подписки, скрытых списаний и платных повторов')}
            </li>
          </ul>
          <p className="muted">
            {tr(
              'Цены будущих операций будут опубликованы после измерений. Сейчас AI-вызовы не выполняются.',
            )}
          </p>
        </Panel>
      </div>
      <div className="section-heading">
        <h2>{tr('Пакеты искр')}</h2>
        <Badge>{tr('ДЕМОНСТРАЦИЯ')}</Badge>
      </div>
      <div className="packages-grid">
        {(packages.data || []).map((p) => (
          <Panel key={p.id}>
            <Sparkles size={25} />
            <h3>{p.name}</h3>
            <div className="package-number">
              {p.credits.toLocaleString(locale)} <small>{tr('искр')}</small>
            </div>
            <Button disabled variant="secondary">
              {tr('Покупки пока недоступны')}
            </Button>
          </Panel>
        ))}
      </div>
      <Panel>
        <h2>{tr('История операций')}</h2>
        <ErrorBox message={wallet.error} retry={wallet.reload} />
        {wallet.loading ? (
          <Loading />
        ) : wallet.data?.ledger.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{tr('Операция')}</th>
                  <th>{tr('Дата')}</th>
                  <th>{tr('Искры')}</th>
                </tr>
              </thead>
              <tbody>
                {wallet.data.ledger.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      {entry.reason}
                      <small className="cell-subtitle">{tr('Тестовая операция')}</small>
                    </td>
                    <td>{date(entry.createdAt)}</td>
                    <td className={entry.amount > 0 ? 'positive' : ''}>
                      {entry.amount > 0 ? '+' : ''}
                      {entry.amount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title={tr('Здесь пока тихо')}
            description={tr(
              'История тестовых начислений и списаний появится здесь. Баланс изменяет только администратор.',
            )}
          />
        )}
      </Panel>
    </>
  );
}
function ShieldCheckIcon() {
  return <span aria-hidden="true">◇</span>;
}
export function NotificationsPage() {
  const date = useDate();
  const { t: tr, locale } = useT();
  const resource = useResource<
    {
      id: string;
      type: string;
      payload: {
        title?: string;
        reason?: string;
        decision?: string;
        adventureId?: string;
        adventureTitle?: string;
        adventureMetadata?: Parameters<typeof selectAdventureText>[0];
        inviter?: string;
      };
      title: string;
      message: string;
      read: boolean;
      createdAt: string;
    }[]
  >('/notifications');
  const { toast } = useClient();
  return (
    <>
      <PageHeading
        eyebrow={tr('ВЕСТИ ИЗ ТВОИХ МИРОВ')}
        title={tr('Уведомления')}
        description={tr('Публикации, важные изменения и новости твоих историй.')}
      />
      <ErrorBox message={resource.error} retry={resource.reload} />
      {resource.loading ? (
        <Loading />
      ) : resource.data?.length ? (
        <div className="stack">
          {resource.data.map((n) => (
            <Panel key={n.id}>
              <div className="row">
                <Bell size={20} />
                <h3>
                  {n.type === 'welcome'
                    ? tr('Добро пожаловать в Dreamwalk')
                    : n.type === 'moderation'
                      ? tr('Результат модерации')
                      : n.type === 'invitation'
                        ? tr('Приглашение в частный мир')
                        : n.title}
                </h3>
                {!n.read && <Badge>{tr('Новое')}</Badge>}
              </div>
              <p>
                {n.type === 'welcome'
                  ? tr('Твоя история начинается здесь. Создай героя или открой новый мир.')
                  : n.type === 'moderation'
                    ? `${n.payload.title || ''}: ${n.payload.reason || ''}`
                    : n.type === 'invitation'
                      ? tr('{name} приглашает тебя в мир «{title}».', {
                          name: n.payload.inviter || '',
                          title: n.payload.adventureMetadata
                            ? selectAdventureText(n.payload.adventureMetadata, locale).title
                            : n.payload.adventureTitle || '',
                        })
                      : n.message}
              </p>
              <div className="row">
                <small className="muted">{date(n.createdAt)}</small>
                {n.type === 'invitation' && (
                  <ButtonLink href="/library?tab=invitations" variant="secondary">
                    {tr('Посмотреть приглашения')}
                  </ButtonLink>
                )}
                {!n.read && (
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      try {
                        await api(`/notifications/${n.id}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ read: true }),
                        });
                        resource.reload();
                      } catch (e) {
                        toast(errorMessage(e));
                      }
                    }}
                  >
                    {tr('Прочитано')}
                  </Button>
                )}
              </div>
            </Panel>
          ))}
        </div>
      ) : (
        <Empty
          title={tr('Всё спокойно')}
          description={tr('Важные события появятся здесь. А пока можно открыть новый мир.')}
          action={<ButtonLink href="/explore">{tr('Посмотреть приключения')}</ButtonLink>}
        />
      )}
    </>
  );
}
