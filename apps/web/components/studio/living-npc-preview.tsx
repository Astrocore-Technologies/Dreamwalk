'use client';
import { useEffect, useRef, useState } from 'react';
import type { NpcBrain } from '@dreamwalk/contracts';
import { api, errorMessage } from '@/lib/client';
import { useT } from '@/lib/i18n';
import { Button, ErrorBox, Field, Input } from '@/components/ui';

type Preview = {
  sandbox: true;
  sourceRevision: number;
  npcId: string;
  tick: number;
  brain: NpcBrain;
};
const goalLabels = {
  patrol: 'Патруль',
  investigate: 'Проверить событие',
  assist: 'Помочь',
  warn: 'Предупредить',
};
const observationLabels = {
  item_taken: 'Замечено перемещение предмета',
  item_missing: 'Замечено исчезновение предмета',
  door_changed: 'Замечено изменение двери',
  noise: 'Услышан звук',
  addressed: 'Получено обращение',
  helped: 'Оказана помощь',
  claim: 'Получено утверждение',
  known_entity: 'Исходное знание',
  said: 'Услышана реплика',
};
const channelLabels = { direct: 'Наблюдение', heard: 'Слух', report: 'Сообщение другого NPC' };
export function LivingNpcPreview({
  adventureId,
  npcId,
  flush,
}: {
  adventureId: string;
  npcId: string;
  flush: () => Promise<number>;
}) {
  const { t } = useT();
  const [result, setResult] = useState<Preview | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [ticks, setTicks] = useState(20);
  const generation = useRef(0);
  useEffect(() => {
    generation.current++;
    setResult(null);
    setError('');
    setBusy(false);
    return () => {
      generation.current++;
    };
  }, [adventureId, npcId]);
  async function run() {
    const request = ++generation.current;
    setBusy(true);
    setError('');
    try {
      const expectedRevision = await flush();
      const value = await api<Preview>(`/studio/adventures/${adventureId}/npc-preview`, {
        method: 'POST',
        body: JSON.stringify({ expectedRevision, npcId, ticks }),
      });
      if (request === generation.current) setResult(value);
    } catch (err) {
      if (request === generation.current) setError(errorMessage(err));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }
  return (
    <section aria-label={t('Авторская проверка NPC')}>
      <h3>{t('Авторская проверка NPC')}</h3>
      <p>
        {t(
          'Это отдельная копия сохранённого черновика. Память и события чужих прохождений не читаются.',
        )}
      </p>
      <Field label={t('Шагов симуляции')}>
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
        {t('Сохранить и проверить восприятие')}
      </Button>
      <ErrorBox message={error} />
      {result && (
        <div role="status">
          <p>{t('Проверена версия черновика {version}', { version: result.sourceRevision })}</p>
          {result.brain.living ? (
            <>
              <p>
                {t('Текущая цель: {goal}', { goal: t(goalLabels[result.brain.living.goal.kind]) })}
              </p>
              <p>
                {t('Сохранённых обязательств: {count}', {
                  count: result.brain.living.obligations.length,
                })}
              </p>
              <ul>
                {result.brain.living.observations.map((observation) => (
                  <li key={observation.id}>
                    {t(observationLabels[observation.kind])} ·{' '}
                    {t(channelLabels[observation.channel])}
                  </li>
                ))}
              </ul>
              {!result.brain.living.observations.length && (
                <p>
                  {t(
                    'Пока нет наблюдений. Отсутствие знания не означает отсутствие события в мире.',
                  )}
                </p>
              )}
            </>
          ) : (
            <p>{t('Для этой версии самостоятельная память не включена.')}</p>
          )}
        </div>
      )}
    </section>
  );
}
