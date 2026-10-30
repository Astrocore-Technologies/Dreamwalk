'use client';
import { AdventureLaunch } from './game/adventure-launch';
import { useT } from '@/lib/i18n';
import Link from 'next/link';
import {
  selectAdventureText,
  selectAdventureTags,
  selectNpcText,
  type ControlledTag,
} from '@dreamwalk/contracts';
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
  Select,
  Textarea,
} from './ui';
function discoveryCover(adventure: Adventure) {
  // Custom uploads retain their authenticated asset URL and access checks.
  if (adventure.coverAssetId) return coverUrl(adventure);
  const posters: Record<string, string> = {
    'old-observatory': 'observatory',
    'whispering-forest': 'forest',
    tidekeepers: 'tidekeepers',
    'city-of-lanterns': 'city',
  };
  return posters[adventure.slug]
    ? `/images/discovery-${posters[adventure.slug]}.webp`
    : coverUrl(adventure);
}
export function AdventureCard({
  adventure,
  discovery = false,
}: {
  adventure: Adventure;
  discovery?: boolean;
}) {
  const { t: tr, locale, taxonomy } = useT();
  const text = selectAdventureText(adventure, locale);
  return (
    <Link href={`/adventures/${adventure.slug}`} className="adventure-card">
      <div
        className={`card-art art-${adventure.cover}`}
        style={{
          backgroundImage: `url('${discovery ? discoveryCover(adventure) : coverUrl(adventure)}'), url('${coverUrl(adventure)}')`,
        }}
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
  const { t: tr, locale, taxonomy } = useT();
  const { user } = useClient();
  const { data, loading, error, reload } = useResource<Adventure[]>('/adventures?sort=popular');
  const featured = data?.find((item) => item.slug === 'old-observatory') || data?.[0];
  const details = useResource<Adventure>(
    featured ? `/adventures/${encodeURIComponent(featured.slug)}` : null,
  );
  const text = featured ? selectAdventureText(featured, locale) : null;
  return (
    <div className="discovery-page discovery-home">
      <div className="discovery-intro">
        <p>
          {user
            ? tr('С возвращением, {name}', { name: user.name })
            : tr('Истории начинаются со знакомства')}
        </p>
        <Link href="/library">
          {tr('Моя библиотека')} <ArrowUpRight size={16} />
        </Link>
      </div>
      <ErrorBox message={error} retry={reload} />
      {loading ? (
        <Loading />
      ) : featured && text ? (
        <section className="featured-story">
          <div className="featured-copy">
            <div className="story-kicker">
              <span>{tr('В центре внимания')}</span>
              <span>{taxonomy(featured.genre)}</span>
            </div>
            <h1>{text.title}</h1>
            <Link className="discovery-author" href={`/creators/${featured.author.handle}`}>
              <span className="tiny-avatar">{featured.author.name[0]}</span>
              {featured.author.name}
            </Link>
            <p className="featured-synopsis">{text.synopsis}</p>
            {!!details.data?.npcs?.length && (
              <div className="featured-cast">
                <span>{tr('Ты встретишь')}</span>
                {details.data.npcs.slice(0, 3).map((n) => (
                  <span key={n.id} className="cast-name">
                    {selectNpcText(n, locale).name}
                  </span>
                ))}
              </div>
            )}
            <ButtonLink href={`/adventures/${featured.slug}`}>
              {tr('Знакомиться с историей')} <ArrowRight size={18} />
            </ButtonLink>
          </div>
          <Link
            className="featured-art"
            style={{ backgroundImage: `url('${coverUrl(featured)}')` }}
            href={`/adventures/${featured.slug}`}
            aria-label={text.title}
          >
            <img src={discoveryCover(featured)} alt="" />
          </Link>
        </section>
      ) : (
        !error && (
          <Empty
            title={tr('Первые миры уже в пути')}
            description={tr('Опубликованные истории появятся здесь после проверки.')}
          />
        )
      )}
      <section className="discovery-section">
        <div className="section-heading">
          <h2>{tr('Найди свою историю')}</h2>
          <MoreLink href="/explore">{tr('Все приключения')}</MoreLink>
        </div>
        {!!data?.length && (
          <div className="adventure-grid discovery-grid">
            {data.slice(0, 4).map((adventure) => (
              <AdventureCard discovery key={adventure.id} adventure={adventure} />
            ))}
          </div>
        )}
      </section>
      <nav className="discovery-shortcuts" aria-label={tr('Твои истории')}>
        <Link href="/my-characters">
          <UsersRound size={22} />
          <span>
            <strong>{tr('Мои герои')}</strong>
            <small>{tr('Создай героя для будущей истории')}</small>
          </span>
          <ArrowUpRight size={18} />
        </Link>
        <Link href="/studio">
          <Feather size={22} />
          <span>
            <strong>{tr('Открыть студию')}</strong>
            <small>{tr('Расскажи историю на своих условиях')}</small>
          </span>
          <ArrowUpRight size={18} />
        </Link>
      </nav>
      <p className="discovery-stage">
        <BookOpen size={17} />
        {tr('Сейчас — знакомство с мирами и подготовка героев. Игровые сессии появятся позже.')}
      </p>
    </div>
  );
}
export function ExplorePage() {
  const { t: tr, locale, taxonomy } = useT();
  const params = useSearchParams();
  const [query, setQuery] = useState(params.get('q') || ''),
    [genre, setGenre] = useState(''),
    [sort, setSort] = useState('popular');
  useEffect(() => {
    setQuery(params.get('q') || '');
  }, [params]);
  const genres = useResource<string[]>('/genres');
  const { data, loading, error, reload } = useResource<Adventure[]>(
    `/adventures?q=${encodeURIComponent(query)}&genre=${encodeURIComponent(genre)}&sort=${sort}`,
  );
  return (
    <div className="discovery-page discovery-catalog">
      <div className="catalog-heading">
        <h1>{tr('Открыть миры')}</h1>
        <span>{data ? formatCount(locale, data.length) : '…'}</span>
      </div>
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
        <button
          className={!genre ? 'active' : ''}
          aria-pressed={!genre}
          onClick={() => setGenre('')}
        >
          {tr('Все миры')}
        </button>
        {(genres.data || ['Фэнтези', 'Мистика', 'Приключения']).map((item) => (
          <button
            className={genre === item ? 'active' : ''}
            aria-pressed={genre === item}
            key={item}
            onClick={() => setGenre(item)}
          >
            {taxonomy(item)}
          </button>
        ))}
      </div>
      <ErrorBox message={error} retry={reload} />
      {loading ? (
        <Loading />
      ) : data?.length ? (
        <div className="adventure-grid discovery-grid">
          {data.map((a) => (
            <AdventureCard discovery key={a.id} adventure={a} />
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
    </div>
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
  const tagDefinitions = useResource<ControlledTag[]>('/tags');
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
    <div className="discovery-page discovery-detail">
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
      <section className="story-overview">
        <div className="story-poster" style={{ backgroundImage: `url('${coverUrl(a)}')` }}>
          <img src={discoveryCover(a)} alt="" />
        </div>
        <div className="story-intro">
          <div className="story-kicker">
            <span>{taxonomy(a.genre)}</span>
            {a.visibility === 'private' && <Badge>{tr('Частный мир')}</Badge>}
          </div>
          <h1>{text.title}</h1>
          <Link className="discovery-author" href={`/creators/${a.author.handle}`}>
            <span className="tiny-avatar">{a.author.name[0]}</span>
            {a.author.name}
            <ArrowUpRight size={14} />
          </Link>
          <p className="story-synopsis">{text.synopsis}</p>
          <div className="story-tags">
            {selectAdventureTags(a, locale, tagDefinitions.data || []).map((tag, index) => (
              <span key={index}>#{tag}</span>
            ))}
          </div>
        </div>
        <aside className="story-actions">
          <div className="prepare-panel">
            <h2>{tr('Перед приключением')}</h2>
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
            <AdventureLaunch adventure={a} />
          </div>
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
      </section>
      <div className="story-body">
        <div className="story-sections">
          {!!a.npcs?.length && (
            <section className="story-section">
              <h2>{tr('Ты встретишь')}</h2>
              <div className="npc-preview-grid">
                {a.npcs.map((n) => (
                  <div key={n.id} className="npc-preview">
                    <span className="character-orb">
                      {n.portraitAssetId ? (
                        <img src={assetUrl(n.portraitAssetId)} alt="" />
                      ) : (
                        selectNpcText(n, locale).name[0]
                      )}
                    </span>
                    <h3>{selectNpcText(n, locale).name}</h3>
                    <span className="muted">{selectNpcText(n, locale).role}</span>
                    {selectNpcText(n, locale).description && (
                      <p>{selectNpcText(n, locale).description}</p>
                    )}
                    {selectNpcText(n, locale).greeting && (
                      <p>«{selectNpcText(n, locale).greeting}»</p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
          <section className="story-section">
            <h2>{tr('За порогом истории')}</h2>
            <p className="prose">{a.content?.world || text.synopsis}</p>
          </section>
          <section className="story-section">
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
          </section>
          {a.access !== 'invited' && (
            <details className="story-versions">
              <summary>{tr('Версии')}</summary>
              <p className="muted">
                {tr('Опубликованные версии сохраняются отдельно от новых черновиков.')}
              </p>
              {(a.versions || [{ version: a.version, createdAt: a.updatedAt }]).map((v, i) => (
                <div className="list-row" key={i}>
                  <span>{tr('Версия {version}', { version: v.version })}</span>
                  <small>{date(v.createdAt)}</small>
                </div>
              ))}
            </details>
          )}
        </div>
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
    </div>
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
