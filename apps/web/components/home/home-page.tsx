'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Compass,
  Globe2,
  Play,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { selectAdventureText, selectNpcText, type Adventure } from '@dreamwalk/contracts';
import { api, assetUrl, coverUrl, errorMessage, useClient, useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, Empty, ErrorBox, Loading } from '@/components/ui';
import type { CampaignSummary } from '@/components/game/use-game';
import { HeroSelection, useHeroSelection } from '../game/hero-selection';
import { LaunchGate } from './launch-gate';
import { useHomeText } from './messages';
import styles from './home.module.css';
function Rail({
  kind,
  adventures,
  heroId,
}: {
  kind: 'mystery' | 'wonder';
  adventures: Adventure[];
  heroId: string;
}) {
  const h = useHomeText(),
    { locale, taxonomy } = useT(),
    scroller = useRef<HTMLDivElement>(null);
  if (!adventures.length) return null;
  const move = (direction: number) =>
    scroller.current?.scrollBy({
      left: direction * 320,
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  return (
    <section className={styles.railSection} data-home-rail={kind}>
      <header className={styles.sectionHeading}>
        <div>
          <p className={styles.eyebrow}>{h('curated')}</p>
          <h2>{h(kind)}</h2>
          <p className={styles.sectionHint}>
            {h(kind === 'mystery' ? 'mysteryHint' : 'wonderHint')}
          </p>
        </div>
        <div className={styles.railControls}>
          <Link href={`/explore${heroId ? `?heroId=${encodeURIComponent(heroId)}` : ''}`}>
            {h('browse')}
            <ArrowUpRight size={16} />
          </Link>
          <button type="button" aria-label={h('railPrevious')} onClick={() => move(-1)}>
            <ChevronLeft size={18} />
          </button>
          <button type="button" aria-label={h('railNext')} onClick={() => move(1)}>
            <ChevronRight size={18} />
          </button>
        </div>
      </header>
      <div ref={scroller} className={styles.rail}>
        {adventures.map((adventure) => {
          const text = selectAdventureText(adventure, locale);
          return (
            <Link
              className={styles.railCard}
              data-adventure-id={adventure.id}
              key={adventure.id}
              href={`/adventures/${adventure.slug}${heroId ? `?heroId=${encodeURIComponent(heroId)}` : ''}`}
            >
              <div className={styles.railArt}>
                <img
                  loading="lazy"
                  decoding="async"
                  src={coverUrl(adventure)}
                  alt=""
                  width={480}
                  height={320}
                />
                <span>{taxonomy(adventure.genre)}</span>
                <ArrowUpRight className={styles.cardArrow} size={20} />
              </div>
              <h3>{text.title}</h3>
              <p>{text.synopsis}</p>
              <div className={styles.cardFoot}>
                <span>{adventure.author.name}</span>
                <span>
                  <UsersRound size={13} />
                  {adventure.playersMin}–{adventure.playersMax}
                </span>
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}
export function HomePage() {
  const heroSelection = useHeroSelection();
  const h = useHomeText(),
    { locale, taxonomy } = useT(),
    { user } = useClient(),
    router = useRouter();
  const catalog = useResource<Adventure[]>('/adventures?sort=popular');
  const adventures = (catalog.error ? [] : catalog.data || []).filter(
    (item) => item.visibility === 'public' && item.status === 'published',
  );
  const [index, setIndex] = useState(0),
    [busy, setBusy] = useState(false),
    [launchError, setLaunchError] = useState('');
  const active = adventures[index % Math.max(1, adventures.length)];
  const details = useResource<Adventure>(
    active ? `/adventures/${encodeURIComponent(active.slug)}?view=published` : null,
  );
  const campaigns = useResource<{ campaigns: CampaignSummary[] }>(user ? '/game/campaigns' : null);
  const saved = user
    ? campaigns.data?.campaigns.filter(
        (campaign) => campaign.membership === 'accepted' && campaign.status === 'active',
      ) || []
    : [];
  const text = active ? selectAdventureText(active, locale) : null;
  const publicDetails =
    details.data?.id === active?.id &&
    details.data?.visibility === 'public' &&
    details.data?.status === 'published'
      ? details.data
      : null;
  const cast = publicDetails?.npcs?.slice(0, 3) || [];
  const startVersion = publicDetails?.playableVersionId || active?.playableVersionId;
  const gesture = useRef<{ x: number; y: number } | null>(null),
    swiped = useRef(false);
  const launchGate = useRef(new LaunchGate());
  launchGate.current.select(`${user?.id || ''}:${active?.id || ''}:${heroSelection.heroId}`);
  useEffect(() => {
    const gate = launchGate.current;
    gate.activate();
    return () => gate.dispose();
  }, []);
  useEffect(() => {
    setLaunchError('');
  }, [active?.id]);
  const shift = (direction: number) => {
    if (!launchGate.current.busy && adventures.length > 1)
      setIndex((value) => (value + direction + adventures.length) % adventures.length);
  };
  async function start() {
    if (!active || launchGate.current.busy || !heroSelection.ready) return;
    if (!startVersion) {
      router.push(
        `/adventures/${active.slug}${heroSelection.heroId ? `?heroId=${encodeURIComponent(heroSelection.heroId)}` : ''}`,
      );
      return;
    }
    if (!user) {
      router.push('/auth/sign-in');
      return;
    }
    const lease = launchGate.current.begin();
    if (!lease) return;
    setBusy(true);
    setLaunchError('');
    let navigating = false;
    try {
      const result = await api<{ campaignId: string }>('/game/campaigns', {
        method: 'POST',
        body: JSON.stringify({ playableVersionId: startVersion, ...heroSelection.body }),
      });
      if (launchGate.current.accepts(lease)) {
        router.push(`/game/${result.campaignId}`);
        navigating = true;
      }
    } catch (error) {
      if (launchGate.current.accepts(lease)) setLaunchError(errorMessage(error));
    } finally {
      if (!navigating && launchGate.current.finish(lease)) setBusy(false);
    }
  }
  const mystery = adventures.filter((item) =>
    /тайн|мист|детект|приключ|myster|detect|adventure|таєм|пригод/i.test(item.genre),
  );
  const wonder = adventures.filter((item) =>
    /фэнт|фент|fant|уют|затиш|cozy|роман|roman/i.test(item.genre),
  );
  return (
    <div className={styles.page}>
      <header className={styles.intro}>
        <div>
          <span className={styles.introMark}>✦</span>
          <p>{h('intro')}</p>
        </div>
        <Link href="/library">
          {h('library')}
          <ArrowUpRight size={15} />
        </Link>
      </header>
      {catalog.error && (
        <div data-testid="home-catalog-error">
          <ErrorBox message={catalog.error} retry={catalog.reload} />
        </div>
      )}
      {catalog.loading ? (
        <Loading />
      ) : active && text ? (
        <>
          <section
            className={styles.carousel}
            aria-label={h('featured')}
            aria-roledescription={h('carousel')}
            data-testid="home-featured"
            data-featured-slug={active.slug}
            data-featured-id={active.id}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                shift(1);
              }
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                shift(-1);
              }
            }}
            onPointerDown={(event) => {
              swiped.current = false;
              if (event.pointerType === 'touch')
                gesture.current = { x: event.clientX, y: event.clientY };
            }}
            onPointerCancel={() => {
              gesture.current = null;
            }}
            onPointerUp={(event) => {
              const first = gesture.current;
              gesture.current = null;
              if (!first) return;
              const x = event.clientX - first.x,
                y = event.clientY - first.y;
              if (Math.abs(x) > 50 && Math.abs(x) > Math.abs(y) * 1.4) {
                swiped.current = true;
                shift(x < 0 ? 1 : -1);
              }
            }}
            onClickCapture={(event) => {
              if (swiped.current) {
                swiped.current = false;
                event.preventDefault();
                event.stopPropagation();
              }
            }}
          >
            {adventures.length > 1 && (
              <>
                <div
                  className={`${styles.peek} ${styles.peekLeft}`}
                  aria-hidden="true"
                  style={{
                    backgroundImage: `url("${coverUrl(adventures[(index - 1 + adventures.length) % adventures.length])}")`,
                  }}
                />
                <div
                  className={`${styles.peek} ${styles.peekRight}`}
                  aria-hidden="true"
                  style={{
                    backgroundImage: `url("${coverUrl(adventures[(index + 1) % adventures.length])}")`,
                  }}
                />
              </>
            )}
            <article className={styles.feature}>
              <div className={styles.featureArt}>
                <img
                  key={active.id}
                  src={coverUrl(active)}
                  alt=""
                  width={1536}
                  height={1024}
                  fetchPriority="high"
                />
                <div className={styles.artStamp}>
                  <span>{h('brand')}</span>
                  <span>✦</span>
                </div>
              </div>
              <div className={styles.featureCopy}>
                <p className={styles.eyebrow}>
                  <span className={styles.goldDot} />
                  {h('spotlight')}
                </p>
                <h1>{text.title}</h1>
                <p className={styles.hook}>{text.synopsis}</p>
                <Link className={styles.byline} href={`/creators/${active.author.handle}`}>
                  @{active.author.handle}
                  <ArrowUpRight size={12} />
                </Link>
                <div className={styles.metadata}>
                  <span>
                    <Compass size={14} />
                    {taxonomy(active.genre)}
                  </span>
                  <span>
                    <UsersRound size={14} />
                    {active.playersMax > 1
                      ? active.playersMin === 1
                        ? `${h('solo')} / ${h('coop')}`
                        : h('coop')
                      : h('solo')}
                  </span>
                  <span title={h('sourceLanguage')}>
                    <Globe2 size={14} />
                    {(active.sourceLanguage || 'ru').toUpperCase()}
                  </span>
                </div>
                {cast.length > 0 && (
                  <div className={styles.cast}>
                    <p>{h('meet')}</p>
                    <div>
                      {cast.map((npc) => {
                        const name = selectNpcText(npc, locale).name;
                        return (
                          <figure key={npc.id} data-home-npc={npc.id}>
                            <div className={styles.portrait}>
                              {npc.portraitAssetId ? (
                                <img
                                  src={assetUrl(npc.portraitAssetId)}
                                  alt={name}
                                  width={72}
                                  height={88}
                                  loading="lazy"
                                  decoding="async"
                                />
                              ) : (
                                <span role="img" aria-label={`${name} · ${h('portraitMissing')}`}>
                                  <UserRound size={30} strokeWidth={1} />
                                </span>
                              )}
                            </div>
                            <figcaption>{name}</figcaption>
                          </figure>
                        );
                      })}
                    </div>
                  </div>
                )}
                {(startVersion || heroSelection.heroId) && (
                  <HeroSelection selection={heroSelection} disabled={busy} />
                )}
                <div className={styles.featureActions}>
                  <Button
                    data-testid="home-start-adventure"
                    busy={busy}
                    disabled={!heroSelection.ready}
                    onClick={() => void start()}
                  >
                    <Play size={16} fill="currentColor" />
                    {h(startVersion ? 'start' : 'open')}
                  </Button>
                  <Link
                    href={`/adventures/${active.slug}${heroSelection.heroId ? `?heroId=${encodeURIComponent(heroSelection.heroId)}` : ''}`}
                  >
                    {h('details')}
                    <ArrowRight size={16} />
                  </Link>
                </div>
                <ErrorBox message={launchError} />
              </div>
            </article>
            {adventures.length > 1 && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  data-testid="home-previous"
                  className={`${styles.heroArrow} ${styles.previous}`}
                  aria-label={h('previous')}
                  onClick={() => shift(-1)}
                >
                  <ChevronLeft size={23} />
                </button>
                <button
                  type="button"
                  disabled={busy}
                  data-testid="home-next"
                  className={`${styles.heroArrow} ${styles.next}`}
                  aria-label={h('next')}
                  onClick={() => shift(1)}
                >
                  <ChevronRight size={23} />
                </button>
              </>
            )}
          </section>
          <div className={styles.pagination}>
            <span>
              {String((index % adventures.length) + 1).padStart(2, '0')}
              <i /> {String(adventures.length).padStart(2, '0')}
            </span>
            <div>
              {adventures.map((adventure, i) => (
                <button
                  key={adventure.id}
                  type="button"
                  disabled={busy}
                  aria-label={`${h('numbered')} ${i + 1}`}
                  aria-current={i === index % adventures.length ? 'true' : undefined}
                  onClick={() => {
                    if (!launchGate.current.busy) setIndex(i);
                  }}
                />
              ))}
            </div>
          </div>
        </>
      ) : (
        !catalog.error && <Empty title={h('empty')} description={h('emptyHint')} />
      )}
      <section className={styles.continue} data-testid="home-continue">
        <div className={styles.continueIcon}>
          <BookOpen size={25} strokeWidth={1.3} />
        </div>
        <div className={styles.continueCopy}>
          <p className={styles.eyebrow}>{h('continue')}</p>
          <h2>{saved[0] ? saved[0].title || h('saved') : h(user ? 'noSave' : 'signIn')}</h2>
          <p>{h(saved.length ? 'saved' : user ? 'noSaveHint' : 'signInHint')}</p>
        </div>
        <Link
          className={styles.continueLink}
          href={saved[0] ? `/game/${saved[0].id}` : user ? '/game' : '/auth/sign-in'}
        >
          {h(saved.length ? 'resume' : user ? 'saves' : 'signIn')}
          <ArrowRight size={18} />
        </Link>
      </section>
      {user && campaigns.error && <ErrorBox message={campaigns.error} retry={campaigns.reload} />}
      <Rail kind="mystery" adventures={mystery} heroId={heroSelection.heroId} />
      <Rail kind="wonder" adventures={wonder.length ? wonder : []} heroId={heroSelection.heroId} />
    </div>
  );
}
