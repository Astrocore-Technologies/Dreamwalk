'use client';
import { useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Field, Input } from '@/components/ui';
type Sponsor = {
  id: string;
  expiresAt: string;
  revoked: boolean;
  totalCredits: number;
  remainingCredits: number;
  remainingOperations: number;
  maxOperations: number;
  remainingProviderMicros: number;
  purposes: string[];
};
export function SponsorBudget({
  campaignId,
  owner,
  disabled,
}: {
  campaignId: string;
  owner: boolean;
  disabled: boolean;
}) {
  const { t } = useT();
  const [minimum, setMinimum] = useState({ creditPrice: 0, providerUpperMicros: 0 });
  const [records, setRecords] = useState<Sponsor[]>([]),
    [totalCredits, setTotal] = useState(0),
    [perOperationCredits, setPer] = useState(0),
    [totalProviderMicros, setProviderTotal] = useState(0),
    [perOperationProviderMicros, setProviderPer] = useState(0),
    [maxOperations, setMax] = useState(20),
    [minutes, setMinutes] = useState(60),
    [purposes, setPurposes] = useState<('plan' | 'summary' | 'speech' | 'intent')[]>(['speech']),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const retry = useRef<{ key: string; body: unknown } | null>(null),
    epoch = useRef(0);
  const path = `/game/campaigns/${campaignId}/ai/sponsors`;
  useEffect(() => {
    const generation = ++epoch.current;
    setRecords([]);
    setBusy(false);
    setConsent(false);
    setError('');
    retry.current = null;
    if (!owner) return;
    let loading = false;
    async function refresh() {
      if (loading) return;
      loading = true;
      try {
        const value = await api<{
          sponsors: Sponsor[];
          configuration: { creditPrice: number; providerUpperMicros: number };
        }>(path);
        if (generation === epoch.current) {
          setRecords(value.sponsors);
          setMinimum(value.configuration);
        }
      } catch (err) {
        if (generation === epoch.current) setError(errorMessage(err));
      } finally {
        loading = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      epoch.current++;
      clearInterval(timer);
    };
  }, [path, owner]);
  const valid =
    purposes.length > 0 &&
    [
      totalCredits,
      perOperationCredits,
      totalProviderMicros,
      perOperationProviderMicros,
      maxOperations,
      minutes,
    ].every(Number.isInteger) &&
    totalCredits >= perOperationCredits &&
    perOperationCredits >= minimum.creditPrice &&
    totalCredits <= 1000000 &&
    perOperationCredits <= 100000 &&
    totalProviderMicros >= perOperationProviderMicros &&
    perOperationProviderMicros >= minimum.providerUpperMicros &&
    totalProviderMicros <= 1000000000000 &&
    perOperationProviderMicros <= 100000000 &&
    maxOperations >= 1 &&
    maxOperations <= 1000 &&
    minutes >= 1 &&
    minutes <= 1440;
  async function grant() {
    if (!valid || !consent) return;
    const generation = epoch.current;
    setBusy(true);
    setError('');
    const input = {
        totalCredits,
        perOperationCredits,
        totalProviderMicros,
        perOperationProviderMicros,
        maxOperations,
        minutes,
        purposes,
      },
      key = JSON.stringify(input);
    if (retry.current?.key !== key)
      retry.current = {
        key,
        body: {
          operationId: crypto.randomUUID(),
          consent: true,
          totalCredits,
          perOperationCredits,
          totalProviderMicros,
          perOperationProviderMicros,
          maxOperations,
          purposes,
          expiresAt: new Date(Date.now() + minutes * 60000).toISOString(),
        },
      };
    try {
      await api(path, { method: 'POST', body: JSON.stringify(retry.current.body) });
      const value = await api<{
        sponsors: Sponsor[];
        configuration: { creditPrice: number; providerUpperMicros: number };
      }>(path);
      if (generation === epoch.current) {
        setRecords(value.sponsors);
        setMinimum(value.configuration);
        setConsent(false);
        retry.current = null;
      }
    } catch (err) {
      if (generation === epoch.current) setError(errorMessage(err));
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  }
  async function revoke(id: string) {
    const generation = epoch.current;
    setBusy(true);
    setError('');
    try {
      await api(`${path}/${id}`, { method: 'DELETE' });
      const value = await api<{
        sponsors: Sponsor[];
        configuration: { creditPrice: number; providerUpperMicros: number };
      }>(path);
      if (generation === epoch.current) {
        setRecords(value.sponsors);
        setMinimum(value.configuration);
      }
    } catch (err) {
      if (generation === epoch.current) setError(errorMessage(err));
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  }
  if (!owner) return null;
  const active = records.some(
    (record) => !record.revoked && Date.parse(record.expiresAt) > Date.now(),
  );
  return (
    <section aria-label={t('Бюджет организатора')}>
      <h2>{t('Бюджет организатора')}</h2>
      <p>{t('DEMO · НЕ ДЕНЬГИ')}</p>
      <p>
        {t(
          'Это ограниченное согласие на общие операции NPC. Оно не включает внешний провайдер и не разрешает реальные покупки.',
        )}
      </p>
      <p>
        {t('Минимум на операцию: {credits} искр и {micros} технических микроединиц', {
          credits: minimum.creditPrice,
          micros: minimum.providerUpperMicros,
        })}
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void grant();
        }}
      >
        <Field label={t('Общий лимит искр')}>
          <Input
            type="number"
            min={0}
            max={1000000}
            value={totalCredits}
            onChange={(event) => {
              setTotal(Number(event.target.value));
              setConsent(false);
            }}
          />
        </Field>
        <Field label={t('Лимит искр на операцию')}>
          <Input
            type="number"
            min={0}
            max={100000}
            value={perOperationCredits}
            onChange={(event) => {
              setPer(Number(event.target.value));
              setConsent(false);
            }}
          />
        </Field>
        <Field label={t('Общий технический бюджет, микроединицы')}>
          <Input
            type="number"
            min={0}
            max={1000000000000}
            value={totalProviderMicros}
            onChange={(event) => {
              setProviderTotal(Number(event.target.value));
              setConsent(false);
            }}
          />
        </Field>
        <Field label={t('Технический бюджет операции, микроединицы')}>
          <Input
            type="number"
            min={0}
            max={100000000}
            value={perOperationProviderMicros}
            onChange={(event) => {
              setProviderPer(Number(event.target.value));
              setConsent(false);
            }}
          />
        </Field>
        <Field label={t('Максимум операций')}>
          <Input
            type="number"
            min={1}
            max={1000}
            value={maxOperations}
            onChange={(event) => {
              setMax(Number(event.target.value));
              setConsent(false);
            }}
          />
        </Field>
        <Field label={t('Срок согласия в минутах')}>
          <Input
            type="number"
            min={1}
            max={1440}
            value={minutes}
            onChange={(event) => {
              setMinutes(Number(event.target.value));
              setConsent(false);
            }}
          />
        </Field>
        <fieldset>
          <legend>{t('Разрешённые операции')}</legend>
          {(['plan', 'summary', 'speech', 'intent'] as const).map((purpose) => (
            <label key={purpose}>
              <input
                type="checkbox"
                checked={purposes.includes(purpose)}
                onChange={(event) => {
                  setPurposes(
                    event.target.checked
                      ? [...purposes, purpose]
                      : purposes.filter((value) => value !== purpose),
                  );
                  setConsent(false);
                }}
              />
              {t(
                purpose === 'plan'
                  ? 'План действий'
                  : purpose === 'summary'
                    ? 'Сводка личной памяти'
                    : purpose === 'intent'
                      ? 'Действие своими словами'
                      : 'Тестовая реплика NPC',
              )}
            </label>
          ))}
        </fieldset>
        <label>
          <input
            type="checkbox"
            checked={consent}
            onChange={(event) => setConsent(event.target.checked)}
          />
          {t('Разрешаю только указанные операции в пределах этих лимитов')}
        </label>
        <Button type="submit" busy={busy} disabled={disabled || !valid || !consent || active}>
          {t('Выдать ограниченный бюджет')}
        </Button>
      </form>
      <ul>
        {records.map((record) => (
          <li key={record.id}>
            {t(record.revoked ? 'Бюджет отозван' : 'Бюджет выдан')} ·{' '}
            {t('Осталось операций: {count}', { count: record.remainingOperations })} ·{' '}
            {t('Осталось искр: {count}', { count: record.remainingCredits })}
            {!record.revoked && (
              <Button
                type="button"
                variant="secondary"
                disabled={busy || disabled}
                onClick={() => void revoke(record.id)}
              >
                {t('Отозвать бюджет')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <ErrorBox message={error} />
    </section>
  );
}
