'use client';
import { useT } from '@/lib/i18n';
import Link from 'next/link';
import { selectAdventureText } from '@dreamwalk/contracts';
import { formatCount } from '@/lib/locales';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState, useEffect } from 'react';
import {
  ArrowUpRight,
  ArrowRight,
  Clock3,
  UsersRound,
  Heart,
  Feather,
  Compass,
  Search,
  SlidersHorizontal,
  Shield,
  BookOpen,
} from 'lucide-react';
import {
  api,
  useResource,
  useClient,
  coverUrl,
  assetUrl,
  errorMessage,
  useDate,
  type Adventure,
} from '@/lib/client';
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
  MoreLink,
  PageHeading,
  Panel,
  Select,
  Textarea,
} from './ui';
export function AdventureCard({ adventure }: { adventure: Adventure }) {
  const { t: tr, locale, taxonomy } = useT();
  const text = selectAdventureText(adventure, locale);
  return (
    <Link href={`/adventures/${adventure.slug}`} className="adventure-card">
      <div
        className={`card-art art-${adventure.cover}`}
        style={{ backgroundImage: `url('${coverUrl(adventure)}')` }}
      >
        <span className="card-genre">{taxonomy(adventure.genre || 'Фэнтези')}</span>
        <span className="card-arrow">
          <ArrowUpRight size={18} />
        </span>
      </div>
      <div className="card-content">
        <div className="card-author">
          <span className="tiny-avatar">{adventure.author?.name?.slice(0, 1) || 'D'}</span>
          {adventure.author?.name || 'Dreamwalk Studio'}
        </div>
        <h3>{text.title}</h3>
        <p>{text.synopsis}</p>
        <div className="card-meta">
          <span>
            <UsersRound size={14} />
            {adventure.playersMin}–{formatCount(locale, adventure.playersMax, 'player')}
          </span>
          <span>
            <Clock3 size={14} />
            {adventure.duration ? taxonomy(adventure.duration) : tr('Короткая история')}
          </span>
        </div>
      </div>
    </Link>
  );
}
export function HomePage() {
  const { t: tr, locale } = useT();
  const { user } = useClient();
  const { data, loading, error, reload } = useResource<Adventure[]>('/adventures?sort=popular');
  const featured = data?.[0];
  return (
    <div className="home-page">
      <div className="welcome-line">
        <span>
          <span className="small-spark">✧</span>
          {user
            ? tr('С возвращением, {name}', { name: user.name })
            : tr('Маленький шаг за пределы привычного')}
        </span>
        <Badge>{tr('ТВОЯ ИСТОРИЯ ЕЩЁ НЕ НАПИСАНА')}</Badge>
      </div>
      <section className="hero-banner">
        <div
          className="hero-image"
          style={{
            backgroundImage: `url('${featured ? coverUrl(featured) : '/images/observatory.webp'}')`,
          }}
        />
        <div className="hero-grain" />
        <div className="hero-content">
          <div className="eyebrow">
            <span className="online-dot" />
            {tr('МЕСТО ДЛЯ ТВОЕГО ВООБРАЖЕНИЯ')}
          </div>
          <h1>
            {tr('За каждой дверью —')}
            <br />
            {tr('новая')} <em>{tr('история.')}</em>
          </h1>
          <p>
            {tr('Миры, полные тайн. Персонажи, которых не забудешь.')}
            <br className="desktop-break" /> {tr('И ты — в самом центре приключения.')}
          </p>
          <div className="hero-buttons">
            <ButtonLink href="/explore">
              {tr('Найти приключение')}
              <ArrowUpRight size={18} />
            </ButtonLink>
            <ButtonLink href="/studio" variant="glass">
              <Feather size={17} />
              {tr('Создать свой мир')}
            </ButtonLink>
          </div>
          <div className="hero-footnote">
            <span className="star-cluster">✧ ✦ ✧</span>
            {tr('Для тех, кому всегда было мало одной реальности')}
          </div>
        </div>
        <div className="hero-label">
          <span className="label-line" />
          <span>
            {tr('МИР В ФОКУСЕ')}
            <strong>
              {featured
                ? selectAdventureText(featured, locale).title
                : tr('Тайна старой обсерватории')}
            </strong>
          </span>
          <ArrowUpRight size={18} />
        </div>
      </section>
      <div className="quick-grid">
        <Link href="/my-characters" className="quick-card">
          <span className="quick-icon">
            <UsersRound size={22} />
          </span>
          <span>
            <strong>{tr('Кем ты будешь?')}</strong>
            <small>{tr('Создай героя для будущей истории')}</small>
          </span>
          <ArrowUpRight size={19} />
        </Link>
        <Link href="/library" className="quick-card">
          <span className="quick-icon lilac">
            <BookOpen size={22} />
          </span>
          <span>
            <strong>{tr('Твои маленькие открытия')}</strong>
            <small>{tr('Любимые миры всегда под рукой')}</small>
          </span>
          <ArrowUpRight size={19} />
        </Link>
      </div>
      <section className="discovery-section">
        <div className="section-heading">
          <div>
            <div className="eyebrow">{tr('СЛЕДУЙ ЗА ЛЮБОПЫТСТВОМ')}</div>
            <h2>{tr('Миры, которые зовут')}</h2>
          </div>
          <MoreLink href="/explore">{tr('Все приключения')}</MoreLink>
        </div>
        <ErrorBox message={error} retry={reload} />
        {loading ? (
          <Loading />
        ) : data?.length ? (
          <div className="adventure-grid">
            {data.slice(0, 3).map((adventure) => (
              <AdventureCard key={adventure.id} adventure={adventure} />
            ))}
          </div>
        ) : (
          !error && (
            <Empty
              title={tr('Первые миры уже в пути')}
              description={tr('Опубликованные истории появятся здесь после проверки.')}
            />
          )
        )}
      </section>
      <section className="author-banner">
        <span className="author-symbol">✳</span>
        <div>
          <div className="eyebrow">{tr('ДАЙ ВООБРАЖЕНИЮ ФОРМУ')}</div>
          <h2>{tr('Есть история, которую можешь рассказать только ты.')}</h2>
          <p>{tr('Места, герои, неожиданные повороты. Собери их в собственной студии.')}</p>
        </div>
        <ButtonLink href="/studio" variant="secondary">
          {tr('Открыть студию')}
          <ArrowUpRight size={17} />
        </ButtonLink>
      </section>
      <div className="platform-note">
        <Shield size={16} />
        <span>
          {tr(
            'Сейчас можно открывать миры и готовить истории. Игровые сессии — следующий этап. Без платных генераций и покупок.',
          )}
        </span>
      </div>
    </div>
  );
}
export function ExplorePage() {
  const { t: tr, locale, taxonomy } = useT();
  const params = useSearchParams();
  const [query, setQuery] = useState(params.get('q') || ''),
    [genre, setGenre] = useState(''),
    [sort, setSort] = useState('popular');
  const genres = useResource<string[]>('/genres');
  const { data, loading, error, reload } = useResource<Adventure[]>(
    `/adventures?q=${encodeURIComponent(query)}&genre=${encodeURIComponent(genre)}&sort=${sort}`,
  );
  return (
    <>
      <PageHeading
        eyebrow={tr('АТЛАС ВОЗМОЖНОСТЕЙ')}
        title={tr('Куда отправимся?')}
        description={tr('Тихая магия, большие тайны и миры, которые ещё предстоит открыть.')}
      />
      <div className="catalog-tools">
        <div className="search-field">
          <Search size={18} />
          <Input
            aria-label={tr('Поиск приключений')}
            placeholder={tr('Название, настроение или тег…')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="sort-control">
          <SlidersHorizontal size={17} />
          <Select
            aria-label={tr('Порядок приключений')}
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="popular">{tr('Популярные')}</option>
            <option value="new">{tr('Новые')}</option>
            <option value="updated">{tr('Недавно обновлённые')}</option>
          </Select>
        </div>
      </div>
      <div className="filter-chips">
        <button className={!genre ? 'active' : ''} onClick={() => setGenre('')}>
          {tr('Все миры')}
        </button>
        {(genres.data || ['Фэнтези', 'Мистика', 'Приключения']).map((item) => (
          <button
            className={genre === item ? 'active' : ''}
            key={item}
            onClick={() => setGenre(item)}
          >
            {taxonomy(item)}
          </button>
        ))}
      </div>
      <div className="results-line">
        <span>{data ? formatCount(locale, data.length) : '…'}</span>
        <span>{tr('Созданы людьми. Для твоего воображения.')}</span>
      </div>
      <ErrorBox message={error} retry={reload} />
      {loading ? (
        <Loading />
      ) : data?.length ? (
        <div className="adventure-grid">
          {data.map((a) => (
            <AdventureCard key={a.id} adventure={a} />
          ))}
        </div>
      ) : (
        !error && (
          <Empty
            title={tr('Этот мир пока не найден')}
            description={tr('Попробуй другое название или убери фильтры.')}
            action={
              <Button
                variant="secondary"
                onClick={() => {
                  setQuery('');
                  setGenre('');
                }}
              >
                {tr('Сбросить фильтры')}
              </Button>
            }
          />
        )
      )}
    </>
  );
}
export function AdventurePage({ slug }: { slug: string }) {
  const date = useDate();
  const { t: tr, locale, taxonomy } = useT();
  const router = useRouter();
  const { user, toast } = useClient();
  const {
    data: a,
    loading,
    error,
    reload,
  } = useResource<Adventure>(`/adventures/${encodeURIComponent(slug)}`);
  const library = useResource<{ favorites: Adventure[] }>(user ? '/library' : null);
  const [saved, setSaved] = useState(false),
    [busy, setBusy] = useState(false),
    [report, setReport] = useState(false),
    [reason, setReason] = useState(''),
    [reportError, setReportError] = useState('');
  useEffect(() => {
    if (a && library.data) setSaved(library.data.favorites.some((item) => item.id === a.id));
  }, [a, library.data]);
  if (loading) return <Loading />;
  if (error || !a)
    return <ErrorBox message={error || tr('Приключение не найдено')} retry={reload} />;
  const text = selectAdventureText(a, locale);
  return (
    <>
      <Link
        className="back-link"
        href={a.access === 'invited' ? '/library?tab=shared' : '/explore'}
      >
        {a.access === 'invited' ? tr('← К приглашённым мирам') : tr('← К приключениям')}
      </Link>
      {a.access === 'invited' && (
        <div className="notice private-access-note">
          <Shield size={18} />
          {tr(
            'Это частный мир. Ты получил доступ по личному приглашению автора — только для просмотра, без права редактирования. Не передавай содержимое без разрешения.',
          )}
        </div>
      )}
      {a.access === 'owner' && a.visibility === 'private' && (
        <div className="notice private-access-note">
          {tr(
            'Частный мир: доступ есть только у тебя и приглашённых пользователей. В каталоге он не отображается.',
          )}
        </div>
      )}
      <section
        className="detail-hero"
        style={{
          backgroundImage: `linear-gradient(0deg,rgba(23,18,29,.98),rgba(23,18,29,.05)),url('${coverUrl(a)}')`,
        }}
      >
        <div>
          <Badge>{taxonomy(a.genre)}</Badge>
          {a.visibility === 'private' && <Badge>{tr('Частный мир')}</Badge>}
          <h1>{text.title}</h1>
          <p>{text.synopsis}</p>
          <Link className="creator-link" href={`/creators/${a.author.handle}`}>
            <span className="tiny-avatar">{a.author.name[0]}</span>
            {a.author.name}
            <ArrowUpRight size={14} />
          </Link>
        </div>
      </section>
      <div className="detail-layout">
        <div className="stack">
          <Panel>
            <h2>{tr('За порогом истории')}</h2>
            <p className="prose">{a.content?.world || text.synopsis}</p>
            <div className="filter-chips">
              {a.tags.map((tag) => (
                <span className="badge" key={tag}>
                  #{tag}
                </span>
              ))}
            </div>
          </Panel>
          {!!a.npcs?.length && (
            <Panel>
              <h2>{tr('Ты встретишь')}</h2>
              <div className="npc-preview-grid">
                {a.npcs.map((n) => (
                  <div key={n.id} className="npc-preview">
                    <span className="character-orb">{n.name[0]}</span>
                    <h3>{n.name}</h3>
                    <span className="muted">{n.role}</span>
                    <p>«{n.greeting}»</p>
                  </div>
                ))}
              </div>
            </Panel>
          )}
          <Panel>
            <h2>{tr('Границы истории')}</h2>
            <p className="muted">
              {tr('Комфортное приключение начинается с понятных договорённостей.')}
            </p>
            <ul className="plain-list">
              {(a.content?.boundaries?.length
                ? a.content.boundaries
                : [tr('Приключения без откровенного контента')]
              ).map((b) => (
                <li key={b}>
                  <Shield size={15} />
                  {b}
                </li>
              ))}
            </ul>
          </Panel>
          {a.access !== 'invited' && (
            <Panel>
              <h2>{tr('Версии')}</h2>
              <p className="muted">
                {tr('Опубликованные версии сохраняются отдельно от новых черновиков.')}
              </p>
              {(a.versions || [{ version: a.version, createdAt: a.updatedAt }]).map((v, i) => (
                <div className="list-row" key={i}>
                  <span>{tr('Версия {version}', { version: v.version })}</span>
                  <small>{date(v.createdAt)}</small>
                </div>
              ))}
            </Panel>
          )}
        </div>
        <aside className="stack">
          <Panel className="prepare-panel">
            <span className="eyebrow">{tr('ТВОЁ СЛЕДУЮЩЕЕ ОТКРЫТИЕ')}</span>
            <h2>{tr('История ждёт тебя')}</h2>
            <div className="detail-facts">
              <span>
                <UsersRound size={18} />
                {tr('Группа')}
                <strong>
                  {a.playersMin}–{formatCount(locale, a.playersMax, 'player')}
                </strong>
              </span>
              <span>
                <Clock3 size={18} />
                {tr('Длительность')}
                <strong>{taxonomy(a.duration)}</strong>
              </span>
              <span>
                <Compass size={18} />
                {tr('Сложность')}
                <strong>{taxonomy(a.difficulty)}</strong>
              </span>
            </div>
            <ButtonLink href="/my-characters">
              {tr('Подготовить героя')}
              <ArrowRight size={17} />
            </ButtonLink>
            {a.visibility !== 'private' ? (
              <Button
                variant="secondary"
                busy={busy}
                onClick={async () => {
                  if (!user) {
                    router.push('/auth/sign-in');
                    return;
                  }
                  setBusy(true);
                  try {
                    await api(`/favorites/${a.id}`, {
                      method: saved ? 'DELETE' : 'PUT',
                      body: '{}',
                    });
                    setSaved(!saved);
                    toast(
                      saved ? tr('Удалено из библиотеки') : tr('Приключение в твоей библиотеке'),
                    );
                  } catch (e) {
                    toast(errorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Heart size={17} fill={saved ? 'currentColor' : 'none'} />
                {saved ? tr('В библиотеке') : tr('В мою библиотеку')}
              </Button>
            ) : a.access === 'owner' ? (
              <ButtonLink href={`/studio/adventures/${a.id}`} variant="secondary">
                {tr('Редактировать в студии')}
              </ButtonLink>
            ) : a.access === 'invited' ? (
              <ButtonLink href="/library?tab=shared" variant="secondary">
                {tr('В приглашённых мирах')}
              </ButtonLink>
            ) : (
              <ButtonLink href="/admin/adventures" variant="secondary">
                {tr('Управление')}
              </ButtonLink>
            )}
            <Button disabled>{tr('Игровой режим появится позже')}</Button>
            <small>
              {tr(
                'Сейчас доступны просмотр мира и подготовка героя. Запуск сессий — на следующем этапе.',
              )}
            </small>
          </Panel>
          <button
            className="subtle-button"
            onClick={() => {
              if (!user) {
                router.push('/auth/sign-in');
                return;
              }
              setReport(true);
            }}
          >
            {tr('Сообщить о нарушении')}
          </button>
        </aside>
      </div>
      {report && (
        <Modal title={tr('Сообщить о нарушении')} onClose={() => setReport(false)}>
          <form
            method="post"
            onSubmit={async (e) => {
              e.preventDefault();
              setReportError('');
              setBusy(true);
              try {
                await api('/reports', {
                  method: 'POST',
                  body: JSON.stringify({ adventureId: a.id, reason }),
                });
                setReport(false);
                toast(tr('Жалоба отправлена на проверку'));
              } catch (e) {
                setReportError(errorMessage(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label={tr('Что стоит проверить?')}>
              <Textarea
                required
                minLength={5}
                maxLength={2000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </Field>
            <ErrorBox message={reportError} />
            <div className="form-actions">
              <Button type="button" variant="secondary" onClick={() => setReport(false)}>
                {tr('Отмена')}
              </Button>
              <Button busy={busy}>{tr('Отправить жалобу')}</Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
export function CreatorPage({ handle }: { handle: string }) {
  const { t: tr } = useT();
  const { data, loading, error, reload } = useResource<{
    creator: {
      name: string;
      handle: string;
      bio: string;
      avatarAssetId?: string;
    };
    adventures: Adventure[];
  }>(`/creators/${handle}`);
  if (loading) return <Loading />;
  if (!data) return <ErrorBox message={error} retry={reload} />;
  return (
    <>
      <div className="creator-header">
        <span className="avatar large">
          {data.creator.avatarAssetId ? (
            <img src={assetUrl(data.creator.avatarAssetId)} alt="" />
          ) : (
            data.creator.name[0]
          )}
        </span>
        <div>
          <span className="eyebrow">{tr('АВТОР МИРОВ')}</span>
          <h1>{data.creator.name}</h1>
          <p>@{data.creator.handle}</p>
        </div>
      </div>
      <p className="prose">
        {data.creator.bio || tr('Истории говорят об авторе лучше любых слов.')}
      </p>
      <h2 className="section-title">{tr('Опубликованные приключения')}</h2>
      <div className="adventure-grid">
        {data.adventures.map((a) => (
          <AdventureCard adventure={a} key={a.id} />
        ))}
      </div>
      {!data.adventures.length && (
        <Empty
          title={tr('Истории ещё впереди')}
          description={tr('Автор пока не опубликовал приключений.')}
        />
      )}
    </>
  );
}
