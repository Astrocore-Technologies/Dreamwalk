'use client';
import { useRef, useState } from 'react';
import type { AuthoredGameDraft } from '@dreamwalk/contracts';
import { api, errorMessage } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox } from '../ui';
import { GameCanvas } from '../game/game-canvas';
import { compilePlayableDraft, createStateFromPlayable, projectState } from '@dreamwalk/game-core';
type State = {
  id: string;
  status: string;
  sourceHash: string;
  draft: AuthoredGameDraft | null;
  sourceCurrent: boolean;
  jobs: { id: string; status: string; error_code: string }[];
};
type Quote = {
  id: string;
  model: string;
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
    'Игровой план сохранён. Теперь историю можно собрать и опубликовать обычным способом.',
    'Gameplay saved. The story can now be compiled and published through the normal flow.',
    'Ігровий план збережено. Історію тепер можна зібрати й опублікувати звичайним способом.',
  ],
  intro: [
    'AI предлагает расположение ваших локаций и NPC. Это отдельный запрос с ценой и согласием; применение не публикует историю и не меняет текущие игры.',
    'AI proposes geometry for your own locations and NPCs. This is a separate quoted request requiring consent; applying it neither publishes the story nor changes current games.',
    'AI пропонує геометрію ваших локацій та NPC. Це окремий запит із ціною та згодою; застосування не публікує історію й не змінює поточні ігри.',
  ],
} as const;
export function StoryPlayableBuilder({ adventureId }: { adventureId: string }) {
  const { locale } = useT(),
    i = locale === 'ru' ? 0 : locale === 'en' ? 1 : 2,
    text = (k: keyof typeof copy) => copy[k][i];
  const [state, setState] = useState<State | null>(null),
    [quote, setQuote] = useState<Quote | null>(null),
    [review, setReview] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const lock = useRef(false),
    ops = useRef(new Map<string, string>());
  async function mutate(path: string, b: object) {
    const key = JSON.stringify({ path, b });
    if (!ops.current.has(key)) ops.current.set(key, crypto.randomUUID());
    return api(path, {
      method: 'POST',
      body: JSON.stringify({ ...b, operationId: ops.current.get(key) }),
    });
  }
  async function act(kind: 'prepare' | 'quote' | 'dispatch' | 'apply' | 'refresh') {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    let id = state?.id;
    try {
      if (kind === 'prepare') {
        const p = (await mutate('/story-builds/adventures/' + adventureId + '/prepare', {})) as {
          id: string;
        };
        id = p.id;
      } else if (state && kind === 'quote') {
        const s = await api<{ sessionId: string; generationAuthorizationId?: string }>(
          '/generation/status',
        );
        setQuote(
          (await mutate('/story-builds/' + id + '/quote', {
            sessionId: s.generationAuthorizationId ?? s.sessionId,
          })) as Quote,
        );
      } else if (state && kind === 'dispatch' && quote) {
        await mutate('/story-builds/' + id + '/dispatch', { quoteId: quote.id, consent: true });
        setQuote(null);
      } else if (state && kind === 'apply') {
        await mutate('/story-builds/' + id + '/apply', {
          sourceHash: state.sourceHash,
          reviewed: true,
          imageReuseConsent: true,
        });
      }
      if (id) setState(await api<State>('/story-builds/' + id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const compiled = state?.draft ? compilePlayableDraft(state.draft) : null;
  const projection = compiled?.playable
    ? projectState(createStateFromPlayable(compiled.playable, ['story-preview']), 'story-preview')
    : null;
  return (
    <section>
      <h2>{text('title')}</h2>
      <p>{text('intro')}</p>
      {!state ? (
        <Button busy={busy} onClick={() => void act('prepare')}>
          {text('prepare')}
        </Button>
      ) : (
        <>
          <Button busy={busy} variant="secondary" onClick={() => void act('refresh')}>
            {text('refresh')}
          </Button>
          {state.status === 'prepared' && !state.jobs.length && (
            <Button busy={busy} onClick={() => void act('quote')}>
              {text('quote')}
            </Button>
          )}
          {quote && (
            <div>
              <p>
                {quote.model} ·{' '}
                {new Intl.NumberFormat(locale, {
                  style: 'currency',
                  currency: 'USD',
                  maximumFractionDigits: 6,
                }).format((quote.estimatedTotalMicros ?? quote.reserveMicros) / 1e6)}
              </p>
              <Button
                busy={busy}
                disabled={Date.parse(quote.expiresAt) <= Date.now() || !state.sourceCurrent}
                onClick={() => void act('dispatch')}
              >
                {text('dispatch')}
              </Button>
            </div>
          )}
          {state.jobs.map((j) => (
            <p role="status" key={j.id}>
              {j.status}
              {j.error_code ? ' · ' + j.error_code : ''}
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
                  onChange={(e) => setReview(e.target.checked)}
                />
                {text('review')}
              </label>
              <Button
                busy={busy}
                disabled={!review || !state.sourceCurrent}
                onClick={() => void act('apply')}
              >
                {text('apply')}
              </Button>
            </>
          )}
          {state.status === 'applied' && <p role="status">{text('done')}</p>}
        </>
      )}
      <ErrorBox message={error} />
    </section>
  );
}
