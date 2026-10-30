'use client';
import { useEffect, useRef, useState } from 'react';
import type { NpcBrain } from '@dreamwalk/contracts';
import { api, errorMessage } from '@/lib/client';
import { observationLabels } from './living-npc-preview';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Field, Input } from '@/components/ui';
export function ModeratorNpcPreview({
  adventureId,
  versionId,
  npcId,
}: {
  adventureId: string;
  versionId: string;
  npcId: string;
}) {
  const { t } = useT();
  const [ticks, setTicks] = useState(20),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [result, setResult] = useState<{ versionId: string; brain: NpcBrain; tick: number } | null>(
      null,
    );
  const epoch = useRef(0);
  useEffect(() => {
    epoch.current++;
    setResult(null);
    setBusy(false);
    setError('');
    return () => {
      epoch.current++;
    };
  }, [adventureId, versionId, npcId]);
  async function run() {
    const generation = epoch.current;
    setBusy(true);
    setError('');
    try {
      const value = await api<{ versionId: string; brain: NpcBrain; tick: number }>(
        `/admin/adventures/${adventureId}/npc-preview`,
        { method: 'POST', body: JSON.stringify({ versionId, npcId, ticks }) },
      );
      if (generation === epoch.current) setResult(value);
    } catch (err) {
      if (generation === epoch.current) setError(errorMessage(err));
    } finally {
      if (generation === epoch.current) setBusy(false);
    }
  }
  return (
    <section aria-label={t('Проверка поведения отправленной версии')}>
      <h4>{t('Проверка поведения отправленной версии')}</h4>
      <p>
        {t(
          'Симуляция использует только эту неизменяемую заявку. Текущие кампании и черновики не затрагиваются.',
        )}
      </p>
      <Field label={t('Шагов проверки')}>
        <Input
          type="number"
          min={0}
          max={120}
          value={ticks}
          onChange={(event) => setTicks(Number(event.target.value))}
        />
      </Field>
      <Button
        type="button"
        variant="secondary"
        busy={busy}
        disabled={!Number.isInteger(ticks) || ticks < 0 || ticks > 120}
        onClick={() => void run()}
      >
        {t('Проверить NPC этой заявки')}
      </Button>
      <ErrorBox message={error} />
      {result && (
        <div role="status">
          <p>{t('Проверена заявка {version}', { version: result.versionId })}</p>
          <p>
            {t('Наблюдений: {count}', { count: result.brain.living?.observations.length || 0 })}
          </p>
          <ul>
            {result.brain.living?.observations.map((observation) => (
              <li key={observation.id}>
                {observation.title || t(observationLabels[observation.kind])} ·{' '}
                {t('Источник события')}: {observation.eventId}
                {observation.definitionText && <p>{observation.definitionText}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
