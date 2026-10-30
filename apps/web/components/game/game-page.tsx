'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Compass, KeyRound, Moon, Radio, UsersRound } from 'lucide-react';
import type { GameAction, GameEntity, GamePoint } from '@dreamwalk/contracts';
import { api, errorMessage, useClient, useResource } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Field, Input, Loading, PageHeading } from '@/components/ui';
import { authorizedArt } from '../assets/art-visibility';
import { useAssetText } from '../assets/messages';
import { useCampaignArt } from '../assets/use-campaign-art';
import { artPreviewUrl } from '../assets/types';
import { GameCanvas } from './game-canvas';
import { SponsorBudget } from './sponsor-budget';
import { IntentProposals } from './intent-proposals';
import { PartyChat } from './party-chat';
import { LivingAiPanel } from './living-ai-panel';
import { LivingConversation } from './living-conversation';
import { LivingNotices } from './living-notices';
import { useGame, type CampaignSummary } from './use-game';
import styles from './game.module.css';

const actionKeys: Record<GameAction['kind'], string> = {
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
const eventKeys: Record<string, string> = {
  'action.pick_up': 'Предмет передан',
  'action.give': 'Предмет передан',
  'action.open': 'Дверь открыта',
  'action.close': 'Дверь закрыта',
  'action.unlock': 'Дверь отперта',
  'actor.transitioned': 'Локация изменена',
  'encounter.completed': 'Раунд завершён',
  'round.resolved': 'Раунд завершён',
  'action.inspect': 'Осмотр завершён',
  'action.rejected': 'Действие отклонено',
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
  const { t } = useT();
  const router = useRouter();
  const campaigns = useResource<{ campaigns: CampaignSummary[] }>('/game/campaigns');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function create() {
    setBusy(true);
    setError('');
    try {
      const result = await api<{ campaignId: string }>('/game/campaigns', {
        method: 'POST',
        body: JSON.stringify({ template: 'observatory-v1' }),
      });
      router.push(`/game/${result.campaignId}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function accept(id: string) {
    setBusy(true);
    setError('');
    try {
      await api(`/game/campaigns/${id}/accept`, { method: 'POST', body: '{}' });
      router.push(`/game/${id}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={styles.root}>
      <PageHeading
        eyebrow={t('Игровой прототип')}
        title={t('Обсерватория')}
        description={t(
          'Настоящая ходьба, общие предметы и локальные раунды. Пока без платного AI.',
        )}
      />
      <section className={styles.hero}>
        <div className={styles.heroArt} aria-hidden="true">
          <Moon size={72} strokeWidth={0.7} />
          <span>✧</span>
        </div>
        <div>
          <p className={styles.kicker}>{t('Исследование')}</p>
          <h2>{t('Обсерватория')}</h2>
          <p>{t('Этот отдельный тестовый мир не изменяет твои опубликованные истории.')}</p>
          <Button busy={busy} onClick={() => void create()}>
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
                <Button busy={busy} onClick={() => void accept(campaign.id)}>
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
        {t('Прототип работает бесплатно на тестовых решениях NPC.')}
        <br />
        {t('Это временные игровые изображения. Целевой стиль — рисованный 2D.')}
      </p>
    </div>
  );
}
function CampaignRoom({ campaignId }: { campaignId: string }) {
  const { t } = useT();
  const { user } = useClient();
  const members = useResource<{
    ownerId: string;
    members: { userId: string; actorId: string; username: string; status: string }[];
  }>(`/game/campaigns/${campaignId}/members`);
  const game = useGame(campaignId);
  const p = game.projection;
  const fetchedArt = useCampaignArt(campaignId, p?.map.id || '');
  const art = p ? authorizedArt(p, fetchedArt) : [];
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
  const nearby = useMemo(() => p?.entities.filter((entity) => entity.id !== p.actorId) || [], [p]);
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
    if (encounter) {
      setSelected(action);
      return;
    }
    void game.command({ type: 'action', action });
  }
  function approach(entity: GamePoint) {
    if (!p || !own) return;
    const blocked = new Set(p.map.blocked.map((point) => `${point.x},${point.y}`));
    for (const door of p.entities)
      if (door.kind === 'door' && !door.open) blocked.add(`${door.x},${door.y}`);
    const points = [
      { x: entity.x - 1, y: entity.y },
      { x: entity.x + 1, y: entity.y },
      { x: entity.x, y: entity.y - 1 },
      { x: entity.x, y: entity.y + 1 },
    ]
      .filter(
        (point) =>
          point.x >= 0 &&
          point.y >= 0 &&
          point.x < p.map.width &&
          point.y < p.map.height &&
          !blocked.has(`${point.x},${point.y}`),
      )
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
        <Link href="/game" className={styles.back}>
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
  const selectedTarget = p.entities.find((entity) => entity.id === selected.targetId);
  return (
    <div className={styles.root}>
      <div className={styles.roomHeader}>
        <div>
          <Link href="/game" className={styles.back}>
            <ArrowLeft size={16} />
            {t('К кампаниям')}
          </Link>
          {game.campaign?.title && <p className={styles.kicker}>{game.campaign.title}</p>}
          {game.campaign?.sourceRevision && (
            <small>
              {t('Игровая версия {version}', { version: game.campaign.sourceRevision })}
            </small>
          )}
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
      </div>
      {game.error && (
        <ErrorBox
          message={t(errorKeys[game.error] || 'Не удалось выполнить запрос. Попробуйте ещё раз.')}
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
      <div className={styles.roomGrid}>
        <div>
          <GameCanvas
            projection={p}
            art={art}
            disabled={!connected || locked}
            planning={!!encounter}
            onStop={game.stop}
            onMove={(target) => {
              if (encounter) setSelected({ kind: 'move_to', target });
              else game.move(target);
            }}
            reducedMotion={!!user?.settings.reducedMotion}
          />
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
                {t('Намерение: {action}', { action: t(actionKeys[selected.kind]) })}
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
          <section className={styles.objects}>
            <header>
              <h2>{t('Предметы рядом')}</h2>
              <Button
                variant="ghost"
                disabled={!connected || !!encounter}
                busy={game.busy}
                onClick={() => void game.command({ type: 'encounter.begin' })}
              >
                {t('Начать координацию')}
              </Button>
            </header>
            {!nearby.length && <p className={styles.muted}>{t('Видимых объектов нет')}</p>}
            {nearby.map((entity) => (
              <article
                key={entity.id}
                className={styles.object}
                data-entity-id={entity.id}
                data-x={entity.x}
                data-y={entity.y}
              >
                <div>
                  {entity.kind === 'npc' &&
                    art.find((entry) => entry.slot === `entity:${entity.id}:portrait`) && (
                      <img
                        className={styles.artPortrait}
                        loading="lazy"
                        decoding="async"
                        width={72}
                        height={88}
                        src={artPreviewUrl(
                          art.find((entry) => entry.slot === `entity:${entity.id}:portrait`)!.url,
                        )}
                        alt={entity.label || t('NPC')}
                      />
                    )}
                  <h3>{entity.label || t(entityKey(entity, p.actorId))}</h3>
                  <small>
                    {t('Координаты: {x}, {y}', { x: entity.x, y: entity.y })}
                    {entity.kind === 'door'
                      ? ` · ${t(entity.locked ? 'Заперто' : entity.open ? 'Открыто' : 'Закрыто')}`
                      : ''}
                  </small>
                </div>
                <div className={styles.actions}>
                  <Button
                    variant="ghost"
                    disabled={!connected || locked || game.busy}
                    onClick={() => approach(entity)}
                  >
                    {t('Подойти')}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!connected || locked || game.busy}
                    onClick={() => act({ kind: 'inspect', targetId: entity.id })}
                  >
                    {t('Осмотреть')}
                  </Button>
                  {entity.kind === 'item' && (
                    <Button
                      disabled={!connected || locked || game.busy}
                      onClick={() => act({ kind: 'pick_up', targetId: entity.id })}
                    >
                      {t('Подобрать')}
                    </Button>
                  )}
                  {entity.kind === 'door' && (
                    <Button
                      disabled={!connected || locked || game.busy}
                      onClick={() =>
                        act({
                          kind: entity.locked ? 'unlock' : entity.open ? 'close' : 'open',
                          targetId: entity.id,
                          ...(entity.locked ? { itemId: entity.keyId } : {}),
                        })
                      }
                    >
                      {t(
                        entity.locked
                          ? 'Отпереть'
                          : entity.open
                            ? 'Закрыть дверь'
                            : 'Открыть дверь',
                      )}
                    </Button>
                  )}
                  {entity.kind === 'door' && p.rulesetVersion === 'hybrid-v3' && (
                    <>
                      <Button
                        variant="secondary"
                        disabled={!connected || locked || game.busy}
                        onClick={() => act({ kind: 'knock', targetId: entity.id })}
                      >
                        {t('Постучать')}
                      </Button>
                      {!entity.locked && !entity.open && entity.keyId && (
                        <Button
                          variant="secondary"
                          disabled={!connected || locked || game.busy}
                          onClick={() =>
                            act({ kind: 'lock', targetId: entity.id, itemId: entity.keyId })
                          }
                        >
                          {t('Запереть дверь')}
                        </Button>
                      )}
                    </>
                  )}
                  {entity.kind === 'npc' && (
                    <>
                      <Button
                        variant="secondary"
                        disabled={!connected || locked || game.busy}
                        onClick={() => act({ kind: 'talk', targetId: entity.id })}
                      >
                        {t(p.rulesetVersion === 'hybrid-v3' ? 'Попросить помощи' : 'Поговорить')}
                      </Button>
                      {p.rulesetVersion === 'hybrid-v3' && (
                        <Button
                          variant="secondary"
                          disabled={!connected || locked || game.busy}
                          onClick={() => act({ kind: 'distract', targetId: entity.id })}
                        >
                          {t('Отвлечь')}
                        </Button>
                      )}
                      {p.rulesetVersion !== 'hybrid-v3' && (
                        <Button
                          disabled={!connected || !!encounter}
                          busy={game.busy}
                          onClick={() =>
                            void game.command({
                              type: 'npc.request',
                              action: { kind: 'talk', targetId: entity.id },
                            })
                          }
                        >
                          {t('Попросить NPC действовать')}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </article>
            ))}
            {p.map.exits.map((exit) => (
              <article key={exit.id} className={styles.object}>
                <div>
                  <h3>
                    {exit.label ||
                      t(
                        exit.destinationMapId === 'roof'
                          ? 'Крыша'
                          : exit.destinationMapId === 'observatory'
                            ? 'Обсерватория'
                            : 'Переход',
                      )}
                  </h3>
                  <small>{t('Координаты: {x}, {y}', { x: exit.x, y: exit.y })}</small>
                </div>
                <div className={styles.actions}>
                  <Button
                    variant="ghost"
                    disabled={!connected || locked || game.busy}
                    onClick={() => approach(exit)}
                  >
                    {t('Подойти')}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!connected || locked || game.busy}
                    onClick={() => act({ kind: 'transition', targetId: exit.id })}
                  >
                    {t('Перейти')}
                  </Button>
                </div>
              </article>
            ))}
          </section>
        </div>
        <aside className={styles.hud}>
          <section>
            <h2>
              <KeyRound size={18} />
              {t('Инвентарь героя')}
            </h2>
            {p.inventory.length ? (
              <ul className={styles.inventory}>
                {p.inventory.map((item) => (
                  <li key={item.id} data-inventory-id={item.id}>
                    <span>◇</span>
                    {item.label || t(entityKey(item, p.actorId))}
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.muted}>{t('Пустой инвентарь')}</p>
            )}
            <small>{t('Предметы сохраняются сразу; движение — с контрольными точками.')}</small>
          </section>
          <section>
            <h2>
              <UsersRound size={18} />
              {t('Участники кампании')}
            </h2>
            <ul className={styles.members}>
              {members.data?.members.map((member) => (
                <li key={member.userId}>
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
          <LivingConversation
            key={campaignId}
            projection={p}
            disabled={!connected || game.busy || locked}
            command={game.command}
          />
          <IntentProposals
            campaignId={campaignId}
            projection={p}
            disabled={!connected || game.busy || locked}
          />
          <PartyChat campaignId={campaignId} actorId={p.actorId} disabled={!connected} />
          <LivingNotices
            projection={p}
            command={game.command}
            disabled={!connected || game.busy || locked}
          />
          <SponsorBudget
            campaignId={campaignId}
            owner={members.data?.ownerId === user?.id}
            disabled={!connected}
          />
          <LivingAiPanel
            campaignId={campaignId}
            projection={p}
            disabled={!connected || game.busy}
          />
          <section>
            <h2>{t('Журнал событий')}</h2>
            <ol className={styles.journal} aria-live="polite" aria-relevant="additions">
              {game.events.length ? (
                game.events.map((event) => (
                  <li key={event.id}>
                    {t(
                      event.code
                        ? errorKeys[event.code] || 'Действие отклонено'
                        : eventKeys[event.kind] || 'Действие подтверждено',
                    )}
                  </li>
                ))
              ) : (
                <li className={styles.muted}>{t('Новых событий пока нет')}</li>
              )}
            </ol>
          </section>
          <p className={styles.footnote}>
            {t('Прототип работает бесплатно на тестовых решениях NPC.')}
            <br />
            {t('Это временные игровые изображения. Целевой стиль — рисованный 2D.')}
          </p>
        </aside>
      </div>
    </div>
  );
}
