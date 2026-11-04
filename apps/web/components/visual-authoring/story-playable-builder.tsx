'use client';
import { MapImageNotice } from '../game/map-image-notice';
import Link from 'next/link';
import { ArrowLeft, Box, Check, MapPin, Sparkles, UsersRound } from 'lucide-react';
import styles from './story-playable-builder.module.css';
import { useEffect, useRef, useState } from 'react';
import { formatSparkSubunits, type AuthoredGameDraft } from '@dreamwalk/contracts';
import { providerSparkSubunits } from './spark-equivalent';
import { api, errorMessage } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { SparkQuoteNotice, SparkQuotePrice, SparkReceiptCost, useSparkCosts } from './sparks-cost';
import { Button, ErrorBox } from '../ui';
import { GameCanvas } from '../game/game-canvas';
import { compilePlayableDraft, createStateFromPlayable, projectState } from '@dreamwalk/game-core';
type State = {
  id: string;
  status: string;
  sourceHash: string;
  draft: AuthoredGameDraft | null;
  sourceCurrent: boolean;
  jobs: {
    id: string;
    status: string;
    error_code: string;
    sparkStatus?: string;
    sparkReservedSubunits?: string;
    sparkCapturedSubunits?: string | null;

    actual_micros?: number | string | null;
  }[];
};
type Quote = {
  imageInputCount?: number;
  schematicMapCount?: number;
  sparks?: { quoteId: string; reserveSubunits: string; rateVersion: string; walletCharging: true };
  id: string;
  buildId?: string;
  sourceHash?: string;
  reserveMicros: number;
  estimatedTotalMicros?: number;
  expiresAt: string;
};
const copy = {
  title: [
    'Подготовить игру из истории',
    'Build gameplay from your story',
    'Підготувати гру з історії',
  ],
  stages: ['Этапы подготовки мира', 'World preparation stages', 'Етапи підготовки світу'],
  preparation: ['Подготовка', 'Preparation', 'Підготовка'],
  evaluation: ['Оценка', 'Estimate', 'Оцінка'],
  generation: ['Генерация', 'Generation', 'Генерація'],
  verification: ['Проверка', 'Review', 'Перевірка'],
  application: ['Применить', 'Apply', 'Застосувати'],
  back: ['Назад к редактору', 'Back to editor', 'Назад до редактора'],
  locations: ['Локации', 'Locations', 'Локації'],
  characters: ['Персонажи', 'Characters', 'Персонажі'],
  objects: ['Объекты', 'Objects', 'Об’єкти'],
  empty: ['Нет в этом плане', 'None in this plan', 'Немає в цьому плані'],
  preview: ['Предпросмотр стартовой карты', 'Starting map preview', 'Перегляд початкової карти'],
  summary: ['Состав подготовленного мира', 'Prepared world contents', 'Склад підготовленого світу'],
  prepare: ['Подготовить план', 'Prepare plan', 'Підготувати план'],
  quote: ['Узнать стоимость AI-плана', 'Quote AI plan', 'Дізнатися вартість AI-плану'],
  dispatch: [
    'Создать план за указанную стоимость',
    'Generate plan at the quoted cost',
    'Створити план за вказану вартість',
  ],
  review: [
    'Я проверил геометрию, NPC и применение сохранённых изображений',
    'I reviewed geometry, NPC placements and saved image reuse',
    'Я перевірив геометрію, NPC та використання збережених зображень',
  ],
  apply: ['Применить к истории', 'Apply to story', 'Застосувати до історії'],
  refresh: ['Обновить состояние', 'Refresh status', 'Оновити стан'],
  done: [
    'Игра собрана и сохранена. Она ещё не опубликована: выберите приватную публикацию отдельно.',
    'Gameplay is assembled and saved. It is not published yet: choose private publication separately.',
    'Гру зібрано й збережено. Її ще не опубліковано: виберіть приватну публікацію окремо.',
  ],
  estimated: ['Оценка', 'Estimated', 'Оцінка'],
  reserved: [
    'Резерв провайдера при подтверждении',
    'Provider reserve on confirmation',
    'Резерв провайдера після підтвердження',
  ],
  sparks: ['Искры', 'Sparks', 'Іскри'],
  estimateUnknown: [
    'Оценка пока недоступна',
    'Estimate not available yet',
    'Оцінка поки недоступна',
  ],
  loading: [
    'Восстанавливаем состояние сборки…',
    'Restoring build status…',
    'Відновлюємо стан збірки…',
  ],
  mapIntentMismatch: [
    'План не соблюдает заданные размеры или пропорции. Карта не применена. Проверьте форму и описание локаций, затем подготовьте новый план; автоматического повтора нет.',
    'The plan does not match the requested dimensions or aspect. No map was applied. Review location shape and description, then prepare a new plan; there is no automatic retry.',
    'План не відповідає заданим розмірам або пропорціям. Карту не застосовано. Перевірте форму й опис локацій, потім підготуйте новий план; автоматичного повтору немає.',
  ],
  stale: [
    'История изменилась. Подготовьте новый план.',
    'The story changed. Prepare a new plan.',
    'Історія змінилася. Підготуйте новий план.',
  ],
  expired: [
    'Срок цены истёк. Запросите новую оценку.',
    'The quote expired. Request a new estimate.',
    'Термін ціни минув. Запросіть нову оцінку.',
  ],
  prepared: ['Исходные данные готовы', 'Source content is ready', 'Вихідні дані готові'],
  proposed: ['План готов к проверке', 'Plan ready for review', 'План готовий до перевірки'],
  queued: ['Запрос ожидает выполнения', 'Request is queued', 'Запит очікує виконання'],
  running: ['План создаётся', 'Generating the plan', 'План створюється'],
  generated: [
    'Проверяем созданный план',
    'Validating the generated plan',
    'Перевіряємо створений план',
  ],
  committed: ['План проверен', 'Plan validated', 'План перевірено'],
  failed: [
    'План не создан. Можно явно начать новую подготовку.',
    'No plan was created. You can explicitly start a new preparation.',
    'План не створено. Можна явно почати нову підготовку.',
  ],
  cancelled: ['Запрос отменён', 'Request cancelled', 'Запит скасовано'],
  unknown: [
    'Результат запроса уточняется. Не повторяйте генерацию; обновите состояние.',
    'The request outcome is unresolved. Do not regenerate; refresh its status.',
    'Результат запиту уточнюється. Не повторюйте генерацію; оновіть стан.',
  ],
  unavailable: ['Сборка пока недоступна', 'Build status is unavailable', 'Збірка поки недоступна'],
  capacity: [
    'Для этой сборки нужны 1–4 локации и не более 8 NPC.',
    'This builder requires 1–4 locations and at most 8 NPCs.',
    'Для цієї збірки потрібні 1–4 локації та не більше 8 NPC.',
  ],
  intro: [
    'AI предлагает расположение ваших локаций и NPC. Это отдельный запрос с ценой и согласием; применение не публикует историю и не меняет текущие игры.',
    'AI proposes geometry for your own locations and NPCs. This is a separate quoted request requiring consent; applying it neither publishes the story nor changes current games.',
    'AI пропонує геометрію ваших локацій та NPC. Це окремий запит із ціною та згодою; застосування не публікує історію й не змінює поточні ігри.',
  ],
} as const;
export function StoryPlayableBuilder({
  adventureId,
  beforePrepare,
  onApplied,
}: {
  adventureId: string;
  beforePrepare?: () => Promise<unknown>;
  onApplied?: () => void;
}) {
  const costs = useSparkCosts();
  const { locale, t } = useT(),
    i = locale === 'ru' ? 0 : locale === 'en' ? 1 : 2,
    copyText = (k: keyof typeof copy) => copy[k][i];
  const [state, setState] = useState<State | null>(null),
    [quote, setQuote] = useState<Quote | null>(null),
    [review, setReview] = useState(false),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [error, setError] = useState('');
  const lock = useRef(false),
    epoch = useRef(0),
    current = useRef<State | null>(null),
    ops = useRef(new Map<string, string>());
  function receive(next: State | null) {
    const prior = current.current;
    if (
      !next ||
      !next.sourceCurrent ||
      prior?.id !== next.id ||
      prior?.sourceHash !== next.sourceHash ||
      prior?.status !== next.status ||
      JSON.stringify(prior?.jobs) !== JSON.stringify(next.jobs)
    ) {
      setQuote(null);
      setReview(false);
    }
    current.current = next;
    setState(next);
  }
  useEffect(() => {
    const token = ++epoch.current;
    lock.current = true;
    setBusy(true);
    setLoaded(false);
    setError('');
    receive(null);
    ops.current.clear();
    void api<State | null>('/story-builds/adventures/' + adventureId + '/latest')
      .then((next) => {
        if (token !== epoch.current) return;
        receive(next);
        setLoaded(true);
      })
      .catch((e) => {
        if (token === epoch.current) setError(errorMessage(e));
      })
      .finally(() => {
        if (token !== epoch.current) return;
        lock.current = false;
        setBusy(false);
      });
    return () => {
      epoch.current++;
    };
  }, [adventureId]);
  async function mutate(path: string, b: object) {
    const key = JSON.stringify({ path, b });
    if (!ops.current.has(key)) ops.current.set(key, crypto.randomUUID());
    return api(path, {
      method: 'POST',
      body: JSON.stringify({ ...b, operationId: ops.current.get(key) }),
    });
  }
  function localizedError(e: unknown) {
    const code = (e as { code?: string })?.code;
    if (code === 'STORY_CONTEXT_STALE' || code === 'AUTHORING_STALE') return copyText('stale');
    if (code === 'STORY_PLAN_CAPACITY') return copyText('capacity');
    if (code === 'STORY_PLANNER_UNAVAILABLE') return copyText('unavailable');
    return errorMessage(e);
  }
  const unresolved = state?.jobs.some(
    (j) => !['committed', 'failed', 'rejected', 'stale', 'cancelled'].includes(j.status),
  );
  async function act(kind: 'prepare' | 'quote' | 'dispatch' | 'apply' | 'refresh') {
    if (lock.current) return;
    if (kind === 'prepare' && (!loaded || unresolved)) return;
    lock.current = true;
    const token = ++epoch.current;
    const active = () => token === epoch.current;
    setBusy(true);
    setError('');
    let id = state?.id;
    try {
      if (kind === 'refresh') {
        const next = await api<State | null>('/story-builds/adventures/' + adventureId + '/latest');
        if (!active()) return;
        receive(next);
        setLoaded(true);
        return;
      }
      await beforePrepare?.();
      if (!active()) return;
      if (kind === 'prepare') {
        setQuote(null);
        setReview(false);
        const path = '/story-builds/adventures/' + adventureId + '/prepare';
        const p = (await mutate(path, {})) as { id: string };
        if (!active()) return;
        id = p.id;
        // A confirmed preparation ends this operation. Explicit later preparation gets a new ID.
        ops.current.delete(JSON.stringify({ path, b: {} }));
      } else if (state) {
        const fresh = await api<State>('/story-builds/' + id);
        if (!active()) return;
        receive(fresh);
        if (
          !fresh.sourceCurrent ||
          fresh.sourceHash !== state.sourceHash ||
          fresh.id !== state.id
        ) {
          setError(copyText('stale'));
          return;
        }
        if (kind === 'quote') {
          if (fresh.status !== 'prepared' || fresh.jobs.length) return;
          setQuote(null);
          const s = await api<{
            sessionId: string | null;
            authorizationId?: string | null;
            generationAuthorizationId?: string;
          }>('/generation/status');
          if (!active()) return;
          const path = '/story-builds/' + id + '/quote';
          const body = {
            sessionId: s.authorizationId ?? s.generationAuthorizationId ?? s.sessionId ?? undefined,
          };
          const result = (await mutate(path, body)) as Quote;
          if (!active()) return;
          setQuote({ ...result, buildId: fresh.id, sourceHash: fresh.sourceHash });
          ops.current.delete(JSON.stringify({ path, b: body }));
          return;
        }
        if (kind === 'dispatch' && quote) {
          if (
            fresh.jobs.length ||
            fresh.status !== 'prepared' ||
            quote.buildId !== fresh.id ||
            quote.sourceHash !== fresh.sourceHash
          ) {
            setQuote(null);
            return;
          }
          if (
            !Number.isFinite(Date.parse(quote.expiresAt)) ||
            Date.parse(quote.expiresAt) <= Date.now()
          ) {
            setQuote(null);
            setError(copyText('expired'));
            return;
          }
          if (!Number.isSafeInteger(quote.reserveMicros) || quote.reserveMicros < 0) {
            setQuote(null);
            setError(copyText('unavailable'));
            return;
          }
          // Clear consent-bearing quote before dispatch; unknown outcomes require status recovery.
          setQuote(null);
          await mutate('/story-builds/' + id + '/dispatch', { quoteId: quote.id, consent: true });
        } else if (kind === 'apply') {
          if (!review || fresh.status !== 'proposed' || !fresh.draft) return;
          await mutate('/story-builds/' + id + '/apply', {
            sourceHash: fresh.sourceHash,
            reviewed: true,
            imageReuseConsent: true,
          });
          if (!active()) return;
          onApplied?.();
        }
      }
      if (!active()) return;
      if (id) {
        const next = await api<State>('/story-builds/' + id);
        if (active()) receive(next);
      }
    } catch (e) {
      if (active()) {
        setQuote(null);
        setReview(false);
        setError(localizedError(e));
      }
    } finally {
      if (active()) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  const statusText = (status: string) => {
    const key = (
      {
        dispatched: 'running',
        unknown: 'unknown',
        prepared: 'prepared',
        proposed: 'proposed',
        applied: 'done',
        queued: 'queued',
        generated: 'generated',
        committed: 'committed',
        failed: 'failed',
        rejected: 'failed',
        stale: 'stale',
        cancelled: 'cancelled',
      } as Record<string, keyof typeof copy>
    )[status];
    return copyText(key ?? 'unavailable');
  };
  const sparkAmount = (micros: number) => {
    const subunits = providerSparkSubunits(
      micros,
      quote?.sparks ? (quote.sparks.rateVersion ?? null) : undefined,
    );
    return subunits === null ? copyText('estimateUnknown') : formatSparkSubunits(subunits, locale);
  };
  const compiled = state?.draft ? compilePlayableDraft(state.draft) : null;
  const projection = compiled?.playable
    ? projectState(createStateFromPlayable(compiled.playable, ['story-preview']), 'story-preview')
    : null;
  const step = !state?.sourceCurrent
    ? 0
    : state.status === 'applied'
      ? 4
      : state.status === 'proposed'
        ? 3
        : state.jobs.length > 0 || ['dispatched', 'generated'].includes(state.status)
          ? 2
          : state.status === 'prepared'
            ? 1
            : 0;
  const stages = [
    'preparation',
    'evaluation',
    'generation',
    'verification',
    'application',
  ] as const;
  const label = (item: {
    label: string;
    labelTranslations?: Partial<Record<typeof locale, string>>;
  }) => item.labelTranslations?.[locale] || item.label;
  const mapLabel = (id: string) => {
    const map = state?.draft?.maps.find((item) => item.id === id);
    return map ? label(map) : '';
  };
  return (
    <section className={styles.builder} data-testid="story-playable-builder" data-locale={locale}>
      <header className={`page-heading ${styles.heading}`}>
        <div>
          <h1>{copyText('title')}</h1>
          <Link href={`/studio/adventures/${adventureId}`} className={styles.back}>
            <ArrowLeft size={18} aria-hidden="true" /> {copyText('back')}
          </Link>
        </div>
      </header>
      <ol className={styles.steps} aria-label={copyText('stages')}>
        {stages.map((stage, index) => (
          <li
            key={stage}
            aria-current={index === step ? 'step' : undefined}
            data-stage-state={index < step ? 'complete' : index === step ? 'current' : 'upcoming'}
          >
            <span className={styles.stepNumber} aria-hidden="true">
              {index < step ? <Check size={18} /> : index + 1}
            </span>
            <span>{copyText(stage)}</span>
          </li>
        ))}
      </ol>
      <p className={styles.intro}>{copyText('intro')}</p>
      {!loaded && <p role="status">{busy ? copyText('loading') : copyText('unavailable')}</p>}
      {!state ? (
        <>
          <Button busy={busy} disabled={!loaded} onClick={() => void act('prepare')}>
            {copyText('prepare')}
          </Button>
          {!loaded && (
            <Button busy={busy} variant="secondary" onClick={() => void act('refresh')}>
              {copyText('refresh')}
            </Button>
          )}
        </>
      ) : (
        <>
          <div className={styles.statusBand}>
            <p role="status">
              <Sparkles size={24} aria-hidden="true" /> {statusText(state.status)}
            </p>
            <div className={styles.statusActions}>
              <Button busy={busy} variant="secondary" onClick={() => void act('refresh')}>
                {copyText('refresh')}
              </Button>
              {!unresolved &&
                (state.status !== 'prepared' || state.jobs.length > 0 || !state.sourceCurrent) && (
                  <Button
                    busy={busy}
                    variant="secondary"
                    data-testid="builder-reprepare"
                    onClick={() => void act('prepare')}
                  >
                    {copyText('prepare')}
                  </Button>
                )}
            </div>
          </div>
          {!state.sourceCurrent && <p role="alert">{copyText('stale')}</p>}
          {state.sourceCurrent && state.status === 'prepared' && !state.jobs.length && (
            <Button busy={busy} onClick={() => void act('quote')}>
              {copyText('quote')}
            </Button>
          )}
          {quote && (
            <div className={styles.quote}>
              {quote.sparks && <SparkQuotePrice quote={quote} />}
              <SparkQuoteNotice quote={quote} />
              <MapImageNotice
                count={quote.imageInputCount}
                schematicCount={quote.schematicMapCount}
              />
              <p>
                {copyText('estimated')}:{' '}
                {quote.estimatedTotalMicros === undefined
                  ? copyText('estimateUnknown')
                  : sparkAmount(quote.estimatedTotalMicros) + ' ' + copyText('sparks')}
              </p>
              <p>
                {copyText('reserved')}: {sparkAmount(quote.reserveMicros)} {copyText('sparks')}
              </p>
              <Button
                busy={busy}
                disabled={
                  !Number.isSafeInteger(quote.reserveMicros) ||
                  quote.reserveMicros < 0 ||
                  !Number.isFinite(Date.parse(quote.expiresAt)) ||
                  Date.parse(quote.expiresAt) <= Date.now() ||
                  !state.sourceCurrent ||
                  !!unresolved
                }
                onClick={() => void act('dispatch')}
              >
                {copyText('dispatch')}
              </Button>
            </div>
          )}
          {state.jobs.map((j) => (
            <p role="status" className={styles.jobStatus} key={j.id}>
              {j.error_code === 'STORY_MAP_INTENT_MISMATCH'
                ? copyText('mapIntentMismatch')
                : j.error_code?.startsWith('MAP_IMAGE_')
                  ? t(
                      'Не удалось уверенно определить безопасный старт на изображении карты. План не применён.',
                    )
                  : statusText(j.status)}
              {j.sparkStatus && (
                <>
                  {' '}
                  · <SparkReceiptCost receipt={{ ...j, generationCost: null }} />
                </>
              )}
              {!j.sparkStatus && j.actual_micros !== undefined && j.actual_micros !== null && (
                <>
                  {' '}
                  · {costs.s('actual')}: {costs.amount(Number(j.actual_micros))}
                </>
              )}
            </p>
          ))}
          {projection && state.draft && (
            <div className={styles.workspace}>
              <section className={styles.preview} aria-label={copyText('preview')}>
                <div className={styles.previewHeading}>
                  <span>{copyText('preview')}</span>
                  <h2>{mapLabel(projection.map.id)}</h2>
                </div>
                <GameCanvas
                  projection={projection}
                  disabled
                  reducedMotion
                  onMove={() => {}}
                  onSelectNpc={() => {}}
                  onStop={() => {}}
                />
              </section>
              <aside className={styles.contents} aria-label={copyText('summary')}>
                <section>
                  <h2>
                    <MapPin size={22} aria-hidden="true" /> {copyText('locations')}
                  </h2>
                  <ul>
                    {state.draft.maps.map((map) => (
                      <li key={map.id}>
                        <span className={styles.itemIcon} aria-hidden="true">
                          <MapPin size={22} />
                        </span>
                        <div>
                          <strong>{label(map)}</strong>
                          <small>
                            {map.width} × {map.height}
                          </small>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h2>
                    <UsersRound size={22} aria-hidden="true" /> {copyText('characters')}
                  </h2>
                  {state.draft.npcs.length === 0 ? (
                    <p>{copyText('empty')}</p>
                  ) : (
                    <ul>
                      {state.draft.npcs.map((npc) => (
                        <li key={npc.id}>
                          <span className={styles.itemIcon} aria-hidden="true">
                            <UsersRound size={22} />
                          </span>
                          <div>
                            <strong>{label(npc)}</strong>
                            <small>{npc.publicProfile?.role || mapLabel(npc.mapId)}</small>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
                <section>
                  <h2>
                    <Box size={22} aria-hidden="true" /> {copyText('objects')}
                  </h2>
                  {state.draft.objects.length === 0 ? (
                    <p>{copyText('empty')}</p>
                  ) : (
                    <ul>
                      {state.draft.objects.map((object) => (
                        <li key={object.id}>
                          <span className={styles.itemIcon} aria-hidden="true">
                            <Box size={22} />
                          </span>
                          <div>
                            <strong>{label(object)}</strong>
                            <small>{object.publicProfile?.role || mapLabel(object.mapId)}</small>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </aside>
            </div>
          )}
          {state.status === 'proposed' && (
            <div className={styles.reviewActions}>
              <label className={styles.review}>
                <input
                  type="checkbox"
                  checked={review}
                  disabled={busy || !state.sourceCurrent}
                  onChange={(e) => setReview(e.target.checked)}
                />
                {copyText('review')}
              </label>
              <Button
                busy={busy}
                disabled={!review || !state.sourceCurrent}
                onClick={() => void act('apply')}
              >
                {copyText('apply')}
              </Button>
            </div>
          )}
        </>
      )}
      <ErrorBox message={error} />
    </section>
  );
}
