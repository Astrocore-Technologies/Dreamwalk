'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Compass, Moon, Radio, UsersRound } from 'lucide-react';
import {
  adjacentFootprintAnchors,
  footprintInside,
  occupiedCells,
  footprintOverlaps,
} from '@dreamwalk/contracts';
import type { GameAction, GameEntity, GamePoint } from '@dreamwalk/contracts';
import { api, errorMessage, useClient, useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Field, Input, Loading, PageHeading } from '@/components/ui';
import { artPreviewUrl } from '../assets/types';
import { authorizedArt } from '../assets/art-visibility';
import { useAssetText } from '../assets/messages';
import { useCampaignArt } from '../assets/use-campaign-art';
import { HeroSelection, useHeroSelection, useHeroText, CampaignHero } from './hero-selection';
import { DirectorSelection, useDirectorSelection, CampaignDirector } from './director-selection';
import { useLaunchGate } from './use-launch-gate';
import { localizedProjection } from './localized-projection';
import { NarrativePreferences } from './narrative-preferences';
import { GameCanvas } from './game-canvas';
import { TurnControls } from './turn-controls';
import { useTurnText } from './turn-messages';
import { playerControlsAvailable } from './turn-ui';
import { UnifiedStory, type StoryRecipient } from './unified-story';
import { LivingNotices } from './living-notices';
import { useGame, type CampaignSummary } from './use-game';
import styles from './game.module.css';

function GameToolbar({ children }: { children: React.ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => setHost(document.getElementById('game-toolbar')), []);
  return host ? createPortal(children, host) : children;
}

function fitPlaySurface(element: HTMLDivElement | null) {
  if (!element) return;
  const update = () => {
    const top = element.getBoundingClientRect().top + window.scrollY;
    element.style.setProperty(
      '--game-play-height',
      `${Math.max(420, window.innerHeight - top - 12)}px`,
    );
  };
  const observer = new ResizeObserver(update);
  const toolbar = document.querySelector('.game-shell .topbar');
  if (toolbar) observer.observe(toolbar);
  if (element.parentElement) observer.observe(element.parentElement);
  window.addEventListener('resize', update);
  update();
  return () => {
    observer.disconnect();
    window.removeEventListener('resize', update);
  };
}

const actionKeys: Partial<Record<GameAction['kind'], string>> = {
  consume: 'Поесть',
  move_to: 'Подойти',
  wait: 'Ждать',
  inspect: 'Осмотреть',
  talk: 'Поговорить',
  distract: 'Отвлечь',
  pick_up: 'Подобрать',
  give: 'Передать',
  unlock: 'Отпереть',
  knock: 'Постучать',
  communicate: 'Сообщить наблюдение',
  lock: 'Запереть дверь',
  open: 'Открыть дверь',
  close: 'Закрыть дверь',
  transition: 'Перейти',
  defend: 'Ждать',
  flee: 'Покинуть столкновение',
};
const errorKeys: Record<string, string> = {
  OUT_OF_RANGE: 'Слишком далеко. Сначала подойди ближе.',
  PATH_BLOCKED: 'Путь перекрыт.',
  STALE_STATE: 'Мир изменился. Состояние обновлено.',
  TARGET_UNAVAILABLE: 'Этот предмет уже недоступен.',
  WRONG_MODE: 'Действие недоступно в текущем режиме.',
  ROUND_LOCKED: 'Намерение уже зафиксировано.',
  FORBIDDEN: 'У тебя нет доступа к этому действию.',
  UNAUTHORIZED: 'Войди в аккаунт, чтобы продолжить.',
  RATE_LIMITED: 'Слишком много запросов. Подожди немного и повтори.',
  SOURCE_ACCESS_REQUIRED:
    'У игрока нет доступа к исходной приватной истории. Сначала пригласи его в историю.',
};
function entityKey(entity: Pick<GameEntity, 'id' | 'kind'>, actorId: string) {
  if (entity.id === actorId) return 'Твой герой';
  if (entity.id === 'keeper') return 'Смотритель';
  if (entity.id === 'key') return 'Ключ обсерватории';
  if (entity.id === 'token') return 'Лунный жетон';
  if (entity.id === 'door') return 'Дверь на крышу';
  return entity.kind === 'player' ? 'Другой герой' : entity.kind === 'npc' ? 'NPC' : 'Предмет';
}
export function GamePage({ campaignId }: { campaignId?: string }) {
  return campaignId ? <CampaignRoom key={campaignId} campaignId={campaignId} /> : <CampaignLobby />;
}
function CampaignLobby() {
  const turnText = useTurnText();
  const heroSelection = useHeroSelection();
  const heroText = useHeroText();
  const directorSelection = useDirectorSelection('lobby');
  const launchGate = useLaunchGate(`${heroSelection.heroId}:${directorSelection.profileId}`);
  const { t } = useT();
  const router = useRouter();
  const campaigns = useResource<{ campaigns: CampaignSummary[] }>('/game/campaigns');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function create() {
    if (!heroSelection.ready || !directorSelection.ready) return;
    const lease = launchGate.begin();
    if (!lease) return;
    let navigating = false;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ campaignId: string }>('/game/campaigns', {
        method: 'POST',
        body: JSON.stringify({
          template: 'observatory-v1',
          turnBased: true,
          directorProfileId: directorSelection.profileId,
          ...heroSelection.body,
        }),
      });
      if (launchGate.accepts(lease)) {
        router.push(`/game/${result.campaignId}`);
        navigating = true;
      }
    } catch (err) {
      if (launchGate.accepts(lease)) setError(errorMessage(err));
    } finally {
      if (!navigating && launchGate.finish(lease)) setBusy(false);
    }
  }
  async function accept(id: string) {
    if (!heroSelection.ready) return;
    const lease = launchGate.begin();
    if (!lease) return;
    let navigating = false;
    setBusy(true);
    setError('');
    try {
      await api(`/game/campaigns/${id}/accept`, {
        method: 'POST',
        body: JSON.stringify(heroSelection.body),
      });
      if (launchGate.accepts(lease)) {
        router.push(`/game/${id}`);
        navigating = true;
      }
    } catch (err) {
      if (launchGate.accepts(lease)) setError(errorMessage(err));
    } finally {
      if (!navigating && launchGate.finish(lease)) setBusy(false);
    }
  }
  return (
    <div className={styles.root}>
      <PageHeading
        eyebrow={t('Игровой прототип')}
        title={t('Обсерватория')}
        description={turnText('lobbyIntro')}
      />
      <HeroSelection selection={heroSelection} disabled={busy} />
      <DirectorSelection selection={directorSelection} disabled={busy} />
      <Link
        className="button secondary"
        href={`/?heroId=${encodeURIComponent(heroSelection.heroId)}`}
      >
        {heroText('adventures')}
      </Link>
      <section className={styles.hero}>
        <div className={styles.heroArt} aria-hidden="true">
          <Moon size={72} strokeWidth={0.7} />
          <span>✧</span>
        </div>
        <div>
          <p className={styles.kicker}>{t('Исследование')}</p>
          <h2>{t('Обсерватория')}</h2>
          <p>{t('Этот отдельный тестовый мир не изменяет твои опубликованные истории.')}</p>
          <Button
            busy={busy}
            disabled={!heroSelection.ready || !directorSelection.ready}
            onClick={() => void create()}
          >
            <Compass size={18} />
            {t('Новая кампания')}
          </Button>
        </div>
      </section>
      {(error || campaigns.error) && <ErrorBox message={error || campaigns.error} />}
      <h2>{t('Твои кампании')}</h2>
      {campaigns.loading ? (
        <Loading />
      ) : !campaigns.data?.campaigns.length ? (
        <p className={styles.muted}>{t('Пока нет сохранений')}</p>
      ) : (
        <div className={styles.campaignList}>
          {campaigns.data.campaigns.map((campaign) => (
            <article key={campaign.id} className={styles.campaignCard}>
              <div>
                <span className={styles.kicker}>{t('Сохранённое прохождение')}</span>
                <h3>{campaign.title || t('Обсерватория')}</h3>
                <code>{campaign.id.slice(0, 8)}</code>
              </div>
              {campaign.membership === 'pending' ? (
                <Button
                  busy={busy}
                  disabled={!heroSelection.ready}
                  onClick={() => void accept(campaign.id)}
                >
                  {t('Принять приглашение в кампанию')}
                </Button>
              ) : (
                <Link className="button secondary" href={`/game/${campaign.id}`}>
                  {t('Продолжить приключение')}
                </Link>
              )}
            </article>
          ))}
        </div>
      )}
      <p className={styles.footnote}>
        {t('Это временные игровые изображения. Целевой стиль — рисованный 2D.')}
      </p>
    </div>
  );
}
function CampaignRoom({ campaignId }: { campaignId: string }) {
  const turnText = useTurnText();
  const [inspectedNpcId, setInspectedNpcId] = useState<string | null>(null);
  const [storyBusy, setStoryBusy] = useState(false);
  const [recipient, setRecipient] = useState<StoryRecipient>(null);
  useEffect(() => setRecipient(null), [campaignId]);
  const { t, locale } = useT();
  const { user } = useClient();
  const members = useResource<{
    ownerId: string;
    members: { userId: string; actorId: string; username: string; status: string }[];
  }>(`/game/campaigns/${campaignId}/members`);
  const game = useGame(campaignId);
  const p = useMemo(() => localizedProjection(game.projection, locale), [game.projection, locale]);
  const sceneMedia = useCampaignArt(campaignId, p?.map.id || '');
  const art = p ? authorizedArt(p, sceneMedia.art) : [];
  const artText = useAssetText();
  const artCredits = art.filter(
    (entry) =>
      entry.slot === `map:${p?.map.id}:background` ||
      p?.entities.some((entity) => entry.slot.startsWith(`entity:${entity.id}:`)),
  );
  const [username, setUsername] = useState(''),
    [inviteBusy, setInviteBusy] = useState(false),
    [inviteMessage, setInviteMessage] = useState('');
  const [selected, setSelected] = useState<GameAction>({ kind: 'wait' });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  const own = p?.entities.find((entity) => entity.id === p.actorId);
  const encounter =
    p?.encounter?.phase === 'planning' && p.encounter.participants.includes(p.actorId)
      ? p.encounter
      : undefined;
  const locked = !!(p && encounter?.intents[p.actorId]?.ready);
  const connected = game.connection === 'connected';
  const playerAvailable = playerControlsAvailable(p);
  const controlsDisabled = !connected || locked || game.busy || !playerAvailable;
  const membersLoading = useRef(members.loading);
  membersLoading.current = members.loading;
  useEffect(() => {
    if (!connected) return;
    const reloadIfVisible = () => {
      if (document.visibilityState === 'visible' && !membersLoading.current) members.reload();
    };
    const timer = setInterval(reloadIfVisible, 5000);
    document.addEventListener('visibilitychange', reloadIfVisible);
    reloadIfVisible();
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', reloadIfVisible);
    };
  }, [connected, members.reload]);
  useEffect(() => {
    setSelected((p && encounter?.intents[p.actorId]?.action) || { kind: 'wait' });
  }, [encounter?.id, encounter?.round, locked]);
  async function invite(event: React.FormEvent) {
    event.preventDefault();
    setInviteBusy(true);
    setInviteMessage('');
    try {
      await api(`/game/campaigns/${campaignId}/invitations`, {
        method: 'POST',
        body: JSON.stringify({ username: username.trim() }),
      });
      setInviteMessage(t('Игрок приглашён'));
      setUsername('');
      members.reload();
    } catch (err) {
      setInviteMessage(errorMessage(err));
    } finally {
      setInviteBusy(false);
    }
  }
  function act(action: GameAction) {
    if (!playerAvailable) return;
    if (encounter) {
      setSelected(action);
      return;
    }
    void game.command({ type: 'action', action });
  }
  function approach(entity: GamePoint) {
    if (!p || !own || !playerAvailable) return;
    const blocked = new Set(p.map.blocked.map((point) => `${point.x},${point.y}`));
    for (const door of p.entities)
      if (door.kind === 'door' && !door.open) blocked.add(`${door.x},${door.y}`);
    const points = adjacentFootprintAnchors(own, entity)
      .filter((point) => {
        const placed = { ...own, ...point };
        return (
          footprintInside(placed, { x: 0, y: 0, width: p.map.width, height: p.map.height }) &&
          occupiedCells(placed).every((cell) => !blocked.has(`${cell.x},${cell.y}`)) &&
          !p.entities.some(
            (other) =>
              other.id !== own.id &&
              (other.kind === 'npc' || other.kind === 'player') &&
              footprintOverlaps(placed, other),
          )
        );
      })
      .sort(
        (a, b) =>
          Math.abs(a.x - own.x) +
          Math.abs(a.y - own.y) -
          Math.abs(b.x - own.x) -
          Math.abs(b.y - own.y),
      );
    if (points[0]) {
      if (encounter) setSelected({ kind: 'move_to', target: points[0] });
      else game.move(points[0]);
    }
  }
  async function ready() {
    if (!p || !encounter) return;
    await game.command({
      type: 'encounter.intent',
      intent: {
        encounterId: encounter.id,
        generation: encounter.generation,
        round: encounter.round,
        intentRevision: (encounter.intents[p.actorId]?.revision || 0) + 1,
        action: selected,
        ready: true,
      },
    });
  }
  if (!p)
    return (
      <div className={styles.root}>
        <Link href="/game" className={`game-return ${styles.back}`}>
          <ArrowLeft size={16} />
          {t('К кампаниям')}
        </Link>
        {game.error ? (
          <ErrorBox
            message={t(errorKeys[game.error] || 'Сервис временно недоступен. Попробуй позже.')}
          />
        ) : (
          <Loading />
        )}
        <Button variant="secondary" onClick={() => void game.refresh()}>
          {t('Обновить состояние')}
        </Button>
      </div>
    );
  const turnError =
    p.turn && game.error === 'ROUND_LOCKED'
      ? turnText('locked')
      : p.turn && game.error === 'STALE_STATE'
        ? turnText('stale')
        : (p.turn && game.error === 'WRONG_MODE' && !p.turn.ownTurn) ||
            game.error === 'TURN_NOT_ACTIVE' ||
            game.error === 'OUT_OF_TURN'
          ? turnText('outOfTurn')
          : game.error === 'TURN_RESOURCE_EXHAUSTED' || game.error === 'NO_ACTION_RESOURCE'
            ? turnText('exhausted')
            : game.error === 'STALE_TURN'
              ? turnText('stale')
              : '';
  const inspectedNpc = p.entities.find((e) => e.kind === 'npc' && e.id === inspectedNpcId);
  const inspectedPortrait = inspectedNpc
    ? art.find((entry) => entry.slot === `entity:${inspectedNpc.id}:portrait`)
    : undefined;
  const inspectedPortraitUrl = inspectedPortrait ? artPreviewUrl(inspectedPortrait.url) : undefined;
  const selectedTarget = p.entities.find((entity) => entity.id === selected.targetId);
  return (
    <div className={`${styles.root} ${styles.activeRoom}`} data-testid="game-room">
      <GameToolbar>
        <div className={styles.roomHeader} data-game-toolbar>
          <div>
            <Link href="/game" className={`game-return ${styles.back}`}>
              <ArrowLeft size={16} />
              <span className={styles.visuallyHidden}>{t('К кампаниям')}</span>
            </Link>
            <h1>
              {p.map.label ||
                t(
                  p.map.id === 'roof'
                    ? 'Крыша'
                    : p.map.id === 'observatory'
                      ? 'Обсерватория'
                      : 'Локация',
                )}
            </h1>
          </div>
          <div className={styles.connection} data-connected={connected}>
            <Radio size={15} />
            <span role="status">
              {t(
                connected
                  ? 'Подключено'
                  : game.connection === 'connecting'
                    ? 'Подключение'
                    : game.connection === 'superseded'
                      ? 'Управление в другой вкладке'
                      : 'Переподключение',
              )}
            </span>
          </div>
          <TurnControls
            projection={p}
            connected={connected}
            busy={game.busy || storyBusy}
            activeName={
              members.data?.members.find((m) => m.actorId === p.turn?.activeActorId)?.username
            }
            onEnd={() => void game.command({ type: 'turn.end' })}
            onReaction={(decision) => void game.command({ type: 'turn.reaction', decision })}
          />
        </div>
      </GameToolbar>
      {game.error && (
        <ErrorBox
          message={
            turnError ||
            t(errorKeys[game.error] || 'Не удалось выполнить запрос. Попробуйте ещё раз.')
          }
        />
      )}
      {!connected && (
        <p className={styles.warning} role="status">
          {t(
            game.connection === 'superseded'
              ? 'Управление в другой вкладке'
              : 'Соединение потеряно. Движение остановлено.',
          )}
          {game.connection === 'superseded' && (
            <Button variant="secondary" onClick={game.reconnect}>
              {t('Вернуть управление сюда')}
            </Button>
          )}
        </p>
      )}
      <div className={styles.roomOptions}>
        <details className={styles.roomMetadata}>
          <summary>{t(encounter ? 'Планирование раунда' : 'Исследование')}</summary>
          {game.campaign?.title && <p className={styles.kicker}>{game.campaign.title}</p>}
          {game.campaign?.sourceRevision && (
            <small>
              {t('Игровая версия {version}', { version: game.campaign.sourceRevision })}
            </small>
          )}
          {own && (
            <p
              className={styles.position}
              data-testid="game-position"
              data-map-id={p.map.id}
              data-x={own.x}
              data-y={own.y}
            >
              {t('Твоя позиция: {x}, {y}', { x: own.x, y: own.y })}
            </p>
          )}
          <span className={styles.mode}>
            {t(encounter ? 'Планирование раунда' : 'Исследование')}
          </span>
        </details>
        <CampaignDirector campaignId={campaignId} disabled={!connected || game.busy || storyBusy} />
        <NarrativePreferences
          key={campaignId}
          campaignId={campaignId}
          disabled={!connected || game.busy || storyBusy}
        />
      </div>
      <div className={styles.playGrid} data-testid="game-play-surface" ref={fitPlaySurface}>
        <div className={styles.sceneColumn}>
          <GameCanvas
            projection={p}
            art={art}
            illustration={sceneMedia.illustration}
            disabled={controlsDisabled}
            planning={!!encounter}
            onStop={game.stop}
            onInspectNpc={setInspectedNpcId}
            onAction={act}
            onApproach={approach}
            onSelectNpc={(npcId) => {
              const npc = p.entities.find((entity) => entity.id === npcId && entity.kind === 'npc');
              if (npc) setRecipient({ id: npc.id, label: npc.label || t('NPC') });
            }}
            onMove={(target) => {
              if (encounter) setSelected({ kind: 'move_to', target });
              else game.move(target);
            }}
            reducedMotion={!!user?.settings.reducedMotion}
          />
          {p.map.backgroundMode !== 'schematic' && (
            <p className={styles.inspectionHelp}>{turnText('inspectHint')}</p>
          )}
          <div className={styles.inspectionButtons}>
            {p.entities
              .filter((e) => e.kind === 'npc')
              .map((npc) => (
                <Button
                  key={npc.id}
                  type="button"
                  variant="ghost"
                  onClick={() => setInspectedNpcId(npc.id)}
                >
                  {turnText('inspect')} · {npc.label || t('NPC')}
                </Button>
              ))}
          </div>
          {inspectedNpc && (
            <section
              className={styles.inspection}
              aria-live="polite"
              data-testid="npc-public-inspection"
            >
              <header>
                <h2>{inspectedNpc.label || t('NPC')}</h2>
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={turnText('close')}
                  onClick={() => setInspectedNpcId(null)}
                >
                  ×
                </Button>
              </header>
              {inspectedPortraitUrl && (
                <img
                  className={styles.artPortrait}
                  src={inspectedPortraitUrl}
                  alt={inspectedNpc.label || t('NPC')}
                />
              )}
              <p>
                {inspectedNpc.publicProfile?.description ||
                  inspectedNpc.supportingNpc?.description ||
                  turnText('noDescription')}
              </p>
              <p>
                {inspectedNpc.publicProfile?.appearance ||
                  inspectedNpc.supportingNpc?.appearance ||
                  ''}
              </p>
            </section>
          )}
        </div>
        <UnifiedStory
          key={campaignId}
          campaignId={campaignId}
          projection={p}
          recipient={recipient}
          onClearRecipient={() => setRecipient(null)}
          onWorldRefresh={() => void game.refresh()}
          onBusyChange={setStoryBusy}
          disabled={controlsDisabled}
          partyDisabled={!connected || game.busy}
          worldGenerationAllowed={members.data?.ownerId === user?.id}
        />
      </div>
      <div className={styles.roomGrid}>
        <div>
          {artCredits.length > 0 && (
            <details>
              <summary>{artText('credits')}</summary>
              <ul>
                {artCredits.map((entry) => (
                  <li key={entry.slot}>
                    {entry.attribution}
                    {entry.attribution ? ' · ' : ''}
                    {entry.licenseLabel}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {encounter && (
            <section className={styles.encounter} aria-label={t('Планирование раунда')}>
              <div>
                <h2>{t('Раунд {round}', { round: encounter.round })}</h2>
                <strong>
                  {encounter.deadlineMs
                    ? t('Осталось {seconds} с', {
                        seconds: Math.max(
                          0,
                          Math.ceil((encounter.deadlineMs - now - game.clockOffset) / 1000),
                        ),
                      })
                    : t('Ожидание без таймера')}
                </strong>
              </div>
              <p>
                {t(
                  'Выбери действие, затем подтверди готовность. Другие комнаты не останавливаются.',
                )}
              </p>
              <p>
                {t('Намерение: {action}', {
                  action:
                    selected.kind === 'hit' || selected.kind === 'push'
                      ? turnText(selected.kind)
                      : t(actionKeys[selected.kind] || 'Ждать'),
                })}
                {selectedTarget
                  ? ` · ${selectedTarget.label || t(entityKey(selectedTarget, p.actorId))}`
                  : ''}
              </p>
              {encounter.policy && (
                <p>
                  {t('Не более {rounds} раундов. Выход — действием у границы области.', {
                    rounds: encounter.policy.maxRounds,
                  })}
                </p>
              )}
              <div className={styles.actions}>
                <Button
                  variant="secondary"
                  disabled={locked || game.busy}
                  onClick={() => setSelected({ kind: 'wait' })}
                >
                  {t('Ждать')}
                </Button>
                <Button
                  variant="secondary"
                  disabled={locked || game.busy}
                  onClick={() => setSelected({ kind: 'flee' })}
                >
                  {t('Покинуть столкновение')}
                </Button>
                {encounter.policy && (
                  <Button
                    variant="ghost"
                    disabled={!connected || game.busy || encounter.endVotes?.includes(p.actorId)}
                    onClick={() => void game.command({ type: 'encounter.end' })}
                  >
                    {t(
                      encounter.endVotes?.includes(p.actorId)
                        ? 'Завершение запрошено'
                        : 'Предложить завершить',
                    )}
                  </Button>
                )}
                <Button
                  disabled={locked || !connected}
                  busy={game.busy}
                  onClick={() => void ready()}
                >
                  {t(locked ? 'Намерение зафиксировано' : 'Подтвердить намерение')}
                </Button>
              </div>
            </section>
          )}
          {!encounter &&
            p.nearbyEncounters?.map((near) => (
              <section key={near.id} className={styles.encounter}>
                <h2>{t('Столкновение рядом')}</h2>
                <p>{t('Раунд {round}', { round: near.round })}</p>
                <Button
                  disabled={!connected}
                  busy={game.busy}
                  onClick={() =>
                    void game.command({ type: 'encounter.join', encounterId: near.id })
                  }
                >
                  {t('Вступить со следующего раунда')}
                </Button>
              </section>
            ))}
        </div>
        <aside className={styles.hud}>
          <CampaignHero campaignId={campaignId} />
          <section>
            <h2>
              <UsersRound size={18} />
              {t('Участники кампании')}
            </h2>
            <ul className={styles.members}>
              {members.data?.members.map((member) => (
                <li
                  key={member.userId}
                  data-member-handle={member.username}
                  data-member-status={member.status}
                >
                  <span>
                    {member.username}
                    <small>
                      {t(
                        member.status === 'pending'
                          ? 'Ожидает ответа'
                          : member.status === 'revoked'
                            ? 'Доступ отозван'
                            : 'Принято',
                      )}
                    </small>
                  </span>
                  {members.data?.ownerId === user?.id &&
                    member.userId !== user?.id &&
                    member.status !== 'revoked' && (
                      <Button
                        variant="ghost"
                        onClick={() => {
                          if (!window.confirm(t('Отозвать доступ к кампании?'))) return;
                          void api(`/game/campaigns/${campaignId}/members/${member.userId}`, {
                            method: 'DELETE',
                          })
                            .then(() => members.reload())
                            .catch((err: unknown) => setInviteMessage(errorMessage(err)));
                        }}
                      >
                        {t('Отозвать доступ')}
                      </Button>
                    )}
                </li>
              ))}
            </ul>
            {members.data?.ownerId === user?.id && (
              <form onSubmit={(event) => void invite(event)} method="post">
                <Field label={t('Пригласить по имени пользователя')}>
                  <Input
                    value={username}
                    maxLength={40}
                    onChange={(event) => setUsername(event.target.value)}
                    placeholder="handle"
                    required
                    autoComplete="off"
                  />
                </Field>
                <Button
                  busy={inviteBusy}
                  disabled={!username.trim()}
                  type="submit"
                  variant="secondary"
                >
                  {t('Пригласить игрока')}
                </Button>
              </form>
            )}
            {inviteMessage && <p role="status">{inviteMessage}</p>}
          </section>
          <LivingNotices
            showJournal={false}
            projection={p}
            command={game.command}
            disabled={controlsDisabled}
          />
        </aside>
      </div>
    </div>
  );
}
