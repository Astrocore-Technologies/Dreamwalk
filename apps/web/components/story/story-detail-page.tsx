'use client';
import './story-detail.css';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  ArrowRight,
  UsersRound,
  Heart,
  Compass,
  Shield,
  List,
  ChevronDown,
} from 'lucide-react';
import {
  selectAdventureText,
  selectAdventureTags,
  selectNpcText,
  type ControlledTag,
} from '@dreamwalk/contracts';
import { formatCount } from '@/lib/locales';
import { useT } from '@/lib/i18n';
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
import { Badge, Button, ButtonLink, ErrorBox, Field, Loading, Modal, Textarea } from '../ui';
import { StoryMetrics, StoryLikeButton } from '../story-metrics';
import { storyReturnPath, withStoryReturn } from '../story-return';
import { AdventureLaunch } from '../game/adventure-launch';
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
    <div className="story-detail-page" data-testid="story-detail">
      <Link
        className="sd-back-link"
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
      <section className="sd-story-overview">
        <div className="sd-story-poster">
          <img src={coverUrl(a)} alt="" decoding="async" />
        </div>
        <div className="sd-story-intro">
          <div className="sd-story-kicker">
            <span>{taxonomy(a.genre)}</span>
            {a.visibility === 'private' && <Badge>{tr('Частный мир')}</Badge>}
          </div>
          <h1>{text.title}</h1>
          <Link className="discovery-author" href={`/creators/${a.author.handle}`}>
            <span className="tiny-avatar">{a.author.handle[0]}</span>
            {a.author.handle}
            <ArrowUpRight size={14} />
          </Link>
          <p className="sd-story-synopsis">{text.synopsis}</p>
          <StoryMetrics adventure={a} />
          <div className="sd-story-tags">
            {selectAdventureTags(a, locale, tagDefinitions.data || []).map((tag, index) => (
              <span key={index}>#{tag}</span>
            ))}
          </div>
        </div>
        <aside className="sd-story-actions">
          <div className="sd-prepare-panel">
            <h2>{tr('Перед приключением')}</h2>
            <div className="sd-detail-facts">
              <span>
                <UsersRound size={18} />
                {tr('Группа')}
                <strong>
                  {a.playersMin}–{formatCount(locale, a.playersMax, 'player')}
                </strong>
              </span>
              <span>
                <Compass size={18} />
                {tr('Сложность')}
                <strong>{taxonomy(a.difficulty)}</strong>
              </span>
            </div>
            {user &&
              a.visibility === 'public' &&
              (a.access === 'public' || a.status === 'published') && (
                <StoryLikeButton key={a.id} adventure={a} onChanged={reload} />
              )}
            <ButtonLink
              variant="secondary"
              href={withStoryReturn('/my-characters', storyReturnPath(a.slug))}
            >
              {tr('Подготовить героя')}
              <ArrowRight size={17} />
            </ButtonLink>
            <AdventureLaunch adventure={a} />
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
        <div className="sd-story-body">
          <div className="sd-story-sections">
            {!!a.npcs?.length && (
              <section className="sd-story-section">
                <h2>{tr('Ты встретишь')}</h2>
                <div className="sd-npc-preview-grid">
                  {a.npcs.map((n) => (
                    <article key={n.id} className="sd-npc-preview">
                      <div className="sd-npc-identity">
                        <span className="sd-character-orb">
                          {n.portraitAssetId ? (
                            <img src={assetUrl(n.portraitAssetId)} alt="" />
                          ) : (
                            selectNpcText(n, locale).name[0]
                          )}
                        </span>
                        <h3>{selectNpcText(n, locale).name}</h3>
                        <span className="muted">{selectNpcText(n, locale).role}</span>
                      </div>
                      {selectNpcText(n, locale).description && (
                        <p>{selectNpcText(n, locale).description}</p>
                      )}
                      {selectNpcText(n, locale).greeting && (
                        <p>«{selectNpcText(n, locale).greeting}»</p>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            )}
            <details className="sd-story-about">
              <summary>
                <List size={24} aria-hidden="true" />
                <span>{tr('За порогом истории')}</span>
                <ChevronDown size={24} aria-hidden="true" />
              </summary>
              <p className="prose">{text.synopsis}</p>
            </details>
            {a.access !== 'invited' && (
              <details className="sd-story-versions">
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
      </section>
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
