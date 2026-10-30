'use client';
import { useEffect, useRef, useState } from 'react';
import type { GameProjection } from '@dreamwalk/contracts';
import { api, errorMessage } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Field, Select } from '@/components/ui';
type Quote = {
  id: string;
  credits: number;
  expiresAt: string;
  demo: boolean;
  requiresConsent: boolean;
  policyVersion: string;
};
type Status = {
  configuration: {
    provider: 'mock' | 'external';
    enabled: boolean;
    externalCallsEnabled: boolean;
    demo: boolean;
  };
  wallet: { balance: number; available: number; reserved: number };
  jobs: { id: string; status: string; reservationStatus: string; credits: number }[];
};
const labels: Record<string, string> = {
  queued: 'В очереди',
  running: 'Выполняется',
  committed: 'Применено',
  succeeded: 'Применено',
  failed: 'Ошибка',
  cancelled: 'Отменено',
  stale: 'Результат устарел',
  reserved: 'Зарезервировано',
  held: 'Зарезервировано',
  result_received: 'Результат ожидает проверки',
  reconciling: 'Сверка результата',
  released: 'Резерв освобождён',
  captured: 'Списано',
  none: 'Без резерва',
};
export function LivingAiPanel({
  campaignId,
  projection,
  disabled,
}: {
  campaignId: string;
  projection: GameProjection;
  disabled: boolean;
}) {
  const { t } = useT();
  const [status, setStatus] = useState<Status | null>(null),
    [quote, setQuote] = useState<Quote | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [npcId, setNpcId] = useState(''),
    [purpose, setPurpose] = useState<'plan' | 'summary' | 'speech'>('plan'),
    [channel, setChannel] = useState<'say' | 'whisper'>('say'),
    [selectedTopic, setSelectedTopic] = useState('');
  const operation = useRef<string | null>(null);
  const generation = useRef(0);
  const path = `/game/campaigns/${campaignId}/ai`;
  const npcs = projection.entities.filter((entity) => entity.kind === 'npc');
  const topicId =
    purpose === 'speech' && projection.entities.some((entity) => entity.id === selectedTopic)
      ? selectedTopic || undefined
      : undefined;
  const recipient = npcs.some((npc) => npc.id === npcId) ? npcId : npcs[0]?.id || '';
  useEffect(() => {
    if (projection.rulesetVersion !== 'hybrid-v3') return;
    let alive = true;
    const refresh = () =>
      void api<Status>(path)
        .then((value) => {
          if (alive) setStatus(value);
        })
        .catch((err) => {
          if (alive) setError(errorMessage(err));
        });
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [path, projection.rulesetVersion]);
  useEffect(() => {
    generation.current++;
    setQuote(null);
    operation.current = null;
    setBusy(false);
    return () => {
      generation.current++;
    };
  }, [recipient, campaignId, purpose, channel, topicId]);
  async function estimate() {
    setQuote(null);
    operation.current = null;
    const request = generation.current;
    setBusy(true);
    setError('');
    try {
      const value = await api<Quote>(`${path}/quote`, {
        method: 'POST',
        body: JSON.stringify({ npcId: recipient, purpose, channel, topicId }),
      });
      if (request !== generation.current) return;
      setQuote(value);
      operation.current = crypto.randomUUID();
    } catch (err) {
      if (request === generation.current) setError(errorMessage(err));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }
  async function confirm() {
    if (!quote || !operation.current || Date.now() >= Date.parse(quote.expiresAt)) return;
    const request = generation.current;
    setBusy(true);
    setError('');
    try {
      await api(`${path}/jobs`, {
        method: 'POST',
        body: JSON.stringify({
          npcId: recipient,
          purpose,
          channel,
          topicId,
          operationId: operation.current,
          quoteId: quote.id,
          consent: true,
        }),
      });
      if (request !== generation.current) return;
      setQuote(null);
      operation.current = null;
      const latest = await api<Status>(path);
      if (request === generation.current) setStatus(latest);
    } catch (err) {
      if (request === generation.current) setError(errorMessage(err));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }
  if (projection.rulesetVersion !== 'hybrid-v3') return null;
  return (
    <section aria-label={t('Проверка AI-операции')}>
      <h2>{t('Проверка AI-операции')}</h2>
      <p>{t('DEMO · НЕ ДЕНЬГИ')}</p>
      <p>
        {t(
          'Автономные реакции уже работают без этой кнопки. Здесь проверяется отдельная очередь тестового планировщика.',
        )}
      </p>
      <p>
        {status?.configuration.enabled
          ? t('Тестовый планировщик доступен')
          : t('Планировщик выключен')}
      </p>
      {status?.wallet && (
        <p>
          {t('Доступно искр')}: {status.wallet.available} · {t('Зарезервировано искр')}:{' '}
          {status.wallet.reserved}
        </p>
      )}
      <Field label={t('NPC для операции')}>
        <Select
          aria-label={t('NPC для операции')}
          value={recipient}
          disabled={busy}
          onChange={(event) => setNpcId(event.target.value)}
        >
          {npcs.map((npc) => (
            <option key={npc.id} value={npc.id}>
              {npc.label || t('NPC')}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t('Тип AI-операции')}>
        <Select
          aria-label={t('Тип AI-операции')}
          value={purpose}
          disabled={busy}
          onChange={(event) => setPurpose(event.target.value as typeof purpose)}
        >
          <option value="plan">{t('План действий')}</option>
          <option value="summary">{t('Сводка личной памяти')}</option>
          <option value="speech">{t('Тестовая реплика NPC')}</option>
        </Select>
      </Field>
      {purpose === 'speech' && (
        <Field label={t('Канал ответа NPC')}>
          <Select
            aria-label={t('Канал ответа NPC')}
            value={channel}
            disabled={busy}
            onChange={(event) => setChannel(event.target.value as typeof channel)}
          >
            <option value="say">{t('Сказать вслух')}</option>
            <option value="whisper">{t('Личный ответ')}</option>
          </Select>
        </Field>
      )}
      {purpose === 'speech' && (
        <Field label={t('Спросить об объекте')}>
          <Select
            aria-label={t('Спросить об объекте')}
            value={topicId || ''}
            disabled={busy}
            onChange={(event) => setSelectedTopic(event.target.value)}
          >
            <option value="">{t('Без конкретной темы')}</option>
            {projection.entities.map((entity) => (
              <option key={entity.id} value={entity.id}>
                {entity.label || (entity.id === projection.actorId ? t('Ты') : t('Предмет'))}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Button
        type="button"
        variant="secondary"
        busy={busy}
        disabled={
          disabled ||
          !recipient ||
          !status?.configuration.enabled ||
          status.configuration.provider !== 'mock'
        }
        onClick={() => void estimate()}
      >
        {t('Узнать стоимость')}
      </Button>
      {quote && (
        <div>
          <p>{t('Стоимость: {credits} искр', { credits: quote.credits })}</p>
          <p>
            {t('Предложение действует до {time}', {
              time: new Date(quote.expiresAt).toLocaleTimeString(),
            })}
          </p>
          <Button
            type="button"
            disabled={disabled || busy || Date.now() >= Date.parse(quote.expiresAt)}
            onClick={() => void confirm()}
          >
            {t('Подтвердить тестовую операцию')}
          </Button>
        </div>
      )}
      <ErrorBox message={error} />
      <ul>
        {status?.jobs.map((job) => (
          <li key={job.id}>
            {t(labels[job.status] || 'Статус обновляется')} ·{' '}
            {t(labels[job.reservationStatus] || 'Статус обновляется')}
          </li>
        ))}
      </ul>
    </section>
  );
}
