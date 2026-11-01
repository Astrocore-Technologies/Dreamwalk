'use client';
import { useEffect, useRef, useState } from 'react';
import { formatSparkSubunits, type AuthoredGameDraft } from '@dreamwalk/contracts';
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
  const { locale } = useT(),
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
          const s = await api<{ sessionId: string; generationAuthorizationId?: string }>(
            '/generation/status',
          );
          if (!active()) return;
          const path = '/story-builds/' + id + '/quote';
          const body = { sessionId: s.generationAuthorizationId ?? s.sessionId };
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
  const sparkAmount = (micros: number) =>
    Number.isSafeInteger(micros) && micros >= 0
      ? formatSparkSubunits(String(micros), locale)
      : copyText('estimateUnknown');
  const compiled = state?.draft ? compilePlayableDraft(state.draft) : null;
  const projection = compiled?.playable
    ? projectState(createStateFromPlayable(compiled.playable, ['story-preview']), 'story-preview')
    : null;
  return (
    <section>
      <h2>{copyText('title')}</h2>
      <p>{copyText('intro')}</p>
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
          <Button busy={busy} variant="secondary" onClick={() => void act('refresh')}>
            {copyText('refresh')}
          </Button>
          <p role="status">{statusText(state.status)}</p>
          {!state.sourceCurrent && <p role="alert">{copyText('stale')}</p>}
          {!unresolved &&
            (state.status !== 'prepared' || state.jobs.length > 0 || !state.sourceCurrent) && (
              <Button busy={busy} onClick={() => void act('prepare')}>
                {copyText('prepare')}
              </Button>
            )}
          {state.sourceCurrent && state.status === 'prepared' && !state.jobs.length && (
            <Button busy={busy} onClick={() => void act('quote')}>
              {copyText('quote')}
            </Button>
          )}
          {quote && (
            <div>
              {quote.sparks && <SparkQuotePrice quote={quote} />}
              <SparkQuoteNotice quote={quote} />
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
            <p role="status" key={j.id}>
              {j.error_code === 'STORY_MAP_INTENT_MISMATCH'
                ? copyText('mapIntentMismatch')
                : statusText(j.status)}
              {j.sparkStatus && (
                <>
                  {' '}
                  · <SparkReceiptCost receipt={{ ...j, generationCost: null }} />
                </>
              )}
              {j.actual_micros !== undefined && j.actual_micros !== null && (
                <>
                  {' '}
                  · {costs.s('actual')}: {costs.amount(Number(j.actual_micros))}
                </>
              )}
            </p>
          ))}
          {projection && (
            <GameCanvas
              projection={projection}
              disabled
              reducedMotion
              onMove={() => {}}
              onSelectNpc={() => {}}
              onStop={() => {}}
            />
          )}
          {state.status === 'proposed' && (
            <>
              <label>
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
            </>
          )}
        </>
      )}
      <ErrorBox message={error} />
    </section>
  );
}
