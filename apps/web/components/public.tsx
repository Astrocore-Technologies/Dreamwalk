'use client';
import { DiscoveryWorldCard } from './public-discovery';
import './public-discovery.css';
import { StoryMetrics } from './story-metrics';
export { AdventurePage } from './story/story-detail-page';
import { isDiscoveryStory } from '@/lib/discovery';
import { useT } from '@/lib/i18n';
import Link from 'next/link';
import { selectAdventureText } from '@dreamwalk/contracts';
import { formatCount } from '@/lib/locales';
import { useSearchParams } from 'next/navigation';
import { useState, useEffect } from 'react';
import { ArrowUpRight, UsersRound, Search, SlidersHorizontal } from 'lucide-react';
import { useResource, coverUrl, assetUrl, type Adventure } from '@/lib/client';
import { Badge, Button, Empty, ErrorBox, Input, Loading, Select } from './ui';
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
  const heroId = useSearchParams().get('heroId');
  const text = selectAdventureText(adventure, locale);
  return (
    <Link
      href={`/adventures/${adventure.slug}${heroId ? `?heroId=${encodeURIComponent(heroId)}` : ''}`}
      className="adventure-card illustrated-card"
    >
      <div
        className={`card-art art-${adventure.cover}`}
        style={{
          backgroundImage: `url('${discovery ? discoveryCover(adventure) : coverUrl(adventure)}'), url('${coverUrl(adventure)}')`,
        }}
      >
        <span className="card-genre">{taxonomy(adventure.genre || 'Фэнтези')}</span>
        <h3 className="card-art-title" title={text.title}>
          {text.title}
        </h3>
        <span className="card-arrow">
          <ArrowUpRight size={18} />
        </span>
      </div>
      <div className="card-content">
        <div className="card-author">
          <span className="tiny-avatar">{adventure.author?.handle?.slice(0, 1) || 'D'}</span>
          {adventure.author?.handle || 'Dreamwalk Studio'}
        </div>
        {adventure.visibility === 'private' && <Badge>{tr('Приватный')}</Badge>}
        <p>{text.synopsis}</p>
        <StoryMetrics adventure={adventure} />
        <div className="card-meta">
          <span>
            <UsersRound size={14} />
            {adventure.playersMin}–{formatCount(locale, adventure.playersMax, 'player')}
          </span>
        </div>
      </div>
    </Link>
  );
}
export { HomePage } from './home/home-page';
export function ExplorePage() {
  const { t: tr, locale } = useT();
  const params = useSearchParams();
  const [query, setQuery] = useState(params.get('q') || ''),
    [sort, setSort] = useState('popular');
  useEffect(() => {
    setQuery(params.get('q') || '');
  }, [params]);
  const {
    data: catalog,
    loading,
    error,
    reload,
  } = useResource<Adventure[]>(`/adventures?q=${encodeURIComponent(query)}&sort=${sort}`);
  const data = catalog?.filter(isDiscoveryStory);
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
      <ErrorBox message={error} retry={reload} />
      {loading ? (
        <Loading />
      ) : data?.length ? (
        <div className="adventure-grid discovery-grid">
          {data.map((a) => (
            <DiscoveryWorldCard key={a.id} adventure={a} />
          ))}
        </div>
      ) : (
        !error && (
          <Empty
            title={tr('Этот мир пока не найден')}
            description={tr('Попробуй другое название или убери фильтры.')}
            action={
              <Button variant="secondary" onClick={() => setQuery('')}>
                {tr('Сбросить фильтры')}
              </Button>
            }
          />
        )
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
    <div className="discovery-page creator-page">
      <header className="creator-page-heading">
        <h1>{tr('Автор миров')}</h1>
      </header>
      <div className="creator-header creator-banner">
        <picture className="creator-decoration" aria-hidden="true">
          <source srcSet="/images/dreamwalk-world-night.webp" />
          <img src="/images/dreamwalk-world-night.webp" alt="" />
        </picture>
        <span className="avatar large">
          {data.creator.avatarAssetId ? (
            <img src={assetUrl(data.creator.avatarAssetId)} alt="" />
          ) : (
            data.creator.handle[0]
          )}
        </span>
        <div>
          <h2>@{data.creator.handle}</h2>
          <p className="creator-bio">
            {data.creator.bio || tr('Истории говорят об авторе лучше любых слов.')}
          </p>
        </div>
      </div>
      <h2 className="section-title">{tr('Опубликованные приключения')}</h2>
      <div className="adventure-grid discovery-grid">
        {data.adventures.map((a) => (
          <DiscoveryWorldCard adventure={a} key={a.id} portrait />
        ))}
      </div>
      {!data.adventures.length && (
        <Empty
          title={tr('Истории ещё впереди')}
          description={tr('Автор пока не опубликовал приключений.')}
        />
      )}
    </div>
  );
}
