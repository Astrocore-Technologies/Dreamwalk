'use client';
import { WalletSettlementLink } from './owner-settlements';
import walletStyles from './library-wallet.module.css';
import { NotificationsContent } from './notifications';
import { DreamsWalletSection, useDreamsText } from './dreams-wallet';
import { useDreamsWallet } from '@/lib/use-dreams-wallet';
import { useSparksWallet } from '@/lib/use-sparks-wallet';
import { sparksBalanceMessages } from './sparks-balance';
import { shopButtonLabel } from './shop';
import { HeroPortraitControl } from './hero-portrait-control';
import { CharacterSpriteControl } from './visual-authoring/character-sprite-control';
import { useVisualText } from './visual-authoring/messages';
import { readStoryReturn, storyWithHero } from './story-return';
import { StoryReturnLink } from './story-return-link';
import { useHeroText } from './game/hero-selection';
import { CampaignHistory } from './game/campaign-history';
import type { CampaignSummary } from './game/use-game';
import { useT } from '@/lib/i18n';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import styles from './heroes.module.css';
import {
  ArrowUpRight,
  Feather,
  ImageIcon,
  Pencil,
  Play,
  Plus,
  Sparkles,
  UserRound,
  X,
} from 'lucide-react';
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
import type { Invitation } from '@dreamwalk/contracts';
import { formatSparkSubunits, selectAdventureText } from '@dreamwalk/contracts';
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
import { FramedPortrait } from './framed-portrait';
import { PortraitFrameEditor } from './portrait-frame-editor';
export function LibraryPage() {
  const date = useDate();
  const { t: tr, locale } = useT();
  const { toast } = useClient();
  const params = useSearchParams();
  const { data, loading, error, reload } = useResource<{
    favorites: Adventure[];
    drafts: Adventure[];
    privatePublished: Adventure[];
    heroes: Hero[];
    shared: Adventure[];
  }>('/library');
  const invitations = useResource<Invitation[]>('/invitations');
  const campaigns = useResource<{ campaigns: CampaignSummary[] }>('/game/campaigns');
  const router = useRouter();
  const requestedTab = params.get('tab') || '';
  const tab = ['shared', 'invitations', 'playable', 'drafts', 'history'].includes(requestedTab)
    ? requestedTab
    : 'favorites';
  // A completed invitation may update only the navigation that started it.
  // Invalidate on every transition, including Back/Forward to the same tab later.
  const queryKey = params.toString();
  const responseScope = useRef({ queryKey, active: true });
  if (responseScope.current.queryKey !== queryKey) {
    responseScope.current.active = false;
    responseScope.current = { queryKey, active: true };
  }
  useEffect(() => {
    responseScope.current.active = false;
    responseScope.current = { ...responseScope.current, active: true };
    return () => {
      responseScope.current.active = false;
    };
  }, []);
  function setTab(next: string) {
    responseScope.current.active = false;
    responseScope.current = { queryKey, active: true };
    setResponse(null);
    const query = new URLSearchParams(params.toString());
    query.set('tab', next);
    router.push(`/library?${query}`, { scroll: false });
  }
  const [response, setResponse] = useState<{
    scope: typeof responseScope.current;
    id: string;
  } | null>(null);
  const busy = response?.scope === responseScope.current ? response.id : null;
  const invitationLabels = {
    pending: tr('Ожидает ответа'),
    accepted: tr('Принято'),
    declined: tr('Отклонено'),
    revoked: tr('Доступ отозван'),
  };
  async function respond(id: string, decision: 'accept' | 'decline') {
    const scope = responseScope.current;
    setResponse({ scope, id });
    try {
      await api(`/invitations/${id}/respond`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      if (!scope.active) return;
      invitations.reload();
      reload();
      toast(
        decision === 'accept'
          ? tr('Приглашение принято. Мир появился в общей библиотеке.')
          : tr('Приглашение отклонено.'),
      );
      if (decision === 'accept') setTab('shared');
    } catch (error) {
      if (scope.active) toast(errorMessage(error));
    } finally {
      if (scope.active) setResponse(null);
    }
  }
  return (
    <div className={walletStyles.library}>
      <PageHeading
        title={tr('Моя библиотека')}
        description={tr(
          'Миры, к которым хочется вернуться. И истории, которым ещё предстоит случиться.',
        )}
      />
      <div className={walletStyles.tabs} aria-label={tr('Моя библиотека')}>
        {[
          ['favorites', tr('Избранные миры'), data?.favorites.length],
          ['shared', tr('Приглашённые миры'), data?.shared?.length],
          [
            'invitations',
            tr('Приглашения'),
            invitations.data?.filter((i) => i.status === 'pending').length,
          ],
          [
            'playable',
            locale === 'ru'
              ? 'Мои игровые публикации'
              : locale === 'uk'
                ? 'Мої ігрові публікації'
                : 'My playable releases',
            data?.privatePublished?.length,
          ],
          ['drafts', tr('Мои истории'), data?.drafts.length],
          ['history', tr('Прохождения'), campaigns.data?.campaigns.length],
        ].map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            aria-pressed={tab === key}
            className={tab === key ? walletStyles.active : ''}
            onClick={() => setTab(String(key))}
          >
            {label}
            <span>{count || 0}</span>
          </button>
        ))}
      </div>
      <div className={walletStyles.actionBand}>
        <ButtonLink href="/explore">
          <Plus size={20} />
          {tr('Найти новый мир')}
          <ArrowUpRight size={20} />
        </ButtonLink>
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
            <div className={`stack invitation-list ${walletStyles.invitations}`}>
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
      ) : tab === 'history' ? (
        <CampaignHistory resource={campaigns} />
      ) : loading ? (
        <Loading />
      ) : tab === 'playable' ? (
        <div className="adventure-grid">
          {data?.privatePublished?.map((a) => (
            <AdventureCard key={a.id} adventure={a} />
          ))}
          {!data?.privatePublished?.length && (
            <p>
              {locale === 'ru'
                ? 'Сначала подготовьте игровой план и опубликуйте историю приватно в мастерской.'
                : locale === 'uk'
                  ? 'Спочатку підготуйте ігровий план та опублікуйте історію приватно в майстерні.'
                  : 'Build a playable plan and publish your story privately in Studio first.'}
            </p>
          )}
        </div>
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
        <div className={walletStyles.drafts}>
          {data.drafts.map((a) => (
            <Link
              className={`panel ${walletStyles.draft}`}
              key={a.id}
              href={`/studio/adventures/${a.id}`}
            >
              {a.coverAssetId ? (
                <img className={walletStyles.draftCover} src={assetUrl(a.coverAssetId)} alt="" />
              ) : (
                <Feather size={28} aria-hidden="true" />
              )}
              <span>
                <strong>{selectAdventureText(a, locale).title}</strong>
                <small>{tr('Обновлено {date}', { date: date(a.updatedAt) })}</small>
              </span>
              <Badge>{a.status === 'published' ? tr('Опубликовано') : tr('Черновик')}</Badge>
              {a.visibility === 'private' && <Badge>{tr('Приватный')}</Badge>}
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
    </div>
  );
}
export function HeroesPage() {
  const visualText = useVisualText();
  const returnTo = readStoryReturn(useSearchParams());
  const heroText = useHeroText();
  const { t: tr, locale } = useT();
  const appearanceLabel =
    locale === 'ru' ? 'Образ героя' : locale === 'uk' ? 'Образ героя' : 'Hero appearance';
  const [traitsText, setTraitsText] = useState('');
  const { toast } = useClient();
  const resource = useResource<Hero[]>('/heroes');
  const [editing, setEditing] = useState<Partial<Hero> | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [remove, setRemove] = useState<Hero | null>(null);
  return (
    <section className={styles.page}>
      <PageHeading
        title={tr('Мои герои')}
        action={
          <Button
            onClick={() => {
              setError('');
              setTraitsText('');
              setEditing({ name: '', backstory: '', notes: '', traits: [] });
            }}
          >
            <Plus size={17} />
            {tr('Создать героя')}
          </Button>
        }
      />
      <StoryReturnLink intent={returnTo} />
      <ErrorBox message={resource.error} retry={resource.reload} />
      {resource.loading ? (
        <Loading />
      ) : resource.data?.length ? (
        <div className={`hero-grid ${styles.grid}`}>
          {resource.data.map((hero) => (
            <Panel key={hero.id} className={`hero-card ${styles.card}`}>
              <div className={`hero-portrait ${styles.portrait}`}>
                {hero.portraitAssetId ? (
                  <FramedPortrait
                    src={assetUrl(hero.portraitAssetId)}
                    alt={hero.name}
                    frame={hero.portraitFrame}
                  />
                ) : (
                  <UserRound size={55} />
                )}
                <span className="portrait-star">✧</span>
              </div>
              <div className={styles.cardBody}>
                <h2>{hero.name}</h2>
                <div className={`filter-chips ${styles.traits}`}>
                  {hero.traits.map((trait, index) => (
                    <Badge key={`${trait}-${index}`}>
                      <Sparkles size={15} aria-hidden="true" />
                      {trait}
                    </Badge>
                  ))}
                </div>
                <p className={styles.backstory}>
                  {hero.backstory || tr('История этого героя ещё не рассказана.')}
                </p>
                <details className={styles.appearance}>
                  <summary>
                    <ImageIcon size={18} aria-hidden="true" />
                    {appearanceLabel}
                  </summary>
                  <CharacterSpriteControl
                    target={{ kind: 'hero', id: hero.id }}
                    onSaved={resource.reload}
                  />
                </details>
                <div className={styles.cardActions}>
                  <ButtonLink
                    href={
                      storyWithHero(returnTo, hero.id) ||
                      `/explore?heroId=${encodeURIComponent(hero.id)}`
                    }
                  >
                    <Play size={17} aria-hidden="true" />
                    {heroText('play')}
                  </ButtonLink>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setError('');
                      setTraitsText(hero.traits.join(', '));
                      setEditing(hero);
                    }}
                  >
                    <Pencil size={17} aria-hidden="true" />
                    {tr('Редактировать')}
                  </Button>
                </div>
                <Button variant="ghost" className={styles.remove} onClick={() => setRemove(hero)}>
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
            <Button
              onClick={() => {
                setError('');
                setTraitsText('');
                setEditing({ name: '', backstory: '', notes: '', traits: [] });
              }}
            >
              <Plus size={17} />
              {tr('Создать первого героя')}
            </Button>
          }
        />
      )}
      <div className={styles.workshop}>
        <ButtonLink href="/studio/visuals" variant="ghost">
          {visualText('title')}
        </ButtonLink>
      </div>
      <div className="platform-note">
        <UserRound size={16} />
        {tr('Герои принадлежат игрокам. Персонажи мира (NPC) создаются отдельно в студии автора.')}
      </div>
      {editing && (
        <Modal
          className={styles.editor}
          title={editing.id ? tr('История твоего героя') : tr('Новый герой')}
          onClose={() => setEditing(null)}
        >
          <div className={styles.editorScroll}>
            <form
              id="hero-editor"
              method="post"
              className={styles.editorForm}
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
                      portraitFrame: fields.portraitAssetId ? (fields.portraitFrame ?? null) : null,
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
              <div className={styles.portraitColumn}>
                <div className={styles.editorPortrait}>
                  {editing.portraitAssetId ? (
                    <FramedPortrait
                      className="upload-preview"
                      src={assetUrl(editing.portraitAssetId)}
                      alt={tr('Портрет героя')}
                      frame={editing.portraitFrame}
                    />
                  ) : (
                    <UserRound size={100} aria-hidden="true" />
                  )}
                </div>
                <UploadField
                  label={tr('Загрузить портрет')}
                  onUploaded={(asset) =>
                    setEditing((current) =>
                      current
                        ? { ...current, portraitAssetId: asset.id, portraitFrame: null }
                        : null,
                    )
                  }
                />
                <PortraitFrameEditor
                  src={assetUrl(editing.portraitAssetId)}
                  value={editing.portraitFrame}
                  onChange={(frame) =>
                    setEditing((current) => (current ? { ...current, portraitFrame: frame } : null))
                  }
                />
              </div>
              <div className={styles.fields}>
                <Field label={tr('Имя героя')}>
                  <Input
                    required
                    minLength={2}
                    maxLength={80}
                    value={editing.name || ''}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  />
                </Field>
                <Field label={tr('Предыстория')}>
                  <Textarea
                    maxLength={6000}
                    value={editing.backstory || ''}
                    onChange={(e) => setEditing({ ...editing, backstory: e.target.value })}
                    placeholder={tr('Откуда герой пришёл? Что оставил позади?')}
                  />
                </Field>
                <div className={styles.traitEditor}>
                  <Field label={tr('Черты характера')} hint={tr('Через запятую, до 12 черт')}>
                    <Input
                      value={traitsText}
                      onChange={(e) => {
                        setTraitsText(e.target.value);
                        setEditing({
                          ...editing,
                          traits: e.target.value
                            .split(',')
                            .map((trait) => trait.trim())
                            .filter(Boolean),
                        });
                      }}
                      placeholder={tr('Любопытный, упрямый, добрый')}
                    />
                  </Field>
                  <div className={styles.traits}>
                    {editing.traits?.map((trait, index) => (
                      <button
                        type="button"
                        key={`${trait}-${index}`}
                        className={styles.traitChip}
                        aria-label={`${tr('Удалить')}: ${trait}`}
                        onClick={() => {
                          const traits = editing.traits!.filter((_, at) => at !== index);
                          setEditing({ ...editing, traits });
                          setTraitsText(traits.join(', '));
                        }}
                      >
                        <Sparkles size={14} aria-hidden="true" />
                        {trait}
                        <X size={14} aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                </div>
                <Field label={tr('Личные заметки')}>
                  <Textarea
                    value={editing.notes || ''}
                    maxLength={6000}
                    onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                  />
                </Field>
                <ErrorBox message={error} />
              </div>
            </form>
            <HeroPortraitControl
              name={editing.name || ''}
              backstory={editing.backstory || ''}
              traits={editing.traits || []}
              onSelected={(assetId) =>
                setEditing((current) =>
                  current ? { ...current, portraitAssetId: assetId, portraitFrame: null } : null,
                )
              }
            />
          </div>
          <div className={`form-actions ${styles.editorActions}`}>
            <Button type="button" variant="secondary" onClick={() => setEditing(null)}>
              {tr('Отмена')}
            </Button>
            <Button type="submit" form="hero-editor" busy={busy}>
              {tr('Сохранить героя')}
            </Button>
          </div>
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
    </section>
  );
}
export function WalletPage() {
  const { text: dreamsText } = useDreamsText();
  const date = useDate();
  const { t: tr, locale } = useT();
  const { user } = useClient();
  const sparks = useSparksWallet(user?.id);
  const dreams = useDreamsWallet(user?.id);
  const text = sparksBalanceMessages[locale];
  const labels =
    locale === 'ru'
      ? {
          admin_credit: 'Начисление администратором',
          admin_debit: 'Списание администратором',
          reserve: 'Резерв',
          capture: 'Списано',
          release: 'Возврат резерва',
          pending: 'На сверке',
          empty: 'Здесь появятся начисления и расходы искр.',
        }
      : locale === 'uk'
        ? {
            admin_credit: 'Нарахування адміністратором',
            admin_debit: 'Списання адміністратором',
            reserve: 'Резерв',
            capture: 'Списано',
            release: 'Повернення резерву',
            pending: 'На звірці',
            empty: 'Тут з’являться нарахування та витрати іскор.',
          }
        : {
            admin_credit: 'Administrator credit',
            admin_debit: 'Administrator debit',
            reserve: 'Reserved',
            capture: 'Charged',
            release: 'Reservation released',
            pending: 'Pending reconciliation',
            empty: 'Sparks credits and usage will appear here.',
          };
  const kinds: Record<string, string> = { ...labels, starter_grant: text.starter };
  return (
    <div className={walletStyles.wallet}>
      <PageHeading title={dreamsText.title} description={dreamsText.description} />
      <div className={walletStyles.balanceBanner}>
        <DreamsWalletSection part="balance" wallet={dreams} />
        <section className="balance-card" aria-label={text.available}>
          <Sparkles size={24} />
          <p>{text.available}</p>
          <h2 aria-live="polite" data-testid="wallet-sparks-balance">
            {sparks.data
              ? formatSparkSubunits(sparks.data.availableSubunits, locale)
              : sparks.unavailable
                ? '—'
                : '…'}
            <span>✦</span>
          </h2>
          {sparks.data && (
            <small>
              {dreamsText.held}: {formatSparkSubunits(sparks.data.heldSubunits, locale, 'exact')}
            </small>
          )}
          <Link className="button primary compact" href="/shop" data-testid="open-spark-shop">
            {shopButtonLabel[locale]}
          </Link>
        </section>
      </div>
      <ErrorBox message={sparks.unavailable ? text.unavailable : ''} retry={sparks.reload} />
      <WalletSettlementLink />
      <Panel>
        <h2>
          {tr('Искры')} · {tr('История операций')}
        </h2>
        {!sparks.data && !sparks.unavailable ? (
          <Loading />
        ) : sparks.data?.ledger.length ? (
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
                {sparks.data.ledger.map((entry) => {
                  const credit = ['starter_grant', 'admin_credit'].includes(entry.kind);
                  const debit = ['capture', 'admin_debit'].includes(entry.kind);
                  return (
                    <tr key={entry.id}>
                      <td>
                        <span className={walletStyles.operation}>
                          <Sparkles size={18} aria-hidden="true" />
                          {kinds[entry.kind]}
                        </span>
                        {entry.reason && <small className="cell-subtitle">{entry.reason}</small>}
                      </td>
                      <td>{date(entry.createdAt)}</td>
                      <td className={credit ? 'positive' : ''}>
                        {credit ? '+' : debit ? '−' : ''}
                        {formatSparkSubunits(entry.amountSubunits, locale, 'exact')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : sparks.data ? (
          <Empty title={tr('Здесь пока тихо')} description={labels.empty} />
        ) : null}
      </Panel>
      <DreamsWalletSection part="history" wallet={dreams} />
    </div>
  );
}
export function NotificationsPage() {
  return <NotificationsContent />;
}
