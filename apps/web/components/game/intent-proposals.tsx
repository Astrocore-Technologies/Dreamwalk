'use client';
import { useEffect, useRef, useState } from 'react';
import type { GameAction, GameProjection } from '@dreamwalk/contracts';
import { api, errorMessage } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Field, Textarea } from '@/components/ui';
type Proposal = {
  id: string;
  status: string;
  action?: GameAction;
  code?: string;
  cost: number;
  generationCost?: number | null;
  funding?: 'session-budget' | 'personal' | 'free' | null;
  expiresAt: string;
};
const actionLabels: Record<GameAction['kind'], string> = {
  move_to: 'Подойти',
  inspect: 'Осмотреть',
  pick_up: 'Подобрать',
  unlock: 'Отпереть',
  open: 'Открыть дверь',
  close: 'Закрыть дверь',
  talk: 'Поговорить',
  distract: 'Отвлечь',
  wait: 'Ждать',
  transition: 'Перейти',
  give: 'Передать предмет',
  knock: 'Постучать',
  communicate: 'Сообщить наблюдение',
  lock: 'Запереть дверь',
  defend: 'Ждать',
  flee: 'Покинуть столкновение',
};
export function IntentProposals({
  campaignId,
  projection,
  disabled,
}: {
  campaignId: string;
  projection: GameProjection;
  disabled: boolean;
}) {
  const { t } = useT();
  const [text, setText] = useState(''),
    [proposal, setProposal] = useState<Proposal | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const request = useRef<{ text: string; operationId: string } | null>(null),
    confirmation = useRef<string | null>(null),
    epoch = useRef(0);
  const path = `/game/campaigns/${campaignId}/intent-proposals`;
  useEffect(() => {
    epoch.current++;
    setProposal(null);
    setBusy(false);
    setText('');
    setError('');
    request.current = null;
    confirmation.current = null;
    return () => {
      epoch.current++;
    };
  }, [campaignId]);
  useEffect(() => {
    let active = true,
      loading = false,
      first = true;
    async function refresh() {
      if (loading) return;
      loading = true;
      try {
        const result = await api<{ proposals: Proposal[] }>(path);
        if (active) {
          const restore = first
            ? result.proposals.find((entry) => ['pending', 'proposed'].includes(entry.status))
            : null;
          first = false;
          if (restore && !confirmation.current) confirmation.current = crypto.randomUUID();
          setProposal((current) =>
            current
              ? result.proposals.find((entry) => entry.id === current.id) || current
              : restore || null,
          );
        }
      } catch (err) {
        if (active) setError(errorMessage(err));
      } finally {
        loading = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [path]);
  async function propose() {
    const generation = epoch.current;
    setBusy(true);
    setError('');
    setProposal(null);
    if (request.current?.text !== text.trim())
      request.current = { text: text.trim(), operationId: crypto.randomUUID() };
    try {
      const value = await api<Proposal>(path, {
        method: 'POST',
        body: JSON.stringify(request.current),
      });
      if (generation === epoch.current) {
        setProposal(value);
        confirmation.current = crypto.randomUUID();
      }
    } catch (err) {
      if (generation === epoch.current) setError(errorMessage(err));
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  }
  async function confirm() {
    if (!proposal || proposal.status !== 'proposed' || !confirmation.current) return;
    const generation = epoch.current;
    setBusy(true);
    setError('');
    try {
      const result = await api<{ status: string; code?: string }>(
        `${path}/${proposal.id}/confirm`,
        {
          method: 'POST',
          body: JSON.stringify({ operationId: confirmation.current }),
        },
      );
      if (result.status === 'rejected') throw new Error(result.code || 'ACTION_REJECTED');
      if (generation === epoch.current) {
        setProposal(null);
        request.current = null;
        confirmation.current = null;
        setText('');
      }
    } catch (err) {
      if (generation === epoch.current) setError(errorMessage(err));
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  }
  const action = proposal?.action,
    target = projection.entities.find((entity) => entity.id === action?.targetId);
  return (
    <section aria-label={t('Действие своими словами')}>
      <h2>{t('Действие своими словами')}</h2>
      <p>
        {t(
          'Сначала сервер предлагает конкретное действие. Мир изменится только после подтверждения; непонятный запрос нужно уточнить.',
        )}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void propose();
        }}
      >
        <Field label={t('Что сделать')}>
          <Textarea
            aria-label={t('Что сделать')}
            value={text}
            disabled={busy}
            maxLength={1000}
            onChange={(event) => {
              setText(event.target.value);
              setProposal(null);
              confirmation.current = null;
            }}
          />
        </Field>
        <Button type="submit" busy={busy} disabled={disabled || !text.trim()}>
          {t('Предложить действие')}
        </Button>
      </form>
      {proposal && (
        <div role="status">
          {proposal.status === 'pending' ? (
            <p>{t('Планировщик готовит предложение; действие ещё не выполнено.')}</p>
          ) : proposal.status === 'proposed' && action ? (
            <>
              <p>
                {t('Предлагаемое действие')}: {t(actionLabels[action.kind])}
                {target
                  ? ` · ${target.label || t('Предмет')}`
                  : action.targetId &&
                      projection.map.exits.some((exit) => exit.id === action.targetId)
                    ? ` · ${t('Переход')}: ${action.targetId}`
                    : ''}
                {action.itemId
                  ? ` · ${t('Предмет')}: ${projection.inventory.find((item) => item.id === action.itemId)?.label || projection.entities.find((item) => item.id === action.itemId)?.label || action.itemId}`
                  : ''}
                {action.target ? ` (${action.target.x}, ${action.target.y})` : ''}
              </p>
              <p>
                {t('Подтверждение игрового действия: {credits} искр', { credits: proposal.cost })}
              </p>
              <p>
                {proposal.generationCost == null
                  ? t('Стоимость обработки учитывается отдельно в разрешённом бюджете.')
                  : t('Обработка запроса: {credits} искр', { credits: proposal.generationCost })}
              </p>
              <Button type="button" disabled={disabled || busy} onClick={() => void confirm()}>
                {t('Подтвердить это действие')}
              </Button>
            </>
          ) : proposal.status === 'cancelled' ? (
            <p>
              {t(
                proposal.code === 'INTENT_EXPIRED'
                  ? 'Предложение устарело. Отправь новый запрос.'
                  : 'Предложение отменено: обработка недоступна. Можно отправить новый запрос.',
              )}
            </p>
          ) : (
            <p>{t('Нужно уточнение: назови одно действие и видимый объект.')}</p>
          )}
        </div>
      )}
      <ErrorBox message={error} />
    </section>
  );
}
